//! Splanc firmware update core (docs/design/ota.md): the signed manifest (the
//! swarm loader's format), the resumable receive session, the loader's boot
//! decision, the app's health and crash-loop rules, and the OTA arms of the
//! player protocol. no_std, zero dependencies, host-tested; the loader and the
//! app reach it from C++ through [`capi`] (firmware/ota/ota_ffi.h).

#![no_std]

pub mod boot;
pub mod capi;
pub mod image;
pub mod keyring;
pub mod manifest;
pub mod session;
pub mod sha256;
pub mod wire;
