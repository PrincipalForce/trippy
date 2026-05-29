// Algorithmic tempo / beat detection.
//
// Approach (classic, well-trodden):
//   1. Downmix to mono.
//   2. Compute a short-time spectral-flux onset envelope using a small FFT
//      window. Spectral flux = sum over bins of positive magnitude
//      differences between consecutive frames. It spikes on percussive
//      attacks and is roughly genre-agnostic.
//   3. Autocorrelate the onset envelope, weighted toward musical tempos
//      (a log-Gaussian prior around 120 BPM) so we don't lock onto
//      half/double-time.
//   4. Pick the peak lag → BPM.
//
// No ML required for the v1 — this works well on percussive material
// (drums, beats, loops). Tonal material with no clear pulse gets a low
// confidence and the UI ignores it.
//
// Why not just use the FFT magnitudes directly: flux's positive-difference
// step suppresses the steady-state energy from tonal content, so the
// envelope is dominated by attacks. That's the whole game.

const FFT_SIZE = 1024;
const HOP_SIZE = 512;
// Tempo search bounds. Musical floor ≈ 50, ceiling ≈ 200; outside that we
// usually want to halve/double, which the prior handles.
const MIN_BPM = 60;
const MAX_BPM = 200;
const PRIOR_CENTER_BPM = 120;
const PRIOR_SIGMA = 0.7; // wide log-normal — accepts most genres

export interface TempoEstimate {
  bpm: number;
  /** 0..1. Below ~0.35 the estimate is probably noise. */
  confidence: number;
}

export function detectTempo(
  channels: Float32Array[],
  sampleRate: number,
): TempoEstimate {
  if (channels.length === 0 || !channels[0] || channels[0].length < FFT_SIZE * 4) {
    return { bpm: 120, confidence: 0 };
  }
  const mono = downmix(channels);
  const flux = spectralFluxEnvelope(mono, sampleRate);
  if (flux.length < 32) return { bpm: 120, confidence: 0 };
  const envSr = sampleRate / HOP_SIZE;
  return tempoFromOnsetEnvelope(flux, envSr);
}

function downmix(channels: Float32Array[]): Float32Array {
  const n = channels[0]!.length;
  if (channels.length === 1) return channels[0]!;
  const out = new Float32Array(n);
  const inv = 1 / channels.length;
  for (let ch = 0; ch < channels.length; ch++) {
    const c = channels[ch]!;
    for (let i = 0; i < n; i++) out[i] = out[i]! + c[i]! * inv;
  }
  return out;
}

// Compute spectral flux per hop. Uses a real-only radix-2 FFT inline.
function spectralFluxEnvelope(mono: Float32Array, _sampleRate: number): Float32Array {
  const nFrames = Math.max(0, Math.floor((mono.length - FFT_SIZE) / HOP_SIZE) + 1);
  const env = new Float32Array(nFrames);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  const window = hann(FFT_SIZE);
  const halfBins = FFT_SIZE / 2;
  let prevMag = new Float32Array(halfBins);

  for (let f = 0; f < nFrames; f++) {
    const offset = f * HOP_SIZE;
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = mono[offset + i]! * window[i]!;
      im[i] = 0;
    }
    fftInPlace(re, im);

    let flux = 0;
    for (let k = 1; k < halfBins; k++) {
      const mag = Math.sqrt(re[k]! * re[k]! + im[k]! * im[k]!);
      const d = mag - prevMag[k]!;
      if (d > 0) flux += d;
      prevMag[k] = mag;
    }
    env[f] = flux;
  }

  // Normalize + half-wave rectify + light smoothing for stability.
  return postprocessEnvelope(env);
}

function postprocessEnvelope(env: Float32Array): Float32Array {
  let max = 0;
  for (let i = 0; i < env.length; i++) if (env[i]! > max) max = env[i]!;
  if (max <= 0) return env;
  const out = new Float32Array(env.length);
  // Subtract a moving-mean baseline so steady-state energy doesn't bias the
  // autocorrelation. Window ≈ 1 second when envSr ≈ 86 Hz (1024/512 @ 44.1k).
  const winRadius = 43;
  let runSum = 0;
  for (let i = 0; i < Math.min(env.length, winRadius); i++) runSum += env[i]!;
  for (let i = 0; i < env.length; i++) {
    const lo = Math.max(0, i - winRadius);
    const hi = Math.min(env.length - 1, i + winRadius);
    // O(1) sliding window
    if (i - winRadius - 1 >= 0) runSum -= env[i - winRadius - 1]!;
    if (i + winRadius < env.length) runSum += env[i + winRadius]!;
    const mean = runSum / (hi - lo + 1);
    const v = env[i]! / max - mean / max;
    out[i] = v > 0 ? v : 0;
  }
  return out;
}

// Bias autocorrelation toward musical tempos via a log-Gaussian prior centered
// on PRIOR_CENTER_BPM. Returns the BPM with the best (acf × prior) score.
function tempoFromOnsetEnvelope(env: Float32Array, envSr: number): TempoEstimate {
  const minLag = Math.floor((envSr * 60) / MAX_BPM);
  const maxLag = Math.ceil((envSr * 60) / MIN_BPM);
  if (maxLag >= env.length / 2) {
    return { bpm: 120, confidence: 0 };
  }
  const acf = new Float32Array(maxLag + 1);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let s = 0;
    const upto = env.length - lag;
    for (let i = 0; i < upto; i++) s += env[i]! * env[i + lag]!;
    acf[lag] = s / upto;
  }

  let bestLag = minLag;
  let bestScore = -Infinity;
  let secondBest = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (envSr * 60) / lag;
    const logRatio = Math.log(bpm / PRIOR_CENTER_BPM);
    const prior = Math.exp(-(logRatio * logRatio) / (2 * PRIOR_SIGMA * PRIOR_SIGMA));
    const score = acf[lag]! * prior;
    if (score > bestScore) {
      secondBest = bestScore;
      bestScore = score;
      bestLag = lag;
    } else if (score > secondBest) {
      secondBest = score;
    }
  }

  const bpm = (envSr * 60) / bestLag;
  // Confidence = peak prominence above the runner-up. Cheap and surprisingly
  // well-calibrated: a clear pulse gives 0.5+, ambient material rarely > 0.2.
  let confidence = 0;
  if (bestScore > 0 && Number.isFinite(secondBest)) {
    confidence = Math.max(0, Math.min(1, (bestScore - secondBest) / bestScore));
  }
  return { bpm, confidence };
}

function hann(n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  }
  return out;
}

// In-place radix-2 Cooley–Tukey FFT. `re.length` must be a power of two.
function fftInPlace(re: Float32Array, im: Float32Array) {
  const n = re.length;
  // Bit-reversal permutation.
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const angStep = (-2 * Math.PI) / len;
    const wRe = Math.cos(angStep);
    const wIm = Math.sin(angStep);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < half; k++) {
        const tRe = curRe * re[i + k + half]! - curIm * im[i + k + half]!;
        const tIm = curRe * im[i + k + half]! + curIm * re[i + k + half]!;
        re[i + k + half] = re[i + k]! - tRe;
        im[i + k + half] = im[i + k]! - tIm;
        re[i + k] = re[i + k]! + tRe;
        im[i + k] = im[i + k]! + tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}
