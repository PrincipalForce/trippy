# Contributing to trippy

Thanks for thinking about contributing! trippy is early — the audio engine
core is in place, but most milestones beyond M4 are still scaffolding. There's
room for substantial work.

## Before you start

For anything larger than a small fix, **open an issue first** so we can align
on approach. The plan in [`docs/`](docs/) is opinionated; PRs that fight the
architecture are hard to merge.

Good first issues:

- Reverb tail calibration (see the ignored test in `crates/trippy-engine/src/fx/reverb.rs`)
- Phase-vocoder time-stretch for tonal material (companion to WSOLA)
- WAM 2.0 plugin host wiring (see `docs/M9-plugin-host.md`)
- Real PWA icons (the current `apps/web/public/icons/*.png` are placeholders)

## Local development

```bash
pnpm install
pnpm build:engine:dev   # build Rust → wasm
pnpm dev                # http://localhost:5173
```

Requires Node 20+, pnpm 10+, Rust stable, and `wasm-pack`
(`cargo install wasm-pack`).

## Before opening a PR

- `cargo fmt --all` — Rust formatting
- `cargo clippy --workspace --all-targets -- -D warnings` — Rust lints
- `cargo test --workspace` — Rust tests
- `pnpm typecheck` — TS types
- `pnpm test` — JS/TS tests
- `pnpm build` — production bundle still builds

CI runs all of these on every push.

## Code style

- **No dead code, no speculative abstractions.** A bug fix doesn't need
  surrounding cleanup; one similar shape repeated three times is fine.
- **Comment WHY, not WHAT.** Well-named identifiers describe the what.
  Comments explain non-obvious constraints, surprising behavior, or
  workarounds for specific bugs.
- **Audio thread is allocation-free.** Engine `process()` paths must never
  allocate, lock, or call into JS.
- **Tests.** New DSP needs unit tests with synthetic signals
  (impulse, sine, white noise). New UI components need component-level
  tests against the project store.

## Licensing

By contributing, you agree your changes will be dual-licensed under
**MIT OR Apache-2.0** (same as the rest of the project).
