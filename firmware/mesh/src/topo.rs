//! Mesh topology (the app's mesh map, and later effects' `peer_pos` / `nearest_peer`): each
//! member's room pose and its radio neighbours, gossiped on the `STATUS` port next to
//! [`crate::gateway::StatusMsg`].
//!
//! A [`TopoMsg`] is its own message (tag [`T_TOPO`]), not a tail on the 27-byte status: an
//! older member decodes the status by its exact length and would drop a longer one, and it
//! hands an unknown tag to the firmware as a plain packet, which ignores it. So a mesh of
//! mixed firmware keeps its health reports, and the old members simply have no topology.
//!
//! It is broadcast (flooded) like the status, so **every** member, not only the gateway, keeps
//! every other member's latest [`Topo`] in its [`crate::gateway::Fanout`]: a member reads its
//! peers' poses locally ([`crate::MeshStack::peer_topo`]).
//!
//! Cadence and airtime: the neighbours go out every [`TOPO_EVERY_US`] (with the status
//! period), the pose only when it changed or every [`POSE_EVERY_US`]: at most 4 + 29 + 32 = 65
//! bytes, usually 36 (no pose, 8 neighbours).
//!
//! Wire (big-endian like the rest of the layer):
//!
//! ```text
//! 0      T_TOPO
//! 1      bits 0-1 pose kind: 0 not in this message, 1 unposed, 2 posed, 3 posed + rotation
//!        bits 2-7 reserved (0)
//! 2      pose generation (u8; moves on every pose change)
//! 3      n neighbours (<= NEIGHBOURS)
//! [pose] translation x, y, z: i16 cm each (+-327 m)
//! [rot]  quaternion x, y, z: i16 x 32767 each (w >= 0, rebuilt from the unit norm)
//! [pose] room length (<= ROOM_MAX), room bytes (UTF-8, cut on a character boundary)
//! n x    node u16, RSSI i8 (dBm), unicast delivery u8 (0..=100 %, 255 = no unicasts yet)
//! ```
//!
//! Decoders accept trailing bytes (later additions append).

use crate::backhaul::NodeId;

pub const T_TOPO: u8 = 0x24;
/// Neighbours a member reports (and every member keeps per peer).
pub const NEIGHBOURS: usize = 8;
/// Room name bytes carried (a longer name is cut).
pub const ROOM_MAX: usize = 16;
/// Largest encoded [`TopoMsg`].
pub const TOPO_MAX: usize = 4 + 6 + 6 + 1 + ROOM_MAX + NEIGHBOURS * 4;
/// Neighbours are re-sent this often (the status period).
pub const TOPO_EVERY_US: i64 = 10_000_000;
/// The pose is re-sent at least this often (and as soon as it changes).
pub const POSE_EVERY_US: i64 = 60_000_000;
/// Unicast delivery not measured (no unicasts to that neighbour yet).
pub const TX_UNKNOWN: u8 = 255;

const KIND_NONE: u8 = 0;
const KIND_UNPOSED: u8 = 1;
const KIND_POSED: u8 = 2;
const KIND_POSED_ROT: u8 = 3;

/// A room pose, compact: translation in cm, the rotation's x, y, z (w >= 0) x 32767, and the
/// room name.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PoseC {
    pub t_cm: [i16; 3],
    /// `None`: identity (the fixture's map axes are the room's).
    pub q: Option<[i16; 3]>,
    pub room: [u8; ROOM_MAX],
    pub room_len: u8,
}

impl PoseC {
    /// From the player's pose: translation in metres, a quaternion (x, y, z, w; normalised
    /// here, identity when `None`), and the room name (cut to [`ROOM_MAX`] bytes on a UTF-8
    /// character boundary).
    pub fn from_pose(t_m: [f32; 3], q: Option<[f32; 4]>, room: &[u8]) -> PoseC {
        let cm = |v: f32| {
            let x = v * 100.0;
            // Saturating, and rounded half away from zero (no f32::round in no_std).
            let x = if x >= 0.0 { x + 0.5 } else { x - 0.5 };
            x.clamp(i16::MIN as f32, i16::MAX as f32) as i16
        };
        let q = q.and_then(|[x, y, z, w]| {
            let n2 = x * x + y * y + z * z + w * w;
            if !(n2 > 1e-12) || !n2.is_finite() {
                return None;
            }
            let n = sqrt(n2);
            let s = if w < 0.0 { -1.0 / n } else { 1.0 / n };
            let c = |v: f32| {
                let x = v * s * 32767.0;
                let x = if x >= 0.0 { x + 0.5 } else { x - 0.5 };
                x.clamp(-32767.0, 32767.0) as i16
            };
            let r = [c(x), c(y), c(z)];
            // Identity: say nothing (saves 6 bytes).
            if r == [0, 0, 0] {
                None
            } else {
                Some(r)
            }
        });
        let mut n = room.len().min(ROOM_MAX);
        while n > 0 && n < room.len() && (room[n] & 0xc0) == 0x80 {
            n -= 1; // never split a UTF-8 sequence
        }
        let mut r = [0u8; ROOM_MAX];
        r[..n].copy_from_slice(&room[..n]);
        PoseC { t_cm: [cm(t_m[0]), cm(t_m[1]), cm(t_m[2])], q, room: r, room_len: n as u8 }
    }

    /// Translation in metres.
    pub fn t_m(&self) -> [f32; 3] {
        [self.t_cm[0] as f32 / 100.0, self.t_cm[1] as f32 / 100.0, self.t_cm[2] as f32 / 100.0]
    }

    /// The unit quaternion (x, y, z, w).
    pub fn quat(&self) -> [f32; 4] {
        match self.q {
            None => [0.0, 0.0, 0.0, 1.0],
            Some([x, y, z]) => {
                let (x, y, z) = (x as f32 / 32767.0, y as f32 / 32767.0, z as f32 / 32767.0);
                let w2 = 1.0 - x * x - y * y - z * z;
                [x, y, z, if w2 > 0.0 { sqrt(w2) } else { 0.0 }]
            }
        }
    }

    pub fn room(&self) -> &[u8] {
        &self.room[..self.room_len as usize]
    }
}

/// What a member knows of a peer's pose.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PoseKnown {
    /// No topology message with a pose heard yet.
    #[default]
    Unknown,
    /// The peer has no room pose.
    Unposed,
    Posed(PoseC),
}

/// One radio neighbour as a member reports it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Link {
    pub node: NodeId,
    /// Running average, dBm.
    pub rssi: i8,
    /// Unicasts to it delivered (ACKed), 0..=100 %; [`TX_UNKNOWN`] before the first.
    pub tx_pct: u8,
}

impl Link {
    pub const EMPTY: Link = Link { node: 0, rssi: 0, tx_pct: TX_UNKNOWN };

    /// From a backhaul's unicast counters.
    pub fn tx_pct_of(ok: u32, fail: u32) -> u8 {
        let n = ok as u64 + fail as u64;
        if n == 0 {
            TX_UNKNOWN
        } else {
            ((ok as u64 * 100 + n / 2) / n) as u8
        }
    }
}

/// One topology message.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TopoMsg {
    /// The pose, or `Unknown` when this message does not carry it (only the neighbours).
    pub pose: PoseKnown,
    pub pose_gen: u8,
    pub n: u8,
    pub links: [Link; NEIGHBOURS],
}

impl Default for TopoMsg {
    fn default() -> Self {
        TopoMsg { pose: PoseKnown::Unknown, pose_gen: 0, n: 0, links: [Link::EMPTY; NEIGHBOURS] }
    }
}

impl TopoMsg {
    pub fn links(&self) -> &[Link] {
        &self.links[..(self.n as usize).min(NEIGHBOURS)]
    }

    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let mut w = 0usize;
        let mut put = |out: &mut [u8], b: &[u8]| -> Option<()> {
            out.get_mut(w..w + b.len())?.copy_from_slice(b);
            w += b.len();
            Some(())
        };
        let kind = match self.pose {
            PoseKnown::Unknown => KIND_NONE,
            PoseKnown::Unposed => KIND_UNPOSED,
            PoseKnown::Posed(p) if p.q.is_some() => KIND_POSED_ROT,
            PoseKnown::Posed(_) => KIND_POSED,
        };
        let n = (self.n as usize).min(NEIGHBOURS);
        put(out, &[T_TOPO, kind, self.pose_gen, n as u8])?;
        if let PoseKnown::Posed(p) = self.pose {
            for v in p.t_cm {
                put(out, &v.to_be_bytes())?;
            }
            if let Some(q) = p.q {
                for v in q {
                    put(out, &v.to_be_bytes())?;
                }
            }
            let rl = (p.room_len as usize).min(ROOM_MAX);
            put(out, &[rl as u8])?;
            put(out, &p.room[..rl])?;
        }
        for l in &self.links[..n] {
            let id = l.node.to_be_bytes();
            put(out, &[id[0], id[1], l.rssi as u8, l.tx_pct])?;
        }
        Some(w)
    }

    pub fn decode(b: &[u8]) -> Option<TopoMsg> {
        if b.len() < 4 || b[0] != T_TOPO {
            return None;
        }
        let kind = b[1] & 3;
        let n = b[3] as usize;
        if n > NEIGHBOURS {
            return None;
        }
        let mut o = 4usize;
        let i16_at = |o: &mut usize| -> Option<i16> {
            let v = i16::from_be_bytes([*b.get(*o)?, *b.get(*o + 1)?]);
            *o += 2;
            Some(v)
        };
        let pose = match kind {
            KIND_NONE => PoseKnown::Unknown,
            KIND_UNPOSED => PoseKnown::Unposed,
            _ => {
                let t_cm = [i16_at(&mut o)?, i16_at(&mut o)?, i16_at(&mut o)?];
                let q = if kind == KIND_POSED_ROT { Some([i16_at(&mut o)?, i16_at(&mut o)?, i16_at(&mut o)?]) } else { None };
                let rl = *b.get(o)? as usize;
                o += 1;
                if rl > ROOM_MAX {
                    return None;
                }
                let mut room = [0u8; ROOM_MAX];
                room[..rl].copy_from_slice(b.get(o..o + rl)?);
                o += rl;
                PoseKnown::Posed(PoseC { t_cm, q, room, room_len: rl as u8 })
            }
        };
        let mut links = [Link::EMPTY; NEIGHBOURS];
        for l in links.iter_mut().take(n) {
            let e = b.get(o..o + 4)?;
            *l = Link { node: u16::from_be_bytes([e[0], e[1]]), rssi: e[2] as i8, tx_pct: e[3] };
            o += 4;
        }
        Some(TopoMsg { pose, pose_gen: b[2], n: n as u8, links })
    }
}

/// A peer's topology as a member keeps it ([`crate::gateway::Member::topo`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Topo {
    pub pose: PoseKnown,
    /// The generation of `pose`, and the latest one the peer announced (they differ until a
    /// message with the new pose arrives).
    pub pose_gen: u8,
    pub pose_gen_seen: u8,
    /// Hops its last status-port message took to reach this node (1 = a direct neighbour;
    /// 0 = nothing heard on the status port yet).
    pub hops: u8,
    pub n: u8,
    pub links: [Link; NEIGHBOURS],
    /// When the last topology message came (0 = never).
    pub topo_us: i64,
}

impl Topo {
    pub const EMPTY: Topo = Topo { pose: PoseKnown::Unknown, pose_gen: 0, pose_gen_seen: 0, hops: 0, n: 0, links: [Link::EMPTY; NEIGHBOURS], topo_us: 0 };

    pub fn links(&self) -> &[Link] {
        &self.links[..(self.n as usize).min(NEIGHBOURS)]
    }

    /// Take a topology message (the neighbours always; the pose when it carries one).
    pub fn apply(&mut self, now_us: i64, m: &TopoMsg) {
        self.n = m.n.min(NEIGHBOURS as u8);
        self.links = m.links;
        self.pose_gen_seen = m.pose_gen;
        if m.pose != PoseKnown::Unknown {
            self.pose = m.pose;
            self.pose_gen = m.pose_gen;
        }
        self.topo_us = now_us.max(1);
    }

    /// The pose is the latest the peer announced (not one generation behind).
    pub fn pose_current(&self) -> bool {
        self.pose != PoseKnown::Unknown && self.pose_gen == self.pose_gen_seen
    }
}

impl Default for Topo {
    fn default() -> Self {
        Topo::EMPTY
    }
}

/// This node's own topology, and when to send it ([`crate::MeshStack`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TopoLocal {
    /// `Unknown` until the firmware reports a pose (then the topology starts going out).
    pub pose: PoseKnown,
    pub pose_gen: u8,
    /// The generation last sent with its pose, and when.
    pub sent_gen: Option<u8>,
    pub pose_sent_us: i64,
    pub next_us: Option<i64>,
}

impl TopoLocal {
    pub const fn new() -> TopoLocal {
        TopoLocal { pose: PoseKnown::Unknown, pose_gen: 0, sent_gen: None, pose_sent_us: 0, next_us: None }
    }

    /// The firmware's pose; returns true when it changed (the generation moves).
    pub fn set_pose(&mut self, p: PoseKnown) -> bool {
        if p == self.pose {
            return false;
        }
        self.pose = p;
        self.pose_gen = self.pose_gen.wrapping_add(1);
        true
    }

    /// Due now (the period ran out, or the pose changed since it was last sent)?
    pub fn due(&self, now_us: i64) -> bool {
        self.pose != PoseKnown::Unknown && (self.next_us.is_none_or(|t| now_us >= t) || self.sent_gen != Some(self.pose_gen))
    }

    /// Whether the next message carries the pose.
    pub fn with_pose(&self, now_us: i64) -> bool {
        self.sent_gen != Some(self.pose_gen) || now_us - self.pose_sent_us >= POSE_EVERY_US
    }

    /// The message to send now (the neighbours are the caller's).
    pub fn message(&self, now_us: i64, links: &[Link]) -> TopoMsg {
        let mut m = TopoMsg { pose: if self.with_pose(now_us) { self.pose } else { PoseKnown::Unknown }, pose_gen: self.pose_gen, ..TopoMsg::default() };
        let n = links.len().min(NEIGHBOURS);
        m.links[..n].copy_from_slice(&links[..n]);
        m.n = n as u8;
        m
    }

    /// `m` went out at `now_us`; the next one is due `period_us` later.
    pub fn sent(&mut self, now_us: i64, m: &TopoMsg, period_us: i64) {
        if m.pose != PoseKnown::Unknown {
            self.sent_gen = Some(m.pose_gen);
            self.pose_sent_us = now_us;
        }
        self.next_us = Some(now_us + period_us);
    }
}

impl Default for TopoLocal {
    fn default() -> Self {
        TopoLocal::new()
    }
}

/// Newton's square root (no_std has no f32::sqrt); exact enough for unit quaternions.
fn sqrt(x: f32) -> f32 {
    if !(x > 0.0) {
        return 0.0;
    }
    let mut r = if x > 1.0 { x } else { 1.0 };
    for _ in 0..20 {
        r = 0.5 * (r + x / r);
    }
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    fn links(n: usize) -> [Link; NEIGHBOURS] {
        let mut l = [Link::EMPTY; NEIGHBOURS];
        for (i, x) in l.iter_mut().enumerate().take(n) {
            *x = Link { node: 0x1100 + i as u16, rssi: -40 - i as i8, tx_pct: if i == 0 { TX_UNKNOWN } else { 90 + i as u8 } };
        }
        l
    }

    #[test]
    fn round_trips_every_pose_kind() {
        let posed = PoseC::from_pose([1.234, -0.5, 2.0], Some([0.0, 0.7071068, 0.0, 0.7071068]), b"Living room");
        for pose in [PoseKnown::Unknown, PoseKnown::Unposed, PoseKnown::Posed(posed), PoseKnown::Posed(PoseC { q: None, ..posed })] {
            for n in [0, 3, NEIGHBOURS] {
                let m = TopoMsg { pose, pose_gen: 7, n: n as u8, links: links(n) };
                let mut b = [0u8; TOPO_MAX];
                let len = m.encode(&mut b).unwrap();
                let d = TopoMsg::decode(&b[..len]).unwrap();
                assert_eq!(d, m, "{pose:?} n={n}");
                // Trailing bytes (a later version's additions) are fine; truncation is not.
                let mut longer = b;
                assert_eq!(TopoMsg::decode(&longer[..(len + 1).min(TOPO_MAX)]).map(|x| x.n), Some(n as u8));
                longer[0] = 0x23;
                assert!(TopoMsg::decode(&longer[..len]).is_none(), "not a status");
                if len > 4 {
                    assert!(TopoMsg::decode(&b[..len - 1]).is_none());
                }
            }
        }
    }

    #[test]
    fn sizes_stay_small() {
        let full = PoseC::from_pose([1.0, 2.0, 3.0], Some([0.1, 0.2, 0.3, 0.9]), b"A room with a very long name");
        let m = TopoMsg { pose: PoseKnown::Posed(full), pose_gen: 1, n: NEIGHBOURS as u8, links: links(NEIGHBOURS) };
        let mut b = [0u8; 128];
        assert_eq!(m.encode(&mut b), Some(TOPO_MAX));
        assert_eq!(TOPO_MAX, 65);
        let lean = TopoMsg { pose: PoseKnown::Unknown, ..m };
        assert_eq!(lean.encode(&mut b), Some(36));
        assert_eq!(m.encode(&mut [0u8; 64]), None, "too small: nothing");
    }

    #[test]
    fn pose_quantises_and_cuts_names() {
        let p = PoseC::from_pose([1.234, -0.005, 400.0], Some([0.0, 0.0, 0.0, -2.0]), "Küche".as_bytes());
        assert_eq!(p.t_cm, [123, -1, i16::MAX]);
        assert_eq!(p.q, None, "identity (w<0 flipped, normalised)");
        assert_eq!(p.room(), "Küche".as_bytes());
        // A half-turn about y, given with w < 0 and not normalised.
        let p = PoseC::from_pose([0.0; 3], Some([0.0, -2.0, 0.0, -0.0001]), b"");
        let q = p.quat();
        assert!((q[1].abs() - 1.0).abs() < 1e-3 && q[3] >= 0.0, "{q:?}");
        let p = PoseC::from_pose([0.0; 3], Some([0.0, 0.3826834, 0.0, 0.9238795]), b"");
        let q = p.quat();
        assert!((q[1] - 0.3826834).abs() < 1e-4 && (q[3] - 0.9238795).abs() < 1e-4, "{q:?}");
        // 17 bytes with a 2-byte character across the 16-byte cut: cut before it.
        let name = "abcdefghijklmnoé".as_bytes();
        assert_eq!(name.len(), 17);
        assert_eq!(PoseC::from_pose([0.0; 3], None, name).room(), b"abcdefghijklmno");
        assert_eq!(PoseC::from_pose([0.0; 3], Some([f32::NAN, 0.0, 0.0, 1.0]), b"").q, None);
    }

    #[test]
    fn tx_rate() {
        assert_eq!(Link::tx_pct_of(0, 0), TX_UNKNOWN);
        assert_eq!(Link::tx_pct_of(9, 1), 90);
        assert_eq!(Link::tx_pct_of(2, 1), 67);
        assert_eq!(Link::tx_pct_of(0, 5), 0);
        assert_eq!(Link::tx_pct_of(u32::MAX, 0), 100);
    }

    #[test]
    fn local_cadence_sends_the_pose_on_change_and_every_minute() {
        let mut t = TopoLocal::new();
        assert!(!t.due(0), "nothing until the firmware reports a pose");
        assert!(t.set_pose(PoseKnown::Unposed));
        assert!(!t.set_pose(PoseKnown::Unposed), "same pose: no new generation");
        assert!(t.due(0) && t.with_pose(0));
        let m = t.message(0, &links(2)[..2]);
        assert_eq!((m.pose, m.n), (PoseKnown::Unposed, 2));
        t.sent(0, &m, TOPO_EVERY_US);
        assert!(!t.due(1_000_000));
        assert!(t.due(TOPO_EVERY_US));
        let m = t.message(TOPO_EVERY_US, &[]);
        assert_eq!(m.pose, PoseKnown::Unknown, "neighbours only");
        t.sent(TOPO_EVERY_US, &m, TOPO_EVERY_US);
        // A new pose: due at once, with the pose.
        let p = PoseKnown::Posed(PoseC::from_pose([1.0, 0.0, 0.0], None, b"Hall"));
        assert!(t.set_pose(p));
        assert!(t.due(TOPO_EVERY_US + 1));
        assert_eq!(t.message(TOPO_EVERY_US + 1, &[]).pose, p);
        t.sent(TOPO_EVERY_US + 1, &t.message(TOPO_EVERY_US + 1, &[]), TOPO_EVERY_US);
        // ... and again after POSE_EVERY_US even without a change.
        assert_eq!(t.message(TOPO_EVERY_US * 2, &[]).pose, PoseKnown::Unknown);
        assert_eq!(t.message(TOPO_EVERY_US + 1 + POSE_EVERY_US, &[]).pose, p);
    }

    #[test]
    fn a_peer_keeps_its_last_pose_and_knows_when_it_is_stale() {
        let mut peer = Topo::EMPTY;
        let p = PoseKnown::Posed(PoseC::from_pose([0.5, 1.0, 0.0], None, b"Hall"));
        peer.apply(10, &TopoMsg { pose: p, pose_gen: 3, n: 1, links: links(1) });
        assert!(peer.pose_current() && peer.links().len() == 1);
        // Neighbours only, same generation: still current.
        peer.apply(20, &TopoMsg { pose: PoseKnown::Unknown, pose_gen: 3, n: 2, links: links(2) });
        assert!(peer.pose_current() && peer.links().len() == 2 && peer.pose == p);
        // A newer generation announced without the pose: kept, but stale.
        peer.apply(30, &TopoMsg { pose: PoseKnown::Unknown, pose_gen: 4, n: 0, links: links(0) });
        assert!(!peer.pose_current() && peer.pose == p && peer.topo_us == 30);
    }
}
