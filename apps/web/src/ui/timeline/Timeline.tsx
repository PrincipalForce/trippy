// Multi-track timeline with Canvas2D-rendered waveforms and pinch/wheel zoom.
//
// The timeline is laid out horizontally (time → x) with stacked track lanes
// vertically. Pixels-per-frame is the single zoom parameter; pan offset is in
// frames. Touch gestures: one-finger drag pans, two-finger pinch zooms.
//
// Waveform peaks come from `WaveformCache`. Per-frame redraws hit only the
// chosen pyramid level so cost is O(width).

import { createEffect, onCleanup, onMount, For } from "solid-js";
import type { ProjectFile, TrackSnapshot, ClipSnapshot, SourceMeta } from "@trippy/format";
import { chooseLevel, type Waveform } from "../../audio/waveform-cache";

export interface TimelineProps {
  project: ProjectFile;
  waveforms: Map<number, Waveform>; // sourceId → Waveform
  positionFrames: number;
  /** Initial zoom in frames per pixel. */
  initialZoom?: number;
  onSeek?: (frame: number) => void;
}

const TRACK_HEIGHT = 80;
const RULER_HEIGHT = 28;
const MIN_FPP = 8; // frames per pixel
const MAX_FPP = 100_000;

export function Timeline(props: TimelineProps) {
  let canvas: HTMLCanvasElement | undefined;
  let container: HTMLDivElement | undefined;
  let framesPerPixel = props.initialZoom ?? 1024;
  let panFrames = 0;

  let pinchStart: { dist: number; fpp: number; centerFrame: number } | null = null;
  let dragStart: { x: number; panFrames: number } | null = null;

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

  function frameToX(frame: number): number {
    return (frame - panFrames) / framesPerPixel;
  }
  function xToFrame(x: number): number {
    return panFrames + x * framesPerPixel;
  }

  function drawRuler(ctx: CanvasRenderingContext2D, w: number, sr: number, bpm: number) {
    ctx.fillStyle = "#14141c";
    ctx.fillRect(0, 0, w, RULER_HEIGHT);
    ctx.strokeStyle = "#1e1e2a";
    ctx.beginPath();
    ctx.moveTo(0, RULER_HEIGHT - 0.5);
    ctx.lineTo(w, RULER_HEIGHT - 0.5);
    ctx.stroke();

    // Beat grid: choose the smallest beat subdivision that's at least 24 px wide.
    const framesPerBeat = (60 / bpm) * sr;
    let subdivision = 1;
    while ((framesPerBeat * subdivision) / framesPerPixel < 24) subdivision *= 2;
    const stepFrames = framesPerBeat * subdivision;

    const firstBeat = Math.floor(panFrames / stepFrames);
    const lastBeat = Math.ceil((panFrames + w * framesPerPixel) / stepFrames);

    ctx.font = "11px ui-monospace, SF Mono, Menlo, monospace";
    ctx.fillStyle = "#8a8aa0";
    ctx.textBaseline = "middle";
    for (let b = firstBeat; b <= lastBeat; b++) {
      const f = b * stepFrames;
      const x = frameToX(f);
      ctx.strokeStyle = b % 4 === 0 ? "#3a3a55" : "#1e1e2a";
      ctx.beginPath();
      ctx.moveTo(x + 0.5, 0);
      ctx.lineTo(x + 0.5, RULER_HEIGHT);
      ctx.stroke();
      if (b % 4 === 0) {
        const bar = Math.floor(b * subdivision) / 4 + 1;
        ctx.fillText(`${bar.toFixed(0)}`, x + 4, RULER_HEIGHT / 2);
      }
    }
  }

  function drawTracks(ctx: CanvasRenderingContext2D, w: number, h: number) {
    const tracks = props.project.tracks;
    for (let i = 0; i < tracks.length; i++) {
      const y = RULER_HEIGHT + i * TRACK_HEIGHT;
      if (y >= h) break;
      // Lane background
      ctx.fillStyle = i % 2 === 0 ? "#0d0d14" : "#101019";
      ctx.fillRect(0, y, w, TRACK_HEIGHT);
      // Beat grid lines through lane
      drawTrackGrid(ctx, w, y);
      // Clips
      for (const clip of tracks[i]!.clips) {
        drawClip(ctx, w, y, tracks[i]!, clip);
      }
    }
  }

  function drawTrackGrid(ctx: CanvasRenderingContext2D, w: number, y: number) {
    const sr = props.project.transport.sampleRate;
    const framesPerBeat = (60 / props.project.transport.bpm) * sr;
    let subdivision = 1;
    while ((framesPerBeat * subdivision) / framesPerPixel < 24) subdivision *= 2;
    const stepFrames = framesPerBeat * subdivision;
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
    y: number,
    _track: TrackSnapshot,
    clip: ClipSnapshot,
  ) {
    const x1 = frameToX(clip.startFrame);
    const x2 = frameToX(clip.startFrame + clip.lengthFrames);
    const left = Math.max(-1, x1);
    const right = Math.min(canvasW + 1, x2);
    if (right <= left) return;
    const w = right - left;
    const top = y + 2;
    const h = TRACK_HEIGHT - 4;

    ctx.save();
    ctx.fillStyle = "#1b1633";
    ctx.strokeStyle = "#7c5cff";
    ctx.lineWidth = 1;
    roundRect(ctx, left, top, w, h, 6);
    ctx.fill();
    ctx.stroke();

    // Clip caption
    if (clip.label) {
      ctx.fillStyle = "#bdb1ff";
      ctx.font = "11px system-ui";
      ctx.textBaseline = "top";
      ctx.fillText(clip.label, left + 6, top + 4);
    }

    // Waveform
    const wf = props.waveforms.get(clip.sourceId);
    if (wf && wf.levels[0]) {
      const channelLevels = wf.levels[0]!;
      const level = chooseLevel(channelLevels, framesPerPixel);
      const peaks = level.data;
      const bucketSize = level.bucketSize;
      const yMid = top + h / 2;
      const yScale = (h / 2) * 0.92;

      ctx.strokeStyle = "#7c5cff";
      ctx.beginPath();
      const fpp = framesPerPixel;
      const widthPx = right - left;
      for (let px = 0; px < widthPx; px++) {
        const projFrame = panFrames + (left + px) * fpp;
        const clipRel = projFrame - clip.startFrame + clip.offsetInSource;
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
    ctx.restore();
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

  // Wheel: zoom (with ctrl/cmd) or horizontal pan.
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

  // Touch handlers — pinch + pan.
  const activeTouches = new Map<number, { x: number; y: number }>();

  function onPointerDown(e: PointerEvent) {
    canvas!.setPointerCapture(e.pointerId);
    activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activeTouches.size === 1) {
      dragStart = { x: e.clientX, panFrames };
    } else if (activeTouches.size === 2) {
      const [a, b] = [...activeTouches.values()];
      const dx = a!.x - b!.x;
      const dy = a!.y - b!.y;
      const dist = Math.hypot(dx, dy);
      const centerX = (a!.x + b!.x) / 2;
      const rect = canvas!.getBoundingClientRect();
      const centerFrame = xToFrame(centerX - rect.left);
      pinchStart = { dist, fpp: framesPerPixel, centerFrame };
      dragStart = null;
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!activeTouches.has(e.pointerId)) return;
    activeTouches.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (activeTouches.size === 2 && pinchStart) {
      const [a, b] = [...activeTouches.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const ratio = pinchStart.dist / Math.max(1, dist);
      framesPerPixel = clampZoom(pinchStart.fpp * ratio);
      const centerX = (a!.x + b!.x) / 2;
      const rect = canvas!.getBoundingClientRect();
      panFrames = pinchStart.centerFrame - (centerX - rect.left) * framesPerPixel;
      if (panFrames < 0) panFrames = 0;
      draw();
    } else if (activeTouches.size === 1 && dragStart) {
      const dx = e.clientX - dragStart.x;
      panFrames = Math.max(0, dragStart.panFrames - dx * framesPerPixel);
      draw();
    }
  }

  function onPointerUp(e: PointerEvent) {
    activeTouches.delete(e.pointerId);
    if (activeTouches.size < 2) pinchStart = null;
    if (activeTouches.size === 0) dragStart = null;
  }

  function onClick(e: MouseEvent) {
    // Only treat a click (no drag movement) as a seek.
    if (!props.onSeek) return;
    const rect = canvas!.getBoundingClientRect();
    const x = e.clientX - rect.left;
    if (e.clientY - rect.top < RULER_HEIGHT) {
      props.onSeek(Math.max(0, Math.floor(xToFrame(x))));
    }
  }

  onMount(() => {
    draw();
    const ro = new ResizeObserver(() => draw());
    if (canvas) ro.observe(canvas);
    onCleanup(() => ro.disconnect());
  });

  // Redraw on prop changes.
  createEffect(() => {
    void props.project;
    void props.positionFrames;
    void props.waveforms;
    draw();
  });

  return (
    <div
      ref={(el) => (container = el)}
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
        onPointerCancel={onPointerUp}
        onClick={onClick}
        style={{ width: "100%", height: "100%", display: "block", cursor: "crosshair" }}
      />
    </div>
  );
}

// Re-export for callers that build waveforms ad-hoc.
export type { Waveform } from "../../audio/waveform-cache";

// Quiet down unused-variable noise from the helper that callers may want
// later (e.g. for source overlays).
export type _UnusedRef = SourceMeta;
