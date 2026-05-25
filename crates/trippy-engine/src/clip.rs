//! Clip: an instance of an audio source placed on the timeline.
//!
//! Many clips can reference the same source. A clip has:
//! - `start_frame`: where it begins on the project timeline
//! - `length_frames`: how long it sounds (may be shorter than the source)
//! - `offset_in_source`: how many frames of the source to skip at the start
//! - `gain`: linear amplitude multiplier
//!
//! M1 has no time-stretching: clips play at source rate. M3 introduces
//! per-clip stretch ratios and pitch shift.

use crate::source::SourceHandle;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct ClipId(pub u32);

#[derive(Debug, Clone)]
pub struct Clip {
    pub id: ClipId,
    pub source: SourceHandle,
    pub start_frame: u64,
    pub length_frames: u64,
    pub offset_in_source: u64,
    pub gain: f32,
}

impl Clip {
    /// Frame range `[start, end)` on the project timeline that this clip covers.
    pub fn end_frame(&self) -> u64 {
        self.start_frame.saturating_add(self.length_frames)
    }

    /// Returns `true` if the project frame `t` falls inside this clip.
    pub fn contains(&self, t: u64) -> bool {
        t >= self.start_frame && t < self.end_frame()
    }

    /// Map a project-timeline frame to the corresponding source frame index,
    /// or `None` if the frame is outside the clip or past the end of the source.
    pub fn source_frame(&self, project_frame: u64) -> Option<usize> {
        if !self.contains(project_frame) {
            return None;
        }
        let rel = project_frame - self.start_frame;
        let src_idx = self.offset_in_source.saturating_add(rel);
        if (src_idx as usize) < self.source.frame_count() {
            Some(src_idx as usize)
        } else {
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::source::{AudioSource, ChannelLayout, SourceId};
    use std::sync::Arc;

    fn mk_clip(start: u64, len: u64, offset: u64) -> Clip {
        let src = Arc::new(AudioSource::from_interleaved(
            SourceId(0),
            48_000.0,
            ChannelLayout::Mono,
            &[0.0; 1000],
        ));
        Clip {
            id: ClipId(1),
            source: src,
            start_frame: start,
            length_frames: len,
            offset_in_source: offset,
            gain: 1.0,
        }
    }

    #[test]
    fn contains_boundaries() {
        let c = mk_clip(100, 50, 0);
        assert!(!c.contains(99));
        assert!(c.contains(100));
        assert!(c.contains(149));
        assert!(!c.contains(150));
    }

    #[test]
    fn source_frame_with_offset() {
        let c = mk_clip(100, 50, 200);
        assert_eq!(c.source_frame(100), Some(200));
        assert_eq!(c.source_frame(149), Some(249));
        assert_eq!(c.source_frame(150), None); // past clip end
    }
}
