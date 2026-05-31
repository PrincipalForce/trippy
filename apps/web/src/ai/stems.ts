// "Stems" v1: 4-band frequency split.
//
// **What this is:** the input clip is filtered into four overlapping
// frequency bands (bass, low-mid, high-mid, high) using cascaded biquads.
// Each band lands as a new track. Soloing a band, EQ-ing it independently,
// or muting noisy bands all become trivial.
//
// **What this isn't:** real source separation. A snare hit lives in three
// of these bands at once; a bassline with harmonics bleeds into low-mid.
// Real stem separation (drums/bass/vocals/other) needs a Demucs-class CNN
// — out of scope for this commit but the engine + UI plumbing here is the
// same path it'll take.
//
// We use OfflineAudioContext for the actual filtering: nothing custom to
// debug, hardware-tuned biquads, runs off the main thread internally.

export type StemBand = "bass" | "low_mid" | "high_mid" | "high";

export interface StemBandConfig {
  /** Display label used as a track-name suffix. */
  label: string;
  /** Filter spec — applied in series. */
  filters: Array<{ type: BiquadFilterType; frequency: number; Q?: number }>;
}

// Bands chosen to roughly bracket musical roles:
//   bass     : <  200 Hz   — kick body, sub, bass fundamental
//   low_mid  : 200 – 800   — bass harmonics, low piano, body of drums
//   high_mid : 800 – 4 k   — snares, vocals, guitar presence
//   high     : > 4 kHz     — hats, cymbals, vocal sibilance, air
// Each crossover uses a single biquad at Q=0.707 (Butterworth) so the
// summed bands roughly approximate the original spectrum without
// significant peaks at the crossover frequencies.
const Q_BUTTERWORTH = 0.707;
export const BAND_CONFIGS: Record<StemBand, StemBandConfig> = {
  bass: {
    label: "bass",
    filters: [{ type: "lowpass", frequency: 200, Q: Q_BUTTERWORTH }],
  },
  low_mid: {
    label: "low-mid",
    filters: [
      { type: "highpass", frequency: 200, Q: Q_BUTTERWORTH },
      { type: "lowpass", frequency: 800, Q: Q_BUTTERWORTH },
    ],
  },
  high_mid: {
    label: "high-mid",
    filters: [
      { type: "highpass", frequency: 800, Q: Q_BUTTERWORTH },
      { type: "lowpass", frequency: 4000, Q: Q_BUTTERWORTH },
    ],
  },
  high: {
    label: "high",
    filters: [{ type: "highpass", frequency: 4000, Q: Q_BUTTERWORTH }],
  },
};

export interface StemSplitResult {
  band: StemBand;
  config: StemBandConfig;
  channels: Float32Array[];
}

/**
 * Split `channels` into the four frequency bands. `sampleRate` must match
 * the input audio; the returned per-band channels are at the same rate and
 * same length as the input. Runs the four bands sequentially (cheap; even
 * a long clip takes well under a second on a phone).
 */
export async function splitIntoFrequencyBands(
  channels: Float32Array[],
  sampleRate: number,
): Promise<StemSplitResult[]> {
  if (channels.length === 0 || !channels[0]) {
    throw new Error("splitIntoFrequencyBands: no channels");
  }
  const numChannels = channels.length;
  const frames = channels[0].length;
  const out: StemSplitResult[] = [];
  for (const band of Object.keys(BAND_CONFIGS) as StemBand[]) {
    const config = BAND_CONFIGS[band];
    const filtered = await renderBand(channels, sampleRate, numChannels, frames, config);
    out.push({ band, config, channels: filtered });
  }
  return out;
}

async function renderBand(
  channels: Float32Array[],
  sampleRate: number,
  numChannels: number,
  frames: number,
  config: StemBandConfig,
): Promise<Float32Array[]> {
  const ctx = new OfflineAudioContext(numChannels, frames, sampleRate);
  const src = ctx.createBufferSource();
  const buf = ctx.createBuffer(numChannels, frames, sampleRate);
  for (let c = 0; c < numChannels; c++) buf.copyToChannel(channels[c]! as Float32Array<ArrayBuffer>, c);
  src.buffer = buf;

  // Chain the filters in series.
  let head: AudioNode = src;
  for (const f of config.filters) {
    const bq = ctx.createBiquadFilter();
    bq.type = f.type;
    bq.frequency.value = f.frequency;
    bq.Q.value = f.Q ?? Q_BUTTERWORTH;
    head.connect(bq);
    head = bq;
  }
  head.connect(ctx.destination);
  src.start();
  const rendered = await ctx.startRendering();
  const result: Float32Array[] = [];
  for (let c = 0; c < numChannels; c++) {
    // Copy out of the rendered AudioBuffer so it can be GC'd.
    const arr = new Float32Array(frames);
    rendered.copyFromChannel(arr, c);
    result.push(arr);
  }
  return result;
}
