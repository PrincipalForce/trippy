// Top-of-timeline mode bar. Picks which gesture the timeline interprets on
// pointer-down: move clips, slice at the touch point, or erase the clip
// under the touch.
//
// Two-finger pinch and ruler-tap (seek) behave the same in every mode —
// only the single-finger clip interaction changes.

import { For } from "solid-js";

export type EditMode = "move" | "slice" | "erase";

interface ModeDef {
  id: EditMode;
  glyph: string;
  label: string;
  hint: string;
}

const MODES: ModeDef[] = [
  { id: "move", glyph: "✥", label: "Move", hint: "Drag clips, trim edges" },
  { id: "slice", glyph: "✂", label: "Slice", hint: "Tap a clip to split it" },
  { id: "erase", glyph: "⌫", label: "Erase", hint: "Tap a clip to delete it" },
];

export function ModeBar(props: { mode: EditMode; onChange: (m: EditMode) => void }) {
  return (
    <div
      role="toolbar"
      aria-label="Edit mode"
      style={{
        display: "flex",
        gap: "0.25rem",
        padding: "0.4rem 0.5rem",
        background: "var(--bg-elevated)",
        "border-bottom": "1px solid var(--grid)",
        "overflow-x": "auto",
      }}
    >
      <For each={MODES}>
        {(m) => {
          const active = () => props.mode === m.id;
          return (
            <button
              type="button"
              title={m.hint}
              aria-pressed={active()}
              onClick={() => props.onChange(m.id)}
              style={{
                display: "flex",
                "align-items": "center",
                gap: "0.35rem",
                padding: "0.35rem 0.6rem",
                "min-height": "36px",
                background: active() ? "var(--accent-dim)" : "transparent",
                "border-color": active() ? "var(--accent)" : "var(--grid)",
                color: active() ? "var(--fg)" : "var(--fg-dim)",
                "font-weight": active() ? 600 : 400,
                "white-space": "nowrap",
              }}
            >
              <span aria-hidden style={{ "font-size": "1rem" }}>{m.glyph}</span>
              <span>{m.label}</span>
            </button>
          );
        }}
      </For>
    </div>
  );
}
