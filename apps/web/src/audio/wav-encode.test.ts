import { describe, it, expect } from "vitest";
import { encodeWavPcm16 } from "./wav-encode";

function readU32LE(buf: ArrayBuffer, offset: number): number {
  return new DataView(buf).getUint32(offset, true);
}

function readU16LE(buf: ArrayBuffer, offset: number): number {
  return new DataView(buf).getUint16(offset, true);
}

function readAscii(buf: ArrayBuffer, offset: number, len: number): string {
  const v = new DataView(buf);
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(v.getUint8(offset + i));
  return s;
}

describe("encodeWavPcm16", () => {
  it("produces a valid RIFF/WAVE header", () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buf = encodeWavPcm16([samples], 48_000);
    expect(readAscii(buf, 0, 4)).toBe("RIFF");
    expect(readAscii(buf, 8, 4)).toBe("WAVE");
    expect(readAscii(buf, 12, 4)).toBe("fmt ");
    expect(readU32LE(buf, 16)).toBe(16);
    expect(readU16LE(buf, 20)).toBe(1); // PCM
    expect(readU16LE(buf, 22)).toBe(1); // mono
    expect(readU32LE(buf, 24)).toBe(48_000);
    expect(readU16LE(buf, 34)).toBe(16); // bits
    expect(readAscii(buf, 36, 4)).toBe("data");
    expect(readU32LE(buf, 40)).toBe(samples.length * 2);
  });

  it("interleaves stereo correctly", () => {
    const l = new Float32Array([1, 0, -1]);
    const r = new Float32Array([0, 1, 0]);
    const buf = encodeWavPcm16([l, r], 44_100);
    const v = new DataView(buf);
    // header is 44 bytes; first frame = L0, R0
    expect(v.getInt16(44, true)).toBeCloseTo(32767, 0); // L=+1 → 32767
    expect(v.getInt16(46, true)).toBe(0); // R=0
    expect(v.getInt16(48, true)).toBe(0); // L=0
    expect(v.getInt16(50, true)).toBeCloseTo(32767, 0); // R=+1
    expect(v.getInt16(52, true)).toBe(-32768); // L=-1
  });

  it("clamps out-of-range floats", () => {
    const samples = new Float32Array([2.0, -2.0]);
    const buf = encodeWavPcm16([samples], 8_000);
    const v = new DataView(buf);
    expect(v.getInt16(44, true)).toBe(32767);
    expect(v.getInt16(46, true)).toBe(-32768);
  });

  it("rejects empty channels", () => {
    expect(() => encodeWavPcm16([], 48_000)).toThrow();
  });
});
