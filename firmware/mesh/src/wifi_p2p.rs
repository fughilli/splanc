//! The 802.11 backhaul (docs/design/mesh.md §4, M3): mesh frames as Splanc Public Action
//! frames on our own netstack MAC (`ledmapper_netstack::p2p`, measured by the M3a spike).
//!
//! Pure logic over a [`Radio`] (the C6's direct TX queue in firmware, a fake in the tests),
//! so everything here runs on the host:
//!
//! - **TX** is a non-blocking state machine driven by [`WifiP2p::pump`]: one frame in the
//!   air at a time, never armed on top of another TX path's frame ([`Radio::tx_idle`]),
//!   paced on the airtime at the rate it actually goes out (plus the ACK exchange). Unicasts
//!   expect the peer's ACK and are retried in software (the C6 MAC does not retry on this
//!   path, M3a) with the Retry bit, the same sequence number and a growing backoff, so a
//!   peer deaf for one BLE event still gets the frame.
//! - **Group policy** (owner desk #70, pending): mesh data that must arrive goes either as
//!   one broadcast, or as one ACKed unicast to each live neighbour ([`GroupPolicy`], one
//!   switch). Discovery (beacons, adverts) is always one broadcast.
//! - **RX** ([`WifiP2p::on_frame`]) takes Splanc mesh frames before the STA path, learns the
//!   neighbour (MAC, node id from the envelope's clear header, RSSI from the RX vector),
//!   drops the copies a lost ACK makes, and queues the envelope for the mesh with its
//!   hardware RX timestamp mapped onto this node's clock (§6.2 needs it; M4).
//! - **Channel** (§4.2, AP-anchored): the backhaul is told the channel the radio is on
//!   ([`WifiP2p::set_channel`]); [`ChannelRule`] says which channel the mesh should be on.
//!
//! No Espressif OUI and no ESP-NOW framing (owner rule): the frame is `p2p::encode`'s.

use ledmapper_netstack::p2p;

use crate::backhaul::{Backhaul, BackhaulId, Busy, NodeId, RxMeta, TxClass, TxStamp};
use crate::ranging::{LinkRange, Ranging};
use crate::envelope::Header;

/// Envelope bytes per frame (§5.2: 250-byte bodies, short airtime at 1 Mb/s).
pub const MTU: usize = 250;
/// The largest 802.11 frame this backhaul builds (no FCS).
pub const FRAME_MAX: usize = p2p::OVERHEAD + MTU;
/// Frames queued for TX.
pub const TXQ: usize = 4;
/// Frames received and not yet taken by the mesh.
pub const RXQ: usize = 8;
/// Neighbours tracked (MAC, id, RSSI, link counters).
pub const NEIGHBOURS: usize = 8;
/// A neighbour counts as live (a fan-out target) this long after its last frame.
pub const LIVE_US: i64 = 5_000_000;
/// Longest the MAC can hold an armed frame back (BLE has the radio; M3a saw up to ~10 ms),
/// on top of its airtime, before the attempt counts as lost.
pub const COMPLETION_SLACK_US: i64 = 12_000;
/// A neighbour whose unicasts were given up this many times in a row gets 1 Mb/s for
/// [`SLOW_US`], then the configured unicast rate again (a probe).
pub const SLOW_AFTER: u8 = 3;
pub const SLOW_US: i64 = 10_000_000;
/// SIFS before an ACK.
pub const SIFS_US: u32 = 10;
/// Window over which the RX-timestamp offset is the minimum lag seen (follows drift).
pub const TS_WINDOW_US: i64 = 10_000_000;

/// The node id a MAC derives (§3.3): its low 16 bits, never broadcast or zero.
pub fn node_id_from_mac(mac: &[u8; 6]) -> NodeId {
    match u16::from_be_bytes([mac[4], mac[5]]) {
        0xFFFF => 0xFFFE,
        0 => 1,
        id => id,
    }
}

/// Airtime of a frame of `bytes` (no FCS) at TX rate code `rate`, µs.
pub fn airtime_us(rate: u8, bytes: usize) -> u32 {
    let kbps = match p2p::rate_kbps(rate) {
        0 => 1_000, // an unknown code paces as 1 Mb/s: never short
        k => k,
    };
    p2p::airtime_us(bytes, kbps)
}

/// Legacy OFDM (the rates whose stamps carry fine timing; DSSS/CCK's do not).
pub fn is_ofdm(rate: u8) -> bool {
    !matches!(p2p::rate_kbps(rate), 0 | 1_000 | 2_000 | 5_500 | 11_000)
}

/// SIFS + the peer's ACK (10 bytes) at the response rate for `rate`, µs.
pub fn ack_exchange_us(rate: u8) -> u32 {
    SIFS_US + airtime_us(p2p::response_rate(rate), 10)
}

/// How mesh data addressed to everyone goes out (owner desk #70, pending). Discovery is
/// always [`GroupPolicy::Broadcast`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum GroupPolicy {
    /// One group-addressed frame: no ACK, no retry (4-8 % lost while BLE advertises, M3a).
    Broadcast,
    /// One ACKed, retried unicast to each live neighbour (100 % in M3a, BLE or not); a
    /// broadcast when no neighbour is known yet.
    #[default]
    Unicast,
}

/// One transmit attempt's outcome.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TxResult {
    Ok,
    AckTimeout,
    Other(u8),
}

impl From<p2p::TxStatus> for TxResult {
    fn from(s: p2p::TxStatus) -> TxResult {
        match s {
            p2p::TxStatus::Ok => TxResult::Ok,
            p2p::TxStatus::AckTimeout => TxResult::AckTimeout,
            p2p::TxStatus::Other(n) => TxResult::Other(n),
        }
    }
}

/// The MAC under the backhaul.
pub trait Radio {
    /// No frame of any TX path still on air (the STA path's pacing, our previous frame).
    fn tx_idle(&mut self, now_us: i64) -> bool;
    /// Arm `frame` at TX rate code `rate`, expecting an ACK or not; `retry`: the same MPDU
    /// again (keep its sequence number; the Retry bit is already set). False if refused.
    fn arm(&mut self, frame: &mut [u8], rate: u8, ack: bool, retry: bool) -> bool;
    /// The armed frame's outcome, once the MAC reports it.
    fn tx_done(&mut self) -> Option<TxResult>;
    /// Tell the other TX paths the radio is ours for `us` from `now_us` (their pacing).
    fn hold(&mut self, now_us: i64, us: u32);
    /// This node's clock read now (µs), for completion stamps: the caller's `now_us` can be
    /// a whole tick old. None: use the caller's.
    fn now_us(&mut self) -> Option<i64> {
        None
    }
    /// The TX queue's FTM stamp words (t1, t4: [`ledmapper_netstack::ftm::TxFtm`]) of the
    /// frame [`Radio::tx_done`] just reported ACKed; read only while ranging is on. None:
    /// this MAC has none.
    fn tx_ftm(&mut self) -> Option<[u32; 3]> {
        None
    }
    /// Force the FTM tick phase ([`ledmapper_netstack::ftm::force_phase`]); false if not
    /// done (a frame is armed, or this MAC cannot).
    fn force_phase(&mut self) -> bool {
        false
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct P2pConfig {
    pub mac: [u8; 6],
    /// TX rate codes (`p2p::RATE_*`) for broadcasts and unicasts.
    pub rate_bcast: u8,
    pub rate_ucast: u8,
    /// Attempts per unicast (1 = no retry).
    pub tries: u8,
    pub policy: GroupPolicy,
    /// Learn neighbours only from frames of this mesh (None: any).
    pub mesh_id: Option<u32>,
}

impl P2pConfig {
    pub fn new(mac: [u8; 6]) -> P2pConfig {
        // Unicasts at 6 Mb/s OFDM: ~6x less airtime than 1 Mb/s, and M3a delivered every
        // ACKed unicast at every rate; a neighbour that keeps failing drops to 1 Mb/s
        // (SLOW_AFTER). Broadcasts (discovery) stay at 1 Mb/s: robust, longest range.
        P2pConfig { mac, rate_bcast: p2p::RATE_1M, rate_ucast: p2p::RATE_6M, tries: 4, policy: GroupPolicy::default(), mesh_id: None }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct P2pNeighbour {
    pub id: NodeId,
    pub mac: [u8; 6],
    /// Last RSSI, and a running average (×16, 1/8 weight), dBm.
    pub rssi: i8,
    pub rssi_avg_x16: i16,
    pub first_us: i64,
    pub last_us: i64,
    pub rx: u32,
    /// Unicasts to it: delivered (ACKed), given up, and the retries the delivered ones took.
    pub tx_ok: u32,
    pub tx_fail: u32,
    pub retries: u32,
    /// The channel its last frame came in on.
    pub channel: u8,
    /// Unicasts given up in a row, and until when it gets 1 Mb/s (see [`SLOW_AFTER`]).
    pub fail_run: u8,
    pub slow_until_us: i64,
    last_seq: u16,
}

impl P2pNeighbour {
    pub fn rssi_avg(&self) -> i8 {
        (self.rssi_avg_x16 / 16) as i8
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct P2pStats {
    pub tx_queued: u32,
    /// `send` refused: the queue was full.
    pub tx_full: u32,
    /// Frames too big for the MTU.
    pub tx_oversize: u32,
    pub tx_bcast: u32,
    pub tx_ucast_ok: u32,
    pub tx_ucast_fail: u32,
    /// Attempts on air, retries among them, ACK timeouts, other failure codes, attempts
    /// the MAC never reported.
    pub attempts: u32,
    pub retries: u32,
    pub ack_timeouts: u32,
    pub tx_other: u32,
    pub no_completion: u32,
    /// The MAC refused an arm.
    pub arm_refused: u32,
    /// Fan-out frames (one per data frame under `GroupPolicy::Unicast`) and the unicasts
    /// they became; fan-outs with nobody to send to went as a broadcast.
    pub fanouts: u32,
    pub fanout_ucasts: u32,
    pub fanout_bcast: u32,
    pub rx_frames: u32,
    /// Mesh frames for someone else (overheard unicasts), own frames heard back, MAC
    /// retries of a frame already taken, not an envelope, RX queue full.
    pub rx_overheard: u32,
    pub rx_own: u32,
    pub rx_dup_retry: u32,
    pub rx_not_envelope: u32,
    pub rx_overflow: u32,
    /// Frames on another kind (the link probe, diagnostics): left to the caller.
    pub rx_other_kind: u32,
    /// Reaped frames longer than their RX vector's MPDU (word padding), trimmed.
    pub rx_trimmed: u32,
    /// Neighbours dropped to 1 Mb/s after repeated unicast failures.
    pub slowed: u32,
    pub channel_changes: u32,
    /// Time beacons (M4): completions stamped, and lost (no completion reported).
    pub time_stamped: u32,
    pub time_lost: u32,
    /// The longest any frame was held between arm and done (µs; BLE coex holds it), and the
    /// widest completion bracket (µs).
    pub hold_max_us: u32,
    pub bracket_max_us: u32,
}

#[derive(Clone, Copy)]
enum Dest {
    Broadcast,
    Mac([u8; 6]),
    /// Neighbour slots still to send to.
    Fanout(u8),
}

#[derive(Clone, Copy)]
struct TxSlot {
    len: u16,
    dest: Dest,
    /// A time beacon: stamp its completion.
    stamp: bool,
    buf: [u8; FRAME_MAX],
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    Broadcast,
    Mac { mac: [u8; 6], nb: Option<usize> },
}

#[derive(Clone, Copy, Debug)]
struct Current {
    target: Target,
    attempt: u8,
    inflight: bool,
    deadline_us: i64,
    not_before_us: i64,
    /// When this attempt was armed, and the last poll that still saw it in flight.
    armed_us: i64,
    poll_us: i64,
    /// The rate code this attempt went out at (ranging's airtime check).
    rate: u8,
}

#[derive(Clone, Copy)]
struct RxSlot {
    meta: RxMeta,
    buf: [u8; MTU],
}

/// What [`WifiP2p::on_frame`] did with a reaped frame.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RxVerdict {
    /// Not a Splanc frame: the STA path's.
    NotSplanc,
    /// A Splanc frame of another kind (`kind`): the caller's (diagnostics).
    OtherKind(u8),
    /// A mesh frame: taken (queued, or dropped and counted).
    Taken,
}

/// Maps the RX vector's 1 MHz timestamp onto this node's clock.
///
/// **Hardware anchor (M4).** The transport reads the MAC's TSF counter next to `esp_timer`
/// every loop pass ([`RxClock::anchor`]); when the RX vector's stamp is that counter (M4
/// checks it on silicon: the mapped arrival must precede its reap by a small, positive lag),
/// an arrival maps exactly: `esp_timer = anchor_esp + (stamp - anchor_tsf)`, with no reap
/// lag in it. Anchors whose read was interrupted (a wide `esp_timer` bracket) are skipped;
/// a jump in the TSF-to-`esp_timer` offset (a MAC reset) is counted and re-anchored.
///
/// **Fallback (M3).** Without anchors, or for a stamp the anchor maps implausibly (it would
/// arrive after its reap, or more than a second before it), the reap-lag floor: the
/// hardware clock runs a constant offset from `esp_timer` (M3a: ~0.70 s behind), and a frame
/// is reaped some time after it arrived, never before; the smallest lag in the current and
/// the previous window is the offset.
#[derive(Clone, Copy, Debug, Default)]
pub struct RxClock {
    cur_min: Option<i64>,
    prev_min: Option<i64>,
    window_start_us: i64,
    /// The newest good (esp_timer, TSF) pair, and the first of the current segment (the
    /// drift baseline).
    anchor: Option<(i64, u32)>,
    seg: Option<(i64, u32)>,
    pub stats: RxClockStats,
}

/// [`RxClock`]'s counters: how the hardware anchor behaves on silicon.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RxClockStats {
    pub anchors: u32,
    /// Anchor reads interrupted (bracket too wide) and skipped.
    pub anchor_wide: u32,
    /// The TSF-to-esp_timer offset moved more than [`ANCHOR_JUMP_US`] between anchors.
    pub jumps: u32,
    /// Arrivals mapped by the anchor, and by the floor (no anchor, or implausible).
    pub mapped_hw: u32,
    pub mapped_floor: u32,
    pub implausible: u32,
    /// Reap lag of anchor-mapped arrivals (µs): min and max.
    pub lag_min_us: i32,
    pub lag_max_us: i32,
    /// esp_timer minus TSF (µs, the newest anchor), and the drift between them (ppb) over
    /// the current segment.
    pub offset_us: i64,
    pub drift_ppb: i64,
}

/// An anchor read whose `esp_timer` bracket is wider than this was interrupted.
pub const ANCHOR_BRACKET_US: i64 = 6;
/// A TSF-to-esp_timer offset change larger than this between anchors is a jump.
pub const ANCHOR_JUMP_US: i64 = 50;

impl RxClock {
    /// A (TSF, esp_timer) reading: `esp_before`, the TSF counter, `esp_after`.
    pub fn anchor(&mut self, esp_before: i64, hw: u32, esp_after: i64) {
        let bracket = esp_after - esp_before;
        if !(0..=ANCHOR_BRACKET_US).contains(&bracket) {
            self.stats.anchor_wide += 1;
            return;
        }
        let esp = esp_before + bracket / 2;
        if let Some((pe, ph)) = self.anchor {
            let pred = pe + hw.wrapping_sub(ph) as i32 as i64;
            let slack = ANCHOR_JUMP_US + (esp - pe).abs() / 10_000; // + 100 ppm
            if (esp - pred).abs() > slack {
                self.stats.jumps += 1;
                self.seg = None;
            }
        }
        let (se, sh) = *self.seg.get_or_insert((esp, hw));
        let span = esp - se;
        if span >= 10_000_000 {
            let hw_span = hw.wrapping_sub(sh) as i64;
            self.stats.drift_ppb = (span - hw_span) * 1_000_000_000 / span;
            if span > 1_800_000_000 {
                // Restart the baseline well before the 32-bit counter wraps (71 min).
                self.seg = Some((esp, hw));
            }
        }
        self.anchor = Some((esp, hw));
        self.stats.anchors += 1;
        self.stats.offset_us = esp - hw as i64;
    }

    /// Whether arrivals map through the hardware anchor.
    pub fn anchored(&self) -> bool {
        self.anchor.is_some()
    }

    /// `reap_us`: this node's clock when the frame was reaped; `hw_ts`: the vector's stamp.
    /// The frame's arrival on this node's clock.
    pub fn map(&mut self, reap_us: i64, hw_ts: u32) -> i64 {
        let floor = self.map_floor(reap_us, hw_ts);
        if let Some((ae, ah)) = self.anchor {
            let rx = ae + hw_ts.wrapping_sub(ah) as i32 as i64;
            let lag = reap_us - rx;
            if (-20..1_000_000).contains(&lag) {
                let first = self.stats.mapped_hw == 0;
                self.stats.mapped_hw += 1;
                let l = lag as i32;
                self.stats.lag_min_us = if first { l } else { self.stats.lag_min_us.min(l) };
                self.stats.lag_max_us = if first { l } else { self.stats.lag_max_us.max(l) };
                return rx;
            }
            self.stats.implausible += 1;
        }
        self.stats.mapped_floor += 1;
        floor
    }

    fn map_floor(&mut self, reap_us: i64, hw_ts: u32) -> i64 {
        // Wrap-safe: the lag is the 32-bit difference (the hardware clock wraps at 2^32 µs).
        let lag = (reap_us as u32).wrapping_sub(hw_ts) as i32 as i64;
        if reap_us - self.window_start_us >= TS_WINDOW_US {
            self.prev_min = self.cur_min;
            self.cur_min = None;
            self.window_start_us = reap_us;
        }
        self.cur_min = Some(self.cur_min.map_or(lag, |m| m.min(lag)));
        let off = match self.prev_min {
            Some(p) => p.min(self.cur_min.unwrap_or(p)),
            None => self.cur_min.unwrap_or(lag),
        };
        reap_us - (lag - off).max(0)
    }

    /// The reap-lag floor's offset estimate, µs (M3's mapping; compare with
    /// `stats.offset_us`).
    pub fn offset_us(&self) -> Option<i64> {
        match (self.cur_min, self.prev_min) {
            (Some(a), Some(b)) => Some(a.min(b)),
            (a, b) => a.or(b),
        }
    }
}

/// The channel rules of §4.2 for the AP-anchored mesh (M3): where the mesh should be.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ChannelRule {
    /// The channel the mesh is on now.
    pub channel: u8,
    /// Times the mesh followed the AP to another channel.
    pub moves: u32,
}

/// What [`ChannelRule::decide`] wants.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChannelAction {
    /// Stay where we are.
    Stay,
    /// The AP is elsewhere now: the mesh is on `to` (the radio is already there; the
    /// adverts announce it from now on).
    Followed { from: u8, to: u8 },
    /// Not associated, and our mesh's adverts announce `to`: the place to camp. The
    /// AP-anchored build only reports it; `kModeMesh` (next PR) tunes there.
    Camp { to: u8 },
}

impl ChannelRule {
    /// `assoc`: the AP's channel while associated; `radio`: the channel the radio is on;
    /// `heard`: the channel our mesh's adverts announce (the most recent).
    pub fn decide(&mut self, assoc: Option<u8>, radio: u8, heard: Option<u8>) -> ChannelAction {
        if let Some(ap) = assoc {
            if self.channel != ap {
                let from = self.channel;
                self.channel = ap;
                if from != 0 {
                    self.moves += 1;
                    return ChannelAction::Followed { from, to: ap };
                }
            }
            return ChannelAction::Stay;
        }
        if self.channel == 0 {
            self.channel = radio;
        }
        match heard {
            Some(h) if h != 0 && h != radio => ChannelAction::Camp { to: h },
            _ => ChannelAction::Stay,
        }
    }
}

/// The 802.11 backhaul.
pub struct WifiP2p {
    pub cfg: P2pConfig,
    pub stats: P2pStats,
    pub neighbours: [Option<P2pNeighbour>; NEIGHBOURS],
    pub clock: RxClock,
    pub backhaul: BackhaulId,
    channel: u8,
    seq: u16,
    rng: u32,
    txq: [TxSlot; TXQ],
    tx_head: usize,
    tx_len: usize,
    cur: Option<Current>,
    rxq: [RxSlot; RXQ],
    rx_head: usize,
    rx_len: usize,
    /// A copy of the last data frame queued (the replay check, [`WifiP2p::replay_last`]):
    /// beacons and adverts never displace it.
    last_len: u16,
    last_data: [u8; FRAME_MAX],
    /// The newest clock reading seen (pump, on_frame): `send` has no clock argument.
    now_us: i64,
    /// The last frame's (armed, done) times, any class (diagnostics, M4), and the last time
    /// beacon's completion, until taken.
    pub last_tx: TxStamp,
    stamp: Option<TxStamp>,
    /// Link ranging ([`crate::ranging`]): off by default (`ranging.cfg.enabled`).
    pub ranging: Ranging,
}

impl WifiP2p {
    pub fn new(cfg: P2pConfig, channel: u8) -> WifiP2p {
        let seed = u32::from_le_bytes([cfg.mac[2], cfg.mac[3], cfg.mac[4], cfg.mac[5]]) | 1;
        WifiP2p {
            cfg,
            stats: P2pStats::default(),
            neighbours: [None; NEIGHBOURS],
            clock: RxClock::default(),
            backhaul: BackhaulId(0),
            channel,
            seq: 0,
            rng: seed,
            txq: [TxSlot { len: 0, dest: Dest::Broadcast, stamp: false, buf: [0; FRAME_MAX] }; TXQ],
            tx_head: 0,
            tx_len: 0,
            cur: None,
            rxq: [RxSlot { meta: RxMeta { len: 0, rssi_dbm: 0, rx_us: 0, src_mac: [0; 6], backhaul: BackhaulId(0) }, buf: [0; MTU] }; RXQ],
            rx_head: 0,
            rx_len: 0,
            last_len: 0,
            last_data: [0; FRAME_MAX],
            now_us: 0,
            last_tx: TxStamp::default(),
            stamp: None,
            ranging: Ranging::new(seed.rotate_left(16)),
        }
    }

    pub fn channel(&self) -> u8 {
        self.channel
    }

    /// The radio is on `ch` now (a rejoin or the AP moved). Neighbours stay: they follow
    /// the same AP.
    pub fn set_channel(&mut self, ch: u8) {
        if ch != self.channel {
            self.channel = ch;
            self.stats.channel_changes += 1;
        }
    }

    fn rand(&mut self) -> u32 {
        // xorshift32: backoff jitter only.
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    /// Live neighbours (heard within [`LIVE_US`]) as a slot bitmask.
    pub fn live_mask(&self, now_us: i64) -> u8 {
        let mut m = 0u8;
        for (i, n) in self.neighbours.iter().enumerate() {
            if n.is_some_and(|n| now_us - n.last_us < LIVE_US) {
                m |= 1 << i;
            }
        }
        m
    }

    pub fn neighbour(&self, id: NodeId) -> Option<&P2pNeighbour> {
        self.neighbours.iter().flatten().find(|n| n.id == id)
    }

    /// Frames waiting to go out (the one in flight included).
    pub fn tx_pending(&self) -> usize {
        self.tx_len
    }

    /// A unicast is in flight and the MAC has not reported it yet.
    pub fn awaiting_ack(&self) -> bool {
        self.cur.is_some_and(|c| c.inflight && matches!(c.target, Target::Mac { .. }))
    }

    /// A frame is in flight (armed, not yet reported).
    pub fn inflight(&self) -> bool {
        self.cur.is_some_and(|c| c.inflight)
    }

    fn enqueue(&mut self, frame: &[u8], dest: Dest, stamp: bool) -> Result<(), Busy> {
        if frame.len() > MTU {
            self.stats.tx_oversize += 1;
            return Err(Busy);
        }
        if self.tx_len == TXQ {
            self.stats.tx_full += 1;
            return Err(Busy);
        }
        let i = (self.tx_head + self.tx_len) % TXQ;
        let da = match dest {
            Dest::Mac(m) => m,
            _ => p2p::BROADCAST,
        };
        let seq = self.seq;
        self.seq = (self.seq + 1) & 0x0fff;
        let mac = self.cfg.mac;
        let s = &mut self.txq[i];
        let Some(n) = p2p::encode(&da, &mac, seq, p2p::KIND_MESH_V1, frame, &mut s.buf) else {
            self.stats.tx_oversize += 1;
            return Err(Busy);
        };
        s.len = n as u16;
        s.dest = dest;
        s.stamp = stamp;
        self.tx_len += 1;
        self.stats.tx_queued += 1;
        Ok(())
    }

    /// Queue `frame` as `class` for `dst` (None: everyone).
    pub fn queue(&mut self, now_us: i64, frame: &[u8], dst: Option<NodeId>, class: TxClass) -> Result<(), Busy> {
        let dest = match dst {
            Some(id) => match self.neighbour(id) {
                Some(n) => Dest::Mac(n.mac),
                // An id we have not heard: a broadcast (the link frame names its target).
                None => Dest::Broadcast,
            },
            None if class == TxClass::Data && self.cfg.policy == GroupPolicy::Unicast => {
                self.stats.fanouts += 1;
                match self.live_mask(now_us) {
                    0 => {
                        self.stats.fanout_bcast += 1;
                        Dest::Broadcast
                    }
                    m => Dest::Fanout(m),
                }
            }
            None => Dest::Broadcast,
        };
        self.enqueue(frame, dest, class == TxClass::Time)?;
        if class == TxClass::Data {
            let i = (self.tx_head + self.tx_len - 1) % TXQ;
            let n = self.txq[i].len as usize;
            self.last_data[..n].copy_from_slice(&self.txq[i].buf[..n]);
            self.last_len = n as u16;
        }
        Ok(())
    }

    /// Re-send the last data frame verbatim (same envelope, same counter): what an attacker
    /// replaying a captured frame does. Test-only (the HITL envelope check).
    pub fn replay_last(&mut self) -> bool {
        if self.last_len == 0 || self.tx_len == TXQ {
            return false;
        }
        let n = self.last_len as usize;
        let i = (self.tx_head + self.tx_len) % TXQ;
        let s = &mut self.txq[i];
        s.buf[..n].copy_from_slice(&self.last_data[..n]);
        s.buf[4..10].copy_from_slice(&p2p::BROADCAST);
        s.buf[1] &= !p2p::FC1_RETRY;
        s.len = n as u16;
        s.dest = Dest::Broadcast;
        s.stamp = false;
        self.tx_len += 1;
        true
    }

    /// The next target of the head slot, consuming it when it has none left.
    fn next_target(&mut self, now_us: i64) -> Option<Target> {
        while self.tx_len > 0 {
            let h = self.tx_head;
            match self.txq[h].dest {
                Dest::Broadcast => return Some(Target::Broadcast),
                Dest::Mac(mac) => return Some(Target::Mac { mac, nb: None }),
                Dest::Fanout(mask) => {
                    let live = self.live_mask(now_us);
                    let mut m = mask;
                    while m != 0 {
                        let i = m.trailing_zeros() as usize;
                        m &= !(1 << i);
                        if live & (1 << i) != 0 {
                            let n = self.neighbours[i].unwrap();
                            self.txq[h].dest = Dest::Fanout(m);
                            self.stats.fanout_ucasts += 1;
                            return Some(Target::Mac { mac: n.mac, nb: Some(i) });
                        }
                    }
                    self.pop_head();
                }
            }
        }
        None
    }

    fn pop_head(&mut self) {
        if self.tx_len > 0 {
            self.tx_head = (self.tx_head + 1) % TXQ;
            self.tx_len -= 1;
        }
    }

    /// The current target is done (sent, delivered or given up).
    fn target_done(&mut self) {
        self.cur = None;
        if self.tx_len > 0 && matches!(self.txq[self.tx_head].dest, Dest::Broadcast | Dest::Mac(_)) {
            self.pop_head();
        }
    }

    fn nb_index(&self, mac: &[u8; 6]) -> Option<usize> {
        self.neighbours.iter().position(|n| n.is_some_and(|n| &n.mac == mac))
    }

    /// Drive TX: collect the in-flight frame's outcome, retry or move on, arm the next.
    /// Call every loop pass; never blocks.
    pub fn pump(&mut self, now_us: i64, radio: &mut dyn Radio) {
        self.now_us = self.now_us.max(now_us);
        // Ranging's phase force, between frames (nothing of ours in flight).
        if self.ranging.force_pending && self.cur.is_none() && radio.tx_idle(now_us) && radio.force_phase() {
            self.ranging.on_forced();
        }
        for _ in 0..3 {
            if self.settle(now_us, radio) {
                return;
            }
            if self.cur.is_none() {
                let Some(t) = self.next_target(now_us) else { return };
                self.cur = Some(Current { target: t, attempt: 1, inflight: false, deadline_us: 0, not_before_us: now_us, armed_us: 0, poll_us: 0, rate: 0 });
            }
            let mut c = self.cur.unwrap();
            if now_us < c.not_before_us || !radio.tx_idle(now_us) {
                return;
            }
            let h = self.tx_head;
            let len = self.txq[h].len as usize;
            let (ack, rate) = match c.target {
                Target::Broadcast => {
                    self.txq[h].buf[4..10].copy_from_slice(&p2p::BROADCAST);
                    (false, self.cfg.rate_bcast)
                }
                Target::Mac { mac, nb } => {
                    self.txq[h].buf[4..10].copy_from_slice(&mac);
                    let slow = nb.or_else(|| self.nb_index(&mac)).and_then(|i| self.neighbours[i]).is_some_and(|n| now_us < n.slow_until_us);
                    (true, if slow { p2p::RATE_1M } else { self.cfg.rate_ucast })
                }
            };
            let retry = c.attempt > 1;
            if retry {
                self.txq[h].buf[1] |= p2p::FC1_RETRY;
            } else {
                self.txq[h].buf[1] &= !p2p::FC1_RETRY;
            }
            if !radio.arm(&mut self.txq[h].buf[..len], rate, ack, retry) {
                self.stats.arm_refused += 1;
                c.not_before_us = now_us + 1_000;
                self.cur = Some(c);
                return;
            }
            self.stats.attempts += 1;
            if retry {
                self.stats.retries += 1;
            }
            let air = airtime_us(rate, len) + if ack { ack_exchange_us(rate) } else { 0 };
            radio.hold(now_us, air + 100);
            let armed = radio.now_us().unwrap_or(now_us);
            c.inflight = true;
            c.rate = rate;
            c.armed_us = armed;
            c.poll_us = armed;
            c.deadline_us = now_us + air as i64 + COMPLETION_SLACK_US;
            self.cur = Some(c);
        }
    }

    /// Collect the in-flight frame's outcome if the MAC has it (or its time is up), never
    /// arming anything: what another TX path calls before it needs the queue. True while
    /// the frame is still in flight.
    pub fn settle(&mut self, now_us: i64, radio: &mut dyn Radio) -> bool {
        let Some(c) = self.cur.filter(|c| c.inflight) else { return false };
        // Read the clock BEFORE the MAC: if it says done, the completion is between the last
        // poll that saw it in flight and this reading (the two-step stamp's bracket).
        let t = radio.now_us().unwrap_or(now_us);
        let outcome = match radio.tx_done() {
            Some(r) => Some(r),
            None if now_us >= c.deadline_us => None,
            None => {
                if let Some(cur) = self.cur.as_mut() {
                    cur.poll_us = t.max(cur.poll_us);
                }
                return true;
            }
        };
        if outcome.is_some() {
            let done = c.poll_us + (t - c.poll_us).max(0) / 2;
            let st = TxStamp { armed_us: c.armed_us, done_us: done, err_us: (t - c.poll_us).max(0) / 2 };
            self.last_tx = st;
            self.stats.hold_max_us = self.stats.hold_max_us.max((t - c.armed_us).clamp(0, u32::MAX as i64) as u32);
            self.stats.bracket_max_us = self.stats.bracket_max_us.max((t - c.poll_us).clamp(0, u32::MAX as i64) as u32);
            if self.tx_len > 0 && self.txq[self.tx_head].stamp {
                self.stamp = Some(st);
                self.stats.time_stamped += 1;
            }
            if outcome == Some(TxResult::Ok) && c.attempt == 1 && self.ranging.on() && self.tx_len > 0 {
                self.range_tx(t, c, radio);
            }
        } else if self.tx_len > 0 && self.txq[self.tx_head].stamp {
            self.stats.time_lost += 1;
        }
        self.finish(now_us, c, outcome);
        false
    }

    /// A first-attempt unicast was ACKed: its stamps are a half-exchange (OFDM only: DSSS
    /// stamps carry no fine timing).
    fn range_tx(&mut self, now_us: i64, c: Current, radio: &mut dyn Radio) {
        let Target::Mac { mac, nb } = c.target else { return };
        if !is_ofdm(c.rate) {
            return;
        }
        let Some(id) = nb.or_else(|| self.nb_index(&mac)).and_then(|i| self.neighbours[i]).map(|n| n.id) else { return };
        let Some(words) = radio.tx_ftm() else { return };
        let s = &self.txq[self.tx_head];
        let len = s.len as usize;
        let seq = u16::from_le_bytes([s.buf[22], s.buf[23]]) >> 4;
        self.ranging.on_tx(now_us, id, seq, words, airtime_us(c.rate, len));
    }

    fn finish(&mut self, now_us: i64, mut c: Current, outcome: Option<TxResult>) {
        match outcome {
            None => self.stats.no_completion += 1,
            Some(TxResult::AckTimeout) => self.stats.ack_timeouts += 1,
            Some(TxResult::Other(_)) => self.stats.tx_other += 1,
            Some(TxResult::Ok) => {}
        }
        match c.target {
            Target::Broadcast => {
                self.stats.tx_bcast += 1;
                self.target_done();
            }
            Target::Mac { mac, nb } => {
                let nb = nb.or_else(|| self.nb_index(&mac));
                if outcome == Some(TxResult::Ok) {
                    self.stats.tx_ucast_ok += 1;
                    if let Some(n) = nb.and_then(|i| self.neighbours[i].as_mut()) {
                        n.tx_ok += 1;
                        n.retries += (c.attempt - 1) as u32;
                        n.fail_run = 0;
                    }
                    self.target_done();
                } else if c.attempt < self.cfg.tries.max(1) {
                    // Back off before the retry, longer each time (2, 4, 6 ms + up to 1 ms):
                    // a peer that missed it was usually deaf for a BLE event (M3a r3: four
                    // back-to-back attempts all landed in the same window).
                    let back = 2_000 * c.attempt as i64 + (self.rand() % 1_000) as i64;
                    c.attempt += 1;
                    c.inflight = false;
                    c.not_before_us = now_us + back;
                    self.cur = Some(c);
                } else {
                    self.stats.tx_ucast_fail += 1;
                    if let Some(n) = nb.and_then(|i| self.neighbours[i].as_mut()) {
                        n.tx_fail += 1;
                        n.fail_run = n.fail_run.saturating_add(1);
                        if n.fail_run >= SLOW_AFTER {
                            n.fail_run = 0;
                            n.slow_until_us = now_us + SLOW_US;
                            self.stats.slowed += 1;
                        }
                    }
                    self.target_done();
                }
            }
        }
    }

    /// A reaped frame, before the STA path sees it. `rxv`: its 92-byte RX vector (RSSI,
    /// timestamp), if the reap kept it; `reap_us`: this node's clock at the reap.
    pub fn on_frame(&mut self, reap_us: i64, frame: &[u8], rxv: Option<&[u8]>) -> RxVerdict {
        let v = rxv.and_then(p2p::RxVector::decode);
        // The reaped length is rounded up to a 4-byte multiple (the RX DMA writes words):
        // up to 3 bytes of junk after the MPDU, which the envelope's MIC and the exact-length
        // membership messages do not survive (mesh_smoke r4/r5: every advert "malformed",
        // MIC failures on any frame whose length was not a multiple of 4; M3a's fixed
        // 256-byte probes never showed it). The RX vector's sig_len (MPDU + FCS) is exact.
        let frame = match v.map(|v| v.sig_len as usize) {
            Some(sig) if sig >= 4 + p2p::OVERHEAD && sig - 4 < frame.len() => {
                self.stats.rx_trimmed += 1;
                &frame[..sig - 4]
            }
            _ => frame,
        };
        let Some(p) = p2p::parse(frame) else { return RxVerdict::NotSplanc };
        self.now_us = self.now_us.max(reap_us);
        if p.kind != p2p::KIND_MESH_V1 {
            self.stats.rx_other_kind += 1;
            return RxVerdict::OtherKind(p.kind);
        }
        self.stats.rx_frames += 1;
        if p.sa == self.cfg.mac {
            self.stats.rx_own += 1;
            return RxVerdict::Taken;
        }
        let rssi = v.map_or(0, |v| v.rssi);
        let rx_us = match v {
            Some(v) => self.clock.map(reap_us, v.timestamp_us),
            None => reap_us,
        };
        let Ok(h) = Header::decode(p.payload) else {
            self.stats.rx_not_envelope += 1;
            return RxVerdict::Taken;
        };
        // Learn the neighbour from every frame of our mesh (overheard unicasts included).
        let ours = self.cfg.mesh_id.is_none_or(|m| m == h.mesh_id);
        let dup = if ours { self.learn(reap_us, &p, h.src, rssi) } else { false };
        // Ranging: a first copy of a unicast to us, which our MAC ACKed (its RX vector holds
        // t2 and our ACK's t3), received clean as legacy OFDM.
        if ours && self.ranging.on() && p.da == self.cfg.mac && !p.retry {
            if let (Some(v), Some(raw)) = (v, rxv) {
                if v.bb_format == p2p::BB_FORMAT_11G && v.rx_state == 0 && v.rxend_state == 0 {
                    self.ranging.on_rx(reap_us, h.src, p.seq, raw, p2p::airtime_us(frame.len(), v.rate_kbps()));
                }
            }
        }
        // A unicast to another neighbour is still a mesh frame (the flood): hearing a
        // neighbour's relay is what cancels our own (the swarm's relay rule), so it goes up
        // too; the mesh's dedup drops what it already has.
        if p.da != p2p::BROADCAST && p.da != self.cfg.mac {
            self.stats.rx_overheard += 1;
        }
        if dup {
            self.stats.rx_dup_retry += 1;
            return RxVerdict::Taken;
        }
        if p.payload.len() > MTU {
            self.stats.rx_not_envelope += 1;
            return RxVerdict::Taken;
        }
        if self.rx_len == RXQ {
            self.stats.rx_overflow += 1;
            return RxVerdict::Taken;
        }
        let i = (self.rx_head + self.rx_len) % RXQ;
        let s = &mut self.rxq[i];
        s.buf[..p.payload.len()].copy_from_slice(p.payload);
        s.meta = RxMeta { len: p.payload.len(), rssi_dbm: rssi, rx_us, src_mac: p.sa, backhaul: self.backhaul };
        self.rx_len += 1;
        RxVerdict::Taken
    }

    /// Update (or add) the neighbour a frame came from; true if it is a MAC retry of the
    /// last frame we took from it (a lost ACK's copy).
    fn learn(&mut self, now_us: i64, p: &p2p::Parsed<'_>, id: NodeId, rssi: i8) -> bool {
        let i = self
            .nb_index(&p.sa)
            .or_else(|| self.neighbours.iter().position(|n| n.is_none()))
            .unwrap_or_else(|| (0..NEIGHBOURS).min_by_key(|&i| self.neighbours[i].map_or(i64::MIN, |n| n.last_us)).unwrap_or(0));
        let fresh = self.neighbours[i].filter(|n| n.mac == p.sa).is_none();
        if fresh {
            self.neighbours[i] = Some(P2pNeighbour { id, mac: p.sa, rssi, rssi_avg_x16: rssi as i16 * 16, first_us: now_us, last_seq: 0xFFFF, ..Default::default() });
        }
        let ch = self.channel;
        let n = self.neighbours[i].as_mut().unwrap();
        let dup = p.retry && p.seq == n.last_seq && (p.da == self.cfg.mac || p.da == p2p::BROADCAST);
        n.id = id;
        n.rssi = rssi;
        n.rssi_avg_x16 += (rssi as i16 * 16 - n.rssi_avg_x16) / 8;
        n.last_us = now_us;
        n.rx += 1;
        n.channel = ch;
        if p.da == self.cfg.mac || p.da == p2p::BROADCAST {
            n.last_seq = p.seq;
        }
        dup
    }
}

impl Backhaul for WifiP2p {
    fn mtu(&self) -> usize {
        MTU
    }

    fn send(&mut self, frame: &[u8], dst: Option<NodeId>) -> Result<(), Busy> {
        self.send_class(frame, dst, TxClass::Data)
    }

    fn send_class(&mut self, frame: &[u8], dst: Option<NodeId>, class: TxClass) -> Result<(), Busy> {
        self.queue(self.now_us, frame, dst, class)
    }

    fn take_tx_stamp(&mut self) -> Option<TxStamp> {
        self.stamp.take()
    }

    fn recv(&mut self, buf: &mut [u8]) -> Option<RxMeta> {
        if self.rx_len == 0 {
            return None;
        }
        let s = &self.rxq[self.rx_head];
        let n = s.meta.len.min(buf.len());
        buf[..n].copy_from_slice(&s.buf[..n]);
        let meta = RxMeta { len: n, ..s.meta };
        self.rx_head = (self.rx_head + 1) % RXQ;
        self.rx_len -= 1;
        Some(meta)
    }

    fn may_send(&self, _now_us: i64) -> bool {
        self.tx_len < TXQ
    }

    fn links(&self, now_us: i64, out: &mut [crate::topo::Link]) -> usize {
        let mut n = 0usize;
        for nb in self.neighbours.iter().flatten().filter(|nb| now_us - nb.last_us < LIVE_US) {
            let l = crate::topo::Link { node: nb.id, rssi: nb.rssi_avg(), tx_pct: crate::topo::Link::tx_pct_of(nb.tx_ok, nb.tx_fail) };
            // Insert, strongest first (at most NEIGHBOURS: no sort needed).
            let mut i = n.min(out.len());
            while i > 0 && out[i - 1].rssi < l.rssi {
                i -= 1;
            }
            if i >= out.len() {
                continue;
            }
            let end = (n + 1).min(out.len());
            out.copy_within(i..end - 1, i + 1);
            out[i] = l;
            n = end;
        }
        n
    }

    fn range_out(&mut self, now_us: i64, out: &mut [u8]) -> Option<(NodeId, usize)> {
        if !self.ranging.on() {
            return None;
        }
        for n in self.neighbours.iter().flatten() {
            if now_us - n.last_us < LIVE_US {
                self.ranging.track(now_us, n.id);
            }
        }
        let idle = self.tx_len == 0 && self.cur.is_none();
        let nbs = &self.neighbours;
        let live = |id: NodeId| nbs.iter().flatten().any(|n| n.id == id && now_us - n.last_us < LIVE_US);
        self.ranging.poll(now_us, idle, &live, out)
    }

    fn range_in(&mut self, now_us: i64, from: NodeId, body: &[u8]) {
        self.ranging.on_msg(now_us, from, body);
    }

    fn link_range(&self, now_us: i64, node: NodeId) -> Option<LinkRange> {
        self.ranging.link(now_us, node)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    const A: [u8; 6] = [0x02, 0, 0, 0, 0x31, 0x70];
    const B: [u8; 6] = [0x02, 0, 0, 0, 0x11, 0x30];
    const C: [u8; 6] = [0x02, 0, 0, 0, 0x1f, 0x48];

    /// A fake MAC: records arms, completes each after a set number of polls with a scripted
    /// outcome (default Ok), and is busy while another path holds it.
    #[derive(Default)]
    struct Fake {
        armed: Vec<(Vec<u8>, u8, bool, bool)>,
        outcomes: VecDeque<Option<TxResult>>,
        pending: Option<Option<TxResult>>,
        busy_until: i64,
        holds: Vec<(i64, u32)>,
        refuse: bool,
        /// Hold completions back (the frame is still on air).
        defer: bool,
    }

    impl Radio for Fake {
        fn tx_idle(&mut self, now_us: i64) -> bool {
            now_us >= self.busy_until
        }
        fn arm(&mut self, frame: &mut [u8], rate: u8, ack: bool, retry: bool) -> bool {
            if self.refuse {
                return false;
            }
            self.armed.push((frame.to_vec(), rate, ack, retry));
            self.pending = Some(self.outcomes.pop_front().unwrap_or(Some(TxResult::Ok)));
            true
        }
        fn tx_done(&mut self) -> Option<TxResult> {
            if self.defer {
                return None;
            }
            match self.pending {
                Some(Some(r)) => {
                    self.pending = None;
                    Some(r)
                }
                // None: the MAC never reports this attempt.
                _ => None,
            }
        }
        fn hold(&mut self, now_us: i64, us: u32) {
            self.busy_until = now_us + us as i64;
            self.holds.push((now_us, us));
        }
    }

    fn envelope(mesh_id: u32, src: NodeId) -> Vec<u8> {
        use crate::envelope::{seal, MicLen};
        let h = Header { mesh_id, epoch: 1, src, counter: 7, long: true };
        let mut out = vec![0u8; 64];
        let n = seal(&[9; 16], MicLen::M8, &h, b"hello", &mut out).unwrap();
        out.truncate(n);
        out
    }

    fn frame_from(sa: [u8; 6], da: [u8; 6], seq: u16, retry: bool, body: &[u8]) -> Vec<u8> {
        let mut f = vec![0u8; FRAME_MAX];
        let n = p2p::encode(&da, &sa, seq, p2p::KIND_MESH_V1, body, &mut f).unwrap();
        f.truncate(n);
        if retry {
            f[1] |= p2p::FC1_RETRY;
        }
        f
    }

    fn rxv(rssi: i8, ts: u32) -> [u8; p2p::RXV_LEN] {
        let mut v = [0u8; p2p::RXV_LEN];
        v[0] = rssi as u8;
        v[12..16].copy_from_slice(&ts.to_le_bytes());
        v
    }

    fn hear(w: &mut WifiP2p, t: i64, from: [u8; 6], id: NodeId) {
        let f = frame_from(from, p2p::BROADCAST, 1, false, &envelope(5, id));
        assert_eq!(w.on_frame(t, &f, Some(&rxv(-40, t as u32))), RxVerdict::Taken);
        let mut b = [0u8; MTU];
        while w.recv(&mut b).is_some() {}
    }

    fn run(w: &mut WifiP2p, r: &mut Fake, from_us: i64, ms: i64) -> i64 {
        let mut t = from_us;
        for _ in 0..ms * 10 {
            t += 100;
            w.pump(t, r);
        }
        t
    }

    #[test]
    fn node_ids_from_macs() {
        assert_eq!(node_id_from_mac(&A), 0x3170);
        assert_eq!(node_id_from_mac(&[0, 0, 0, 0, 0xff, 0xff]), 0xFFFE);
        assert_eq!(node_id_from_mac(&[0, 0, 0, 0, 0, 0]), 1);
    }

    /// The frame on air is the Splanc Public Action frame around the envelope bytes, from
    /// our MAC, with no Espressif OUI anywhere.
    #[test]
    fn broadcast_goes_out_once_as_a_splanc_frame() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        let mut r = Fake::default();
        let env = envelope(5, 0x3170);
        w.queue(0, &env, None, TxClass::Discovery).unwrap();
        run(&mut w, &mut r, 0, 5);
        assert_eq!(r.armed.len(), 1);
        let (f, rate, ack, retry) = &r.armed[0];
        assert_eq!((*rate, *ack, *retry), (p2p::RATE_1M, false, false));
        let p = p2p::parse(f).unwrap();
        assert_eq!((p.da, p.sa, p.kind, p.payload), (p2p::BROADCAST, A, p2p::KIND_MESH_V1, &env[..]));
        assert!(!f.windows(3).any(|w| w == [0x18, 0xfe, 0x34]), "Espressif OUI");
        assert_eq!((w.stats.tx_bcast, w.tx_pending()), (1, 0));
    }

    /// Pacing on the real rate: the hold covers the frame's airtime at the rate it goes out
    /// (1 Mb/s here: a 280-byte frame is 2.4 ms, not the 6 Mb/s guess), plus the ACK when
    /// one is expected; nothing is armed while another path holds the radio.
    #[test]
    fn holds_the_radio_for_the_real_airtime() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        let mut r = Fake { busy_until: 3_000, ..Default::default() };
        w.queue(0, &[0x53; MTU], None, TxClass::Discovery).unwrap();
        w.pump(1_000, &mut r);
        assert!(r.armed.is_empty(), "armed while another frame was on air");
        w.pump(3_000, &mut r);
        assert_eq!(r.armed.len(), 1);
        let air = airtime_us(p2p::RATE_1M, FRAME_MAX);
        assert_eq!(air, 192 + (FRAME_MAX as u32 + 4) * 8);
        assert_eq!(r.holds, vec![(3_000, air + 100)]);
        // A unicast at 6 Mb/s OFDM: OFDM airtime + SIFS + a 6 Mb/s ACK.
        let mut cfg = P2pConfig::new(A);
        cfg.rate_ucast = p2p::RATE_6M;
        let mut w = WifiP2p::new(cfg, 1);
        let mut r = Fake::default();
        hear(&mut w, 0, B, 0x1130);
        w.queue(0, &[1; 100], Some(0x1130), TxClass::Data).unwrap();
        w.pump(10, &mut r);
        let len = p2p::OVERHEAD + 100;
        assert_eq!(r.holds[0].1, airtime_us(p2p::RATE_6M, len) + SIFS_US + airtime_us(p2p::RATE_6M, 10) + 100);
    }

    /// A unicast that misses its ACK is retried (Retry bit, same sequence number) after a
    /// growing backoff, up to `tries` attempts, then given up and counted.
    #[test]
    fn unicast_retries_with_backoff_then_gives_up() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        let mut r = Fake::default();
        hear(&mut w, 0, B, 0x1130);
        r.outcomes.extend([Some(TxResult::AckTimeout), Some(TxResult::AckTimeout), Some(TxResult::Ok)]);
        w.queue(0, &[7; 40], Some(0x1130), TxClass::Data).unwrap();
        let mut t = 0;
        let mut armed_at = vec![];
        for _ in 0..400 {
            t += 100;
            let before = r.armed.len();
            w.pump(t, &mut r);
            if r.armed.len() > before {
                armed_at.push(t);
            }
        }
        assert_eq!(r.armed.len(), 3);
        let seqs: Vec<u16> = r.armed.iter().map(|a| p2p::parse(&a.0).unwrap().seq).collect();
        assert!(seqs.iter().all(|&s| s == seqs[0]), "same MPDU: {seqs:?}");
        assert_eq!(r.armed.iter().map(|a| (a.2, a.3)).collect::<Vec<_>>(), vec![(true, false), (true, true), (true, true)]);
        assert!(p2p::parse(&r.armed[1].0).unwrap().retry);
        // Backoff 2-3 ms, then 4-5 ms.
        let gaps: Vec<i64> = armed_at.windows(2).map(|g| g[1] - g[0]).collect();
        assert!((2_000..3_200).contains(&gaps[0]) && (4_000..5_200).contains(&gaps[1]), "{gaps:?}");
        let n = w.neighbour(0x1130).unwrap();
        assert_eq!((n.tx_ok, n.retries, w.stats.ack_timeouts, w.stats.tx_ucast_ok), (1, 2, 2, 1));
        // Four failures: given up.
        r.outcomes.extend([Some(TxResult::AckTimeout); 4]);
        w.queue(t, &[7; 40], Some(0x1130), TxClass::Data).unwrap();
        run(&mut w, &mut r, t, 60);
        assert_eq!((w.stats.tx_ucast_fail, w.neighbour(0x1130).unwrap().tx_fail, r.armed.len()), (1, 1, 7));
    }

    /// An attempt the MAC never reports (no completion) times out after airtime + slack and
    /// counts as a miss: the unicast is retried, not stuck.
    #[test]
    fn a_silent_mac_times_out_and_retries() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        let mut r = Fake::default();
        hear(&mut w, 0, B, 0x1130);
        r.outcomes.push_back(None);
        w.queue(0, &[7; 40], Some(0x1130), TxClass::Data).unwrap();
        run(&mut w, &mut r, 0, 40);
        assert_eq!((w.stats.no_completion, w.stats.tx_ucast_ok, r.armed.len()), (1, 1, 2));
        assert!(!w.inflight());
    }

    /// `settle` collects the outcome but never arms the next frame (the STA path's wait).
    #[test]
    fn settle_never_arms() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        let mut r = Fake::default();
        hear(&mut w, 0, B, 0x1130);
        w.queue(0, &[1; 20], Some(0x1130), TxClass::Data).unwrap();
        w.queue(0, &[2; 20], Some(0x1130), TxClass::Data).unwrap();
        r.defer = true;
        w.pump(0, &mut r);
        assert_eq!(r.armed.len(), 1);
        assert!(w.awaiting_ack());
        assert!(w.settle(1, &mut r), "still on air");
        r.defer = false;
        assert!(!w.settle(2, &mut r));
        assert_eq!((r.armed.len(), w.stats.tx_ucast_ok, w.tx_pending()), (1, 1, 1));
        r.busy_until = 0;
        w.pump(10_000, &mut r);
        assert_eq!(r.armed.len(), 2);
    }

    /// The policy switch: data to everyone fans out as one ACKed unicast per live neighbour
    /// (`Unicast`, the default) or goes as one broadcast; discovery is always a broadcast;
    /// with nobody heard yet a fan-out is a broadcast.
    #[test]
    fn group_policy_switch() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        let mut r = Fake::default();
        w.queue(0, &[1; 30], None, TxClass::Data).unwrap();
        run(&mut w, &mut r, 0, 10);
        assert_eq!((r.armed.len(), r.armed[0].2, w.stats.fanout_bcast), (1, false, 1));
        hear(&mut w, 10_000, B, 0x1130);
        hear(&mut w, 10_000, C, 0x1f48);
        r.armed.clear();
        w.queue(10_000, &[2; 30], None, TxClass::Data).unwrap();
        let t = run(&mut w, &mut r, 10_000, 20);
        let das: Vec<[u8; 6]> = r.armed.iter().map(|a| p2p::parse(&a.0).unwrap().da).collect();
        assert_eq!(das, vec![B, C]);
        assert!(r.armed.iter().all(|a| a.2), "ACK expected");
        assert_eq!((w.stats.fanouts, w.stats.fanout_ucasts, w.tx_pending()), (2, 2, 0));
        r.armed.clear();
        w.queue(t, &[3; 30], None, TxClass::Discovery).unwrap();
        let t = run(&mut w, &mut r, t, 10);
        assert_eq!(r.armed.len(), 1);
        assert_eq!(p2p::parse(&r.armed[0].0).unwrap().da, p2p::BROADCAST);
        w.cfg.policy = GroupPolicy::Broadcast;
        r.armed.clear();
        w.queue(t, &[4; 30], None, TxClass::Data).unwrap();
        let t = run(&mut w, &mut r, t, 10);
        assert_eq!((r.armed.len(), r.armed[0].2), (1, false));
        // A neighbour silent past LIVE_US is no fan-out target.
        w.cfg.policy = GroupPolicy::Unicast;
        r.armed.clear();
        let late = 10_000 + LIVE_US + 1;
        hear(&mut w, late, C, 0x1f48);
        w.queue(late.max(t), &[5; 30], None, TxClass::Data).unwrap();
        run(&mut w, &mut r, late.max(t), 10);
        assert_eq!(r.armed.iter().map(|a| p2p::parse(&a.0).unwrap().da).collect::<Vec<_>>(), vec![C]);
    }

    /// RX: mesh frames are taken with RSSI and the mapped timestamp; the neighbour is learned
    /// from the envelope's clear header; MAC retry copies, own frames, overheard unicasts and
    /// other kinds are not queued; a full queue drops and counts.
    #[test]
    fn rx_learns_neighbours_and_filters() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 6);
        let env = envelope(5, 0x1130);
        let f = frame_from(B, A, 9, false, &env);
        assert_eq!(w.on_frame(1_000_000, &f, Some(&rxv(-33, 300_000))), RxVerdict::Taken);
        let mut b = [0u8; MTU];
        let m = w.recv(&mut b).unwrap();
        assert_eq!((m.len, m.rssi_dbm, m.src_mac, &b[..m.len]), (env.len(), -33, B, &env[..]));
        assert_eq!(m.rx_us, 1_000_000, "first frame: the reap lag is the offset");
        let n = *w.neighbour(0x1130).unwrap();
        assert_eq!((n.mac, n.rssi, n.rx, n.channel), (B, -33, 1, 6));
        // Its MAC retry (lost ACK): dropped before the mesh.
        let r = frame_from(B, A, 9, true, &env);
        w.on_frame(1_000_100, &r, Some(&rxv(-33, 300_050)));
        assert!(w.recv(&mut b).is_none());
        assert_eq!(w.stats.rx_dup_retry, 1);
        // A later frame reaped 400 µs after arrival maps back to its arrival.
        let f2 = frame_from(B, A, 10, false, &env);
        w.on_frame(1_020_400, &f2, Some(&rxv(-31, 320_000)));
        assert_eq!(w.recv(&mut b).unwrap().rx_us, 1_020_000);
        // Overheard unicast to C: neighbour updated, and queued (relay cancellation).
        w.on_frame(1_030_000, &frame_from(B, C, 11, false, &env), None);
        assert!(w.recv(&mut b).is_some());
        assert_eq!((w.stats.rx_overheard, w.neighbour(0x1130).unwrap().rx), (1, 4));
        // Own frame heard back; the link probe kind; a non-Splanc frame.
        w.on_frame(0, &frame_from(A, p2p::BROADCAST, 1, false, &env), None);
        let mut probe = frame_from(B, A, 1, false, &env);
        probe[29] = p2p::KIND_LINK_PROBE;
        assert_eq!(w.on_frame(0, &probe, None), RxVerdict::OtherKind(p2p::KIND_LINK_PROBE));
        assert_eq!(w.on_frame(0, &[0x80; 60], None), RxVerdict::NotSplanc);
        assert_eq!(w.stats.rx_own, 1);
        // Overflow.
        for s in 0..(RXQ as u16 + 2) {
            w.on_frame(2_000_000, &frame_from(B, A, 100 + s, false, &env), None);
        }
        assert_eq!(w.stats.rx_overflow, 2);
    }

    /// The topology's neighbour list: live neighbours, strongest first, with their unicast
    /// delivery rate; a full list keeps the strongest.
    #[test]
    fn links_list_live_neighbours_strongest_first() {
        use crate::topo::{Link, TX_UNKNOWN};
        let mut w = WifiP2p::new(P2pConfig::new(A), 6);
        let mut b = [0u8; MTU];
        let mut heard = |w: &mut WifiP2p, t: i64, mac: [u8; 6], id: NodeId, rssi: i8| {
            let f = frame_from(mac, A, 1 + t as u16, false, &envelope(5, id));
            w.on_frame(t, &f, Some(&rxv(rssi, t as u32)));
            while w.recv(&mut b).is_some() {}
        };
        heard(&mut w, 1_000_000, B, 0x1130, -60);
        heard(&mut w, 1_000_010, C, 0x2240, -35);
        w.neighbours.iter_mut().flatten().find(|n| n.id == 0x1130).unwrap().tx_ok = 3;
        w.neighbours.iter_mut().flatten().find(|n| n.id == 0x1130).unwrap().tx_fail = 1;
        let mut out = [Link::EMPTY; 8];
        let n = w.links(1_500_000, &mut out);
        assert_eq!(&out[..n], &[Link { node: 0x2240, rssi: -35, tx_pct: TX_UNKNOWN }, Link { node: 0x1130, rssi: -60, tx_pct: 75 }]);
        // Only room for one: the strongest.
        let mut one = [Link::EMPTY; 1];
        assert_eq!((w.links(1_500_000, &mut one), one[0].node), (1, 0x2240));
        // Not heard within LIVE_US: gone.
        assert_eq!(w.links(1_000_010 + LIVE_US, &mut out), 0);
    }

    /// The reap length is word-rounded on silicon: the RX vector's sig_len (MPDU + FCS)
    /// trims the junk, so the envelope bytes come out exact; without a vector, nothing is
    /// trimmed.
    #[test]
    fn rx_trims_word_padding_by_the_rx_vector() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        let env = envelope(5, 0x1130);
        let f = frame_from(B, A, 3, false, &env);
        let mut padded = f.clone();
        padded.extend_from_slice(&[0xEE; 3]);
        let mut v = rxv(-30, 1);
        v[84..86].copy_from_slice(&((f.len() + 4) as u16).to_le_bytes());
        assert_eq!(w.on_frame(10, &padded, Some(&v)), RxVerdict::Taken);
        let mut b = [0u8; MTU];
        let m = w.recv(&mut b).unwrap();
        assert_eq!(&b[..m.len], &env[..]);
        assert_eq!(w.stats.rx_trimmed, 1);
        // Exact length: untouched, not counted.
        let mut v2 = rxv(-30, 2);
        let f2 = frame_from(B, A, 4, false, &env);
        v2[84..86].copy_from_slice(&((f2.len() + 4) as u16).to_le_bytes());
        w.on_frame(20, &f2, Some(&v2));
        assert_eq!((w.recv(&mut b).unwrap().len, w.stats.rx_trimmed), (env.len(), 1));
    }

    #[test]
    fn rx_clock_follows_the_reap_floor_and_wraps() {
        let mut c = RxClock::default();
        // Hardware clock 700 ms behind, reaps 50..900 µs late.
        let off = 700_000i64;
        for (i, late) in [300i64, 50, 900, 120].iter().enumerate() {
            let arr = 5_000_000 + i as i64 * 10_000;
            let t = c.map(arr + late, (arr - off) as u32);
            assert!(t >= arr && t <= arr + late, "{i}: {t} vs {arr}");
        }
        assert_eq!(c.offset_us(), Some(off + 50));
        // Across the 32-bit wrap of the hardware clock.
        let arr = (1i64 << 32) + 10_000_000;
        let t = c.map(arr + 50, (arr - off) as u32);
        // The mapping's constant bias is the shortest reap delay seen (50 µs here).
        assert_eq!(t, arr + 50);
    }

    /// AP-anchored channel rules (§4.2): the mesh is where the AP is; a move is counted and
    /// followed; unassociated members only learn where to camp (kModeMesh tunes, next PR).
    #[test]
    fn channel_rule_follows_the_ap() {
        let mut r = ChannelRule::default();
        assert_eq!(r.decide(Some(1), 1, None), ChannelAction::Stay);
        assert_eq!(r.channel, 1);
        assert_eq!(r.decide(Some(6), 6, Some(1)), ChannelAction::Followed { from: 1, to: 6 });
        assert_eq!((r.channel, r.moves), (6, 1));
        assert_eq!(r.decide(None, 3, Some(6)), ChannelAction::Camp { to: 6 });
        assert_eq!(r.decide(None, 6, Some(6)), ChannelAction::Stay);
        assert_eq!(r.decide(Some(6), 6, None), ChannelAction::Stay);
    }

    /// A neighbour whose unicasts keep failing gets 1 Mb/s for a while, then the
    /// configured rate again.
    #[test]
    fn failing_neighbour_falls_back_to_1m() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        let mut r = Fake::default();
        hear(&mut w, 0, B, 0x1130);
        let mut t = 0;
        for _ in 0..SLOW_AFTER {
            r.outcomes.extend([Some(TxResult::AckTimeout); 4]);
            w.queue(t, &[1; 20], Some(0x1130), TxClass::Data).unwrap();
            t = run(&mut w, &mut r, t, 60);
        }
        assert!(r.armed.iter().all(|a| a.1 == p2p::RATE_6M));
        assert_eq!(w.stats.slowed, 1);
        r.armed.clear();
        w.queue(t, &[2; 20], Some(0x1130), TxClass::Data).unwrap();
        let t = run(&mut w, &mut r, t, 10);
        assert_eq!(r.armed[0].1, p2p::RATE_1M);
        r.armed.clear();
        let later = t + SLOW_US;
        hear(&mut w, later, B, 0x1130);
        w.queue(later, &[3; 20], Some(0x1130), TxClass::Data).unwrap();
        run(&mut w, &mut r, later, 10);
        assert_eq!(r.armed[0].1, p2p::RATE_6M);
    }

    /// The replay check's frame is the last DATA frame byte for byte (same envelope, so the
    /// same counter), broadcast; beacons and adverts sent after it do not displace it.
    #[test]
    fn replay_last_resends_the_last_data_envelope() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        let mut r = Fake::default();
        assert!(!w.replay_last(), "nothing sent yet");
        let env = envelope(5, 0x3170);
        w.queue(0, &env, None, TxClass::Data).unwrap();
        for _ in 0..TXQ {
            w.queue(0, &[0x99; 40], None, TxClass::Discovery).unwrap_or(());
            run(&mut w, &mut r, 0, 5);
        }
        let before = r.armed.len();
        assert!(w.replay_last());
        run(&mut w, &mut r, 50_000, 5);
        assert_eq!(r.armed.len(), before + 1);
        let p = p2p::parse(&r.armed[before].0).unwrap();
        assert_eq!((p.da, p.payload), (p2p::BROADCAST, &env[..]));
    }

    /// A full queue is back-pressure; may_send says so first.
    #[test]
    fn full_queue_is_busy() {
        let mut w = WifiP2p::new(P2pConfig::new(A), 1);
        for _ in 0..TXQ {
            assert!(w.may_send(0));
            w.queue(0, &[0; 10], None, TxClass::Discovery).unwrap();
        }
        assert!(!w.may_send(0));
        assert_eq!(w.queue(0, &[0; 10], None, TxClass::Discovery), Err(Busy));
        assert_eq!(w.queue(0, &[0; MTU + 1], None, TxClass::Discovery), Err(Busy));
        assert_eq!((w.stats.tx_full, w.stats.tx_oversize), (1, 1));
    }

    /// End to end: three nodes' MeshStacks over WifiP2p and a shared fake air form a mesh
    /// under one site secret, beacon, and deliver broadcast and unicast app packets through
    /// the envelope (no plain frame carries an app payload).
    #[test]
    fn three_stacks_form_a_mesh_over_wifi_p2p() {
        use crate::crypto::{DeviceKey, Entropy, PublicKey};
        use crate::membership::{Credentials, Mode, ProvisionSource};
        use crate::ports::Port;
        use crate::stack::{Event, MeshStack, StackConfig};
        use swarm_net::mesh::BROADCAST as ALL;
        use swarm_net::update::Flash;

        struct NoFlash;
        impl Flash for NoFlash {
            fn capacity(&self) -> u32 {
                0
            }
            fn erase(&mut self, _: u32, _: u32) -> bool {
                false
            }
            fn write(&mut self, _: u32, _: &[u8]) -> bool {
                false
            }
            fn read(&mut self, _: u32, _: &mut [u8]) -> bool {
                false
            }
        }
        struct Key(u8);
        impl DeviceKey for Key {
            fn public_key(&self) -> PublicKey {
                [self.0; 65]
            }
            fn ecdh(&self, _: &PublicKey) -> Option<[u8; 32]> {
                None
            }
        }
        struct Rng(u32);
        impl Entropy for Rng {
            fn fill(&mut self, out: &mut [u8]) {
                for b in out {
                    self.0 = self.0.wrapping_mul(1_103_515_245).wrapping_add(12_345);
                    *b = (self.0 >> 16) as u8;
                }
            }
        }
        /// The shared air: what each node armed lands on every other node next pump.
        #[derive(Default)]
        struct AirRadio {
            out: Vec<Vec<u8>>,
            pending: bool,
        }
        impl Radio for AirRadio {
            fn tx_idle(&mut self, _: i64) -> bool {
                true
            }
            fn arm(&mut self, f: &mut [u8], _: u8, _: bool, _: bool) -> bool {
                self.out.push(f.to_vec());
                self.pending = true;
                true
            }
            fn tx_done(&mut self) -> Option<TxResult> {
                core::mem::take(&mut self.pending).then_some(TxResult::Ok)
            }
            fn hold(&mut self, _: i64, _: u32) {}
        }

        const P: usize = 200;
        let macs = [A, B, C];
        let creds = Credentials { mesh_id: 0x5350_4C33, channel: 1, mode: Mode::Closed, site_secret: Some([0x42; 32]), ..Default::default() };
        let mut nodes: Vec<MeshStack<WifiP2p, P, Key, Rng, 16>> = macs
            .iter()
            .enumerate()
            .map(|(i, mac)| {
                let mut cfg = P2pConfig::new(*mac);
                cfg.mesh_id = Some(creds.mesh_id);
                let w = WifiP2p::new(cfg, 1);
                let mut s = MeshStack::new(node_id_from_mac(mac), *mac, w, Key(i as u8 + 1), Rng(i as u32 + 9), StackConfig::default()).unwrap();
                s.provision(0, &creds, ProvisionSource::App);
                s
            })
            .collect();
        let mut radios: Vec<AirRadio> = (0..3).map(|_| AirRadio::default()).collect();
        let mut scratch = vec![0u8; nodes[0].scratch_len()];
        let mut got: Vec<Vec<(NodeId, Port, Vec<u8>)>> = vec![vec![]; 3];
        let mut plain_app_bytes = false;
        let mut step = |nodes: &mut Vec<MeshStack<WifiP2p, P, Key, Rng, 16>>, t: i64, got: &mut Vec<Vec<(NodeId, Port, Vec<u8>)>>| {
            for i in 0..3 {
                for f in core::mem::take(&mut radios[i].out) {
                    for (j, n) in nodes.iter_mut().enumerate() {
                        if j != i {
                            if let Some(p) = p2p::parse(&f) {
                                plain_app_bytes |= p.payload.windows(4).any(|w| w == b"APP!");
                            }
                            n.node.backhaul.on_frame(t, &f, Some(&rxv(-40, t as u32)));
                        }
                    }
                }
                let n = &mut nodes[i];
                n.node.backhaul.pump(t, &mut radios[i]);
                let mut mark = None;
                n.tick(t, &mut NoFlash, &mut scratch, &mut |e| match e {
                    Event::Packet { origin, port, body, .. } => got[i].push((origin, port, body.to_vec())),
                    Event::PersistCounter(m) => mark = Some(m),
                    _ => {}
                });
                if let Some(m) = mark {
                    n.node.guard.counter_reserved(m);
                }
                n.node.backhaul.pump(t, &mut radios[i]);
            }
        };
        let mut t = 0;
        while t < 8_000_000 {
            t += 1_000;
            step(&mut nodes, t, &mut got);
        }
        for (i, n) in nodes.iter().enumerate() {
            assert!(n.membership.is_member(), "node {i}");
            assert_eq!(n.neighbours.iter().flatten().count(), 2, "node {i} sees both others");
            assert_eq!(n.node.backhaul.neighbours.iter().flatten().count(), 2, "node {i} link table");
        }
        // Broadcast from A on STATUS, unicast with an end-to-end ack from B to C on REPLY.
        nodes[0].send(ALL, Port::Status, b"APP!bcast", false).unwrap();
        let c_id = node_id_from_mac(&C);
        nodes[1].send(c_id, Port::Reply, b"APP!ucast", true).unwrap();
        let end = t + 1_000_000;
        while t < end {
            t += 1_000;
            step(&mut nodes, t, &mut got);
        }
        let a_id = node_id_from_mac(&A);
        for i in [1, 2] {
            assert!(got[i].contains(&(a_id, Port::Status, b"APP!bcast".to_vec())), "node {i}: {:?}", got[i]);
        }
        assert!(got[2].contains(&(node_id_from_mac(&B), Port::Reply, b"APP!ucast".to_vec())));
        assert!(!got[0].iter().any(|g| g.2 == b"APP!ucast"));
        // Topology (crate::topo): A and B report a pose, C none (unposed); within one period
        // every member holds both peers' poses and their neighbour lists (not only a gateway).
        use crate::topo::{PoseC, PoseKnown, TOPO_EVERY_US};
        let pa = PoseKnown::Posed(PoseC::from_pose([1.0, 0.0, -2.5], Some([0.0, 0.38268343, 0.0, 0.9238795]), b"Hall"));
        let pb = PoseKnown::Posed(PoseC::from_pose([-0.5, 1.2, 0.0], None, b"Hall"));
        nodes[0].set_pose(pa);
        nodes[1].set_pose(pb);
        nodes[2].set_pose(PoseKnown::Unposed);
        let end = t + 2_000_000;
        while t < end {
            t += 1_000;
            step(&mut nodes, t, &mut got);
        }
        let ids: Vec<NodeId> = macs.iter().map(node_id_from_mac).collect();
        let want = [pa, pb, PoseKnown::Unposed];
        for (i, n) in nodes.iter().enumerate() {
            for (j, &peer) in ids.iter().enumerate().filter(|(j, _)| *j != i) {
                let tp = n.peer_topo(t, peer).unwrap_or_else(|| panic!("node {i} has no topology for {j}"));
                assert_eq!(tp.pose, want[j], "node {i} sees {j}'s pose");
                assert!(tp.pose_current() && tp.hops == 1, "node {i} -> {j}: {tp:?}");
                let mut l: Vec<NodeId> = tp.links().iter().map(|l| l.node).collect();
                l.sort();
                let mut others: Vec<NodeId> = ids.iter().copied().filter(|x| *x != peer).collect();
                others.sort();
                assert_eq!(l, others, "node {i}: {j}'s neighbours");
            }
        }
        // A pose change goes out at once, well before the next period.
        let moved = PoseKnown::Posed(PoseC::from_pose([3.0, 0.0, 0.0], None, b"Porch"));
        nodes[2].set_pose(moved);
        let end = t + 500_000;
        while t < end {
            t += 1_000;
            step(&mut nodes, t, &mut got);
        }
        assert!(500_000 < TOPO_EVERY_US);
        assert_eq!(nodes[0].peer_topo(t, ids[2]).map(|x| x.pose), Some(moved));
        assert!(!plain_app_bytes, "an app payload went out unencrypted");
        assert!(nodes.iter().all(|n| n.node.guard.stats.bad_mic == 0 && n.node.guard.stats.opened > 0));
        // Fan-out unicasts carried the data (default policy).
        assert!(nodes[0].node.backhaul.stats.fanout_ucasts > 0 && nodes[0].node.backhaul.stats.tx_ucast_ok > 0);
    }
}
