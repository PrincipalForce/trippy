// AI panel: surfaces the AI job queue, the mix-assistant prompt box, and
// (eventually) per-clip "split stems / transcribe / denoise" buttons.

import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import { getAiJobQueue, type AiJob } from "../../ai/jobs";

export function AiPanel() {
  const [jobs, setJobs] = createSignal<AiJob[]>([]);
  const [prompt, setPrompt] = createSignal("");
  const queue = getAiJobQueue();

  onMount(() => {
    const unsub = queue.subscribe(setJobs);
    onCleanup(unsub);
  });

  function submit() {
    if (!prompt().trim()) return;
    queue.enqueue({
      kind: "mix-assist",
      backend: "cloud",
      sourceId: 0,
      params: { prompt: prompt() },
    });
    setPrompt("");
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
            if (e.key === "Enter") submit();
          }}
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
        <button onClick={submit}>ask</button>
      </div>
      <Show when={jobs().length > 0}>
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "0.3rem",
            "max-height": "120px",
            "overflow-y": "auto",
            "font-size": "0.78rem",
          }}
        >
          <For each={jobs()}>
            {(j) => (
              <div
                style={{
                  display: "flex",
                  "align-items": "center",
                  gap: "0.5rem",
                  padding: "0.35rem 0.5rem",
                  background: "var(--bg)",
                  border: "1px solid var(--grid)",
                  "border-radius": "6px",
                }}
              >
                <span style={{ color: "var(--fg-dim)", "min-width": "70px" }}>{j.input.kind}</span>
                <span
                  style={{
                    color:
                      j.status === "done"
                        ? "#88d977"
                        : j.status === "error"
                          ? "#ff8888"
                          : "var(--fg-dim)",
                    "min-width": "70px",
                  }}
                >
                  {j.status}
                </span>
                <span style={{ flex: 1, color: "var(--fg-dim)", "overflow": "hidden", "text-overflow": "ellipsis", "white-space": "nowrap" }}>
                  {j.error ?? (j.input.params.prompt as string | undefined) ?? ""}
                </span>
                <Show when={j.status === "pending" || j.status === "running"}>
                  <button
                    onClick={() => queue.cancel(j.id)}
                    style={{ "min-height": "26px", padding: "0 0.5rem", "font-size": "0.75rem" }}
                  >
                    cancel
                  </button>
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
