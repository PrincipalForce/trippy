import { describe, it, expect } from "vitest";
import { newProject, parse, serialize, SCHEMA_VERSION } from "./index";

describe("trippy-format", () => {
  it("creates a valid empty project", () => {
    const p = newProject("demo");
    expect(p.schemaVersion).toBe(SCHEMA_VERSION);
    expect(p.meta.name).toBe("demo");
    expect(p.meta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(p.transport.bpm).toBe(120);
    expect(p.tracks).toEqual([]);
  });

  it("serializes and round-trips", () => {
    const p = newProject("rt");
    p.tracks.push({
      id: 1,
      name: "drums",
      gain: 0.9,
      pan: -0.2,
      mute: false,
      solo: false,
      clips: [
        {
          id: 1,
          sourceId: 1,
          startFrame: 0,
          lengthFrames: 192_000,
          offsetInSource: 0,
          gain: 1,
        },
      ],
    });
    const json = serialize(p);
    const back = parse(json);
    expect(back).toEqual(p);
  });

  it("rejects unknown schema versions", () => {
    expect(() => parse(JSON.stringify({ schemaVersion: 999 }))).toThrow(/unsupported/);
  });

  it("rejects non-objects", () => {
    expect(() => parse("null")).toThrow();
    expect(() => parse("42")).toThrow();
  });
});
