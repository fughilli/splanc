//! `td_ledmapper` — the native core of the TouchDesigner custom operators that
//! stream video textures and drive shader uniforms on `ledmapper.v1` fixtures.
//!
//! The C++ TOP/CHOP shims (`tools/touchdesigner/plugin`) are thin: they read
//! TouchDesigner's input pixels/channels and forward everything here through the
//! [`ffi`] C ABI. All protocol, encoding, discovery and networking live in this
//! crate so they can be unit-tested on the host without TouchDesigner.
//!
//! Modules:
//! - [`proto`]     — hand-rolled protobuf for the `ledmapper.v1` envelope arms.
//! - [`texture`]   — RGBA/BGRA → quantized + delta + RLE `set_texture` codec.
//! - [`manifest`]  — parse the effect uniform manifest JSON.
//! - [`ws`]        — a tiny RFC 6455 WebSocket client.
//! - [`discovery`] — probe the LAN for fixtures.
//! - [`client`]    — a non-blocking background fixture [`client::Session`].
//! - [`ffi`]       — the C ABI the C++ plugin links against.

pub mod client;
pub mod discovery;
pub mod ffi;
pub mod manifest;
pub mod proto;
pub mod texture;
pub mod ws;
