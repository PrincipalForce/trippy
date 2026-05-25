//! Simple polyphonic sampler instrument.
//!
//! Maps MIDI notes to source audio (one source per note, or one source pitched
//! across keys via WSOLA/resampling). Voice allocation is round-robin with
//! steal-oldest when polyphony is exceeded. This is the M6 baseline; a
//! sample-mapped multi-zone instrument with velocity layers follows in M7.

use crate::source::SourceHandle;

const MAX_VOICES: usize = 32;

#[derive(Debug, Clone, Copy)]
struct Voice {
    active: bool,
    note: u8,
    velocity: f32,
    /// Playback cursor within the source, in source frames.
    cursor: f64,
    /// Sample-rate ratio: how fast to advance the cursor per output sample
    /// (combines pitch shift + source vs. output rate).
    rate: f64,
    age: u64,
}

impl Default for Voice {
    fn default() -> Self {
        Self {
            active: false,
            note: 0,
            velocity: 0.0,
            cursor: 0.0,
            rate: 1.0,
            age: 0,
        }
    }
}

pub struct Sampler {
    sample_rate: f32,
    /// One source per MIDI note (0..128). `None` means the note isn't mapped.
    map: Vec<Option<SourceHandle>>,
    /// Root note for the mapped source — used to compute pitch rate for
    /// neighboring notes via 12-TET when the explicit slot is empty.
    pub root_note: u8,
    /// Fallback source used for notes that aren't directly mapped — pitched
    /// from `root_note` via resampling.
    pub fallback: Option<SourceHandle>,
    voices: [Voice; MAX_VOICES],
    voice_counter: u64,
}

impl Sampler {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            sample_rate,
            map: (0..128).map(|_| None).collect(),
            root_note: 60,
            fallback: None,
            voices: [Voice::default(); MAX_VOICES],
            voice_counter: 0,
        }
    }

    /// Map a source to a specific note (0..127).
    pub fn map_note(&mut self, note: u8, source: SourceHandle) {
        if (note as usize) < self.map.len() {
            self.map[note as usize] = Some(source);
        }
    }

    /// Set the fallback source (pitched to root_note) used for unmapped notes.
    pub fn set_fallback(&mut self, source: SourceHandle, root_note: u8) {
        self.fallback = Some(source);
        self.root_note = root_note;
    }

    pub fn note_on(&mut self, note: u8, velocity: u8) {
        let (source, rate) =
            if let Some(direct) = self.map.get(note as usize).and_then(|x| x.clone()) {
                // Source is exactly at root pitch by design when stored directly.
                let r = direct.sample_rate / self.sample_rate;
                (Some(direct), r as f64)
            } else if let Some(fb) = self.fallback.clone() {
                // Resample for pitch: ratio = 2^(semitones/12).
                let semis = (note as i32 - self.root_note as i32) as f32;
                let pitch = 2f32.powf(semis / 12.0);
                let rate = (fb.sample_rate / self.sample_rate * pitch) as f64;
                (Some(fb), rate)
            } else {
                (None, 1.0)
            };
        let Some(_src) = source.as_ref() else { return };

        // Pick a voice: prefer inactive, else steal oldest.
        let mut chosen = 0_usize;
        let mut oldest_age = u64::MAX;
        let mut found_inactive = false;
        for (i, v) in self.voices.iter().enumerate() {
            if !v.active {
                chosen = i;
                found_inactive = true;
                break;
            }
            if v.age < oldest_age {
                oldest_age = v.age;
                chosen = i;
            }
        }
        let _ = found_inactive;
        self.voice_counter += 1;
        self.voices[chosen] = Voice {
            active: true,
            note,
            velocity: velocity as f32 / 127.0,
            cursor: 0.0,
            rate,
            age: self.voice_counter,
        };
        // Borrow source into voice via separate storage? For simplicity we
        // re-resolve per process(). This avoids lifetime/Arc clones in the
        // hot path beyond what's already paid for at note_on.
    }

    pub fn note_off(&mut self, note: u8) {
        for v in self.voices.iter_mut() {
            if v.active && v.note == note {
                // Simple release: deactivate immediately. A proper ADSR
                // arrives in M7 along with velocity-layer support.
                v.active = false;
            }
        }
    }

    pub fn all_notes_off(&mut self) {
        for v in self.voices.iter_mut() {
            v.active = false;
        }
    }

    fn voice_source(&self, v: &Voice) -> Option<&SourceHandle> {
        self.map
            .get(v.note as usize)
            .and_then(|s| s.as_ref())
            .or(self.fallback.as_ref())
    }

    pub fn process(&mut self, out_l: &mut [f32], out_r: &mut [f32]) {
        for s in out_l.iter_mut() {
            *s = 0.0;
        }
        for s in out_r.iter_mut() {
            *s = 0.0;
        }
        let n = out_l.len();
        for v_idx in 0..MAX_VOICES {
            if !self.voices[v_idx].active {
                continue;
            }
            // Take a snapshot to satisfy the borrow checker — we read source
            // immutably and mutate voice cursor.
            let src = match self.voice_source(&self.voices[v_idx]) {
                Some(s) => s.clone(),
                None => {
                    self.voices[v_idx].active = false;
                    continue;
                }
            };
            let chans = &src.channels;
            let frame_count = src.frame_count();
            let v = &mut self.voices[v_idx];
            let amp = v.velocity;
            for i in 0..n {
                let idx = v.cursor.floor() as usize;
                if idx >= frame_count.saturating_sub(1) {
                    v.active = false;
                    break;
                }
                let frac = (v.cursor - idx as f64) as f32;
                let (sl, sr) = match chans.len() {
                    1 => {
                        let a = chans[0][idx];
                        let b = chans[0][idx + 1];
                        let s = a + (b - a) * frac;
                        (s, s)
                    }
                    2 => {
                        let al = chans[0][idx];
                        let bl = chans[0][idx + 1];
                        let ar = chans[1][idx];
                        let br = chans[1][idx + 1];
                        (al + (bl - al) * frac, ar + (br - ar) * frac)
                    }
                    _ => (0.0, 0.0),
                };
                out_l[i] += sl * amp;
                out_r[i] += sr * amp;
                v.cursor += v.rate;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{AudioSource, ChannelLayout, SourceId};
    use std::sync::Arc;

    fn mono_source() -> SourceHandle {
        Arc::new(AudioSource {
            id: SourceId(1),
            sample_rate: 48_000.0,
            layout: ChannelLayout::Mono,
            channels: vec![vec![0.5; 1000]],
        })
    }

    #[test]
    fn note_on_then_off_silences_voice() {
        let mut s = Sampler::new(48_000.0);
        s.set_fallback(mono_source(), 60);
        s.note_on(60, 100);
        let mut l = vec![0.0; 64];
        let mut r = vec![0.0; 64];
        s.process(&mut l, &mut r);
        assert!(
            l.iter().any(|&x| x.abs() > 0.0),
            "expected sound after note_on"
        );
        s.note_off(60);
        let mut l2 = vec![0.0; 64];
        let mut r2 = vec![0.0; 64];
        s.process(&mut l2, &mut r2);
        assert!(
            l2.iter().all(|&x| x == 0.0),
            "expected silence after note_off"
        );
    }

    #[test]
    fn unmapped_note_with_no_fallback_is_silent() {
        let mut s = Sampler::new(48_000.0);
        s.note_on(60, 100);
        let mut l = vec![0.0; 64];
        let mut r = vec![0.0; 64];
        s.process(&mut l, &mut r);
        assert!(l.iter().all(|&x| x == 0.0));
    }
}
