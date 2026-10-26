//! Splanc MAX over-the-air updates (docs/design/max-ota.md): a MAX (Raspberry Pi
//! + Tang Nano 9K FPGA) updates the way a C6 fixture does — "Update over Wi-Fi",
//! the agent's `update_firmware`, the bridge — but the update is a whole NixOS
//! system (closure) that the Pi downloads itself, boots ONCE, and keeps only if
//! the player proves healthy; otherwise U-Boot's default (the old system) comes
//! back by itself, across resets and power cuts.
//!
//! * [`verify`]: the C6's signed 108-byte manifest, checked against the MAX ring
//!   (key ids 3 `max` and 4 `max_backup` only) and the board in flags bits 24..31.
//! * [`image`]: the `.nixclosure` header + zstd `nix-store --export` payload.
//! * [`updater`]: the state machine (download, import, stage the one-shot trial,
//!   boot reconcile, health, commit, roll back) over the [`updater::Sys`] seam;
//!   [`linux`] is the real Pi.
//! * [`state`], [`kv`]: the persistent state / request / health files.
//!
//! The player (pi/player_rs) links this crate for its OTA arms; the root updater
//! is the `splanc-max-ota` binary (src/main.rs), run by pi/provisioning/nix/ota.nix.

pub mod board;
pub mod extlinux;
pub mod health;
pub mod image;
pub mod kv;
pub mod linux;
pub mod ring;
pub mod state;
pub mod updater;
pub mod verify;

/// The keyring this build trusts (generated from firmware/ota/keys; `--//firmware/
/// ota:trust=test` swaps in the checked-in TEST key).
pub fn ring() -> &'static verify::Ring {
    ring::RING
}

/// True when this build trusts the public TEST key (HITL/dev images only).
pub fn test_trust() -> bool {
    ring::RING.iter().any(|(_, name, _)| name.starts_with("test"))
}
