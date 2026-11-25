//! meshsim (design §14.1): N Splanc mesh devices — the real `swarm_net`, envelope,
//! membership and port policy ([`splanc_mesh::MeshStack`]) — over a simulated 802.11
//! channel, with no radio.
//!
//! The channel ([`Air`]): nodes at positions in a room, log-distance path loss plus a
//! per-node enclosure loss (the metal boxes of §4.5), a receiver sensitivity and CCA
//! threshold per rate, 1 Mb/s DSSS or 6 Mb/s OFDM airtime, CSMA/CA (DIFS + random backoff,
//! deferring while the medium is sensed busy), collisions at each receiver (overlapping
//! frames within the capture margin destroy each other, hidden nodes included), half-duplex
//! radios, per-link and global random loss, and a processing latency. Every frame on the air
//! is kept in a sniffer log so scenarios can replay captured frames.
//!
//! Clocks: each node has an offset and a ppm drift; it runs (timers, RX timestamps) on its own
//! clock, as on hardware. Time sync proper is M4; here clocks only have to not break things.
//!
//! Node classes (design §10.6): each node is a standalone C6, a P4 + C6 fixture or a Pi.
//! Custodians (P4, Pi) get a [`SimStore`]: a deep relay store with the C6↔P4 SDIO cost per
//! transfer (P4) or none (Pi). A Pi's radio path has an extra per-frame latency
//! ([`Placement::tx_latency_us`]: nl80211 action frames, USB injection, or a USB-attached C6,
//! still being worked out).
//!
//! Not modelled yet: BLE coexistence outages (M3b), multiple channels, UWB/TDMA.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

use splanc_mesh::admin::Grant;
use splanc_mesh::backhaul::{Backhaul, BackhaulId, Busy, NodeId, RxMeta, TxClass, TxStamp};
use splanc_mesh::crypto::DeviceKey;
use splanc_mesh::host_keys::{AdminSigner, HostKey, TestRng};
use splanc_mesh::membership::{Credentials, MeshState, ProvisionSource};
use splanc_mesh::msg::{Class, PendingJoin};
use splanc_mesh::blob::{id_of, sha256, BlobDone, BlobId, BlobStore, Hash, SceneMsg};
use splanc_mesh::gateway::{ReplyMsg, Status};
use splanc_mesh::ports::{ControlHeader, Port, Targets};
use splanc_mesh::stack::{CustodianStore, Event, MeshStack, SendError, StackConfig, FETCH_TIMEOUT_US};
use swarm_net::mesh::Relay;
use swarm_net::update::Flash;

/// The mesh payload capacity on 802.11 (§5.2).
pub const P: usize = 200;
/// The Splanc action-frame body budget (§4.1).
pub const MTU: usize = 250;

/// The 802.11 rate frames are sent at (§4.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Rate {
    Dsss1,
    Ofdm6,
    Ofdm12,
    Ofdm24,
}

impl Rate {
    /// Airtime of a Splanc frame carrying `body` envelope bytes: 802.11 header (24) + the
    /// Public Action vendor-specific header (category 4, action 9, CID 3, kind 1: 6 bytes,
    /// §4.1) + body + FCS (4).
    pub fn airtime_us(self, body: usize) -> i64 {
        let bytes = (24 + 6 + body + 4) as i64;
        let ofdm = |bits_per_symbol: i64| 20 + (16 + 6 + 8 * bytes + bits_per_symbol - 1) / bits_per_symbol * 4;
        match self {
            Rate::Dsss1 => 192 + bytes * 8,
            Rate::Ofdm6 => ofdm(24),
            Rate::Ofdm12 => ofdm(48),
            Rate::Ofdm24 => ofdm(96),
        }
    }
    pub fn sensitivity_dbm(self) -> f64 {
        match self {
            Rate::Dsss1 => -94.0,
            Rate::Ofdm6 => -88.0,
            Rate::Ofdm12 => -85.0,
            Rate::Ofdm24 => -80.0,
        }
    }

    /// The rate ladder a link adapts on, most robust first.
    pub const LADDER: [Rate; 4] = [Rate::Dsss1, Rate::Ofdm6, Rate::Ofdm12, Rate::Ofdm24];

    pub fn mbps(self) -> f64 {
        match self {
            Rate::Dsss1 => 1.0,
            Rate::Ofdm6 => 6.0,
            Rate::Ofdm12 => 12.0,
            Rate::Ofdm24 => 24.0,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct RadioModel {
    pub rate: Rate,
    pub tx_power_dbm: f64,
    /// Path loss at 1 m and the exponent (indoor, line of sight with people: ~2.5–3).
    pub pl_1m_db: f64,
    pub exponent: f64,
    /// A frame survives an overlapping one at least this much weaker.
    pub capture_db: f64,
    pub cca_dbm: f64,
    pub difs_us: i64,
    pub slot_us: i64,
    pub cw: u32,
    /// From the end of a frame to the receiver's host seeing it.
    pub latency_us: i64,
    /// RX timestamp jitter (± µs).
    pub jitter_us: i64,
    /// Frames a node's TX queue holds (back-pressure beyond).
    pub queue: usize,
    /// Per-node rate adaptation (Q12): each node starts at the most robust rate and moves
    /// along [`Rate::LADDER`] on its neighbours' delivery. Off: everyone sends at `rate`.
    pub adaptive: bool,
    /// People walking between fixtures: links get 12 dB of shadowing for 1–3 s at random.
    pub walking: bool,
}

impl Default for RadioModel {
    fn default() -> Self {
        RadioModel {
            // 6 Mb/s OFDM: the sweep's airtime result (design §10.6); DSSS stays available.
            rate: Rate::Ofdm6,
            tx_power_dbm: 15.0,
            pl_1m_db: 40.0,
            exponent: 3.0,
            capture_db: 10.0,
            // DSSS carrier sense detects a preamble close to sensitivity (−82 dBm is the
            // OFDM figure; with it far nodes stay hidden and collide far more than real ones).
            cca_dbm: -90.0,
            difs_us: 50,
            slot_us: 20,
            cw: 31,
            latency_us: 200,
            jitter_us: 5,
            queue: 16,
            adaptive: false,
            walking: false,
        }
    }
}

/// Where a node is and what its hardware is like.
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub x_m: f64,
    pub y_m: f64,
    /// Loss through this node's enclosure, each way (§4.5).
    pub enclosure_db: f64,
    pub clock_offset_us: i64,
    pub clock_ppm: f64,
    pub class: Class,
    /// Extra latency from queueing a frame to it reaching the air (a Pi's radio path), plus
    /// a random part up to `tx_jitter_us`.
    pub tx_latency_us: i64,
    pub tx_jitter_us: i64,
    /// The most frames per second this radio path sends (0: no limit).
    pub max_fps: u32,
    /// Extra loss on everything this node sends (a radio path's own losses).
    pub tx_loss: f64,
}

impl Placement {
    pub fn at(x_m: f64, y_m: f64) -> Placement {
        Placement { x_m, y_m, enclosure_db: 0.0, clock_offset_us: 0, clock_ppm: 0.0, class: Class::C6, tx_latency_us: 0, tx_jitter_us: 0, max_fps: 0, tx_loss: 0.0 }
    }

    /// A Pi on its built-in radio (Broadcom, firmware passthrough of Public Action frames),
    /// as measured by the Pi transport work: ~14 ms median / 54 ms p99 unicast RTT (so ~7 ms
    /// median one way, up to ~27 ms), ~94 % per-hop broadcast delivery, ≤ ~320 frames/s.
    pub fn pi_radio(mut self) -> Placement {
        self.tx_latency_us = 5_000;
        self.tx_jitter_us = 22_000;
        self.max_fps = 320;
        self.tx_loss = 0.06;
        self
    }
}

/// A custodian's deep relay store (design §10.6): on a P4 it lives in P4 RAM, reached over
/// the C6↔P4 SDIO link (a fixed latency plus bytes at the link rate per transfer); on a Pi
/// in its own RAM.
pub struct SimStore {
    q: VecDeque<(i64, Relay<P>)>,
    pub cap: usize,
    /// Per-transfer latency and throughput of the link to the store.
    pub link_us: i64,
    pub link_bytes_per_us: f64,
    pub peak: usize,
    pub pushed: u64,
    pub dropped: u64,
}

impl SimStore {
    /// A P4's store: 256 relays (~60 KB of P4 RAM), SDIO at ~100 µs + 20 MB/s per transfer.
    pub fn p4() -> SimStore {
        SimStore { q: VecDeque::new(), cap: 256, link_us: 100, link_bytes_per_us: 20.0, peak: 0, pushed: 0, dropped: 0 }
    }
    /// A Pi's store: effectively unbounded, in its own RAM.
    pub fn pi() -> SimStore {
        SimStore { q: VecDeque::new(), cap: 4096, link_us: 0, link_bytes_per_us: f64::INFINITY, peak: 0, pushed: 0, dropped: 0 }
    }
}

impl CustodianStore<P> for SimStore {
    fn push(&mut self, now_us: i64, r: Relay<P>) -> bool {
        if self.q.len() >= self.cap {
            self.dropped += 1;
            return false;
        }
        // Both directions cross the link; charge it on the way in.
        let cost = self.link_us + (r.packet.len as f64 / self.link_bytes_per_us) as i64;
        self.q.push_back((now_us + 2 * cost, r));
        self.pushed += 1;
        self.peak = self.peak.max(self.q.len());
        true
    }
    fn pop(&mut self, now_us: i64) -> Option<Relay<P>> {
        if self.q.front().is_some_and(|(t, _)| *t <= now_us) {
            return self.q.pop_front().map(|(_, r)| r);
        }
        None
    }
    fn len(&self) -> usize {
        self.q.len()
    }
}

/// One frame on the air, as a sniffer saw it.
#[derive(Clone, Debug)]
pub struct Sniffed {
    pub from: usize,
    pub start_us: i64,
    pub bytes: Vec<u8>,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AirStats {
    pub frames: u64,
    pub receptions: u64,
    pub collided: u64,
    pub lost: u64,
    pub half_duplex: u64,
    pub too_weak: u64,
    pub deferrals: u64,
    pub queue_full: u64,
    pub airtime_us: i64,
}

struct Tx {
    from: usize,
    start: i64,
    end: i64,
    bytes: Vec<u8>,
    dst: Option<NodeId>,
    rate: Rate,
}

/// A node's broadcast rate controller (Q12; design §4.6). Its feedback is its neighbours'
/// reception of its frames (on hardware: per-neighbour heard counts in their adverts and the
/// MAC ACKs of unicasts): the share of its frames that its *solid* neighbours (reached with a
/// 10 dB margin at the most robust rate) still receive. Marginal neighbours are left to
/// relays: holding the whole mesh at 1 Mb/s for them costs more airtime than it saves.
/// A neighbour is *solid* when the most robust rate reaches it with this margin.
pub const SOLID_MARGIN_DB: f64 = 10.0;

#[derive(Clone, Copy, Debug, Default)]
pub struct RateCtl {
    pub ix: usize,
    expected: u32,
    got: u32,
    good: u32,
    holdoff: u32,
    wait: u32,
    window_end: i64,
    pub changes: u32,
    pub time_at: [i64; 4],
    last_change: i64,
    /// Air time this node sensed busy in the window (its CCA busy counter on hardware).
    busy_us: i64,
}

struct Station {
    place: Placement,
    id: NodeId,
    online: bool,
    /// (frame, link destination, a time beacon whose completion is stamped).
    queue: VecDeque<(Vec<u8>, Option<NodeId>, bool)>,
    /// When the head of the queue next tries the medium.
    attempt_us: Option<i64>,
    /// The last time beacon's completion on this node's clock (M4), until taken.
    stamp: Option<TxStamp>,
    rx: VecDeque<(i64, Vec<u8>, RxMeta)>,
    last_tx_us: Option<i64>,
    ctl: RateCtl,
}

struct Medium {
    m: RadioModel,
    st: Vec<Station>,
    /// Extra loss per (from, to); None = no link at all.
    extra: Vec<Vec<Option<f64>>>,
    loss: Vec<Vec<f64>>,
    air: Vec<Tx>,
    /// Shadowing (dB, until) per link while people walk.
    shadow: Vec<Vec<(f64, i64)>>,
    next_walk: i64,
    now: i64,
    rng: u64,
    stats: AirStats,
    sniffer: Vec<Sniffed>,
}

impl Medium {
    fn rand(&mut self) -> f64 {
        self.rng ^= self.rng << 13;
        self.rng ^= self.rng >> 7;
        self.rng ^= self.rng << 17;
        (self.rng >> 11) as f64 / (1u64 << 53) as f64
    }

    fn rssi(&self, from: usize, to: usize) -> Option<f64> {
        let mut extra = self.extra[from][to]?;
        if let Some(&(db, until)) = self.shadow.get(from).and_then(|r| r.get(to)) {
            if self.now < until {
                extra += db;
            }
        }
        let (a, b) = (&self.st[from].place, &self.st[to].place);
        let d = ((a.x_m - b.x_m).powi(2) + (a.y_m - b.y_m).powi(2)).sqrt().max(0.1);
        let pl = self.m.pl_1m_db + 10.0 * self.m.exponent * d.log10() + a.enclosure_db + b.enclosure_db + extra;
        Some(self.m.tx_power_dbm - pl)
    }

    /// Carrier sense: a preamble is detected a little above its rate's sensitivity.
    fn cca(&self, rate: Rate) -> f64 {
        self.m.cca_dbm.max(rate.sensitivity_dbm() + 2.0)
    }

    fn rate_of(&self, i: usize) -> Rate {
        if self.m.adaptive {
            Rate::LADDER[self.st[i].ctl.ix]
        } else {
            self.m.rate
        }
    }

    fn rssi_clear(&self, from: usize, to: usize) -> f64 {
        let (a, b) = (&self.st[from].place, &self.st[to].place);
        let d = ((a.x_m - b.x_m).powi(2) + (a.y_m - b.y_m).powi(2)).sqrt().max(0.1);
        self.m.tx_power_dbm - (self.m.pl_1m_db + 10.0 * self.m.exponent * d.log10() + a.enclosure_db + b.enclosure_db + self.extra[from][to].unwrap_or(0.0))
    }

    /// One rate window closes. On a busy channel (> 50 % sensed busy) poor delivery means
    /// collisions: step up. Otherwise step down below 80 %, up after two windows at ≥ 90 %; a
    /// probe that fails holds the rate down for twice as long next time.
    fn adapt(&mut self, i: usize) {
        let now = self.now;
        let c = &mut self.st[i].ctl;
        c.time_at[c.ix] += now - c.last_change.max(c.window_end - 1_000_000);
        if c.expected < 10 {
            c.window_end = now + 1_000_000;
            return;
        }
        let ratio = c.got as f64 / c.expected as f64;
        let busy = c.busy_us as f64 / 1e6;
        c.busy_us = 0;
        let before = c.ix;
        if busy > 0.5 && ratio < 0.90 && c.ix + 1 < Rate::LADDER.len() {
            // Losses on a busy channel are collisions, not range: shorter frames help.
            c.ix += 1;
            c.good = 0;
        } else if ratio < 0.80 && c.ix > 0 {
            c.ix -= 1;
            c.holdoff = (c.holdoff.max(1) * 2).min(32);
            c.wait = c.holdoff;
            c.good = 0;
        } else if ratio >= 0.90 {
            c.good += 1;
            if c.wait > 0 {
                c.wait -= 1;
            } else if c.good >= 2 && c.ix + 1 < Rate::LADDER.len() {
                c.ix += 1;
                c.good = 0;
            }
        } else {
            c.good = 0;
        }
        if c.ix != before {
            c.changes += 1;
        }
        c.last_change = now;
        c.expected = 0;
        c.got = 0;
        c.window_end = now + 1_000_000;
    }

    fn local(&self, i: usize, g: i64) -> i64 {
        let p = &self.st[i].place;
        g + p.clock_offset_us + (g as f64 * p.clock_ppm / 1e6) as i64
    }

    /// When `i` senses the medium busy until (None: idle at `t`).
    fn busy_until(&self, i: usize, t: i64) -> Option<i64> {
        self.air
            .iter()
            .filter(|x| x.start <= t && x.end > t)
            .filter(|x| x.from == i || self.rssi(x.from, i).is_some_and(|r| r >= self.cca(x.rate)))
            .map(|x| x.end)
            .max()
    }

    fn backoff(&mut self) -> i64 {
        let slots = (self.rand() * (self.m.cw + 1) as f64) as i64;
        self.m.difs_us + slots * self.m.slot_us
    }

    // `to` indexes the stations and the per-station flags together.
    #[allow(clippy::needless_range_loop)]
    fn deliver(&mut self, tx_i: usize) {
        let (from, start, end) = (self.air[tx_i].from, self.air[tx_i].start, self.air[tx_i].end);
        let rate = self.air[tx_i].rate;
        let robust: Vec<bool> = (0..self.st.len()).map(|j| j != from && self.st[j].online && self.extra[from][j].is_some() && self.rssi_clear(from, j) >= Rate::Dsss1.sensitivity_dbm() + SOLID_MARGIN_DB).collect();
        let n_robust = robust.iter().filter(|&&b| b).count() as u32;
        if self.air[tx_i].dst.is_none() {
            self.st[from].ctl.expected += n_robust;
        }
        let air = end - start;
        for j in 0..self.st.len() {
            if j != from && self.rssi(from, j).is_some_and(|r| r >= self.cca(rate)) {
                self.st[j].ctl.busy_us += air;
            }
        }
        let mut got_robust = 0u32;
        for to in 0..self.st.len() {
            if to == from || !self.st[to].online {
                continue;
            }
            let Some(rssi) = self.rssi(from, to) else { continue };
            if rssi < rate.sensitivity_dbm() {
                self.stats.too_weak += 1;
                continue;
            }
            if let Some(d) = self.air[tx_i].dst {
                if self.st[to].id != d {
                    continue;
                }
            }
            // Half duplex: `to` transmitted during this frame.
            if self.air.iter().any(|x| x.from == to && x.start < end && x.end > start) {
                self.stats.half_duplex += 1;
                continue;
            }
            let collided = self.air.iter().enumerate().any(|(j, x)| {
                j != tx_i && x.from != to && x.start < end && x.end > start && self.rssi(x.from, to).is_some_and(|r| r > rssi - self.m.capture_db)
            });
            if collided {
                self.stats.collided += 1;
                continue;
            }
            let tx_loss = self.st[from].place.tx_loss;
            if self.rand() < self.loss[from][to] || (tx_loss > 0.0 && self.rand() < tx_loss) {
                self.stats.lost += 1;
                continue;
            }
            self.stats.receptions += 1;
            if robust[to] {
                got_robust += 1;
            }
            let jitter = ((self.rand() * 2.0 - 1.0) * self.m.jitter_us as f64) as i64;
            let at = end + self.m.latency_us;
            let mut src_mac = [0x02, 0x5c, 0, 0, 0, 0];
            src_mac[4..].copy_from_slice(&self.st[from].id.to_be_bytes());
            let meta = RxMeta {
                len: self.air[tx_i].bytes.len(),
                rssi_dbm: rssi.round().clamp(-128.0, 0.0) as i8,
                rx_us: self.local(to, end) + jitter,
                src_mac,
                backhaul: BackhaulId(0),
            };
            let bytes = self.air[tx_i].bytes.clone();
            self.st[to].rx.push_back((at, bytes, meta));
        }
        if self.air[tx_i].dst.is_none() {
            self.st[from].ctl.got += got_robust;
        }
    }

    /// Run the channel up to global time `to`.
    fn advance(&mut self, to: i64) {
        loop {
            // The next event: a frame ending, or a station's attempt.
            let next_end = self.air.iter().map(|x| x.end).filter(|&e| e > self.now).min();
            let next_try = self.st.iter().filter(|s| s.online).filter_map(|s| s.attempt_us).min();
            let t = match (next_end, next_try) {
                (Some(a), Some(b)) => a.min(b),
                (a, b) => match a.or(b) {
                    Some(t) => t,
                    None => break,
                },
            };
            if t > to {
                break;
            }
            self.now = t.max(self.now);
            self.housekeeping();
            // Frames ending now are delivered.
            for i in 0..self.air.len() {
                if self.air[i].end == self.now {
                    self.deliver(i);
                }
            }
            // Stations whose attempt is due: transmit if idle, else defer.
            for i in 0..self.st.len() {
                if !self.st[i].online || self.st[i].attempt_us != Some(self.now) {
                    continue;
                }
                if let Some(busy) = self.busy_until(i, self.now) {
                    self.stats.deferrals += 1;
                    let b = self.backoff();
                    self.st[i].attempt_us = Some(busy + b);
                    continue;
                }
                let Some((bytes, dst, stamp)) = self.st[i].queue.pop_front() else {
                    self.st[i].attempt_us = None;
                    continue;
                };
                let rate = self.rate_of(i);
                let air = rate.airtime_us(bytes.len());
                self.stats.frames += 1;
                self.stats.airtime_us += air;
                if stamp {
                    // The firmware's two-step stamp: the completion seen by a poll up to
                    // 30 µs after the frame ends, reported as the bracket's midpoint.
                    let end = self.local(i, self.now + air);
                    let poll = (self.rand() * 30.0) as i64;
                    self.st[i].stamp = Some(TxStamp { armed_us: self.local(i, self.now), done_us: end + poll / 2, err_us: 15 });
                }
                self.sniffer.push(Sniffed { from: i, start_us: self.now, bytes: bytes.clone() });
                self.air.push(Tx { from: i, start: self.now, end: self.now + air, bytes, dst, rate });
                self.st[i].last_tx_us = Some(self.now);
                let b = self.backoff();
                let p = self.st[i].place;
                let gap = if p.max_fps > 0 { 1_000_000 / p.max_fps as i64 } else { 0 };
                self.st[i].attempt_us = if self.st[i].queue.is_empty() { None } else { Some(self.now + (air + b).max(gap)) };
            }
            // Forget frames that can no longer overlap anything new.
            let horizon = self.now - 20_000;
            self.air.retain(|x| x.end > horizon);
        }
        self.now = to.max(self.now);
        self.housekeeping();
    }

    /// Rate windows and walking people.
    fn housekeeping(&mut self) {
        if self.m.adaptive {
            for i in 0..self.st.len() {
                if self.st[i].ctl.window_end == 0 {
                    self.st[i].ctl.window_end = self.now + 1_000_000;
                    self.st[i].ctl.last_change = self.now;
                }
                if self.now >= self.st[i].ctl.window_end {
                    self.adapt(i);
                }
            }
        }
        if self.m.walking && self.now >= self.next_walk {
            self.next_walk = self.now + 500_000;
            let n = self.st.len();
            for a in 0..n {
                for b in a + 1..n {
                    if self.rand() < 0.03 {
                        let until = self.now + 1_000_000 + (self.rand() * 2e6) as i64;
                        self.shadow[a][b] = (12.0, until);
                        self.shadow[b][a] = (12.0, until);
                    }
                }
            }
        }
    }
}

/// The shared channel. Cheap to clone (a handle).
#[derive(Clone)]
pub struct Air(Rc<RefCell<Medium>>);

impl Air {
    pub fn new(m: RadioModel, seed: u64) -> Air {
        Air(Rc::new(RefCell::new(Medium {
            m,
            st: Vec::new(),
            extra: Vec::new(),
            loss: Vec::new(),
            air: Vec::new(),
            shadow: Vec::new(),
            next_walk: 0,
            now: 0,
            rng: seed | 1,
            stats: AirStats::default(),
            sniffer: Vec::new(),
        })))
    }

    fn add(&self, id: NodeId, place: Placement) -> usize {
        let mut m = self.0.borrow_mut();
        let i = m.st.len();
        m.st.push(Station { place, id, online: false, queue: VecDeque::new(), attempt_us: None, stamp: None, rx: VecDeque::new(), last_tx_us: None, ctl: RateCtl::default() });
        for row in m.shadow.iter_mut() {
            row.push((0.0, 0));
        }
        let n = i + 1;
        m.shadow.push(vec![(0.0, 0); n]);
        for row in m.extra.iter_mut() {
            row.push(Some(0.0));
        }
        for row in m.loss.iter_mut() {
            row.push(0.0);
        }
        m.extra.push(vec![Some(0.0); n]);
        m.loss.push(vec![0.0; n]);
        i
    }

    /// Extra attenuation on a link, both ways (None: they cannot hear each other).
    pub fn link(&self, a: usize, b: usize, extra_db: Option<f64>) {
        let mut m = self.0.borrow_mut();
        m.extra[a][b] = extra_db;
        m.extra[b][a] = extra_db;
    }

    /// Random loss on a link, both ways.
    pub fn link_loss(&self, a: usize, b: usize, p: f64) {
        let mut m = self.0.borrow_mut();
        m.loss[a][b] = p;
        m.loss[b][a] = p;
    }

    /// Random loss from `from` to `to` only (an asymmetric link).
    pub fn link_loss_oneway(&self, from: usize, to: usize, p: f64) {
        self.0.borrow_mut().loss[from][to] = p;
    }

    /// Random loss on every link.
    pub fn set_loss(&self, p: f64) {
        let mut m = self.0.borrow_mut();
        for row in m.loss.iter_mut() {
            row.fill(p);
        }
    }

    /// Each node's rate controller (adaptive runs).
    pub fn rate_ctl(&self, i: usize) -> RateCtl {
        self.0.borrow().st[i].ctl
    }

    pub fn rssi(&self, a: usize, b: usize) -> Option<f64> {
        self.0.borrow().rssi(a, b)
    }

    pub fn stats(&self) -> AirStats {
        self.0.borrow().stats
    }

    pub fn now(&self) -> i64 {
        self.0.borrow().now
    }

    pub fn sniffed(&self) -> Vec<Sniffed> {
        self.0.borrow().sniffer.clone()
    }

    /// Put a captured frame back on the air from station `from` (a replay attacker there).
    pub fn inject(&self, from: usize, bytes: Vec<u8>) {
        let mut m = self.0.borrow_mut();
        let now = m.now;
        m.st[from].queue.push_back((bytes, None, false));
        if m.st[from].attempt_us.is_none() {
            m.st[from].attempt_us = Some(now);
        }
    }
}

/// A node's end of the [`Air`].
pub struct SimPort {
    air: Air,
    index: usize,
}

impl Backhaul for SimPort {
    fn mtu(&self) -> usize {
        MTU
    }

    fn send(&mut self, frame: &[u8], dst: Option<NodeId>) -> Result<(), Busy> {
        self.send_class(frame, dst, TxClass::Data)
    }

    fn take_tx_stamp(&mut self) -> Option<TxStamp> {
        self.air.0.borrow_mut().st[self.index].stamp.take()
    }

    fn send_class(&mut self, frame: &[u8], dst: Option<NodeId>, class: TxClass) -> Result<(), Busy> {
        assert!(frame.len() <= MTU, "frame of {} bytes over the MTU", frame.len());
        let mut m = self.air.0.borrow_mut();
        let (qmax, now, i) = (m.m.queue, m.now, self.index);
        if m.st[i].queue.len() >= qmax {
            m.stats.queue_full += 1;
            return Err(Busy);
        }
        m.st[i].queue.push_back((frame.to_vec(), dst, class == TxClass::Time));
        if m.st[i].attempt_us.is_none() {
            let b = m.backoff();
            let p = m.st[i].place;
            // Skewed jitter: mostly near the median, sometimes up to the p99.
            let r = m.rand();
            let lat = p.tx_latency_us + (r * r * r * p.tx_jitter_us as f64) as i64;
            let gap = if p.max_fps > 0 { 1_000_000 / p.max_fps as i64 } else { 0 };
            let earliest = m.st[i].last_tx_us.map_or(now, |t| (t + gap).max(now));
            m.st[self.index].attempt_us = Some(earliest + lat + b);
        }
        Ok(())
    }

    fn recv(&mut self, buf: &mut [u8]) -> Option<RxMeta> {
        let mut m = self.air.0.borrow_mut();
        let now = m.now;
        let s = &mut m.st[self.index];
        if s.rx.front().is_none_or(|(at, _, _)| *at > now) {
            return None;
        }
        let (_, bytes, meta) = s.rx.pop_front()?;
        let n = bytes.len().min(buf.len());
        buf[..n].copy_from_slice(&bytes[..n]);
        Some(RxMeta { len: n, ..meta })
    }

    fn may_send(&self, _now_us: i64) -> bool {
        let m = self.air.0.borrow();
        m.st[self.index].queue.len() < m.m.queue
    }
}

/// Flash for the firmware/blob updater.
pub struct RamFlash(Vec<u8>);

impl Flash for RamFlash {
    fn capacity(&self) -> u32 {
        self.0.len() as u32
    }
    fn erase(&mut self, o: u32, l: u32) -> bool {
        self.0[o as usize..(o + l) as usize].fill(0xFF);
        true
    }
    fn write(&mut self, o: u32, d: &[u8]) -> bool {
        self.0[o as usize..o as usize + d.len()].copy_from_slice(d);
        true
    }
    fn read(&mut self, o: u32, b: &mut [u8]) -> bool {
        b.copy_from_slice(&self.0[o as usize..o as usize + b.len()]);
        true
    }
}

/// An owned [`Event`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ev {
    Control { origin: NodeId, header: ControlHeader, inner: Vec<u8> },
    Packet { origin: NodeId, port: Port, body: Vec<u8>, admin: bool },
    Pending(PendingJoin),
    Joined { epoch: u8 },
    Rekeyed { epoch: u8 },
    StateChanged,
    PersistCounter(u64),
    SessionSynced { session: u32, gateway: NodeId },
    GrantRenewalDue { session: u32, not_after: u32 },
    ShowEpoch(splanc_mesh::meshtime::ShowEpoch),
    WallClock { gen: u32, origin: NodeId },
    Ejected,
    Scene { origin: NodeId, msg: SceneMsg },
    SceneFailed { origin: NodeId, op_id: u32, code: u16 },
    Blob(BlobDone),
    Fetched { op_id: u32, have: usize, of: usize },
    CatchUp { node: NodeId },
}

impl From<Event<'_>> for Ev {
    fn from(e: Event<'_>) -> Ev {
        match e {
            Event::Control { origin, header, inner } => Ev::Control { origin, header, inner: inner.to_vec() },
            Event::Packet { origin, port, body, admin } => Ev::Packet { origin, port, body: body.to_vec(), admin },
            Event::Pending(p) => Ev::Pending(p),
            Event::Joined { epoch } => Ev::Joined { epoch },
            Event::Rekeyed { epoch } => Ev::Rekeyed { epoch },
            Event::StateChanged => Ev::StateChanged,
            Event::PersistCounter(m) => Ev::PersistCounter(m),
            Event::SessionSynced { session, gateway } => Ev::SessionSynced { session, gateway },
            Event::GrantRenewalDue { session, not_after } => Ev::GrantRenewalDue { session, not_after },
            Event::ShowEpoch(e) => Ev::ShowEpoch(e),
            Event::WallClock { gen, origin } => Ev::WallClock { gen, origin },
            Event::Ejected => Ev::Ejected,
            Event::Scene { origin, msg } => Ev::Scene { origin, msg },
            Event::SceneFailed { origin, op_id, code } => Ev::SceneFailed { origin, op_id, code },
            Event::Blob(d) => Ev::Blob(d),
            Event::Fetched { op_id, have, of } => Ev::Fetched { op_id, have, of },
            Event::CatchUp { node } => Ev::CatchUp { node },
            #[allow(unreachable_patterns)]
            _ => Ev::StateChanged,
        }
    }
}

/// A device's blobs (M6): complete ones it can serve and apply, and the one it receives.
#[derive(Default)]
pub struct SimBlobs {
    pub held: Vec<(Hash, Vec<u8>)>,
    pub rx: Option<(Hash, Vec<u8>)>,
    /// The most bytes it ever held at once (complete + receiving): the C6's heap cost.
    pub peak: usize,
}

impl SimBlobs {
    pub fn put(&mut self, b: &[u8]) -> (Hash, u16) {
        let h = sha256(b);
        if !self.held.iter().any(|(x, _)| *x == h) {
            self.held.push((h, b.to_vec()));
        }
        (h, b.len() as u16)
    }

    pub fn get(&self, h: &Hash) -> Option<&[u8]> {
        self.held.iter().find(|(x, _)| x == h).map(|(_, b)| b.as_slice())
    }

    fn note_peak(&mut self) {
        let n = self.held.iter().map(|(_, b)| b.len()).sum::<usize>() + self.rx.as_ref().map_or(0, |(_, b)| b.len());
        self.peak = self.peak.max(n);
    }
}

impl BlobStore for SimBlobs {
    fn find(&mut self, id: &BlobId) -> Option<&[u8]> {
        self.held.iter().find(|(h, _)| id_of(h) == *id).map(|(_, b)| b.as_slice())
    }
    fn has(&mut self, hash: &Hash, size: usize) -> bool {
        self.held.iter().any(|(h, b)| h == hash && b.len() == size)
    }
    fn begin(&mut self, hash: &Hash, size: usize) -> bool {
        self.rx = Some((*hash, vec![0; size]));
        self.note_peak();
        true
    }
    fn rx(&mut self) -> Option<&mut [u8]> {
        self.rx.as_mut().map(|(_, b)| b.as_mut_slice())
    }
    fn finish(&mut self, hash: &Hash, ok: bool) {
        if let Some((h, b)) = self.rx.take() {
            if ok && h == *hash {
                self.held.push((h, b));
            }
        }
    }
}

/// What a simulated player did with a scene (M6): the blobs it applied, and when, on the
/// show clock (mesh ms: the time base every member follows).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Applied {
    /// Global µs it was handed over (blobs all held).
    pub at: i64,
    /// The mesh ms it took effect (`apply_at`, or the mesh ms it was handed over if late or NOW).
    pub mesh_ms: i64,
    pub late: bool,
    pub blobs: Vec<Hash>,
    /// Catch-up blobs equal to what the player showed already (not reloaded).
    pub skipped: usize,
    pub op_id: u32,
}

/// The roster a simulated gateway can hold (64: a large mesh's every member).
pub const ROSTER: usize = 64;

pub type Stack = MeshStack<SimPort, P, HostKey, TestRng, ROSTER>;

pub struct SimNode {
    pub stack: Stack,
    pub flash: RamFlash,
    /// (global µs, event).
    pub events: Vec<(i64, Ev)>,
    pub index: usize,
    pub id: NodeId,
    pub store: Option<SimStore>,
    /// What the device would have persisted: the counter mark and the mesh state.
    pub counter_mark: u64,
    pub saved: Option<MeshState>,
    /// Effect sharing (M6): the device's blobs, what its player applied, the effect it shows,
    /// and (a gateway) the scene a catch-up sends.
    pub blobs: SimBlobs,
    pub applied: Vec<Applied>,
    pub showing: Option<Hash>,
    pub scene: Vec<(Hash, u16)>,
}

impl SimNode {
    pub fn controls(&self) -> Vec<(i64, NodeId, u32, Vec<u8>)> {
        self.events
            .iter()
            .filter_map(|(t, e)| match e {
                Ev::Control { origin, header, inner } => Some((*t, *origin, header.op_id, inner.clone())),
                _ => None,
            })
            .collect()
    }

    pub fn pending(&self) -> Vec<PendingJoin> {
        self.events.iter().filter_map(|(_, e)| if let Ev::Pending(p) = e { Some(*p) } else { None }).collect()
    }

    pub fn class(&self) -> Class {
        self.stack.class()
    }

    pub fn synced(&self, session: u32) -> bool {
        self.stack.sessions.get(session).is_some_and(|s| s.floor.is_some())
    }
}

/// The firmware/blob signing key of simulated images (the swarm's manifest key).
pub const FW_SECRET: [u8; 32] = [6; 32];

/// The simulated world: a channel and the devices on it.
pub struct World {
    pub air: Air,
    pub nodes: Vec<SimNode>,
    scratch: Vec<u8>,
    pub tick_us: i64,
    now: i64,
    /// Capacity-aware relaying on (off: the uniform-small-queue baseline).
    pub capacity_aware: bool,
    pub hop_limit: u8,
    pub adaptive_hops: bool,
    /// Each device's flash for images (80 KiB; the 1.5 MB firmware runs raise it).
    pub flash_bytes: usize,
    /// How long the app's grants last; with `auto_renew` the app signs a renewal (same
    /// session, `grant_ttl_s` more) when a gateway asks (Q11).
    pub grant_ttl_s: u32,
    pub auto_renew: bool,
    /// Renewals the app signed.
    pub renewals: u32,
    /// The app's admin signer (it holds the admin secret; fixtures never do).
    pub admin: AdminSigner,
    pub mesh_id: u32,
}

impl World {
    pub fn new(m: RadioModel, seed: u64) -> World {
        World::with(m, seed, 0x5241_444C, b"radiolarian-adm!", true)
    }

    pub fn with(m: RadioModel, seed: u64, mesh_id: u32, admin_secret: &[u8; 16], capacity_aware: bool) -> World {
        World {
            air: Air::new(m, seed),
            nodes: Vec::new(),
            scratch: vec![0; 4096],
            tick_us: 1_000,
            now: 0,
            capacity_aware,
            hop_limit: 5,
            adaptive_hops: true,
            flash_bytes: 80 * 1024,
            grant_ttl_s: 3600,
            auto_renew: true,
            renewals: 0,
            admin: AdminSigner::from_secret(admin_secret, mesh_id),
            mesh_id,
        }
    }

    fn make_stack(&self, index: usize, id: NodeId, class: Class, counter_mark: u64) -> Stack {
        let port = SimPort { air: self.air.clone(), index };
        let fw_key = swarm_net::crypto::signing::p256_public_key(&FW_SECRET);
        let cfg = StackConfig { firmware: 1, class, capacity_aware: self.capacity_aware, counter_mark, fw_key, hop_limit: self.hop_limit, adaptive_hops: self.adaptive_hops, ..StackConfig::default() };
        let mut mac = [0x02, 0x5c, 0, 0, 0, 0];
        mac[4..].copy_from_slice(&id.to_be_bytes());
        MeshStack::new(id, mac, port, HostKey::from_seed(id as u64), TestRng(0xC0FFEE ^ id as u64 ^ counter_mark), cfg).expect("MTU")
    }

    /// Add a device with node id `id` (its device key and randomness derive from it); it is
    /// powered off until [`World::power_on`].
    pub fn add(&mut self, id: NodeId, place: Placement) -> usize {
        let index = self.air.add(id, place);
        let stack = self.make_stack(index, id, place.class, 0);
        assert!(stack.scratch_len() <= self.scratch.len());
        let store = match (self.capacity_aware, place.class) {
            (true, Class::P4) => Some(SimStore::p4()),
            (true, Class::Pi) => Some(SimStore::pi()),
            _ => None,
        };
        self.nodes.push(SimNode {
            stack,
            flash: RamFlash(vec![0xFF; self.flash_bytes]),
            events: Vec::new(),
            index,
            id,
            store,
            counter_mark: 0,
            saved: None,
            blobs: SimBlobs::default(),
            applied: Vec::new(),
            showing: None,
            scene: Vec::new(),
        });
        index
    }

    /// Power a device on (provisioned with `c` from `source`, or unprovisioned).
    pub fn power_on(&mut self, i: usize, c: Option<(&Credentials, ProvisionSource)>) {
        self.air.0.borrow_mut().st[i].online = true;
        let local = self.local(i);
        if let Some((c, src)) = c {
            self.nodes[i].stack.provision(local, c, src);
        }
    }

    /// Take a device off the air or back (out of range, or powered down without losing RAM:
    /// churn), keeping its state.
    pub fn set_online(&mut self, i: usize, online: bool) {
        if online {
            self.air.0.borrow_mut().st[i].online = true;
        } else {
            self.power_off(i);
        }
    }

    pub fn power_off(&mut self, i: usize) {
        let mut m = self.air.0.borrow_mut();
        m.st[i].online = false;
        m.st[i].queue.clear();
        m.st[i].rx.clear();
        m.st[i].attempt_us = None;
    }

    /// Reboot device `i`: RAM is lost; it comes back with what it persisted (its counter
    /// mark and its mesh state), as firmware would.
    pub fn reboot(&mut self, i: usize) {
        self.power_off(i);
        let (id, class, mark) = (self.nodes[i].id, self.nodes[i].class(), self.nodes[i].counter_mark);
        // Through the bytes the firmware writes to littlefs (mesh M7), not the struct.
        let saved = self.nodes[i].stack.membership.state.and_then(|s| MeshState::decode(&s.encode()));
        let mut stack = self.make_stack(i, id, class, mark);
        let local = self.local(i);
        if let Some(s) = saved {
            stack.restore(local, s);
        }
        self.nodes[i].stack = stack;
        self.nodes[i].saved = saved;
        // RAM blobs are gone; the effect it showed is persisted (the firmware's /lfs/fx.pb,
        // which its store finds by hash).
        let showing = self.nodes[i].showing;
        let b = &mut self.nodes[i].blobs;
        b.rx = None;
        b.held.retain(|(h, _)| Some(*h) == showing);
        self.air.0.borrow_mut().st[i].online = true;
    }

    pub fn now(&self) -> i64 {
        self.now
    }

    /// Node `i`'s local clock now.
    pub fn local(&self, i: usize) -> i64 {
        self.air.0.borrow().local(i, self.now)
    }

    /// Advance `ms` milliseconds: the channel, then every powered device ticks on its clock.
    pub fn run_ms(&mut self, ms: i64) {
        let end = self.now + ms * 1_000;
        let mut renew: Vec<(usize, u32, u32)> = Vec::new();
        while self.now < end {
            self.now += self.tick_us;
            self.air.0.borrow_mut().advance(self.now);
            for k in 0..self.nodes.len() {
                let i = self.nodes[k].index;
                if !self.air.0.borrow().st[i].online {
                    continue;
                }
                let local = self.local(i);
                let now = self.now;
                let n = &mut self.nodes[k];
                let mut evs = Vec::new();
                n.stack.tick_blobs(local, &mut n.flash, &mut n.blobs, &mut self.scratch, &mut |e| evs.push((now, Ev::from(e))));
                // The low-priority crypto task gets one job per tick (a few ms of CPU on a C6
                // in the gaps between render frames; here it is free).
                n.stack.run_crypto(local);
                if let Some(st) = n.store.as_mut() {
                    n.stack.pump_custodian(local, st);
                }
                for (t, e) in evs {
                    if let Ev::GrantRenewalDue { session, not_after } = e {
                        renew.push((k, session, not_after));
                    }
                    if let Ev::PersistCounter(m) = e {
                        // The device writes the mark at once.
                        n.stack.node.guard.counter_reserved(m);
                        n.counter_mark = m;
                    }
                    Self::player(n, local, now, &e);
                    n.events.push((t, e));
                }
                // Simulated install of a fully received image, then a healthy boot (as M1).
                let u = &mut n.stack.node.net.updater;
                if u.status() == swarm_net::update::Status::Ready {
                    u.running = u.manifest().unwrap().version;
                    u.set_validated(true);
                }
            }
            // The app answers renewal requests in the background (Q11): same session, later
            // expiry; members verify it off their render path.
            for (k, session, not_after) in renew.drain(..) {
                if self.auto_renew {
                    let g = self.admin.grant(self.mesh_id, session, self.nodes[k].id, self.nodes[k].stack.dev.public_key(), not_after + self.grant_ttl_s);
                    let local = self.local(self.nodes[k].index);
                    if self.nodes[k].stack.unlock(local, 0, &g, None).is_ok() {
                        self.renewals += 1;
                    }
                }
            }
        }
    }

    /// What the device's firmware does with the mesh's M6 events (mesh_gw.rs on the C6):
    /// apply a scene's blobs (at their show-clock time), answer the gateway, and as the
    /// gateway pick the apply time once the targets hold the blob, and catch members up.
    fn player(n: &mut SimNode, local: i64, now: i64, e: &Ev) {
        let mesh_ms = n.stack.time.mesh_us(local) / 1_000;
        match e {
            Ev::Scene { origin, msg } => {
                let mut status = Status::Ok;
                if msg.flags & SceneMsg::APPLY != 0 {
                    let late = msg.flags & SceneMsg::NOW != 0 || i64::from(msg.apply_at) <= mesh_ms;
                    let at_ms = if late { mesh_ms } else { i64::from(msg.apply_at) };
                    let mut skipped = 0;
                    for (h, _) in msg.blobs() {
                        if msg.flags & SceneMsg::CATCH_UP != 0 && n.showing == Some(*h) {
                            skipped += 1;
                        }
                    }
                    if n.blobs.get(&msg.blobs()[0].0).is_none() {
                        status = Status::Failed;
                    }
                    n.showing = Some(msg.blobs()[0].0);
                    n.applied.push(Applied { at: now, mesh_ms: at_ms, late: late && msg.flags & SceneMsg::NOW == 0, blobs: msg.blobs().iter().map(|b| b.0).collect(), skipped, op_id: msg.op_id });
                }
                if msg.want_reply() {
                    let _ = n.stack.reply(*origin, &ReplyMsg { op_id: msg.op_id, status, arm: 21, code: 0 });
                }
            }
            Ev::Fetched { op_id, .. } => {
                // Every target has it (or the time ran out): all switch 300 ms from now.
                let at = (mesh_ms + 300) as u32;
                if let Ok(msg) = n.stack.distribute_apply(local, Some(at), 3_000_000) {
                    let h = msg.blobs()[0].0;
                    n.showing = Some(h);
                    n.applied.push(Applied { at: now, mesh_ms: i64::from(at), late: false, blobs: vec![h], skipped: 0, op_id: *op_id });
                }
            }
            Ev::CatchUp { node } => {
                if n.scene.is_empty() {
                    return;
                }
                let Some(t) = Targets::nodes(&[*node]) else { return };
                let flags = SceneMsg::APPLY | SceneMsg::NOW | SceneMsg::CATCH_UP | SceneMsg::WANT_REPLY;
                if let Some(msg) = SceneMsg::new(0x0c00_0000 | u32::from(*node), flags, 0, t, &n.scene) {
                    let _ = n.stack.share(local, 0, &msg, 15_000_000);
                }
            }
            _ => {}
        }
    }

    /// Gateway `i` shares an effect blob (and a state blob for catch-ups) with every member
    /// through connection 0's session: the two-phase share of mesh M6.
    pub fn share_effect(&mut self, i: usize, op_id: u32, effect: &[u8], state: Option<&[u8]>) -> Result<usize, SendError> {
        let local = self.local(i);
        let n = &mut self.nodes[i];
        let e = n.blobs.put(effect);
        n.scene = vec![e];
        if let Some(s) = state {
            let s = n.blobs.put(s);
            n.scene.push(s);
        }
        n.stack.distribute(local, 0, op_id, Targets::All, e, FETCH_TIMEOUT_US)
    }

    /// Run until `cond` holds or `max_ms` pass; the elapsed ms, or None.
    pub fn run_until(&mut self, max_ms: i64, mut cond: impl FnMut(&World) -> bool) -> Option<i64> {
        let start = self.now;
        let step = 10;
        let mut t = 0;
        while t < max_ms {
            if cond(self) {
                return Some((self.now - start) / 1_000);
            }
            self.run_ms(step);
            t += step;
        }
        cond(self).then_some((self.now - start) / 1_000)
    }

    /// The share of time the channel carried a frame so far.
    pub fn airtime_share(&self) -> f64 {
        self.air.stats().airtime_us as f64 / self.now.max(1) as f64
    }

    /// The app's grant for gateway `i` (session `session`, valid an hour).
    pub fn grant(&self, i: usize, session: u32) -> Grant {
        let local_s = (self.local(i) / 1_000_000) as u32;
        self.admin.grant(self.mesh_id, session, self.nodes[i].id, self.nodes[i].stack.dev.public_key(), local_s + self.grant_ttl_s)
    }

    /// Unlock gateway `i`'s connection 0 with a fresh grant and wait (≤ `max_ms`) until the
    /// members in `members` are synced with it. The ms it took, or None.
    pub fn unlock_and_sync(&mut self, i: usize, session: u32, members: &[usize], max_ms: i64) -> Option<i64> {
        let g = self.grant(i, session);
        let t = self.local(i);
        self.nodes[i].stack.unlock(t, 0, &g, None).expect("grant");
        let members: Vec<usize> = members.iter().copied().filter(|&m| m != i).collect();
        self.run_until(max_ms, |w| members.iter().all(|&m| w.nodes[m].synced(session)))
    }

    /// Put a signed image (firmware or an effect blob) on node `i`, which then serves it.
    pub fn host_image(&mut self, i: usize, img: &[u8], version: u32) {
        use swarm_net::update::{self, PAGE_SIZE};
        let mut m = swarm_net::Manifest::for_image(img, version, 0);
        m.sign(&FW_SECRET);
        let local = self.local(i);
        let n = &mut self.nodes[i];
        let net = &mut n.stack.node.net;
        assert!(net.host_manifest(m.raw(), &mut n.flash));
        for (page, p) in img.chunks(PAGE_SIZE).enumerate() {
            for (c, d) in p.chunks(update::CHUNK).enumerate() {
                net.host_chunk(local, page as u16, c as u8, d, &mut n.flash);
            }
        }
        net.take_changes();
        net.updater.running = version;
        net.updater.set_validated(true);
    }

    /// Node `i` holds the image (verified, serving it).
    pub fn has_image(&self, i: usize, version: u32) -> bool {
        let u = &self.nodes[i].stack.node.net.updater;
        u.running == version && matches!(u.status(), swarm_net::update::Status::Serving)
    }
}

#[cfg(test)]
mod scenarios;

#[cfg(test)]
mod air_tests {
    use super::*;

    #[test]
    fn airtime() {
        // A 250-byte body at 1 Mb/s: ~2.3 ms; at 6 Mb/s about a fifth (§4.1).
        assert_eq!(Rate::Dsss1.airtime_us(250), 192 + 284 * 8);
        let o = Rate::Ofdm6.airtime_us(250);
        assert!((380..=420).contains(&o), "{o}");
    }

    #[test]
    fn clocks_and_rx_timestamps_are_per_node() {
        let air = Air::new(RadioModel::default(), 1);
        let a = air.add(1, Placement::at(0.0, 0.0));
        let b = air.add(2, Placement { clock_offset_us: 1_000_000, clock_ppm: 100.0, ..Placement::at(3.0, 0.0) });
        air.0.borrow_mut().st[a].online = true;
        air.0.borrow_mut().st[b].online = true;
        let mut pa = SimPort { air: air.clone(), index: a };
        let mut pb = SimPort { air: air.clone(), index: b };
        air.0.borrow_mut().advance(10_000_000);
        pa.send(&[1; 100], None).unwrap();
        air.0.borrow_mut().advance(10_010_000);
        let mut buf = [0u8; 256];
        let m = pb.recv(&mut buf).expect("heard");
        let end_guess = 10_000_000 + RadioModel::default().rate.airtime_us(100);
        // Local clock: +1 s offset and +100 ppm of 10 s (1 ms), give or take backoff + jitter.
        let local = m.rx_us - 1_000_000 - 1_000;
        assert!((end_guess..end_guess + 1_000).contains(&local), "{}", m.rx_us);
        // 15 dBm - (40 + 30 log10(3 m)) = -39 dBm.
        assert_eq!(m.rssi_dbm, -39);
        assert!(pa.recv(&mut buf).is_none(), "no self-reception");
    }

    #[test]
    fn hidden_nodes_collide_and_csma_defers() {
        // a - b - c: a and c cannot hear each other (hidden) but both reach b.
        let air = Air::new(RadioModel::default(), 7);
        let (a, b, c) = (air.add(1, Placement::at(0.0, 0.0)), air.add(2, Placement::at(5.0, 0.0)), air.add(3, Placement::at(10.0, 0.0)));
        air.link(a, c, None);
        for i in [a, b, c] {
            air.0.borrow_mut().st[i].online = true;
        }
        let mut pa = SimPort { air: air.clone(), index: a };
        let mut pc = SimPort { air: air.clone(), index: c };
        // Force both to start together.
        pa.send(&[1; 200], None).unwrap();
        pc.send(&[2; 200], None).unwrap();
        {
            let mut m = air.0.borrow_mut();
            m.st[a].attempt_us = Some(100);
            m.st[c].attempt_us = Some(100);
            m.advance(100_000);
        }
        assert_eq!(air.stats().collided, 2, "b loses both");
        // Two stations that hear each other defer instead.
        let air = Air::new(RadioModel::default(), 7);
        let (a, b) = (air.add(1, Placement::at(0.0, 0.0)), air.add(2, Placement::at(5.0, 0.0)));
        let c = air.add(3, Placement::at(2.5, 2.0));
        for i in [a, b, c] {
            air.0.borrow_mut().st[i].online = true;
        }
        let mut pa = SimPort { air: air.clone(), index: a };
        let mut pb = SimPort { air: air.clone(), index: b };
        pa.send(&[1; 200], None).unwrap();
        pb.send(&[2; 200], None).unwrap();
        {
            let mut m = air.0.borrow_mut();
            m.st[a].attempt_us = Some(100);
            m.st[b].attempt_us = Some(150);
            m.advance(100_000);
        }
        let s = air.stats();
        assert_eq!((s.collided, s.deferrals, s.receptions), (0, 1, 4));
    }
}
