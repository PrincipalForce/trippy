//! SIMD-optimized DSP primitives shared across the trippy engine and tools.
//!
//! M0 placeholder. FFT, biquad, oscillators, window functions land alongside
//! the engine MVP in M1.

/// Sums a slice of f32 samples. Trivial M0 smoke-test function.
pub fn sum_f32(samples: &[f32]) -> f32 {
    samples.iter().sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sum_empty_is_zero() {
        assert_eq!(sum_f32(&[]), 0.0);
    }

    #[test]
    fn sum_basic() {
        assert_eq!(sum_f32(&[1.0, 2.0, 3.0]), 6.0);
    }
}
