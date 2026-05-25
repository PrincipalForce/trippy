// Lock-free single-producer / single-consumer ring buffer over a
// SharedArrayBuffer. Used to ferry rendered audio from the engine worker
// (producer) to the AudioWorklet (consumer).
//
// Layout (all values are Int32, little-endian):
//
//   [0]   write index (in frames)
//   [1]   read index  (in frames)
//   [2]   capacity   (in frames; constant)
//   [3]   channels   (constant, 1 or 2)
//   [4..] interleaved Float32 samples (capacity * channels)
//
// The Float32 audio region is aliased over the same SAB starting at byte
// offset HEADER_BYTES (16 bytes).
//
// Producer writes to `samples[write..write+n]` then advances `write` with
// Atomics.store. Consumer reads from `samples[read..read+n]` then advances
// `read`. Both indices wrap modulo `capacity * channels` lazily — we keep
// them as monotonically increasing u32-style counters and compute slots via
// `index % capacity`. Capacity must be a power of two for cheap wrap.

const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4;

export interface RingBuffer {
  readonly sab: SharedArrayBuffer;
  readonly capacityFrames: number;
  readonly channels: number;
  readonly samples: Float32Array;
  readonly state: Int32Array;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/** Build a new ring buffer. `capacityFrames` must be a power of two. */
export function createRingBuffer(
  capacityFrames: number,
  channels: 1 | 2,
): RingBuffer {
  if (!isPowerOfTwo(capacityFrames)) {
    throw new Error(`ringbuffer capacity must be a power of two, got ${capacityFrames}`);
  }
  const sampleBytes = capacityFrames * channels * 4;
  const sab = new SharedArrayBuffer(HEADER_BYTES + sampleBytes);
  const state = new Int32Array(sab, 0, HEADER_INTS);
  state[2] = capacityFrames;
  state[3] = channels;
  const samples = new Float32Array(sab, HEADER_BYTES, capacityFrames * channels);
  return { sab, capacityFrames, channels, samples, state };
}

/** Reconstruct a ring buffer view over an existing SAB (e.g. in a worker). */
export function attachRingBuffer(sab: SharedArrayBuffer): RingBuffer {
  const state = new Int32Array(sab, 0, HEADER_INTS);
  const capacityFrames = state[2]!;
  const channels = state[3]! as 1 | 2;
  const samples = new Float32Array(sab, HEADER_BYTES, capacityFrames * channels);
  return { sab, capacityFrames, channels, samples, state };
}

/** Available frames to read (consumer view). */
export function availableRead(rb: RingBuffer): number {
  const w = Atomics.load(rb.state, 0);
  const r = Atomics.load(rb.state, 1);
  return (w - r) | 0;
}

/** Free frames available to write (producer view). */
export function availableWrite(rb: RingBuffer): number {
  const w = Atomics.load(rb.state, 0);
  const r = Atomics.load(rb.state, 1);
  return (rb.capacityFrames - ((w - r) | 0)) | 0;
}

/**
 * Producer: write `frames` interleaved stereo samples (length = frames * channels)
 * from `src` into the ring. Returns the number of frames written.
 * Caller is responsible for not over-writing — check `availableWrite` first.
 */
export function writeFrames(rb: RingBuffer, src: Float32Array, frames: number): number {
  const cap = rb.capacityFrames;
  const ch = rb.channels;
  const w = Atomics.load(rb.state, 0);
  const slot = (w & (cap - 1)) * ch;
  const samplesToWrite = frames * ch;
  const tail = cap * ch - slot;
  if (samplesToWrite <= tail) {
    rb.samples.set(src.subarray(0, samplesToWrite), slot);
  } else {
    rb.samples.set(src.subarray(0, tail), slot);
    rb.samples.set(src.subarray(tail, samplesToWrite), 0);
  }
  Atomics.store(rb.state, 0, (w + frames) | 0);
  // Wake any consumer that's parked. Wake is harmless if no waiter.
  Atomics.notify(rb.state, 0, 1);
  return frames;
}

/**
 * Consumer: read up to `frames` frames into `outL`/`outR` (deinterleaving).
 * For mono rings, outR receives the same samples as outL.
 * Returns the number of frames actually delivered.
 */
export function readFramesDeinterleaved(
  rb: RingBuffer,
  outL: Float32Array,
  outR: Float32Array,
  frames: number,
): number {
  const cap = rb.capacityFrames;
  const ch = rb.channels;
  const w = Atomics.load(rb.state, 0);
  const r = Atomics.load(rb.state, 1);
  const avail = (w - r) | 0;
  const n = Math.min(frames, avail);
  if (n === 0) return 0;
  const startSlot = (r & (cap - 1)) * ch;
  const samples = rb.samples;
  if (ch === 2) {
    for (let i = 0; i < n; i++) {
      const idx = (startSlot + i * 2) & ((cap * 2) - 1);
      outL[i] = samples[idx]!;
      outR[i] = samples[idx + 1]!;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const idx = (startSlot + i) & (cap - 1);
      const v = samples[idx]!;
      outL[i] = v;
      outR[i] = v;
    }
  }
  Atomics.store(rb.state, 1, (r + n) | 0);
  return n;
}
