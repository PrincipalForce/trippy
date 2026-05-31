// Session-only mirror of each track's FX chain.
//
// The Rust engine is the source of truth for the actual DSP state, but JS
// also needs a representation so the Inspector can list "EQ @ 8 kHz +2 dB"
// and let the user remove it. The engine doesn't expose a "list FX on
// track X" query — JS records what it just added.
//
// FX are *session-only*: they live in this in-memory map for the duration
// of the page. Persisting them to a project file requires a schema bump
// (TrackSnapshot.fx_chain[]) which lands separately.

export interface FxEntryBase {
  /** Engine-assigned, stable for the lifetime of this FX instance. */
  fxId: number;
  /** One-line summary the Inspector shows next to the remove button. */
  label: string;
}

export type FxEntry =
  | (FxEntryBase & { kind: "eq" })
  | (FxEntryBase & { kind: "compressor"; sidechainFromProjTrackId?: number })
  | (FxEntryBase & { kind: "delay" });
