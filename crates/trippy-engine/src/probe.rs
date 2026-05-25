//! Probe nodes: first-class taps that capture audio at any point in the graph
//! for analysis, metering, and AI inspection.
//!
//! A `Probe` is a lock-free ring buffer that the audio thread writes into
//! after some node has finished producing samples. Readers (the UI thread,
//! workers, AI inference) pull from the ring at their own pace; if they're
//! slow the ring overwrites oldest samples — analyzers always show the most
//! recent state, never stale data.
//!
//! At M3.5 we use this for:
//! - Realtime scope view (waveform + spectrogram)
//! - Loudness / true-peak / correlation meters
//! - A/B and difference listening
//!
//! Later milestones consume the same API for: ML feature extraction (M7.5),
//! probe-driven automation (M5+), tuner & onset visualization (M3+).

use std::sync::atomic::{AtomicUsize, Ordering};

/// A single-producer / multi-consumer-snapshot ring buffer for stereo audio.
///
/// The producer (audio thread) calls `write` with deinterleaved L/R blocks.
/// Consumers call `snapshot` to copy out the most recent `N` frames.
///
/// Not lock-free across consumers (each `snapshot` takes the latest write
/// index and copies), but the producer never blocks. Capacity must be a
/// power of two.
pub struct Probe {
    capacity: usize,
    mask: usize,
    left: Vec<f32>,
    right: Vec<f32>,
    write_index: AtomicUsize,
}

impl Probe {
    pub fn new(capacity_pow2: usize) -> Self {
        assert!(
            capacity_pow2.is_power_of_two() && capacity_pow2 >= 64,
            "capacity must be a power of two ≥ 64"
        );
        Self {
            capacity: capacity_pow2,
            mask: capacity_pow2 - 1,
            left: vec![0.0; capacity_pow2],
            right: vec![0.0; capacity_pow2],
            write_index: AtomicUsize::new(0),
        }
    }

    pub fn capacity(&self) -> usize {
        self.capacity
    }

    /// Append `frames` of stereo audio. Producer-only.
    pub fn write(&mut self, l: &[f32], r: &[f32]) {
        debug_assert_eq!(l.len(), r.len());
        let n = l.len();
        let w = self.write_index.load(Ordering::Relaxed);
        let start = w & self.mask;
        if start + n <= self.capacity {
            self.left[start..start + n].copy_from_slice(l);
            self.right[start..start + n].copy_from_slice(r);
        } else {
            let head = self.capacity - start;
            self.left[start..].copy_from_slice(&l[..head]);
            self.right[start..].copy_from_slice(&r[..head]);
            self.left[..n - head].copy_from_slice(&l[head..]);
            self.right[..n - head].copy_from_slice(&r[head..]);
        }
        self.write_index.store(w + n, Ordering::Release);
    }

    /// Copy the *most recent* `out_l.len()` frames into the caller's buffers.
    /// Returns the global frame index of the first sample copied (useful for
    /// aligning multiple probes).
    pub fn snapshot(&self, out_l: &mut [f32], out_r: &mut [f32]) -> usize {
        debug_assert_eq!(out_l.len(), out_r.len());
        let n = out_l.len().min(self.capacity);
        let w = self.write_index.load(Ordering::Acquire);
        let start = (w.saturating_sub(n)) & self.mask;
        let first_global = w.saturating_sub(n);
        if start + n <= self.capacity {
            out_l[..n].copy_from_slice(&self.left[start..start + n]);
            out_r[..n].copy_from_slice(&self.right[start..start + n]);
        } else {
            let head = self.capacity - start;
            out_l[..head].copy_from_slice(&self.left[start..]);
            out_r[..head].copy_from_slice(&self.right[start..]);
            out_l[head..n].copy_from_slice(&self.left[..n - head]);
            out_r[head..n].copy_from_slice(&self.right[..n - head]);
        }
        first_global
    }
}

/// Streaming RMS loudness: short-term and momentary windows in dBFS.
///
/// Approximation of the EBU R128 momentary (400 ms) and short-term (3 s)
/// windows. Pre-filter (K-weighting) is *not* applied at M3.5 — that comes
/// when full LUFS accuracy is needed in M4 mastering.
pub struct LoudnessMeter {
    sample_rate: f32,
    win_momentary: usize,
    win_short: usize,
    sum_sq_momentary: f64,
    sum_sq_short: f64,
    history: Vec<f32>,
    write: usize,
    filled: usize,
}

impl LoudnessMeter {
    pub fn new(sample_rate: f32) -> Self {
        let win_momentary = (sample_rate * 0.4) as usize;
        let win_short = (sample_rate * 3.0) as usize;
        Self {
            sample_rate,
            win_momentary,
            win_short,
            sum_sq_momentary: 0.0,
            sum_sq_short: 0.0,
            history: vec![0.0; win_short],
            write: 0,
            filled: 0,
        }
    }

    /// Push N mono-summed samples (L+R)/2.
    pub fn push(&mut self, samples: &[f32]) {
        let mask_len = self.history.len();
        for &s in samples {
            // Evict the value rolling out of the short window.
            let old = self.history[self.write];
            self.sum_sq_short -= (old * old) as f64;
            if self.filled >= self.win_momentary {
                let off = (self.write + mask_len - self.win_momentary) % mask_len;
                let old_m = self.history[off];
                self.sum_sq_momentary -= (old_m * old_m) as f64;
            }
            self.history[self.write] = s;
            self.sum_sq_short += (s * s) as f64;
            self.sum_sq_momentary += (s * s) as f64;
            self.write = (self.write + 1) % mask_len;
            if self.filled < mask_len {
                self.filled += 1;
            }
        }
    }

    pub fn momentary_dbfs(&self) -> f32 {
        let n = self.win_momentary.min(self.filled).max(1) as f64;
        let rms = (self.sum_sq_momentary / n).sqrt();
        20.0 * (rms.max(1e-10).log10()) as f32
    }

    pub fn short_term_dbfs(&self) -> f32 {
        let n = self.win_short.min(self.filled).max(1) as f64;
        let rms = (self.sum_sq_short / n).sqrt();
        20.0 * (rms.max(1e-10).log10()) as f32
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }
}

/// True-peak per channel: tracks the absolute max sample seen, with optional
/// reset (e.g. on transport stop).
pub struct PeakMeter {
    pub left: f32,
    pub right: f32,
}

impl Default for PeakMeter {
    fn default() -> Self {
        Self {
            left: 0.0,
            right: 0.0,
        }
    }
}

impl PeakMeter {
    pub fn push(&mut self, l: &[f32], r: &[f32]) {
        for &s in l {
            let a = s.abs();
            if a > self.left {
                self.left = a;
            }
        }
        for &s in r {
            let a = s.abs();
            if a > self.right {
                self.right = a;
            }
        }
    }

    pub fn reset(&mut self) {
        self.left = 0.0;
        self.right = 0.0;
    }

    pub fn left_dbfs(&self) -> f32 {
        20.0 * self.left.max(1e-10).log10()
    }

    pub fn right_dbfs(&self) -> f32 {
        20.0 * self.right.max(1e-10).log10()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_round_trips_small_block() {
        let mut p = Probe::new(1024);
        let l = vec![0.1, 0.2, 0.3, 0.4];
        let r = vec![-0.1, -0.2, -0.3, -0.4];
        p.write(&l, &r);
        let mut ol = vec![0.0; 4];
        let mut or_ = vec![0.0; 4];
        p.snapshot(&mut ol, &mut or_);
        assert_eq!(ol, l);
        assert_eq!(or_, r);
    }

    #[test]
    fn probe_wraps_across_buffer_boundary() {
        let mut p = Probe::new(64);
        // Write 50 + 30 = 80 frames; capacity 64 means we wrap.
        let a_l: Vec<f32> = (0..50).map(|i| i as f32).collect();
        let a_r: Vec<f32> = (0..50).map(|i| -(i as f32)).collect();
        p.write(&a_l, &a_r);
        let b_l: Vec<f32> = (0..30).map(|i| 100.0 + i as f32).collect();
        let b_r: Vec<f32> = (0..30).map(|i| -(100.0 + i as f32)).collect();
        p.write(&b_l, &b_r);
        let mut ol = vec![0.0; 16];
        let mut or_ = vec![0.0; 16];
        p.snapshot(&mut ol, &mut or_);
        // The last 16 frames should be b_l[14..30]
        let expected: Vec<f32> = (0..16).map(|i| 100.0 + 14.0 + i as f32).collect();
        assert_eq!(ol, expected);
    }

    #[test]
    fn peak_meter_tracks_max_abs() {
        let mut m = PeakMeter::default();
        m.push(&[0.1, -0.5, 0.3], &[0.0, 0.0, 0.0]);
        m.push(&[0.2, -0.8, 0.1], &[0.0, 0.0, 0.0]);
        assert!((m.left - 0.8).abs() < 1e-6);
    }

    #[test]
    fn loudness_meter_silence_is_minus_inf_floor() {
        let mut m = LoudnessMeter::new(48_000.0);
        m.push(&[0.0; 4_800]);
        assert!(m.momentary_dbfs() < -100.0);
    }

    #[test]
    fn loudness_meter_full_scale_sine_near_minus_three() {
        // A full-scale sine has RMS = 1/sqrt(2) ≈ 0.707 → 20 log10 = -3 dBFS.
        let sr = 48_000.0;
        let n = (sr * 0.5) as usize;
        let mut samples = Vec::with_capacity(n);
        for i in 0..n {
            let t = i as f32 / sr;
            samples.push((2.0 * std::f32::consts::PI * 1000.0 * t).sin());
        }
        let mut m = LoudnessMeter::new(sr);
        m.push(&samples);
        assert!(
            (m.momentary_dbfs() - -3.0).abs() < 0.5,
            "got {} dBFS",
            m.momentary_dbfs()
        );
    }
}
