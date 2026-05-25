// AudioWorkletProcessor that drains a SAB ring filled by the engine worker.
//
// Built by Vite as a separate worklet bundle. The processor receives the SAB
// handle via the worklet `processorOptions` and reads frames per `process()`
// call (typically 128 frames per quantum). If the ring underruns, it emits
// silence — never blocks the audio thread.

import {
  attachRingBuffer,
  readFramesDeinterleaved,
  availableRead,
  type RingBuffer,
} from "./ringbuffer";

// AudioWorkletGlobalScope ambient declarations.
declare const sampleRate: number;
declare const currentFrame: number;
declare class AudioWorkletProcessor {
  port: MessagePort;
  constructor();
}
declare function registerProcessor(
  name: string,
  processor: new (options?: any) => AudioWorkletProcessor,
): void;

interface WorkletInit {
  ringSab: SharedArrayBuffer;
}

class TrippyOutputProcessor extends AudioWorkletProcessor {
  private rb: RingBuffer | null = null;
  private underruns = 0;
  private lastReportFrame = 0;

  constructor(options: { processorOptions: WorkletInit }) {
    super();
    if (options?.processorOptions?.ringSab) {
      this.rb = attachRingBuffer(options.processorOptions.ringSab);
    }
    this.port.onmessage = (e: MessageEvent) => {
      if (e.data?.type === "attach" && e.data.ringSab) {
        this.rb = attachRingBuffer(e.data.ringSab);
      }
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const outL = output[0]!;
    const outR = output[1] ?? outL;
    const frames = outL.length;

    if (!this.rb) {
      outL.fill(0);
      if (output[1]) output[1].fill(0);
      return true;
    }

    const got = readFramesDeinterleaved(this.rb, outL, outR, frames);
    if (got < frames) {
      // Underrun: fill the tail with silence. Don't block.
      outL.fill(0, got);
      if (output[1]) output[1].fill(0, got);
      this.underruns++;
      // Report at most once per second to avoid flooding the main thread.
      if (currentFrame - this.lastReportFrame > sampleRate) {
        this.port.postMessage({
          type: "underrun",
          count: this.underruns,
          available: availableRead(this.rb),
        });
        this.lastReportFrame = currentFrame;
      }
    }
    return true;
  }
}

registerProcessor("trippy-output", TrippyOutputProcessor);
