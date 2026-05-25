import { createSignal, onCleanup, onMount, Show, For, createMemo } from "solid-js";
import { getController } from "../audio/controller";
import { decodeAudio } from "../audio/decode";
import { encodeWavPcm16 } from "../audio/wav-encode";
import { buildWaveform, type Waveform } from "../audio/waveform-cache";
import { createProjectStore } from "../project/store";
import { Timeline } from "./timeline/Timeline";
import { AiPanel } from "./ai/AiPanel";
import { RecordButton } from "./RecordButton";
import { opfsAvailable, saveProject, loadProject, listProjects } from "../project/opfs";

export function App() {
  const [playing, setPlaying] = createSignal(false);
  const [position, setPosition] = createSignal(0);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [projects, setProjects] = createSignal<Array<{ id: string; name: string; modifiedAt: string }>>([]);

  const project = createProjectStore();
  // sourceId → Waveform (main thread cache for rendering)
  const [waveforms, setWaveforms] = createSignal<Map<number, Waveform>>(new Map());
  // sourceId → raw audio bytes (for OPFS save)
  const sourceBytes = new Map<number, ArrayBuffer>();
  // engine track id ↔ project track id mapping
  const engineTrackIds = new Map<number, number>();
  const engineSourceIds = new Map<number, number>();

  const controller = getController();

  onMount(() => {
    const unsub = controller.onTransportChange((s) => {
      setPosition(s.positionFrames);
      setPlaying(s.playing);
    });
    onCleanup(unsub);
    refreshProjectList();
  });

  async function refreshProjectList() {
    if (!opfsAvailable()) return;
    try {
      setProjects(await listProjects());
    } catch (e) {
      console.warn("listProjects failed", e);
    }
  }

  async function loadFile(file: File) {
    setError(null);
    setBusy(true);
    try {
      await controller.resume();
      const rawBytes = await file.arrayBuffer();

      // 1) Decode the file via the browser. Handles wav, mp3, m4a (iOS
      //    Voice Memos), flac, ogg — anything the host AudioContext
      //    understands. The engine only ingests WAV, so we re-encode after.
      const decoded = await decodeAudio(rawBytes);

      // 2) Re-encode to 16-bit PCM WAV in memory. Cheap and keeps the
      //    project bundle on disk format-uniform.
      const wavBytes = encodeWavPcm16(decoded.channels, decoded.sampleRate);

      // 3) Send the WAV to the engine worker for playback
      const engineSrc = await controller.loadWav(wavBytes);

      // 4) Build waveform peaks for the timeline
      const wf = buildWaveform(decoded.channels, decoded.sampleRate);

      // 5) Register in the project model. Save the re-encoded WAV (not
      //    rawBytes) so reload uses the same canonical bytes — m4a files
      //    don't survive a project export to another browser/runtime.
      const projSourceId = (project.state.project.sources.at(-1)?.id ?? 0) + 1;
      project.addSource({
        id: projSourceId,
        file: `src-${projSourceId}.wav`,
        sampleRate: engineSrc.sampleRate,
        channels: engineSrc.channels,
        frameCount: engineSrc.frameCount,
        originalName: file.name,
      });
      engineSourceIds.set(projSourceId, engineSrc.sourceId);
      sourceBytes.set(projSourceId, wavBytes);
      setWaveforms((m) => {
        const next = new Map(m);
        next.set(projSourceId, wf);
        return next;
      });

      // 4) Create track + clip
      const projTrackId = project.addTrack(file.name.replace(/\.[^.]+$/, ""));
      const engineTrackId = await controller.addTrack();
      engineTrackIds.set(projTrackId, engineTrackId);

      const clipId = project.addClip(projTrackId, {
        sourceId: projSourceId,
        startFrame: 0,
        lengthFrames: engineSrc.frameCount,
        offsetInSource: 0,
        gain: 1,
        label: file.name,
      });
      if (clipId != null) {
        await controller.addClip({
          trackId: engineTrackId,
          sourceId: engineSrc.sourceId,
          startFrame: 0,
          lengthFrames: engineSrc.frameCount,
          offsetInSource: 0,
        });
      }

      // 5) Auto-set loop on first load to the new clip
      if (project.state.project.tracks.length === 1) {
        controller.setLoop(0, engineSrc.frameCount);
        project.setLoop({ start: 0, end: engineSrc.frameCount });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function togglePlay() {
    await controller.resume();
    if (playing()) controller.stop();
    else controller.play();
  }

  async function save() {
    setError(null);
    setBusy(true);
    try {
      await saveProject(project.state.project, sourceBytes);
      project.markClean();
      await refreshProjectList();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function load(id: string) {
    setError(null);
    setBusy(true);
    try {
      const { project: proj, sourceBytes: bytes } = await loadProject(id);
      project.replace(proj);
      sourceBytes.clear();
      engineSourceIds.clear();
      engineTrackIds.clear();
      const newWf = new Map<number, Waveform>();
      // Re-push all sources to engine + rebuild waveforms
      for (const src of proj.sources) {
        const b = bytes.get(src.id);
        if (!b) continue;
        sourceBytes.set(src.id, b);
        const engineSrc = await controller.loadWav(b);
        engineSourceIds.set(src.id, engineSrc.sourceId);
        const decoded = await decodeAudio(b);
        newWf.set(src.id, buildWaveform(decoded.channels, decoded.sampleRate));
      }
      setWaveforms(newWf);
      // Re-create tracks + clips on the engine
      for (const t of proj.tracks) {
        const engineTid = await controller.addTrack();
        engineTrackIds.set(t.id, engineTid);
        controller.setTrackGain(engineTid, t.gain);
        controller.setTrackPan(engineTid, t.pan);
        controller.setTrackMute(engineTid, t.mute);
        controller.setTrackSolo(engineTid, t.solo);
        for (const c of t.clips) {
          const engineSid = engineSourceIds.get(c.sourceId);
          if (engineSid == null) continue;
          await controller.addClip({
            trackId: engineTid,
            sourceId: engineSid,
            startFrame: c.startFrame,
            lengthFrames: c.lengthFrames,
            offsetInSource: c.offsetInSource,
          });
        }
      }
      if (proj.transport.loop) {
        controller.setLoop(proj.transport.loop.start, proj.transport.loop.end);
      } else {
        controller.clearLoop();
      }
      controller.setBpm(proj.transport.bpm);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function fmtTime(n: number): string {
    if (controller.sampleRate <= 0) return `${n}f`;
    const secs = n / controller.sampleRate;
    const m = Math.floor(secs / 60);
    const s = (secs % 60).toFixed(2);
    return `${m}:${s.padStart(5, "0")}`;
  }

  const bpm = createMemo(() => project.state.project.transport.bpm);

  return (
    <main
      style={{
        display: "flex",
        "flex-direction": "column",
        height: "100%",
        padding: "env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)",
      }}
    >
      <header
        style={{
          display: "flex",
          "align-items": "center",
          gap: "0.6rem",
          padding: "0.6rem 0.9rem",
          "border-bottom": "1px solid var(--grid)",
          background: "var(--bg-elevated)",
          "flex-wrap": "wrap",
        }}
      >
        <strong style={{ "letter-spacing": "-0.02em", "font-size": "1.05rem" }}>trippy</strong>
        <input
          type="text"
          value={project.state.project.meta.name}
          onInput={(e) => project.rename(e.currentTarget.value)}
          style={{
            background: "var(--bg)",
            color: "var(--fg)",
            border: "1px solid var(--grid)",
            "border-radius": "6px",
            padding: "0.3rem 0.5rem",
            "min-width": "120px",
            font: "inherit",
          }}
        />
        <button onClick={togglePlay} style={{ "min-width": "84px" }}>
          {playing() ? "■ Stop" : "▶ Play"}
        </button>
        <span
          style={{
            "font-family": "ui-monospace, monospace",
            color: "var(--fg-dim)",
            "min-width": "62px",
            "text-align": "right",
          }}
        >
          {fmtTime(position())}
        </span>
        <label style={{ display: "flex", "align-items": "center", gap: "0.35rem" }}>
          <span style={{ color: "var(--fg-dim)", "font-size": "0.8rem" }}>BPM</span>
          <input
            type="number"
            min="40"
            max="300"
            step="0.1"
            value={bpm()}
            onChange={(e) => {
              const v = parseFloat(e.currentTarget.value) || 120;
              project.setBpm(v);
              controller.setBpm(v);
            }}
            style={{
              width: "70px",
              background: "var(--bg)",
              color: "var(--fg)",
              border: "1px solid var(--grid)",
              "border-radius": "6px",
              padding: "0.35rem 0.45rem",
              font: "inherit",
            }}
          />
        </label>
        <FilePicker onFile={loadFile} disabled={busy()} />
        <RecordButton onRecording={loadFile} onError={setError} disabled={busy()} />
        <Show when={opfsAvailable()}>
          <button onClick={save} disabled={busy()} title="Save to browser storage">
            ↓ Save
          </button>
          <Show when={projects().length > 0}>
            <select
              onChange={(e) => {
                const id = e.currentTarget.value;
                if (id) load(id);
                e.currentTarget.value = "";
              }}
              style={{
                background: "var(--bg)",
                color: "var(--fg)",
                border: "1px solid var(--grid)",
                "border-radius": "6px",
                padding: "0.35rem 0.5rem",
                font: "inherit",
                "min-height": "44px",
              }}
            >
              <option value="">Load…</option>
              <For each={projects()}>
                {(p) => <option value={p.id}>{p.name}</option>}
              </For>
            </select>
          </Show>
        </Show>
        <Show when={project.state.dirty}>
          <span style={{ color: "#ffb86b", "font-size": "0.8rem" }}>● unsaved</span>
        </Show>
      </header>

      {/* Timeline */}
      <section
        style={{
          flex: 1,
          "overflow-y": "auto",
          background: "var(--bg)",
        }}
      >
        <Timeline
          project={project.state.project}
          waveforms={waveforms()}
          positionFrames={position()}
          onSeek={(f) => controller.setPosition(f)}
        />
      </section>

      {/* Mixer strip */}
      <Show when={project.state.project.tracks.length > 0}>
        <section
          style={{
            display: "flex",
            gap: "0.5rem",
            padding: "0.6rem 0.9rem",
            "border-top": "1px solid var(--grid)",
            background: "var(--bg-elevated)",
            "overflow-x": "auto",
          }}
        >
          <For each={project.state.project.tracks}>
            {(t) => (
              <MixerStrip
                name={t.name}
                gain={t.gain}
                pan={t.pan}
                mute={t.mute}
                solo={t.solo}
                onGain={(v) => {
                  project.updateTrack(t.id, { gain: v });
                  const eid = engineTrackIds.get(t.id);
                  if (eid != null) controller.setTrackGain(eid, v);
                }}
                onPan={(v) => {
                  project.updateTrack(t.id, { pan: v });
                  const eid = engineTrackIds.get(t.id);
                  if (eid != null) controller.setTrackPan(eid, v);
                }}
                onMute={(v) => {
                  project.updateTrack(t.id, { mute: v });
                  const eid = engineTrackIds.get(t.id);
                  if (eid != null) controller.setTrackMute(eid, v);
                }}
                onSolo={(v) => {
                  project.updateTrack(t.id, { solo: v });
                  const eid = engineTrackIds.get(t.id);
                  if (eid != null) controller.setTrackSolo(eid, v);
                }}
              />
            )}
          </For>
        </section>
      </Show>

      <AiPanel />

      <Show when={error()}>
        <div
          style={{
            color: "#ff8888",
            "background-color": "#3a1212",
            padding: "0.6rem 0.9rem",
            "border-top": "1px solid #6e2222",
            "font-size": "0.85rem",
          }}
        >
          {error()}
        </div>
      </Show>
    </main>
  );
}

function FilePicker(props: { onFile: (file: File) => void; disabled?: boolean }) {
  let inputRef: HTMLInputElement | undefined;
  return (
    <>
      <input
        ref={(el) => (inputRef = el)}
        type="file"
        // Broad accept so the iOS / Android file picker surfaces Voice
        // Memos (.m4a), recordings, sample libraries — anything an
        // AudioContext can decode. Explicit extensions help platforms
        // that don't honor the wildcard fully.
        accept="audio/*,.wav,.mp3,.m4a,.aac,.flac,.ogg,.opus,.weba"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.currentTarget.files?.[0];
          if (f) props.onFile(f);
          e.currentTarget.value = "";
        }}
      />
      <button type="button" disabled={props.disabled} onClick={() => inputRef?.click()}>
        + load
      </button>
    </>
  );
}

function MixerStrip(props: {
  name: string;
  gain: number;
  pan: number;
  mute: boolean;
  solo: boolean;
  onGain: (v: number) => void;
  onPan: (v: number) => void;
  onMute: (v: boolean) => void;
  onSolo: (v: boolean) => void;
}) {
  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--grid)",
        "border-radius": "8px",
        padding: "0.55rem",
        display: "flex",
        "flex-direction": "column",
        gap: "0.35rem",
        "min-width": "100px",
      }}
    >
      <div
        style={{
          "font-size": "0.78rem",
          color: "var(--fg-dim)",
          "white-space": "nowrap",
          overflow: "hidden",
          "text-overflow": "ellipsis",
          "max-width": "90px",
        }}
      >
        {props.name}
      </div>
      <input
        type="range"
        min="0"
        max="1.5"
        step="0.01"
        value={props.gain}
        onInput={(e) => props.onGain(parseFloat(e.currentTarget.value))}
      />
      <input
        type="range"
        min="-1"
        max="1"
        step="0.01"
        value={props.pan}
        onInput={(e) => props.onPan(parseFloat(e.currentTarget.value))}
      />
      <div style={{ display: "flex", gap: "0.3rem" }}>
        <button
          type="button"
          onClick={() => props.onMute(!props.mute)}
          style={{
            flex: 1,
            "min-width": 0,
            "min-height": "30px",
            padding: 0,
            "border-color": props.mute ? "var(--accent)" : "var(--grid)",
            background: props.mute ? "var(--accent-dim)" : "transparent",
            color: props.mute ? "var(--fg)" : "var(--fg-dim)",
            "font-weight": 600,
            "font-size": "0.8rem",
          }}
        >
          M
        </button>
        <button
          type="button"
          onClick={() => props.onSolo(!props.solo)}
          style={{
            flex: 1,
            "min-width": 0,
            "min-height": "30px",
            padding: 0,
            "border-color": props.solo ? "#ffb86b" : "var(--grid)",
            background: props.solo ? "#5a3e1a" : "transparent",
            color: props.solo ? "#ffe6b8" : "var(--fg-dim)",
            "font-weight": 600,
            "font-size": "0.8rem",
          }}
        >
          S
        </button>
      </div>
    </div>
  );
}
