//! MIDI event types and a sample-accurate event queue.
//!
//! Trippy uses a compact, allocation-light event format. Each event carries
//! the project-frame at which it should fire, a status byte, and up to two
//! data bytes. Channel info is encoded in the low nibble of the status.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct MidiEvent {
    pub frame: u64,
    pub status: u8,
    pub data1: u8,
    pub data2: u8,
}

impl MidiEvent {
    pub fn note_on(frame: u64, channel: u8, note: u8, velocity: u8) -> Self {
        Self {
            frame,
            status: 0x90 | (channel & 0x0F),
            data1: note & 0x7F,
            data2: velocity & 0x7F,
        }
    }

    pub fn note_off(frame: u64, channel: u8, note: u8) -> Self {
        Self {
            frame,
            status: 0x80 | (channel & 0x0F),
            data1: note & 0x7F,
            data2: 0,
        }
    }

    pub fn channel(&self) -> u8 {
        self.status & 0x0F
    }
    pub fn kind(&self) -> u8 {
        self.status & 0xF0
    }
    pub fn is_note_on(&self) -> bool {
        self.kind() == 0x90 && self.data2 > 0
    }
    pub fn is_note_off(&self) -> bool {
        self.kind() == 0x80 || (self.kind() == 0x90 && self.data2 == 0)
    }
}

/// A simple sample-frame-sorted event list. `push` keeps order via
/// partition_point; cheap for the typical near-sequential edit pattern.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MidiTrack {
    pub events: Vec<MidiEvent>,
}

impl MidiTrack {
    pub fn push(&mut self, e: MidiEvent) {
        let pos = self.events.partition_point(|x| x.frame <= e.frame);
        self.events.insert(pos, e);
    }

    /// Iterator over events in `[start, end)`.
    pub fn range(&self, start: u64, end: u64) -> impl Iterator<Item = &MidiEvent> {
        let lo = self.events.partition_point(|x| x.frame < start);
        let hi = self.events.partition_point(|x| x.frame < end);
        self.events[lo..hi].iter()
    }
}

/// Convert a MIDI note number to frequency in Hz (A4 = 69 = 440 Hz).
pub fn note_to_freq(note: u8) -> f32 {
    440.0 * 2f32.powf((note as f32 - 69.0) / 12.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn note_a4_is_440hz() {
        assert!((note_to_freq(69) - 440.0).abs() < 1e-3);
    }

    #[test]
    fn note_on_has_correct_status() {
        let e = MidiEvent::note_on(1000, 3, 60, 100);
        assert_eq!(e.kind(), 0x90);
        assert_eq!(e.channel(), 3);
        assert!(e.is_note_on());
    }

    #[test]
    fn zero_velocity_note_on_is_note_off() {
        let e = MidiEvent::note_on(0, 0, 60, 0);
        assert!(e.is_note_off());
        assert!(!e.is_note_on());
    }

    #[test]
    fn push_keeps_order() {
        let mut t = MidiTrack::default();
        t.push(MidiEvent::note_on(100, 0, 60, 100));
        t.push(MidiEvent::note_on(50, 0, 62, 100));
        t.push(MidiEvent::note_on(200, 0, 64, 100));
        assert_eq!(t.events[0].frame, 50);
        assert_eq!(t.events[1].frame, 100);
        assert_eq!(t.events[2].frame, 200);
    }

    #[test]
    fn range_returns_only_window() {
        let mut t = MidiTrack::default();
        for f in [10_u64, 50, 100, 200, 500] {
            t.push(MidiEvent::note_on(f, 0, 60, 100));
        }
        let in_range: Vec<u64> = t.range(50, 200).map(|e| e.frame).collect();
        assert_eq!(in_range, vec![50, 100]);
    }
}
