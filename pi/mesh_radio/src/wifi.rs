//! [`WifiBackhaul`]: the mesh's [`Backhaul`] over any [`RawRadio`] — Splanc action frames
//! (design §4.1) on a Linux radio, or the same bytes over UDP ([`crate::udp::UdpRadio`],
//! the M10 IP backhaul) or a USB-attached C6 ([`crate::serial::SerialRadio`]).
//!
//! It owns what the design gives a backhaul: framing, the NodeId → MAC map for link
//! unicasts (learned from received frames), link-retry dedup, and pacing (an airtime budget
//! so a Pi never takes more than its share of a channel it shares with the venue AP).

use std::collections::HashMap;
use std::io;

use splanc_mesh::{Backhaul, BackhaulId, Busy, NodeId, RxMeta};

use crate::frame::{self, Category, BROADCAST};
use crate::radio::RawRadio;

#[derive(Clone, Copy, Debug)]
pub struct WifiConfig {
    pub cat: Category,
    /// Largest mesh frame (the envelope) carried: 250 on the C6 mesh (design §4.1, §5.2).
    pub mtu: usize,
    pub backhaul: BackhaulId,
    /// PHY rate the airtime budget assumes (kb/s).
    pub rate_kbps: u32,
    /// Share of airtime this node may use (0..1), measured over `burst_us`.
    pub max_duty: f32,
    pub burst_us: i64,
    /// RSSI reported when the radio gives none (brcmfmac, UDP).
    pub default_rssi_dbm: i8,
    /// A learned peer MAC is forgotten after this long without a frame from it.
    pub peer_ttl_us: i64,
}

impl Default for WifiConfig {
    fn default() -> Self {
        WifiConfig {
            cat: Category::Vendor,
            mtu: 250,
            backhaul: BackhaulId(0),
            rate_kbps: 6_000,
            max_duty: 0.3,
            burst_us: 50_000,
            default_rssi_dbm: -60,
            peer_ttl_us: 60_000_000,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WifiStats {
    pub tx: u32,
    pub tx_unicast: u32,
    /// Unicasts to a node whose MAC we have not learned: sent as broadcast (the link frame
    /// carries the destination, so others drop it).
    pub tx_unknown_peer: u32,
    pub tx_err: u32,
    pub tx_paced: u32,
    pub rx: u32,
    pub rx_other: u32,
    pub rx_dup: u32,
    pub rx_err: u32,
    pub acked: u32,
    pub unacked: u32,
    pub airtime_us: u64,
}

struct Peer {
    mac: [u8; 6],
    seen_us: i64,
}

pub struct WifiBackhaul<R: RawRadio> {
    pub radio: R,
    pub cfg: WifiConfig,
    pub stats: WifiStats,
    mac: [u8; 6],
    seq: u16,
    peers: HashMap<NodeId, Peer>,
    /// Last (seq) seen from each MAC: drops link-layer retransmissions we already took.
    last_seq: HashMap<[u8; 6], u16>,
    /// Airtime budget (µs) and when it was last refilled.
    tokens_us: f64,
    refill_at_us: i64,
    now_us: i64,
    buf: Vec<u8>,
}

/// The source node of a mesh frame: the envelope's (M2, design §5.1: "SM", v1, source at
/// bytes 8..10) or, for plain M1 frames, the link frame's.
pub fn source_node(mesh: &[u8]) -> Option<NodeId> {
    if mesh.len() >= 14 && mesh[0..3] == *b"SM\x01" {
        return Some(u16::from_be_bytes([mesh[8], mesh[9]]));
    }
    splanc_mesh::link::decode(mesh).ok().map(|r| r.src)
}

impl<R: RawRadio> WifiBackhaul<R> {
    pub fn new(radio: R, cfg: WifiConfig) -> WifiBackhaul<R> {
        let mac = radio.mac();
        let burst = cfg.burst_us as f64 * cfg.max_duty as f64;
        WifiBackhaul {
            radio,
            cfg,
            stats: WifiStats::default(),
            mac,
            seq: 0,
            peers: HashMap::new(),
            last_seq: HashMap::new(),
            tokens_us: burst,
            refill_at_us: 0,
            now_us: 0,
            buf: vec![0; 2400],
        }
    }

    /// Advance the backhaul's clock (the caller's, the same one `Node::tick` gets).
    pub fn set_now(&mut self, now_us: i64) {
        let dt = (now_us - self.refill_at_us).max(0) as f64;
        let cap = self.cfg.burst_us as f64 * self.cfg.max_duty as f64;
        self.tokens_us = (self.tokens_us + dt * self.cfg.max_duty as f64).min(cap);
        self.refill_at_us = now_us;
        self.now_us = now_us;
        let ttl = self.cfg.peer_ttl_us;
        self.peers.retain(|_, p| now_us - p.seen_us < ttl);
    }

    pub fn mac(&self) -> [u8; 6] {
        self.mac
    }

    /// The learned link address of a node.
    pub fn peer_mac(&self, id: NodeId) -> Option<[u8; 6]> {
        self.peers.get(&id).map(|p| p.mac)
    }

    fn airtime(&self, mesh_len: usize) -> u32 {
        frame::airtime_us(frame::overhead(self.cfg.cat) + mesh_len, self.cfg.rate_kbps)
    }
}

impl<R: RawRadio> Backhaul for WifiBackhaul<R> {
    fn mtu(&self) -> usize {
        self.cfg.mtu
    }

    fn send(&mut self, mesh: &[u8], dst: Option<NodeId>) -> Result<(), Busy> {
        if mesh.len() > self.cfg.mtu {
            self.stats.tx_err += 1;
            return Err(Busy);
        }
        let air = self.airtime(mesh.len()) as f64;
        if self.tokens_us < air {
            self.stats.tx_paced += 1;
            return Err(Busy);
        }
        let da = match dst {
            None => BROADCAST,
            Some(id) => match self.peers.get(&id) {
                Some(p) => {
                    self.stats.tx_unicast += 1;
                    p.mac
                }
                None => {
                    self.stats.tx_unknown_peer += 1;
                    BROADCAST
                }
            },
        };
        self.seq = (self.seq + 1) & 0x0fff;
        let mut f = std::mem::take(&mut self.buf);
        let n = frame::encode(self.cfg.cat, da, self.mac, self.seq, mesh, &mut f).expect("buffer sized for the MTU");
        let r = self.radio.send(&f[..n]);
        self.buf = f;
        match r {
            Ok(()) => {
                self.tokens_us -= air;
                self.stats.tx += 1;
                self.stats.airtime_us += air as u64;
                Ok(())
            }
            Err(e) => {
                self.stats.tx_err += 1;
                if e.kind() != io::ErrorKind::WouldBlock {
                    log_once(&e);
                }
                Err(Busy)
            }
        }
    }

    fn recv(&mut self, out: &mut [u8]) -> Option<RxMeta> {
        let (a, u) = self.radio.take_tx_status();
        self.stats.acked += a;
        self.stats.unacked += u;
        let mut f = std::mem::take(&mut self.buf);
        let r = loop {
            let raw = match self.radio.recv(&mut f) {
                Ok(Some(raw)) => raw,
                Ok(None) => break None,
                Err(e) => {
                    self.stats.rx_err += 1;
                    log_once(&e);
                    break None;
                }
            };
            let Some(p) = frame::parse(&f[..raw.len]) else {
                self.stats.rx_other += 1;
                continue;
            };
            if p.cat != self.cfg.cat || p.sa == self.mac || p.mesh.len() > out.len() {
                self.stats.rx_other += 1;
                continue;
            }
            if p.da != BROADCAST && p.da != self.mac {
                self.stats.rx_other += 1;
                continue;
            }
            if p.retry && self.last_seq.get(&p.sa) == Some(&p.seq) {
                self.stats.rx_dup += 1;
                continue;
            }
            self.last_seq.insert(p.sa, p.seq);
            if let Some(id) = source_node(p.mesh) {
                self.peers.insert(id, Peer { mac: p.sa, seen_us: self.now_us });
            }
            self.stats.rx += 1;
            out[..p.mesh.len()].copy_from_slice(p.mesh);
            break Some(RxMeta {
                len: p.mesh.len(),
                rssi_dbm: raw.rssi_dbm.unwrap_or(self.cfg.default_rssi_dbm),
                rx_us: self.now_us,
                src_mac: p.sa,
                backhaul: self.cfg.backhaul,
            });
        };
        self.buf = f;
        r
    }

    fn may_send(&self, _now_us: i64) -> bool {
        self.tokens_us >= self.airtime(self.cfg.mtu) as f64
    }
}

fn log_once(e: &io::Error) {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    if N.fetch_add(1, Ordering::Relaxed) < 8 {
        eprintln!("mesh_radio: {e}");
    }
}
