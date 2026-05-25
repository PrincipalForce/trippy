//! Biquad filter primitive (RBJ cookbook formulae).
//!
//! Stereo, transposed direct form II — numerically well-behaved for
//! single-precision and cheap (4 mults + 4 adds per sample per channel).

use std::f32::consts::PI;

#[derive(Debug, Clone, Copy)]
pub enum BiquadKind {
    Lowpass,
    Highpass,
    Bandpass,
    Peak,
    LowShelf,
    HighShelf,
    Notch,
}

#[derive(Debug, Clone, Copy)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    // State (per channel)
    z1l: f32,
    z2l: f32,
    z1r: f32,
    z2r: f32,
}

impl Default for Biquad {
    fn default() -> Self {
        // Identity (pass-through)
        Self {
            b0: 1.0,
            b1: 0.0,
            b2: 0.0,
            a1: 0.0,
            a2: 0.0,
            z1l: 0.0,
            z2l: 0.0,
            z1r: 0.0,
            z2r: 0.0,
        }
    }
}

impl Biquad {
    /// Configure with RBJ formulae. `freq` in Hz, `q` dimensionless,
    /// `gain_db` only used by peak/shelf types.
    pub fn set(&mut self, kind: BiquadKind, sample_rate: f32, freq: f32, q: f32, gain_db: f32) {
        let f = freq.clamp(10.0, sample_rate * 0.49);
        let q = q.max(0.0001);
        let omega = 2.0 * PI * f / sample_rate;
        let cos_w = omega.cos();
        let sin_w = omega.sin();
        let a = 10f32.powf(gain_db / 40.0);
        let alpha = sin_w / (2.0 * q);

        let (b0, b1, b2, a0, a1, a2) = match kind {
            BiquadKind::Lowpass => {
                let b0 = (1.0 - cos_w) * 0.5;
                let b1 = 1.0 - cos_w;
                let b2 = b0;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadKind::Highpass => {
                let b0 = (1.0 + cos_w) * 0.5;
                let b1 = -(1.0 + cos_w);
                let b2 = b0;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadKind::Bandpass => {
                let b0 = alpha;
                let b1 = 0.0;
                let b2 = -alpha;
                let a0 = 1.0 + alpha;
                let a1 = -2.0 * cos_w;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadKind::Notch => {
                let b0 = 1.0;
                let b1 = -2.0 * cos_w;
                let b2 = 1.0;
                let a0 = 1.0 + alpha;
                let a1 = b1;
                let a2 = 1.0 - alpha;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadKind::Peak => {
                let b0 = 1.0 + alpha * a;
                let b1 = -2.0 * cos_w;
                let b2 = 1.0 - alpha * a;
                let a0 = 1.0 + alpha / a;
                let a1 = b1;
                let a2 = 1.0 - alpha / a;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadKind::LowShelf => {
                let s = 1.0;
                let beta = ((a * a + 1.0) / s - (a - 1.0).powi(2)).sqrt();
                let b0 = a * ((a + 1.0) - (a - 1.0) * cos_w + beta * sin_w);
                let b1 = 2.0 * a * ((a - 1.0) - (a + 1.0) * cos_w);
                let b2 = a * ((a + 1.0) - (a - 1.0) * cos_w - beta * sin_w);
                let a0 = (a + 1.0) + (a - 1.0) * cos_w + beta * sin_w;
                let a1 = -2.0 * ((a - 1.0) + (a + 1.0) * cos_w);
                let a2 = (a + 1.0) + (a - 1.0) * cos_w - beta * sin_w;
                (b0, b1, b2, a0, a1, a2)
            }
            BiquadKind::HighShelf => {
                let s = 1.0;
                let beta = ((a * a + 1.0) / s - (a - 1.0).powi(2)).sqrt();
                let b0 = a * ((a + 1.0) + (a - 1.0) * cos_w + beta * sin_w);
                let b1 = -2.0 * a * ((a - 1.0) + (a + 1.0) * cos_w);
                let b2 = a * ((a + 1.0) + (a - 1.0) * cos_w - beta * sin_w);
                let a0 = (a + 1.0) - (a - 1.0) * cos_w + beta * sin_w;
                let a1 = 2.0 * ((a - 1.0) - (a + 1.0) * cos_w);
                let a2 = (a + 1.0) - (a - 1.0) * cos_w - beta * sin_w;
                (b0, b1, b2, a0, a1, a2)
            }
        };
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    pub fn reset(&mut self) {
        self.z1l = 0.0;
        self.z2l = 0.0;
        self.z1r = 0.0;
        self.z2r = 0.0;
    }

    /// Process stereo in-place. Transposed direct form II.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let xl = l[i];
            let yl = self.b0 * xl + self.z1l;
            self.z1l = self.b1 * xl - self.a1 * yl + self.z2l;
            self.z2l = self.b2 * xl - self.a2 * yl;
            l[i] = yl;

            let xr = r[i];
            let yr = self.b0 * xr + self.z1r;
            self.z1r = self.b1 * xr - self.a1 * yr + self.z2r;
            self.z2r = self.b2 * xr - self.a2 * yr;
            r[i] = yr;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lowpass_attenuates_high_freq() {
        let sr = 48_000.0;
        let mut bq = Biquad::default();
        bq.set(BiquadKind::Lowpass, sr, 1000.0, 0.7071, 0.0);

        // 8 kHz tone, well above cutoff.
        let n = 4_800;
        let mut l = vec![0.0; n];
        let mut r = vec![0.0; n];
        for i in 0..n {
            let s = (2.0 * std::f32::consts::PI * 8_000.0 * i as f32 / sr).sin();
            l[i] = s;
            r[i] = s;
        }
        bq.process(&mut l, &mut r);
        // Compare RMS in the last 1000 samples (after settle).
        let rms: f32 = (l[3_800..].iter().map(|s| s * s).sum::<f32>() / 1000.0).sqrt();
        // Original was 1/sqrt(2) RMS. We expect heavy attenuation.
        assert!(rms < 0.2, "expected heavy attenuation, got rms={rms}");
    }

    #[test]
    fn highpass_lets_high_freq_through() {
        let sr = 48_000.0;
        let mut bq = Biquad::default();
        bq.set(BiquadKind::Highpass, sr, 500.0, 0.7071, 0.0);
        let n = 4_800;
        let mut l = vec![0.0; n];
        let mut r = vec![0.0; n];
        for i in 0..n {
            let s = (2.0 * std::f32::consts::PI * 5_000.0 * i as f32 / sr).sin();
            l[i] = s;
            r[i] = s;
        }
        bq.process(&mut l, &mut r);
        let rms: f32 = (l[3_800..].iter().map(|s| s * s).sum::<f32>() / 1000.0).sqrt();
        assert!(rms > 0.5, "expected passband ~unity, got rms={rms}");
    }

    #[test]
    fn identity_preserves_signal() {
        let mut bq = Biquad::default();
        let mut l = vec![0.5, -0.5, 0.25, -0.25];
        let mut r = vec![0.0, 0.0, 0.0, 0.0];
        let orig = l.clone();
        bq.process(&mut l, &mut r);
        for (a, b) in l.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
