import { describe, it, expect } from "vitest";

// Placeholder smoke test so CI's `pnpm test` has something to run at M0.
// Real component + engine tests arrive in M1 once the audio graph exists.
describe("M0 smoke", () => {
  it("arithmetic still works", () => {
    expect(2 + 3).toBe(5);
  });
});
