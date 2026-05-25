# M9 — Plugin host

Trippy's plugin story is **WAM 2.0 first, native later.**

## Why WAM 2.0 first

- It runs in the browser today, with no native bridge. The same loader will
  later run inside Tauri desktop builds.
- The ecosystem already includes ports of high-quality plugins (Surge XT,
  Dexed, OB-Xd, Sonic Filter, AudioBrowser).
- Plugins ship as ESM modules + an AudioWorklet processor — same primitives
  we already use for trippy's own engine.
- WAM 2.0 has a settled spec (v2.0, June 2023) and a reference SDK (`@webaudiomodules/sdk`).

## Architecture

```text
┌───────────────── AudioContext ─────────────────┐
│                                                │
│   ┌──────────┐   ┌──────────┐   ┌──────────┐   │
│   │ trippy   │──▶│  WAM #1  │──▶│  WAM #2  │──▶│─── master out
│   │ track    │   │ (EQ)     │   │ (Reverb) │   │
│   └──────────┘   └──────────┘   └──────────┘   │
│                                                │
└────────────────────────────────────────────────┘
```

WAM nodes are regular `AudioNode`s, so they slot into the master graph
between trippy's per-track engine output and the master worklet. The engine
worker still owns DSP for trippy's own tracks; WAM plugins live on the main
AudioContext as siblings.

## Plugin discovery

- `/plugins/index.json` — manifest, `WamPluginDescriptor[]`
- Each plugin's `url` points to its ESM entry, served from
  `/plugins/<vendor>/<plugin>/index.js`
- Trust model: only plugins listed in the manifest are loadable. We host the
  manifest, so we control the supply chain.

## VST3 / AU / CLAP

These three formats need native code and live outside the browser sandbox.
The plan:

- **Tauri desktop build** (post-M9): ship a native bridge that scans the
  user's plugin folders, loads VST3/AU/CLAP via the C++ SDK, and exposes
  parameter/audio I/O over IPC to the WASM engine. Reuses the same engine
  binary as the web build — only the bridge is new.
- **iOS/Android** (Capacitor): AU on iOS and JUCE-via-Oboe on Android. Same
  bridge pattern.

The web-side `WamPluginDescriptor` and `WamInstance` interfaces are designed
so a native plugin can be wrapped to look identical to a WAM from the
engine's perspective — no UI code change.
