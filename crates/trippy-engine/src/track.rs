//! Track: a container for clips with channel-strip state.
//!
//! M1: gain, pan (constant-power), mute, solo flag. FX inserts and sends
//! arrive in M4.

use crate::clip::{Clip, ClipId};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct TrackId(pub u32);

#[derive(Debug, Clone)]
pub struct Track {
    pub id: TrackId,
    pub clips: Vec<Clip>,
    /// Linear gain. 1.0 = unity.
    pub gain: f32,
    /// Pan, -1.0 (full left) to +1.0 (full right). Constant-power law.
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
}

impl Track {
    pub fn new(id: TrackId) -> Self {
        Self {
            id,
            clips: Vec::new(),
            gain: 1.0,
            pan: 0.0,
            mute: false,
            solo: false,
        }
    }

    /// Constant-power pan coefficients (left, right) for the current pan value.
    ///
    /// At pan=0, both = sqrt(0.5) ≈ 0.7071 — preserving perceived loudness
    /// when summing identical signal to both channels.
    pub fn pan_gains(&self) -> (f32, f32) {
        let p = self.pan.clamp(-1.0, 1.0);
        // Map [-1, 1] → angle [0, π/2]
        let angle = (p + 1.0) * 0.25 * std::f32::consts::PI;
        (angle.cos(), angle.sin())
    }

    pub fn add_clip(&mut self, clip: Clip) {
        self.clips.push(clip);
    }

    pub fn remove_clip(&mut self, id: ClipId) -> bool {
        let n = self.clips.len();
        self.clips.retain(|c| c.id != id);
        self.clips.len() != n
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn center_pan_is_equal_power() {
        let t = Track::new(TrackId(1));
        let (l, r) = t.pan_gains();
        assert!((l - r).abs() < 1e-6);
        // Sum of squares should equal 1 (constant power law).
        assert!((l * l + r * r - 1.0).abs() < 1e-5);
    }

    #[test]
    fn full_left_pan() {
        let mut t = Track::new(TrackId(1));
        t.pan = -1.0;
        let (l, r) = t.pan_gains();
        assert!(l > 0.99 && r < 0.01);
    }

    #[test]
    fn full_right_pan() {
        let mut t = Track::new(TrackId(1));
        t.pan = 1.0;
        let (l, r) = t.pan_gains();
        assert!(r > 0.99 && l < 0.01);
    }
}
