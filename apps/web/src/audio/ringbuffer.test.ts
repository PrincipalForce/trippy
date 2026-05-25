import { describe, it, expect } from "vitest";
import {
  createRingBuffer,
  attachRingBuffer,
  writeFrames,
  readFramesDeinterleaved,
  availableRead,
  availableWrite,
} from "./ringbuffer";

// JSDom isn't required — SharedArrayBuffer + Atomics work in node 16+.
describe("ringbuffer", () => {
  it("rejects non-power-of-two capacity", () => {
    expect(() => createRingBuffer(100, 2)).toThrow();
  });

  it("round-trips stereo frames", () => {
    const rb = createRingBuffer(8, 2);
    expect(availableRead(rb)).toBe(0);
    expect(availableWrite(rb)).toBe(8);

    // Write 4 frames: (1L,1R), (2,2), (3,3), (4,4)
    const src = new Float32Array([1, -1, 2, -2, 3, -3, 4, -4]);
    writeFrames(rb, src, 4);
    expect(availableRead(rb)).toBe(4);

    const l = new Float32Array(4);
    const r = new Float32Array(4);
    const got = readFramesDeinterleaved(rb, l, r, 4);
    expect(got).toBe(4);
    expect(Array.from(l)).toEqual([1, 2, 3, 4]);
    expect(Array.from(r)).toEqual([-1, -2, -3, -4]);
    expect(availableRead(rb)).toBe(0);
  });

  it("wraps around the buffer", () => {
    const rb = createRingBuffer(4, 2);
    // Fill: 4 frames
    writeFrames(rb, new Float32Array([1, 1, 2, 2, 3, 3, 4, 4]), 4);
    // Consume 3
    const l = new Float32Array(3);
    const r = new Float32Array(3);
    readFramesDeinterleaved(rb, l, r, 3);
    expect(Array.from(l)).toEqual([1, 2, 3]);

    // Write 3 more — this wraps from slot 0 because capacity is 4 and write
    // index is at 4 (slot 0 modulo 4).
    writeFrames(rb, new Float32Array([5, 5, 6, 6, 7, 7]), 3);
    expect(availableRead(rb)).toBe(4);
    const l2 = new Float32Array(4);
    const r2 = new Float32Array(4);
    readFramesDeinterleaved(rb, l2, r2, 4);
    expect(Array.from(l2)).toEqual([4, 5, 6, 7]);
  });

  it("returns partial read on underrun", () => {
    const rb = createRingBuffer(4, 2);
    writeFrames(rb, new Float32Array([1, 1, 2, 2]), 2);
    const l = new Float32Array(4);
    const r = new Float32Array(4);
    const got = readFramesDeinterleaved(rb, l, r, 4);
    expect(got).toBe(2);
  });

  it("mono ring duplicates samples into both outputs", () => {
    const rb = createRingBuffer(8, 1);
    writeFrames(rb, new Float32Array([0.1, 0.2, 0.3]), 3);
    const l = new Float32Array(3);
    const r = new Float32Array(3);
    readFramesDeinterleaved(rb, l, r, 3);
    expect(Array.from(l)).toEqual([0.1, 0.2, 0.3].map((n) => Math.fround(n)));
    expect(Array.from(r)).toEqual(Array.from(l));
  });

  it("attach reuses the same SAB layout", () => {
    const rb1 = createRingBuffer(16, 2);
    const rb2 = attachRingBuffer(rb1.sab);
    writeFrames(rb1, new Float32Array([0.5, -0.5]), 1);
    const l = new Float32Array(1);
    const r = new Float32Array(1);
    readFramesDeinterleaved(rb2, l, r, 1);
    expect(l[0]).toBeCloseTo(0.5);
    expect(r[0]).toBeCloseTo(-0.5);
  });
});
