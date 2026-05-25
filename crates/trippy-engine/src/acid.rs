//! Parser for the ACID chunk inside RIFF/WAVE files.
//!
//! Sony ACID (and modern tools like Acidplanet, Cakewalk, FL Studio) embed
//! loop metadata in a chunk identified by `acid` (lowercase, with trailing
//! space — `b"acid"`). The chunk is 24 bytes long:
//!
//! ```text
//! offset  size  field
//! 0       4     flags (bitmask)
//!                 bit 0 = OneShot   (0=loop, 1=one-shot — no pitch following)
//!                 bit 1 = RootNote set
//!                 bit 2 = StretchOn
//!                 bit 3 = DiskBased
//!                 bit 4 = AcidiZer
//! 4       2     root note (MIDI note number, 0..127)
//! 6       2     reserved (commonly 0x8000)
//! 8       4     reserved (float, often 0.0)
//! 12      4     beat count
//! 16      2     meter denominator (e.g. 4 for /4)
//! 18      2     meter numerator   (e.g. 4 for 4/)
//! 20      4     tempo (BPM, IEEE float)
//! ```
//!
//! We parse this best-effort: malformed chunks return `None` rather than
//! panicking, since unknown content can appear in real-world files.

/// Decoded ACID chunk.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AcidMeta {
    pub one_shot: bool,
    pub root_note_set: bool,
    pub stretch_on: bool,
    pub disk_based: bool,
    pub acidizer: bool,
    /// MIDI note number for the root pitch, if `root_note_set`.
    pub root_note: u8,
    pub beat_count: u32,
    pub meter_numerator: u16,
    pub meter_denominator: u16,
    pub bpm: f32,
}

impl AcidMeta {
    pub fn from_chunk(body: &[u8]) -> Option<Self> {
        if body.len() < 24 {
            return None;
        }
        let flags = u32::from_le_bytes([body[0], body[1], body[2], body[3]]);
        let root_note = body[4];
        let beat_count = u32::from_le_bytes([body[12], body[13], body[14], body[15]]);
        let meter_denominator = u16::from_le_bytes([body[16], body[17]]);
        let meter_numerator = u16::from_le_bytes([body[18], body[19]]);
        let bpm = f32::from_le_bytes([body[20], body[21], body[22], body[23]]);
        Some(Self {
            one_shot: flags & 0x01 != 0,
            root_note_set: flags & 0x02 != 0,
            stretch_on: flags & 0x04 != 0,
            disk_based: flags & 0x08 != 0,
            acidizer: flags & 0x10 != 0,
            root_note,
            beat_count,
            meter_numerator,
            meter_denominator,
            bpm,
        })
    }
}

/// Walk a RIFF/WAVE byte slice and extract the ACID chunk if present.
pub fn parse_from_wav(bytes: &[u8]) -> Option<AcidMeta> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return None;
    }
    let mut pos = 12_usize;
    while pos + 8 <= bytes.len() {
        let id = &bytes[pos..pos + 4];
        let size = u32::from_le_bytes([
            bytes[pos + 4],
            bytes[pos + 5],
            bytes[pos + 6],
            bytes[pos + 7],
        ]) as usize;
        let body_start = pos + 8;
        let body_end = body_start.checked_add(size)?;
        if body_end > bytes.len() {
            return None;
        }
        if id == b"acid" {
            return AcidMeta::from_chunk(&bytes[body_start..body_end]);
        }
        // Skip body + padding byte.
        pos = body_end + (size & 1);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn build_wav_with_acid(acid_body: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&0u32.to_le_bytes()); // size placeholder
        buf.extend_from_slice(b"WAVE");
        // Minimal fmt chunk (16 bytes)
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&[0u8; 16]);
        // ACID chunk
        buf.extend_from_slice(b"acid");
        buf.extend_from_slice(&(acid_body.len() as u32).to_le_bytes());
        buf.extend_from_slice(acid_body);
        buf
    }

    #[test]
    fn parses_typical_acid_chunk() {
        let mut body = Vec::new();
        body.extend_from_slice(&0x16u32.to_le_bytes()); // flags: root+stretch+acidizer
        body.push(60); // root note C4
        body.push(0);
        body.extend_from_slice(&0x8000u16.to_le_bytes());
        body.extend_from_slice(&0f32.to_le_bytes());
        body.extend_from_slice(&8u32.to_le_bytes()); // 8 beats
        body.extend_from_slice(&4u16.to_le_bytes()); // denom
        body.extend_from_slice(&4u16.to_le_bytes()); // numer
        body.extend_from_slice(&120.0f32.to_le_bytes()); // bpm
        let wav = build_wav_with_acid(&body);
        let m = parse_from_wav(&wav).unwrap();
        assert_eq!(m.root_note, 60);
        assert_eq!(m.beat_count, 8);
        assert!((m.bpm - 120.0).abs() < 1e-3);
        assert!(m.root_note_set);
        assert!(m.stretch_on);
        assert!(m.acidizer);
        assert!(!m.one_shot);
    }

    #[test]
    fn returns_none_when_no_acid_chunk() {
        let mut buf = Vec::new();
        buf.extend_from_slice(b"RIFF");
        buf.extend_from_slice(&0u32.to_le_bytes());
        buf.extend_from_slice(b"WAVE");
        buf.extend_from_slice(b"fmt ");
        buf.extend_from_slice(&16u32.to_le_bytes());
        buf.extend_from_slice(&[0u8; 16]);
        assert!(parse_from_wav(&buf).is_none());
    }

    #[test]
    fn rejects_truncated_chunk() {
        let body = vec![0u8; 10];
        let wav = build_wav_with_acid(&body);
        assert!(parse_from_wav(&wav).is_none());
    }
}
