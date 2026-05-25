//! Parameter automation: breakpoint-curve evaluator with sample-accurate output.
//!
//! Each automated parameter has an `AutomationLane` — a sorted list of
//! breakpoints (frame, value, curve). The engine queries the lane every
//! sample (or every N-sample block) for the current value. Curve types:
//!
//! - `Linear`: straight line between points
//! - `Hold`: previous value until the next point
//! - `Exp(k)`: exponential curve (k>0 = ease-in, k<0 = ease-out)
//!
//! Lanes are append-only at runtime; edits replace the lane atomically (the
//! engine swaps in a new `Arc<AutomationLane>` between blocks).
//!
//! For CRDT-friendly collab (M8) the breakpoint list is the canonical state;
//! the evaluator never holds derived caches that would conflict.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Curve {
    Linear,
    Hold,
    /// Power-curve interpolation: `t.powf(k)`. k > 1 ease-in, 0 < k < 1 ease-out.
    Exp(f32),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Breakpoint {
    pub frame: u64,
    pub value: f32,
    /// Curve applied *from this point to the next*.
    pub curve: Curve,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct AutomationLane {
    /// Sorted ascending by frame. We keep this invariant in `insert`.
    pub points: Vec<Breakpoint>,
    /// Value used before the first breakpoint (and when the lane is empty).
    pub initial: f32,
}

impl AutomationLane {
    pub fn new(initial: f32) -> Self {
        Self {
            points: Vec::new(),
            initial,
        }
    }

    pub fn insert(&mut self, bp: Breakpoint) {
        let pos = self.points.partition_point(|p| p.frame < bp.frame);
        // If a point exists at the same frame, replace it.
        if let Some(existing) = self.points.get_mut(pos) {
            if existing.frame == bp.frame {
                *existing = bp;
                return;
            }
        }
        self.points.insert(pos, bp);
    }

    pub fn remove_at(&mut self, frame: u64) -> bool {
        if let Some(i) = self.points.iter().position(|p| p.frame == frame) {
            self.points.remove(i);
            true
        } else {
            false
        }
    }

    /// Evaluate the lane at `frame`.
    pub fn value_at(&self, frame: u64) -> f32 {
        if self.points.is_empty() {
            return self.initial;
        }
        // Find the segment [lo, hi) containing `frame`.
        let pos = self.points.partition_point(|p| p.frame <= frame);
        if pos == 0 {
            // Before first breakpoint.
            return self.initial;
        }
        let lo = &self.points[pos - 1];
        if pos == self.points.len() {
            return lo.value;
        }
        let hi = &self.points[pos];
        let span = (hi.frame - lo.frame) as f32;
        if span <= 0.0 {
            return lo.value;
        }
        let t = (frame - lo.frame) as f32 / span;
        match lo.curve {
            Curve::Hold => lo.value,
            Curve::Linear => lo.value + (hi.value - lo.value) * t,
            Curve::Exp(k) => {
                let shaped = if k.abs() < 1e-6 {
                    t
                } else {
                    t.powf(k.max(0.001))
                };
                lo.value + (hi.value - lo.value) * shaped
            }
        }
    }

    /// Fill a block with sample-by-sample values starting at `start_frame`.
    pub fn fill(&self, start_frame: u64, out: &mut [f32]) {
        for (i, slot) in out.iter_mut().enumerate() {
            *slot = self.value_at(start_frame + i as u64);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_lane_returns_initial() {
        let lane = AutomationLane::new(0.5);
        assert_eq!(lane.value_at(0), 0.5);
        assert_eq!(lane.value_at(1_000_000), 0.5);
    }

    #[test]
    fn hold_returns_previous() {
        let mut lane = AutomationLane::new(0.0);
        lane.insert(Breakpoint {
            frame: 100,
            value: 0.5,
            curve: Curve::Hold,
        });
        lane.insert(Breakpoint {
            frame: 200,
            value: 1.0,
            curve: Curve::Hold,
        });
        assert_eq!(lane.value_at(50), 0.0);
        assert_eq!(lane.value_at(100), 0.5);
        assert_eq!(lane.value_at(150), 0.5);
        assert_eq!(lane.value_at(200), 1.0);
        assert_eq!(lane.value_at(500), 1.0);
    }

    #[test]
    fn linear_interpolates_smoothly() {
        let mut lane = AutomationLane::new(0.0);
        lane.insert(Breakpoint {
            frame: 0,
            value: 0.0,
            curve: Curve::Linear,
        });
        lane.insert(Breakpoint {
            frame: 100,
            value: 1.0,
            curve: Curve::Linear,
        });
        assert!((lane.value_at(50) - 0.5).abs() < 1e-6);
        assert!((lane.value_at(25) - 0.25).abs() < 1e-6);
    }

    #[test]
    fn insert_replaces_same_frame() {
        let mut lane = AutomationLane::new(0.0);
        lane.insert(Breakpoint {
            frame: 100,
            value: 0.5,
            curve: Curve::Linear,
        });
        lane.insert(Breakpoint {
            frame: 100,
            value: 0.9,
            curve: Curve::Linear,
        });
        assert_eq!(lane.points.len(), 1);
        assert!((lane.value_at(100) - 0.9).abs() < 1e-6);
    }

    #[test]
    fn fill_block_matches_per_sample() {
        let mut lane = AutomationLane::new(0.0);
        lane.insert(Breakpoint {
            frame: 0,
            value: 0.0,
            curve: Curve::Linear,
        });
        lane.insert(Breakpoint {
            frame: 1000,
            value: 1.0,
            curve: Curve::Linear,
        });
        let mut out = vec![0.0; 128];
        lane.fill(400, &mut out);
        for (i, &v) in out.iter().enumerate() {
            let expected = (400 + i) as f32 / 1000.0;
            assert!((v - expected).abs() < 1e-5);
        }
    }
}
