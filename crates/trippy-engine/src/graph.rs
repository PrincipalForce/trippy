//! Engine processing graph: tracks → mixer → master out.
//!
//! Two-pass render to support cross-track sidechain:
//!
//! ```text
//! Pass 1 (per track):  clips ──► sum into per-track tap (L/R)
//! Pass 2 (per track):  tap ──► copy to scratch ──► FX chain ──► pan/gain
//!                                                ▲                ▼
//!                                     sidechain  │            master sum
//!                                     reads from │
//!                                     other tracks' taps
//! ```
//!
//! All buffers — per-track taps, the working scratch, and the id-index
//! lookup — are owned by the engine so the audio callback itself never
//! allocates. They grow lazily to the largest seen chunk + track count.

use crate::clip::Clip;
use crate::fx::{AuxInput, FxNode};
use crate::track::{Track, TrackId};
use crate::transport::Transport;

/// Per-process-call context passed to every node.
#[derive(Debug, Clone, Copy)]
pub struct ProcessContext {
    pub sample_rate: f32,
    /// The project-timeline frame the *first* output sample corresponds to.
    pub start_frame: u64,
    pub frames: usize,
    pub playing: bool,
}

/// Render `frames` of stereo audio. See module docs for the two-pass model.
///
/// `taps_l`/`taps_r` must each have `tracks.len()` entries; each entry must
/// be at least `ctx.frames` long. `id_index` maps TrackId → index-into-tracks
/// and must reflect the current tracks slice. Sized + populated by the
/// engine before each call.
pub fn render_master(
    ctx: ProcessContext,
    tracks: &mut [Track],
    taps_l: &mut [Vec<f32>],
    taps_r: &mut [Vec<f32>],
    id_index: &[(TrackId, usize)],
    scratch_l: &mut [f32],
    scratch_r: &mut [f32],
    out_l: &mut [f32],
    out_r: &mut [f32],
) {
    debug_assert_eq!(out_l.len(), ctx.frames);
    debug_assert_eq!(out_r.len(), ctx.frames);
    debug_assert_eq!(taps_l.len(), tracks.len());
    debug_assert_eq!(taps_r.len(), tracks.len());
    debug_assert!(scratch_l.len() >= ctx.frames);
    debug_assert!(scratch_r.len() >= ctx.frames);

    out_l.fill(0.0);
    out_r.fill(0.0);

    if !ctx.playing {
        return;
    }

    let n = tracks.len();
    let frames = ctx.frames;

    // ─── Pass 1: clip-mix every track into its tap. We tap signal regardless
    // of mute/solo so a muted trigger track still drives downstream sidechain
    // compressors (and so cross-track relationships keep working when soloing
    // for A/B).
    for i in 0..n {
        let tap_l = &mut taps_l[i][..frames];
        let tap_r = &mut taps_r[i][..frames];
        tap_l.fill(0.0);
        tap_r.fill(0.0);
        for clip in &tracks[i].clips {
            mix_clip_into_scratch(ctx, clip, tap_l, tap_r);
        }
    }

    let any_solo = tracks.iter().any(|t| t.solo);

    // ─── Pass 2: copy each track's tap to scratch, run FX (with sidechain
    // lookups against the other tracks' taps), apply pan/gain, sum to master.
    for i in 0..n {
        let (mute, solo) = (tracks[i].mute, tracks[i].solo);
        if mute || (any_solo && !solo) {
            continue;
        }
        scratch_l[..frames].copy_from_slice(&taps_l[i][..frames]);
        scratch_r[..frames].copy_from_slice(&taps_r[i][..frames]);

        // Split tracks so we can hold &mut tracks[i] for FX state mutation
        // while still reading other tracks' taps (taps_l/taps_r are separate
        // params, so no aliasing).
        let track = &mut tracks[i];
        for fx in track.fx_chain.iter_mut() {
            let sc_idx = match fx {
                FxNode::Compressor { sidechain_source: Some(src_id), .. } => id_index
                    .iter()
                    .find(|(id, _)| *id == *src_id)
                    .map(|(_, idx)| *idx)
                    .filter(|&j| j < n && j != i),
                _ => None,
            };
            let aux = match sc_idx {
                Some(j) => AuxInput {
                    sidechain: Some((&taps_l[j][..frames], &taps_r[j][..frames])),
                },
                None => AuxInput::default(),
            };
            fx.process(
                &mut scratch_l[..frames],
                &mut scratch_r[..frames],
                aux,
            );
        }

        let (pan_l, pan_r) = track.pan_gains();
        let gain_l = track.gain * pan_l;
        let gain_r = track.gain * pan_r;
        for k in 0..frames {
            out_l[k] += scratch_l[k] * gain_l;
            out_r[k] += scratch_r[k] * gain_r;
        }
    }
}

/// Mix a single clip's contribution into the per-track scratch buses
/// (pre-pan, pre-gain, pre-FX). Mono sources duplicate to both channels at
/// equal amplitude (the constant-power pan law in step 3 restores perceived
/// loudness when applied post-FX).
fn mix_clip_into_scratch(
    ctx: ProcessContext,
    clip: &Clip,
    out_l: &mut [f32],
    out_r: &mut [f32],
) {
    let win_start = ctx.start_frame;
    let win_end = win_start + ctx.frames as u64;
    let clip_start = clip.start_frame;
    let clip_end = clip.end_frame();

    let overlap_start = win_start.max(clip_start);
    let overlap_end = win_end.min(clip_end);
    if overlap_start >= overlap_end {
        return;
    }

    let out_offset = (overlap_start - win_start) as usize;
    let copy_frames = (overlap_end - overlap_start) as usize;
    let src_offset_frame = (overlap_start - clip_start) + clip.offset_in_source;
    let src_idx = src_offset_frame as usize;
    let src_len = clip.source.frame_count();
    if src_idx >= src_len {
        return;
    }
    let actual_frames = copy_frames.min(src_len - src_idx);

    let g = clip.gain;
    let chans = &clip.source.channels;
    match chans.len() {
        1 => {
            // Mono → duplicate at unity into both buses. The post-FX
            // constant-power pan (each leg = 1/sqrt(2) at center) then
            // attenuates by sqrt(2)/2, matching the legacy behavior where
            // mono center pan produced 0.5 × sqrt(0.5) per channel.
            let src = &chans[0][src_idx..src_idx + actual_frames];
            for (i, &s) in src.iter().enumerate() {
                let v = s * g;
                out_l[out_offset + i] += v;
                out_r[out_offset + i] += v;
            }
        }
        2 => {
            // Stereo source: feed each side straight through, scaled
            // so that the post-FX center pan reproduces unity gain.
            let src_l = &chans[0][src_idx..src_idx + actual_frames];
            let src_r = &chans[1][src_idx..src_idx + actual_frames];
            let pre = g * std::f32::consts::SQRT_2;
            for i in 0..actual_frames {
                out_l[out_offset + i] += src_l[i] * pre;
                out_r[out_offset + i] += src_r[i] * pre;
            }
        }
        _ => {
            // Other layouts not supported.
        }
    }
}

/// Drive the engine forward by `frames`: render into `out_l`/`out_r`, advance
/// transport. Returns the (possibly looped) new transport position.
pub fn process(
    transport: &mut Transport,
    tracks: &mut [Track],
    taps_l: &mut [Vec<f32>],
    taps_r: &mut [Vec<f32>],
    id_index: &[(TrackId, usize)],
    scratch_l: &mut [f32],
    scratch_r: &mut [f32],
    out_l: &mut [f32],
    out_r: &mut [f32],
) -> u64 {
    let frames = out_l.len();
    debug_assert_eq!(out_r.len(), frames);
    let ctx = ProcessContext {
        sample_rate: transport.sample_rate,
        start_frame: transport.position_frames,
        frames,
        playing: transport.playing,
    };
    render_master(
        ctx, tracks, taps_l, taps_r, id_index, scratch_l, scratch_r, out_l, out_r,
    );
    if transport.playing {
        transport.advance(frames as u64)
    } else {
        transport.position_frames
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clip::{Clip, ClipId};
    use crate::source::{AudioSource, ChannelLayout, SourceId};
    use crate::track::{Track, TrackId};
    use crate::transport::Transport;
    use std::sync::Arc;

    fn mono_source(samples: Vec<f32>) -> Arc<AudioSource> {
        Arc::new(AudioSource {
            id: SourceId(0),
            sample_rate: 48_000.0,
            layout: ChannelLayout::Mono,
            channels: vec![samples],
        })
    }

    fn buf(n: usize) -> Vec<f32> {
        vec![0.0; n]
    }

    /// Build per-track tap buffers + id_index for the given tracks and frame
    /// count. Test-only convenience so each test isn't 6 lines of setup.
    fn ctx_for(tracks: &[Track], frames: usize) -> (Vec<Vec<f32>>, Vec<Vec<f32>>, Vec<(TrackId, usize)>) {
        let tl = tracks.iter().map(|_| vec![0.0; frames]).collect();
        let tr = tracks.iter().map(|_| vec![0.0; frames]).collect();
        let idx = tracks.iter().enumerate().map(|(i, t)| (t.id, i)).collect();
        (tl, tr, idx)
    }

    #[test]
    fn silence_when_stopped() {
        let mut t = Transport::new(48_000.0);
        t.playing = false;
        let mut l = vec![1.0; 128];
        let mut r = vec![1.0; 128];
        let mut sl = buf(128);
        let mut sr = buf(128);
        let mut tracks: Vec<Track> = vec![];
        let (mut tl, mut tr, idx) = ctx_for(&tracks, 128);
        process(
            &mut t, &mut tracks, &mut tl, &mut tr, &idx, &mut sl, &mut sr, &mut l, &mut r,
        );
        assert!(l.iter().all(|&s| s == 0.0));
        assert!(r.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn mono_clip_renders_to_both_channels() {
        let src = mono_source(vec![0.5; 1000]);
        let mut track = Track::new(TrackId(1));
        track.add_clip(Clip {
            id: ClipId(1),
            source: src,
            start_frame: 0,
            length_frames: 1000,
            offset_in_source: 0,
            gain: 1.0,
        });

        let mut t = Transport::new(48_000.0);
        t.playing = true;
        let mut l = buf(128);
        let mut r = buf(128);
        let mut sl = buf(128);
        let mut sr = buf(128);
        let mut tracks = vec![track];
        let (mut tl, mut tr, idx) = ctx_for(&tracks, 128);
        process(
            &mut t, &mut tracks, &mut tl, &mut tr, &idx, &mut sl, &mut sr, &mut l, &mut r,
        );

        // Center pan ≈ sqrt(0.5). 0.5 * sqrt(0.5) ≈ 0.3536
        let expected = 0.5 * std::f32::consts::FRAC_1_SQRT_2;
        for s in l.iter().chain(r.iter()) {
            assert!((s - expected).abs() < 1e-5, "got {s}, expected {expected}");
        }
        assert_eq!(t.position_frames, 128);
    }

    #[test]
    fn clip_outside_window_is_silent() {
        let src = mono_source(vec![1.0; 1000]);
        let mut track = Track::new(TrackId(1));
        track.add_clip(Clip {
            id: ClipId(1),
            source: src,
            start_frame: 10_000,
            length_frames: 1000,
            offset_in_source: 0,
            gain: 1.0,
        });

        let mut t = Transport::new(48_000.0);
        t.playing = true;
        let mut l = buf(128);
        let mut r = buf(128);
        let mut sl = buf(128);
        let mut sr = buf(128);
        let mut tracks = vec![track];
        let (mut tl, mut tr, idx) = ctx_for(&tracks, 128);
        process(
            &mut t, &mut tracks, &mut tl, &mut tr, &idx, &mut sl, &mut sr, &mut l, &mut r,
        );
        assert!(l.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn muted_track_is_silent() {
        let src = mono_source(vec![1.0; 1000]);
        let mut track = Track::new(TrackId(1));
        track.add_clip(Clip {
            id: ClipId(1),
            source: src,
            start_frame: 0,
            length_frames: 1000,
            offset_in_source: 0,
            gain: 1.0,
        });
        track.mute = true;

        let mut t = Transport::new(48_000.0);
        t.playing = true;
        let mut l = buf(64);
        let mut r = buf(64);
        let mut sl = buf(64);
        let mut sr = buf(64);
        let mut tracks = vec![track];
        let (mut tl, mut tr, idx) = ctx_for(&tracks, 64);
        process(
            &mut t, &mut tracks, &mut tl, &mut tr, &idx, &mut sl, &mut sr, &mut l, &mut r,
        );
        assert!(l.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn solo_overrides_unsoloed_tracks() {
        let src_a = mono_source(vec![0.5; 1000]);
        let src_b = mono_source(vec![0.5; 1000]);
        let mut track_a = Track::new(TrackId(1));
        let mut track_b = Track::new(TrackId(2));
        track_a.add_clip(Clip {
            id: ClipId(1),
            source: src_a,
            start_frame: 0,
            length_frames: 1000,
            offset_in_source: 0,
            gain: 1.0,
        });
        track_b.add_clip(Clip {
            id: ClipId(2),
            source: src_b,
            start_frame: 0,
            length_frames: 1000,
            offset_in_source: 0,
            gain: 1.0,
        });
        track_b.solo = true;

        let mut t = Transport::new(48_000.0);
        t.playing = true;
        let mut l = buf(64);
        let mut r = buf(64);
        let mut sl = buf(64);
        let mut sr = buf(64);
        let mut tracks = vec![track_a, track_b];
        let (mut tl, mut tr, idx) = ctx_for(&tracks, 64);
        process(
            &mut t, &mut tracks, &mut tl, &mut tr, &idx, &mut sl, &mut sr, &mut l, &mut r,
        );

        // Only track_b plays. Magnitude = 0.5 * sqrt(0.5)
        let expected = 0.5 * std::f32::consts::FRAC_1_SQRT_2;
        for s in &l {
            assert!((s - expected).abs() < 1e-5);
        }
    }

    #[test]
    fn loop_wraps_position() {
        use crate::transport::LoopRegion;
        let mut t = Transport::new(48_000.0);
        t.playing = true;
        t.loop_region = LoopRegion::new(0, 100);
        t.position_frames = 80;
        let mut l = buf(64);
        let mut r = buf(64);
        let mut sl = buf(64);
        let mut sr = buf(64);
        let mut tracks: Vec<Track> = vec![];
        let (mut tl, mut tr, idx) = ctx_for(&tracks, 64);
        process(
            &mut t, &mut tracks, &mut tl, &mut tr, &idx, &mut sl, &mut sr, &mut l, &mut r,
        );
        // 80 + 64 = 144; wrap to 44
        assert_eq!(t.position_frames, 44);
    }

    #[test]
    fn fx_chain_processes_in_order() {
        use crate::fx::delay::Delay;
        use crate::fx::{FxId, FxNode};

        // Two delays in series: 50-sample then 30-sample, each 100% wet,
        // 0 feedback. An impulse at sample 0 should appear at sample 80.
        let mut track = Track::new(TrackId(1));
        let src = mono_source({
            let mut v = vec![0.0; 500];
            v[0] = 1.0;
            v
        });
        track.add_clip(Clip {
            id: ClipId(1),
            source: src,
            start_frame: 0,
            length_frames: 500,
            offset_in_source: 0,
            gain: 1.0,
        });
        let mut d1 = Delay::new(48_000.0, 1.0);
        d1.delay_samples = 50;
        d1.wet = 1.0;
        d1.dry = 0.0;
        d1.feedback = 0.0;
        let mut d2 = Delay::new(48_000.0, 1.0);
        d2.delay_samples = 30;
        d2.wet = 1.0;
        d2.dry = 0.0;
        d2.feedback = 0.0;
        track.fx_chain.push(FxNode::Delay { id: FxId(1), fx: d1 });
        track.fx_chain.push(FxNode::Delay { id: FxId(2), fx: d2 });

        let mut t = Transport::new(48_000.0);
        t.playing = true;
        let mut l = buf(200);
        let mut r = buf(200);
        let mut sl = buf(200);
        let mut sr = buf(200);
        let mut tracks = vec![track];
        let (mut tl, mut tr, idx) = ctx_for(&tracks, 200);
        process(
            &mut t, &mut tracks, &mut tl, &mut tr, &idx, &mut sl, &mut sr, &mut l, &mut r,
        );
        assert!(l[80].abs() > 0.1, "expected a peak at 80, got {}", l[80]);
        assert!(l[10].abs() < 1e-3);
    }

    #[test]
    fn sidechain_routes_from_other_track() {
        // Two tracks: trigger (loud burst on track 1), target (quiet steady
        // tone on track 2). Target carries a sidechain compressor sourced
        // from track 1. Target's contribution to master should drop while
        // the trigger is loud and recover when it's silent.
        use crate::fx::compressor::Compressor;
        use crate::fx::{FxId, FxNode};

        let n = 4_800;
        let trigger_samples: Vec<f32> =
            (0..n).map(|i| if i < n / 2 { 0.8 } else { 0.0 }).collect();
        let target_samples = vec![0.4f32; n];

        let mut trigger = Track::new(TrackId(1));
        trigger.add_clip(Clip {
            id: ClipId(1),
            source: mono_source(trigger_samples),
            start_frame: 0,
            length_frames: n as u64,
            offset_in_source: 0,
            gain: 1.0,
        });

        let mut target = Track::new(TrackId(2));
        target.add_clip(Clip {
            id: ClipId(2),
            source: mono_source(target_samples),
            start_frame: 0,
            length_frames: n as u64,
            offset_in_source: 0,
            gain: 1.0,
        });
        // Mute the trigger so its own audio doesn't muddy the energy
        // measurement of the target's master contribution. Sidechain still
        // works because pass 1 fills taps regardless of mute.
        trigger.mute = true;
        let mut comp = Compressor::new(48_000.0);
        comp.threshold_db = -20.0;
        comp.ratio = 8.0;
        comp.set_attack_ms(1.0);
        comp.set_release_ms(50.0);
        target.fx_chain.push(FxNode::Compressor {
            id: FxId(1),
            fx: comp,
            sidechain_source: Some(TrackId(1)),
        });

        let mut t = Transport::new(48_000.0);
        t.playing = true;
        let mut l = buf(n);
        let mut r = buf(n);
        let mut sl = buf(n);
        let mut sr = buf(n);
        let mut tracks = vec![trigger, target];
        let (mut tl, mut tr, idx) = ctx_for(&tracks, n);
        process(
            &mut t, &mut tracks, &mut tl, &mut tr, &idx, &mut sl, &mut sr, &mut l, &mut r,
        );

        // Energy in the first half (loud trigger) vs. second half (silent).
        let early: f32 = (l[200..600].iter().map(|s| s.abs()).sum::<f32>()) / 400.0;
        let late: f32 = (l[n - 400..n].iter().map(|s| s.abs()).sum::<f32>()) / 400.0;
        assert!(
            late > early * 1.5,
            "expected sidechain duck — early={early}, late={late}",
        );
    }
}
