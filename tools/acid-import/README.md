# acid-import

CLI for batch-reading ACID chunks out of `.wav` files and emitting trippy
clip metadata (root note, slices, beat count, tempo).

Useful when migrating an existing ACID sample library into a trippy project
without round-tripping through the UI.

**Status:** placeholder. The chunk-parsing logic already exists in the engine
crate at `crates/trippy-engine/src/acid.rs`; this tool will be a thin wrapper
around it with directory-walking and JSON output. Targeted for M3 polish.
