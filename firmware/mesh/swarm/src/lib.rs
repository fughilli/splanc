// Ported from fughilli/indoor_localization swarm/net/src/lib.rs at 5a906e78 (Splanc owns this
// copy; firmware/mesh/swarm/PROVENANCE.md lists what changed).
//! Swarm network (firmware/mesh/swarm/docs/swarm-network.md): mesh packets with managed
//! flooding, authenticated settings, signed firmware manifests, and the
//! page-by-page firmware distribution protocol. no_std, no allocation: the
//! firmware owns the radio and the flash (Splanc: through the backhaul seam in
//! //firmware/mesh; upstream's C ABI, ffi.rs, is not ported); every format is a
//! swarm.v1 protobuf message (wire.rs, firmware/mesh/swarm/docs/swarm-wire.md);
//! this crate decides what to store, what to ask neighbours for and what to
//! send them. Host tests run whole swarms of it over a lossy channel.
#![cfg_attr(not(test), no_std)]

pub mod crypto;
pub mod manifest;
pub mod mesh;
pub mod net;
pub mod settings;
pub mod update;
pub mod wire;
#[cfg(test)]
mod budget;
#[cfg(test)]
mod golden;

pub use manifest::Manifest;
pub use mesh::{Mesh, MeshConfig, MeshOf};
pub use net::{Net, NetOf};
pub use update::{Flash, Status, Updater};
