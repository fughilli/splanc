//! LED Mapper — Raspberry Pi player app (Rust).
//!
//! A native-Rust reimplementation of the Pi player that REUSES the firmware's
//! `ledmapper_player` protocol/effects core directly (as a crate dependency, no
//! FFI) and adds only the Pi platform layer: LED wire framing + render loop,
//! WS+TLS transport, and filesystem persistence. It is the aarch64/std sibling
//! of `firmware/player_app` (which is the same Rust core behind a C++ shell).
//!
//! Phase 1 is this wire-framing layer — a byte-exact port of the Python
//! `pi/led_driver/led_driver/{fpga_spi,spi}.py` it replaces, pinned by the same
//! encoder vectors.

pub mod wire;

pub use wire::{apa102, FpgaCodec, Rgb, GRB};
