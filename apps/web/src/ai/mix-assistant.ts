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
 * Send a request to the mix assistant. Throws until the Workers AI gateway
 * lands in M8 — the UI handles the error with a "coming soon" message.
 */
export async function callMixAssistant(_req: MixAssistantRequest): Promise<MixAssistantResponse> {
  throw new Error(
    "mix-assistant cloud gateway not yet deployed (M8 work — see docs/M8-cloud.md)",
  );
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
