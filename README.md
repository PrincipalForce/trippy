# trippy

A mobile-first, next-generation, browser-based DAW — the spiritual successor to Sony ACID Pro.

Loop-based beat assembly, parameter automation, top-tier audio editing, built-in FX, MIDI, deep stream inspection, and AI-assisted editing — all in a touch-first PWA powered by a Rust + WebAssembly DSP engine.

## Status

Pre-alpha. Currently at milestone **M0 — foundation**.

## Stack

- **DSP core**: Rust → WebAssembly (SIMD, threads)
- **Audio runtime**: Web Audio API + AudioWorklet, SharedArrayBuffer ring buffers
- **UI**: SolidJS + Vite + TypeScript, WebGL2 for timeline/meters
- **Distribution**: PWA first, Tauri desktop + Capacitor mobile later
- **AI**: ONNX Runtime Web + WebGPU on-device, Cloudflare Workers AI for heavy lifts

## Repo layout

```
crates/trippy-engine     Rust DSP core (compiles to wasm32)
crates/trippy-dsp-prims  SIMD-optimized DSP primitives
apps/web                 SolidJS PWA
packages/trippy-format   Shared .trippy project schema (TS + Rust)
packages/trippy-ui-kit   Touch-first UI components
tools/acid-import        CLI: read ACID .wav chunks → trippy clips
```

## Local development

Prerequisites: Node 20+, pnpm 10+, Rust stable, `wasm-pack` (`cargo install wasm-pack`).

```bash
pnpm install
pnpm build:engine:dev     # build the Rust engine to wasm
pnpm dev                  # start the PWA on http://localhost:5173
```

The dev server is configured to serve `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` headers, which are required for
`SharedArrayBuffer` and WASM threads.

## License

TBD.
