//! Audio recording: capture stereo input from the host (`getUserMedia` on
//! the web, `cpal` on native) into the engine for monitoring and bouncing
//! to a clip.
//!
//! The engine side is just a ring buffer + a `RecordingClip` finalizer. The
//! host pushes input samples in (typically per-quantum from the AudioWorklet),
//! the engine optionally mixes them into the monitor path, and on stop the
//! buffer is converted into a regular `AudioSource` via `AudioSource::from_*`.

use crate::source::{AudioSource, ChannelLayout, SourceId};
use std::sync::Arc;

pub struct Recorder {
    sample_rate: f32,
    layout: ChannelLayout,
    buffer_l: Vec<f32>,
    buffer_r: Vec<f32>,
    /// True while the recorder is accepting input.
    pub recording: bool,
    /// Whether to also pass input through to the output bus.
    pub monitor: bool,
}

impl Recorder {
    pub fn new(sample_rate: f32, layout: ChannelLayout) -> Self {
        Self {
            sample_rate,
            layout,
            buffer_l: Vec::new(),
            buffer_r: Vec::new(),
            recording: false,
            monitor: true,
        }
    }

    pub fn start(&mut self) {
        self.buffer_l.clear();
        self.buffer_r.clear();
        self.recording = true;
    }

    pub fn stop(&mut self) {
        self.recording = false;
    }

    /// Push input samples. Called once per audio block by the host.
    pub fn push(&mut self, l: &[f32], r: &[f32]) {
        if !self.recording {
            return;
        }
        match self.layout {
            ChannelLayout::Mono => {
                // Average L+R into the mono buffer.
                debug_assert_eq!(l.len(), r.len());
                for i in 0..l.len() {
                    self.buffer_l.push((l[i] + r[i]) * 0.5);
                }
            }
            ChannelLayout::Stereo => {
                self.buffer_l.extend_from_slice(l);
                self.buffer_r.extend_from_slice(r);
            }
        }
    }

    /// Mix the most recent block of input into the output for monitoring.
    pub fn monitor_into(&self, out_l: &mut [f32], out_r: &mut [f32]) {
        if !self.monitor || !self.recording {
            return;
        }
        let n = out_l.len();
        let take = n.min(self.buffer_l.len());
        let start = self.buffer_l.len() - take;
        for i in 0..take {
            out_l[i] += self.buffer_l[start + i];
            if self.layout == ChannelLayout::Stereo {
                out_r[i] += self.buffer_r[start + i];
            } else {
                out_r[i] += self.buffer_l[start + i];
            }
        }
    }

    /// Bounce the recorded buffer to a fresh AudioSource.
    pub fn bounce(&self, id: SourceId) -> AudioSource {
        match self.layout {
            ChannelLayout::Mono => AudioSource {
                id,
                sample_rate: self.sample_rate,
                layout: ChannelLayout::Mono,
                channels: vec![self.buffer_l.clone()],
            },
            ChannelLayout::Stereo => AudioSource {
                id,
                sample_rate: self.sample_rate,
                layout: ChannelLayout::Stereo,
                channels: vec![self.buffer_l.clone(), self.buffer_r.clone()],
            },
        }
    }

    pub fn frame_count(&self) -> usize {
        self.buffer_l.len()
    }

    pub fn bounce_handle(&self, id: SourceId) -> Arc<AudioSource> {
        Arc::new(self.bounce(id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_buffers_only_while_recording() {
        let mut r = Recorder::new(48_000.0, ChannelLayout::Stereo);
        r.push(&[0.1; 8], &[0.2; 8]);
        assert_eq!(r.frame_count(), 0);
        r.start();
        r.push(&[0.1; 8], &[0.2; 8]);
        assert_eq!(r.frame_count(), 8);
        r.stop();
        r.push(&[0.5; 4], &[0.5; 4]);
        assert_eq!(r.frame_count(), 8);
    }

    #[test]
    fn bounce_produces_audio_source() {
        let mut r = Recorder::new(48_000.0, ChannelLayout::Stereo);
        r.start();
        r.push(&[0.1; 16], &[0.2; 16]);
        let src = r.bounce(SourceId(7));
        assert_eq!(src.id, SourceId(7));
        assert_eq!(src.frame_count(), 16);
        assert!((src.channels[0][0] - 0.1).abs() < 1e-6);
        assert!((src.channels[1][0] - 0.2).abs() < 1e-6);
    }
}
