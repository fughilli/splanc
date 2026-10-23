//! FX perf-study bench (docs/design/fx-perf-study.md).
//!
//! A standalone C6 image (no WiFi/BLE/TLS — nothing on the core but this) that
//! answers "how far is the effects VM from the hardware ceiling?" with cycle
//! counts measured on the chip:
//!
//! - **study** effects run three ways on the same synthetic fixture (a 3-D helix
//!   with a chained topology, 500 and 2048 LEDs): the fx_vm interpreter, the
//!   interpreter + the on-device RV32 JIT (exactly the firmware's install path),
//!   and hand-written native Rust (`native.rs`: a float twin that follows the
//!   VM's math, and where it makes sense a fixed-point rewrite). Every LED's RGB
//!   is cross-checked native-vs-VM.
//! - **agent** effects (tools/fx_agent_eval output) run VM + JIT at 500 LEDs.
//! - **valid** programs (fx_bench calibration programs, `--no-opt`, linear map)
//!   re-measure known goldens so this bench's numbers can be tied to fx_bench's.
//! - **micro** benchmarks (`micro.rs`) price the VM's building blocks: dispatch,
//!   stack traffic, soft-float primitives, the transcendental implementations.
//!
//! The same crate builds for the host (`rust_test`), where the native-vs-VM
//! check runs without hardware and the op counts are gathered.
#![cfg_attr(not(test), no_std)]

pub mod engine;
pub mod fastfloat;
pub mod fixture;
pub mod native;

#[cfg(target_arch = "riscv32")]
pub mod device;
#[cfg(target_arch = "riscv32")]
pub mod micro;

mod effects_gen;
#[cfg(test)]
mod host_test;
pub use effects_gen::EFFECTS;

/// One embedded effect, from gen_effects.rs.
pub struct EffectDesc {
    pub name: &'static str,
    /// 0 study, 1 agent, 2 valid, 3 micro, 4 user (the user's library).
    pub group: u8,
    /// 0 = the group's default LED sweep, else a fixed count.
    pub leds: u16,
    pub opt: bool,
    pub fxb: &'static [u8],
    pub uniforms: &'static [(u8, &'static [f32])],
    /// Compile diagnostics (empty fxb) — reported, never run.
    pub err: &'static str,
}

pub const GROUP_STUDY: u8 = 0;
pub const GROUP_AGENT: u8 = 1;
pub const GROUP_VALID: u8 = 2;
pub const GROUP_USER: u8 = 4;
