//! Splanc mesh on a Linux radio (docs/design/mesh-pi-transport.md): a Raspberry Pi (or any
//! Linux host) as a full mesh node.
//!
//! - [`frame`]: the Splanc 802.11 action frame (design §4.1), byte-identical to the C6's.
//! - [`radio`]: raw radios — monitor-mode injection ([`radio::Monitor`], mac80211 USB
//!   adapters), nl80211 management frames ([`radio::Nl80211Mgmt`]) and brcmfmac's firmware
//!   `actframe` through its vendor command ([`radio::BrcmActframe`], the Pi's own radio).
//! - [`udp`]: the IP backhaul (M10) with the same frames in UDP datagrams.
//! - [`serial`]: a USB-attached ESP32-C6 as the radio coprocessor.
//! - [`WifiBackhaul`]: the mesh's `Backhaul` over any of them.
//!
//! std, Linux. No dependencies beyond the mesh crates (libc calls are declared in [`sys`]).

pub mod frame;
pub mod nl80211;
pub mod radio;
pub mod radiotap;
pub mod serial;
pub mod sys;
pub mod udp;
pub mod wifi;

pub use radio::{RawRadio, RawRx};
pub use wifi::{WifiBackhaul, WifiConfig, WifiStats};

#[cfg(test)]
mod tests;
