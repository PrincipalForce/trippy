//! N-band parametric EQ built from biquads.
//!
//! Each band is a peak filter; the outermost bands can be configured as
//! shelves for traditional treble/bass control. Bands process serially.

use super::biquad::{Biquad, BiquadKind};
use super::Fx;

#[derive(Debug, Clone, Copy)]
pub struct EqBand {
    pub kind: BiquadKind,
    pub freq: f32,
    pub q: f32,
    pub gain_db: f32,
    pub enabled: bool,
}

pub struct Eq {
    sample_rate: f32,
    bands: Vec<(EqBand, Biquad)>,
}

impl Eq {
    pub fn new(sample_rate: f32, bands: Vec<EqBand>) -> Self {
        let mut filters = Vec::with_capacity(bands.len());
        for b in bands {
            let mut bq = Biquad::default();
            bq.set(b.kind, sample_rate, b.freq, b.q, b.gain_db);
            filters.push((b, bq));
        }
        Self {
            sample_rate,
            bands: filters,
        }
    }

    pub fn set_band(&mut self, idx: usize, band: EqBand) {
        if let Some((cfg, bq)) = self.bands.get_mut(idx) {
            *cfg = band;
            bq.set(band.kind, self.sample_rate, band.freq, band.q, band.gain_db);
        }
    }
}

impl Fx for Eq {
    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (cfg, bq) in self.bands.iter_mut() {
            if cfg.enabled {
                bq.process(l, r);
            }
        }
    }

    fn reset(&mut self) {
        for (_, bq) in self.bands.iter_mut() {
            bq.reset();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn disabled_bands_are_identity() {
        let mut eq = Eq::new(
            48_000.0,
            vec![EqBand {
                kind: BiquadKind::Peak,
                freq: 1000.0,
                q: 1.0,
                gain_db: 12.0,
                enabled: false,
            }],
        );
        let mut l = vec![0.1, -0.2, 0.3, -0.4];
        let mut r = l.clone();
        let orig = l.clone();
        eq.process(&mut l, &mut r);
        for (a, b) in l.iter().zip(orig.iter()) {
            assert!((a - b).abs() < 1e-6);
        }
    }
}
