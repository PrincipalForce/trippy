// trippy AI gateway.
//
// One Worker, two responsibilities:
//   1. Hold the ANTHROPIC_API_KEY so it never reaches the browser.
//   2. Translate a {prompt, context} request into a Claude Messages API
//      call with tool use, then return the resolved tool calls back to
//      the PWA in a stable schema the client can dispatch into the engine.
//
// The tool schema must stay in sync with apps/web/src/ai/mix-assistant.ts —
// the PWA owns the canonical list there, and the Worker echoes the same
// names + arg shapes when forwarding tool_use blocks. If you change one,
// change both.

export interface Env {
  ANTHROPIC_API_KEY: string;
  ALLOWED_ORIGINS: string;
}

const SYSTEM_PROMPT = `You are the trippy mix assistant. The user is producing
music in a browser-based DAW and will ask you for mix adjustments in plain
English (e.g. "sidechain the bass to the kick, brighten the hats 2dB above 8k").

You will receive a compact JSON summary of the project: BPM, sample rate, and
each track's id, name, gain, pan, mute, and rough duration. Use it to ground
each suggestion to a concrete track_id.

Respond ONLY by calling the provided tools. Each tool call is a single
concrete change. Include a short rationale (one sentence) on every call so
the user understands why. Do NOT chain narration around the tool calls;
the UI presents them as a previewable diff.

If the request is ambiguous (e.g. "make it louder" with three tracks named
"vox"), ask for clarification via the request_info tool instead of guessing.`;

// Mirrors apps/web/src/ai/mix-assistant.ts MIX_ASSISTANT_TOOLS. Plus a
// request_info escape hatch for ambiguous prompts.
const TOOLS = [
  {
    name: "set_track_gain",
    description: "Adjust a track's gain by a delta in dB.",
    input_schema: {
      type: "object",
      properties: {
        track_id: { type: "integer" },
        delta_db: { type: "number" },
        rationale: { type: "string" },
      },
      required: ["track_id", "delta_db", "rationale"],
    },
  },
  {
    name: "set_track_pan",
    description: "Set a track's stereo pan: -1 (left) to +1 (right).",
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
    description: "Add a compressor with threshold, ratio, attack, release, makeup.",
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
      required: [
        "track_id",
        "threshold_db",
        "ratio",
        "attack_ms",
        "release_ms",
        "rationale",
      ],
    },
  },
  {
    name: "add_delay",
    description:
      "Add a stereo delay synced to a beat division (0.5 = half note, 0.125 = 1/8).",
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
    description: "Sidechain the compressor on one track to another's signal.",
    input_schema: {
      type: "object",
      properties: {
        from_track_id: { type: "integer" },
        to_track_id: { type: "integer" },
        amount_db: { type: "number" },
        rationale: { type: "string" },
      },
      required: ["from_track_id", "to_track_id", "rationale"],
    },
  },
  {
    name: "request_info",
    description:
      "Ask the user a single clarifying question instead of guessing. Use when the prompt is ambiguous.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string" } },
      required: ["question"],
    },
  },
] as const;

interface MixRequest {
  prompt: string;
  context: unknown;
}

interface AssistantCommand {
  tool: string;
  args: Record<string, unknown>;
}

interface MixResponse {
  commands: AssistantCommand[];
  needsClarification?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (url.pathname === "/healthz") {
      return new Response("ok", { status: 200, headers: cors });
    }

    if (url.pathname === "/mix-assistant" && request.method === "POST") {
      try {
        const body = (await request.json()) as MixRequest;
        if (!body || typeof body.prompt !== "string") {
          return json({ error: "missing prompt" }, 400, cors);
        }
        if (!env.ANTHROPIC_API_KEY) {
          return json({ error: "gateway not configured (ANTHROPIC_API_KEY)" }, 500, cors);
        }
        const result = await callClaude(body, env.ANTHROPIC_API_KEY);
        return json(result, 200, cors);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return json({ error: message }, 500, cors);
      }
    }

    return json({ error: "not found" }, 404, cors);
  },
};

async function callClaude(req: MixRequest, apiKey: string): Promise<MixResponse> {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      messages: [
        {
          role: "user",
          content: `Project context:\n${JSON.stringify(req.context)}\n\nUser request:\n${req.prompt}`,
        },
      ],
    }),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`anthropic ${r.status}: ${text}`);
  }
  const data = (await r.json()) as {
    content: Array<
      | { type: "text"; text: string }
      | { type: "tool_use"; name: string; input: Record<string, unknown> }
    >;
  };
  const commands: AssistantCommand[] = [];
  let needsClarification: string | undefined;
  for (const block of data.content) {
    if (block.type !== "tool_use") continue;
    if (block.name === "request_info") {
      const q = typeof block.input.question === "string" ? block.input.question : "Could you clarify?";
      needsClarification = q;
      continue;
    }
    commands.push({ tool: block.name, args: block.input });
  }
  return needsClarification ? { commands, needsClarification } : { commands };
}

function corsHeaders(origin: string | null, allowed: string): HeadersInit {
  const list = allowed.split(",").map((s) => s.trim());
  const allowOrigin = origin && list.includes(origin) ? origin : list[0] ?? "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS, GET",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(payload: unknown, status: number, cors: HeadersInit): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...cors },
  });
}
