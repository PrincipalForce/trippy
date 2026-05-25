// Stem separation via Demucs-class ONNX models, executed on-device via
// ONNX Runtime Web with the WebGPU backend (falling back to WASM).
//
// **Status:** stubbed for M7.5. Wiring steps once the model lands:
//
// 1. Download `htdemucs-distilled.onnx` (~150 MB) on first invocation; cache
//    in OPFS keyed by sha-256.
// 2. Pre-process: resample input to model rate (44.1k), split into overlapping
//    chunks, normalize, batch.
// 3. Run inference per chunk on a Worker so the UI stays responsive.
// 4. Post-process: window-overlap-add chunks back together, denormalize,
//    resample to project rate, write four new `AudioSource`s ("drums",
//    "bass", "vocals", "other").
// 5. Return them through the AI job queue as `AiJobOutput.sources` for the
//    UI to spawn as preview tracks.

export interface StemSeparationResult {
  drums: ArrayBuffer;
  bass: ArrayBuffer;
  vocals: ArrayBuffer;
  other: ArrayBuffer;
  sampleRate: number;
  channels: number;
}

export async function separateStems(
  _bytes: ArrayBuffer,
  _progress: (p: number) => void,
): Promise<StemSeparationResult> {
  throw new Error(
    "stem separation model not yet bundled — see apps/web/src/ai/stems.ts header",
  );
}
