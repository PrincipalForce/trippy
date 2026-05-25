// WAM 2.0 (Web Audio Modules) plugin host.
//
// WAM 2.0 (https://www.webaudiomodules.com/) is the de-facto standard for
// browser-native audio plugins: each plugin is an ESM that exports a factory
// returning a `WebAudioModule` instance, which spawns an `AudioWorkletNode`
// for DSP and an HTMLElement for UI.
//
// Why WAM first (not VST3/AU/CLAP):
//   - Runs in the browser today, no native bridge required
//   - Ecosystem includes ports of common synths/effects (Surge, Dexed, etc.)
//   - Same architecture works in Tauri desktop builds
// CLAP/VST3/AU come later through native bridges in the Tauri / Capacitor
// shells.
//
// **Status:** scaffolding. The real plugin discovery + instantiation lands
// once we have at least one bundled WAM plugin in `apps/web/public/plugins/`.

export interface WamPluginDescriptor {
  id: string;
  /** URL of the plugin's `index.js` (ESM entry). */
  url: string;
  name: string;
  vendor: string;
  /** `audio_effect` or `audio_generator`. */
  kind: "audio_effect" | "audio_generator";
  /** Self-reported version. */
  version: string;
}

export interface WamInstance {
  descriptor: WamPluginDescriptor;
  /** The plugin's processing node — connect to the graph as you would any AudioNode. */
  node: AudioNode;
  /** Optional UI element rendered into a host container. */
  ui: HTMLElement | null;
  destroy(): void;
}

/**
 * Discover plugins from a manifest at `/plugins/index.json`.
 * The manifest format is just `WamPluginDescriptor[]`.
 */
export async function discoverPlugins(): Promise<WamPluginDescriptor[]> {
  try {
    const res = await fetch("/plugins/index.json");
    if (!res.ok) return [];
    return (await res.json()) as WamPluginDescriptor[];
  } catch {
    return [];
  }
}

/**
 * Instantiate a WAM plugin into the given AudioContext.
 *
 * Throws until we ship at least one bundled plugin and the loader is hooked up.
 */
export async function instantiatePlugin(
  _ctx: BaseAudioContext,
  _descriptor: WamPluginDescriptor,
): Promise<WamInstance> {
  throw new Error("WAM plugin host not yet wired (M9 work)");
}
