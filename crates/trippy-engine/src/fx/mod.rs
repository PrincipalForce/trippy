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
