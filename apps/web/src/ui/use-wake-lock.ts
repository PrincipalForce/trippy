// Screen Wake Lock: keep the display awake while the DAW is open.
//
// Why this matters here, not for a generic web app: even when audio is
// playing the OS dims and sleeps the screen after the inactivity timeout,
// because the timeout is gated on *touch* input, not on audio output. For
// a DAW that means the user puts the phone down to listen to a 2-minute
// loop, the screen sleeps after 30 seconds, and they lose the timeline.
//
// The API: `navigator.wakeLock.request("screen")` returns a sentinel that
// holds the lock until either:
//   1. `.release()` is called explicitly, or
//   2. the document becomes hidden (tab switch, app backgrounded). The
//      browser auto-releases — we re-acquire on `visibilitychange`.
//
// Availability: Chrome / Edge / Firefox on Android, Safari on iOS 16.4+.
// On older Safari `navigator.wakeLock` is undefined; we silently no-op.

import { createSignal, onCleanup, onMount } from "solid-js";

interface WakeLockSentinelLike {
  release: () => Promise<void>;
  addEventListener: (
    type: "release",
    listener: () => void,
    options?: AddEventListenerOptions,
  ) => void;
}

interface WakeLockApi {
  request: (type: "screen") => Promise<WakeLockSentinelLike>;
}

function wakeLockApi(): WakeLockApi | null {
  const nav = navigator as Navigator & { wakeLock?: WakeLockApi };
  return nav.wakeLock ?? null;
}

export function useWakeLock() {
  const [active, setActive] = createSignal(false);
  const [supported] = createSignal(wakeLockApi() !== null);
  let sentinel: WakeLockSentinelLike | null = null;

  async function acquire() {
    const api = wakeLockApi();
    if (!api) return;
    if (sentinel) return; // already held
    try {
      const s = await api.request("screen");
      sentinel = s;
      setActive(true);
      // The browser fires `release` when it auto-drops the lock on hide,
      // low battery, etc. Mirror that into our state so the UI matches.
      s.addEventListener("release", () => {
        sentinel = null;
        setActive(false);
      });
    } catch {
      // Permission denied / low battery / no power — don't surface; the
      // user can't act on this and the rest of the app works fine.
    }
  }

  function release() {
    if (sentinel) {
      void sentinel.release().catch(() => {});
      sentinel = null;
      setActive(false);
    }
  }

  function onVisibility() {
    if (document.visibilityState === "visible") void acquire();
  }

  onMount(() => {
    void acquire();
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => {
      document.removeEventListener("visibilitychange", onVisibility);
      release();
    });
  });

  return { active, supported };
}
