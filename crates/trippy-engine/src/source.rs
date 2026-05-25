//! Audio source: an immutable PCM buffer with sample rate and channel count.
//!
//! Sources are reference-counted via `Arc` so a clip can hold a cheap handle
//! while many clip instances on the timeline share the underlying samples.

use std::sync::Arc;

/// A stable identifier for an audio source registered with the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct SourceId(pub u32);

/// Channel layouts trippy understands at M1. More layouts (5.1, ambisonic)
/// can be added later by extending the enum.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChannelLayout {
    Mono,
    Stereo,
}

impl ChannelLayout {
    pub fn channels(self) -> u16 {
        match self {
            ChannelLayout::Mono => 1,
            ChannelLayout::Stereo => 2,
        }
    }

    pub fn from_count(n: u16) -> Option<Self> {
        match n {
            1 => Some(ChannelLayout::Mono),
            2 => Some(ChannelLayout::Stereo),
            _ => None,
        }
    }
}

/// An audio source. Samples are stored deinterleaved (one `Vec` per channel)
/// for SIMD-friendly per-channel iteration in the mixer.
#[derive(Debug)]
pub struct AudioSource {
    pub id: SourceId,
    pub sample_rate: f32,
    pub layout: ChannelLayout,
    /// One buffer per channel. All buffers are the same length.
    pub channels: Vec<Vec<f32>>,
}

impl AudioSource {
    /// Construct from interleaved samples.
    pub fn from_interleaved(
        id: SourceId,
        sample_rate: f32,
        layout: ChannelLayout,
        interleaved: &[f32],
    ) -> Self {
        let n_chans = layout.channels() as usize;
        let frames = interleaved.len() / n_chans;
        let mut channels = vec![Vec::with_capacity(frames); n_chans];
        for (frame_idx, frame) in interleaved.chunks_exact(n_chans).enumerate() {
            for (ch, sample) in frame.iter().enumerate() {
                channels[ch].push(*sample);
                // suppress unused warning on frame_idx
                let _ = frame_idx;
            }
        }
        Self {
            id,
            sample_rate,
            layout,
            channels,
        }
    }

    pub fn frame_count(&self) -> usize {
        self.channels.first().map(|c| c.len()).unwrap_or(0)
    }
}

/// Cheap shared handle to a source.
pub type SourceHandle = Arc<AudioSource>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interleaved_stereo_split() {
        // [L0,R0,L1,R1,L2,R2]
        let src = AudioSource::from_interleaved(
            SourceId(1),
            48_000.0,
            ChannelLayout::Stereo,
            &[0.1, 0.2, 0.3, 0.4, 0.5, 0.6],
        );
        assert_eq!(src.frame_count(), 3);
        assert_eq!(src.channels[0], vec![0.1, 0.3, 0.5]);
        assert_eq!(src.channels[1], vec![0.2, 0.4, 0.6]);
    }

    #[test]
    fn mono_round_trip() {
        let src = AudioSource::from_interleaved(
            SourceId(2),
            48_000.0,
            ChannelLayout::Mono,
            &[0.1, 0.2, 0.3],
        );
        assert_eq!(src.channels.len(), 1);
        assert_eq!(src.channels[0], vec![0.1, 0.2, 0.3]);
    }
}
