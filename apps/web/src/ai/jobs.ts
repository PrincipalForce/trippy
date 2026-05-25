// AI job queue: schedules on-device (ONNX Runtime Web / WebGPU) and cloud
// (Cloudflare Workers AI) inference, surfaces progress to the UI, and
// keeps every output as a *suggestion* on a preview track until the user
// accepts.
//
// Trippy's AI promise:
//   - Stem separation (Demucs)
//   - Beat/key/chord detection
//   - Audio→MIDI transcription (Basic Pitch)
//   - Smart quantize
//   - Vocal denoise (RNNoise / DeepFilterNet)
//   - Prompt-to-sample (MusicGen) — cloud
//   - Natural-language mix assistant — cloud LLM with engine command tools
//
// This file is the *queue* — the I/O surface shared by all jobs. Each job
// type lives in its own module (`stems.ts`, `transcribe.ts`, etc.) and is
// added as those models ship.
//
// **Status:** scaffolding only. Real inference wiring lands as we integrate
// ONNX Runtime Web (deps: `onnxruntime-web`, hooked up in M7.5's build PR).

export type AiJobKind =
  | "stems"
  | "transcribe"
  | "beat-detect"
  | "key-detect"
  | "denoise"
  | "smart-quantize"
  | "prompt-sample"
  | "mix-assist";

export type AiBackend = "device" | "cloud";

export interface AiJobInput {
  kind: AiJobKind;
  backend: AiBackend;
  /** Source-id of the audio to operate on (or 0 for prompt-only jobs). */
  sourceId: number;
  /** Free-form params per job kind (model variant, prompt text, etc.). */
  params: Record<string, unknown>;
}

export interface AiJobOutput {
  /** Optional new source(s) produced (e.g. 4 stems). */
  sources?: Array<{ name: string; bytes: ArrayBuffer; channels: number; sampleRate: number }>;
  /** Optional engine command list (used by mix-assist). */
  commands?: EngineCommandSuggestion[];
  /** Optional MIDI track (transcribe). */
  midi?: { events: Array<{ frame: number; status: number; data1: number; data2: number }> };
  /** Optional analysis numbers (key, bpm). */
  analysis?: Record<string, unknown>;
}

export type EngineCommandSuggestion =
  | { type: "setTrackGain"; trackId: number; gain: number; rationale: string }
  | { type: "setTrackPan"; trackId: number; pan: number; rationale: string }
  | { type: "addEq"; trackId: number; freq: number; q: number; gainDb: number; rationale: string }
  | { type: "addCompressor"; trackId: number; thresholdDb: number; ratio: number; rationale: string }
  | { type: "addDelay"; trackId: number; beats: number; feedback: number; wet: number; rationale: string }
  | { type: "sidechain"; from: number; to: number; rationale: string };

export interface AiJob {
  id: string;
  input: AiJobInput;
  status: "pending" | "running" | "done" | "error" | "canceled";
  progress: number; // 0..1
  error?: string;
  output?: AiJobOutput;
  startedAt?: number;
  finishedAt?: number;
}

type Listener = (jobs: AiJob[]) => void;

export class AiJobQueue {
  private jobs = new Map<string, AiJob>();
  private listeners = new Set<Listener>();
  private nextId = 1;

  list(): AiJob[] {
    return [...this.jobs.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    fn(this.list());
    return () => this.listeners.delete(fn);
  }

  private notify() {
    const snapshot = this.list();
    this.listeners.forEach((fn) => fn(snapshot));
  }

  enqueue(input: AiJobInput): AiJob {
    const id = `job-${this.nextId++}`;
    const job: AiJob = { id, input, status: "pending", progress: 0 };
    this.jobs.set(id, job);
    this.notify();
    // Real impl: dispatch by kind/backend to a per-backend runner.
    // For now we mark the job as errored with a "not implemented" message so
    // the UI exercises the full lifecycle and we can ship the panel.
    queueMicrotask(() => {
      const j = this.jobs.get(id);
      if (!j) return;
      j.status = "error";
      j.error = "model runtime not yet wired (M7.5 work in progress)";
      j.finishedAt = Date.now();
      this.notify();
    });
    return job;
  }

  cancel(id: string): boolean {
    const j = this.jobs.get(id);
    if (!j || j.status !== "pending" && j.status !== "running") return false;
    j.status = "canceled";
    j.finishedAt = Date.now();
    this.notify();
    return true;
  }
}

let _instance: AiJobQueue | null = null;
export function getAiJobQueue(): AiJobQueue {
  if (!_instance) _instance = new AiJobQueue();
  return _instance;
}
