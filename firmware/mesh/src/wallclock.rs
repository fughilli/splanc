//! The mesh wall clock (RTC plan §3, PR-8; owner decision D-564: each lamp fires its own
//! rules on mesh-shared wall time).
//!
//! **One record** ([`WallRecord`]): `wall_minus_mesh_us` (UTC µs minus mesh µs at the same
//! instant), a generation, the node that sent it, the sender's clock source and error, and
//! the zone (a POSIX TZ rule and its IANA name, so a rule written for 07:00 fires at the same
//! local time on every member). Mesh time is shared by every member (tens of µs), so every
//! member that maps the same record through its own mesh-time fit agrees on wall time to
//! mesh-time accuracy, whatever the record's absolute error. A schedule then fires on the
//! same frame everywhere.
//!
//! **Origin.** Like the show epoch (desk #79), the gateway's admin session originates it, on
//! the admin-class port `CLOCK` (signed per receiver like `TIME_BASE`; envelope framing on a
//! dev mesh with no admin key). Only a gateway whose own clock came from somewhere other than
//! the mesh (SNTP, the app, a hardware RTC, a soft-reset carry-over) sends one: a record
//! never comes back around as its own source. [`WallMesh::due`] decides when: at once, again
//! when the gateway's wall clock has moved against mesh time by [`MOVE_US`] (its crystal
//! against the mesh's, or a new sample; at most every [`MIN_GAP_US`]), when its source or
//! zone changes, and every [`REFRESH_US`] for members that joined or rebooted since.
//!
//! **Members** keep the newest signed record ([`WallMesh::take`]); the firmware offers it to
//! its software RTC as source `Mesh` (a member with a better source of its own, SNTP say,
//! keeps that for its display clock) and converts schedule instants through it, so every
//! member, the gateway included, fires a rule at the same mesh instant.

use crate::backhaul::NodeId;
use crate::codec::{R, W};

/// Longest POSIX rule / IANA name carried (the player's own limit).
pub const TZ_MAX: usize = 64;
/// The record's wire version.
pub const VERSION: u8 = 1;
/// The largest encoded record.
pub const RECORD_MAX: usize = 1 + 4 + 2 + 8 + 4 + 1 + 1 + TZ_MAX + 1 + TZ_MAX;
/// The `ledmapper_clock::Source` wire value of a mesh-relayed sample (never re-originated).
pub const SOURCE_MESH: u8 = 2;
/// Re-send when the gateway's wall clock moved this far against mesh time.
pub const MOVE_US: i64 = 500;
/// ... but no more often than this.
pub const MIN_GAP_US: i64 = 2_000_000;
/// Re-send this often regardless (members that joined or rebooted since).
pub const REFRESH_US: i64 = 30_000_000;
/// The device's own wall-clock report older than this is not used to originate.
pub const LOCAL_STALE_US: i64 = 1_000_000;
/// How fast a held record's error grows, ppm (the sender's crystal against mesh time).
pub const DRIFT_PPM: i64 = 40;
/// A node that sent a record this recently ignores another gateway's (its own source is
/// at hand; members could otherwise see two gateways' records alternate).
pub const OWN_HOLD_US: i64 = 2 * REFRESH_US;

/// `STATUS` port tag of a [`ClockStatus`] (next to the status `0x23` and topology `0x24`).
pub const T_CLOCK_STATUS: u8 = 0x25;
/// A member's clock status goes out this often, and on a change (at most every
/// [`MIN_GAP_US`]).
pub const STATUS_EVERY_US: i64 = 60_000_000;

/// A member's wall clock as the gateway lists it (`MeshMember.clock_*`): its own small
/// message, so an older gateway still decodes the 27-byte status.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ClockStatus {
    /// `ClockSource` (0 = not set, 2 = the mesh's record).
    pub source: u8,
    /// Its error bound, ms (saturating; 0 while not set).
    pub err_ms: u32,
    /// The mesh record it maps schedules through (generation, sender; 0 = none).
    pub gen: u32,
    pub origin: NodeId,
}

impl ClockStatus {
    pub const LEN: usize = 1 + 1 + 4 + 4 + 2;

    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let mut w = W::new(out);
        w.u8(T_CLOCK_STATUS).u8(self.source).u32(self.err_ms).u32(self.gen).u16(self.origin);
        w.done()
    }

    /// Later versions may append fields: ignored.
    pub fn decode(b: &[u8]) -> Option<ClockStatus> {
        let mut r = R::new(b);
        if r.u8()? != T_CLOCK_STATUS {
            return None;
        }
        Some(ClockStatus { source: r.u8()?, err_ms: r.u32()?, gen: r.u32()?, origin: r.u16()? })
    }

    /// Worth an early broadcast: the source or the record changed, or the error moved by
    /// more than a factor of two.
    pub fn differs(&self, o: &ClockStatus) -> bool {
        let (a, b) = (self.err_ms.max(1), o.err_ms.max(1));
        self.source != o.source || self.gen != o.gen || self.origin != o.origin || a > 2 * b || b > 2 * a
    }
}

/// A time zone: the POSIX rule (`""` = UTC) and its IANA name (display only).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Zone {
    rule: [u8; TZ_MAX],
    rule_len: u8,
    name: [u8; TZ_MAX],
    name_len: u8,
}

impl Default for Zone {
    fn default() -> Self {
        Self::UTC
    }
}

impl Zone {
    pub const UTC: Zone = Zone { rule: [0; TZ_MAX], rule_len: 0, name: [0; TZ_MAX], name_len: 0 };

    /// None if either part is longer than [`TZ_MAX`].
    pub fn new(rule: &[u8], name: &[u8]) -> Option<Zone> {
        if rule.len() > TZ_MAX || name.len() > TZ_MAX {
            return None;
        }
        let mut z = Zone::UTC;
        z.rule[..rule.len()].copy_from_slice(rule);
        z.rule_len = rule.len() as u8;
        z.name[..name.len()].copy_from_slice(name);
        z.name_len = name.len() as u8;
        Some(z)
    }

    pub fn rule(&self) -> &[u8] {
        &self.rule[..self.rule_len as usize]
    }

    pub fn name(&self) -> &[u8] {
        &self.name[..self.name_len as usize]
    }

    /// FNV-1a over both parts (what a sent record remembers of its zone).
    pub fn hash(&self) -> u32 {
        let mut h = 2_166_136_261u32;
        for &b in self.rule().iter().chain([0xffu8].iter()).chain(self.name()) {
            h = (h ^ u32::from(b)).wrapping_mul(16_777_619);
        }
        h
    }
}

/// The wall clock on mesh time (module docs). Body of the `CLOCK` port.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WallRecord {
    pub gen: u32,
    pub origin: NodeId,
    /// UTC µs minus mesh µs.
    pub wall_minus_mesh_us: i64,
    /// The sender's error bound when it sent it (its wall clock's plus its mesh time's), µs.
    pub err_us: u32,
    /// The sender's clock source (`ledmapper_clock::Source` wire value; never [`SOURCE_MESH`]).
    pub source: u8,
    pub zone: Zone,
}

impl WallRecord {
    /// `ver ‖ gen ‖ origin ‖ wall−mesh ‖ err ‖ source ‖ rule_len ‖ rule ‖ name_len ‖ name`.
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let mut w = W::new(out);
        w.u8(VERSION).u32(self.gen).u16(self.origin).i64(self.wall_minus_mesh_us).u32(self.err_us).u8(self.source);
        w.u8(self.zone.rule_len).put(self.zone.rule()).u8(self.zone.name_len).put(self.zone.name());
        w.done()
    }

    /// A later version may append fields: they are ignored.
    pub fn decode(b: &[u8]) -> Option<WallRecord> {
        let mut r = R::new(b);
        if r.u8()? < VERSION {
            return None;
        }
        let (gen, origin, wmm, err_us, source) = (r.u32()?, r.u16()?, r.i64()?, r.u32()?, r.u8()?);
        let n = r.u8()? as usize;
        let rule = r.take(n)?;
        let m = r.u8()? as usize;
        let name = r.take(m)?;
        let zone = Zone::new(rule, name)?;
        (source != SOURCE_MESH).then_some(WallRecord { gen, origin, wall_minus_mesh_us: wmm, err_us, source, zone })
    }

    /// UTC µs at mesh instant `mesh_us`.
    pub fn wall_at(&self, mesh_us: i64) -> i64 {
        mesh_us.saturating_add(self.wall_minus_mesh_us)
    }

    /// The mesh instant of UTC µs `unix_us`.
    pub fn mesh_at(&self, unix_us: i64) -> i64 {
        unix_us.saturating_sub(self.wall_minus_mesh_us)
    }
}

/// The device's own wall clock, as the firmware reports it each pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LocalWall {
    /// UTC µs at local (device clock) µs `at_us`.
    pub unix_us: i64,
    pub at_us: i64,
    /// Its error bound now, µs.
    pub err_us: i64,
    /// `ledmapper_clock::Source` wire value.
    pub source: u8,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct WallStats {
    /// Records this node sent (gateway).
    pub sent: u32,
    /// Signed records taken (member), and ones ignored because this node is originating.
    pub taken: u32,
    pub ignored: u32,
    /// `CLOCK` bodies that did not decode.
    pub bad: u32,
}

/// What a sent record was, to judge when the next is due.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Sent {
    at_us: i64,
    wmm: i64,
    source: u8,
    zone: u32,
}

/// The mesh wall clock's state on one node (in the stack; ~0.5 KB).
#[derive(Clone, Copy, Debug, Default)]
pub struct WallMesh {
    /// The record in force: the newest signed one, or the one this node sent.
    pub rec: Option<WallRecord>,
    /// Local µs `rec` was taken or sent.
    pub rec_us: i64,
    /// `rec` is this node's own.
    pub own: bool,
    /// The device's wall clock (firmware report) and zone; whether the firmware reports one
    /// at all (a device without a wall clock sends no clock status).
    pub local: Option<LocalWall>,
    pub reported: bool,
    pub zone: Zone,
    sent: Option<Sent>,
    /// The clock status last broadcast, and when.
    status_sent: Option<(ClockStatus, i64)>,
    pub stats: WallStats,
}

impl WallMesh {
    pub const fn new() -> WallMesh {
        WallMesh { rec: None, rec_us: 0, own: false, local: None, reported: false, zone: Zone::UTC, sent: None, status_sent: None, stats: WallStats { sent: 0, taken: 0, ignored: 0, bad: 0 } }
    }

    /// Forget everything (left the mesh).
    pub fn clear(&mut self) {
        let stats = self.stats;
        *self = WallMesh::new();
        self.stats = stats;
    }

    /// The device's wall clock now (None: invalid) and its zone.
    pub fn set_local(&mut self, l: Option<LocalWall>, zone: Zone) {
        self.local = l;
        self.zone = zone;
        self.reported = true;
    }

    /// What this node would send at local `now_us` with mesh time `mesh_us`, if it may
    /// originate (its own clock is valid, fresh, and not from the mesh).
    pub fn candidate(&self, now_us: i64, mesh_us: i64, mesh_err_us: i64) -> Option<WallRecord> {
        let l = self.local?;
        if l.source == SOURCE_MESH || l.source == 0 || now_us.saturating_sub(l.at_us).abs() > LOCAL_STALE_US {
            return None;
        }
        let unix_now = l.unix_us.saturating_add(now_us - l.at_us);
        let err = l.err_us.saturating_add(mesh_err_us.clamp(0, 1_000_000)).clamp(0, u32::MAX as i64) as u32;
        Some(WallRecord { gen: 0, origin: 0, wall_minus_mesh_us: unix_now - mesh_us, err_us: err, source: l.source, zone: self.zone })
    }

    /// Whether `c` (from [`WallMesh::candidate`]) should go out now.
    pub fn due(&self, now_us: i64, c: &WallRecord) -> bool {
        let Some(s) = self.sent else { return true };
        let since = now_us - s.at_us;
        if !(0..REFRESH_US).contains(&since) {
            return true;
        }
        let changed = s.source != c.source || s.zone != c.zone.hash() || (c.wall_minus_mesh_us - s.wmm).abs() > MOVE_US;
        changed && since >= MIN_GAP_US
    }

    /// `c` went out (or there was nobody to send it to) at `now_us`: it is the record in
    /// force here. Returns it with its generation and origin.
    pub fn sent(&mut self, now_us: i64, me: NodeId, mut c: WallRecord) -> WallRecord {
        c.gen = self.rec.map_or(0, |r| r.gen).wrapping_add(1);
        c.origin = me;
        self.sent = Some(Sent { at_us: now_us, wmm: c.wall_minus_mesh_us, source: c.source, zone: c.zone.hash() });
        self.rec = Some(c);
        self.rec_us = now_us;
        self.own = true;
        self.stats.sent += 1;
        c
    }

    /// A signed record from the admin session (members). True if it is now in force.
    pub fn take(&mut self, now_us: i64, me: NodeId, r: WallRecord) -> bool {
        if r.origin == me {
            return false;
        }
        if self.own && self.sent.is_some_and(|s| now_us - s.at_us < OWN_HOLD_US) {
            self.stats.ignored += 1;
            return false;
        }
        self.rec = Some(r);
        self.rec_us = now_us;
        self.own = false;
        self.stats.taken += 1;
        true
    }

    /// This node's clock status (from the firmware's last report and the record in force).
    pub fn status(&self) -> ClockStatus {
        let (source, err_ms) = self.local.map_or((0, 0), |l| (l.source, (l.err_us / 1000).clamp(1, u32::MAX as i64) as u32));
        let (gen, origin) = self.rec.map_or((0, 0), |r| (r.gen, r.origin));
        ClockStatus { source, err_ms, gen, origin }
    }

    /// Whether the clock status should go out now.
    pub fn status_due(&self, now_us: i64, st: &ClockStatus) -> bool {
        match self.status_sent {
            None => true,
            Some((s, at)) => {
                let since = now_us - at;
                !(0..STATUS_EVERY_US).contains(&since) || (since >= MIN_GAP_US && st.differs(&s))
            }
        }
    }

    pub fn status_went(&mut self, now_us: i64, st: ClockStatus) {
        self.status_sent = Some((st, now_us));
    }

    /// The record's error at local `now_us`: as sent, grown with its age, plus this node's
    /// mesh-time error.
    pub fn err_now(&self, now_us: i64, mesh_err_us: i64) -> Option<i64> {
        let r = self.rec?;
        let age = (now_us - self.rec_us).max(0);
        Some(i64::from(r.err_us) + age / 1_000_000 * DRIFT_PPM + mesh_err_us.clamp(0, 1_000_000))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec() -> WallRecord {
        WallRecord {
            gen: 7,
            origin: 0x1001,
            wall_minus_mesh_us: 1_764_000_000_000_000,
            err_us: 4_000,
            source: 3,
            zone: Zone::new(b"CET-1CEST,M3.5.0,M10.5.0/3", b"Europe/Berlin").unwrap(),
        }
    }

    #[test]
    fn record_round_trip_and_forward_compat() {
        let r = rec();
        let mut b = [0u8; RECORD_MAX + 4];
        let n = r.encode(&mut b).unwrap();
        assert_eq!(n, 1 + 4 + 2 + 8 + 4 + 1 + 1 + 26 + 1 + 13);
        assert_eq!(WallRecord::decode(&b[..n]), Some(r));
        // A later version's extra fields are ignored.
        b[0] = 2;
        b[n] = 0xaa;
        assert_eq!(WallRecord::decode(&b[..n + 1]), Some(r));
        // Truncated, or a mesh-sourced record (never re-originated): refused.
        assert_eq!(WallRecord::decode(&b[..n - 1]), None);
        let mut m = r;
        m.source = SOURCE_MESH;
        let k = m.encode(&mut b).unwrap();
        assert_eq!(WallRecord::decode(&b[..k]), None);
        // The largest fits the stated bound.
        let big = WallRecord { zone: Zone::new(&[b'x'; TZ_MAX], &[b'y'; TZ_MAX]).unwrap(), ..r };
        assert_eq!(big.encode(&mut b), Some(RECORD_MAX));
        assert!(Zone::new(&[b'x'; TZ_MAX + 1], b"").is_none());
    }

    #[test]
    fn clock_status_round_trip_and_due() {
        let c = ClockStatus { source: 2, err_ms: 5, gen: 9, origin: 0x1001 };
        let mut b = [0u8; 16];
        let n = c.encode(&mut b).unwrap();
        assert_eq!(n, ClockStatus::LEN);
        assert_eq!(ClockStatus::decode(&b[..n]), Some(c));
        assert_eq!(ClockStatus::decode(&b[..n + 2]), Some(c), "appended fields ignored");
        assert_eq!(ClockStatus::decode(&b[..n - 1]), None);
        assert!(c.differs(&ClockStatus { source: 3, ..c }));
        assert!(c.differs(&ClockStatus { err_ms: 11, ..c }));
        assert!(!c.differs(&ClockStatus { err_ms: 9, ..c }));
        let mut w = WallMesh::new();
        assert_eq!(w.status(), ClockStatus::default());
        assert!(w.status_due(0, &c));
        w.status_went(0, c);
        assert!(!w.status_due(1_000_000, &ClockStatus { source: 3, ..c }), "min gap");
        assert!(w.status_due(MIN_GAP_US, &ClockStatus { source: 3, ..c }));
        assert!(!w.status_due(MIN_GAP_US, &c));
        assert!(w.status_due(STATUS_EVERY_US, &c));
    }

    #[test]
    fn mapping_is_exact_both_ways() {
        let r = rec();
        let mesh = 123_456_789;
        assert_eq!(r.mesh_at(r.wall_at(mesh)), mesh);
    }

    #[test]
    fn only_a_fresh_non_mesh_local_clock_originates() {
        let mut w = WallMesh::new();
        assert!(w.candidate(10, 5, 0).is_none(), "no local clock");
        w.set_local(Some(LocalWall { unix_us: 1_000_000_000, at_us: 0, err_us: 3_000, source: 3 }), Zone::UTC);
        let c = w.candidate(500_000, 40_000_000, 50).unwrap();
        assert_eq!(c.wall_minus_mesh_us, 1_000_500_000 - 40_000_000);
        assert_eq!(c.err_us, 3_050);
        assert!(w.candidate(2_000_001, 0, 0).is_none(), "stale report");
        w.set_local(Some(LocalWall { unix_us: 1, at_us: 0, err_us: 0, source: SOURCE_MESH }), Zone::UTC);
        assert!(w.candidate(0, 0, 0).is_none(), "a mesh-sourced clock never re-originates");
    }

    #[test]
    fn due_rules() {
        let mut w = WallMesh::new();
        let c = WallRecord { gen: 0, origin: 0, ..rec() };
        assert!(w.due(0, &c), "first");
        let s = w.sent(0, 0x1001, c);
        assert_eq!((s.gen, s.origin), (1, 0x1001));
        assert!(!w.due(1_000_000, &c), "unchanged");
        let moved = WallRecord { wall_minus_mesh_us: c.wall_minus_mesh_us + MOVE_US + 1, ..c };
        assert!(!w.due(1_000_000, &moved), "moved, but within the minimum gap");
        assert!(w.due(MIN_GAP_US, &moved), "moved");
        let small = WallRecord { wall_minus_mesh_us: c.wall_minus_mesh_us + MOVE_US, ..c };
        assert!(!w.due(MIN_GAP_US, &small), "within the move threshold");
        let zone = WallRecord { zone: Zone::UTC, ..c };
        assert!(w.due(MIN_GAP_US, &zone), "zone changed");
        let src = WallRecord { source: 1, ..c };
        assert!(w.due(MIN_GAP_US, &src), "source changed");
        assert!(w.due(REFRESH_US, &c), "refresh");
        assert!(w.due(-1, &c), "the local clock went back past the send");
        assert_eq!(w.sent(REFRESH_US, 0x1001, c).gen, 2);
    }

    #[test]
    fn members_take_signed_records_and_an_originator_keeps_its_own() {
        let mut m = WallMesh::new();
        assert!(m.take(0, 0x2002, rec()));
        assert_eq!(m.rec, Some(rec()));
        assert!(!m.take(0, 0x1001, rec()), "its own, looped back");
        assert_eq!(m.err_now(10_000_000, 30), Some(4_000 + 400 + 30));
        let mut g = WallMesh::new();
        g.sent(0, 0x3003, rec());
        assert!(!g.take(1_000, 0x3003, rec()), "originating: another gateway's is ignored");
        assert_eq!(g.stats.ignored, 1);
        assert!(g.take(OWN_HOLD_US, 0x3003, rec()), "stopped originating long ago");
        g.clear();
        assert!(g.rec.is_none() && g.stats.taken == 1);
    }
}
