//! trippy-engine: the Rust DSP core for trippy.
//!
//! Compiles to `cdylib` for WebAssembly (used by the SolidJS PWA via
//! `wasm-bindgen`) and `rlib` for native targets (Tauri desktop, CLI tools,
//! integration tests). The audio graph, transport, and clip engine all live
//! here so the same logic runs unchanged on every surface.

#![deny(unsafe_op_in_unsafe_fn)]
// Pragmatic clippy carve-outs. Each one comes from a deliberate style choice
// in the engine that the lint can't see context for:
// - DSP code routinely keeps `sample_rate` / cached coefficients in structs
//   even when only used at config time, for symmetry across all FX.
// - Test setup builders intentionally use Default + field assignment for
//   readability over struct-literal init.
#![allow(dead_code)]
#![allow(clippy::field_reassign_with_default)]
// `for i in 0..n` indexed loops are clearer than iterator chains when reading
// from multiple parallel arrays (the FDN reverb, the WAV decoder, etc.).
#![allow(clippy::needless_range_loop)]
// 0.7071 etc. show up as test inputs where the literal is what's being tested.
#![allow(clippy::approx_constant)]
// `oldest_age = 0; break;` after voice steal is intentional for clarity.
#![allow(unused_assignments)]
// `n % 2 == 0` reads better than `n.is_multiple_of(2)` in DSP context.
#![allow(clippy::manual_is_multiple_of)]

use wasm_bindgen::prelude::*;

pub mod acid;
pub mod automation;
pub mod clip;
pub mod engine;
pub mod fx;
pub mod graph;
pub mod midi;
pub mod probe;
pub mod recording;
pub mod sampler;
pub mod source;
pub mod stretch;
pub mod track;
pub mod transport;
pub mod warp;
pub mod wasm;
pub mod wav;

/// Engine build version. Bumped per release.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");

/// Smoke-test entry point: returns the engine version string so the web app
/// can confirm the wasm module loaded and is callable.
#[wasm_bindgen]
pub fn engine_version() -> String {
    VERSION.to_string()
}

/// Installs a panic hook that forwards Rust panics to `console.error`.
#[wasm_bindgen(start)]
pub fn _start() {
    #[cfg(feature = "debug")]
    std::panic::set_hook(Box::new(|info| {
        web_sys::console::error_1(&format!("trippy-engine panic: {info}").into());
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_is_non_empty() {
        assert!(!engine_version().is_empty());
    }
}
