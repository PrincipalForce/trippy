// Lightweight client-side audio decode for waveform visualization.
//
// The Rust engine has its own WAV decoder for *playback* (runs in the engine
// worker, only needs samples). For *rendering*, the UI thread needs samples
// too — we use the browser's built-in `decodeAudioData` which handles wav,
// mp3, flac, ogg, m4a, ... uniformly.

let _ctx: OfflineAudioContext | null = null;
function ctx(): OfflineAudioContext {
  // 48k mono, 1 frame — the context is only used as a decoder source, not for
  // actual rendering. decodeAudioData runs independent of context length.
  if (!_ctx) _ctx = new OfflineAudioContext(2, 1, 48_000);
  return _ctx;
}

export interface DecodedAudio {
  sampleRate: number;
  channels: Float32Array[];
  frameCount: number;
}

export async function decodeAudio(bytes: ArrayBuffer): Promise<DecodedAudio> {
  // decodeAudioData mutates the buffer in some engines; slice for safety.
  const buf = await ctx().decodeAudioData(bytes.slice(0));
  const channels: Float32Array[] = [];
  for (let i = 0; i < buf.numberOfChannels; i++) {
    channels.push(buf.getChannelData(i).slice());
  }
  return {
    sampleRate: buf.sampleRate,
    channels,
    frameCount: buf.length,
  };
}
