//! `fx_gpu` — a feasibility prototype for lowering the splanc FX engine's
//! per-LED `shade()` kernel onto GPUs (docs/design/fx-gpu-lowering.md).
//!
//! Pipeline: `.fxb` bytecode → [`lower`] (macro IR) → [`legalize`] (primitive
//! IR for a numerics [`Profile`]) → either [`eval`] (host reference for the GPU
//! result) or [`emit_glsl`] (GLSL ES 1.00 / 3.10, which glslang turns into
//! SPIR-V). The VM (`fx_vm`) stays the semantic reference; the conformance
//! harness compares [`eval`] against it within tolerance (see `tests/`).
//!
//! This is a host-only crate (`std`); it is NOT linked into firmware or the
//! Pi player. It covers the pure per-LED arithmetic / trig / colour subset and
//! refuses the rest (user functions, buffers/textures, graph queries, loops),
//! which stay on the VM.

pub mod bench;
pub mod emit_glsl;
pub mod eval;
pub mod ir;
pub mod kernel;
pub mod legalize;
pub mod lower;

pub use legalize::Profile;

/// Lower a parsed program's `shade()` and legalize it for `prof`, returning the
/// primitive graph + RGB roots, or why it could not be lowered.
pub fn compile_shade(
    prog: &ledmapper_fx_vm::Program,
    prof: Profile,
) -> Result<(ir::Graph, [ir::NodeId; 3], bool), lower::Unsupported> {
    let lo = lower::lower_shade(prog)?;
    let (g, roots) = legalize::legalize(&lo.g, &lo.rgb, prof);
    Ok((g, [roots[0], roots[1], roots[2]], lo.raw_rgb))
}
