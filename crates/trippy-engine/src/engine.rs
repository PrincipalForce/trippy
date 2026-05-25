//! Engine: top-level owner of transport + tracks + sources.
//!
//! This is the *native* API. The wasm-bindgen layer in `wasm.rs` wraps it
//! with a thin JS-friendly facade.

use std::collections::HashMap;
use std::sync::Arc;

use crate::clip::{Clip, ClipId};
use crate::graph;
use crate::source::{AudioSource, ChannelLayout, SourceHandle, SourceId};
use crate::track::{Track, TrackId};
use crate::transport::{LoopRegion, Transport};

#[derive(Debug)]
pub struct Engine {
    pub transport: Transport,
    pub tracks: Vec<Track>,
    sources: HashMap<SourceId, SourceHandle>,
    next_source_id: u32,
    next_track_id: u32,
    next_clip_id: u32,
}

impl Engine {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            transport: Transport::new(sample_rate),
            tracks: Vec::new(),
            sources: HashMap::new(),
            next_source_id: 1,
            next_track_id: 1,
            next_clip_id: 1,
        }
    }

    pub fn add_source_interleaved(
        &mut self,
        sample_rate: f32,
        layout: ChannelLayout,
        interleaved: &[f32],
    ) -> SourceId {
        let id = SourceId(self.next_source_id);
        self.next_source_id += 1;
        let src = Arc::new(AudioSource::from_interleaved(
            id,
            sample_rate,
            layout,
            interleaved,
        ));
        self.sources.insert(id, src);
        id
    }

    pub fn add_source_deinterleaved(
        &mut self,
        sample_rate: f32,
        layout: ChannelLayout,
        channels: Vec<Vec<f32>>,
    ) -> SourceId {
        let id = SourceId(self.next_source_id);
        self.next_source_id += 1;
        let src = Arc::new(AudioSource {
            id,
            sample_rate,
            layout,
            channels,
        });
        self.sources.insert(id, src);
        id
    }

    pub fn source(&self, id: SourceId) -> Option<&SourceHandle> {
        self.sources.get(&id)
    }

    pub fn remove_source(&mut self, id: SourceId) -> bool {
        self.sources.remove(&id).is_some()
    }

    pub fn add_track(&mut self) -> TrackId {
        let id = TrackId(self.next_track_id);
        self.next_track_id += 1;
        self.tracks.push(Track::new(id));
        id
    }

    pub fn remove_track(&mut self, id: TrackId) -> bool {
        let n = self.tracks.len();
        self.tracks.retain(|t| t.id != id);
        self.tracks.len() != n
    }

    pub fn track_mut(&mut self, id: TrackId) -> Option<&mut Track> {
        self.tracks.iter_mut().find(|t| t.id == id)
    }

    /// Place a clip on a track. Returns `None` if the track or source doesn't
    /// exist. If `length_frames` is `None`, plays the whole source.
    pub fn add_clip(
        &mut self,
        track_id: TrackId,
        source_id: SourceId,
        start_frame: u64,
        length_frames: Option<u64>,
        offset_in_source: u64,
    ) -> Option<ClipId> {
        let source = self.sources.get(&source_id)?.clone();
        let max_len = source
            .frame_count()
            .saturating_sub(offset_in_source as usize) as u64;
        let length = length_frames.unwrap_or(max_len).min(max_len);
        let clip_id = ClipId(self.next_clip_id);
        self.next_clip_id += 1;
        let track = self.tracks.iter_mut().find(|t| t.id == track_id)?;
        track.add_clip(Clip {
            id: clip_id,
            source,
            start_frame,
            length_frames: length,
            offset_in_source,
            gain: 1.0,
        });
        Some(clip_id)
    }

    pub fn remove_clip(&mut self, track_id: TrackId, clip_id: ClipId) -> bool {
        if let Some(t) = self.track_mut(track_id) {
            t.remove_clip(clip_id)
        } else {
            false
        }
    }

    // ---------- transport controls ----------

    pub fn play(&mut self) {
        self.transport.playing = true;
    }
    pub fn stop(&mut self) {
        self.transport.playing = false;
    }
    pub fn set_position(&mut self, frame: u64) {
        self.transport.position_frames = frame;
    }
    pub fn set_bpm(&mut self, bpm: f64) {
        self.transport.bpm.0 = bpm;
    }
    pub fn set_loop(&mut self, start: u64, end: u64) {
        self.transport.loop_region = LoopRegion::new(start, end);
    }
    pub fn clear_loop(&mut self) {
        self.transport.loop_region = None;
    }

    /// Render the next `out_l.len()` frames. `out_r.len()` must equal `out_l.len()`.
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        graph::process(&mut self.transport, &self.tracks, out_l, out_r);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn end_to_end_mono_clip_playback() {
        let mut e = Engine::new(48_000.0);
        // A constant 0.5 mono source of 1000 frames.
        let interleaved: Vec<f32> = vec![0.5; 1000];
        let sid = e.add_source_interleaved(48_000.0, ChannelLayout::Mono, &interleaved);
        let tid = e.add_track();
        e.add_clip(tid, sid, 0, None, 0).unwrap();
        e.play();

        let mut l = vec![0.0; 256];
        let mut r = vec![0.0; 256];
        e.process(&mut l, &mut r);

        let expected = 0.5 * std::f32::consts::FRAC_1_SQRT_2;
        assert!((l[0] - expected).abs() < 1e-5);
        assert!((r[0] - expected).abs() < 1e-5);
        assert_eq!(e.transport.position_frames, 256);
    }

    #[test]
    fn remove_track_removes_its_clips() {
        let mut e = Engine::new(48_000.0);
        let sid = e.add_source_interleaved(48_000.0, ChannelLayout::Mono, &vec![0.1; 100]);
        let tid = e.add_track();
        e.add_clip(tid, sid, 0, None, 0).unwrap();
        assert!(e.remove_track(tid));
        assert!(e.tracks.is_empty());
    }
}
