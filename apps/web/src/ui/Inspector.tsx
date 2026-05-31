// Bottom-sheet inspector. Surfaces details and actions for whatever the
// user has selected: a clip (with the per-clip toolbox), a track (with
// the per-track toolbox), or nothing (a collapsed handle).
//
// On mobile the inspector docks to the bottom; on wider viewports it
// still lives at the bottom for muscle-memory consistency with the
// transport / mixer rail.

import { For, Show } from "solid-js";
import type { ClipSnapshot, TrackSnapshot } from "@trippy/format";
import type { FxEntry } from "../audio/fx-state";

const TRACK_COLORS = [
  "#7c5cff", "#ff8c5c", "#5cff8c", "#ffd45c", "#5cdcff",
  "#ff5c9b", "#a35cff", "#5cffea",
];

export interface InspectorProps {
  selectedClip?: { track: TrackSnapshot; clip: ClipSnapshot } | null;
  selectedTrack?: TrackSnapshot | null;
  sampleRate: number;
  // clip actions
  onClipGain?: (gain: number) => void;
  onClipDuplicate?: () => void;
  onClipDelete?: () => void;
  onClipSplitAtPlayhead?: () => void;
  /** Frequency-band split the clip into bass/low-mid/high-mid/high tracks. */
  onClipSplitBands?: () => void;
  onClipRename?: (label: string) => void;
  // track actions
  onTrackRename?: (name: string) => void;
  onTrackColor?: (color: string) => void;
  onTrackDelete?: () => void;
  /** FX chain on the currently-selected track. */
  trackFx?: FxEntry[];
  /** Remove a specific FX from the selected track. */
  onRemoveFx?: (fxId: number) => void;
  // shell
  onClose?: () => void;
}

export function Inspector(props: InspectorProps) {
  const hasSelection = () => !!(props.selectedClip || props.selectedTrack);

  return (
    <Show when={hasSelection()}>
      <section
        role="dialog"
        aria-label="Inspector"
        style={{
          background: "var(--bg-elevated)",
          "border-top": "1px solid var(--grid)",
          padding: "0.6rem 0.8rem 0.7rem",
          display: "flex",
          "flex-direction": "column",
          gap: "0.55rem",
          "max-height": "45vh",
          "overflow-y": "auto",
        }}
      >
        <header
          style={{
            display: "flex",
            "align-items": "center",
            "justify-content": "space-between",
            gap: "0.5rem",
          }}
        >
          <strong style={{ "font-size": "0.85rem", color: "var(--fg-dim)", "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            {props.selectedClip ? "Clip" : "Track"}
          </strong>
          <button
            type="button"
            onClick={() => props.onClose?.()}
            style={{ "min-height": "34px", padding: "0 0.7rem" }}
          >
            Done
          </button>
        </header>

        <Show when={props.selectedClip}>
          {(sel) => (
            <ClipInspector
              track={sel().track}
              clip={sel().clip}
              sampleRate={props.sampleRate}
              onGain={props.onClipGain}
              onDuplicate={props.onClipDuplicate}
              onDelete={props.onClipDelete}
              onSplitAtPlayhead={props.onClipSplitAtPlayhead}
              onSplitBands={props.onClipSplitBands}
              onRename={props.onClipRename}
            />
          )}
        </Show>

        <Show when={!props.selectedClip && props.selectedTrack}>
          {(t) => (
            <TrackInspector
              track={t()}
              fx={props.trackFx ?? []}
              onRename={props.onTrackRename}
              onColor={props.onTrackColor}
              onDelete={props.onTrackDelete}
              onRemoveFx={props.onRemoveFx}
            />
          )}
        </Show>
      </section>
    </Show>
  );
}

function ClipInspector(props: {
  track: TrackSnapshot;
  clip: ClipSnapshot;
  sampleRate: number;
  onGain?: (v: number) => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onSplitAtPlayhead?: () => void;
  onSplitBands?: () => void;
  onRename?: (label: string) => void;
}) {
  function fmtSecs(frames: number): string {
    const s = frames / props.sampleRate;
    return `${s.toFixed(2)}s`;
  }
  const gainDb = () => {
    const g = props.clip.gain || 1;
    if (g <= 0.0001) return "-∞ dB";
    return `${(20 * Math.log10(g)).toFixed(1)} dB`;
  };

  return (
    <>
      <div style={{ display: "flex", gap: "0.4rem", "align-items": "center", "flex-wrap": "wrap" }}>
        <input
          type="text"
          value={props.clip.label ?? ""}
          placeholder="(unlabeled)"
          onInput={(e) => props.onRename?.(e.currentTarget.value)}
          style={{
            flex: "1 1 200px",
            "min-width": "140px",
            background: "var(--bg)",
            color: "var(--fg)",
            border: "1px solid var(--grid)",
            "border-radius": "6px",
            padding: "0.4rem 0.55rem",
            font: "inherit",
          }}
        />
        <span style={{ color: "var(--fg-dim)", "font-size": "0.8rem" }}>
          on <em style={{ "font-style": "normal", color: "var(--fg)" }}>{props.track.name}</em>
        </span>
      </div>
      <div style={{ display: "flex", gap: "0.9rem", "font-size": "0.78rem", color: "var(--fg-dim)", "flex-wrap": "wrap" }}>
        <span>start {fmtSecs(props.clip.startFrame)}</span>
        <span>length {fmtSecs(props.clip.lengthFrames)}</span>
        <span>offset {fmtSecs(props.clip.offsetInSource)}</span>
      </div>
      <label style={{ display: "flex", "align-items": "center", gap: "0.5rem" }}>
        <span style={{ "min-width": "44px", color: "var(--fg-dim)", "font-size": "0.8rem" }}>Gain</span>
        <input
          type="range"
          min="0"
          max="2"
          step="0.01"
          value={props.clip.gain}
          onInput={(e) => props.onGain?.(parseFloat(e.currentTarget.value))}
          style={{ flex: 1 }}
        />
        <span
          style={{
            "min-width": "62px",
            "text-align": "right",
            "font-family": "ui-monospace, monospace",
            "font-size": "0.8rem",
            color: "var(--fg)",
          }}
        >
          {gainDb()}
        </span>
      </label>
      <div style={{ display: "flex", gap: "0.4rem", "flex-wrap": "wrap" }}>
        <button type="button" onClick={() => props.onSplitAtPlayhead?.()}>
          ✂ Split @ playhead
        </button>
        <button
          type="button"
          onClick={() => props.onSplitBands?.()}
          title="Split into bass / low-mid / high-mid / high tracks"
        >
          ≡ Split bands
        </button>
        <button type="button" onClick={() => props.onDuplicate?.()}>
          ⎘ Duplicate
        </button>
        <button
          type="button"
          onClick={() => props.onDelete?.()}
          style={{ "border-color": "#ff4d6d", color: "#ffb8c5" }}
        >
          ✕ Delete
        </button>
      </div>
    </>
  );
}

function TrackInspector(props: {
  track: TrackSnapshot;
  fx: FxEntry[];
  onRename?: (name: string) => void;
  onColor?: (color: string) => void;
  onDelete?: () => void;
  onRemoveFx?: (fxId: number) => void;
}) {
  const glyph = (kind: FxEntry["kind"]) =>
    kind === "eq" ? "≈" : kind === "compressor" ? "▼" : "↻";
  return (
    <>
      <div style={{ display: "flex", gap: "0.4rem", "align-items": "center", "flex-wrap": "wrap" }}>
        <input
          type="text"
          value={props.track.name}
          onInput={(e) => props.onRename?.(e.currentTarget.value)}
          style={{
            flex: "1 1 200px",
            "min-width": "140px",
            background: "var(--bg)",
            color: "var(--fg)",
            border: "1px solid var(--grid)",
            "border-radius": "6px",
            padding: "0.4rem 0.55rem",
            font: "inherit",
          }}
        />
        <span style={{ color: "var(--fg-dim)", "font-size": "0.78rem" }}>
          {props.track.clips.length} clip{props.track.clips.length === 1 ? "" : "s"}
        </span>
      </div>
      <div style={{ display: "flex", "align-items": "center", gap: "0.5rem", "flex-wrap": "wrap" }}>
        <span style={{ color: "var(--fg-dim)", "font-size": "0.8rem", "min-width": "44px" }}>Color</span>
        <div style={{ display: "flex", gap: "0.3rem", "flex-wrap": "wrap" }}>
          {TRACK_COLORS.map((c) => (
            <button
              type="button"
              aria-label={`Color ${c}`}
              onClick={() => props.onColor?.(c)}
              style={{
                width: "28px",
                height: "28px",
                "min-height": "28px",
                "border-radius": "50%",
                padding: 0,
                background: c,
                "border-color": props.track.color === c ? "var(--fg)" : "transparent",
                "border-width": "2px",
              }}
            />
          ))}
        </div>
      </div>
      <Show when={props.fx.length > 0}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "0.25rem" }}>
          <span style={{ color: "var(--fg-dim)", "font-size": "0.75rem", "text-transform": "uppercase", "letter-spacing": "0.05em" }}>
            FX chain
          </span>
          <For each={props.fx}>
            {(f) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "0.5rem",
                  padding: "0.35rem 0.55rem",
                  background: "var(--bg)",
                  border: "1px solid var(--grid)",
                  "border-radius": "6px",
                }}
              >
                <span style={{ "font-size": "0.95rem", width: "1.2rem", "text-align": "center" }}>
                  {glyph(f.kind)}
                </span>
                <span style={{ flex: 1, "font-size": "0.82rem", "min-width": 0, overflow: "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                  {f.label}
                </span>
                <button
                  type="button"
                  onClick={() => props.onRemoveFx?.(f.fxId)}
                  title="Remove this FX"
                  style={{
                    "min-width": "32px",
                    "min-height": "30px",
                    padding: "0 0.4rem",
                    "border-color": "#ff4d6d",
                    color: "#ffb8c5",
                  }}
                >
                  ✕
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
      <div style={{ display: "flex", gap: "0.4rem" }}>
        <button
          type="button"
          onClick={() => props.onDelete?.()}
          style={{ "border-color": "#ff4d6d", color: "#ffb8c5" }}
        >
          ✕ Delete track
        </button>
      </div>
    </>
  );
}
