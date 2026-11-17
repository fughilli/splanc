//! The envelope as a frame guard around M1's link frames (design §3.1 item 4, §5.1, §7.5).
//!
//! [`crate::Node`] seals every link frame it sends and opens every frame it receives through a
//! [`FrameGuard`]. [`MeshSecurity`] is the real one: AES-CCM under the frame key of the
//! current epoch (and the previous one for 60 s during a rotation, §7.6), the 64-bit counter
//! with its short/long header ([`crate::envelope`]), the per-source replay window checked
//! before decrypting and committed after. [`Plain`] is M1's pass-through.
//!
//! Trust domains: a member's node only ever feeds `swarm_net` frames under the mesh key; a
//! guest's only frames under `K_open` (§7.4: "members never act on open-key frames"). Plain
//! frames (epoch 0) never reach `swarm_net`: they go to membership ([`Opened::Plain`]).
//!
//! The group key authenticates "some member sent this", not which one: any member could
//! claim another's source id. What must be bound to one device (admin commands, membership,
//! freshness) carries pairwise MACs on top ([`crate::admin`]).

use core::ops::Range;

use crate::backhaul::NodeId;
use crate::envelope::{self, reconstruct, EnvReject, Header, MicLen, TxCounter, EPOCH_OPEN, EPOCH_PLAIN, HEADER_LEN, HEADER_LONG_LEN};
use crate::replay::{ReplayTable, SourceState};

/// What a guard made of a received frame.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Opened {
    /// A link frame for `swarm_net`, at `frame[range]`.
    Link(Range<usize>),
    /// A plain frame (join, advert, guest hello) for membership: its header and body range.
    Plain { header: Header, body: Range<usize> },
    /// Dropped (the guard counted why).
    Dropped,
}

/// Seals and opens backhaul frames around link frames.
pub trait FrameGuard {
    /// Bytes added to each link frame (taken off the backhaul MTU before sizing packets).
    fn overhead(&self) -> usize;
    /// Whether this node may send mesh frames at all (it holds a key).
    fn can_seal(&self) -> bool;
    /// Seal `link` into `out` (at most `mtu` bytes); its length, or None.
    fn seal(&mut self, now_us: i64, link: &[u8], out: &mut [u8]) -> Option<usize>;
    /// A plain frame for `body` (membership traffic), if the guard has any.
    fn seal_plain(&mut self, _body: &[u8], _out: &mut [u8]) -> Option<usize> {
        None
    }
    /// Open a received frame in place.
    fn open(&mut self, now_us: i64, frame: &mut [u8]) -> Opened;
}

/// M1's pass-through: link frames as they are, no envelope.
#[derive(Clone, Copy, Debug, Default)]
pub struct Plain;

impl FrameGuard for Plain {
    fn overhead(&self) -> usize {
        0
    }
    fn can_seal(&self) -> bool {
        true
    }
    fn seal(&mut self, _now_us: i64, link: &[u8], out: &mut [u8]) -> Option<usize> {
        out.get_mut(..link.len())?.copy_from_slice(link);
        Some(link.len())
    }
    fn open(&mut self, _now_us: i64, frame: &mut [u8]) -> Opened {
        Opened::Link(0..frame.len())
    }
}

/// Members tracked by the replay table (§7.5: 64 × 16 B).
pub const MEMBERS: usize = 64;
/// Guests tracked by their own replay table (§7.4; open mode only).
#[cfg(feature = "open_mode")]
pub const GUEST_SOURCES: usize = 16;
/// Both epochs are accepted this long after a rotation (§7.6).
pub const GRACE_US: i64 = 60_000_000;
/// A sender puts its full counter in a long header at least this often (when the frame has
/// room), so receivers without state for it learn the high bits.
pub const LONG_EVERY_US: i64 = 1_000_000;

/// Whose frames this node reads and writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Domain {
    /// No key: plain frames only.
    None,
    /// The mesh key.
    Member,
    /// An open mesh's follow stream, `K_open`.
    Guest,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct EpochKey {
    epoch: u8,
    key: [u8; 16],
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SecurityStats {
    pub sealed: u32,
    pub sealed_long: u32,
    pub opened: u32,
    pub plain: u32,
    pub not_envelope: u32,
    /// Unknown envelope version (§5.7: reported as "incompatible").
    pub version: u32,
    pub foreign_mesh: u32,
    /// An epoch we hold no key for (`newer_epoch` counts the later ones).
    pub unknown_epoch: u32,
    pub newer_epoch: u32,
    pub bad_mic: u32,
    pub replay_duplicate: u32,
    pub replay_too_old: u32,
    pub replay_full: u32,
    /// A short header from a sender we hold no counter for (waits for its long header).
    pub unsynced_short: u32,
    /// Open-key frames a member ignored, or member frames a guest cannot read.
    pub other_domain: u32,
    /// Frames not sent: the counter's reservation has not been persisted yet.
    pub counter_unreserved: u32,
    /// Frames dropped because this node holds no key.
    pub no_key: u32,
}

pub struct MeshSecurity {
    pub mesh_id: u32,
    pub me: NodeId,
    pub mic: MicLen,
    /// The backhaul MTU (the long header is used only when the frame fits).
    pub mtu: usize,
    domain: Domain,
    current: Option<EpochKey>,
    previous: Option<(EpochKey, i64)>,
    /// A rotation's new key: accepted on receive, not yet used to send (§7.6).
    next: Option<EpochKey>,
    heard_next: bool,
    open_key: Option<[u8; 16]>,
    tx: TxCounter,
    last_long_us: Option<i64>,
    members: ReplayTable<MEMBERS>,
    #[cfg(feature = "open_mode")]
    guests: ReplayTable<GUEST_SOURCES>,
    pub stats: SecurityStats,
}

impl MeshSecurity {
    /// `counter_mark` is the persisted counter high-water mark (§7.5; 0 on a new device).
    pub fn new(me: NodeId, mic: MicLen, mtu: usize, counter_mark: u64) -> MeshSecurity {
        MeshSecurity {
            mesh_id: 0,
            me,
            mic,
            mtu,
            domain: Domain::None,
            current: None,
            previous: None,
            next: None,
            heard_next: false,
            open_key: None,
            tx: TxCounter::new(counter_mark),
            last_long_us: None,
            members: ReplayTable::new(),
            #[cfg(feature = "open_mode")]
            guests: ReplayTable::new(),
            stats: SecurityStats::default(),
        }
    }

    pub fn domain(&self) -> Domain {
        self.domain
    }

    pub fn epoch(&self) -> Option<u8> {
        self.current.map(|k| k.epoch)
    }

    /// Install the mesh key for `epoch` (membership's keys changed). A different epoch than
    /// the current one keeps the old key for [`GRACE_US`].
    pub fn set_member(&mut self, now_us: i64, mesh_id: u32, epoch: u8, mesh_key: &[u8; 16]) {
        let k = EpochKey { epoch, key: envelope::frame_key(mesh_id, mesh_key, epoch) };
        if mesh_id != self.mesh_id {
            self.members.clear();
            self.previous = None;
        } else if let Some(cur) = self.current {
            if cur.epoch != epoch {
                self.previous = Some((cur, now_us + GRACE_US));
            } else if cur.key != k.key {
                self.previous = None;
            }
        }
        self.mesh_id = mesh_id;
        self.current = Some(k);
        self.open_key = None;
        self.domain = Domain::Member;
    }

    /// A rotation's new key (§7.6): accept frames under it now, keep sending under the
    /// current one until [`MeshSecurity::switch_to_next`] (so members that don't have it yet
    /// can still read everything, relays of the rekey included).
    pub fn stage_next(&mut self, mesh_id: u32, epoch: u8, mesh_key: &[u8; 16]) {
        if mesh_id == self.mesh_id && self.domain == Domain::Member {
            self.next = Some(EpochKey { epoch, key: envelope::frame_key(mesh_id, mesh_key, epoch) });
            self.heard_next = false;
        }
    }

    /// Send under the staged key from now on; the old one is accepted for [`GRACE_US`].
    pub fn switch_to_next(&mut self, now_us: i64) -> bool {
        let Some(n) = self.next.take() else { return false };
        if let Some(cur) = self.current {
            self.previous = Some((cur, now_us + GRACE_US));
        }
        self.current = Some(n);
        self.heard_next = false;
        true
    }

    /// The staged epoch, if a rotation is pending here.
    pub fn next_epoch(&self) -> Option<u8> {
        self.next.map(|n| n.epoch)
    }

    /// A frame under the staged key verified (someone already switched): time to switch.
    pub fn take_heard_next(&mut self) -> bool {
        core::mem::take(&mut self.heard_next)
    }

    /// Follow an open mesh as a guest.
    #[cfg(feature = "open_mode")]
    pub fn set_guest(&mut self, mesh_id: u32, open_key: [u8; 16]) {
        self.mesh_id = mesh_id;
        self.current = None;
        self.previous = None;
        self.open_key = Some(open_key);
        self.guests.clear();
        self.domain = Domain::Guest;
    }

    /// Plain frames only (unprovisioned, searching for a mesh, or a guest that stopped).
    pub fn set_none(&mut self, mesh_id: u32) {
        self.mesh_id = mesh_id;
        self.current = None;
        self.previous = None;
        self.open_key = None;
        self.domain = Domain::None;
    }

    /// The counter mark to persist next, if one is due (§7.5: once per 2^16 frames).
    pub fn wants_counter_reservation(&mut self) -> Option<u64> {
        self.tx.wants_reservation()
    }

    pub fn counter_reserved(&mut self, mark: u64) {
        self.tx.reserved(mark);
    }

    /// A fresh, never-repeating value (an admin sequence): the frame counter.
    pub fn next_sequence(&mut self) -> Option<u64> {
        self.tx.take().ok()
    }

    /// This sender's current full counter (what a freshness reply vouches for).
    pub fn current_counter(&self) -> u64 {
        self.tx.current()
    }

    /// What the replay table holds for `src`.
    pub fn source(&self, src: NodeId) -> Option<SourceState> {
        self.members.state(src)
    }

    /// A freshness exchange vouched for `src`'s counter (see [`ReplayTable::sync`]).
    pub fn sync_source(&mut self, now_us: i64, src: NodeId, ctr: u64) -> bool {
        self.members.sync(src, ctr, (now_us / 1_000_000) as u32)
    }

    /// High-water marks to persist occasionally (a fallback for after a reboot).
    pub fn export_marks(&self) -> impl Iterator<Item = (NodeId, u64)> + '_ {
        self.members.export()
    }

    /// Restore persisted marks at boot.
    pub fn restore_mark(&mut self, now_us: i64, src: NodeId, high: u64) {
        self.members.restore(src, high, (now_us / 1_000_000) as u32);
    }

    fn key_for(&mut self, now_us: i64, epoch: u8) -> Option<[u8; 16]> {
        if let Some(c) = self.current.filter(|c| c.epoch == epoch) {
            return Some(c.key);
        }
        if let Some(n) = self.next.filter(|n| n.epoch == epoch) {
            return Some(n.key);
        }
        match self.previous {
            Some((p, until)) if p.epoch == epoch && now_us < until => Some(p.key),
            Some((_, until)) if now_us >= until => {
                self.previous = None;
                None
            }
            _ => None,
        }
    }

    fn sync_replay_stats(&mut self) {
        let m = self.members.stats;
        #[cfg(feature = "open_mode")]
        let m = {
            let g = self.guests.stats;
            crate::replay::ReplayStats { duplicate: m.duplicate + g.duplicate, too_old: m.too_old + g.too_old, full: m.full + g.full, evicted: 0 }
        };
        self.stats.replay_duplicate = m.duplicate;
        self.stats.replay_too_old = m.too_old;
        self.stats.replay_full = m.full;
    }

    fn open_member(&mut self, now_us: i64, h: &Header, frame: &mut [u8]) -> Opened {
        if self.domain != Domain::Member {
            self.stats.no_key += 1;
            return Opened::Dropped;
        }
        let Some(key) = self.key_for(now_us, h.epoch) else {
            self.stats.unknown_epoch += 1;
            if self.current.is_some_and(|c| h.epoch > c.epoch) {
                self.stats.newer_epoch += 1;
            }
            return Opened::Dropped;
        };
        let counter = if h.long {
            h.counter
        } else {
            match self.members.state(h.src) {
                Some(s) => reconstruct(s.high, h.counter as u32),
                None => {
                    self.stats.unsynced_short += 1;
                    return Opened::Dropped;
                }
            }
        };
        let now_s = (now_us / 1_000_000) as u32;
        if let Err(r) = self.members.check(h.src, counter, now_s) {
            self.members.count(r);
            self.sync_replay_stats();
            return Opened::Dropped;
        }
        match envelope::open(&key, self.mic, h, counter, frame) {
            Ok(r) => {
                if let Err(e) = self.members.commit(h.src, counter, now_s) {
                    self.members.count(e);
                    self.sync_replay_stats();
                    return Opened::Dropped;
                }
                self.stats.opened += 1;
                if self.next.is_some_and(|n| n.epoch == h.epoch) {
                    self.heard_next = true;
                }
                Opened::Link(r)
            }
            Err(_) => {
                self.stats.bad_mic += 1;
                Opened::Dropped
            }
        }
    }

    #[cfg(feature = "open_mode")]
    fn open_guest(&mut self, now_us: i64, h: &Header, frame: &mut [u8]) -> Opened {
        let (Domain::Guest, Some(key)) = (self.domain, self.open_key) else {
            self.stats.other_domain += 1;
            return Opened::Dropped;
        };
        let counter = match (h.long, self.guests.state(h.src)) {
            (true, _) => h.counter,
            (false, Some(s)) => reconstruct(s.high, h.counter as u32),
            (false, None) => {
                self.stats.unsynced_short += 1;
                return Opened::Dropped;
            }
        };
        let now_s = (now_us / 1_000_000) as u32;
        if let Err(r) = self.guests.check(h.src, counter, now_s) {
            self.guests.count(r);
            self.sync_replay_stats();
            return Opened::Dropped;
        }
        match envelope::open(&key, self.mic, h, counter, frame) {
            Ok(r) if self.guests.commit(h.src, counter, now_s).is_ok() => {
                self.stats.opened += 1;
                Opened::Link(r)
            }
            Ok(_) => Opened::Dropped,
            Err(_) => {
                self.stats.bad_mic += 1;
                Opened::Dropped
            }
        }
    }
}

impl FrameGuard for MeshSecurity {
    fn overhead(&self) -> usize {
        self.mic.overhead()
    }

    fn can_seal(&self) -> bool {
        self.domain != Domain::None
    }

    fn seal(&mut self, now_us: i64, link: &[u8], out: &mut [u8]) -> Option<usize> {
        let (epoch, key) = match self.domain {
            Domain::Member => {
                let c = self.current?;
                (c.epoch, c.key)
            }
            // TODO(M7b): guests relay the follow stream; this path is what that relay uses.
            Domain::Guest => (EPOCH_OPEN, self.open_key?),
            Domain::None => return None,
        };
        let Ok(counter) = self.tx.take() else {
            self.stats.counter_unreserved += 1;
            return None;
        };
        let due = self.last_long_us.is_none_or(|t| now_us - t >= LONG_EVERY_US);
        let long = due && HEADER_LONG_LEN + link.len() + self.mic.bytes() <= self.mtu;
        if long {
            self.last_long_us = Some(now_us);
            self.stats.sealed_long += 1;
        }
        let h = Header { mesh_id: self.mesh_id, epoch, src: self.me, counter, long };
        let n = envelope::seal(&key, self.mic, &h, link, out)?;
        self.stats.sealed += 1;
        Some(n)
    }

    fn seal_plain(&mut self, body: &[u8], out: &mut [u8]) -> Option<usize> {
        let Ok(counter) = self.tx.take() else {
            self.stats.counter_unreserved += 1;
            return None;
        };
        envelope::seal_plain(self.mesh_id, self.me, counter, body, out)
    }

    fn open(&mut self, now_us: i64, frame: &mut [u8]) -> Opened {
        let h = match Header::decode(frame) {
            Ok(h) => h,
            Err(EnvReject::Version(_)) => {
                self.stats.version += 1;
                return Opened::Dropped;
            }
            Err(_) => {
                self.stats.not_envelope += 1;
                return Opened::Dropped;
            }
        };
        if h.src == self.me {
            return Opened::Dropped; // our own frame heard back (a relay)
        }
        if h.epoch == EPOCH_PLAIN {
            // Any mesh id: a guest looks for open meshes it does not belong to yet.
            self.stats.plain += 1;
            return Opened::Plain { header: h, body: HEADER_LEN.min(h.len())..frame.len() };
        }
        if h.mesh_id != self.mesh_id {
            self.stats.foreign_mesh += 1;
            return Opened::Dropped;
        }
        if h.epoch == EPOCH_OPEN {
            #[cfg(feature = "open_mode")]
            return self.open_guest(now_us, &h, frame);
            #[cfg(not(feature = "open_mode"))]
            {
                self.stats.other_domain += 1;
                return Opened::Dropped;
            }
        }
        if self.domain == Domain::Guest {
            self.stats.other_domain += 1;
            return Opened::Dropped;
        }
        self.open_member(now_us, &h, frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MESH: u32 = 77;
    const KEY: [u8; 16] = [3; 16];

    fn node(id: NodeId, mark: u64) -> MeshSecurity {
        let mut s = MeshSecurity::new(id, MicLen::M8, 250, mark);
        s.set_member(0, MESH, 1, &KEY);
        let m = s.wants_counter_reservation().unwrap();
        s.counter_reserved(m);
        s
    }

    fn pair() -> (MeshSecurity, MeshSecurity) {
        (node(1, 0), node(2, 0))
    }

    fn seal_at(s: &mut MeshSecurity, now: i64, body: &[u8]) -> Vec<u8> {
        let mut out = [0u8; 256];
        let n = s.seal(now, body, &mut out).unwrap();
        out[..n].to_vec()
    }

    fn seal(s: &mut MeshSecurity, body: &[u8]) -> Vec<u8> {
        seal_at(s, 0, body)
    }

    fn open(s: &mut MeshSecurity, now: i64, f: &[u8]) -> Option<Vec<u8>> {
        let mut g = f.to_vec();
        match s.open(now, &mut g) {
            Opened::Link(r) => Some(g[r].to_vec()),
            _ => None,
        }
    }

    #[test]
    fn long_header_once_a_second_then_short() {
        let (mut a, mut b) = pair();
        let f = seal(&mut a, b"link");
        assert_eq!(&f[..2], b"SL", "first frame carries the full counter");
        assert_eq!(f.len(), 4 + 26);
        let g = seal(&mut a, b"link");
        assert_eq!((&g[..2], g.len()), (&b"SM"[..], 4 + 22));
        // A receiver without state can't use a short header until it hears a long one.
        assert_eq!(open(&mut b, 0, &g), None);
        assert_eq!(b.stats.unsynced_short, 1);
        assert_eq!(open(&mut b, 0, &f).as_deref(), Some(&b"link"[..]));
        assert_eq!(open(&mut b, 0, &g).as_deref(), Some(&b"link"[..]), "now reconstructed");
        assert_eq!(open(&mut b, 0, &g), None, "replay");
        assert!(&seal_at(&mut a, 1_000_000, b"x")[..2] == b"SL", "again after a second");
        // A frame without room for 4 more bytes stays short.
        let big = [0u8; 250 - 22];
        assert_eq!(&seal_at(&mut a, 5_000_000, &big)[..2], b"SM");
    }

    /// A sender far into its counter, across 2^32, rebooting to its reserved mark.
    #[test]
    fn counters_across_2_32_and_reboots() {
        let start = (1u64 << 32) - 3;
        let mut a = node(1, start);
        let mut b = node(2, 0);
        let mut got = 0;
        for i in 0..8 {
            let f = seal_at(&mut a, i * 10, b"x");
            got += open(&mut b, i * 10, &f).is_some() as u32;
        }
        assert_eq!(got, 8);
        assert!(b.source(1).unwrap().high >= 1 << 32);
        // Reboot: the sender restarts at its persisted mark (a block ahead), its first
        // frame is long, and the receiver accepts it; old frames stay refused.
        let old = seal_at(&mut a, 100, b"old");
        let mark = start + envelope::COUNTER_BLOCK;
        let mut a2 = node(1, mark);
        let f = seal_at(&mut a2, 2_000_000, b"new");
        assert_eq!(open(&mut b, 2_000_000, &f).as_deref(), Some(&b"new"[..]));
        assert_eq!(open(&mut b, 2_000_000, &old), None, "too old after the jump");
    }

    #[test]
    fn a_forged_frame_does_not_move_the_window() {
        let (mut a, mut b) = pair();
        let f = seal(&mut a, b"real");
        let mut forged = f.clone();
        forged[10..18].copy_from_slice(&0x7fff_ffff_ffffu64.to_be_bytes());
        assert!(open(&mut b, 0, &forged).is_none());
        assert_eq!(b.stats.bad_mic, 1);
        assert!(open(&mut b, 0, &f).is_some(), "the real frame is still fresh");
    }

    #[test]
    fn foreign_meshes_wrong_keys_and_versions() {
        let (mut a, mut b) = pair();
        let mut c = node(3, 0);
        c.set_member(0, MESH + 1, 1, &KEY);
        assert!(open(&mut b, 0, &seal(&mut c, b"x")).is_none());
        assert_eq!(b.stats.foreign_mesh, 1);
        let mut d = node(4, 0);
        d.set_member(0, MESH, 1, &[9; 16]);
        assert!(open(&mut b, 0, &seal(&mut d, b"x")).is_none());
        assert_eq!(b.stats.bad_mic, 1);
        let mut v = seal(&mut a, b"x");
        v[2] = 9;
        assert!(open(&mut b, 0, &v).is_none());
        assert_eq!(b.stats.version, 1);
    }

    #[test]
    fn rotation_keeps_the_old_epoch_for_the_grace_period() {
        let (mut a, mut b) = pair();
        let old = seal(&mut a, b"old");
        b.set_member(1_000_000, MESH, 2, &[8; 16]);
        assert!(open(&mut b, 2_000_000, &old).is_some(), "old epoch within 60 s");
        let old2 = seal(&mut a, b"old2");
        assert!(open(&mut b, 1_000_000 + GRACE_US, &old2).is_none(), "and not after");
        a.set_member(0, MESH, 2, &[8; 16]);
        assert!(open(&mut b, 1_000_000 + GRACE_US, &seal_at(&mut a, 3_000_000, b"new")).is_some());
        let mut c = node(5, 0);
        c.set_member(0, MESH, 5, &[1; 16]);
        assert!(open(&mut b, 0, &seal(&mut c, b"x")).is_none());
        assert_eq!(b.stats.newer_epoch, 1);
    }

    /// A staged key is read before it is used to send; hearing it used triggers the switch.
    #[test]
    fn staged_rotation() {
        let (mut a, mut b) = pair();
        b.stage_next(MESH, 2, &[8; 16]);
        assert_eq!(&seal(&mut b, b"x")[7..8], &[1], "still sends under epoch 1");
        assert!(open(&mut a, 0, &seal_at(&mut b, 1_500_000, b"y")).is_some(), "a (no new key) still reads b");
        a.stage_next(MESH, 2, &[8; 16]);
        assert!(a.switch_to_next(0));
        let f = seal_at(&mut a, 2_000_000, b"new");
        assert!(open(&mut b, 0, &f).is_some());
        assert!(b.take_heard_next());
        assert!(b.switch_to_next(0));
        assert_eq!(b.epoch(), Some(2));
        assert!(open(&mut a, 1_000, &seal_at(&mut b, 3_000_000, b"z")).is_some());
    }

    #[test]
    fn counter_must_be_reserved_before_use() {
        let mut s = MeshSecurity::new(1, MicLen::M8, 250, 0);
        s.set_member(0, MESH, 1, &KEY);
        assert!(s.seal(0, b"x", &mut [0; 64]).is_none());
        assert_eq!(s.stats.counter_unreserved, 1);
    }

    #[test]
    fn domains_do_not_mix() {
        let (mut a, mut b) = pair();
        let mut n = MeshSecurity::new(11, MicLen::M8, 250, 0);
        n.set_none(MESH);
        n.counter_reserved(envelope::COUNTER_BLOCK);
        assert!(!n.can_seal());
        assert!(n.seal(0, b"x", &mut [0; 64]).is_none());
        let mut p = [0u8; 64];
        let len = n.seal_plain(b"hello", &mut p).unwrap();
        assert!(matches!(b.open(0, &mut p[..len]), Opened::Plain { header, body } if header.src == 11 && body == (14..19)));
        let _ = seal(&mut a, b"m");
    }

    #[cfg(feature = "open_mode")]
    #[test]
    fn open_key_frames_are_not_member_frames() {
        let (mut a, mut b) = pair();
        let mut g = MeshSecurity::new(9, MicLen::M8, 250, 0);
        g.set_guest(MESH, envelope::open_key(MESH));
        g.counter_reserved(envelope::COUNTER_BLOCK);
        let gf = seal(&mut g, b"guest");
        assert!(open(&mut b, 0, &gf).is_none(), "members never act on open-key frames");
        assert!(open(&mut g, 0, &seal(&mut a, b"member")).is_none(), "guests cannot read members");
    }
}
