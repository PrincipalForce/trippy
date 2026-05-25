// Multi-resolution peak data for fast waveform rendering.
//
// Storing raw PCM and resampling per draw call is wasteful — a 3-minute stereo
// 48k loop is 17 MB. Instead we precompute a tree of min/max peaks at multiple
// zoom levels. Each level summarizes the previous one by a factor of `BUCKET`
// (8 by default), so we need ~log_BUCKET(N) levels.
//
// At render time we pick the level whose bucket size is just smaller than the
// pixels-per-second resolution being asked for, then fetch min/max pairs and
// draw vertical bars. This gives O(width) draw cost regardless of clip length.

const BUCKET = 8;

export interface WaveformLevel {
  bucketSize: number; // frames per bucket
  /** Interleaved (min, max) pairs per bucket, one mono channel. */
  data: Float32Array;
}

export interface Waveform {
  sampleRate: number;
  frameCount: number;
  channels: number;
  /** Per-channel multi-resolution levels. Index 0 = finest level. */
  levels: WaveformLevel[][];
}

export function buildWaveform(
  channels: Float32Array[],
  sampleRate: number,
): Waveform {
  const frameCount = channels[0]?.length ?? 0;
  const perChannel: WaveformLevel[][] = channels.map((ch) =>
    buildPyramid(ch),
  );
  return {
    sampleRate,
    frameCount,
    channels: channels.length,
    levels: perChannel,
  };
}

function buildPyramid(samples: Float32Array): WaveformLevel[] {
  const levels: WaveformLevel[] = [];
  // Level 0: bucket size BUCKET over raw samples.
  let bucketSize = BUCKET;
  let buckets = Math.ceil(samples.length / bucketSize);
  let data = new Float32Array(buckets * 2);
  for (let b = 0; b < buckets; b++) {
    let mn = Infinity;
    let mx = -Infinity;
    const start = b * bucketSize;
    const end = Math.min(start + bucketSize, samples.length);
    for (let i = start; i < end; i++) {
      const v = samples[i]!;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mn === Infinity) {
      mn = 0;
      mx = 0;
    }
    data[b * 2] = mn;
    data[b * 2 + 1] = mx;
  }
  levels.push({ bucketSize, data });

  // Subsequent levels: each bucket summarizes BUCKET buckets of the prior level.
  while (buckets > BUCKET) {
    bucketSize *= BUCKET;
    const nextBuckets = Math.ceil(buckets / BUCKET);
    const nextData = new Float32Array(nextBuckets * 2);
    for (let b = 0; b < nextBuckets; b++) {
      let mn = Infinity;
      let mx = -Infinity;
      const start = b * BUCKET;
      const end = Math.min(start + BUCKET, buckets);
      for (let i = start; i < end; i++) {
        const lmn = data[i * 2]!;
        const lmx = data[i * 2 + 1]!;
        if (lmn < mn) mn = lmn;
        if (lmx > mx) mx = lmx;
      }
      if (mn === Infinity) {
        mn = 0;
        mx = 0;
      }
      nextData[b * 2] = mn;
      nextData[b * 2 + 1] = mx;
    }
    levels.push({ bucketSize, data: nextData });
    buckets = nextBuckets;
    data = nextData;
  }

  return levels;
}

/**
 * Pick the level whose bucket size is just <= `framesPerPixel`. Returns the
 * finest level if all are larger, the coarsest if all are smaller.
 */
export function chooseLevel(
  pyramid: WaveformLevel[],
  framesPerPixel: number,
): WaveformLevel {
  for (let i = pyramid.length - 1; i >= 0; i--) {
    if (pyramid[i]!.bucketSize <= framesPerPixel) return pyramid[i]!;
  }
  return pyramid[0]!;
}
