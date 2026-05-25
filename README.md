# trippy

[![CI](https://github.com/principalforce/trippy/actions/workflows/ci.yml/badge.svg)](https://github.com/principalforce/trippy/actions/workflows/ci.yml)
[![License: MIT OR Apache-2.0](https://img.shields.io/badge/license-MIT%20OR%20Apache--2.0-blue.svg)](#license)

A mobile-first, next-generation, browser-based DAW — the spiritual successor
to Sony ACID Pro.

Loop-based beat assembly, parameter automation, top-tier audio editing,
built-in FX, MIDI, deep stream inspection, and AI-assisted editing — all in a
touch-first PWA powered by a Rust + WebAssembly DSP engine.

## Status

Pre-alpha. M0–M9 architectural milestones have working code and tests in
place; many features beyond M4 are scaffolding waiting for production
deployment (cloud sync, plugin host) or model integration (AI). See
[`docs/`](docs/) for milestone notes.

## Stack

| Layer | Choice |
|---|---|
| DSP core | Rust → WebAssembly (SIMD-ready, threads-ready) |
| Audio runtime | Web Audio API + AudioWorklet + SharedArrayBuffer ring buffer |
| UI | SolidJS + Vite + TypeScript |
| Persistence | OPFS for projects + samples |
| Distribution | PWA first; Tauri desktop + Capacitor mobile later |
| AI | ONNX Runtime Web + WebGPU on-device, Cloudflare Workers AI for cloud |

## Repo layout

```
crates/trippy-engine     Rust DSP core (compiles to wasm32)
crates/trippy-dsp-prims  SIMD-optimized DSP primitives
apps/web                 SolidJS PWA
packages/trippy-format   Shared .trippy project schema (TS + Rust)
packages/trippy-ui-kit   Touch-first UI components (placeholder)
tools/acid-import        CLI: read ACID .wav chunks → trippy clips (placeholder)
docs                     Milestone design notes
```

## What works today

- **Engine**: sample-accurate transport, multi-track mixer, mute/solo,
  constant-power pan, looping, WAV decode (8/16/24/32-bit PCM + IEEE
  float, mono+stereo), ACID chunk parsing.
- **Effects**: RBJ biquad, parametric EQ, soft-knee compressor, stereo
  delay, FDN reverb, tanh saturation — all allocation-free.
- **Audio math**: WSOLA time-stretch, pitch-shift, MIDI events + note→Hz,
  polyphonic sampler with voice stealing, recording-to-source bounce.
- **Project**: versioned `.trippy` schema, OPFS save/load with audio,
  patch-based undo/redo.
- **Timeline**: Canvas waveform rendering with multi-resolution peak
  pyramid, pinch-zoom, beat-grid ruler, click-to-seek.
- **Audio path**: Rust engine in a Web Worker → SAB ring → AudioWorklet
  drain. Underrun reporting. Cross-origin isolation headers wired.

## Local development

Prerequisites:

- Node 20+
- pnpm 10+
- Rust stable
- `wasm-pack` (`cargo install wasm-pack`)

```bash
pnpm install
pnpm build:engine:dev      # build the Rust engine to wasm
pnpm dev                   # start the PWA on http://localhost:5173
```

The dev server serves `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` headers, which are required
for `SharedArrayBuffer` (the audio engine's ring buffer relies on it). When
deploying, make sure your hosting setup serves the same headers.

### Useful scripts

```bash
pnpm typecheck             # TS across all packages
pnpm test                  # JS/TS tests (vitest)
pnpm test:rust             # cargo test --workspace
pnpm lint:rust             # cargo clippy -D warnings
pnpm fmt:rust              # cargo fmt --all
pnpm build:engine          # release wasm
pnpm build                 # production web bundle
pnpm icons                 # regenerate PWA icons from favicon.svg
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). The project is early enough that
substantial contributions are welcome — especially in the AI (M7.5), cloud
(M8), and plugin host (M9) areas.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy.

## License

Dual-licensed under either of:

- MIT license ([LICENSE-MIT](LICENSE-MIT) or http://opensource.org/licenses/MIT)
- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE) or http://www.apache.org/licenses/LICENSE-2.0)

at your option.

Unless you explicitly state otherwise, any contribution intentionally
submitted for inclusion in the work by you, as defined in the Apache-2.0
license, shall be dual-licensed as above, without any additional terms or
conditions.
