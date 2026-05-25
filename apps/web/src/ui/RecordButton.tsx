// In-app mic recorder.
//
// Uses MediaRecorder (supported in iOS Safari 14.3+ and every modern desktop
// browser) to capture from getUserMedia. On stop we hand the resulting Blob
// back as a synthetic `File`, so the caller can run it through the same
// decode → re-encode → engine path that handles regular file imports —
// no separate ingest pipeline needed.
//
// Output codec depends on the browser: typically opus-in-webm on Chrome /
// Firefox / Android, AAC-in-mp4 on iOS Safari. AudioContext.decodeAudioData
// understands both, so downstream code doesn't have to care.

import { createSignal, onCleanup, Show } from "solid-js";

export interface RecordButtonProps {
  /** Called once when the recording is finalized, with a synthetic File. */
  onRecording: (file: File) => void;
  /** Surfaced to the parent; lets the error banner display permission failures. */
  onError?: (message: string) => void;
  disabled?: boolean;
}

const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

function pickSupportedMime(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  for (const m of MIME_CANDIDATES) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return undefined;
}

function extForMime(mime: string): string {
  if (mime.includes("webm")) return "webm";
  if (mime.includes("mp4")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "bin";
}

export function RecordButton(props: RecordButtonProps) {
  const [recording, setRecording] = createSignal(false);
  const [seconds, setSeconds] = createSignal(0);

  let mediaRecorder: MediaRecorder | null = null;
  let stream: MediaStream | null = null;
  let chunks: BlobPart[] = [];
  let timer: ReturnType<typeof setInterval> | null = null;
  let startedAt = 0;

  function teardown() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    mediaRecorder = null;
    chunks = [];
    setRecording(false);
    setSeconds(0);
  }

  onCleanup(teardown);

  async function start() {
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      props.onError?.("This browser doesn't expose microphone access.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      props.onError?.("This browser doesn't support MediaRecorder.");
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      const mime = pickSupportedMime();
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.onerror = (e) => {
        const err = (e as Event & { error?: Error }).error;
        props.onError?.(`record: ${err?.message ?? "unknown error"}`);
        teardown();
      };
      mediaRecorder.onstop = () => {
        const blobType = mediaRecorder?.mimeType || mime || "audio/webm";
        const blob = new Blob(chunks, { type: blobType });
        const ext = extForMime(blobType);
        const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const file = new File([blob], `recording-${ts}.${ext}`, { type: blobType });
        teardown();
        if (blob.size > 0) props.onRecording(file);
      };

      // Slice the stream into 250ms chunks so a crash mid-recording loses
      // only the tail.
      mediaRecorder.start(250);
      startedAt = Date.now();
      setRecording(true);
      timer = setInterval(() => setSeconds((Date.now() - startedAt) / 1000), 100);
    } catch (err) {
      teardown();
      const msg = err instanceof Error ? err.message : String(err);
      // Most common case: user denied the permission prompt.
      props.onError?.(
        /denied|not allowed/i.test(msg)
          ? "Microphone permission denied."
          : `Could not start recording: ${msg}`,
      );
    }
  }

  function stop() {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    } else {
      teardown();
    }
  }

  function toggle() {
    if (recording()) stop();
    else void start();
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={props.disabled && !recording()}
      title={recording() ? "Stop recording" : "Record from mic"}
      style={{
        "min-width": "92px",
        "border-color": recording() ? "#ff4d6d" : "var(--accent-dim)",
        background: recording() ? "#3a1020" : "transparent",
        color: recording() ? "#ffb8c5" : "var(--fg)",
        "font-variant-numeric": "tabular-nums",
      }}
    >
      <Show when={recording()} fallback={<span>● rec</span>}>
        <span>■ {seconds().toFixed(1)}s</span>
      </Show>
    </button>
  );
}
