// Engine worker: owns the WASM engine and feeds the SAB ring buffer.
//
// Receives commands from the main thread (load WAV, add track/clip, play/stop,
// set BPM, etc.) and a SAB ring handle. Continuously renders audio in chunks
// and writes into the ring, sleeping (Atomics.wait) when the ring is full.

import init, { WasmEngine } from "../engine/pkg/trippy_engine";
import {
  attachRingBuffer,
  availableWrite,
  writeFrames,
  type RingBuffer,
} from "./ringbuffer";

// Commands accepted from the main thread.
export type EngineCommand =
  | { type: "init"; ringSab: SharedArrayBuffer; sampleRate: number; wasmUrl: string }
  | { type: "loadWav"; bytes: ArrayBuffer; requestId: number }
  | { type: "addTrack"; requestId: number }
  | {
      type: "addClip";
      trackId: number;
      sourceId: number;
      startFrame: number;
      lengthFrames: number;
      offsetInSource: number;
      requestId: number;
    }
  | { type: "play" }
  | { type: "stop" }
  | { type: "setBpm"; bpm: number }
  | { type: "setLoop"; start: number; end: number }
  | { type: "clearLoop" }
  | { type: "setPosition"; frame: number }
  | { type: "setTrackGain"; trackId: number; gain: number }
  | { type: "setTrackPan"; trackId: number; pan: number }
  | { type: "setTrackMute"; trackId: number; mute: boolean }
  | { type: "setTrackSolo"; trackId: number; solo: boolean }
  | { type: "removeClip"; trackId: number; clipId: number }
  | { type: "removeTrack"; trackId: number };

// Events emitted back to the main thread.
export type EngineEvent =
  | { type: "ready"; sampleRate: number }
  | {
      type: "wavLoaded";
      requestId: number;
      sourceId: number;
      sampleRate: number;
      channels: number;
      frameCount: number;
    }
  | { type: "trackAdded"; requestId: number; trackId: number }
  | { type: "clipAdded"; requestId: number; clipId: number }
  | { type: "error"; message: string; requestId?: number }
  | { type: "position"; frame: number; playing: boolean };

let engine: WasmEngine | null = null;
let rb: RingBuffer | null = null;
let running = false;

// Reusable mix buffers, sized to the chunk we render per iteration.
// 512 frames @ 48 kHz ≈ 10.6ms — plenty of slack vs the worklet's 128-frame
// quantum and well within typical scheduler granularity.
const CHUNK_FRAMES = 512;
let mixL = new Float32Array(CHUNK_FRAMES);
let mixR = new Float32Array(CHUNK_FRAMES);
let interleaved = new Float32Array(CHUNK_FRAMES * 2);

function emit(ev: EngineEvent, transfer: Transferable[] = []) {
  (self as DedicatedWorkerGlobalScope).postMessage(ev, transfer);
}

async function handleInit(cmd: Extract<EngineCommand, { type: "init" }>) {
  await init(cmd.wasmUrl);
  engine = new WasmEngine(cmd.sampleRate);
  rb = attachRingBuffer(cmd.ringSab);
  emit({ type: "ready", sampleRate: cmd.sampleRate });
  startRenderLoop();
}

function startRenderLoop() {
  if (running) return;
  running = true;
  // We use setTimeout to keep the worker responsive to messages.
  // The loop is paced by ring backpressure: when the ring is full we yield.
  const tick = () => {
    if (!running || !engine || !rb) return;
    const free = availableWrite(rb);
    if (free >= CHUNK_FRAMES) {
      try {
        engine.process(mixL, mixR);
        // Interleave mixL/mixR → interleaved
        for (let i = 0; i < CHUNK_FRAMES; i++) {
          interleaved[i * 2] = mixL[i]!;
          interleaved[i * 2 + 1] = mixR[i]!;
        }
        writeFrames(rb, interleaved, CHUNK_FRAMES);
      } catch (err) {
        emit({ type: "error", message: `process: ${String(err)}` });
      }
      // Yield to message pump but immediately reschedule.
      setTimeout(tick, 0);
    } else {
      // Ring nearly full — wait a bit. This is the steady-state path.
      setTimeout(tick, 2);
    }

    // Periodic position broadcast (every ~50ms).
    maybeBroadcastPosition();
  };
  tick();
}

let lastPositionBroadcast = 0;
function maybeBroadcastPosition() {
  if (!engine) return;
  const now = performance.now();
  if (now - lastPositionBroadcast > 50) {
    emit({
      type: "position",
      frame: engine.positionFrames(),
      playing: engine.isPlaying(),
    });
    lastPositionBroadcast = now;
  }
}

self.onmessage = async (e: MessageEvent<EngineCommand>) => {
  const cmd = e.data;
  try {
    if (cmd.type === "init") {
      await handleInit(cmd);
      return;
    }
    if (!engine) {
      emit({ type: "error", message: "engine not initialised" });
      return;
    }
    switch (cmd.type) {
      case "loadWav": {
        const bytes = new Uint8Array(cmd.bytes);
        const meta = JSON.parse(engine.addSourceFromWav(bytes));
        emit({
          type: "wavLoaded",
          requestId: cmd.requestId,
          sourceId: meta.sourceId,
          sampleRate: meta.sampleRate,
          channels: meta.channels,
          frameCount: meta.frameCount,
        });
        break;
      }
      case "addTrack": {
        const trackId = engine.addTrack();
        emit({ type: "trackAdded", requestId: cmd.requestId, trackId });
        break;
      }
      case "addClip": {
        const clipId = engine.addClip(
          cmd.trackId,
          cmd.sourceId,
          BigInt(cmd.startFrame),
          BigInt(cmd.lengthFrames),
          BigInt(cmd.offsetInSource),
        );
        emit({ type: "clipAdded", requestId: cmd.requestId, clipId });
        break;
      }
      case "play":
        engine.play();
        break;
      case "stop":
        engine.stop();
        break;
      case "setBpm":
        engine.setBpm(cmd.bpm);
        break;
      case "setLoop":
        engine.setLoop(cmd.start, cmd.end);
        break;
      case "clearLoop":
        engine.clearLoop();
        break;
      case "setPosition":
        engine.setPosition(cmd.frame);
        break;
      case "setTrackGain":
        engine.setTrackGain(cmd.trackId, cmd.gain);
        break;
      case "setTrackPan":
        engine.setTrackPan(cmd.trackId, cmd.pan);
        break;
      case "setTrackMute":
        engine.setTrackMute(cmd.trackId, cmd.mute);
        break;
      case "setTrackSolo":
        engine.setTrackSolo(cmd.trackId, cmd.solo);
        break;
      case "removeClip":
        engine.removeClip(cmd.trackId, cmd.clipId);
        break;
      case "removeTrack":
        engine.removeTrack(cmd.trackId);
        break;
    }
  } catch (err) {
    emit({
      type: "error",
      message: `${cmd.type}: ${err instanceof Error ? err.message : String(err)}`,
      requestId: "requestId" in cmd ? cmd.requestId : undefined,
    });
  }
};
