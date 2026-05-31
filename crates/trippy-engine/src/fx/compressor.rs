//! Feed-forward soft-knee compressor with peak detection.
//!
//! - Detector: stereo peak (max of |L|, |R|) → log domain
//! - Static curve: soft-knee around threshold with configurable ratio
//! - Smoothing: separate attack/release one-pole filters in dB
//! - Make-up gain: linear, applied post-curve
//!
//! No look-ahead at M4 (latency-free). A look-ahead variant arrives in M4.5
//! once we have a delay line abstraction in the graph.

use super::Fx;

pub struct Compressor {
    sample_rate: f32,
    pub threshold_db: f32,
    pub ratio: f32, // e.g. 4.0 means 4:1
    pub knee_db: f32,
    pub attack_ms: f32,
    pub release_ms: f32,
    pub makeup_db: f32,
    env_db: f32,
    /// Cached per-sample coefficients
    attack_coef: f32,
    release_coef: f32,
}

impl Compressor {
    pub fn new(sample_rate: f32) -> Self {
        let mut c = Self {
            sample_rate,
            threshold_db: -12.0,
            ratio: 4.0,
            knee_db: 6.0,
            attack_ms: 10.0,
            release_ms: 100.0,
            makeup_db: 0.0,
            env_db: -100.0,
            attack_coef: 0.0,
            release_coef: 0.0,
        };
        c.recompute_coefs();
        c
    }

    fn recompute_coefs(&mut self) {
        // One-pole time-constant: y[n] = a*y[n-1] + (1-a)*x[n]
        // where 'a' is e^(-1/(tau*sr)) for tau in seconds.
        let atk_samples = (self.attack_ms / 1000.0) * self.sample_rate;
        let rel_samples = (self.release_ms / 1000.0) * self.sample_rate;
        self.attack_coef = (-1.0 / atk_samples.max(1.0)).exp();
        self.release_coef = (-1.0 / rel_samples.max(1.0)).exp();
    }

    pub fn set_attack_ms(&mut self, ms: f32) {
        self.attack_ms = ms;
        self.recompute_coefs();
    }
    pub fn set_release_ms(&mut self, ms: f32) {
        self.release_ms = ms;
        self.recompute_coefs();
    }

    /// Compute gain reduction in dB for input level in dB.
    fn gain_reduction_db(&self, in_db: f32) -> f32 {
        let knee = self.knee_db.max(0.001);
        let over = in_db - self.threshold_db;
        if over <= -knee / 2.0 {
            0.0
        } else if over >= knee / 2.0 {
            -(over - over / self.ratio)
        } else {
            // Soft-knee: quadratic interpolation
            let x = over + knee / 2.0;
            -(x * x) / (2.0 * knee) * (1.0 - 1.0 / self.ratio)
        }
    }
}

impl Fx for Compressor {
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        self.process_internal(l, r, None);
    }

    fn reset(&mut self) {
        self.env_db = -100.0;
    }
}

impl Compressor {
    /// Sidechain entry point: derive the envelope from `det_l`/`det_r` (the
    /// "trigger" signal — e.g. a kick) while applying gain reduction to the
    /// `l`/`r` target (e.g. a bass). Detector and target must have equal len.
    ///
    /// Same DSP otherwise — peak detector + soft-knee static curve +
    /// attack/release-smoothed envelope.
    pub fn process_with_detector(
        &mut self,
        l: &mut [f32],
        r: &mut [f32],
        det_l: &[f32],
        det_r: &[f32],
    ) {
        debug_assert_eq!(l.len(), r.len());
        debug_assert_eq!(l.len(), det_l.len());
        debug_assert_eq!(l.len(), det_r.len());
        self.process_internal(l, r, Some((det_l, det_r)));
    }

    fn process_internal(
        &mut self,
        l: &mut [f32],
        r: &mut [f32],
        detector: Option<(&[f32], &[f32])>,
    ) {
        let makeup_lin = 10f32.powf(self.makeup_db / 20.0);
        for i in 0..l.len() {
            let (dl, dr) = match detector {
                Some((dl, dr)) => (dl[i], dr[i]),
                None => (l[i], r[i]),
            };
            let peak = dl.abs().max(dr.abs()).max(1e-10);
            let in_db = 20.0 * peak.log10();
            let coef = if in_db > self.env_db {
                self.attack_coef
            } else {
                self.release_coef
            };
            self.env_db = coef * self.env_db + (1.0 - coef) * in_db;
            let gr_db = self.gain_reduction_db(self.env_db);
            let g = 10f32.powf(gr_db / 20.0) * makeup_lin;
            l[i] *= g;
            r[i] *= g;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_signal_passes_through() {
        let sr = 48_000.0;
        let mut c = Compressor::new(sr);
        c.threshold_db = -6.0;
        c.ratio = 4.0;
        c.makeup_db = 0.0;
        let mut l = vec![0.05; 1000];
        let mut r = l.clone();
        c.process(&mut l, &mut r);
        // Far below threshold; gain reduction should be ~0.
        assert!((l[999] - 0.05).abs() < 0.01);
    }

    #[test]
    fn sidechain_quiet_target_gets_ducked_by_loud_trigger() {
        // The classic kick→bass duck. Target is a quiet steady tone, trigger
        // is a loud burst — target output should drop during the burst even
        // though it never crosses threshold on its own.
        let sr = 48_000.0;
        let mut c = Compressor::new(sr);
        c.threshold_db = -20.0;
        c.ratio = 6.0;
        c.set_attack_ms(1.0); // must use setter to recompute coefficients
        c.set_release_ms(100.0);
        let n = 4_800;
        let mut tgt_l = vec![0.05; n]; // ≈ -26 dBFS, below threshold
        let mut tgt_r = tgt_l.clone();
        let det_l: Vec<f32> = (0..n).map(|i| if i < n / 2 { 0.8 } else { 0.0 }).collect();
        let det_r = det_l.clone();
        c.process_with_detector(&mut tgt_l, &mut tgt_r, &det_l, &det_r);
        // First half (loud trigger) ducks target.
        let early: f32 = (tgt_l[200..600].iter().map(|s| s.abs()).sum::<f32>()) / 400.0;
        // Second half (silent trigger) recovers.
        let late: f32 = (tgt_l[n - 400..n].iter().map(|s| s.abs()).sum::<f32>()) / 400.0;
        assert!(early < 0.04, "expected duck, got {early}");
        assert!(late > 0.045, "expected recovery, got {late}");
    }

    #[test]
    fn loud_signal_gets_reduced() {
        let sr = 48_000.0;
        let mut c = Compressor::new(sr);
        c.threshold_db = -24.0;
        c.ratio = 4.0;
        c.attack_ms = 1.0;
        c.release_ms = 50.0;
        let n = 4_800;
        let mut l = vec![0.7; n]; // ≈ -3 dBFS, well above threshold
        let mut r = l.clone();
        c.process(&mut l, &mut r);
        // After attack settles, output should be significantly < 0.7.
        let tail_rms: f32 = (l[n - 100..].iter().map(|s| s * s).sum::<f32>() / 100.0).sqrt();
        assert!(tail_rms < 0.5, "tail rms = {tail_rms}");
    }
}
