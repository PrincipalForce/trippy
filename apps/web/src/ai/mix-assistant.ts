// Natural-language mix assistant.
//
// The user types instructions like "sidechain the bass to the kick, brighten
// the hats 2dB above 8k, add 1/8 dotted delay to the lead with 30% wet".
// We send the prompt + a *project context summary* + the *engine command
// schema* to a cloud LLM (Claude via Workers AI gateway). The LLM responds
// with structured tool calls. We resolve each tool call into a concrete
// `EngineCommandSuggestion`, present them in a preview panel, and only apply
// the user-accepted subset.
//
// Why structured tool calls (and not a free-form text response that we
// regex-parse): tool calls give us:
//   1) typed JSON arguments — no parse failures from prose
//   2) one round-trip even when there are many commands (batched)
//   3) the model can ask clarifying questions via a `request_info` tool,
//      keeping the UX conversational
//
// **Status:** scaffolding only — the actual Workers AI gateway is part of M8.
// For now this just shows the prompt → preview → accept loop with a stub.

import type { EngineCommandSuggestion } from "./jobs";
import type { ProjectFile } from "@trippy/format";

export interface MixAssistantRequest {
  prompt: string;
  /** Compact, tokens-cheap summary of the project for context. */
  context: ProjectContextSummary;
}

export interface ProjectContextSummary {
  bpm: number;
  sampleRate: number;
  trackCount: number;
  /** Up to ~16 tracks summarized; longer projects get a truncation note. */
  tracks: Array<{
    id: number;
    name: string;
    gain: number;
    pan: number;
    mute: boolean;
    /** Approximate length in seconds, by clip span. */
    durationSec: number;
  }>;
  truncated?: boolean;
}

export interface MixAssistantResponse {
  commands: EngineCommandSuggestion[];
  /** Optional follow-up question if the assistant needs more info. */
  needsClarification?: string;
}

export function summarizeProject(p: ProjectFile): ProjectContextSummary {
  const tracks = p.tracks.slice(0, 16).map((t) => {
    let maxEnd = 0;
    for (const c of t.clips) maxEnd = Math.max(maxEnd, c.startFrame + c.lengthFrames);
    return {
      id: t.id,
      name: t.name,
      gain: t.gain,
      pan: t.pan,
      mute: t.mute,
      durationSec: maxEnd / p.transport.sampleRate,
    };
  });
  return {
    bpm: p.transport.bpm,
    sampleRate: p.transport.sampleRate,
    trackCount: p.tracks.length,
    tracks,
    truncated: p.tracks.length > 16,
  };
}

/**
 * Send a request to the mix assistant. Posts the prompt + project context
 * summary to the Cloudflare Worker gateway whose URL is configured via
 * `VITE_AI_GATEWAY_URL`. Returns a list of {tool, args} commands the caller
 * resolves into typed `EngineCommandSuggestion`s via `resolveCommand`.
 *
 * Throws with a useful message if the env var is unset, the gateway is
 * unreachable, or the gateway returns an error body.
 */
export async function callMixAssistant(req: MixAssistantRequest): Promise<MixAssistantResponse> {
  const url = import.meta.env.VITE_AI_GATEWAY_URL;
  if (!url) {
    throw new Error(
      "mix-assistant not configured: set VITE_AI_GATEWAY_URL in apps/web/.env.local and rebuild",
    );
  }
  const endpoint = `${url.replace(/\/+$/, "")}/mix-assistant`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: req.prompt, context: req.context }),
    });
  } catch (err) {
    throw new Error(`gateway unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`gateway ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    commands?: Array<{ tool: string; args: Record<string, unknown> }>;
    needsClarification?: string;
    error?: string;
  };
  if (data.error) throw new Error(data.error);
  const commands: EngineCommandSuggestion[] = [];
  for (const raw of data.commands ?? []) {
    const resolved = resolveCommand(raw.tool, raw.args);
    if (resolved) commands.push(resolved);
  }
  return data.needsClarification
    ? { commands, needsClarification: data.needsClarification }
    : { commands };
}

/** Validate + normalize a raw tool call into a typed engine suggestion.
 *  Returns null for unknown tools so the rest of the batch still flows.
 *  Kept defensive — the LLM can hallucinate keys or types. */
export function resolveCommand(
  tool: string,
  args: Record<string, unknown>,
): EngineCommandSuggestion | null {
  const num = (k: string) => (typeof args[k] === "number" ? (args[k] as number) : NaN);
  const int = (k: string) => {
    const v = args[k];
    return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : NaN;
  };
  const str = (k: string) => (typeof args[k] === "string" ? (args[k] as string) : "");
  switch (tool) {
    case "set_track_gain": {
      const trackId = int("track_id");
      const delta = num("delta_db");
      if (!Number.isFinite(trackId) || !Number.isFinite(delta)) return null;
      // Stored as a *relative* dB change; the executor reads the current
      // gain and applies. The schema is "delta" not "absolute" so the LLM
      // doesn't need to know the current value.
      return { type: "setTrackGain", trackId, gain: delta, rationale: str("rationale") };
    }
    case "set_track_pan": {
      const trackId = int("track_id");
      const pan = num("pan");
      if (!Number.isFinite(trackId) || !Number.isFinite(pan)) return null;
      return {
        type: "setTrackPan",
        trackId,
        pan: Math.max(-1, Math.min(1, pan)),
        rationale: str("rationale"),
      };
    }
    case "add_eq_band": {
      const trackId = int("track_id");
      const freq = num("freq_hz");
      const q = num("q");
      const gainDb = num("gain_db");
      if (!Number.isFinite(trackId) || !Number.isFinite(freq)) return null;
      return {
        type: "addEq",
        trackId,
        freq,
        q: Number.isFinite(q) ? q : 1,
        gainDb: Number.isFinite(gainDb) ? gainDb : 0,
        rationale: str("rationale"),
      };
    }
    case "add_compressor": {
      const trackId = int("track_id");
      if (!Number.isFinite(trackId)) return null;
      return {
        type: "addCompressor",
        trackId,
        thresholdDb: num("threshold_db"),
        ratio: num("ratio"),
        rationale: str("rationale"),
      };
    }
    case "add_delay": {
      const trackId = int("track_id");
      const beats = num("beats");
      if (!Number.isFinite(trackId) || !Number.isFinite(beats)) return null;
      return {
        type: "addDelay",
        trackId,
        beats,
        feedback: num("feedback"),
        wet: num("wet"),
        rationale: str("rationale"),
      };
    }
    case "sidechain": {
      const from = int("from_track_id");
      const to = int("to_track_id");
      if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
      return { type: "sidechain", from, to, rationale: str("rationale") };
    }
    default:
      return null;
  }
}

/** Tool schema we'll register with the LLM once the gateway is live. */
export const MIX_ASSISTANT_TOOLS = [
  {
    name: "set_track_gain",
    description: "Adjust a track's gain in dB.",
    input_schema: {
      type: "object",
      properties: {
        track_id: { type: "integer", description: "Target track id from the context summary." },
        delta_db: { type: "number", description: "Change in dB (positive=louder, negative=quieter)." },
        rationale: { type: "string" },
      },
      required: ["track_id", "delta_db", "rationale"],
    },
  },
  {
    name: "set_track_pan",
    description: "Set track stereo pan, -1 (left) to +1 (right).",
    input_schema: {
      type: "object",
      properties: {
        track_id: { type: "integer" },
        pan: { type: "number", minimum: -1, maximum: 1 },
        rationale: { type: "string" },
      },
      required: ["track_id", "pan", "rationale"],
    },
  },
  {
    name: "add_eq_band",
    description: "Add a peak/shelf EQ band on a track.",
    input_schema: {
      type: "object",
      properties: {
        track_id: { type: "integer" },
        freq_hz: { type: "number" },
        q: { type: "number" },
        gain_db: { type: "number" },
        kind: { enum: ["peak", "low_shelf", "high_shelf", "lowpass", "highpass"] },
        rationale: { type: "string" },
      },
      required: ["track_id", "freq_hz", "q", "gain_db", "kind", "rationale"],
    },
  },
  {
    name: "add_compressor",
    description: "Add a compressor with a given threshold, ratio, attack, release.",
    input_schema: {
      type: "object",
      properties: {
        track_id: { type: "integer" },
        threshold_db: { type: "number" },
        ratio: { type: "number", minimum: 1, maximum: 20 },
        attack_ms: { type: "number", minimum: 0.1, maximum: 1000 },
        release_ms: { type: "number", minimum: 1, maximum: 5000 },
        makeup_db: { type: "number" },
        rationale: { type: "string" },
      },
      required: ["track_id", "threshold_db", "ratio", "attack_ms", "release_ms", "rationale"],
    },
  },
  {
    name: "add_delay",
    description: "Add a stereo delay synced to a beat division (e.g. 0.5 = half note, 0.125 = 1/8).",
    input_schema: {
      type: "object",
      properties: {
        track_id: { type: "integer" },
        beats: { type: "number" },
        feedback: { type: "number", minimum: 0, maximum: 0.95 },
        wet: { type: "number", minimum: 0, maximum: 1 },
        ping_pong: { type: "number", minimum: 0, maximum: 1 },
        rationale: { type: "string" },
      },
      required: ["track_id", "beats", "feedback", "wet", "rationale"],
    },
  },
  {
    name: "sidechain",
    description: "Sidechain the compressor on one track to the signal of another.",
    input_schema: {
      type: "object",
      properties: {
        from_track_id: { type: "integer", description: "Trigger track (e.g. kick)." },
        to_track_id: { type: "integer", description: "Track being compressed (e.g. bass)." },
        amount_db: { type: "number" },
        rationale: { type: "string" },
      },
      required: ["from_track_id", "to_track_id", "rationale"],
    },
  },
] as const;
