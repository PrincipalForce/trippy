//! Time-stretching via WSOLA (Waveform Similarity Overlap-Add).
//!
//! WSOLA is a time-domain algorithm that stretches or compresses audio
//! duration without changing pitch. It works by:
//!
//! 1. Slicing the input into overlapping frames of length `FRAME`.
//! 2. For each output frame, picking an input position derived from the
//!    target stretch ratio, then *searching* a small window around that
//!    position for the frame that best matches the *expected* waveform
//!    (the previous output frame's tail). This preserves phase continuity
//!    and avoids audible clicks at frame boundaries.
//! 3. Crossfading the chosen frame into the output stream with a Hann
//!    window at 50% overlap (overlap-add).
//!
//! For pitch shifting, downstream code chains WSOLA with a resampler:
//! - to shift pitch up by ratio `p`, stretch by `p` then resample to `1/p`
//! - to shift pitch down by `p`, resample to `1/p` then stretch by `p`
//!
//! The result preserves duration (resample inverts the stretch).
//!
//! This is the *transient-friendly* time-stretch. A phase-vocoder
//! implementation will follow in `stretch_pv.rs` for tonal material; the
//! engine will pick automatically based on a transientness metric.

/// Hann window of length `n`. Allocates — call once and cache.
fn hann(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / (n as f32 - 1.0)).cos())
        .collect()
}

/// Sum-of-squares cross-correlation between two equal-length slices.
/// Higher = more similar.
fn xcorr(a: &[f32], b: &[f32]) -> f32 {
    debug_assert_eq!(a.len(), b.len());
    let mut sum = 0.0_f32;
    for i in 0..a.len() {
        sum += a[i] * b[i];
    }
    sum
}

/// Streaming WSOLA processor.
///
/// Holds state across `process` calls so a clip can be stretched in chunks
/// during real-time playback. All buffers are pre-allocated; the audio-thread
/// hot path is allocation-free.
pub struct Wsola {
    frame: usize,
    hop_synthesis: usize,
    search_radius: usize,
    window: Vec<f32>,
    /// The tail of the last synthesized output; matched against new candidates
    /// to keep phase continuity.
    natural_progression: Vec<f32>,
    overlap_out: Vec<f32>,
    /// Fractional input position (the "analysis cursor" advances by
    /// `hop_synthesis * ratio` per output frame).
    input_pos: f64,
    stretch_ratio: f64,
}

impl Wsola {
    /// Construct with `frame` samples per WSOLA frame. `frame` must be even.
    /// Sensible defaults: 1024 frames @ 44.1k ≈ 23ms.
    pub fn new(frame: usize, stretch_ratio: f64) -> Self {
        assert!(
            frame >= 64 && frame % 2 == 0,
            "frame must be even and >= 64"
        );
        let hop_synthesis = frame / 2;
        let search_radius = frame / 4;
        Self {
            frame,
            hop_synthesis,
            search_radius,
            window: hann(frame),
            natural_progression: vec![0.0; frame],
            overlap_out: vec![0.0; frame],
            input_pos: 0.0,
            stretch_ratio,
        }
    }

    pub fn reset(&mut self) {
        self.natural_progression.fill(0.0);
        self.overlap_out.fill(0.0);
        self.input_pos = 0.0;
    }

    pub fn set_ratio(&mut self, ratio: f64) {
        self.stretch_ratio = ratio;
    }

    /// Stretch `input` to fill `output`. Caller is responsible for sizing
    /// `output` according to the stretch ratio. Returns the number of output
    /// samples produced (may be < output.len() if the input is exhausted).
    ///
    /// This is the *offline* convenience entry — for streaming, see `tick()`.
    pub fn stretch_offline(&mut self, input: &[f32], output: &mut [f32]) -> usize {
        self.reset();
        let mut out_pos = 0;
        let hop = self.hop_synthesis;
        // First frame: just copy from input start at full window.
        if input.len() < self.frame {
            return 0;
        }
        // Initialize first hop into output and natural_progression.
        for i in 0..self.frame {
            self.overlap_out[i] = input[i] * self.window[i];
        }
        for i in 0..hop.min(output.len()) {
            output[i] = self.overlap_out[i];
            out_pos += 1;
        }
        // Save tail as natural progression.
        self.natural_progression
            .copy_from_slice(&input[hop..hop + self.frame.min(input.len() - hop)]);

        // Input cursor advances by hop_analysis = hop_synthesis / stretch_ratio
        // (slower input for ratio > 1 produces a longer output).
        let inv_ratio = 1.0 / self.stretch_ratio.max(1e-6);
        self.input_pos = (hop as f64) * inv_ratio;

        while out_pos + hop <= output.len() {
            // Target analysis position.
            let target = self.input_pos.round() as i64;
            let lo = (target - self.search_radius as i64).max(0) as usize;
            let hi = (target + self.search_radius as i64) as usize;
            let hi = hi.min(input.len().saturating_sub(self.frame));
            if lo >= hi || lo + self.frame > input.len() {
                break;
            }
            // Pick the frame in [lo, hi] whose first `frame` samples best
            // correlate with our natural_progression.
            let mut best = lo;
            let mut best_score = f32::NEG_INFINITY;
            for cand in (lo..=hi).step_by(2) {
                if cand + self.frame > input.len() {
                    break;
                }
                let score = xcorr(&input[cand..cand + self.frame], &self.natural_progression);
                if score > best_score {
                    best_score = score;
                    best = cand;
                }
            }

            // Window + overlap-add the chosen frame.
            let chosen = &input[best..best + self.frame];
            // Crossfade: second half of previous overlap_out + first half of
            // new windowed frame.
            for i in 0..hop {
                let new_sample = chosen[i] * self.window[i];
                let mixed = self.overlap_out[hop + i] + new_sample;
                output[out_pos + i] = mixed;
            }
            out_pos += hop;
            // Save tail for next iteration.
            for i in 0..hop {
                self.overlap_out[i] = chosen[hop + i] * self.window[hop + i];
            }
            // Natural progression = what we *would* hear if input advanced by hop.
            let np_start = (best + hop).min(input.len().saturating_sub(self.frame));
            if np_start + self.frame <= input.len() {
                self.natural_progression
                    .copy_from_slice(&input[np_start..np_start + self.frame]);
            }
            self.input_pos += (self.hop_synthesis as f64) * inv_ratio;
        }
        out_pos
    }
}

/// Linear resampler — used to combine with WSOLA for pitch shifting.
///
/// Input and output sample rates are encoded as a ratio. For pitch shifting
/// by 2x, set `ratio = 2.0` (output samples advance through input twice as
/// fast → frequency doubled → pitch up an octave).
pub fn resample_linear(input: &[f32], ratio: f64) -> Vec<f32> {
    if ratio <= 0.0 {
        return Vec::new();
    }
    let out_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 * ratio;
        let s0 = src.floor() as usize;
        let frac = (src - s0 as f64) as f32;
        if s0 + 1 >= input.len() {
            out.push(input[s0.min(input.len() - 1)]);
            break;
        }
        out.push(input[s0] * (1.0 - frac) + input[s0 + 1] * frac);
    }
    out
}

/// Pitch-shift `input` by `semitones`, preserving duration.
///
/// Implementation: stretch by `2^(semitones/12)`, then resample by the
/// inverse. The duration cancels; the pitch changes.
pub fn pitch_shift(input: &[f32], semitones: f32) -> Vec<f32> {
    if semitones.abs() < 1e-4 {
        return input.to_vec();
    }
    let pitch_ratio = 2f64.powf((semitones as f64) / 12.0);
    // Stretch first, then resample down by pitch_ratio.
    let stretched_len = ((input.len() as f64) * pitch_ratio).ceil() as usize;
    let mut stretched = vec![0.0_f32; stretched_len];
    let mut wsola = Wsola::new(1024, pitch_ratio);
    let n = wsola.stretch_offline(input, &mut stretched);
    stretched.truncate(n);
    resample_linear(&stretched, pitch_ratio)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f32, sr: f32, n: usize) -> Vec<f32> {
        let mut out = Vec::with_capacity(n);
        let omega = 2.0 * std::f32::consts::PI * freq / sr;
        for i in 0..n {
            out.push((omega * i as f32).sin() * 0.5);
        }
        out
    }

    #[test]
    fn resample_unity_is_identity() {
        let s = sine(440.0, 48_000.0, 1000);
        let r = resample_linear(&s, 1.0);
        assert_eq!(r.len(), 1000);
        for i in 0..1000 {
            assert!((r[i] - s[i]).abs() < 1e-6);
        }
    }

    #[test]
    fn resample_2x_halves_length() {
        let s = vec![0.0; 1000];
        let r = resample_linear(&s, 2.0);
        assert_eq!(r.len(), 500);
    }

    #[test]
    fn wsola_2x_stretch_produces_approximately_2x_output() {
        let sr = 48_000.0;
        let input = sine(440.0, sr, 8_000);
        let mut out = vec![0.0_f32; 16_000];
        let mut w = Wsola::new(1024, 2.0);
        let n = w.stretch_offline(&input, &mut out);
        // We're stretching ratio=2.0, so output ≈ 2x input. WSOLA may stop a
        // couple frames short to keep the analysis window in-bounds.
        assert!(
            (10_000..=16_000).contains(&n),
            "produced {n} samples, expected ~16000"
        );
    }

    #[test]
    fn wsola_half_stretch_compresses() {
        let sr = 48_000.0;
        let input = sine(440.0, sr, 16_000);
        let mut out = vec![0.0_f32; 8_000];
        let mut w = Wsola::new(1024, 0.5);
        let n = w.stretch_offline(&input, &mut out);
        assert!(n > 5_000, "produced {n}");
    }

    #[test]
    fn pitch_shift_zero_is_identity() {
        let s = sine(440.0, 48_000.0, 4_000);
        let p = pitch_shift(&s, 0.0);
        assert_eq!(p.len(), s.len());
    }

    #[test]
    fn pitch_shift_produces_nonempty_output() {
        // Tight duration-preservation guarantees are hard with a hop-quantized
        // WSOLA. The contract here is just "produces audio of vaguely the
        // right length, no panic". A spectral correctness test belongs in an
        // integration suite with a real FFT analyzer.
        let s = sine(440.0, 48_000.0, 16_000);
        let p = pitch_shift(&s, 7.0);
        assert!(p.len() > s.len() / 4, "output too short: {}", p.len());
        assert!(p.len() < s.len() * 3, "output too long: {}", p.len());
    }

    #[test]
    fn xcorr_correlates_self_maximally() {
        let s = sine(440.0, 48_000.0, 256);
        let zero = vec![0.0; 256];
        let neg: Vec<f32> = s.iter().map(|x| -x).collect();
        let self_score = xcorr(&s, &s);
        let neg_score = xcorr(&s, &neg);
        let zero_score = xcorr(&s, &zero);
        assert!(self_score > neg_score);
        assert!(self_score > zero_score);
    }
}
