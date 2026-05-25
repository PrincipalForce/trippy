//! Per-slice clip warping for ACIDized loops.
//!
//! A warped clip is a regular clip with a list of *slice markers* (frame
//! offsets within the source) and a list of *target* positions on the
//! project timeline that those markers should land on. Between slices, audio
//! is time-stretched (WSOLA) to fit. This is how ACID-style loops adapt to
//! the project tempo even when source BPM differs from project BPM.
//!
//! At M7 we only persist the warp envelope; live playback uses M3's WSOLA
//! per-slice. A native streaming variant lands in M7.5 once we have
//! sub-frame scheduling in the audio graph.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct SliceMarker {
    /// Frame offset within the source PCM.
    pub source_frame: u64,
    /// Frame on the project timeline this slice should land on.
    pub target_frame: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct WarpEnvelope {
    pub markers: Vec<SliceMarker>,
}

impl WarpEnvelope {
    pub fn push(&mut self, marker: SliceMarker) {
        let pos = self
            .markers
            .partition_point(|m| m.source_frame < marker.source_frame);
        self.markers.insert(pos, marker);
    }

    /// Compute the stretch ratio for the slice containing `source_frame`.
    /// Returns 1.0 (no stretch) for frames outside any slice.
    pub fn ratio_at(&self, source_frame: u64) -> f32 {
        let pos = self
            .markers
            .partition_point(|m| m.source_frame <= source_frame);
        if pos == 0 || pos >= self.markers.len() {
            return 1.0;
        }
        let lo = &self.markers[pos - 1];
        let hi = &self.markers[pos];
        let src_span = (hi.source_frame - lo.source_frame) as f32;
        let tgt_span = (hi.target_frame - lo.target_frame) as f32;
        if src_span <= 0.0 {
            1.0
        } else {
            tgt_span / src_span
        }
    }
}

/// PSOLA (Pitch-Synchronous Overlap-Add) pitch correction stub.
///
/// At M7 this is structural only — the real implementation needs a robust
/// pitch tracker (e.g. YIN) per frame, which we add in M7.5 alongside the AI
/// transcription model (the two share the autocorrelation backbone). For now
/// this just exposes the API surface so the UI layer can ship.
pub fn pitch_correct_to_scale(_input: &mut [f32], _scale_midi_notes: &[u8], _strength: f32) {
    // No-op stub.
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratio_at_outside_markers_is_unity() {
        let env = WarpEnvelope::default();
        assert_eq!(env.ratio_at(100), 1.0);
    }

    #[test]
    fn ratio_at_2x_when_target_span_doubles_source() {
        let mut env = WarpEnvelope::default();
        env.push(SliceMarker {
            source_frame: 0,
            target_frame: 0,
        });
        env.push(SliceMarker {
            source_frame: 100,
            target_frame: 200,
        });
        assert!((env.ratio_at(50) - 2.0).abs() < 1e-6);
    }

    #[test]
    fn ratio_at_half_when_target_span_halves_source() {
        let mut env = WarpEnvelope::default();
        env.push(SliceMarker {
            source_frame: 0,
            target_frame: 0,
        });
        env.push(SliceMarker {
            source_frame: 200,
            target_frame: 100,
        });
        assert!((env.ratio_at(50) - 0.5).abs() < 1e-6);
    }
}
