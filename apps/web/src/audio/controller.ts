// AudioController: main-thread facade that wires everything together.
//
// - Creates the AudioContext + SAB ring
// - Spawns the engine worker, hands it the SAB and wasm URL
// - Loads the AudioWorklet and connects it to destination
// - Provides a typed promise-based API for the UI

import EngineWorker from "./engine-worker?worker";
import workletUrl from "./worklet-processor?worker&url";
import wasmUrl from "../engine/pkg/trippy_engine_bg.wasm?url";
import { createRingBuffer } from "./ringbuffer";
import type { EngineCommand, EngineEvent } from "./engine-worker";

export interface ControllerOptions {
  /** Ring capacity in frames. Must be a power of two. Default 8192 ≈ 170ms @ 48k. */
  ringCapacityFrames?: number;
}

export interface TransportState {
  positionFrames: number;
  playing: boolean;
}

export interface LoadedSource {
  sourceId: number;
  sampleRate: number;
  channels: number;
  frameCount: number;
}

type Listener = (state: TransportState) => void;

export class AudioController {
  private ctx: AudioContext;
  private worker: Worker;
  private worklet: AudioWorkletNode | null = null;
  private pending = new Map<number, (ev: EngineEvent) => void>();
  private nextRequestId = 1;
  private listeners = new Set<Listener>();
  private state: TransportState = { positionFrames: 0, playing: false };
  readonly sampleRate: number;

  constructor(opts: ControllerOptions = {}) {
    const ringCapacity = opts.ringCapacityFrames ?? 8192;
    this.ctx = new AudioContext();
    this.sampleRate = this.ctx.sampleRate;
    const rb = createRingBuffer(ringCapacity, 2);
    this.worker = new EngineWorker();
    this.worker.onmessage = (e: MessageEvent<EngineEvent>) => this.onWorkerEvent(e.data, rb.sab);
    this.worker.onerror = (e) => {
      // eslint-disable-next-line no-console
      console.error("engine worker error", e);
    };
    // Stash SAB on instance for the ready handler to forward to the worklet.
    this.pendingRingSab = rb.sab;
    const cmd: EngineCommand = {
      type: "init",
      ringSab: rb.sab,
      sampleRate: this.sampleRate,
      wasmUrl,
    };
    this.worker.postMessage(cmd);
  }

  private pendingRingSab: SharedArrayBuffer | null = null;

  private async onWorkerEvent(ev: EngineEvent, ringSab: SharedArrayBuffer) {
    if (ev.type === "ready") {
      await this.ctx.audioWorklet.addModule(workletUrl);
      this.worklet = new AudioWorkletNode(this.ctx, "trippy-output", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [2],
        processorOptions: { ringSab },
      });
      this.worklet.port.onmessage = (e) => {
        if (e.data?.type === "underrun") {
          // eslint-disable-next-line no-console
          console.warn("[trippy] audio underrun", e.data);
        }
      };
      this.worklet.connect(this.ctx.destination);
      this.pendingRingSab = null;
      return;
    }
    if (ev.type === "position") {
      this.state = { positionFrames: ev.frame, playing: ev.playing };
      this.listeners.forEach((fn) => fn(this.state));
      return;
    }
    if ("requestId" in ev && ev.requestId != null) {
      const cb = this.pending.get(ev.requestId);
      if (cb) {
        this.pending.delete(ev.requestId);
        cb(ev);
      }
    }
    if (ev.type === "error") {
      // eslint-disable-next-line no-console
      console.error("[trippy engine]", ev.message);
    }
  }

  private request<T extends EngineEvent>(
    build: (id: number) => EngineCommand,
  ): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, (ev) => {
        if (ev.type === "error") reject(new Error(ev.message));
        else resolve(ev as T);
      });
      this.worker.postMessage(build(id));
    });
  }

  /** Browsers gate AudioContext until a user gesture; call this from a click handler. */
  async resume(): Promise<void> {
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  onTransportChange(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async loadWav(bytes: ArrayBuffer): Promise<LoadedSource> {
    const ev = await this.request<Extract<EngineEvent, { type: "wavLoaded" }>>((id) => ({
      type: "loadWav",
      bytes,
      requestId: id,
    }));
    return {
      sourceId: ev.sourceId,
      sampleRate: ev.sampleRate,
      channels: ev.channels,
      frameCount: ev.frameCount,
    };
  }

  async addTrack(): Promise<number> {
    const ev = await this.request<Extract<EngineEvent, { type: "trackAdded" }>>((id) => ({
      type: "addTrack",
      requestId: id,
    }));
    return ev.trackId;
  }

  async addClip(opts: {
    trackId: number;
    sourceId: number;
    startFrame?: number;
    lengthFrames?: number;
    offsetInSource?: number;
  }): Promise<number> {
    const ev = await this.request<Extract<EngineEvent, { type: "clipAdded" }>>((id) => ({
      type: "addClip",
      trackId: opts.trackId,
      sourceId: opts.sourceId,
      startFrame: opts.startFrame ?? 0,
      lengthFrames: opts.lengthFrames ?? 0,
      offsetInSource: opts.offsetInSource ?? 0,
      requestId: id,
    }));
    return ev.clipId;
  }

  removeClip(trackId: number, clipId: number) {
    this.worker.postMessage({ type: "removeClip", trackId, clipId } satisfies EngineCommand);
  }

  removeTrack(trackId: number) {
    this.worker.postMessage({ type: "removeTrack", trackId } satisfies EngineCommand);
  }

  // ----- FX inserts -----
  //
  // Each helper waits for the worker to ACK with the assigned fx id so the
  // caller can later remove the FX without bookkeeping per-call ids itself.

  async addEq(opts: {
    trackId: number;
    freq: number;
    q: number;
    gainDb: number;
    kind: "peak" | "low_shelf" | "high_shelf" | "lowpass" | "highpass";
  }): Promise<number> {
    const ev = await this.request<Extract<EngineEvent, { type: "fxAdded" }>>((id) => ({
      type: "addEq",
      trackId: opts.trackId,
      freq: opts.freq,
      q: opts.q,
      gainDb: opts.gainDb,
      kind: opts.kind,
      requestId: id,
    }));
    return ev.fxId;
  }

  async addCompressor(opts: {
    trackId: number;
    thresholdDb: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
    makeupDb: number;
  }): Promise<number> {
    const ev = await this.request<Extract<EngineEvent, { type: "fxAdded" }>>((id) => ({
      type: "addCompressor",
      trackId: opts.trackId,
      thresholdDb: opts.thresholdDb,
      ratio: opts.ratio,
      attackMs: opts.attackMs,
      releaseMs: opts.releaseMs,
      makeupDb: opts.makeupDb,
      requestId: id,
    }));
    return ev.fxId;
  }

  async addDelay(opts: {
    trackId: number;
    beats: number;
    feedback: number;
    wet: number;
    pingPong: number;
  }): Promise<number> {
    const ev = await this.request<Extract<EngineEvent, { type: "fxAdded" }>>((id) => ({
      type: "addDelay",
      trackId: opts.trackId,
      beats: opts.beats,
      feedback: opts.feedback,
      wet: opts.wet,
      pingPong: opts.pingPong,
      requestId: id,
    }));
    return ev.fxId;
  }

  removeFx(trackId: number, fxId: number) {
    this.worker.postMessage({ type: "removeFx", trackId, fxId } satisfies EngineCommand);
  }

  /** Add a sidechain compressor on `targetTrackId` whose detector reads
   *  from `sourceTrackId`. Classic kick→bass pump. */
  async addSidechainCompressor(opts: {
    targetTrackId: number;
    sourceTrackId: number;
    thresholdDb: number;
    ratio: number;
    attackMs: number;
    releaseMs: number;
    makeupDb: number;
  }): Promise<number> {
    const ev = await this.request<Extract<EngineEvent, { type: "fxAdded" }>>((id) => ({
      type: "addSidechainCompressor",
      targetTrackId: opts.targetTrackId,
      sourceTrackId: opts.sourceTrackId,
      thresholdDb: opts.thresholdDb,
      ratio: opts.ratio,
      attackMs: opts.attackMs,
      releaseMs: opts.releaseMs,
      makeupDb: opts.makeupDb,
      requestId: id,
    }));
    return ev.fxId;
  }

  /** Render `frameCount` frames straight-through into a stereo-interleaved
   *  Float32Array. Pauses realtime playback for the duration of the render
   *  and restores transport position afterward. */
  async renderOffline(
    frameCount: number,
  ): Promise<{ interleaved: Float32Array; sampleRate: number; frameCount: number }> {
    const ev = await this.request<Extract<EngineEvent, { type: "renderedOffline" }>>((id) => ({
      type: "renderOffline",
      frameCount,
      requestId: id,
    }));
    return {
      interleaved: ev.interleaved,
      sampleRate: ev.sampleRate,
      frameCount: ev.frameCount,
    };
  }

  play() {
    this.worker.postMessage({ type: "play" } satisfies EngineCommand);
  }
  stop() {
    this.worker.postMessage({ type: "stop" } satisfies EngineCommand);
  }
  setBpm(bpm: number) {
    this.worker.postMessage({ type: "setBpm", bpm } satisfies EngineCommand);
  }
  setLoop(start: number, end: number) {
    this.worker.postMessage({ type: "setLoop", start, end } satisfies EngineCommand);
  }
  clearLoop() {
    this.worker.postMessage({ type: "clearLoop" } satisfies EngineCommand);
  }
  setPosition(frame: number) {
    this.worker.postMessage({ type: "setPosition", frame } satisfies EngineCommand);
  }
  setTrackGain(trackId: number, gain: number) {
    this.worker.postMessage({ type: "setTrackGain", trackId, gain } satisfies EngineCommand);
  }
  setTrackPan(trackId: number, pan: number) {
    this.worker.postMessage({ type: "setTrackPan", trackId, pan } satisfies EngineCommand);
  }
  setTrackMute(trackId: number, mute: boolean) {
    this.worker.postMessage({ type: "setTrackMute", trackId, mute } satisfies EngineCommand);
  }
  setTrackSolo(trackId: number, solo: boolean) {
    this.worker.postMessage({ type: "setTrackSolo", trackId, solo } satisfies EngineCommand);
  }

  dispose() {
    this.worklet?.disconnect();
    this.worker.terminate();
    this.ctx.close();
  }
}

let _instance: AudioController | null = null;
/** Lazy global controller. Created on first call. */
export function getController(): AudioController {
  if (!_instance) _instance = new AudioController();
  return _instance;
}
