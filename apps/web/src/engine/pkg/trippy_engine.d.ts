/* tslint:disable */
/* eslint-disable */

/**
 * Opaque engine handle.
 */
export class WasmEngine {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Add a clip. Pass `length_frames = 0` to use the full remaining source length.
     */
    addClip(track_id: number, source_id: number, start_frame: bigint, length_frames: bigint, offset_in_source: bigint): number;
    /**
     * Add an interleaved audio source (mono or stereo). Returns the source id.
     */
    addSource(sample_rate: number, channels: number, interleaved: Float32Array): number;
    /**
     * Add a source by decoding a RIFF/WAVE byte buffer.
     * Returns `{ sourceId, sampleRate, channels, frameCount }` as a JSON string.
     */
    addSourceFromWav(bytes: Uint8Array): string;
    /**
     * Add a new track. Returns the track id.
     */
    addTrack(): number;
    clearLoop(): void;
    isPlaying(): boolean;
    /**
     * Construct a new engine for the given output sample rate (Hz).
     */
    constructor(sample_rate: number);
    play(): void;
    positionFrames(): number;
    /**
     * Render `out_l.len()` frames of stereo audio. `out_r.len()` must match.
     *
     * The two slices alias JS `Float32Array` memory; mutations are visible
     * to JS without a copy. Allocation-free hot path.
     */
    process(out_l: Float32Array, out_r: Float32Array): void;
    removeClip(track_id: number, clip_id: number): boolean;
    removeSource(source_id: number): boolean;
    removeTrack(track_id: number): boolean;
    sampleRate(): number;
    setBpm(bpm: number): void;
    setLoop(start: number, end: number): void;
    setPosition(frame: number): void;
    setTrackGain(track_id: number, gain: number): boolean;
    setTrackMute(track_id: number, mute: boolean): boolean;
    setTrackPan(track_id: number, pan: number): boolean;
    setTrackSolo(track_id: number, solo: boolean): boolean;
    stop(): void;
}

/**
 * Installs a panic hook that forwards Rust panics to `console.error`.
 */
export function _start(): void;

/**
 * Smoke-test entry point: returns the engine version string so the web app
 * can confirm the wasm module loaded and is callable.
 */
export function engine_version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_wasmengine_free: (a: number, b: number) => void;
    readonly _start: () => void;
    readonly engine_version: () => [number, number];
    readonly wasmengine_addClip: (a: number, b: number, c: number, d: bigint, e: bigint, f: bigint) => [number, number, number];
    readonly wasmengine_addSource: (a: number, b: number, c: number, d: number, e: number) => [number, number, number];
    readonly wasmengine_addSourceFromWav: (a: number, b: number, c: number) => [number, number, number, number];
    readonly wasmengine_addTrack: (a: number) => number;
    readonly wasmengine_clearLoop: (a: number) => void;
    readonly wasmengine_isPlaying: (a: number) => number;
    readonly wasmengine_new: (a: number) => number;
    readonly wasmengine_play: (a: number) => void;
    readonly wasmengine_positionFrames: (a: number) => number;
    readonly wasmengine_process: (a: number, b: number, c: number, d: any, e: number, f: number, g: any) => [number, number];
    readonly wasmengine_removeClip: (a: number, b: number, c: number) => number;
    readonly wasmengine_removeSource: (a: number, b: number) => number;
    readonly wasmengine_removeTrack: (a: number, b: number) => number;
    readonly wasmengine_sampleRate: (a: number) => number;
    readonly wasmengine_setBpm: (a: number, b: number) => void;
    readonly wasmengine_setLoop: (a: number, b: number, c: number) => void;
    readonly wasmengine_setPosition: (a: number, b: number) => void;
    readonly wasmengine_setTrackGain: (a: number, b: number, c: number) => number;
    readonly wasmengine_setTrackMute: (a: number, b: number, c: number) => number;
    readonly wasmengine_setTrackPan: (a: number, b: number, c: number) => number;
    readonly wasmengine_setTrackSolo: (a: number, b: number, c: number) => number;
    readonly wasmengine_stop: (a: number) => void;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
