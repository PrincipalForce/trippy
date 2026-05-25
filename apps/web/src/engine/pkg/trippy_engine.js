/* @ts-self-types="./trippy_engine.d.ts" */

/**
 * Opaque engine handle.
 */
export class WasmEngine {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        WasmEngineFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_wasmengine_free(ptr, 0);
    }
    /**
     * Add a clip. Pass `length_frames = 0` to use the full remaining source length.
     * @param {number} track_id
     * @param {number} source_id
     * @param {bigint} start_frame
     * @param {bigint} length_frames
     * @param {bigint} offset_in_source
     * @returns {number}
     */
    addClip(track_id, source_id, start_frame, length_frames, offset_in_source) {
        const ret = wasm.wasmengine_addClip(this.__wbg_ptr, track_id, source_id, start_frame, length_frames, offset_in_source);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add an interleaved audio source (mono or stereo). Returns the source id.
     * @param {number} sample_rate
     * @param {number} channels
     * @param {Float32Array} interleaved
     * @returns {number}
     */
    addSource(sample_rate, channels, interleaved) {
        const ptr0 = passArrayF32ToWasm0(interleaved, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_addSource(this.__wbg_ptr, sample_rate, channels, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add a source by decoding a RIFF/WAVE byte buffer.
     * Returns `{ sourceId, sampleRate, channels, frameCount }` as a JSON string.
     * @param {Uint8Array} bytes
     * @returns {string}
     */
    addSourceFromWav(bytes) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.wasmengine_addSourceFromWav(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * Add a new track. Returns the track id.
     * @returns {number}
     */
    addTrack() {
        const ret = wasm.wasmengine_addTrack(this.__wbg_ptr);
        return ret >>> 0;
    }
    clearLoop() {
        wasm.wasmengine_clearLoop(this.__wbg_ptr);
    }
    /**
     * @returns {boolean}
     */
    isPlaying() {
        const ret = wasm.wasmengine_isPlaying(this.__wbg_ptr);
        return ret !== 0;
    }
    /**
     * Construct a new engine for the given output sample rate (Hz).
     * @param {number} sample_rate
     */
    constructor(sample_rate) {
        const ret = wasm.wasmengine_new(sample_rate);
        this.__wbg_ptr = ret;
        WasmEngineFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    play() {
        wasm.wasmengine_play(this.__wbg_ptr);
    }
    /**
     * @returns {number}
     */
    positionFrames() {
        const ret = wasm.wasmengine_positionFrames(this.__wbg_ptr);
        return ret;
    }
    /**
     * Render `out_l.len()` frames of stereo audio. `out_r.len()` must match.
     *
     * The two slices alias JS `Float32Array` memory; mutations are visible
     * to JS without a copy. Allocation-free hot path.
     * @param {Float32Array} out_l
     * @param {Float32Array} out_r
     */
    process(out_l, out_r) {
        var ptr0 = passArrayF32ToWasm0(out_l, wasm.__wbindgen_malloc);
        var len0 = WASM_VECTOR_LEN;
        var ptr1 = passArrayF32ToWasm0(out_r, wasm.__wbindgen_malloc);
        var len1 = WASM_VECTOR_LEN;
        const ret = wasm.wasmengine_process(this.__wbg_ptr, ptr0, len0, out_l, ptr1, len1, out_r);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} track_id
     * @param {number} clip_id
     * @returns {boolean}
     */
    removeClip(track_id, clip_id) {
        const ret = wasm.wasmengine_removeClip(this.__wbg_ptr, track_id, clip_id);
        return ret !== 0;
    }
    /**
     * @param {number} source_id
     * @returns {boolean}
     */
    removeSource(source_id) {
        const ret = wasm.wasmengine_removeSource(this.__wbg_ptr, source_id);
        return ret !== 0;
    }
    /**
     * @param {number} track_id
     * @returns {boolean}
     */
    removeTrack(track_id) {
        const ret = wasm.wasmengine_removeTrack(this.__wbg_ptr, track_id);
        return ret !== 0;
    }
    /**
     * @returns {number}
     */
    sampleRate() {
        const ret = wasm.wasmengine_sampleRate(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} bpm
     */
    setBpm(bpm) {
        wasm.wasmengine_setBpm(this.__wbg_ptr, bpm);
    }
    /**
     * @param {number} start
     * @param {number} end
     */
    setLoop(start, end) {
        wasm.wasmengine_setLoop(this.__wbg_ptr, start, end);
    }
    /**
     * @param {number} frame
     */
    setPosition(frame) {
        wasm.wasmengine_setPosition(this.__wbg_ptr, frame);
    }
    /**
     * @param {number} track_id
     * @param {number} gain
     * @returns {boolean}
     */
    setTrackGain(track_id, gain) {
        const ret = wasm.wasmengine_setTrackGain(this.__wbg_ptr, track_id, gain);
        return ret !== 0;
    }
    /**
     * @param {number} track_id
     * @param {boolean} mute
     * @returns {boolean}
     */
    setTrackMute(track_id, mute) {
        const ret = wasm.wasmengine_setTrackMute(this.__wbg_ptr, track_id, mute);
        return ret !== 0;
    }
    /**
     * @param {number} track_id
     * @param {number} pan
     * @returns {boolean}
     */
    setTrackPan(track_id, pan) {
        const ret = wasm.wasmengine_setTrackPan(this.__wbg_ptr, track_id, pan);
        return ret !== 0;
    }
    /**
     * @param {number} track_id
     * @param {boolean} solo
     * @returns {boolean}
     */
    setTrackSolo(track_id, solo) {
        const ret = wasm.wasmengine_setTrackSolo(this.__wbg_ptr, track_id, solo);
        return ret !== 0;
    }
    stop() {
        wasm.wasmengine_stop(this.__wbg_ptr);
    }
}
if (Symbol.dispose) WasmEngine.prototype[Symbol.dispose] = WasmEngine.prototype.free;

/**
 * Installs a panic hook that forwards Rust panics to `console.error`.
 */
export function _start() {
    wasm._start();
}

/**
 * Smoke-test entry point: returns the engine version string so the web app
 * can confirm the wasm module loaded and is callable.
 * @returns {string}
 */
export function engine_version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.engine_version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_ef53bc310eb298a0: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_copy_to_typed_array_7a3f7b938f93cf12: function(arg0, arg1, arg2) {
            new Uint8Array(arg2.buffer, arg2.byteOffset, arg2.byteLength).set(getArrayU8FromWasm0(arg0, arg1));
        },
        __wbg___wbindgen_throw_1506f2235d1bdba0: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./trippy_engine_bg.js": import0,
    };
}

const WasmEngineFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_wasmengine_free(ptr, 1));

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('trippy_engine_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
