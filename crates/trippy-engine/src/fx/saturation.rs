//! Soft-clip saturation with drive and output trim.
//!
//! Uses a smooth `tanh`-based curve: gentle compression at moderate drive,
//! aggressive harmonic generation at high drive. Per-sample, stateless, cheap.

use super::Fx;

pub struct Saturation {
    pub drive_db: f32,
    pub output_db: f32,
    pub mix: f32,
}

impl Default for Saturation {
    fn default() -> Self {
        Self {
            drive_db: 0.0,
            output_db: 0.0,
            mix: 1.0,
        }
    }
}

impl Fx for Saturation {
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let drive_lin = 10f32.powf(self.drive_db / 20.0);
        let output_lin = 10f32.powf(self.output_db / 20.0);
        // Compensate output level for drive so loud drive doesn't blow up the bus.
        let post = output_lin / drive_lin.max(1.0).sqrt();
        let mix = self.mix.clamp(0.0, 1.0);
        for i in 0..l.len() {
            let xl = l[i];
            let xr = r[i];
            let yl = (xl * drive_lin).tanh() * post;
            let yr = (xr * drive_lin).tanh() * post;
            l[i] = xl * (1.0 - mix) + yl * mix;
            r[i] = xr * (1.0 - mix) + yr * mix;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_drive_is_near_identity() {
        let mut s = Saturation::default();
        s.drive_db = 0.0;
        s.output_db = 0.0;
        let mut l = vec![0.1, -0.1, 0.05, -0.05];
        let mut r = l.clone();
        let orig = l.clone();
        s.process(&mut l, &mut r);
        for (a, b) in l.iter().zip(orig.iter()) {
            // tanh(x) ≈ x for small x, so error should be tiny.
            assert!((a - b).abs() < 0.001);
        }
    }

    #[test]
    fn extreme_drive_clamps_to_unity() {
        let mut s = Saturation::default();
        s.drive_db = 60.0;
        s.output_db = 0.0;
        s.mix = 1.0;
        let mut l = vec![0.5; 16];
        let mut r = l.clone();
        s.process(&mut l, &mut r);
        // With high drive, tanh saturates near ±1, then is scaled back by post.
        for &v in &l {
            assert!(v.abs() < 1.1);
        }
    }
}
