# M8 — Cloud sync + collaboration (design notes)

This document captures the planned shape of trippy's cloud layer so the
client-side stubs in `apps/web/src/cloud/` can grow into real plumbing
without re-architecting.

## Goals

- **Offline-first.** OPFS is canonical. Cloud is a sync target, not the source
  of truth. A project must always open, edit, and save without network.
- **Conflict-free collab.** Two users editing the same project from two
  devices should never produce a "merge conflict" dialog. CRDTs.
- **Cheap to host.** Cloudflare Workers + R2 + Durable Objects scale to zero;
  per-user cost is dominated by sample storage, not compute.
- **No vendor lock-in for the user.** Every project remains downloadable as a
  `.trippy` bundle (zip) that opens in any future client.

## Stack

| Concern | Choice |
|---|---|
| Auth | WebAuthn passkeys; session cookie HttpOnly/SameSite=Strict |
| Edge runtime | Cloudflare Workers |
| CRDT room | Durable Object per project, holding the Yjs doc |
| Real-time wire | WebSocket inside the DO, Yjs-encoded updates |
| Audio CDN | R2, content-addressed by sha-256 |
| Auth gateway / billing | Stripe for premium tiers (cloud storage, AI) |
| AI gateway | Workers AI for cloud models (MusicGen, mix-assistant LLM) |

## Project sync model

- **Project doc**: a Yjs `Doc` whose root is the same JSON schema as
  `packages/trippy-format` — but every field is mapped to Yjs types
  (`Y.Map`, `Y.Array`) so edits are CRDT operations, not JSON patches.
- **Audio**: never goes through the CRDT. On `addSource`, the client computes
  the sha-256, uploads to R2 if not present, and stores only the digest +
  metadata in the project doc. Downloads are lazy (UI requests the file
  when the user views/plays a track that needs it).
- **Snapshots**: every N edits or M minutes, the DO writes a Yjs snapshot
  to R2 keyed by `project-id/snapshot-{ts}.yjs`. Clients pulling a fresh
  project start from the latest snapshot, then catch up with deltas.

## CRDT-friendly engine state

The engine (Rust) is **not** Yjs-aware. The UI translates Yjs doc changes
into engine commands and vice versa. This keeps the audio thread free of
collab overhead.

Conflict semantics that fall out naturally:
- Two users move the same clip → last-writer-wins on (startFrame, trackId).
- Two users add different clips at the same position → both kept.
- Two users change a knob → last-writer-wins (visually: brief flicker as
  the remote update arrives ~200ms later).

## Implementation plan

1. **Workers project skeleton** — Hono + Yjs + R2 binding. `/auth/*`,
   `/projects/*`, `/sync/:projectId` (WS upgrade).
2. **Passkey flow** — register, authenticate, session cookie.
3. **R2 upload of audio by hash** — presigned PUT URLs.
4. **Project doc PUT/GET** — Yjs binary encoding.
5. **Live sync WebSocket** — Yjs awareness + updates.
6. **Web app integration** — replace `StubCloudClient` with the real one.
7. **Billing**: Stripe Checkout for "Pro" tier (storage quota + AI tokens).

## What's already in the repo

- `apps/web/src/cloud/sync.ts` — typed client interface + stub.
- `apps/web/src/project/store.ts` — patch-based undo, already shaped to
  swap in Yjs binding without UI changes (the store hands out
  `state.project`; we'll wrap that in a Yjs proxy at M8 time).
