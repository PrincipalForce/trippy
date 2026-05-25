//! Minimal RIFF/WAVE decoder.
//!
//! Supports the formats trippy needs to load loops at M1:
//! - PCM 8-bit unsigned, 16-bit signed, 24-bit packed signed, 32-bit signed
//! - IEEE 754 float 32 and 64
//! - Mono and stereo
//! - WAVE_FORMAT_EXTENSIBLE with PCM or IEEE float sub-formats
//!
//! Returns deinterleaved `f32` channels in `[-1.0, 1.0]`.
//!
//! At M2 we'll either keep this for ACID-chunk awareness (since `acid-import`
//! reuses the same chunk walker) or graduate to `symphonia` when MP3/FLAC
//! support arrives in M3.

// The per-channel loops in `decode_data` use parallel indexing across
// `frame` (the interleaved input) and `deinterleaved` (the output channels).
// An iterator-based rewrite would be less readable, so suppress the lint.
#![allow(clippy::needless_range_loop)]

use std::io::{Cursor, Read};

#[derive(Debug)]
pub struct WavData {
    pub sample_rate: u32,
    pub channels: u16,
    /// Deinterleaved channels in [-1.0, 1.0].
    pub samples: Vec<Vec<f32>>,
}

#[derive(Debug, thiserror::Error)]
pub enum WavError {
    #[error("file too small to contain a RIFF header")]
    TooShort,
    #[error("not a RIFF/WAVE file (header was {0:?})")]
    NotRiff([u8; 4]),
    #[error("missing chunk: {0}")]
    MissingChunk(&'static str),
    #[error("unsupported format tag: 0x{0:04x}")]
    UnsupportedFormat(u16),
    #[error("unsupported bit depth: {0}")]
    UnsupportedBitDepth(u16),
    #[error("unsupported channel count: {0}")]
    UnsupportedChannelCount(u16),
    #[error("truncated chunk: {0}")]
    Truncated(&'static str),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Decode a RIFF/WAVE byte slice into deinterleaved `f32` channels.
pub fn decode_wav(bytes: &[u8]) -> Result<WavData, WavError> {
    if bytes.len() < 12 {
        return Err(WavError::TooShort);
    }
    let mut riff = [0u8; 4];
    riff.copy_from_slice(&bytes[0..4]);
    if &riff != b"RIFF" {
        return Err(WavError::NotRiff(riff));
    }
    // [4..8] = chunk size; we don't trust it for short-circuit decisions.
    if &bytes[8..12] != b"WAVE" {
        return Err(WavError::NotRiff([
            bytes[8], bytes[9], bytes[10], bytes[11],
        ]));
    }

    let mut cursor = Cursor::new(&bytes[12..]);
    let mut fmt: Option<FmtChunk> = None;
    let mut data: Option<&[u8]> = None;

    while (cursor.position() as usize) + 8 <= bytes.len() - 12 {
        let mut id = [0u8; 4];
        let mut size_bytes = [0u8; 4];
        cursor.read_exact(&mut id)?;
        cursor.read_exact(&mut size_bytes)?;
        let size = u32::from_le_bytes(size_bytes) as usize;
        let start = cursor.position() as usize + 12; // absolute offset
        let end = start
            .checked_add(size)
            .ok_or(WavError::Truncated("chunk size overflow"))?;
        if end > bytes.len() {
            return Err(WavError::Truncated("chunk extends past file end"));
        }
        let body = &bytes[start..end];
        match &id {
            b"fmt " => fmt = Some(parse_fmt(body)?),
            b"data" => data = Some(body),
            _ => { /* ignore other chunks (LIST/INFO, ACID, smpl, etc.) */ }
        }
        // Skip body and padding byte (chunks are word-aligned).
        cursor.set_position((start + size + (size & 1) - 12) as u64);
    }

    let fmt = fmt.ok_or(WavError::MissingChunk("fmt "))?;
    let data = data.ok_or(WavError::MissingChunk("data"))?;
    decode_data(&fmt, data)
}

#[derive(Debug, Clone, Copy)]
struct FmtChunk {
    format_tag: u16,
    channels: u16,
    sample_rate: u32,
    bits_per_sample: u16,
}

const WAVE_FORMAT_PCM: u16 = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT: u16 = 0x0003;
const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;

fn parse_fmt(body: &[u8]) -> Result<FmtChunk, WavError> {
    if body.len() < 16 {
        return Err(WavError::Truncated("fmt chunk shorter than 16 bytes"));
    }
    let mut format_tag = u16::from_le_bytes([body[0], body[1]]);
    let channels = u16::from_le_bytes([body[2], body[3]]);
    let sample_rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
    let bits_per_sample = u16::from_le_bytes([body[14], body[15]]);

    // WAVE_FORMAT_EXTENSIBLE stores the real sub-format in a GUID at offset 24.
    // The first two bytes of that GUID match WAVE_FORMAT_PCM or _IEEE_FLOAT.
    if format_tag == WAVE_FORMAT_EXTENSIBLE && body.len() >= 26 {
        if body.len() < 40 {
            return Err(WavError::Truncated(
                "EXTENSIBLE fmt chunk shorter than 40 bytes",
            ));
        }
        format_tag = u16::from_le_bytes([body[24], body[25]]);
    }

    Ok(FmtChunk {
        format_tag,
        channels,
        sample_rate,
        bits_per_sample,
    })
}

fn decode_data(fmt: &FmtChunk, data: &[u8]) -> Result<WavData, WavError> {
    if fmt.channels == 0 || fmt.channels > 2 {
        return Err(WavError::UnsupportedChannelCount(fmt.channels));
    }
    let channels = fmt.channels as usize;
    let bytes_per_sample = match fmt.bits_per_sample {
        8 | 16 | 24 | 32 | 64 => (fmt.bits_per_sample as usize) / 8,
        n => return Err(WavError::UnsupportedBitDepth(n)),
    };
    let frame_size = bytes_per_sample * channels;
    let frames = data.len() / frame_size;
    let mut deinterleaved = vec![Vec::<f32>::with_capacity(frames); channels];

    match (fmt.format_tag, fmt.bits_per_sample) {
        (WAVE_FORMAT_PCM, 8) => {
            // 8-bit PCM is unsigned, biased by 128.
            for frame in data.chunks_exact(frame_size) {
                for ch in 0..channels {
                    let b = frame[ch];
                    deinterleaved[ch].push((b as f32 - 128.0) / 128.0);
                }
            }
        }
        (WAVE_FORMAT_PCM, 16) => {
            for frame in data.chunks_exact(frame_size) {
                for ch in 0..channels {
                    let off = ch * 2;
                    let v = i16::from_le_bytes([frame[off], frame[off + 1]]);
                    deinterleaved[ch].push(v as f32 / 32768.0);
                }
            }
        }
        (WAVE_FORMAT_PCM, 24) => {
            for frame in data.chunks_exact(frame_size) {
                for ch in 0..channels {
                    let off = ch * 3;
                    // Sign-extend 24 → 32.
                    let raw = (frame[off] as i32)
                        | ((frame[off + 1] as i32) << 8)
                        | ((frame[off + 2] as i32) << 16);
                    let signed = if raw & 0x0080_0000 != 0 {
                        raw | !0x00FF_FFFF
                    } else {
                        raw
                    };
                    deinterleaved[ch].push(signed as f32 / 8_388_608.0);
                }
            }
        }
        (WAVE_FORMAT_PCM, 32) => {
            for frame in data.chunks_exact(frame_size) {
                for ch in 0..channels {
                    let off = ch * 4;
                    let v = i32::from_le_bytes([
                        frame[off],
                        frame[off + 1],
                        frame[off + 2],
                        frame[off + 3],
                    ]);
                    deinterleaved[ch].push(v as f32 / 2_147_483_648.0);
                }
            }
        }
        (WAVE_FORMAT_IEEE_FLOAT, 32) => {
            for frame in data.chunks_exact(frame_size) {
                for ch in 0..channels {
                    let off = ch * 4;
                    let v = f32::from_le_bytes([
                        frame[off],
                        frame[off + 1],
                        frame[off + 2],
                        frame[off + 3],
                    ]);
                    deinterleaved[ch].push(v);
                }
            }
        }
        (WAVE_FORMAT_IEEE_FLOAT, 64) => {
            for frame in data.chunks_exact(frame_size) {
                for ch in 0..channels {
                    let off = ch * 8;
                    let mut bytes = [0u8; 8];
                    bytes.copy_from_slice(&frame[off..off + 8]);
                    deinterleaved[ch].push(f64::from_le_bytes(bytes) as f32);
                }
            }
        }
        (tag, bits) => {
            // Either an unsupported tag or an unsupported bit-depth for the tag.
            if tag != WAVE_FORMAT_PCM && tag != WAVE_FORMAT_IEEE_FLOAT {
                return Err(WavError::UnsupportedFormat(tag));
            }
            return Err(WavError::UnsupportedBitDepth(bits));
        }
    }

    Ok(WavData {
        sample_rate: fmt.sample_rate,
        channels: fmt.channels,
        samples: deinterleaved,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Build a minimal RIFF/WAVE container around the given fmt fields and
    /// data bytes. Used to synthesize test inputs without external fixtures.
    fn build_wav(
        format_tag: u16,
        channels: u16,
        sample_rate: u32,
        bits: u16,
        data: &[u8],
    ) -> Vec<u8> {
        let block_align = channels * (bits / 8);
        let byte_rate = sample_rate * block_align as u32;
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        let total = 36 + data.len() as u32;
        buf.extend_from_slice(&total.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        // fmt chunk
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&format_tag.to_le_bytes());
        buf.extend_from_slice(&channels.to_le_bytes());
        buf.extend_from_slice(&sample_rate.to_le_bytes());
        buf.extend_from_slice(&byte_rate.to_le_bytes());
        buf.extend_from_slice(&block_align.to_le_bytes());
        buf.extend_from_slice(&bits.to_le_bytes());
        // data chunk
        buf.extend_from_slice(b"data");
        buf.extend_from_slice(&(data.len() as u32).to_le_bytes());
        buf.extend_from_slice(data);
        buf
    }

    #[test]
    fn rejects_non_riff() {
        let bytes = vec![0u8; 64];
        assert!(matches!(decode_wav(&bytes), Err(WavError::NotRiff(_))));
    }

    #[test]
    fn rejects_too_short() {
        assert!(matches!(decode_wav(&[]), Err(WavError::TooShort)));
    }

    #[test]
    fn decodes_16bit_mono() {
        // Two frames: +max, -max
        let mut data = Vec::new();
        data.extend_from_slice(&i16::MAX.to_le_bytes());
        data.extend_from_slice(&i16::MIN.to_le_bytes());
        let wav = build_wav(WAVE_FORMAT_PCM, 1, 48_000, 16, &data);
        let decoded = decode_wav(&wav).unwrap();
        assert_eq!(decoded.sample_rate, 48_000);
        assert_eq!(decoded.channels, 1);
        assert_eq!(decoded.samples.len(), 1);
        assert!((decoded.samples[0][0] - 0.99997).abs() < 1e-3);
        assert!((decoded.samples[0][1] - -1.0).abs() < 1e-6);
    }

    #[test]
    fn decodes_16bit_stereo() {
        // Frame 0: L=+max, R=0; Frame 1: L=0, R=-max
        let mut data = Vec::new();
        data.extend_from_slice(&i16::MAX.to_le_bytes());
        data.extend_from_slice(&0i16.to_le_bytes());
        data.extend_from_slice(&0i16.to_le_bytes());
        data.extend_from_slice(&i16::MIN.to_le_bytes());
        let wav = build_wav(WAVE_FORMAT_PCM, 2, 44_100, 16, &data);
        let decoded = decode_wav(&wav).unwrap();
        assert_eq!(decoded.channels, 2);
        assert!(decoded.samples[0][0] > 0.99);
        assert!(decoded.samples[0][1].abs() < 1e-6);
        assert!(decoded.samples[1][0].abs() < 1e-6);
        assert!(decoded.samples[1][1] < -0.99);
    }

    #[test]
    fn decodes_8bit_pcm() {
        let data = vec![128, 0, 255]; // mid, min, max
        let wav = build_wav(WAVE_FORMAT_PCM, 1, 22_050, 8, &data);
        let decoded = decode_wav(&wav).unwrap();
        assert!(decoded.samples[0][0].abs() < 1e-6);
        assert!((decoded.samples[0][1] - -1.0).abs() < 1e-6);
        assert!((decoded.samples[0][2] - (127.0 / 128.0)).abs() < 1e-6);
    }

    #[test]
    fn decodes_float32() {
        let mut data = Vec::new();
        data.extend_from_slice(&0.5f32.to_le_bytes());
        data.extend_from_slice(&(-0.25f32).to_le_bytes());
        let wav = build_wav(WAVE_FORMAT_IEEE_FLOAT, 1, 48_000, 32, &data);
        let decoded = decode_wav(&wav).unwrap();
        assert!((decoded.samples[0][0] - 0.5).abs() < 1e-6);
        assert!((decoded.samples[0][1] - -0.25).abs() < 1e-6);
    }

    #[test]
    fn rejects_unsupported_channel_count() {
        let data = vec![0u8; 32];
        let wav = build_wav(WAVE_FORMAT_PCM, 6, 48_000, 16, &data);
        assert!(matches!(
            decode_wav(&wav),
            Err(WavError::UnsupportedChannelCount(6))
        ));
    }
}
