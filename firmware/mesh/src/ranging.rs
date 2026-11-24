//! Link ranging (docs/design/mesh-ftm.md): FTM-style two-way ranging between neighbours on
//! the 802.11 backhaul, from the MAC's fine timestamps ([`ledmapper_netstack::ftm`]).
//!
//! **Every ACKed unicast is a half-exchange.** When A's unicast to B is ACKed, A keeps
//! (seq, t1, t4) from its TX queue's stamp words; B keeps (seq, t2, t3) from the frame's RX
//! vector. B ships its records back to A in a [`RangeMsg::Report`] (a one-hop, sealed,
//! unicast link frame, itself ACKed: B's half-exchange towards A), and A joins the two by
//! sequence number:
//!
//! ```text
//! RTT = (t4 - t1) - (t3 - t2) x (1 - drift)         range = (RTT - K) x 0.234 m
//! ```
//!
//! `drift` (B's clock rate against A's) is the slope of `t2 - t1` over `t1` across the
//! records of a report: no extra traffic. `K` is the zero-range constant (hardware delays),
//! [`RangeConfig::k_raw_x16`].
//!
//! When a neighbour has seen no unicast from us lately, a burst of [`BURST`] small
//! [`RangeMsg::Probe`]s goes out (one per tick, only while the backhaul queue is empty, never
//! back to back: [`PROBE_GAP_US`]), the last asking for the report. About 1-2 ms of airtime
//! per link every [`PERIOD_US`].
//!
//! **Uncalibrated.** Each device has a per-boot phase state (39 or 41: [`Phase`]) that adds
//! 1.6-2.6 m to every RTT through a device in the high state (the FTM spike, #638). Until S2
//! calibrates it, every [`LinkRange`] carries both ends' states and `calibrated: false`, so a
//! consumer can drop the link or fit an offset per state.
//!
//! **Never stalls anything.** All of it runs in the mesh tick, which runs below the render
//! task ([`crate::MeshStack::tick`] on the netstack loop, #371). The work per frame is a few
//! integer operations; per report, a fit over at most [`REPORT_MAX`] points and a median of
//! at most [`HIST`]. Off ([`RangeConfig::enabled`] false, the default): nothing is recorded,
//! nothing is sent, and the backhaul reads no stamp registers.

use ledmapper_netstack::ftm::{self, FtmStamp, RxFtm, TxFtm};

use crate::backhaul::NodeId;

/// Neighbours ranged at once (the stalest is replaced).
pub const PEERS: usize = 6;
/// Records a responder keeps per neighbour, and the most a report carries.
pub const REPORT_MAX: usize = 10;
/// Records an initiator keeps per neighbour (its sent, ACKed unicasts).
pub const TX_RECS: usize = 12;
/// RTTs a link's estimate is the robust mean of.
pub const HIST: usize = 16;
/// A responder reports once it holds this many unreported records...
pub const REPORT_MIN: u8 = 8;
/// ...or when the oldest unreported one is this old, or the initiator asked.
pub const REPORT_STALE_US: i64 = 2_000_000;
/// Reports to one neighbour at most this often.
pub const REPORT_GAP_US: i64 = 200_000;
/// Probes per burst.
pub const BURST: u8 = 8;
/// Between two probes.
pub const PROBE_GAP_US: i64 = 3_000;
/// A link is re-measured this often (a burst, unless data unicasts already did it).
pub const PERIOD_US: i64 = 10_000_000;
/// RTTs older than this leave the estimate (a fixture that moved re-converges).
pub const HIST_MAX_AGE_US: i64 = 120_000_000;
/// An initiator record older than this is not matched (12-bit sequence numbers wrap).
pub const TX_MAX_AGE_US: i64 = 5_000_000;
/// The turnaround (t3 - t2) and the sender's span (t4 - t1) are the frame's airtime plus
/// SIFS + signal extension (15.3 µs on silicon, every rate and length) plus, for the span,
/// the RTT: stamps outside this window (µs over the airtime) are not this frame's.
pub const TURN_MIN_US: i64 = 12;
pub const TURN_MAX_US: i64 = 22;
/// An RTT further than this from `K` (raw; 234 m) is an outlier (the spike's one-sided
/// ±2.6 µs stamps).
pub const RTT_WINDOW_RAW: i64 = 1_000;
/// The drift fit needs its points spread over at least this (µs).
pub const FIT_SPAN_US: i64 = 10_000;
/// The zero-range RTT measured on the bench (hitl-rig-1, both devices in phase state 39, at
/// a short unmeasured distance): 1407.5 raw, x16.
pub const DEFAULT_K_RAW_X16: i32 = 22_520;
/// Message bytes: header + REPORT_MAX records.
pub const MSG_MAX: usize = 4 + REPORT_MAX * REC_LEN;
const REC_LEN: usize = 12;

const VERSION: u8 = 1;
const KIND_PROBE: u8 = 1;
const KIND_REPORT: u8 = 2;
const F_WANT_REPORT: u8 = 4;

/// A device's per-boot TX/RX clock-phase state, as it reads it from the frames it ACKs.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Phase {
    /// No ACKed frame seen yet.
    #[default]
    Unknown,
    /// 39: the lower-offset state.
    Low,
    /// 41: adds 7-11 raw (1.6-2.6 m) to every RTT through this device.
    High,
    /// Both, or neither (a stamp map this firmware does not know): distrust.
    Mixed,
}

impl Phase {
    pub fn code(self) -> u8 {
        match self {
            Phase::Unknown => 0,
            Phase::Low => 1,
            Phase::High => 2,
            Phase::Mixed => 3,
        }
    }
    pub fn from_code(c: u8) -> Phase {
        match c & 3 {
            1 => Phase::Low,
            2 => Phase::High,
            3 => Phase::Mixed,
            _ => Phase::Unknown,
        }
    }
    /// The raw `(t3 tick - t2 tick) mod 80` value it stands for (0: none).
    pub fn ticks(self) -> u8 {
        match self {
            Phase::Low => ftm::PHASE_LOW,
            Phase::High => ftm::PHASE_HIGH,
            _ => 0,
        }
    }
}

/// Counts of the phase values this device's own RX stamps showed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PhaseVote {
    pub low: u16,
    pub high: u16,
    pub other: u16,
}

impl PhaseVote {
    fn add(&mut self, ticks: u8) {
        let c = match ticks {
            ftm::PHASE_LOW => &mut self.low,
            ftm::PHASE_HIGH => &mut self.high,
            _ => &mut self.other,
        };
        *c = c.saturating_add(1);
    }

    /// The boot's state: at least 3 votes, and the runner-up under a tenth of the winner.
    pub fn state(&self) -> Phase {
        let n = self.low as u32 + self.high as u32 + self.other as u32;
        if n < 3 {
            return Phase::Unknown;
        }
        let (win, w) = if self.low >= self.high { (Phase::Low, self.low as u32) } else { (Phase::High, self.high as u32) };
        if (n - w) * 10 > w {
            Phase::Mixed
        } else {
            win
        }
    }
}

/// One link's range as this node measured it (it was the initiator).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct LinkRange {
    /// One-way distance, mm, `(RTT - K) x 0.234 m`: negative is possible before calibration.
    pub range_mm: i32,
    /// The estimate's standard error (σ of one exchange / √n), mm.
    pub sigma_mm: u32,
    /// Exchanges in the estimate.
    pub n: u8,
    /// Since the newest exchange in it, ms.
    pub age_ms: u32,
    /// This device's phase state and the neighbour's (from its last report).
    pub phase_self: Phase,
    pub phase_peer: Phase,
    /// `K` (and per-state offsets) were set from a known distance on this pair's states:
    /// false until S2 lands. Consumers treat an uncalibrated range as relative (offset by
    /// up to ~2.6 m per device in [`Phase::High`]).
    pub calibrated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RangeConfig {
    pub enabled: bool,
    /// The zero-range RTT (raw units x 16).
    pub k_raw_x16: i32,
    /// `K` came from a ground-truth measurement (D-520 tape / D-521 coax).
    pub calibrated: bool,
    pub period_us: i64,
    pub burst: u8,
}

impl Default for RangeConfig {
    fn default() -> Self {
        RangeConfig { enabled: false, k_raw_x16: DEFAULT_K_RAW_X16, calibrated: false, period_us: PERIOD_US, burst: BURST }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RangeStats {
    /// Half-exchanges kept as responder / initiator.
    pub rx_recs: u32,
    pub tx_recs: u32,
    /// Stamps outside the airtime window (not this frame's), either side.
    pub rx_bad: u32,
    pub tx_bad: u32,
    /// Messages sent / received.
    pub probes: u32,
    pub reports: u32,
    pub reports_in: u32,
    pub bad_msgs: u32,
    /// Report records joined with ours, RTTs kept, and rejected (window or fit outliers).
    pub matched: u32,
    pub exchanges: u32,
    pub rejected: u32,
    /// Drift fits made / skipped (span too short or too few points).
    pub fits: u32,
    pub no_fit: u32,
}

/// A responder's record: what it sends back.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RxRec {
    pub seq: u16,
    pub t2: FtmStamp,
    /// t3 - t2, raw.
    pub turn: i32,
}

#[derive(Clone, Copy, Debug, Default)]
struct RxSlot {
    rec: RxRec,
    /// When it was recorded ([`ms`]).
    at_ms: u32,
    reported: bool,
}

#[derive(Clone, Copy, Debug, Default)]
struct TxRec {
    seq: u16,
    t1: FtmStamp,
    /// t4 - t1, raw.
    span: i32,
    at_ms: u32,
}

#[derive(Clone, Copy, Debug, Default)]
struct Rtt {
    /// Drift-corrected RTT, raw x 4.
    x4: i32,
    at_ms: u32,
}

/// Record times are kept as wrapping ms (4 bytes, not 8: ~1.5 KB less over the table);
/// [`age_us`] compares them, valid for ages up to ~24 days.
fn ms(now_us: i64) -> u32 {
    (now_us / 1000) as u32
}

fn age_us(now_us: i64, at_ms: u32) -> i64 {
    ms(now_us).wrapping_sub(at_ms) as i32 as i64 * 1000
}

#[derive(Clone, Copy, Debug)]
pub struct Peer {
    pub id: NodeId,
    rx: [RxSlot; REPORT_MAX],
    rx_head: u8,
    rx_n: u8,
    tx: [TxRec; TX_RECS],
    tx_head: u8,
    tx_n: u8,
    hist: [Rtt; HIST],
    hist_head: u8,
    hist_n: u8,
    /// The neighbour's clock rate against ours, ppb (from the last good fit).
    pub ppb: Option<i32>,
    pub phase_peer: Phase,
    want_report: bool,
    last_report_us: i64,
    next_burst_us: i64,
    burst_left: u8,
    next_probe_us: i64,
    /// Our ACKed unicasts to it since the last burst (data counts as exchanges too).
    tx_since_burst: u8,
    pub last_us: i64,
    est: Option<LinkRange>,
    est_us: i64,
}

impl Peer {
    fn new(id: NodeId, now_us: i64, first_burst_us: i64) -> Peer {
        Peer {
            id,
            rx: [RxSlot::default(); REPORT_MAX],
            rx_head: 0,
            rx_n: 0,
            tx: [TxRec::default(); TX_RECS],
            tx_head: 0,
            tx_n: 0,
            hist: [Rtt::default(); HIST],
            hist_head: 0,
            hist_n: 0,
            ppb: None,
            phase_peer: Phase::Unknown,
            want_report: false,
            last_report_us: i64::MIN / 2,
            next_burst_us: first_burst_us,
            burst_left: 0,
            next_probe_us: now_us,
            tx_since_burst: 0,
            last_us: now_us,
            est: None,
            est_us: 0,
        }
    }

    /// Unreported records, and the oldest one's age (µs).
    fn unreported(&self, now_us: i64) -> (u8, i64) {
        let mut n = 0u8;
        let mut oldest = 0i64;
        for s in self.rx_slots().filter(|s| !s.reported) {
            n += 1;
            oldest = oldest.max(age_us(now_us, s.at_ms));
        }
        (n, oldest)
    }

    fn rx_slots(&self) -> impl Iterator<Item = &RxSlot> {
        let (h, n) = (self.rx_head as usize, self.rx_n as usize);
        (0..n).map(move |i| &self.rx[(h + REPORT_MAX - n + i) % REPORT_MAX])
    }
}

/// A ranging message (the payload of a link `FRAME_TYPE_RANGE` frame, one hop, unicast).
///
/// ```text
/// 0  VERSION (1)
/// 1  kind: 1 probe, 2 report
/// 2  flags: bits 0-1 the sender's own phase state (Phase::code), bit 2 want a report
/// 3  n records (report; 0 for a probe)
/// n x 12: seq u16, t2 µs u32, t2 sub-µs i16 (raw), t3 - t2 i32 (raw)    (big-endian)
/// ```
///
/// Decoders accept trailing bytes (later additions append).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeMsg {
    Probe { phase: Phase, want_report: bool },
    Report { phase: Phase, n: u8, recs: [RxRec; REPORT_MAX] },
}

impl RangeMsg {
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let (kind, phase, want, recs): (u8, Phase, bool, &[RxRec]) = match self {
            RangeMsg::Probe { phase, want_report } => (KIND_PROBE, *phase, *want_report, &[]),
            RangeMsg::Report { phase, n, recs } => (KIND_REPORT, *phase, false, &recs[..(*n as usize).min(REPORT_MAX)]),
        };
        let len = 4 + recs.len() * REC_LEN;
        let o = out.get_mut(..len)?;
        o[0] = VERSION;
        o[1] = kind;
        o[2] = phase.code() | if want { F_WANT_REPORT } else { 0 };
        o[3] = recs.len() as u8;
        for (i, r) in recs.iter().enumerate() {
            let b = &mut o[4 + i * REC_LEN..4 + (i + 1) * REC_LEN];
            b[0..2].copy_from_slice(&r.seq.to_be_bytes());
            b[2..6].copy_from_slice(&r.t2.us.to_be_bytes());
            b[6..8].copy_from_slice(&(r.t2.sub.clamp(i16::MIN as i32, i16::MAX as i32) as i16).to_be_bytes());
            b[8..12].copy_from_slice(&r.turn.to_be_bytes());
        }
        Some(len)
    }

    pub fn decode(b: &[u8]) -> Option<RangeMsg> {
        if b.len() < 4 || b[0] != VERSION {
            return None;
        }
        let phase = Phase::from_code(b[2]);
        match b[1] {
            KIND_PROBE => Some(RangeMsg::Probe { phase, want_report: b[2] & F_WANT_REPORT != 0 }),
            KIND_REPORT => {
                let n = b[3] as usize;
                if n > REPORT_MAX || b.len() < 4 + n * REC_LEN {
                    return None;
                }
                let mut recs = [RxRec::default(); REPORT_MAX];
                for (i, r) in recs.iter_mut().take(n).enumerate() {
                    let e = &b[4 + i * REC_LEN..4 + (i + 1) * REC_LEN];
                    *r = RxRec {
                        seq: u16::from_be_bytes([e[0], e[1]]),
                        t2: FtmStamp { us: u32::from_be_bytes([e[2], e[3], e[4], e[5]]), sub: i16::from_be_bytes([e[6], e[7]]) as i32 },
                        turn: i32::from_be_bytes([e[8], e[9], e[10], e[11]]),
                    };
                }
                Some(RangeMsg::Report { phase, n: n as u8, recs })
            }
            _ => None,
        }
    }
}

/// Raw stamps outside `air + [lo, hi]` µs are not this frame's.
fn in_window(raw: i64, air_us: u32, lo_us: i64, hi_us: i64) -> bool {
    let us = air_us as i64;
    raw >= (us + lo_us) * ftm::RAW_PER_US && raw <= (us + hi_us) * ftm::RAW_PER_US
}

fn isqrt(v: u64) -> u64 {
    if v < 2 {
        return v;
    }
    let mut x = v;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + v / x) / 2;
    }
    x
}

fn median(xs: &mut [i32]) -> i32 {
    // Insertion sort: at most HIST (16) values.
    for i in 1..xs.len() {
        let mut j = i;
        while j > 0 && xs[j - 1] > xs[j] {
            xs.swap(j - 1, j);
            j -= 1;
        }
    }
    let n = xs.len();
    if n % 2 == 1 {
        xs[n / 2]
    } else {
        ((xs[n / 2 - 1] as i64 + xs[n / 2] as i64) / 2) as i32
    }
}

/// Least squares through (x µs, y raw): the slope as ppb (y raw per x µs / 640 x 1e9).
fn slope_ppb(pts: &[(i64, i64)]) -> Option<i64> {
    let n = pts.len() as i128;
    if n < 4 {
        return None;
    }
    let (sx, sy) = pts.iter().fold((0i128, 0i128), |(a, b), &(x, y)| (a + x as i128, b + y as i128));
    let (mut sxx, mut sxy) = (0i128, 0i128);
    for &(x, y) in pts {
        let dx = x as i128 * n - sx;
        let dy = y as i128 * n - sy;
        sxx += dx * dx;
        sxy += dx * dy;
    }
    if sxx == 0 {
        return None;
    }
    // 1e9 / 640 = 1_562_500.
    Some((sxy * 1_562_500 / sxx) as i64)
}

/// The ranging state of one node ([`crate::wifi_p2p::WifiP2p::ranging`]).
#[derive(Clone, Copy, Debug)]
pub struct Ranging {
    pub cfg: RangeConfig,
    pub stats: RangeStats,
    pub vote: PhaseVote,
    pub peers: [Option<Peer>; PEERS],
    rng: u32,
}

impl Ranging {
    pub fn new(seed: u32) -> Ranging {
        Ranging { cfg: RangeConfig::default(), stats: RangeStats::default(), vote: PhaseVote::default(), peers: [None; PEERS], rng: seed | 1 }
    }

    fn rand(&mut self) -> u32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    pub fn phase(&self) -> Phase {
        self.vote.state()
    }

    pub fn peer(&self, id: NodeId) -> Option<&Peer> {
        self.peers.iter().flatten().find(|p| p.id == id)
    }

    fn peer_mut(&mut self, now_us: i64, id: NodeId) -> &mut Peer {
        let i = match self.peers.iter().position(|p| p.is_some_and(|p| p.id == id)) {
            Some(i) => i,
            None => {
                let i = self.peers.iter().position(|p| p.is_none()).unwrap_or_else(|| (0..PEERS).min_by_key(|&i| self.peers[i].map_or(i64::MIN, |p| p.last_us)).unwrap_or(0));
                // The first burst a random part of a period away: peers that met together
                // never probe in step.
                let j = (self.rand() as i64).rem_euclid(self.cfg.period_us.max(1));
                self.peers[i] = Some(Peer::new(id, now_us, now_us + j / 4));
                i
            }
        };
        let p = self.peers[i].as_mut().unwrap();
        p.last_us = now_us;
        p
    }

    /// Make sure a live neighbour is ranged (the backhaul calls this for each one).
    pub fn track(&mut self, now_us: i64, id: NodeId) {
        if self.cfg.enabled && self.peer(id).is_none() {
            self.peer_mut(now_us, id);
        }
    }

    /// A unicast from `from` to us that our MAC ACKed (first copy, OFDM, received clean):
    /// its RX vector holds t2 and our ACK's t3. `air_us`: the frame's airtime.
    pub fn on_rx(&mut self, now_us: i64, from: NodeId, seq: u16, rxv: &[u8], air_us: u32) {
        if !self.cfg.enabled {
            return;
        }
        let Some(r) = RxFtm::decode(rxv) else { return };
        let turn = r.turnaround();
        if !in_window(turn, air_us, TURN_MIN_US, TURN_MAX_US) {
            self.stats.rx_bad += 1;
            return;
        }
        self.vote.add(r.phase);
        self.stats.rx_recs += 1;
        let p = self.peer_mut(now_us, from);
        let i = p.rx_head as usize;
        p.rx[i] = RxSlot { rec: RxRec { seq, t2: r.t2, turn: turn as i32 }, at_ms: ms(now_us), reported: false };
        p.rx_head = ((i + 1) % REPORT_MAX) as u8;
        p.rx_n = (p.rx_n + 1).min(REPORT_MAX as u8);
    }

    /// Our first-attempt unicast to `to` was ACKed: `words` are the TX queue's stamp words
    /// ([`TxFtm::decode`]), `air_us` the frame's airtime.
    pub fn on_tx(&mut self, now_us: i64, to: NodeId, seq: u16, words: [u32; 3], air_us: u32) {
        if !self.cfg.enabled {
            return;
        }
        let t = TxFtm::decode(words);
        let span = t.span();
        // The span is the turnaround plus the RTT (< 1.6 µs at 234 m).
        if !in_window(span, air_us, TURN_MIN_US, TURN_MAX_US + 2) {
            self.stats.tx_bad += 1;
            return;
        }
        self.stats.tx_recs += 1;
        let p = self.peer_mut(now_us, to);
        let i = p.tx_head as usize;
        p.tx[i] = TxRec { seq, t1: t.t1, span: span as i32, at_ms: ms(now_us) };
        p.tx_head = ((i + 1) % TX_RECS) as u8;
        p.tx_n = (p.tx_n + 1).min(TX_RECS as u8);
        p.tx_since_burst = p.tx_since_burst.saturating_add(1);
    }

    /// A ranging message from neighbour `from`.
    pub fn on_msg(&mut self, now_us: i64, from: NodeId, body: &[u8]) {
        if !self.cfg.enabled {
            return;
        }
        let Some(m) = RangeMsg::decode(body) else {
            self.stats.bad_msgs += 1;
            return;
        };
        match m {
            RangeMsg::Probe { phase, want_report } => {
                let p = self.peer_mut(now_us, from);
                p.phase_peer = phase;
                p.want_report |= want_report;
            }
            RangeMsg::Report { phase, n, recs } => {
                self.stats.reports_in += 1;
                self.on_report(now_us, from, phase, &recs[..n as usize]);
            }
        }
    }

    fn on_report(&mut self, now_us: i64, from: NodeId, phase: Phase, recs: &[RxRec]) {
        let k_x4 = self.cfg.k_raw_x16 as i64 / 4;
        let mut st = self.stats;
        let p = self.peer_mut(now_us, from);
        p.phase_peer = phase;
        // Join by seq with our fresh records.
        let mut joined = [(TxRec::default(), RxRec::default()); REPORT_MAX];
        let mut m = 0usize;
        for r in recs {
            if let Some(t) = p.tx[..p.tx_n as usize].iter().find(|t| t.seq == r.seq && age_us(now_us, t.at_ms) < TX_MAX_AGE_US) {
                joined[m] = (*t, *r);
                m += 1;
            }
        }
        st.matched += m as u32;
        let joined = &joined[..m];
        if joined.is_empty() {
            self.stats = st;
            return;
        }
        // Drift: the slope of (t2 - t1) over t1, both relative to the first pair.
        let (t0, r0) = joined[0];
        let mut pts = [(0i64, 0i64); REPORT_MAX];
        for (i, (t, r)) in joined.iter().enumerate() {
            let x = t.t1.minus(t0.t1);
            pts[i] = (x / ftm::RAW_PER_US, r.t2.minus(r0.t2) - x);
        }
        let span_us = pts[..m].iter().map(|p| p.0).max().unwrap_or(0) - pts[..m].iter().map(|p| p.0).min().unwrap_or(0);
        let fit = if span_us >= FIT_SPAN_US { slope_ppb(&pts[..m]) } else { None };
        match fit {
            // Two crystals within ±200 ppm; anything else is a bad join.
            Some(f) if f.abs() < 200_000 => {
                st.fits += 1;
                // Refit without points far off the line (a stale stamp), if any.
                let mut keep = [(0i64, 0i64); REPORT_MAX];
                let mut kn = 0usize;
                let mean_x = pts[..m].iter().map(|p| p.0 as i128).sum::<i128>() / m as i128;
                let mean_y = pts[..m].iter().map(|p| p.1 as i128).sum::<i128>() / m as i128;
                for &(x, y) in &pts[..m] {
                    let pred = mean_y + (x as i128 - mean_x) * f as i128 * 640 / 1_000_000_000;
                    if (y as i128 - pred).abs() <= 64 {
                        keep[kn] = (x, y);
                        kn += 1;
                    }
                }
                let f = if kn < m { slope_ppb(&keep[..kn]).filter(|g| g.abs() < 200_000).unwrap_or(f) } else { f };
                p.ppb = Some(match p.ppb {
                    None => f as i32,
                    Some(old) => (old as i64 + (f - old as i64) / 4) as i32,
                });
            }
            _ => st.no_fit += 1,
        }
        let Some(ppb) = p.ppb else {
            self.stats = st;
            return;
        };
        for (t, r) in joined {
            let turn = r.turn as i64;
            // RTT x 4 = 4 (span - turn) + 4 turn x ppb.
            let x4 = 4 * (t.span as i64 - turn) + (4 * turn * ppb as i64) / 1_000_000_000;
            if (x4 - k_x4).abs() > 4 * RTT_WINDOW_RAW {
                st.rejected += 1;
                continue;
            }
            st.exchanges += 1;
            let i = p.hist_head as usize;
            p.hist[i] = Rtt { x4: x4 as i32, at_ms: ms(now_us) };
            p.hist_head = ((i + 1) % HIST) as u8;
            p.hist_n = (p.hist_n + 1).min(HIST as u8);
        }
        self.stats = st;
        let est = self.estimate(now_us, from);
        if let Some(p) = self.peers.iter_mut().flatten().find(|p| p.id == from) {
            p.est = est;
            p.est_us = now_us;
        }
    }

    /// The robust estimate over the fresh RTTs: median, a 5-MAD cut (MAD at least 1 raw),
    /// then mean and standard error.
    fn estimate(&mut self, now_us: i64, id: NodeId) -> Option<LinkRange> {
        let phase_self = self.phase();
        let (k_x16, cal) = (self.cfg.k_raw_x16 as i64, self.cfg.calibrated);
        let p = self.peers.iter().flatten().find(|p| p.id == id)?;
        let mut xs = [0i32; HIST];
        let mut newest_age = i64::MAX;
        let mut n = 0usize;
        for r in &p.hist[..p.hist_n as usize] {
            let age = age_us(now_us, r.at_ms);
            if age <= HIST_MAX_AGE_US {
                xs[n] = r.x4;
                n += 1;
                newest_age = newest_age.min(age);
            }
        }
        if n == 0 {
            return None;
        }
        let mut sorted = xs;
        let med = median(&mut sorted[..n]) as i64;
        let mut dev = [0i32; HIST];
        for i in 0..n {
            dev[i] = (xs[i] as i64 - med).unsigned_abs().min(i32::MAX as u64) as i32;
        }
        // MAD x 1.4826 (x4 units), at least 1 raw.
        let mad = (median(&mut dev[..n]) as i64 * 14_826 / 10_000).max(4);
        let (mut sum, mut k) = (0i64, 0i64);
        for &x in &xs[..n] {
            if (x as i64 - med).abs() <= 5 * mad {
                sum += x as i64;
                k += 1;
            }
        }
        let mean_x4 = sum / k.max(1);
        let mut var = 0u64;
        for &x in &xs[..n] {
            if (x as i64 - med).abs() <= 5 * mad {
                let d = (x as i64 - mean_x4).unsigned_abs();
                var += d * d;
            }
        }
        let sd_x4 = if k > 1 { isqrt(var / (k as u64 - 1)) } else { mad as u64 };
        let se_x4 = sd_x4 * 1000 / isqrt(k as u64 * 1_000_000).max(1);
        // mm = raw x 234.21286; x4 units: / 4.
        let range_mm = ((mean_x4 * 4 - k_x16) * 234_213 / 16_000) as i32;
        let sigma_mm = (se_x4 * 234_213 / 4_000) as u32;
        Some(LinkRange {
            range_mm,
            sigma_mm,
            n: k as u8,
            age_ms: (newest_age / 1000).clamp(0, u32::MAX as i64) as u32,
            phase_self,
            phase_peer: p.phase_peer,
            calibrated: cal,
        })
    }

    /// The link to `id` as last estimated (its age brought up to `now_us`).
    pub fn link(&self, now_us: i64, id: NodeId) -> Option<LinkRange> {
        let p = self.peer(id)?;
        let mut e = p.est?;
        e.age_ms = e.age_ms.saturating_add(((now_us - p.est_us) / 1000).clamp(0, u32::MAX as i64) as u32);
        if e.age_ms as i64 * 1000 > HIST_MAX_AGE_US {
            return None;
        }
        e.phase_self = self.phase();
        Some(e)
    }

    /// The next ranging message to send, if any: a due report first, else a probe of a
    /// burst (only when `idle`: the backhaul has nothing else queued). `live(id)`: the
    /// neighbour is still heard. Returns the destination and the message length in `out`.
    pub fn poll(&mut self, now_us: i64, idle: bool, live: &dyn Fn(NodeId) -> bool, out: &mut [u8]) -> Option<(NodeId, usize)> {
        if !self.cfg.enabled {
            return None;
        }
        let phase = self.phase();
        // Reports.
        for i in 0..PEERS {
            let Some(p) = self.peers[i].as_mut() else { continue };
            let (n, oldest) = p.unreported(now_us);
            if n == 0 || now_us - p.last_report_us < REPORT_GAP_US || !live(p.id) {
                continue;
            }
            if !(n >= REPORT_MIN || p.want_report || oldest >= REPORT_STALE_US) {
                continue;
            }
            let mut recs = [RxRec::default(); REPORT_MAX];
            let mut k = 0usize;
            let (h, rn) = (p.rx_head as usize, p.rx_n as usize);
            for j in 0..rn {
                let s = &mut p.rx[(h + REPORT_MAX - rn + j) % REPORT_MAX];
                if !s.reported {
                    recs[k] = s.rec;
                    k += 1;
                    s.reported = true;
                }
            }
            p.want_report = false;
            p.last_report_us = now_us;
            let id = p.id;
            let len = RangeMsg::Report { phase, n: k as u8, recs }.encode(out)?;
            self.stats.reports += 1;
            return Some((id, len));
        }
        // Bursts.
        if !idle {
            return None;
        }
        let (period, burst) = (self.cfg.period_us.max(1), self.cfg.burst.max(1));
        for i in 0..PEERS {
            let jitter = (self.rand() as i64).rem_euclid(period / 4 + 1);
            let Some(p) = self.peers[i].as_mut() else { continue };
            if !live(p.id) {
                continue;
            }
            if p.burst_left == 0 && now_us >= p.next_burst_us {
                p.next_burst_us = now_us + period - jitter;
                // Data unicasts already gave this period's exchanges: only ask for them.
                if p.tx_since_burst >= burst {
                    p.tx_since_burst = 0;
                    p.burst_left = 1;
                } else {
                    p.burst_left = burst;
                }
                p.tx_since_burst = 0;
            }
            if p.burst_left == 0 || now_us < p.next_probe_us {
                continue;
            }
            p.burst_left -= 1;
            p.next_probe_us = now_us + PROBE_GAP_US;
            let id = p.id;
            let len = RangeMsg::Probe { phase, want_report: p.burst_left == 0 }.encode(out)?;
            self.stats.probes += 1;
            return Some((id, len));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: NodeId = 0x1170;
    const B: NodeId = 0x1f48;

    /// A simulated pair: B's clock = A's x (1 + ppb) + an offset; the true RTT `rtt_raw`;
    /// stamps exact (t1/t3 on the 8-raw tick grid, t2/t4 through the fine field).
    struct Pair {
        a: Ranging,
        b: Ranging,
        t_us: i64,
        seq: u16,
        ppb: i64,
        rtt_raw: i64,
        phase_b: u8,
    }

    /// The queue words that decode to t1 (a multiple of 8) and t4.
    fn tx_words(t1: i64, t4: i64) -> [u32; 3] {
        let a = t1 + 5120;
        assert_eq!(a.rem_euclid(8), 0);
        let (w0, tick1) = (a.div_euclid(640) as u32, (a.rem_euclid(640) / 8) as u32);
        let b = t4 + 13312;
        let (us4, fine) = (b.div_euclid(640) as u32, b.rem_euclid(640) as u32);
        [w0, (us4 & 0xffff_c000) | tick1, ((us4 & 0x3fff) << 18) | (fine << 7)]
    }

    /// The RX vector that decodes to t2 and t3 (a multiple of 8) with this phase state.
    fn rx_vec(t2: i64, t3: i64, phase: u8) -> [u8; 92] {
        let a = t3 + 5120;
        assert_eq!(a.rem_euclid(8), 0);
        let (us3, tick3) = (a.div_euclid(640) as u32, a.rem_euclid(640) / 8);
        let tick2 = (tick3 - phase as i64).rem_euclid(80);
        let b = t2 + 13312 - tick2 * 8;
        let (us2, fine) = (b.div_euclid(640) as u32, b.rem_euclid(640) as u32);
        let mut v = [0u8; 92];
        v[11] = tick2 as u8;
        v[12..16].copy_from_slice(&us2.to_le_bytes());
        v[34] = ((fine & 0xf) << 4) as u8;
        v[35] = ((fine >> 4) & 0x7f) as u8;
        v[76..80].copy_from_slice(&us3.to_le_bytes());
        v[80] = tick3 as u8;
        v
    }

    impl Pair {
        fn new(ppm: i64, rtt_raw: i64) -> Pair {
            let mut a = Ranging::new(1);
            let mut b = Ranging::new(2);
            a.cfg.enabled = true;
            b.cfg.enabled = true;
            Pair { a, b, t_us: 1_000_000, seq: 100, ppb: ppm * 1000, rtt_raw, phase_b: 41 }
        }

        /// One exchange A -> B of a frame with `air_us` airtime.
        fn exchange(&mut self, air_us: i64) {
            let t1 = self.t_us * 640 + 24;
            let b_of = |a: i64, ppb: i64| a + a * ppb / 1_000_000_000 + 123_456_789 * 640;
            let fly = self.rtt_raw / 2;
            let t2 = b_of(t1 + fly, self.ppb);
            let t3 = (t2 + (air_us + 15) * 640 + 200 + 7) / 8 * 8;
            let turn_b = t3 - t2;
            let turn_a = turn_b * 1_000_000_000 / (1_000_000_000 + self.ppb);
            let t4 = t1 + self.rtt_raw + turn_a;
            let air = air_us as u32;
            self.b.on_rx(self.t_us, A, self.seq, &rx_vec(t2, t3, self.phase_b), air);
            self.a.on_tx(self.t_us, B, self.seq, tx_words(t1, t4), air);
            self.seq = (self.seq + 1) & 0x0fff;
            self.t_us += 3_000;
        }

        fn deliver_b_to_a(&mut self) -> bool {
            let mut out = [0u8; MSG_MAX];
            let live = |_: NodeId| true;
            match self.b.poll(self.t_us, false, &live, &mut out) {
                Some((to, n)) => {
                    assert_eq!(to, A);
                    self.a.on_msg(self.t_us, B, &out[..n]);
                    true
                }
                None => false,
            }
        }
    }

    /// The simulator's stamps decode back to themselves.
    #[test]
    fn simulator_inverts_the_decode() {
        let w = tx_words(1_000_024, 1_133_931);
        let t = TxFtm::decode(w);
        assert_eq!((t.t1.us as i64 * 640 + t.t1.sub as i64, t.t4.us as i64 * 640 + t.t4.sub as i64), (1_000_024, 1_133_931));
        let v = rx_vec(5_000_001, 5_132_504, 41);
        let r = RxFtm::decode(&v).unwrap();
        assert_eq!((r.t2.us as i64 * 640 + r.t2.sub as i64, r.turnaround(), r.phase), (5_000_001, 132_503, 41));
    }

    #[test]
    fn report_round_trips() {
        let mut recs = [RxRec::default(); REPORT_MAX];
        recs[0] = RxRec { seq: 0x0abc, t2: FtmStamp { us: 0xdead_beef, sub: -12_526 }, turn: 132_502 };
        recs[1] = RxRec { seq: 1, t2: FtmStamp { us: 7, sub: 3 }, turn: -1 };
        let m = RangeMsg::Report { phase: Phase::High, n: 2, recs };
        let mut b = [0u8; MSG_MAX];
        let n = m.encode(&mut b).unwrap();
        assert_eq!(n, 4 + 2 * 12);
        assert_eq!(RangeMsg::decode(&b[..n]), Some(m));
        let p = RangeMsg::Probe { phase: Phase::Low, want_report: true };
        let n = p.encode(&mut b).unwrap();
        assert_eq!(RangeMsg::decode(&b[..n]), Some(p));
        // Trailing bytes are fine; a short report or another version is not.
        assert_eq!(RangeMsg::decode(&[1, 1, 5, 0, 9, 9]), Some(RangeMsg::Probe { phase: Phase::Low, want_report: true }));
        assert_eq!(RangeMsg::decode(&[1, 2, 0, 3, 0]), None);
        assert_eq!(RangeMsg::decode(&[2, 1, 0, 0]), None);
    }

    #[test]
    fn phase_vote() {
        let mut v = PhaseVote::default();
        assert_eq!(v.state(), Phase::Unknown);
        for _ in 0..3 {
            v.add(41);
        }
        assert_eq!(v.state(), Phase::High);
        for _ in 0..20 {
            v.add(39);
        }
        // 20 low vs 3 high: more than a tenth disagrees.
        assert_eq!(v.state(), Phase::Mixed);
        for _ in 0..20 {
            v.add(39);
        }
        assert_eq!(v.state(), Phase::Low);
    }

    /// The whole loop on a simulated pair: 49 ppm apart, a true RTT of K + 20 raw (4.7 m).
    /// Without the drift fit a 1000-byte frame would read ~2.4 m long; with it the range
    /// comes out within a few cm, flagged uncalibrated with B's phase state.
    #[test]
    fn ranges_a_simulated_pair_with_drift() {
        let k = DEFAULT_K_RAW_X16 as i64 / 16;
        let mut p = Pair::new(49, k + 20);
        for _ in 0..REPORT_MIN {
            p.exchange(1_380); // ~1000 bytes at 6 Mb/s
        }
        assert!(p.deliver_b_to_a());
        assert_eq!(p.a.stats.matched, REPORT_MIN as u32);
        assert_eq!(p.a.stats.fits, 1);
        let ppb = p.a.peer(B).unwrap().ppb.unwrap();
        assert!((ppb - 49_000).abs() < 1_000, "ppb {ppb}");
        let l = p.a.link(p.t_us, B).unwrap();
        // 20 raw x 0.234 = 4.68 m, (K is 1407.5, the true RTT 1427 -> 19.5 raw = 4.57 m).
        let want = ((k + 20) * 16 - DEFAULT_K_RAW_X16 as i64) * 234_213 / 16_000;
        assert!((l.range_mm as i64 - want).abs() < 150, "{l:?} want {want}");
        assert_eq!(l.n, REPORT_MIN);
        assert_eq!(l.phase_peer, Phase::High);
        assert!(!l.calibrated);
        // B's own vote: every record was state 41.
        assert_eq!(p.b.phase(), Phase::High);
    }

    #[test]
    fn stamps_outside_the_airtime_window_are_dropped() {
        let mut p = Pair::new(0, 1407);
        p.exchange(200);
        assert_eq!((p.a.stats.tx_recs, p.b.stats.rx_recs), (1, 1));
        // The same stamps claimed for a 500 µs frame: neither side's fits it.
        let t1 = 2_000_000 * 640 + 24;
        let t3 = t1 + 300 * 640;
        p.b.on_rx(p.t_us, A, 7, &rx_vec(t3 - 215 * 640, t3, 39), 500);
        p.a.on_tx(p.t_us, B, 7, tx_words(t1, t1 + 217 * 640), 500);
        assert_eq!((p.b.stats.rx_bad, p.a.stats.tx_bad), (1, 1));
        // A blank vector (t3 never written) is no exchange either.
        p.b.on_rx(p.t_us, A, 8, &[0u8; 92], 200);
        assert_eq!(p.b.stats.rx_bad, 2);
    }

    #[test]
    fn off_records_and_sends_nothing() {
        let mut p = Pair::new(49, 1407);
        p.a.cfg.enabled = false;
        p.b.cfg.enabled = false;
        p.exchange(200);
        assert_eq!((p.a.stats.tx_recs, p.b.stats.rx_recs), (0, 0));
        let mut out = [0u8; MSG_MAX];
        assert_eq!(p.b.poll(p.t_us, true, &|_| true, &mut out), None);
    }

    /// An idle link gets a burst: BURST probes, PROBE_GAP_US apart, only while idle, the
    /// last asking for the report; the next burst a period later.
    #[test]
    fn bursts_probe_idle_links() {
        let mut r = Ranging::new(9);
        r.cfg.enabled = true;
        r.track(0, B);
        let mut out = [0u8; MSG_MAX];
        let live = |_: NodeId| true;
        let mut t = 0i64;
        let mut probes = vec![];
        // The first burst is within a quarter period, the next at least 3/4 period later.
        while t < PERIOD_US * 3 / 4 {
            if let Some((to, n)) = r.poll(t, true, &live, &mut out) {
                assert_eq!(to, B);
                probes.push((t, RangeMsg::decode(&out[..n]).unwrap()));
            }
            // Busy: nothing.
            assert_eq!(r.poll(t, false, &live, &mut out), None);
            t += 1_000;
        }
        assert_eq!(probes.len(), BURST as usize, "{probes:?}");
        for w in probes.windows(2) {
            assert!(w[1].0 - w[0].0 >= PROBE_GAP_US);
        }
        let wants: Vec<bool> = probes.iter().map(|(_, m)| matches!(m, RangeMsg::Probe { want_report: true, .. })).collect();
        assert_eq!(wants.iter().filter(|w| **w).count(), 1);
        assert!(wants[BURST as usize - 1]);
        // A dead neighbour is not probed.
        let mut r2 = Ranging::new(9);
        r2.cfg.enabled = true;
        r2.track(0, B);
        for t in (0..PERIOD_US).step_by(1000) {
            assert_eq!(r2.poll(t, true, &|_| false, &mut out), None);
        }
    }

    /// A responder reports when the initiator asks, even with few records.
    #[test]
    fn want_report_flushes() {
        let mut p = Pair::new(10, 1410);
        for _ in 0..3 {
            p.exchange(200);
        }
        assert!(!p.deliver_b_to_a(), "3 records, not stale, not asked");
        let mut b = [0u8; MSG_MAX];
        let n = RangeMsg::Probe { phase: Phase::Low, want_report: true }.encode(&mut b).unwrap();
        p.b.on_msg(p.t_us, A, &b[..n]);
        assert!(p.deliver_b_to_a());
        assert_eq!(p.a.stats.matched, 3);
        // A probe from A also tells B A's phase state.
        assert_eq!(p.b.peer(A).unwrap().phase_peer, Phase::Low);
    }

    /// The table lives in the mesh's heap block (allocated on MESH ON only): keep it small.
    #[test]
    fn ram_stays_small() {
        let n = core::mem::size_of::<Ranging>();
        assert!(n <= 4_400, "Ranging is {n} bytes");
    }

    #[test]
    fn integer_helpers() {
        assert_eq!((isqrt(0), isqrt(1), isqrt(15), isqrt(16), isqrt(1 << 40)), (0, 1, 3, 4, 1 << 20));
        assert_eq!(median(&mut [5, 1, 3]), 3);
        assert_eq!(median(&mut [4, 1, 3, 2]), 2);
        // 8000 raw (12.5 µs) more every 125 ms: 100 ppm.
        let pts: Vec<(i64, i64)> = (0..8).map(|i| (i * 125_000, i * 8_000)).collect();
        assert_eq!(slope_ppb(&pts), Some(100_000));
    }
}
