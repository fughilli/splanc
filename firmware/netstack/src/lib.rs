//! A heapless WiFi + BLE + coexistence network stack for the ESP32-C6.
//!
//! The crate is `no_std` and allocation-free: every buffer, ring, and table is
//! sized at compile time, and the protocol parsers are bounded by their input.
//! It provides the 802.11 RX/TX path, the BLE (HCI/L2CAP/ATT/GATT) path, the
//! MLME/GAP role state machines, a static WiFi/BT coexistence arbiter, and the
//! ESP32-C6 MAC/PHY register map used by the low-level driver layers.
//!
//! # Design principles
//!
//! * **Capacity-typed buffers.** Values live in a `Buf<const N: usize>` whose
//!   capacity is part of its type; appends are bounds-checked and return
//!   `Err(Overflow)` rather than overrunning.
//! * **Bounded parsers.** IE/TLV/PDU iterators are total functions over a byte
//!   slice: each step is bounded by the remaining length, and malformed input
//!   yields `Err`/`None` instead of reading past the buffer.
//! * **Fixed pools and rings.** RX/TX frames land in fixed-size slot rings;
//!   exhaustion applies back-pressure (drops/refuses) rather than allocating.
//! * **Static tables.** The AP station table and the GATT attribute table are
//!   fixed arrays, so a flood is bounded back-pressure, not memory growth.
//! * **Deterministic memory.** Total RAM is a compile-time constant — the sum of
//!   the pools — with no fragmentation.
//!
//! # Status
//!
//! The protocol logic (parsing, reassembly, role state machines, coexistence)
//! is complete and host-tested. The PHY and lower-MAC bring-up sequences in
//! [`phy`] and [`lmac`] are still in progress; their register map and access
//! primitives live in [`regs`].

#![cfg_attr(not(test), no_std)]

pub mod regs;
pub mod rx;
pub mod ieee80211;
pub mod ble;
pub mod gap;
pub mod mac;
pub mod tx;
pub mod coex;
pub mod http;
pub mod pb;
pub mod wpa;
pub mod ccmp;
pub mod sta;
pub mod ap;
pub mod stack;
pub mod mlme;
pub mod phy;
pub mod lmac;
