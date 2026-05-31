import { describe, it, expect, beforeAll } from "vitest";
import { splitIntoFrequencyBands } from "./stems";

// vitest's default environment is "node" — there's no OfflineAudioContext.
// Provide a tiny shim that does naive single-pole filtering so the test
// validates wiring + band routing without depending on a browser. The
// browser path uses the real Web Audio biquads.
beforeAll(() => {
  if (typeof OfflineAudioContext === "undefined") {
    const g = globalThis as unknown as Record<string, unknown>;
    g.OfflineAudioContext = class {
      destination: { connections: unknown[] } = { connections: [] };
      private numChannels: number;
      private frames: number;
      private sampleRate: number;
      private nodes: Array<{
        type: "src" | "biquad";
        kind?: BiquadFilterType;
        freq?: number;
        buffer?: { channels: Float32Array[] };
        outputs: unknown[];
      }> = [];
      constructor(numChannels: number, frames: number, sampleRate: number) {
        this.numChannels = numChannels;
        this.frames = frames;
        this.sampleRate = sampleRate;
      }
      createBufferSource() {
        const node = { type: "src" as const, buffer: undefined as undefined | { channels: Float32Array[] }, outputs: [] as unknown[] };
        this.nodes.push(node);
        return {
          get buffer() {
            return node.buffer;
          },
          set buffer(b: { channels: Float32Array[] } | undefined) {
            node.buffer = b;
          },
          connect: (next: { __node: unknown }) => {
            node.outputs.push(next.__node);
            return next;
          },
          start: () => {},
        };
      }
      createBuffer(numChannels: number, frames: number, _sampleRate: number) {
        const channels = Array.from({ length: numChannels }, () => new Float32Array(frames));
        return {
          channels,
          copyToChannel: (src: Float32Array, ch: number) => {
            channels[ch]!.set(src);
          },
          copyFromChannel: (dst: Float32Array, ch: number) => {
            dst.set(channels[ch]!);
          },
        };
      }
      createBiquadFilter() {
        const node = { type: "biquad" as const, kind: "lowpass" as BiquadFilterType, freq: 1000, outputs: [] as unknown[] };
        this.nodes.push(node);
        const proxy: { __node: typeof node; type: BiquadFilterType; frequency: { value: number }; Q: { value: number }; connect: (next: { __node?: unknown }) => unknown } = {
          __node: node,
          get type() {
            return node.kind;
          },
          set type(v: BiquadFilterType) {
            node.kind = v;
          },
          frequency: {
            get value() {
              return node.freq;
            },
            set value(v: number) {
              node.freq = v;
            },
          },
          Q: { value: 0.707 },
          connect: (next: { __node?: unknown }) => {
            node.outputs.push("__node" in next ? next.__node : "dest");
            return next;
          },
        };
        return proxy;
      }
      async startRendering() {
        // Walk: src → biquad(s) → destination. Apply naive single-pole
        // filtering per biquad (lowpass / highpass only, since that's
        // what we use). Sufficient to verify band-routing in tests.
        const src = this.nodes.find((n) => n.type === "src");
        if (!src?.buffer) throw new Error("no source");
        let current = src.buffer.channels.map((c) => Array.from(c));
        let cursor: unknown = src;
        while (true) {
          const next = (cursor as { outputs: unknown[] }).outputs[0];
          if (!next || next === "dest") break;
          const node = next as { type: "biquad"; kind: BiquadFilterType; freq: number; outputs: unknown[] };
          // Cheap RC filter approximation, just to attenuate the right side.
          const alpha = 1 / (1 + this.sampleRate / (2 * Math.PI * node.freq));
          if (node.kind === "lowpass") {
            for (const ch of current) {
              let prev = 0;
              for (let i = 0; i < ch.length; i++) {
                prev = prev + alpha * (ch[i]! - prev);
                ch[i] = prev;
              }
            }
          } else if (node.kind === "highpass") {
            for (const ch of current) {
              let prev = 0;
              let prevIn = 0;
              for (let i = 0; i < ch.length; i++) {
                const out = alpha * (prev + ch[i]! - prevIn);
                prevIn = ch[i]!;
                prev = out;
                ch[i] = out;
              }
            }
          }
          cursor = node;
        }
        const rendered = current.map((c) => Float32Array.from(c));
        return {
          copyFromChannel: (dst: Float32Array, ch: number) => {
            dst.set(rendered[ch]!);
          },
        };
      }
    } as unknown as typeof OfflineAudioContext;
  }
});

function sineAt(freqHz: number, sampleRate: number, frames: number): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    out[i] = Math.sin((2 * Math.PI * freqHz * i) / sampleRate);
  }
  return out;
}

function rms(buf: Float32Array): number {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i]! * buf[i]!;
  return Math.sqrt(s / buf.length);
}

describe("splitIntoFrequencyBands", () => {
  it("routes a 80 Hz tone primarily to the bass band", async () => {
    const sr = 48_000;
    const tone = sineAt(80, sr, sr);
    const out = await splitIntoFrequencyBands([tone], sr);
    const byBand = Object.fromEntries(out.map((b) => [b.band, rms(b.channels[0]!)]));
    expect(byBand.bass!).toBeGreaterThan(byBand.high!);
    expect(byBand.bass!).toBeGreaterThan(byBand.high_mid!);
  });

  it("routes an 8 kHz tone primarily to the high band", async () => {
    const sr = 48_000;
    const tone = sineAt(8000, sr, sr);
    const out = await splitIntoFrequencyBands([tone], sr);
    const byBand = Object.fromEntries(out.map((b) => [b.band, rms(b.channels[0]!)]));
    expect(byBand.high!).toBeGreaterThan(byBand.bass!);
    expect(byBand.high!).toBeGreaterThan(byBand.low_mid!);
  });

  it("rejects empty input", async () => {
    await expect(splitIntoFrequencyBands([], 48_000)).rejects.toThrow();
  });
});
