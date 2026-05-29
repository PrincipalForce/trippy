# trippy AI gateway (Cloudflare Worker)

Holds the Anthropic API key and proxies `POST /mix-assistant` to Claude with
tool use. Returns resolved tool calls in a stable JSON shape the PWA can
preview before dispatching.

## Why a Worker?

The browser must never see `ANTHROPIC_API_KEY`. Anyone with that key can
spend money. The Worker is the smallest deployable unit that keeps the
secret server-side and adds a per-origin CORS allow-list.

## Deploy

```sh
cd workers/ai-gateway
pnpm install
pnpm wrangler login                    # one-time
pnpm wrangler secret put ANTHROPIC_API_KEY
pnpm deploy
```

`pnpm deploy` prints the `*.workers.dev` URL. Point the PWA at it:

```sh
echo 'VITE_AI_GATEWAY_URL=https://trippy-ai-gateway.<account>.workers.dev' \
  >> apps/web/.env.local
```

Then rebuild the PWA so the env var is baked in.

## Endpoints

- `GET /healthz` — returns `ok`.
- `POST /mix-assistant` — body `{ "prompt": string, "context": object }`.
  Response: `{ "commands": [{tool, args}], "needsClarification"?: string }`.

## CORS allow-list

Set `ALLOWED_ORIGINS` in `wrangler.toml` to a comma-separated list of
origins (no trailing slash). Local dev defaults to `http://localhost:5173`
and the staging Pages URL.

## Tool schema

The Worker's `TOOLS` array mirrors `apps/web/src/ai/mix-assistant.ts`
`MIX_ASSISTANT_TOOLS`. Change one, change the other — the PWA validates
incoming tool names against its own list before dispatching, so a
mismatch surfaces as a "skipped: unknown tool" line rather than a crash.
