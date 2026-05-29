import { describe, it, expect } from "vitest";
import { detectTempo } from "./tempo";

// Synthesize a click track: short exponential bursts at fixed BPM. This is
// the simplest signal that should yield a clean BPM lock — if the algorithm
// can't handle pure clicks, it has no business looking at music.
function synthClickTrack(bpm: number, seconds: number, sampleRate: number): Float32Array {
  const n = Math.floor(seconds * sampleRate);
  const out = new Float32Array(n);
  const framesPerBeat = (60 / bpm) * sampleRate;
  const burstLen = Math.floor(sampleRate * 0.02); // 20 ms click
  let beat = 0;
  while (true) {
    const start = Math.floor(beat * framesPerBeat);
    if (start >= n) break;
    for (let i = 0; i < burstLen && start + i < n; i++) {
      // Exponential decay with a touch of noise so flux isn't trivially
      // periodic in a way that masks bugs.
      const env = Math.exp(-i / (sampleRate * 0.004));
      const noise = (Math.random() - 0.5) * 0.05;
      out[start + i] = env * (Math.sin((2 * Math.PI * 1500 * i) / sampleRate) + noise);
    }
    beat++;
  }
  return out;
}

describe("detectTempo", () => {
  it("locks onto a 120 BPM click track", () => {
    const sr = 44_100;
    const click = synthClickTrack(120, 6, sr);
    const { bpm, confidence } = detectTempo([click], sr);
    expect(Math.abs(bpm - 120)).toBeLessThan(2);
    expect(confidence).toBeGreaterThan(0.2);
  });

  it("locks onto 90 BPM", () => {
    const sr = 44_100;
    const click = synthClickTrack(90, 6, sr);
    const { bpm, confidence } = detectTempo([click], sr);
    // Allow half/double; the prior should keep us on 90.
    const ok =
      Math.abs(bpm - 90) < 3 || Math.abs(bpm - 180) < 5 || Math.abs(bpm - 45) < 3;
    expect(ok).toBe(true);
    expect(confidence).toBeGreaterThan(0.15);
  });

  it("returns low confidence on silence", () => {
    const sr = 44_100;
    const silence = new Float32Array(sr * 4);
    const { confidence } = detectTempo([silence], sr);
    expect(confidence).toBeLessThan(0.1);
  });

  it("handles too-short input gracefully", () => {
    const sr = 44_100;
    const tiny = new Float32Array(100);
    const r = detectTempo([tiny], sr);
    expect(r.confidence).toBe(0);
  });
});
