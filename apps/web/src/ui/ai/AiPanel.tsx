// AI panel: mix-assistant prompt + suggestion preview.
//
// Flow:
//   1. User types a prompt and hits "ask".
//   2. We POST {prompt, projectContext} to the Cloudflare AI gateway.
//   3. Claude responds with tool calls; client validates them into
//      EngineCommandSuggestion shape.
//   4. Each suggestion lands in a preview row with its rationale.
//   5. User taps "Apply all" (or per-row accept in a follow-up commit).
//      Accepted suggestions are dispatched via the `onApply` callback
//      provided by App.tsx, which owns the engine controller + id maps.

import { createSignal, For, Show } from "solid-js";
import { callMixAssistant, summarizeProject } from "../../ai/mix-assistant";
import type { EngineCommandSuggestion } from "../../ai/jobs";
import type { ProjectFile } from "@trippy/format";

export interface AiPanelProps {
  project: ProjectFile;
  /** Dispatch a batch of accepted suggestions into the engine. App.tsx owns
   *  the id maps and controller, so it does the actual work. */
  onApply: (commands: EngineCommandSuggestion[]) => void;
}

export function AiPanel(props: AiPanelProps) {
  const [prompt, setPrompt] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [clarification, setClarification] = createSignal<string | null>(null);
  const [suggestions, setSuggestions] = createSignal<EngineCommandSuggestion[]>([]);

  async function ask() {
    const text = prompt().trim();
    if (!text || busy()) return;
    setError(null);
    setClarification(null);
    setSuggestions([]);
    setBusy(true);
    try {
      const res = await callMixAssistant({
        prompt: text,
        context: summarizeProject(props.project),
      });
      setSuggestions(res.commands);
      if (res.needsClarification) setClarification(res.needsClarification);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function applyAll() {
    if (suggestions().length === 0) return;
    props.onApply(suggestions());
    setSuggestions([]);
    setPrompt("");
  }

  function dismissAll() {
    setSuggestions([]);
    setClarification(null);
    setError(null);
  }

  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        "border-top": "1px solid var(--grid)",
        padding: "0.6rem 0.9rem",
        display: "flex",
        "flex-direction": "column",
        gap: "0.5rem",
      }}
    >
      <div style={{ display: "flex", gap: "0.5rem", "align-items": "center" }}>
        <span style={{ color: "var(--fg-dim)", "font-size": "0.85rem" }}>ai</span>
        <input
          type="text"
          placeholder="describe a mix move: e.g. 'sidechain bass to kick, brighten hats above 8k'"
          value={prompt()}
          onInput={(e) => setPrompt(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void ask();
          }}
          disabled={busy()}
          style={{
            flex: 1,
            background: "var(--bg)",
            color: "var(--fg)",
            border: "1px solid var(--grid)",
            "border-radius": "6px",
            padding: "0.5rem 0.7rem",
            font: "inherit",
            "min-height": "36px",
          }}
        />
        <button onClick={() => void ask()} disabled={busy() || !prompt().trim()}>
          {busy() ? "…" : "ask"}
        </button>
      </div>

      <Show when={error()}>
        <div
          style={{
            color: "#ffb8b8",
            background: "#3a1212",
            padding: "0.4rem 0.6rem",
            "border-radius": "6px",
            "font-size": "0.78rem",
          }}
        >
          {error()}
        </div>
      </Show>

      <Show when={clarification()}>
        <div
          style={{
            color: "#ffe6b8",
            background: "#3a2e12",
            padding: "0.4rem 0.6rem",
            "border-radius": "6px",
            "font-size": "0.82rem",
          }}
        >
          ❓ {clarification()}
        </div>
      </Show>

      <Show when={suggestions().length > 0}>
        <div style={{ display: "flex", "flex-direction": "column", gap: "0.3rem" }}>
          <For each={suggestions()}>
            {(s) => <SuggestionRow project={props.project} suggestion={s} />}
          </For>
          <div style={{ display: "flex", gap: "0.4rem" }}>
            <button
              onClick={applyAll}
              style={{ "border-color": "#5cff8c", color: "#c0ffc0" }}
            >
              ✓ Apply all
            </button>
            <button onClick={dismissAll}>Dismiss</button>
          </div>
        </div>
      </Show>
    </div>
  );
}

function SuggestionRow(props: { project: ProjectFile; suggestion: EngineCommandSuggestion }) {
  const trackName = (id: number) =>
    props.project.tracks.find((t) => t.id === id)?.name ?? `track ${id}`;
  const summary = () => describeSuggestion(props.suggestion, trackName);
  const supported = () => isEngineSupported(props.suggestion);
  return (
    <div
      style={{
        display: "flex",
        "flex-direction": "column",
        gap: "0.15rem",
        padding: "0.4rem 0.55rem",
        background: "var(--bg)",
        border: "1px solid var(--grid)",
        "border-radius": "6px",
      }}
    >
      <div style={{ display: "flex", gap: "0.4rem", "align-items": "center" }}>
        <span style={{ "font-size": "0.85rem", "font-weight": 600 }}>{summary()}</span>
        <Show when={!supported()}>
          <span
            title="The engine doesn't have plumbing for this yet — Apply will skip it."
            style={{
              "font-size": "0.7rem",
              color: "#ffb86b",
              padding: "0.1rem 0.4rem",
              border: "1px solid #5a3e1a",
              "border-radius": "999px",
            }}
          >
            engine-pending
          </span>
        </Show>
      </div>
      <Show when={props.suggestion.rationale}>
        <span style={{ "font-size": "0.78rem", color: "var(--fg-dim)" }}>
          {props.suggestion.rationale}
        </span>
      </Show>
    </div>
  );
}

function describeSuggestion(
  s: EngineCommandSuggestion,
  trackName: (id: number) => string,
): string {
  switch (s.type) {
    case "setTrackGain":
      return `${s.gain >= 0 ? "+" : ""}${s.gain.toFixed(1)} dB on ${trackName(s.trackId)}`;
    case "setTrackPan":
      return `pan ${trackName(s.trackId)} to ${s.pan.toFixed(2)}`;
    case "addEq":
      return `EQ ${trackName(s.trackId)} @ ${Math.round(s.freq)} Hz ${s.gainDb >= 0 ? "+" : ""}${s.gainDb.toFixed(1)} dB`;
    case "addCompressor":
      return `compressor on ${trackName(s.trackId)} (${s.thresholdDb.toFixed(0)} dB / ${s.ratio.toFixed(1)}:1)`;
    case "addDelay":
      return `delay on ${trackName(s.trackId)} (${s.beats} beats, ${Math.round(s.wet * 100)}% wet)`;
    case "sidechain":
      return `sidechain ${trackName(s.from)} → ${trackName(s.to)}`;
  }
}

function isEngineSupported(s: EngineCommandSuggestion): boolean {
  // The engine currently only honors track gain & pan. EQ/comp/delay/sidechain
  // are scaffolded but not yet wired through the audio graph; until they are,
  // Apply skips them with a one-line notice.
  return s.type === "setTrackGain" || s.type === "setTrackPan";
}
