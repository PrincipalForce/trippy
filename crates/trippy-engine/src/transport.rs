//! Transport state: BPM, position, play/stop, loop region.
//!
//! The transport owns the timeline cursor in *samples* (not seconds or beats).
//! Conversions to/from beats use the current BPM and sample rate. BPM changes
//! never retroactively shift the cursor — they only affect future beat math.

use serde::{Deserialize, Serialize};

/// Beats per minute. Stored as `f64` so automation can land on any sub-beat
/// value without rounding artifacts.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Bpm(pub f64);

impl Default for Bpm {
    fn default() -> Self {
        Bpm(120.0)
    }
}

/// A half-open loop region `[start, end)` in sample frames. `end > start`
/// is enforced at construction; an empty loop is `None` on the transport.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct LoopRegion {
    pub start: u64,
    pub end: u64,
}

impl LoopRegion {
    pub fn new(start: u64, end: u64) -> Option<Self> {
        if end > start {
            Some(Self { start, end })
        } else {
            None
        }
    }

    pub fn len(&self) -> u64 {
        self.end - self.start
    }

    /// A `LoopRegion` is always non-empty by construction (`new` rejects
    /// `end <= start`), but clippy wants this for symmetry with `len`.
    pub fn is_empty(&self) -> bool {
        false
    }
}

/// Transport state.
///
/// `position_frames` is the *next* frame to be rendered. After a `process()`
/// call that emits N frames, the position advances by N (wrapping if a loop
/// region is active and the cursor crosses `end`).
#[derive(Debug, Clone)]
pub struct Transport {
    pub sample_rate: f32,
    pub bpm: Bpm,
    pub position_frames: u64,
    pub playing: bool,
    pub loop_region: Option<LoopRegion>,
}

impl Transport {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            bpm: Bpm::default(),
            position_frames: 0,
            playing: false,
            loop_region: None,
        }
    }

    /// Frames per beat at the current BPM and sample rate.
    pub fn frames_per_beat(&self) -> f64 {
        60.0 / self.bpm.0 * self.sample_rate as f64
    }

    /// Advance the cursor by `frames`. If a loop region is set and the cursor
    /// crosses `end`, wrap back to `start` preserving the overshoot.
    ///
    /// Returns the new position.
    pub fn advance(&mut self, frames: u64) -> u64 {
        let mut p = self.position_frames.saturating_add(frames);
        if let Some(loop_region) = self.loop_region {
            if p >= loop_region.end {
                let len = loop_region.len();
                if len > 0 {
                    let over = (p - loop_region.start) % len;
                    p = loop_region.start + over;
                }
            }
        }
        self.position_frames = p;
        p
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_bpm_is_120() {
        assert_eq!(Bpm::default(), Bpm(120.0));
    }

    #[test]
    fn frames_per_beat_at_120bpm_48k() {
        let t = Transport::new(48_000.0);
        assert!((t.frames_per_beat() - 24_000.0).abs() < 1e-9);
    }

    #[test]
    fn advance_without_loop_just_adds() {
        let mut t = Transport::new(48_000.0);
        t.position_frames = 100;
        assert_eq!(t.advance(50), 150);
    }

    #[test]
    fn advance_wraps_at_loop_end() {
        let mut t = Transport::new(48_000.0);
        t.loop_region = LoopRegion::new(0, 1000);
        t.position_frames = 990;
        // 990 + 20 = 1010; loop length 1000 → wrap to 10
        assert_eq!(t.advance(20), 10);
    }

    #[test]
    fn loop_region_rejects_empty_or_inverted() {
        assert!(LoopRegion::new(100, 100).is_none());
        assert!(LoopRegion::new(200, 100).is_none());
        assert!(LoopRegion::new(100, 200).is_some());
    }
}
