//! Network time for the netstack C6 (docs/design/wall-clock.md, D-561).
//!
//! - [`dns`]: a DNS A-query builder and answer parser (one question, IN A).
//! - [`ntp`]: SNTP v4 (RFC 4330) client request / server reply codecs, the
//!   offset/delay arithmetic on a monotonic clock, kiss-o'-death codes.
//! - [`stamp`]: maps the Wi-Fi MAC's RX-vector timestamp onto the monotonic
//!   clock (the reap-lag floor), so a reply's arrival is not the loop's reap.
//! - [`client`]: the SNTP client state machine. Servers: the owner's override,
//!   else the DHCP-offered NTP servers (option 42), else `pool.ntp.org`. Each
//!   round asks two servers when it can and takes the time only when they
//!   agree. Backoff: 64 s doubling to 1 h while synced, 15 s doubling to 5 min
//!   while rounds fail.
//!
//! `no_std`, zero-dependency, never allocates. Nothing here touches hardware or
//! the network: the caller sends what [`client::Client::poll`] returns and
//! feeds replies to [`client::Client::on_udp`].

#![no_std]

pub mod client;
pub mod dns;
pub mod ntp;
pub mod stamp;

pub use client::{Client, Config, Fail, Network, Outcome, Phase, Sample, Stats, Tx};

/// An IPv4 address, network byte order (as on the wire).
pub type Ip = [u8; 4];
