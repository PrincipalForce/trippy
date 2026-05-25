//! wasm-bindgen surface — the JS-callable facade for the engine.
//!
//! Wraps `crate::engine::Engine` in opaque handle types so JS code can drive
//! the engine without touching internals. Audio buffers are passed as
//! `Float32Array` slices (`&mut [f32]`), giving zero-copy access between
//! JS and Rust memory.

use wasm_bindgen::prelude::*;

use crate::engine::Engine;
use crate::source::ChannelLayout;
use crate::wav;

/// Opaque engine handle.
#[wasm_bindgen]
pub struct WasmEngine {
    inner: Engine,
}

#[wasm_bindgen]
impl WasmEngine {
    /// Construct a new engine for the given output sample rate (Hz).
    #[wasm_bindgen(constructor)]
    pub fn new(sample_rate: f32) -> Self {
        Self {
            inner: Engine::new(sample_rate),
        }
    }

    // ----- sources -----

    /// Add an interleaved audio source (mono or stereo). Returns the source id.
    #[wasm_bindgen(js_name = addSource)]
    pub fn add_source(
        &mut self,
        sample_rate: f32,
        channels: u16,
        interleaved: &[f32],
    ) -> Result<u32, JsError> {
        let layout = ChannelLayout::from_count(channels)
            .ok_or_else(|| JsError::new(&format!("unsupported channels: {channels}")))?;
        Ok(self
            .inner
            .add_source_interleaved(sample_rate, layout, interleaved)
            .0)
    }

    /// Add a source by decoding a RIFF/WAVE byte buffer.
    /// Returns `{ sourceId, sampleRate, channels, frameCount }` as a JSON string.
    #[wasm_bindgen(js_name = addSourceFromWav)]
    pub fn add_source_from_wav(&mut self, bytes: &[u8]) -> Result<String, JsError> {
        let decoded = wav::decode_wav(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        let layout = ChannelLayout::from_count(decoded.channels)
            .ok_or_else(|| JsError::new(&format!("unsupported channels: {}", decoded.channels)))?;
        let frames = decoded.samples.first().map(|c| c.len()).unwrap_or(0);
        let id = self.inner.add_source_deinterleaved(
            decoded.sample_rate as f32,
            layout,
            decoded.samples,
        );
        Ok(format!(
            "{{\"sourceId\":{},\"sampleRate\":{},\"channels\":{},\"frameCount\":{}}}",
            id.0, decoded.sample_rate, decoded.channels, frames
        ))
    }

    #[wasm_bindgen(js_name = removeSource)]
    pub fn remove_source(&mut self, source_id: u32) -> bool {
        self.inner.remove_source(crate::source::SourceId(source_id))
    }

    // ----- tracks -----

    /// Add a new track. Returns the track id.
    #[wasm_bindgen(js_name = addTrack)]
    pub fn add_track(&mut self) -> u32 {
        self.inner.add_track().0
    }

    #[wasm_bindgen(js_name = removeTrack)]
    pub fn remove_track(&mut self, track_id: u32) -> bool {
        self.inner.remove_track(crate::track::TrackId(track_id))
    }

    #[wasm_bindgen(js_name = setTrackGain)]
    pub fn set_track_gain(&mut self, track_id: u32, gain: f32) -> bool {
        match self.inner.track_mut(crate::track::TrackId(track_id)) {
            Some(t) => {
                t.gain = gain;
                true
            }
            None => false,
        }
    }

    #[wasm_bindgen(js_name = setTrackPan)]
    pub fn set_track_pan(&mut self, track_id: u32, pan: f32) -> bool {
        match self.inner.track_mut(crate::track::TrackId(track_id)) {
            Some(t) => {
                t.pan = pan;
                true
            }
            None => false,
        }
    }

    #[wasm_bindgen(js_name = setTrackMute)]
    pub fn set_track_mute(&mut self, track_id: u32, mute: bool) -> bool {
        match self.inner.track_mut(crate::track::TrackId(track_id)) {
            Some(t) => {
                t.mute = mute;
                true
            }
            None => false,
        }
    }

    #[wasm_bindgen(js_name = setTrackSolo)]
    pub fn set_track_solo(&mut self, track_id: u32, solo: bool) -> bool {
        match self.inner.track_mut(crate::track::TrackId(track_id)) {
            Some(t) => {
                t.solo = solo;
                true
            }
            None => false,
        }
    }

    // ----- clips -----

    /// Add a clip. Pass `length_frames = 0` to use the full remaining source length.
    #[wasm_bindgen(js_name = addClip)]
    pub fn add_clip(
        &mut self,
        track_id: u32,
        source_id: u32,
        start_frame: u64,
        length_frames: u64,
        offset_in_source: u64,
    ) -> Result<u32, JsError> {
        let len = if length_frames == 0 {
            None
        } else {
            Some(length_frames)
        };
        self.inner
            .add_clip(
                crate::track::TrackId(track_id),
                crate::source::SourceId(source_id),
                start_frame,
                len,
                offset_in_source,
            )
            .map(|id| id.0)
            .ok_or_else(|| JsError::new("unknown track or source"))
    }

    #[wasm_bindgen(js_name = removeClip)]
    pub fn remove_clip(&mut self, track_id: u32, clip_id: u32) -> bool {
        self.inner.remove_clip(
            crate::track::TrackId(track_id),
            crate::clip::ClipId(clip_id),
        )
    }

    // ----- transport -----

    pub fn play(&mut self) {
        self.inner.play();
    }
    pub fn stop(&mut self) {
        self.inner.stop();
    }
    #[wasm_bindgen(js_name = setPosition)]
    pub fn set_position(&mut self, frame: f64) {
        self.inner.set_position(frame as u64);
    }
    #[wasm_bindgen(js_name = setBpm)]
    pub fn set_bpm(&mut self, bpm: f64) {
        self.inner.set_bpm(bpm);
    }
    #[wasm_bindgen(js_name = setLoop)]
    pub fn set_loop(&mut self, start: f64, end: f64) {
        self.inner.set_loop(start as u64, end as u64);
    }
    #[wasm_bindgen(js_name = clearLoop)]
    pub fn clear_loop(&mut self) {
        self.inner.clear_loop();
    }

    #[wasm_bindgen(js_name = isPlaying)]
    pub fn is_playing(&self) -> bool {
        self.inner.transport.playing
    }

    #[wasm_bindgen(js_name = positionFrames)]
    pub fn position_frames(&self) -> f64 {
        self.inner.transport.position_frames as f64
    }

    #[wasm_bindgen(js_name = sampleRate)]
    pub fn sample_rate(&self) -> f32 {
        self.inner.transport.sample_rate
    }

    /// Render `out_l.len()` frames of stereo audio. `out_r.len()` must match.
    ///
    /// The two slices alias JS `Float32Array` memory; mutations are visible
    /// to JS without a copy. Allocation-free hot path.
    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32]) -> Result<(), JsError> {
        if out_l.len() != out_r.len() {
            return Err(JsError::new("out_l and out_r length mismatch"));
        }
        self.inner.process(out_l, out_r);
        Ok(())
    }
}
