//! Mesh time on hardware (design §6.2, M4): time beacons, the per-neighbour clock fit, and
//! the show epoch, around [`crate::timesync`]'s robust aggregation.
//!
//! **The beacon** ([`TimeBeacon`], link `FRAME_TYPE_TIME`) is a one-hop broadcast under the
//! mesh envelope (members only; replays fail the envelope's counter window). It is never
//! flooded (relay delays ruin timestamps) and never retried (a retry would carry the first
//! attempt's stamp). Every member sends one every [`BEACON_US`] (jittered).
//!
//! **Two-step stamp.** The C6 has no hardware TX timestamp, and the MAC can hold an armed
//! frame ~10 ms while BLE has the radio, so a stamp taken when the frame is sealed is wrong
//! by the queueing and the hold. Instead the backhaul stamps each time beacon's *completion*
//! ([`crate::backhaul::TxStamp`]: the poll that saw it done and the poll before it bracket
//! the instant; the bracket's half-width is the stamp's error) and the *next* beacon carries
//! that stamp ([`TimeBeacon::prev`]). A receiver pairs it with the hardware RX timestamp it
//! kept for that sequence number: one sample of `peer clock - my clock - L` per beacon,
//! where `L` is the fixed delay between the sender's "done" and the receiver's RX stamp
//! (airtime, the RX vector's reference point, the done poll).
//!
//! **Two-way, over broadcasts.** Each beacon also carries the sender's own current fit of
//! each neighbour ([`TimeBeacon::rev`]). Summing the two directions cancels the offset and
//! leaves `-2L`; differencing them cancels `L` (NTP's four timestamps, without a unicast
//! exchange). So the constant delays drop out, whatever the RX vector's reference point is.
//!
//! **Fit** ([`Fit`]): per neighbour, a least-squares line (offset and drift) over the last
//! [`FIT_N`] samples, refitted without outliers; it predicts the neighbour's clock at any
//! instant. A jump (the neighbour rebooted) resets it after [`RESET_AFTER`] outliers in a
//! row.
//!
//! **Sync states** ([`SyncState`]):
//! - *Unsynced* (booted, or just joined): adopts the aggregate of the synced neighbours it
//!   hears. If none is synced after [`LISTEN_US`], it founds mesh time: the latest of its
//!   own and every neighbour's (so time never steps back on anyone who already runs).
//! - *Forming* (the first [`FORM_US`] after that): nodes that founded at once converge on
//!   the latest of them (a step); a synced neighbourhood wins over a forming one.
//! - *Synced*: [`crate::timesync`]'s rules: Marzullo over itself and the synced neighbours,
//!   steps only with a quorum, slews otherwise (≤ 500 ppm).
//!
//! **The show epoch** ([`ShowEpoch`]) rides in the beacon too: generation, origin and the
//! epoch in mesh time (or cleared). Members gossip the newest generation they know; each maps
//! it onto its own clock and applies it through the player's time base (design §6.3), so
//! `apply_at_ms` lands at one instant on every member. This is the non-admin time field M5
//! builds on: who may *originate* an epoch (any member here; the gateway's admin session in
//! M5) is a policy on [`MeshTime::originate`], not on the members.

use crate::backhaul::NodeId;
use crate::codec::{R, W};
use crate::timesync::{aggregate, Adjust, Confidence, Estimate, MeshClock, Sample, STEP_US};

/// A member's time beacon period (jittered down by up to a quarter).
pub const BEACON_US: i64 = 500_000;
/// Neighbours tracked.
pub const PEERS: usize = 8;
/// Samples per neighbour fit (6 s at 2 Hz).
pub const FIT_N: usize = 12;
/// Fits with fewer samples are not used.
pub const FIT_MIN: u8 = 3;
/// A neighbour not heard for this long is not a source.
pub const PEER_STALE_US: i64 = 3_000_000;
/// A completion stamp coarser than this (half-width) is not used: the poll that saw the
/// frame done was preempted, or the MAC reported it a loop pass late.
pub const MAX_STAMP_ERR_US: i64 = 150;
/// A sample this far from its fit's prediction is an outlier.
pub const OUTLIER_US: i64 = 2_000;
/// Outliers in a row that reset a fit (the neighbour's clock jumped: a reboot).
pub const RESET_AFTER: u8 = 3;
/// How long a node that founded (or joined) mesh time stays *forming*.
pub const FORM_US: i64 = 10_000_000;
/// How long an unsynced node listens for a synced neighbour before it founds mesh time.
pub const LISTEN_US: i64 = 1_500_000;
/// `L` assumed for a neighbour that never reported us back (one-way link), and the extra
/// error its samples carry.
pub const DEFAULT_LATENCY_US: i64 = 0;
pub const ONE_WAY_ERR_US: i64 = 1_000;
/// Reverse samples a beacon carries.
pub const REV: usize = 7;
/// The largest encoded beacon.
pub const BEACON_MAX: usize = 4 + 12 + 12 + 14 + 1 + REV * 10;
pub const VERSION: u8 = 1;
/// Floor of any sample's error (timestamp jitter).
pub const MIN_ERR_US: i64 = 40;

/// A time beacon's completion on the sender's clock (two-step).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stamp {
    pub seq: u16,
    pub done_us: i64,
    /// Half-width of the bracket the completion is in.
    pub err_us: u16,
}

/// The show clock's epoch (design §6.3), in mesh time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ShowEpoch {
    pub gen: u32,
    pub origin: NodeId,
    /// The epoch (mesh µs); None: the time base is cleared.
    pub epoch_mesh_us: Option<i64>,
}

impl ShowEpoch {
    /// Whether `self` supersedes `other` (a later generation; ties by origin).
    pub fn newer_than(&self, other: &ShowEpoch) -> bool {
        self.gen > other.gen || (self.gen == other.gen && self.origin > other.origin)
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, PartialOrd, Ord)]
pub enum SyncState {
    #[default]
    Unsynced = 0,
    Forming = 1,
    Synced = 2,
}

impl SyncState {
    fn from_u8(v: u8) -> Option<SyncState> {
        match v {
            0 => Some(SyncState::Unsynced),
            1 => Some(SyncState::Forming),
            2 => Some(SyncState::Synced),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            SyncState::Unsynced => "unsynced",
            SyncState::Forming => "forming",
            SyncState::Synced => "synced",
        }
    }
}

/// The time beacon (the payload of a link `FRAME_TYPE_TIME` frame).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TimeBeacon {
    pub seq: u16,
    pub state: SyncState,
    /// The previous beacon's completion (two-step).
    pub prev: Option<Stamp>,
    /// The sender's mesh offset (mesh time - its clock), µs.
    pub offset_us: i64,
    /// The sender's own uncertainty, µs.
    pub err_us: u32,
    pub epoch: Option<ShowEpoch>,
    /// The sender's fit of each neighbour: (neighbour, its clock - the sender's - L), µs, at
    /// the time the beacon was built.
    pub rev: [(NodeId, i64); REV],
    pub n_rev: u8,
}

const F_PREV: u8 = 1;
const F_EPOCH: u8 = 2;
const F_EPOCH_SET: u8 = 4;

impl TimeBeacon {
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let mut flags = (self.state as u8) << 4;
        if self.prev.is_some() {
            flags |= F_PREV;
        }
        if let Some(e) = self.epoch {
            flags |= F_EPOCH;
            if e.epoch_mesh_us.is_some() {
                flags |= F_EPOCH_SET;
            }
        }
        let mut w = W::new(out);
        w.u8(VERSION).u8(flags).u16(self.seq);
        if let Some(p) = self.prev {
            w.u16(p.seq).i64(p.done_us).u16(p.err_us);
        }
        w.i64(self.offset_us).u32(self.err_us);
        if let Some(e) = self.epoch {
            w.u32(e.gen).u16(e.origin).i64(e.epoch_mesh_us.unwrap_or(0));
        }
        let n = (self.n_rev as usize).min(REV);
        w.u8(n as u8);
        for &(id, v) in &self.rev[..n] {
            w.u16(id).i64(v);
        }
        w.done()
    }

    pub fn decode(b: &[u8]) -> Option<TimeBeacon> {
        let mut r = R::new(b);
        (r.u8()? == VERSION).then_some(())?;
        let flags = r.u8()?;
        let seq = r.u16()?;
        let state = SyncState::from_u8(flags >> 4)?;
        let prev = if flags & F_PREV != 0 { Some(Stamp { seq: r.u16()?, done_us: r.i64()?, err_us: r.u16()? }) } else { None };
        let offset_us = r.i64()?;
        let err_us = r.u32()?;
        let epoch = if flags & F_EPOCH != 0 {
            let (gen, origin, e) = (r.u32()?, r.u16()?, r.i64()?);
            Some(ShowEpoch { gen, origin, epoch_mesh_us: (flags & F_EPOCH_SET != 0).then_some(e) })
        } else {
            None
        };
        let n = r.u8()? as usize;
        if n > REV {
            return None;
        }
        let mut rev = [(0, 0); REV];
        for x in rev.iter_mut().take(n) {
            *x = (r.u16()?, r.i64()?);
        }
        r.end()?;
        Some(TimeBeacon { seq, state, prev, offset_us, err_us, epoch, rev, n_rev: n as u8 })
    }
}

/// A least-squares line through a neighbour's samples (its clock - ours - L, against our
/// clock): offset and drift.
#[derive(Clone, Copy, Debug)]
pub struct Fit {
    t: [i64; FIT_N],
    y: [i64; FIT_N],
    n: u8,
    head: u8,
}

/// A fit's prediction.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Predict {
    pub y: i64,
    /// RMS residual of the samples kept, µs.
    pub rms: i64,
    /// Samples kept (outliers dropped).
    pub used: u8,
    /// The drift, ppm × 1000.
    pub drift_ppb: i64,
}

impl Default for Fit {
    fn default() -> Fit {
        Fit { t: [0; FIT_N], y: [0; FIT_N], n: 0, head: 0 }
    }
}

impl Fit {
    pub fn len(&self) -> u8 {
        self.n
    }
    pub fn is_empty(&self) -> bool {
        self.n == 0
    }
    pub fn clear(&mut self) {
        self.n = 0;
        self.head = 0;
    }
    pub fn push(&mut self, t: i64, y: i64) {
        let i = (self.head as usize + self.n as usize) % FIT_N;
        self.t[i] = t;
        self.y[i] = y;
        if (self.n as usize) < FIT_N {
            self.n += 1;
        } else {
            self.head = ((self.head as usize + 1) % FIT_N) as u8;
        }
    }

    fn line(&self, keep: &[bool; FIT_N], at: i64) -> Option<(i64, i128, i128, i64, i64)> {
        let (mut n, mut st, mut sy) = (0i64, 0i128, 0i128);
        for k in 0..self.n as usize {
            if keep[k] {
                let i = (self.head as usize + k) % FIT_N;
                n += 1;
                st += (self.t[i] - at) as i128;
                sy += self.y[i] as i128;
            }
        }
        if n == 0 {
            return None;
        }
        let (mt, my) = ((st / n as i128) as i64, (sy / n as i128) as i64);
        let (mut sxx, mut sxy) = (0i128, 0i128);
        for k in 0..self.n as usize {
            if keep[k] {
                let i = (self.head as usize + k) % FIT_N;
                let dx = (self.t[i] - at - mt) as i128;
                sxx += dx * dx;
                sxy += dx * (self.y[i] - my) as i128;
            }
        }
        Some((n, sxx, sxy, mt, my))
    }

    /// The line's value at `at` (our clock), after dropping outliers (more than 5 MADs and
    /// 60 µs from a first fit), with the residual and the drift.
    pub fn predict(&self, at: i64) -> Option<Predict> {
        if self.n == 0 {
            return None;
        }
        let mut keep = [false; FIT_N];
        for k in keep.iter_mut().take(self.n as usize) {
            *k = true;
        }
        let eval = |keep: &[bool; FIT_N]| -> Option<(i64, i128, i128, i64)> {
            let (n, sxx, sxy, mt, my) = self.line(keep, at)?;
            // Value at `at` (dx = -mt from the mean); flat with fewer than 3 or a degenerate
            // spread.
            let y = if n >= 3 && sxx > 0 { my + ((sxy * (-mt) as i128) / sxx) as i64 } else { my };
            Some((y, sxx, sxy, mt))
        };
        let resid = |keep: &[bool; FIT_N], y0: i64, sxx: i128, sxy: i128, out: &mut [i64; FIT_N]| {
            for k in 0..self.n as usize {
                let i = (self.head as usize + k) % FIT_N;
                let dx = (self.t[i] - at) as i128;
                let fit = y0 + if sxx > 0 { ((sxy * dx) / sxx) as i64 } else { 0 };
                out[k] = if keep[k] { self.y[i] - fit } else { 0 };
            }
        };
        let (y0, sxx, sxy, _) = eval(&keep)?;
        let mut r = [0i64; FIT_N];
        resid(&keep, y0, sxx, sxy, &mut r);
        if self.n >= 4 {
            let mut a = [0i64; FIT_N];
            let m = self.n as usize;
            for k in 0..m {
                a[k] = r[k].abs();
            }
            a[..m].sort_unstable();
            let mad = a[m / 2];
            let lim = (5 * mad).max(60);
            for k in 0..m {
                if r[k].abs() > lim {
                    keep[k] = false;
                }
            }
        }
        let (y, sxx, sxy, _) = eval(&keep)?;
        resid(&keep, y, sxx, sxy, &mut r);
        let used = keep.iter().take(self.n as usize).filter(|&&k| k).count() as u8;
        let ss: i128 = r.iter().take(self.n as usize).map(|&v| (v as i128) * (v as i128)).sum();
        let rms = isqrt((ss / used.max(1) as i128) as u64) as i64;
        let drift_ppb = if sxx > 0 { ((sxy * 1_000_000_000) / sxx) as i64 } else { 0 };
        Some(Predict { y, rms, used, drift_ppb })
    }
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

/// One neighbour's time state.
#[derive(Clone, Copy, Debug, Default)]
pub struct Peer {
    pub id: NodeId,
    /// (seq, RX time on our clock) of its last two beacons: the next beacon's stamp pairs
    /// with one of them.
    last_rx: [(u16, i64); 2],
    have_rx: [bool; 2],
    pub fit: Fit,
    /// Its mesh offset and state, from its newest beacon.
    pub off_us: i64,
    pub err_us: u32,
    pub state: SyncState,
    pub heard_us: i64,
    /// `L` for this link (µs), from both directions; None until it reports us back.
    pub lat_us: Option<i64>,
    outlier_run: u8,
    pub samples: u32,
    pub outliers: u32,
    pub resets: u32,
    /// Stamps it sent too coarse to use, and beacons whose stamp's beacon we never heard.
    pub coarse: u32,
    pub unpaired: u32,
}

impl Peer {
    fn new(id: NodeId) -> Peer {
        Peer { id, ..Default::default() }
    }

    /// Its clock - ours, now (the fit plus `L`), and that sample's error.
    pub fn theta(&self, now_us: i64) -> Option<(i64, i64)> {
        self.theta_min(now_us, FIT_MIN)
    }

    /// [`Peer::theta`] from a fit of at least `min` samples (founding takes one).
    pub fn theta_min(&self, now_us: i64, min: u8) -> Option<(i64, i64)> {
        if self.fit.len() < min.max(1) {
            return None;
        }
        let p = self.fit.predict(now_us)?;
        let (lat, lat_err) = match self.lat_us {
            Some(l) => (l, 0),
            None => (DEFAULT_LATENCY_US, ONE_WAY_ERR_US),
        };
        Some((p.y + lat, MIN_ERR_US + 2 * p.rms + lat_err))
    }
}

/// Time counters (reports).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TimeStats {
    pub beacons_tx: u32,
    pub beacons_rx: u32,
    pub stamps: u32,
    pub stamps_coarse: u32,
    pub steps: u32,
    pub slews: u32,
    /// Sum of |slew| (µs).
    pub slewed_us: i64,
    pub founded: u32,
    pub joined: u32,
    pub epochs: u32,
    pub bad: u32,
}

/// One node's mesh time.
#[derive(Clone, Copy, Debug)]
pub struct MeshTime {
    pub me: NodeId,
    pub clock: MeshClock,
    pub state: SyncState,
    /// When it last founded / joined mesh time (Forming ends FORM_US later).
    since_us: i64,
    started_us: Option<i64>,
    pub err_us: i64,
    pub seq: u16,
    /// The beacon awaiting its completion stamp, and the newest stamp not yet sent.
    pending: Option<u16>,
    stamp: Option<Stamp>,
    pub peers: [Option<Peer>; PEERS],
    last_update_us: Option<i64>,
    pub epoch: Option<ShowEpoch>,
    pub stats: TimeStats,
    /// The newest estimate (reports).
    pub last_est: Option<Estimate>,
    pub last_adjust: Adjust,
}

impl MeshTime {
    pub fn new(me: NodeId) -> MeshTime {
        MeshTime {
            me,
            clock: MeshClock::default(),
            state: SyncState::Unsynced,
            since_us: 0,
            started_us: None,
            err_us: i64::from(u32::MAX),
            seq: 0,
            pending: None,
            stamp: None,
            peers: [None; PEERS],
            last_update_us: None,
            epoch: None,
            stats: TimeStats::default(),
            last_est: None,
            last_adjust: Adjust::Hold,
        }
    }

    /// [`MeshTime::new`] written in place at `dst` (firmware builds the stack in its heap
    /// block; by value this is a 2+ KB stack temporary on a tight create stack).
    ///
    /// # Safety
    /// `dst` is valid for writes; every field is initialised on return.
    pub unsafe fn init_in(dst: *mut MeshTime, me: NodeId) {
        use core::ptr::addr_of_mut as f;
        f!((*dst).me).write(me);
        f!((*dst).clock).write(MeshClock::default());
        f!((*dst).state).write(SyncState::Unsynced);
        f!((*dst).since_us).write(0);
        f!((*dst).started_us).write(None);
        f!((*dst).err_us).write(i64::from(u32::MAX));
        f!((*dst).seq).write(0);
        f!((*dst).pending).write(None);
        f!((*dst).stamp).write(None);
        for i in 0..PEERS {
            f!((*dst).peers[i]).write(None);
        }
        f!((*dst).last_update_us).write(None);
        f!((*dst).epoch).write(None);
        f!((*dst).stats).write(TimeStats::default());
        f!((*dst).last_est).write(None);
        f!((*dst).last_adjust).write(Adjust::Hold);
    }

    /// The beacon built last was not queued: no stamp will come for it.
    pub fn cancel_pending(&mut self) {
        self.pending = None;
    }

    /// Mesh time at local instant `local_us` (meaningful once not Unsynced).
    pub fn mesh_us(&self, local_us: i64) -> i64 {
        self.clock.mesh_us(local_us)
    }

    /// The local instant of mesh time `mesh_us`.
    pub fn local_us(&self, mesh_us: i64) -> i64 {
        mesh_us - self.clock.offset_us
    }

    pub fn synced(&self) -> bool {
        self.state != SyncState::Unsynced
    }

    fn peer_mut(&mut self, now_us: i64, id: NodeId) -> &mut Peer {
        let i = self
            .peers
            .iter()
            .position(|p| p.is_some_and(|p| p.id == id))
            .or_else(|| self.peers.iter().position(|p| p.is_none()))
            .unwrap_or_else(|| (0..PEERS).min_by_key(|&i| self.peers[i].map_or(i64::MIN, |p| p.heard_us)).unwrap_or(0));
        if self.peers[i].is_none_or(|p| p.id != id) {
            let mut p = Peer::new(id);
            p.heard_us = now_us;
            self.peers[i] = Some(p);
        }
        self.peers[i].as_mut().unwrap()
    }

    /// The completion stamp of the beacon queued last (the backhaul's [`crate::backhaul::TxStamp`]).
    pub fn on_stamp(&mut self, done_us: i64, err_us: i64) {
        let Some(seq) = self.pending.take() else { return };
        if err_us > MAX_STAMP_ERR_US {
            self.stats.stamps_coarse += 1;
        }
        self.stats.stamps += 1;
        self.stamp = Some(Stamp { seq, done_us, err_us: err_us.clamp(0, u16::MAX as i64) as u16 });
    }

    /// A neighbour's beacon, received at `rx_us` (our clock, the hardware RX timestamp).
    /// Returns the show epoch if this beacon brought a newer one.
    pub fn on_beacon(&mut self, now_us: i64, from: NodeId, rx_us: i64, b: &TimeBeacon) -> Option<ShowEpoch> {
        if from == self.me {
            return None;
        }
        self.stats.beacons_rx += 1;
        let me = self.me;
        let p = self.peer_mut(now_us, from);
        p.heard_us = now_us;
        // 1. Two-step: the stamp of an earlier beacon, paired with its RX time.
        if let Some(st) = b.prev {
            let rx = (0..2).find(|&k| p.have_rx[k] && p.last_rx[k].0 == st.seq).map(|k| p.last_rx[k].1);
            match rx {
                None => p.unpaired += 1,
                Some(_) if st.err_us as i64 > MAX_STAMP_ERR_US => p.coarse += 1,
                Some(r) => {
                    let y = st.done_us - r;
                    let pred = if p.fit.len() >= 4 { p.fit.predict(r).map(|q| q.y) } else { None };
                    match pred {
                        Some(q) if (y - q).abs() > OUTLIER_US => {
                            p.outliers += 1;
                            p.outlier_run += 1;
                            if p.outlier_run >= RESET_AFTER {
                                // Its clock jumped (a reboot): start over.
                                p.fit.clear();
                                p.fit.push(r, y);
                                p.lat_us = None;
                                p.resets += 1;
                                p.outlier_run = 0;
                            }
                        }
                        _ => {
                            p.outlier_run = 0;
                            p.fit.push(r, y);
                            p.samples += 1;
                        }
                    }
                }
            }
        }
        // 2. Keep this beacon's RX time for its stamp (in the next beacon).
        let k = if !p.have_rx[0] || (p.have_rx[1] && p.last_rx[0].1 <= p.last_rx[1].1) { 0 } else { 1 };
        p.last_rx[k] = (b.seq, rx_us);
        p.have_rx[k] = true;
        p.off_us = b.offset_us;
        p.err_us = b.err_us;
        p.state = b.state;
        // 3. Its fit of us: the two directions give L.
        if let Some(&(_, back)) = b.rev[..(b.n_rev as usize).min(REV)].iter().find(|(id, _)| *id == me) {
            if p.fit.len() >= FIT_MIN {
                if let Some(q) = p.fit.predict(rx_us) {
                    // q.y = θ - L, back = -θ - L (θ: its clock - ours).
                    let l = -(q.y + back) / 2;
                    if l.abs() < 20_000 {
                        p.lat_us = Some(match p.lat_us {
                            None => l,
                            Some(old) => old + (l - old) / 8,
                        });
                    }
                }
            }
        }
        // 4. The show epoch.
        match b.epoch {
            Some(e) if self.epoch.is_none_or(|mine| e.newer_than(&mine)) => {
                self.epoch = Some(e);
                self.stats.epochs += 1;
                Some(e)
            }
            _ => None,
        }
    }

    /// Originate a show epoch (this device's app set or cleared its time base): the next
    /// generation, gossiped from the next beacon on.
    pub fn originate(&mut self, epoch_mesh_us: Option<i64>) -> ShowEpoch {
        let gen = self.epoch.map_or(1, |e| e.gen.wrapping_add(1).max(1));
        let e = ShowEpoch { gen, origin: self.me, epoch_mesh_us };
        self.epoch = Some(e);
        self.stats.epochs += 1;
        e
    }

    /// The sources usable now: (peer index, its sample).
    fn sources(&self, now_us: i64, min_state: SyncState, out: &mut [Sample; PEERS + 1]) -> usize {
        self.sources_min(now_us, min_state, FIT_MIN, out)
    }

    fn sources_min(&self, now_us: i64, min_state: SyncState, min_fit: u8, out: &mut [Sample; PEERS + 1]) -> usize {
        let mut n = 0;
        for p in self.peers.iter().flatten() {
            if now_us - p.heard_us > PEER_STALE_US || p.state < min_state {
                continue;
            }
            if let Some((theta, err)) = p.theta_min(now_us, min_fit) {
                out[n] = Sample { peer: p.id, offset_us: theta + p.off_us, err_us: err + (p.err_us as i64).min(5_000) / 4 };
                n += 1;
            }
        }
        n
    }

    fn step_to(&mut self, now_us: i64, offset: i64, state: SyncState) -> Adjust {
        let d = offset - self.clock.offset_us;
        self.clock.offset_us = offset;
        if self.state != state && state == SyncState::Forming {
            self.since_us = now_us;
        }
        self.state = state;
        if d != 0 {
            self.stats.steps += 1;
            Adjust::Step(d)
        } else {
            Adjust::Hold
        }
    }

    /// Re-estimate mesh time (call once per beacon period; [`MeshTime::due`] does).
    pub fn update(&mut self, now_us: i64) -> Adjust {
        let started = *self.started_us.get_or_insert(now_us);
        let dt = now_us - self.last_update_us.unwrap_or(now_us);
        self.last_update_us = Some(now_us);
        let mut s = [Sample { peer: 0, offset_us: 0, err_us: 0 }; PEERS + 1];
        let adj = match self.state {
            SyncState::Unsynced => {
                let n = self.sources(now_us, SyncState::Forming, &mut s);
                if n > 0 {
                    // Join: the synced neighbourhood's time (no vote of ours).
                    let e = combine(&s[..n], (n - 1) / 2);
                    self.last_est = Some(e);
                    self.err_us = e.err_us;
                    self.stats.joined += 1;
                    self.step_to(now_us, e.offset_us, SyncState::Forming)
                } else if now_us - started >= LISTEN_US {
                    // Found: the latest clock among us and every neighbour heard (one sample
                    // each is enough to rank seconds-apart clocks; the forming phase refines).
                    let n = self.sources_min(now_us, SyncState::Unsynced, 1, &mut s);
                    let best = s[..n].iter().map(|x| x.offset_us).fold(self.clock.offset_us, i64::max);
                    self.err_us = s[..n].iter().map(|x| x.err_us).min().unwrap_or(MIN_ERR_US);
                    self.stats.founded += 1;
                    self.step_to(now_us, best, SyncState::Forming)
                } else {
                    Adjust::Hold
                }
            }
            SyncState::Forming | SyncState::Synced => {
                if self.state == SyncState::Forming && now_us - self.since_us >= FORM_US {
                    self.state = SyncState::Synced;
                }
                let mut adj = None;
                if self.state == SyncState::Forming {
                    // A synced neighbourhood wins; among forming ones, the latest.
                    let n = self.sources(now_us, SyncState::Synced, &mut s);
                    if n > 0 {
                        let e = combine(&s[..n], (n - 1) / 2);
                        if (e.offset_us - self.clock.offset_us).abs() > STEP_US {
                            self.last_est = Some(e);
                            adj = Some(self.step_to(now_us, e.offset_us, SyncState::Forming));
                        }
                    } else {
                        let n = self.sources(now_us, SyncState::Forming, &mut s);
                        let best = s[..n].iter().map(|x| x.offset_us).fold(i64::MIN, i64::max);
                        if best > self.clock.offset_us + STEP_US {
                            adj = Some(self.step_to(now_us, best, SyncState::Forming));
                        }
                    }
                }
                match adj {
                    Some(a) => a,
                    None => {
                        let n = self.sources(now_us, SyncState::Forming, &mut s);
                        s[n] = Sample { peer: self.me, offset_us: self.clock.offset_us, err_us: self.err_us.clamp(MIN_ERR_US, 5_000) };
                        let total = n + 1;
                        let f = (total - 1) / 2;
                        let e = combine(&s[..total], f);
                        self.last_est = Some(e);
                        if n == 0 {
                            // Alone: keep running on our own clock.
                            Adjust::Hold
                        } else {
                            self.err_us = e.err_us.max(MIN_ERR_US);
                            let a = self.clock.update(&e, f, dt);
                            match a {
                                Adjust::Step(_) => self.stats.steps += 1,
                                Adjust::Slew(d) => {
                                    self.stats.slews += 1;
                                    self.stats.slewed_us += d.abs();
                                }
                                Adjust::Hold => {}
                            }
                            a
                        }
                    }
                }
            }
        };
        self.last_adjust = adj;
        adj
    }

    /// Build the next beacon (update the estimate first). The beacon's completion stamp is
    /// expected next ([`MeshTime::on_stamp`]).
    pub fn beacon(&mut self, now_us: i64) -> TimeBeacon {
        self.update(now_us);
        self.seq = self.seq.wrapping_add(1);
        let mut rev = [(0, 0); REV];
        let mut n = 0;
        for p in self.peers.iter().flatten() {
            if n == REV || now_us - p.heard_us > PEER_STALE_US || p.fit.len() < FIT_MIN {
                continue;
            }
            if let Some(q) = p.fit.predict(now_us) {
                rev[n] = (p.id, q.y);
                n += 1;
            }
        }
        let b = TimeBeacon {
            seq: self.seq,
            state: self.state,
            prev: self.stamp.take(),
            offset_us: self.clock.offset_us,
            err_us: self.err_us.clamp(0, u32::MAX as i64) as u32,
            epoch: self.epoch,
            rev,
            n_rev: n as u8,
        };
        self.pending = Some(self.seq);
        self.stats.beacons_tx += 1;
        b
    }
}

/// [`aggregate`], then (at high confidence) the inverse-variance mean of the sources that
/// agree, kept inside their common interval: Marzullo picks who to trust, the mean spends
/// all of their precision (NTP's combine step).
pub fn combine(samples: &[Sample], f: usize) -> Estimate {
    let e = aggregate(samples, f);
    if e.confidence != Confidence::High {
        return e;
    }
    let (mut wsum, mut acc) = (0i128, 0i128);
    for s in samples {
        if (s.offset_us - e.offset_us).abs() <= s.err_us {
            let w = 1_000_000_000_000i128 / ((s.err_us.max(1) as i128) * (s.err_us.max(1) as i128));
            wsum += w.max(1);
            acc += w.max(1) * s.offset_us as i128;
        }
    }
    if wsum == 0 {
        return e;
    }
    let m = (acc / wsum) as i64;
    let lo = e.offset_us - e.err_us;
    let hi = e.offset_us + e.err_us;
    Estimate { offset_us: m.clamp(lo, hi), ..e }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn beacon_round_trips() {
        let mut rev = [(0, 0); REV];
        rev[0] = (7, -123_456_789_012);
        rev[1] = (9, 42);
        let b = TimeBeacon {
            seq: 65535,
            state: SyncState::Synced,
            prev: Some(Stamp { seq: 65534, done_us: 9_876_543_210, err_us: 12 }),
            offset_us: -55_000_000,
            err_us: 80,
            epoch: Some(ShowEpoch { gen: 3, origin: 0x1130, epoch_mesh_us: Some(123_000_000) }),
            rev,
            n_rev: 2,
        };
        let mut buf = [0u8; BEACON_MAX];
        let n = b.encode(&mut buf).unwrap();
        assert_eq!(TimeBeacon::decode(&buf[..n]), Some(b));
        let full = TimeBeacon { n_rev: REV as u8, ..b };
        assert!(full.encode(&mut buf).is_some(), "BEACON_MAX holds a full beacon");
        let cleared = TimeBeacon { prev: None, epoch: Some(ShowEpoch { gen: 4, origin: 1, epoch_mesh_us: None }), n_rev: 0, rev: [(0, 0); REV], ..b };
        let n = cleared.encode(&mut buf).unwrap();
        assert_eq!(TimeBeacon::decode(&buf[..n]), Some(cleared));
        assert_eq!(TimeBeacon::decode(&buf[..n - 1]), None);
        buf[0] = 2;
        assert_eq!(TimeBeacon::decode(&buf[..n]), None);
    }

    #[test]
    fn fit_tracks_offset_and_drift_and_drops_outliers() {
        let mut f = Fit::default();
        // y = 1e9 + 20 ppm drift, samples every 0.5 s, ±10 µs noise, one 900 µs outlier.
        for k in 0..FIT_N as i64 {
            let t = 10_000_000 + k * 500_000;
            let noise = [7, -3, 10, -9, 2, 0, -6, 4, 9, -10, 1, -2][k as usize];
            let y = 1_000_000_000 + t * 20 / 1_000_000 + noise + if k == 5 { 900 } else { 0 };
            f.push(t, y);
        }
        let at = 10_000_000 + 12 * 500_000;
        let p = f.predict(at).unwrap();
        let truth = 1_000_000_000 + at * 20 / 1_000_000;
        assert!((p.y - truth).abs() <= 10, "{p:?} vs {truth}");
        assert_eq!(p.used, FIT_N as u8 - 1, "the outlier is dropped");
        assert!((p.drift_ppb - 20_000).abs() < 2_000, "{p:?}");
        assert!(p.rms <= 10, "{p:?}");
    }

    /// Two nodes with clocks a second apart and 30 ppm apart, beacons crossing with a
    /// constant 700 µs from "done" to the RX stamp: the two-way estimate removes it.
    #[test]
    fn two_way_removes_the_link_delay() {
        let (mut a, mut b) = (MeshTime::new(1), MeshTime::new(2));
        let lat = 700i64;
        let la = |g: i64| g;
        let lb = |g: i64| g + 1_000_000 + g * 30 / 1_000_000;
        for k in 0..40i64 {
            let g = 1_000_000 + k * 250_000;
            let (tx, rx, tx_l, rx_l): (&mut MeshTime, &mut MeshTime, &dyn Fn(i64) -> i64, &dyn Fn(i64) -> i64) =
                if k % 2 == 0 { (&mut a, &mut b, &la, &lb) } else { (&mut b, &mut a, &lb, &la) };
            let bc = tx.beacon(tx_l(g));
            tx.on_stamp(tx_l(g + 100), 5);
            let from = tx.me;
            rx.on_beacon(rx_l(g + 100 + lat), from, rx_l(g + 100 + lat), &bc);
        }
        let g = 12_000_000;
        let pa = a.peers.iter().flatten().next().unwrap();
        let (theta, _) = pa.theta(la(g)).unwrap();
        let truth = lb(g) - la(g);
        assert!((theta - truth).abs() < 20, "θ {theta} vs {truth} (lat {:?})", pa.lat_us);
        assert!((pa.lat_us.unwrap() - lat).abs() < 20, "{:?}", pa.lat_us);
    }

    /// Three nodes founding at once agree within a few beacons and stay in step; a node that
    /// reboots rejoins the running time instead of resetting it.
    #[test]
    fn founding_joining_and_steady_state() {
        let offs = [0i64, 37_000_000, -5_000_000];
        let ppm = [0i64, 25, -15];
        let local = |i: usize, g: i64| g + offs[i] + g * ppm[i] / 1_000_000;
        let mut t: Vec<MeshTime> = (0..3).map(|i| MeshTime::new(10 + i as u16)).collect();
        let step = 100_000i64;
        let mut next = [0i64, 170_000, 330_000];
        let mut worst_late = 0i64;
        for k in 0..900i64 {
            let g = k * step;
            if k == 600 {
                t[2] = MeshTime::new(12); // reboot: RAM lost (its clock keeps running)
                next[2] = g + 50_000;
            }
            for i in 0..3 {
                if g >= next[i] {
                    next[i] = g + BEACON_US - ((k * 7 + i as i64 * 13) % 5) * 20_000;
                    let b = t[i].beacon(local(i, g));
                    t[i].on_stamp(local(i, g + 300), 8);
                    for j in 0..3 {
                        if j != i {
                            let r = local(j, g + 300 + 650);
                            let from = t[i].me;
                            t[j].on_beacon(r, from, r, &b);
                        }
                    }
                }
            }
            if g > 15_000_000 && (k < 600 || k > 680) {
                let m: Vec<i64> = (0..3).map(|i| t[i].mesh_us(local(i, g))).collect();
                let spread = m.iter().max().unwrap() - m.iter().min().unwrap();
                worst_late = worst_late.max(spread);
            }
        }
        assert!(worst_late < 150, "mesh time spread {worst_late} µs");
        assert!(t.iter().all(|x| x.state == SyncState::Synced));
        assert!(t[2].stats.joined >= 1 && t[2].stats.founded == 0, "{:?}", t[2].stats);
        // The founders took the latest clock (node 1's): nobody's time stepped back.
        let g = 89_000_000;
        assert!((t[0].mesh_us(local(0, g)) - local(1, g)).abs() < 2_000_000);
    }

    #[test]
    fn epochs_gossip_newest_wins() {
        let mut a = MeshTime::new(1);
        let mut b = MeshTime::new(2);
        let e1 = a.originate(Some(5_000_000));
        assert_eq!(e1.gen, 1);
        let bc = a.beacon(1_000);
        assert_eq!(b.on_beacon(2_000, 1, 2_000, &bc), Some(e1));
        assert_eq!(b.on_beacon(2_500, 1, 2_500, &bc), None, "same generation: no change");
        let e2 = b.originate(None);
        assert_eq!((e2.gen, e2.origin, e2.epoch_mesh_us), (2, 2, None));
        let bc = b.beacon(3_000);
        assert_eq!(a.on_beacon(3_000, 2, 3_000, &bc), Some(e2));
        // An older generation never wins.
        let stale = TimeBeacon { epoch: Some(e1), ..bc };
        assert_eq!(a.on_beacon(3_500, 2, 3_500, &stale), None);
    }

    #[test]
    fn coarse_and_unpaired_stamps_are_not_samples() {
        let mut a = MeshTime::new(1);
        let mut b = MeshTime::new(2);
        let b1 = a.beacon(0);
        a.on_stamp(100, MAX_STAMP_ERR_US + 1);
        b.on_beacon(700, 1, 700, &b1);
        let b2 = a.beacon(500_000);
        b.on_beacon(500_700, 1, 500_700, &b2);
        let p = b.peers.iter().flatten().next().unwrap();
        assert_eq!((p.coarse, p.samples), (1, 0));
        // A stamp for a beacon b never heard.
        a.on_stamp(500_100, 5);
        let mut b3 = a.beacon(1_000_000);
        b3.prev = Some(Stamp { seq: 999, done_us: 0, err_us: 1 });
        b.on_beacon(1_000_700, 1, 1_000_700, &b3);
        assert_eq!(b.peers.iter().flatten().next().unwrap().unpaired, 1);
    }
}
