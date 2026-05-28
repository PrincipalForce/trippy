// Multi-track timeline with Canvas2D-rendered waveforms and pinch/wheel zoom.
//
// Interaction model:
//   - Touch/pointer on a clip → select it; subsequent drag moves the clip
//     (horizontally along time, vertically across track lanes).
//   - Touch/pointer on a clip's left or right edge (within `EDGE_HIT_PX`) →
//     trim that edge instead of moving. Trim keeps the audio that remains
//     in-sync by adjusting offsetInSource for the head, only lengthFrames
//     for the tail.
//   - Touch/pointer on empty lane background → one-finger pan, two-finger
//     pinch-zoom. Tapping the ruler seeks.
//   - Long-press on a clip (500ms with <8px of motion) → fires
//     `onClipLongPress` so the parent can pop an action menu.
//
// Engine sync is left to the parent — we only emit a single `onClipChange`
// once the gesture ends. Mid-gesture the clip is rendered against a local
// `pendingTransform` so audio doesn't get torn down on every pointer move.

import { createEffect, onCleanup, onMount } from "solid-js";
import type { ProjectFile, TrackSnapshot, ClipSnapshot, SourceMeta } from "@trippy/format";
import { chooseLevel, type Waveform } from "../../audio/waveform-cache";

export interface ClipRef {
  trackId: number;
  clipId: number;
}

export interface ClipPatch {
  startFrame?: number;
  lengthFrames?: number;
  offsetInSource?: number;
  /** Destination trackId if the clip was dragged across lanes. */
  trackId?: number;
}

export type TimelineMode = "move" | "slice" | "erase";

export interface TimelineProps {
  project: ProjectFile;
  waveforms: Map<number, Waveform>;
  positionFrames: number;
  selected?: ClipRef | null;
  selectedTrack?: number | null;
  mode?: TimelineMode;
  initialZoom?: number;
  onSeek?: (frame: number) => void;
  onSelectClip?: (ref: ClipRef | null) => void;
  onSelectTrack?: (trackId: number | null) => void;
  /** Commit a finished move/trim/lane-swap gesture. */
  onClipChange?: (ref: ClipRef, patch: ClipPatch) => void;
  /** User held a clip — parent should surface an action menu. `clientX/Y`
   *  are screen-space anchor coords for positioning a popover. */
  onClipLongPress?: (ref: ClipRef, clientX: number, clientY: number) => void;
  /** Slice-mode hit: split the clip at the given project-frame. */
  onClipSlice?: (ref: ClipRef, frame: number) => void;
  /** Erase-mode hit: delete the clip. */
  onClipErase?: (ref: ClipRef) => void;
}

const TRACK_HEIGHT = 80;
const RULER_HEIGHT = 28;
const MIN_FPP = 8;
const MAX_FPP = 100_000;
const EDGE_HIT_PX = 14; // touch-friendly trim handle
const LONG_PRESS_MS = 500;
const LONG_PRESS_SLOP_PX = 8;
const MIN_CLIP_FRAMES = 64; // refuse to trim a clip below this

type GestureMode =
  | { kind: "none" }
  | { kind: "pan"; startX: number; startPan: number }
  | { kind: "pinch"; startDist: number; startFpp: number; centerFrame: number }
  | {
      kind: "move";
      ref: ClipRef;
      grabFrameOffset: number; // pointer's frame minus clip.startFrame at grab
      grabLaneIndex: number;
      pointerStartX: number;
      pointerStartY: number;
      moved: boolean;
    }
  | {
      kind: "trim";
      ref: ClipRef;
      edge: "left" | "right";
      origStart: number;
      origLength: number;
      origOffset: number;
      pointerStartX: number;
      moved: boolean;
    };

interface PendingTransform {
  trackId: number;
  clipId: number;
  startFrame: number;
  lengthFrames: number;
  offsetInSource: number;
  laneIndex: number;
}

export function Timeline(props: TimelineProps) {
  let canvas: HTMLCanvasElement | undefined;
  let framesPerPixel = props.initialZoom ?? 1024;
  let panFrames = 0;

  let gesture: GestureMode = { kind: "none" };
  let pending: PendingTransform | null = null;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  const activeTouches = new Map<number, { x: number; y: number }>();

  function frameToX(frame: number): number {
    return (frame - panFrames) / framesPerPixel;
  }
  function xToFrame(x: number): number {
    return panFrames + x * framesPerPixel;
  }
  function yToLane(y: number): number {
    if (y < RULER_HEIGHT) return -1;
    return Math.floor((y - RULER_HEIGHT) / TRACK_HEIGHT);
  }

  // Beat-grid step in frames, matching the visible ruler subdivision.
  function gridStepFrames(): number {
    const sr = props.project.transport.sampleRate;
    const fpb = (60 / props.project.transport.bpm) * sr;
    let sub = 1;
    while ((fpb * sub) / framesPerPixel < 24) sub *= 2;
    return fpb * sub;
  }

  function snap(frame: number): number {
    const step = gridStepFrames();
    if (step <= 0) return Math.max(0, Math.round(frame));
    return Math.max(0, Math.round(frame / step) * step);
  }

  // Resolve a clip's rendered geometry, honoring any in-flight pending
  // transform so dragging shows movement immediately.
  function effectiveClip(
    trackId: number,
    clip: ClipSnapshot,
  ): { startFrame: number; lengthFrames: number; offsetInSource: number; laneIndex: number } {
    if (
      pending &&
      pending.trackId === trackId &&
      pending.clipId === clip.id
    ) {
      return {
        startFrame: pending.startFrame,
        lengthFrames: pending.lengthFrames,
        offsetInSource: pending.offsetInSource,
        laneIndex: pending.laneIndex,
      };
    }
    const laneIndex = props.project.tracks.findIndex((t) => t.id === trackId);
    return {
      startFrame: clip.startFrame,
      lengthFrames: clip.lengthFrames,
      offsetInSource: clip.offsetInSource,
      laneIndex: Math.max(0, laneIndex),
    };
  }

  function hitTestClip(
    x: number,
    y: number,
  ): { ref: ClipRef; clip: ClipSnapshot; edge: "left" | "right" | null } | null {
    const lane = yToLane(y);
    if (lane < 0) return null;
    const frame = xToFrame(x);
    // Walk all tracks/clips and prefer the lane match, but also accept a
    // dragged clip whose pending lane is `lane`.
    for (let ti = 0; ti < props.project.tracks.length; ti++) {
      const t = props.project.tracks[ti]!;
      for (const c of t.clips) {
        const eff = effectiveClip(t.id, c);
        if (eff.laneIndex !== lane) continue;
        const start = eff.startFrame;
        const end = start + eff.lengthFrames;
        if (frame < start || frame > end) continue;
        const xStart = frameToX(start);
        const xEnd = frameToX(end);
        let edge: "left" | "right" | null = null;
        if (x - xStart < EDGE_HIT_PX) edge = "left";
        else if (xEnd - x < EDGE_HIT_PX) edge = "right";
        return { ref: { trackId: t.id, clipId: c.id }, clip: c, edge };
      }
    }
    return null;
  }

  // ─── Rendering ────────────────────────────────────────────────────────

  function draw() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (canvas.width !== cssW * dpr) canvas.width = cssW * dpr;
    if (canvas.height !== cssH * dpr) canvas.height = cssH * dpr;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#0a0a0f";
    ctx.fillRect(0, 0, cssW, cssH);

    drawRuler(ctx, cssW, props.project.transport.sampleRate, props.project.transport.bpm);
    drawTracks(ctx, cssW, cssH);
    drawPlayhead(ctx, cssW, cssH);
  }

  function drawRuler(ctx: CanvasRenderingContext2D, w: number, sr: number, bpm: number) {
    ctx.fillStyle = "#14141c";
    ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.strokeStyle = "#1e1e2a";
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(w, RULER_HEIGHT - 0.5);
    ctx.stroke();

    const fpb = (60 / bpm) * sr;
    let sub = 1;
    while ((fpb * sub) / framesPerPixel < 24) sub *= 2;
    const stepFrames = fpb * sub;

    const first = Math.floor(panFrames / stepFrames);
    const last = Math.ceil((panFrames + w * framesPerPixel) / stepFrames);

    ctx.font = "11px ui-monospace, SF Mono, Menlo, monospace";
    ctx.fillStyle = "#8a8aa0";
    ctx.textBaseline = "middle";
    for (let b = first; b <= last; b++) {
      const f = b * stepFrames;
      const x = frameToX(f);
      ctx.strokeStyle = b % 4 === 0 ? "#3a3a55" : "#1e1e2a";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, RULER_HEIGHT);
      ctx.stroke();
      if (b % 4 === 0) {
        const bar = Math.floor(b * sub) / 4 + 1;
        ctx.fillText(`${bar.toFixed(0)}`, x + 4, RULER_HEIGHT / 2);
      }
    }
  }

  function drawTracks(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const tracks = props.project.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const y = RULER_HEIGHT + i * TRACK_HEIGHT;
      if (y >= h) break;
      const isTrackSelected = props.selectedTrack === tracks[i]!.id;
      ctx.fillStyle = isTrackSelected
        ? "#181830"
        : i % 2 === 0
          ? "#0d0d14"
          : "#101019";
      ctx.fillRect(0, y, w, TRACK_HEIGHT);
      drawTrackGrid(ctx, w, y);
    }
    // Render clips in a second pass so a dragged clip lands on the lane
    // matching its pending laneIndex (which may differ from its track index).
    for (const t of tracks) {
      for (const c of t.clips) {
        drawClip(ctx, w, t, c);
      }
    }
  }

  function drawTrackGrid(ctx: CanvasRenderingContext2D, w: number, y: number) {
    const stepFrames = gridStepFrames();
    const first = Math.floor(panFrames / stepFrames);
    const last = Math.ceil((panFrames + w * framesPerPixel) / stepFrames);
    ctx.strokeStyle = "#15151f";
    for (let b = first; b <= last; b++) {
      const x = frameToX(b * stepFrames);
      ctx.beginPath();
      ctx.moveTo(x + 0.5, y);
      ctx.lineTo(x + 0.5, y + TRACK_HEIGHT);
      ctx.stroke();
    }
  }

  function drawClip(
    ctx: CanvasRenderingContext2D,
    canvasW: number,
    track: TrackSnapshot,
    clip: ClipSnapshot,
  ) {
    const eff = effectiveClip(track.id, clip);
    const y = RULER_HEIGHT + eff.laneIndex * TRACK_HEIGHT;
    const x1 = frameToX(eff.startFrame);
    const x2 = frameToX(eff.startFrame + eff.lengthFrames);
    const left = Math.max(-1, x1);
    const right = Math.min(canvasW + 1, x2);
    if (right <= left) return;
    const w = right - left;
    const top = y + 2;
    const h = TRACK_HEIGHT - 4;

    const isSelected =
      props.selected?.trackId === track.id && props.selected?.clipId === clip.id;

    const accent = track.color ?? "#7c5cff";
    ctx.save();
    ctx.fillStyle = isSelected ? hexWithAlpha(accent, 0.32) : hexWithAlpha(accent, 0.18);
    ctx.strokeStyle = isSelected ? lighten(accent) : accent;
    ctx.lineWidth = isSelected ? 2 : 1;
    roundRect(ctx, left, top, w, h, 6);
    ctx.fill();
    ctx.stroke();

    if (clip.label) {
      ctx.fillStyle = "#bdb1ff";
      ctx.font = "11px system-ui";
      ctx.textBaseline = "top";
      const labelW = w - 12;
      if (labelW > 0) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(left + 4, top + 2, labelW, 16);
        ctx.clip();
        ctx.fillText(clip.label, left + 6, top + 4);
        ctx.restore();
      }
    }

    const wf = props.waveforms.get(clip.sourceId);
    if (wf && wf.levels[0]) {
      const channelLevels = wf.levels[0]!;
      const level = chooseLevel(channelLevels, framesPerPixel);
      const peaks = level.data;
      const bucketSize = level.bucketSize;
      const yMid = top + h / 2;
      const yScale = (h / 2) * 0.92;

      ctx.strokeStyle = isSelected ? lighten(accent) : accent;
      ctx.beginPath();
      const fpp = framesPerPixel;
      const widthPx = right - left;
      for (let px = 0; px < widthPx; px++) {
        const projFrame = panFrames + (left + px) * fpp;
        const clipRel = projFrame - eff.startFrame + eff.offsetInSource;
        if (clipRel < 0) continue;
        const b = Math.floor(clipRel / bucketSize);
        if (b * 2 + 1 >= peaks.length) break;
        const mn = peaks[b * 2]!;
        const mx = peaks[b * 2 + 1]!;
        const yTop = yMid + mn * yScale;
        const yBot = yMid + mx * yScale;
        ctx.moveTo(left + px + 0.5, yTop);
        ctx.lineTo(left + px + 0.5, yBot);
      }
      ctx.stroke();
    }

    // Trim handles for the selected clip — subtle inset bars.
    if (isSelected && w > EDGE_HIT_PX * 2) {
      ctx.fillStyle = lighten(accent);
      ctx.fillRect(left + 2, top + h / 2 - 10, 3, 20);
      ctx.fillRect(right - 5, top + h / 2 - 10, 3, 20);
    }
    ctx.restore();
  }

  // Cheap hex (#rrggbb) alpha overlay — returns rgba string.
  function hexWithAlpha(hex: string, a: number): string {
    if (hex.length !== 7 || hex[0] !== "#") return hex;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  // Bias a color toward white by ~35%; used to brighten the selected clip's
  // outline so it pops against its own muted fill.
  function lighten(hex: string): string {
    if (hex.length !== 7 || hex[0] !== "#") return hex;
    const r = Math.min(255, parseInt(hex.slice(1, 3), 16) + 70);
    const g = Math.min(255, parseInt(hex.slice(3, 5), 16) + 70);
    const b = Math.min(255, parseInt(hex.slice(5, 7), 16) + 70);
    return `rgb(${r},${g},${b})`;
  }

  function drawPlayhead(ctx: CanvasRenderingContext2D, _w: number, h: number) {
    const x = frameToX(props.positionFrames);
    ctx.strokeStyle = "#ff8c5c";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, h);
    ctx.stroke();
  }

  function roundRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
  }

  function clampZoom(fpp: number): number {
    return Math.max(MIN_FPP, Math.min(MAX_FPP, fpp));
  }

  // ─── Pointer / gesture handling ──────────────────────────────────────

  function cancelLongPress() {
    if (longPressTimer) {
      clearTimeout(longPressTimer);
      longPressTimer = null;
    }
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = canvas!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (e.ctrlKey || e.metaKey) {
      const anchorFrame = xToFrame(x);
      const factor = Math.exp(e.deltaY * 0.002);
      framesPerPixel = clampZoom(framesPerPixel * factor);
      panFrames = anchorFrame - x * framesPerPixel;
    } else {
      panFrames += e.deltaX * framesPerPixel + e.deltaY * framesPerPixel;
    }
    if (panFrames < 0) panFrames = 0;
    draw();
  }

  function onPointerDown(e: PointerEvent) {
    canvas!.setPointerCapture(e.pointerId);
    activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    // Two-finger gesture upgrades to pinch regardless of what we were doing.
    if (activeTouches.size === 2) {
      cancelLongPress();
      const [a, b] = [...activeTouches.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const centerX = (a!.x + b!.x) / 2;
      const rect = canvas!.getBoundingClientRect();
      gesture = {
        kind: "pinch",
        startDist: dist,
        startFpp: framesPerPixel,
        centerFrame: xToFrame(centerX - rect.left),
      };
      pending = null;
      return;
    }

    const rect = canvas!.getBoundingClientRect();
    const localX = e.clientX - rect.left;
    const localY = e.clientY - rect.top;

    // Tap in the ruler → seek and stop. Don't start a drag.
    if (localY < RULER_HEIGHT) {
      props.onSeek?.(Math.max(0, Math.floor(xToFrame(localX))));
      gesture = { kind: "none" };
      return;
    }

    const mode: TimelineMode = props.mode ?? "move";
    const hit = hitTestClip(localX, localY);

    // Slice / Erase modes act on a clip hit immediately and stop here —
    // there's no drag follow-up.
    if (hit && mode === "slice") {
      const sliceFrame = Math.max(0, Math.floor(xToFrame(localX)));
      props.onSelectClip?.(hit.ref);
      props.onClipSlice?.(hit.ref, sliceFrame);
      gesture = { kind: "none" };
      return;
    }
    if (hit && mode === "erase") {
      props.onClipErase?.(hit.ref);
      gesture = { kind: "none" };
      return;
    }

    if (hit) {
      props.onSelectClip?.(hit.ref);
      const track = props.project.tracks.find((t) => t.id === hit.ref.trackId)!;
      const eff = effectiveClip(track.id, hit.clip);
      if (hit.edge) {
        gesture = {
          kind: "trim",
          ref: hit.ref,
          edge: hit.edge,
          origStart: eff.startFrame,
          origLength: eff.lengthFrames,
          origOffset: eff.offsetInSource,
          pointerStartX: e.clientX,
          moved: false,
        };
        pending = {
          trackId: hit.ref.trackId,
          clipId: hit.ref.clipId,
          startFrame: eff.startFrame,
          lengthFrames: eff.lengthFrames,
          offsetInSource: eff.offsetInSource,
          laneIndex: eff.laneIndex,
        };
      } else {
        const pointerFrame = xToFrame(localX);
        gesture = {
          kind: "move",
          ref: hit.ref,
          grabFrameOffset: pointerFrame - eff.startFrame,
          grabLaneIndex: eff.laneIndex,
          pointerStartX: e.clientX,
          pointerStartY: e.clientY,
          moved: false,
        };
        pending = {
          trackId: hit.ref.trackId,
          clipId: hit.ref.clipId,
          startFrame: eff.startFrame,
          lengthFrames: eff.lengthFrames,
          offsetInSource: eff.offsetInSource,
          laneIndex: eff.laneIndex,
        };
        // Arm long-press timer; it fires only if the pointer hasn't moved.
        const startX = e.clientX;
        const startY = e.clientY;
        const ref = hit.ref;
        longPressTimer = setTimeout(() => {
          longPressTimer = null;
          props.onClipLongPress?.(ref, startX, startY);
        }, LONG_PRESS_MS);
      }
      draw();
      return;
    }

    // Empty lane → select that track (if any) and arm a pan gesture.
    props.onSelectClip?.(null);
    const lane = yToLane(localY);
    const trackId = lane >= 0 ? props.project.tracks[lane]?.id ?? null : null;
    props.onSelectTrack?.(trackId);
    gesture = { kind: "pan", startX: e.clientX, startPan: panFrames };
  }

  function onPointerMove(e: PointerEvent) {
    if (!activeTouches.has(e.pointerId)) return;
    activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture.kind === "pinch" && activeTouches.size >= 2) {
      const [a, b] = [...activeTouches.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const ratio = gesture.startDist / Math.max(1, dist);
      framesPerPixel = clampZoom(gesture.startFpp * ratio);
      const centerX = (a!.x + b!.x) / 2;
      const rect = canvas!.getBoundingClientRect();
      panFrames = gesture.centerFrame - (centerX - rect.left) * framesPerPixel;
      if (panFrames < 0) panFrames = 0;
      draw();
      return;
    }

    if (gesture.kind === "pan") {
      const dx = e.clientX - gesture.startX;
      panFrames = Math.max(0, gesture.startPan - dx * framesPerPixel);
      draw();
      return;
    }

    if (gesture.kind === "move" && pending) {
      const dx = e.clientX - gesture.pointerStartX;
      const dy = e.clientY - gesture.pointerStartY;
      if (Math.hypot(dx, dy) > LONG_PRESS_SLOP_PX) cancelLongPress();
      const rect = canvas!.getBoundingClientRect();
      const localX = e.clientX - rect.left;
      const localY = e.clientY - rect.top;
      const pointerFrame = xToFrame(localX);
      let newStart = snap(pointerFrame - gesture.grabFrameOffset);
      if (newStart < 0) newStart = 0;
      const newLane = Math.max(
        0,
        Math.min(props.project.tracks.length - 1, yToLane(localY)),
      );
      pending.startFrame = newStart;
      pending.laneIndex = newLane;
      gesture.moved = gesture.moved || Math.hypot(dx, dy) > 2;
      draw();
      return;
    }

    if (gesture.kind === "trim" && pending) {
      const dx = e.clientX - gesture.pointerStartX;
      const dFrames = dx * framesPerPixel;
      if (gesture.edge === "left") {
        // Move startFrame and offsetInSource together so audio keeps
        // sample-accurate alignment under the trim point.
        let newStart = snap(gesture.origStart + dFrames);
        const maxStart = gesture.origStart + gesture.origLength - MIN_CLIP_FRAMES;
        if (newStart > maxStart) newStart = maxStart;
        if (newStart < 0) newStart = 0;
        const delta = newStart - gesture.origStart;
        let newOffset = gesture.origOffset + delta;
        if (newOffset < 0) newOffset = 0;
        const newLength = gesture.origLength - delta;
        pending.startFrame = newStart;
        pending.offsetInSource = newOffset;
        pending.lengthFrames = Math.max(MIN_CLIP_FRAMES, newLength);
      } else {
        const newEnd = snap(gesture.origStart + gesture.origLength + dFrames);
        const minEnd = gesture.origStart + MIN_CLIP_FRAMES;
        pending.lengthFrames = Math.max(MIN_CLIP_FRAMES, newEnd - gesture.origStart);
        if (pending.lengthFrames < MIN_CLIP_FRAMES) pending.lengthFrames = MIN_CLIP_FRAMES;
        if (newEnd < minEnd) pending.lengthFrames = MIN_CLIP_FRAMES;
      }
      gesture.moved = gesture.moved || Math.abs(dx) > 2;
      draw();
    }
  }

  function commitPending() {
    if (!pending) return;
    const ref: ClipRef = { trackId: pending.trackId, clipId: pending.clipId };
    const lane = pending.laneIndex;
    const destTrackId = props.project.tracks[lane]?.id ?? pending.trackId;
    const patch: ClipPatch = {
      startFrame: pending.startFrame,
      lengthFrames: pending.lengthFrames,
      offsetInSource: pending.offsetInSource,
    };
    if (destTrackId !== pending.trackId) patch.trackId = destTrackId;
    props.onClipChange?.(ref, patch);
    pending = null;
  }

  function onPointerUp(e: PointerEvent) {
    activeTouches.delete(e.pointerId);

    if (gesture.kind === "move" || gesture.kind === "trim") {
      cancelLongPress();
      if (gesture.moved) commitPending();
      else pending = null; // tap-without-drag — no commit, just selection.
      gesture = { kind: "none" };
      draw();
      return;
    }

    if (gesture.kind === "pinch" && activeTouches.size < 2) {
      gesture = { kind: "none" };
    } else if (gesture.kind === "pan" && activeTouches.size === 0) {
      gesture = { kind: "none" };
    }
  }

  function onPointerCancel(e: PointerEvent) {
    activeTouches.delete(e.pointerId);
    cancelLongPress();
    pending = null;
    gesture = { kind: "none" };
    draw();
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────

  onMount(() => {
    draw();
    const ro = new ResizeObserver(() => draw());
    if (canvas) ro.observe(canvas);
    onCleanup(() => {
      ro.disconnect();
      cancelLongPress();
    });
  });

  createEffect(() => {
    void props.project;
    void props.positionFrames;
    void props.waveforms;
    void props.selected;
    void props.selectedTrack;
    void props.mode;
    draw();
  });

  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        height: `${RULER_HEIGHT + Math.max(1, props.project.tracks.length) * TRACK_HEIGHT}px`,
        "min-height": "200px",
        "touch-action": "none",
      }}
    >
      <canvas
        ref={(el) => (canvas = el)}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        style={{ width: "100%", height: "100%", display: "block", cursor: "default" }}
      />
    </div>
  );
}

export type { Waveform } from "../../audio/waveform-cache";
export type _UnusedRef = SourceMeta;
