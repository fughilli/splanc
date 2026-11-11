//! Ethernet + network LED outputs for the P4 player
//! (docs/design/p4-ethernet-ddp.md).
//!
//! The pieces the firmware's C++ (`firmware/player_app/eth_p4.cpp`,
//! `net_output.cpp`) needs that are pure logic, so they are `no_std`,
//! dependency-free and host-tested:
//!
//! * [`config`]: the Ethernet config and the network outputs, their validation
//!   and their flash blob.
//! * [`wire`]: the hand-coded protocol arms 95-98 and replies 53-54
//!   (`tests/wire.rs` checks every field number against the generated host
//!   bindings, like `//firmware/ota:wire_test`).
//! * [`ddp`]: DDP packets, byte for byte the format of the Mac host player
//!   (`pi/player_rs/src/output.rs`).
//! * [`wled`]: what discovery reads from a WLED board's `/json/info`.
//! * [`capi`]: the C ABI, declared in `netout_ffi.h`.
#![no_std]

pub mod capi;
pub mod config;
pub mod ddp;
pub mod pb;
pub mod wire;
pub mod wled;
