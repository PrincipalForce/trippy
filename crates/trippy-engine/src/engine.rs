//! Engine: top-level owner of transport + tracks + sources.
//!
//! This is the *native* API. The wasm-bindgen layer in `wasm.rs` wraps it
//! with a thin JS-friendly facade.

use std::collections::HashMap;
use std::sync::Arc;

use crate::clip::{Clip, ClipId};
use crate::fx::{compressor::Compressor, delay::Delay, eq::Eq, FxId, FxNode};
use crate::graph;
use crate::source::{AudioSource, ChannelLayout, SourceHandle, SourceId};
use crate::track::{Track, TrackId};
use crate::transport::{LoopRegion, Transport};

#[derive(Debug)]
pub struct Engine {
    pub transport: Transport,
    pub tracks: Vec<Track>,
    sources: HashMap<SourceId, SourceHandle>,
    /// Per-track scratch buffers, lazily resized to the largest seen chunk.
    /// Reused across all tracks per render, so the audio callback never
    /// allocates after warmup.
    scratch_l: Vec<f32>,
    scratch_r: Vec<f32>,
    /// Pre-FX tap per track (parallel to `tracks`). Read by sidechain
    /// compressors on later tracks. Resized lazily — see Engine::process.
    taps_l: Vec<Vec<f32>>,
    taps_r: Vec<Vec<f32>>,
    /// (TrackId, index-into-tracks). Refilled each render so sidechain
    /// lookups don't allocate inside the audio callback.
    id_index: Vec<(crate::track::TrackId, usize)>,
    next_source_id: u32,
    next_track_id: u32,
    next_clip_id: u32,
    next_fx_id: u32,
}

impl Engine {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            transport: Transport::new(sample_rate),
            tracks: Vec::new(),
            sources: HashMap::new(),
            scratch_l: Vec::new(),
            scratch_r: Vec::new(),
            taps_l: Vec::new(),
            taps_r: Vec::new(),
            id_index: Vec::new(),
            next_source_id: 1,
            next_track_id: 1,
            next_clip_id: 1,
            next_fx_id: 1,
        }
    }

    /// Add a multi-band EQ to a track. Returns the new FX id, or None if
    /// the track doesn't exist.
    pub fn add_eq(&mut self, track_id: TrackId, bands: Vec<crate::fx::eq::EqBand>) -> Option<FxId> {
        let sr = self.transport.sample_rate;
        let track = self.tracks.iter_mut().find(|t| t.id == track_id)?;
        let id = FxId(self.next_fx_id);
        self.next_fx_id += 1;
        track
            .fx_chain
            .push(FxNode::Eq { id, fx: Eq::new(sr, bands) });
        Some(id)
    }

    /// Add a compressor with the given params.
    pub fn add_compressor(
        &mut self,
        track_id: TrackId,
        threshold_db: f32,
        ratio: f32,
        attack_ms: f32,
        release_ms: f32,
        makeup_db: f32,
    ) -> Option<FxId> {
        let sr = self.transport.sample_rate;
        let track = self.tracks.iter_mut().find(|t| t.id == track_id)?;
        let id = FxId(self.next_fx_id);
        self.next_fx_id += 1;
        let mut c = Compressor::new(sr);
        c.threshold_db = threshold_db;
        c.ratio = ratio.max(1.0);
        c.set_attack_ms(attack_ms.clamp(0.1, 1000.0));
        c.set_release_ms(release_ms.clamp(1.0, 5000.0));
        c.makeup_db = makeup_db;
        track.fx_chain.push(FxNode::Compressor {
            id,
            fx: c,
            sidechain_source: None,
        });
        Some(id)
    }

    /// Add a sidechain-driven compressor: target track is compressed by the
    /// signal of `source_track_id`. Same DSP as `add_compressor`, just with
    /// the detector wired to another track's pre-FX tap.
    pub fn add_sidechain_compressor(
        &mut self,
        target_track_id: TrackId,
        source_track_id: TrackId,
        threshold_db: f32,
        ratio: f32,
        attack_ms: f32,
        release_ms: f32,
        makeup_db: f32,
    ) -> Option<FxId> {
        let sr = self.transport.sample_rate;
        // Verify the source exists; the resolver in graph silently drops
        // unknown sources, but we'd rather fail loudly at add time.
        if !self.tracks.iter().any(|t| t.id == source_track_id) {
            return None;
        }
        let track = self
            .tracks
            .iter_mut()
            .find(|t| t.id == target_track_id)?;
        let id = FxId(self.next_fx_id);
        self.next_fx_id += 1;
        let mut c = Compressor::new(sr);
        c.threshold_db = threshold_db;
        c.ratio = ratio.max(1.0);
        c.set_attack_ms(attack_ms.clamp(0.1, 1000.0));
        c.set_release_ms(release_ms.clamp(1.0, 5000.0));
        c.makeup_db = makeup_db;
        track.fx_chain.push(FxNode::Compressor {
            id,
            fx: c,
            sidechain_source: Some(source_track_id),
        });
        Some(id)
    }

    /// Add a tempo-synced stereo delay. `beats` is the delay time in beats
    /// at the current BPM (0.25 = 1/16, 0.5 = 1/8, 1.0 = quarter, etc.).
    pub fn add_delay(
        &mut self,
        track_id: TrackId,
        beats: f32,
        feedback: f32,
        wet: f32,
        ping_pong: f32,
    ) -> Option<FxId> {
        let sr = self.transport.sample_rate;
        let bpm = self.transport.bpm.0 as f32;
        let track = self.tracks.iter_mut().find(|t| t.id == track_id)?;
        let id = FxId(self.next_fx_id);
        self.next_fx_id += 1;
        let mut d = Delay::new(sr, 4.0);
        d.set_time_beats(beats.max(0.001), bpm);
        d.feedback = feedback.clamp(0.0, 0.95);
        d.wet = wet.clamp(0.0, 1.0);
        d.dry = 1.0 - wet.clamp(0.0, 1.0) * 0.5;
        d.ping_pong = ping_pong.clamp(0.0, 1.0);
        track.fx_chain.push(FxNode::Delay { id, fx: d });
        Some(id)
    }

    pub fn remove_fx(&mut self, track_id: TrackId, fx_id: FxId) -> bool {
        if let Some(track) = self.tracks.iter_mut().find(|t| t.id == track_id) {
            let before = track.fx_chain.len();
            track.fx_chain.retain(|f| f.id() != fx_id);
            track.fx_chain.len() != before
        } else {
            false
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
        let frames = out_l.len();
        if self.scratch_l.len() < frames {
            self.scratch_l.resize(frames, 0.0);
            self.scratch_r.resize(frames, 0.0);
        }
        // Keep one tap pair per track; grow/shrink to match the current
        // track count.
        while self.taps_l.len() < self.tracks.len() {
            self.taps_l.push(Vec::new());
            self.taps_r.push(Vec::new());
        }
        while self.taps_l.len() > self.tracks.len() {
            self.taps_l.pop();
            self.taps_r.pop();
        }
        for buf in self.taps_l.iter_mut().chain(self.taps_r.iter_mut()) {
            if buf.len() < frames {
                buf.resize(frames, 0.0);
            }
        }
        self.id_index.clear();
        for (i, t) in self.tracks.iter().enumerate() {
            self.id_index.push((t.id, i));
        }
        graph::process(
            &mut self.transport,
            &mut self.tracks,
            &mut self.taps_l,
            &mut self.taps_r,
            &self.id_index,
            &mut self.scratch_l,
            &mut self.scratch_r,
            out_l,
            out_r,
        );
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
