//! Engine processing graph: tracks → mixer → master out.
//!
//! M1 architecture is intentionally flat:
//!
//! ```text
//!   Track[0] ──┐
//!   Track[1] ──┼──> Mixer (sum + master gain) ──> stereo out
//!   ...      ──┘
//! ```
//!
//! M4 inserts per-track FX chains and sends; M5 inserts per-parameter
//! automation evaluation. The flat shape here keeps the M1 audio-thread
//! callback allocation-free and easy to reason about.

use crate::clip::Clip;
use crate::track::Track;
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

/// Render `frames` of stereo audio from the given tracks into `out_l`/`out_r`,
/// starting at project-frame `ctx.start_frame`.
///
/// The output buffers are *overwritten*, not added to. Callers wanting to mix
/// into existing audio should sum afterward.
///
/// This is the hot path: no allocations, no virtual dispatch, no I/O.
pub fn render_master(ctx: ProcessContext, tracks: &[Track], out_l: &mut [f32], out_r: &mut [f32]) {
    debug_assert_eq!(out_l.len(), ctx.frames);
    debug_assert_eq!(out_r.len(), ctx.frames);

    // Zero the output. (Could `out_l.fill(0.0)` but explicit loop is clearer.)
    for s in out_l.iter_mut() {
        *s = 0.0;
    }
    for s in out_r.iter_mut() {
        *s = 0.0;
    }

    if !ctx.playing {
        return;
    }

    // Solo logic: if any track is soloed, only soloed tracks render.
    let any_solo = tracks.iter().any(|t| t.solo);

    for track in tracks {
        if track.mute {
            continue;
        }
        if any_solo && !track.solo {
            continue;
        }
        let (pan_l, pan_r) = track.pan_gains();
        let track_gain = track.gain;

        for clip in &track.clips {
            mix_clip_into(ctx, clip, pan_l, pan_r, track_gain, out_l, out_r);
        }
    }
}

/// Mix a single clip's contribution into the stereo buses.
///
/// Walks the overlap between the render window `[start, start+frames)` and the
/// clip's active range `[clip.start_frame, clip.end_frame())`, copies samples
/// from the source, applies clip gain + track gain + pan, and sums into out.
fn mix_clip_into(
    ctx: ProcessContext,
    clip: &Clip,
    pan_l: f32,
    pan_r: f32,
    track_gain: f32,
    out_l: &mut [f32],
    out_r: &mut [f32],
) {
    let win_start = ctx.start_frame;
    let win_end = win_start + ctx.frames as u64;
    let clip_start = clip.start_frame;
    let clip_end = clip.end_frame();

    // Compute overlap in project-frame coordinates.
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

    let gain_l = clip.gain * track_gain * pan_l;
    let gain_r = clip.gain * track_gain * pan_r;

    let chans = &clip.source.channels;
    match chans.len() {
        1 => {
            let src = &chans[0][src_idx..src_idx + actual_frames];
            for (i, &s) in src.iter().enumerate() {
                out_l[out_offset + i] += s * gain_l;
                out_r[out_offset + i] += s * gain_r;
            }
        }
        2 => {
            let src_l = &chans[0][src_idx..src_idx + actual_frames];
            let src_r = &chans[1][src_idx..src_idx + actual_frames];
            for i in 0..actual_frames {
                // For stereo sources, pan acts as a balance: left source goes
                // to left out scaled by pan_l*sqrt(2), right to right scaled by
                // pan_r*sqrt(2). At pan=0 (pan_l=pan_r=sqrt(0.5)) this is unity.
                out_l[out_offset + i] += src_l[i] * gain_l * std::f32::consts::SQRT_2;
                out_r[out_offset + i] += src_r[i] * gain_r * std::f32::consts::SQRT_2;
            }
        }
        _ => {
            // Other layouts not supported at M1.
        }
    }
}

/// Drive the engine forward by `frames`: render into `out_l`/`out_r`, advance
/// transport. Returns the (possibly looped) new transport position.
pub fn process(
    transport: &mut Transport,
    tracks: &[Track],
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
    render_master(ctx, tracks, out_l, out_r);
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

    #[test]
    fn silence_when_stopped() {
        let mut t = Transport::new(48_000.0);
        t.playing = false;
        let mut l = vec![1.0; 128];
        let mut r = vec![1.0; 128];
        process(&mut t, &[], &mut l, &mut r);
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
        let mut l = vec![0.0; 128];
        let mut r = vec![0.0; 128];
        process(&mut t, &[track], &mut l, &mut r);

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
        let mut l = vec![0.0; 128];
        let mut r = vec![0.0; 128];
        process(&mut t, &[track], &mut l, &mut r);

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
        let mut l = vec![0.0; 64];
        let mut r = vec![0.0; 64];
        process(&mut t, &[track], &mut l, &mut r);
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
        let mut l = vec![0.0; 64];
        let mut r = vec![0.0; 64];
        process(&mut t, &[track_a, track_b], &mut l, &mut r);

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
        let mut l = vec![0.0; 64];
        let mut r = vec![0.0; 64];
        process(&mut t, &[], &mut l, &mut r);
        // 80 + 64 = 144; wrap to 44
        assert_eq!(t.position_frames, 44);
    }
}
