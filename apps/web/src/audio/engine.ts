// Re-export the M1 controller API. The engine is no longer loaded directly
// on the main thread — it runs inside `engine-worker.ts`. UI code uses
// `getController()` to drive playback.

export { AudioController, getController } from "./controller";
export type { LoadedSource, TransportState, ControllerOptions } from "./controller";
