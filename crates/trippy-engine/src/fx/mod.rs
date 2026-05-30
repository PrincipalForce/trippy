//! Built-in audio effects.
//!
//! All FX implement the `Fx` trait: stateful, sample-accurate, stereo
//! `process_inplace` over interleaved-as-planar buffers. The audio thread
//! never allocates. Parameter updates are stored as plain fields; smoothing
//! happens internally via one-pole filters where necessary.
//!
//! Modules:
//! - [`biquad`] — biquad filter primitive (LP/HP/BP/peak/shelf)
//! - [`eq`] — multi-band parametric EQ built from biquads
//! - [`compressor`] — feedforward soft-knee compressor with sidechain
//! - [`delay`] — stereo delay with feedback and tap-locked sync
//! - [`reverb`] — FDN (feedback delay network) reverb
//! - [`saturation`] — soft-clip saturation with drive

pub mod biquad;
pub mod compressor;
pub mod delay;
pub mod eq;
pub mod reverb;
pub mod saturation;

/// All FX implement this trait. `l`/`r` are stereo channels; both must be
/// the same length. Processing is in-place.
pub trait Fx {
    fn process(&mut self, l: &mut [f32], r: &mut [f32]);
    fn reset(&mut self) {}
}

/// Stable id for an FX node inside a track's chain. Unique per engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct FxId(pub u32);

/// Polymorphism without `dyn`. An enum dispatch keeps the audio thread
/// allocation-free, lets `process` inline well, and gives us cheap
/// pattern-matching for per-kind parameter updates from the wasm bridge.
pub enum FxNode {
    Eq { id: FxId, fx: eq::Eq },
    Compressor { id: FxId, fx: compressor::Compressor },
    Delay { id: FxId, fx: delay::Delay },
}

impl FxNode {
    pub fn id(&self) -> FxId {
        match self {
            FxNode::Eq { id, .. } | FxNode::Compressor { id, .. } | FxNode::Delay { id, .. } => *id,
        }
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        match self {
            FxNode::Eq { fx, .. } => fx.process(l, r),
            FxNode::Compressor { fx, .. } => fx.process(l, r),
            FxNode::Delay { fx, .. } => fx.process(l, r),
        }
    }

    pub fn reset(&mut self) {
        match self {
            FxNode::Eq { fx, .. } => fx.reset(),
            FxNode::Compressor { fx, .. } => fx.reset(),
            FxNode::Delay { fx, .. } => fx.reset(),
        }
    }
}

impl std::fmt::Debug for FxNode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FxNode::Eq { id, .. } => f.debug_struct("Eq").field("id", id).finish_non_exhaustive(),
            FxNode::Compressor { id, .. } => {
                f.debug_struct("Compressor").field("id", id).finish_non_exhaustive()
            }
            FxNode::Delay { id, .. } => {
                f.debug_struct("Delay").field("id", id).finish_non_exhaustive()
            }
        }
    }
}
