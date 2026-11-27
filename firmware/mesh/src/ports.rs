//! Splanc's mesh ports (design §5.3) and the dispatch policy in front of them.
//!
//! `swarm_net` delivers application packets (`port >= PORT_APP = 16`) with their origin.
//! [`Router::route`] decides what a packet is allowed to be before anything acts on it:
//!
//! - unknown and reserved ports (22..=31) are dropped and counted;
//! - **admin-class** ports (`CONTROL`, `MEMBERSHIP`, `SCENE`, `TIME_BASE`, `CLOCK`, §7.9) must carry a
//!   valid admin tag from an unlocked gateway ([`crate::admin`]), once per (origin, seq);
//!   a member without `K_admin` cannot verify them and drops them;
//! - guests (open mode, §7.4) only ever get the follow ports (`SCENE`, `TIME_BASE`), and the
//!   signatures those need are M7b's ([`Router::route`] refuses them until then);
//! - a `CONTROL` packet whose targets don't include this node is dropped after the tag check
//!   (§7.7: "members not in the group drop it");
//! - **envelope trust** (mesh M5): a closed mesh provisioned without an admin public key (the
//!   dev site key, owner desk #67) has no admin sessions to verify. There, admin-class packets
//!   framed for session [`SESSION_ENVELOPE`] (no per-receiver MACs) are accepted on the strength
//!   of the mesh envelope alone, i.e. from any member. A mesh that holds an admin key
//!   ([`RouteCtx::envelope_trust`] false) refuses that framing (M7's signed sessions only).
//!
//! Wire formats are Splanc's own, fixed-layout and big-endian (the protobuf `MeshControl`
//! of §5.3 / §8.1 arrives with the gateway arms in M5; the target header here is what that
//! message's `MeshTargets` lowers to).

use crate::admin::{Command, Sessions, Verdict};

/// The session id of an envelope-trust command (no grant, no per-receiver MACs; see the
/// module docs). Real sessions are never 0 (the app picks them at random, non-zero).
pub const SESSION_ENVELOPE: u32 = 0;
use crate::backhaul::NodeId;
use crate::groups::Groups;

/// The mesh ports. `PORT_APP` (16) and up are the application's in `swarm_net`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum Port {
    /// Relayed control to targets: `ControlHeader ‖ inner ClientMessage bytes`. Admin-class.
    Control = 16,
    /// A member's reply to the gateway (unicast): `op_id ‖ status ‖ small ServerMessage`.
    Reply = 17,
    /// Member status, and join requests forwarded to gateways ([`crate::msg::PendingJoin`]).
    Status = 18,
    /// Admit, groups, mode (§7). Admin-class.
    Membership = 19,
    /// Per-group scene generations (§5.6, M6). Admin-class.
    Scene = 20,
    /// The show epoch in mesh time (§6.3, M4). Admin-class.
    TimeBase = 21,
    /// Sessions and freshness: grants, acks, confirms, rekeys ([`crate::admin`],
    /// [`crate::rekey`]). Authenticated by signatures and pairwise MACs, not the shared key.
    Freshness = 22,
    /// Bulk transfers (effect blobs and catch-up, M6): lowest relay priority.
    Bulk = 23,
    /// The wall clock on mesh time ([`crate::wallclock::WallRecord`], RTC PR-8). Admin-class.
    /// (24 is taken by the live-update authenticator in the mesh-tesla stack, #551.)
    Clock = 25,
}

/// Ports reserved for Splanc (dropped until assigned; the assigned ones above match first).
pub const RESERVED: core::ops::RangeInclusive<u8> = 24..=31;

impl Port {
    pub const fn from_u8(p: u8) -> Option<Port> {
        Some(match p {
            16 => Port::Control,
            17 => Port::Reply,
            18 => Port::Status,
            19 => Port::Membership,
            20 => Port::Scene,
            21 => Port::TimeBase,
            22 => Port::Freshness,
            23 => Port::Bulk,
            25 => Port::Clock,
            _ => return None,
        })
    }

    /// Needs the admin session's per-receiver MAC (§7.9).
    pub const fn admin_class(self) -> bool {
        matches!(self, Port::Control | Port::Membership | Port::Scene | Port::TimeBase | Port::Clock)
    }

    /// A guest may follow it (§7.4).
    pub const fn guest_follows(self) -> bool {
        matches!(self, Port::Scene | Port::TimeBase)
    }

    /// `swarm_net`'s relay priority bitmap for these ports: control, membership, time and
    /// freshness are never starved by bulk (the drop policy evicts bulk first).
    pub const HIGH_PRIORITY: u32 = (1 << 16) | (1 << 19) | (1 << 20) | (1 << 21) | (1 << 22) | (1 << 25);
}

/// Who a `CONTROL` packet is for (§3.3, §7.7): everyone, a group, or up to 8 nodes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Targets {
    All,
    Group(u8),
    Nodes { ids: [NodeId; Targets::MAX_NODES], n: u8 },
}

impl Targets {
    pub const MAX_NODES: usize = 8;

    pub fn nodes(list: &[NodeId]) -> Option<Targets> {
        if list.is_empty() || list.len() > Self::MAX_NODES {
            return None;
        }
        let mut ids = [0; Self::MAX_NODES];
        ids[..list.len()].copy_from_slice(list);
        Some(Targets::Nodes { ids, n: list.len() as u8 })
    }

    pub fn includes(&self, me: NodeId, groups: &Groups) -> bool {
        match *self {
            Targets::All => true,
            Targets::Group(g) => groups.contains(g),
            Targets::Nodes { ids, n } => ids[..n as usize].contains(&me),
        }
    }

    /// `kind ‖ ...`: 0 = all; 1 = group (1 B); 2 = nodes (count, then ids).
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        match *self {
            Targets::All => {
                *out.first_mut()? = 0;
                Some(1)
            }
            Targets::Group(g) => {
                out.get_mut(..2)?.copy_from_slice(&[1, g]);
                Some(2)
            }
            Targets::Nodes { ids, n } => {
                let len = 2 + 2 * n as usize;
                let o = out.get_mut(..len)?;
                o[0] = 2;
                o[1] = n;
                for (i, id) in ids[..n as usize].iter().enumerate() {
                    o[2 + 2 * i..4 + 2 * i].copy_from_slice(&id.to_be_bytes());
                }
                Some(len)
            }
        }
    }

    pub fn decode(b: &[u8]) -> Option<(Targets, usize)> {
        match *b.first()? {
            0 => Some((Targets::All, 1)),
            1 => Some((Targets::Group(*b.get(1)?), 2)),
            2 => {
                let n = *b.get(1)? as usize;
                if n == 0 || n > Self::MAX_NODES {
                    return None;
                }
                let raw = b.get(2..2 + 2 * n)?;
                let mut ids = [0; Self::MAX_NODES];
                for i in 0..n {
                    ids[i] = u16::from_be_bytes([raw[2 * i], raw[2 * i + 1]]);
                }
                Some((Targets::Nodes { ids, n: n as u8 }, 2 + 2 * n))
            }
            _ => None,
        }
    }
}

/// The head of a `CONTROL` body: `op_id (4) ‖ flags (1) ‖ targets`, then the inner
/// ClientMessage bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ControlHeader {
    pub op_id: u32,
    /// [`ControlHeader::WANT_REPLY`]: each target answers on `REPLY` (M5 aggregation).
    pub flags: u8,
    pub targets: Targets,
}

impl ControlHeader {
    /// Targets answer with a [`crate::gateway::ReplyMsg`] (ACKed unicast to the origin).
    pub const WANT_REPLY: u8 = 1;

    pub fn new(op_id: u32, targets: Targets) -> ControlHeader {
        ControlHeader { op_id, flags: 0, targets }
    }

    pub fn want_reply(&self) -> bool {
        self.flags & Self::WANT_REPLY != 0
    }

    pub fn encode(&self, inner: &[u8], out: &mut [u8]) -> Option<usize> {
        out.get_mut(..4)?.copy_from_slice(&self.op_id.to_be_bytes());
        *out.get_mut(4)? = self.flags;
        let t = self.targets.encode(out.get_mut(5..)?)?;
        let n = 5 + t + inner.len();
        out.get_mut(5 + t..n)?.copy_from_slice(inner);
        Some(n)
    }

    /// The header and the inner bytes.
    pub fn decode(b: &[u8]) -> Option<(ControlHeader, &[u8])> {
        let op_id = u32::from_be_bytes(b.get(..4)?.try_into().ok()?);
        let flags = *b.get(4)?;
        let (targets, n) = Targets::decode(&b[5..])?;
        Some((ControlHeader { op_id, flags, targets }, &b[5 + n..]))
    }
}

/// Whose traffic this node is reading.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    /// Holds the mesh key: the authenticated mesh.
    Member,
    /// Follows an open mesh's stream under `K_open` (§7.4).
    Guest,
}

/// A packet that passed the policy.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Inbound<'a> {
    pub origin: NodeId,
    pub port: Port,
    /// The body (the session framing removed on admin-class ports).
    pub body: &'a [u8],
    /// It came from an admin session's gateway, MAC'd for this node.
    pub admin: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RouteReject {
    /// Not one of Splanc's ports (a swarm port, or the app range beyond ours).
    UnknownPort,
    /// 24..=31.
    Reserved,
    /// Admin-class and not framed as a session command.
    Malformed,
    /// Admin-class, for this node, but its session is unknown or not yet synced: the stack
    /// holds it and asks the gateway.
    Held { session: u32 },
    /// Admin-class and refused (bad MAC, stale, expired, wrong origin).
    Refused(crate::admin::CommandReject),
    /// A guest reading a port guests do not follow.
    GuestForbidden,
    /// Guest follow traffic needs the owner's signature (M7b).
    Unsigned,
    /// Not for this node (no MAC entry, or a `CONTROL` target that excludes it).
    NotTargeted,
    /// Envelope-trust framing ([`SESSION_ENVELOPE`]) on a mesh that holds an admin key.
    Untrusted,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct RouteStats {
    pub routed: u32,
    pub unknown_port: u32,
    pub reserved: u32,
    pub malformed: u32,
    pub held: u32,
    pub refused: u32,
    pub guest_forbidden: u32,
    pub unsigned: u32,
    pub not_targeted: u32,
    pub untrusted: u32,
    /// Admin-class packets accepted on envelope trust.
    pub envelope: u32,
}

/// What [`Router::route`] needs to know about this node.
#[derive(Clone, Copy, Debug)]
pub struct RouteCtx {
    pub mesh_id: u32,
    pub me: NodeId,
    pub role: Role,
    pub groups: Groups,
    /// Mesh seconds (grant expiry; §6, M4).
    pub mesh_time_s: u32,
    /// No admin key is provisioned (a dev closed mesh, desk #67): admin-class packets in the
    /// [`SESSION_ENVELOPE`] framing are accepted from any member (module docs).
    pub envelope_trust: bool,
}

#[derive(Default)]
pub struct Router {
    pub stats: RouteStats,
}

impl Router {
    pub const fn new() -> Router {
        Router {
            stats: RouteStats {
                routed: 0,
                unknown_port: 0,
                reserved: 0,
                malformed: 0,
                held: 0,
                refused: 0,
                guest_forbidden: 0,
                unsigned: 0,
                not_targeted: 0,
                untrusted: 0,
                envelope: 0,
            },
        }
    }

    /// Apply the policy to one delivered packet.
    pub fn route<'a>(&mut self, ctx: &RouteCtx, sessions: &mut Sessions, origin: NodeId, port: u8, payload: &'a [u8]) -> Result<Inbound<'a>, RouteReject> {
        let r = Self::route_inner(ctx, sessions, origin, port, payload);
        let s = &mut self.stats;
        match r {
            Ok(_) => s.routed += 1,
            Err(RouteReject::UnknownPort) => s.unknown_port += 1,
            Err(RouteReject::Reserved) => s.reserved += 1,
            Err(RouteReject::Malformed) => s.malformed += 1,
            Err(RouteReject::Held { .. }) => s.held += 1,
            Err(RouteReject::Refused(_)) => s.refused += 1,
            Err(RouteReject::GuestForbidden) => s.guest_forbidden += 1,
            Err(RouteReject::Unsigned) => s.unsigned += 1,
            Err(RouteReject::NotTargeted) => s.not_targeted += 1,
            Err(RouteReject::Untrusted) => s.untrusted += 1,
        }
        if let Ok(Inbound { admin: false, port, .. }) = r {
            if port.admin_class() {
                s.envelope += 1;
            }
        }
        r
    }

    fn route_inner<'a>(ctx: &RouteCtx, sessions: &mut Sessions, origin: NodeId, port: u8, payload: &'a [u8]) -> Result<Inbound<'a>, RouteReject> {
        let p = match Port::from_u8(port) {
            Some(p) => p,
            None if RESERVED.contains(&port) => return Err(RouteReject::Reserved),
            None => return Err(RouteReject::UnknownPort),
        };
        if ctx.role == Role::Guest {
            if !p.guest_follows() {
                return Err(RouteReject::GuestForbidden);
            }
            // TODO(M7b): verify the owner's ECDSA signature on scene commits, blob ids and
            // TIME_BASE generations (§7.4), and accept bounded live moves for the signed
            // scene. Until then a guest acts on nothing.
            return Err(RouteReject::Unsigned);
        }
        if !p.admin_class() {
            return Ok(Inbound { origin, port: p, body: payload, admin: false });
        }
        let c = Command::parse(payload).ok_or(RouteReject::Malformed)?;
        // Envelope trust: the mesh key vouches for the sender being a member, nothing more.
        let signed = if c.session == SESSION_ENVELOPE {
            if !ctx.envelope_trust {
                return Err(RouteReject::Untrusted);
            }
            false
        } else {
            match sessions.check(&c, origin, port, ctx.mesh_id, ctx.me, ctx.mesh_time_s) {
                Verdict::Accept => {}
                Verdict::NotForMe => return Err(RouteReject::NotTargeted),
                Verdict::Hold { session } => return Err(RouteReject::Held { session }),
                Verdict::Reject(r) => return Err(RouteReject::Refused(r)),
            }
            true
        };
        if p == Port::Control {
            let (h, _) = ControlHeader::decode(c.body).ok_or(RouteReject::Malformed)?;
            if !h.targets.includes(ctx.me, &ctx.groups) {
                return Err(RouteReject::NotTargeted);
            }
        }
        Ok(Inbound { origin, port: p, body: c.body, admin: signed })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::admin::{seal_command, CommandReject, GatewaySession};
    use crate::crypto::DeviceKey;
    use crate::host_keys::{AdminSigner, HostKey, TestRng};
    use crate::rekey::Revocations;

    const MESH: u32 = 0xA1B2_C3D4;

    fn ctx(me: NodeId, groups: &[u8]) -> RouteCtx {
        RouteCtx { mesh_id: MESH, me, role: Role::Member, groups: Groups::from_slice(groups), mesh_time_s: 0, envelope_trust: false }
    }

    /// A member (id 5, key seed 5) with a synced session 7 from gateway 1.
    fn session() -> (Sessions, [u8; 16]) {
        let admin = AdminSigner::from_secret(b"0123456789abcdef", MESH);
        let gw = HostKey::from_seed(1);
        let g = admin.grant(MESH, 7, 1, gw.public_key(), 1000);
        let mut gs = GatewaySession::<4>::new(g, None);
        let mut s = Sessions::new();
        let ack = s.on_grant(0, 0, &g, Some(&admin.public()), &Revocations::default(), MESH, 5, &HostKey::from_seed(5), &mut TestRng(3)).unwrap().unwrap();
        let (_, conf) = gs.on_ack(&ack, &gw, MESH, 1, 100).unwrap();
        s.on_confirm(1, &conf, 5);
        (s, gs.entry(5).unwrap().key)
    }

    fn control(k: &[u8; 16], seq: u64, t: Targets, inner: &[u8]) -> Vec<u8> {
        let mut body = [0u8; 64];
        let n = ControlHeader::new(9, t).encode(inner, &mut body).unwrap();
        let mut out = [0u8; 128];
        let m = seal_command(MESH, 7, seq, Port::Control as u8, &body[..n], &[(5, *k)], &mut out).unwrap();
        out[..m].to_vec()
    }

    #[test]
    fn port_table() {
        for p in 16..=23 {
            assert_eq!(Port::from_u8(p).map(|x| x as u8), Some(p));
        }
        assert_eq!(Port::from_u8(24), None);
        let admin: Vec<_> = (16..=23).filter(|&p| Port::from_u8(p).unwrap().admin_class()).collect();
        assert_eq!(admin, [16, 19, 20, 21]);
    }

    #[test]
    fn targets_roundtrip_and_match() {
        let g = Groups::from_slice(&[3, 7]);
        for (t, me, hit) in [
            (Targets::All, 5, true),
            (Targets::Group(7), 5, true),
            (Targets::Group(4), 5, false),
            (Targets::nodes(&[1, 5, 9]).unwrap(), 5, true),
            (Targets::nodes(&[1, 9]).unwrap(), 5, false),
        ] {
            let mut b = [0u8; 32];
            let n = t.encode(&mut b).unwrap();
            assert_eq!(Targets::decode(&b[..n]), Some((t, n)));
            assert_eq!(t.includes(me, &g), hit, "{t:?}");
        }
        assert!(Targets::nodes(&[0; 9]).is_none());
        assert!(Targets::decode(&[2, 9]).is_none());
    }

    #[test]
    fn control_needs_a_session_mac_once_and_a_matching_target() {
        let (mut s, k) = session();
        let mut r = Router::new();
        let c = ctx(5, &[2]);
        let p = control(&k, 200, Targets::All, b"set_uniforms");
        let got = r.route(&c, &mut s, 1, 16, &p).unwrap();
        assert!(got.admin);
        let (h, inner) = ControlHeader::decode(got.body).unwrap();
        assert_eq!((h.op_id, inner), (9, &b"set_uniforms"[..]));
        assert_eq!(r.route(&c, &mut s, 1, 16, &p), Err(RouteReject::Refused(CommandReject::Stale)));
        let mut bad = p.clone();
        *bad.last_mut().unwrap() ^= 1;
        assert_eq!(r.route(&c, &mut s, 1, 16, &bad), Err(RouteReject::Refused(CommandReject::BadMac)));
        // From another origin than the session's gateway.
        assert_eq!(r.route(&c, &mut s, 4, 16, &control(&k, 201, Targets::All, b"x")), Err(RouteReject::Refused(CommandReject::WrongOrigin)));
        assert_eq!(r.route(&c, &mut s, 1, 16, &control(&k, 202, Targets::Group(3), b"x")), Err(RouteReject::NotTargeted));
        assert!(r.route(&c, &mut s, 1, 16, &control(&k, 203, Targets::Group(2), b"x")).is_ok());
        // Untagged (the old group-key-only framing an insider could send).
        assert_eq!(r.route(&c, &mut s, 1, 16, b"\0\0\0\x09\0set"), Err(RouteReject::Malformed));
        // An unknown session is held.
        let mut fresh = Sessions::new();
        assert_eq!(r.route(&c, &mut fresh, 1, 16, &control(&k, 204, Targets::All, b"x")), Err(RouteReject::Held { session: 7 }));
    }

    #[test]
    fn envelope_trust_only_without_an_admin_key() {
        let mut body = [0u8; 64];
        let h = ControlHeader { op_id: 3, flags: ControlHeader::WANT_REPLY, targets: Targets::nodes(&[5, 6]).unwrap() };
        let n = h.encode(b"inner", &mut body).unwrap();
        assert_eq!(ControlHeader::decode(&body[..n]), Some((h, &b"inner"[..])));
        let mut p = [0u8; 96];
        let m = seal_command(MESH, SESSION_ENVELOPE, 1, Port::Control as u8, &body[..n], &[], &mut p).unwrap();
        let mut r = Router::new();
        let mut s = Sessions::new();
        // A mesh with an admin key refuses it, from anyone.
        assert_eq!(r.route(&ctx(5, &[]), &mut s, 1, 16, &p[..m]), Err(RouteReject::Untrusted));
        // A dev mesh (no admin key) takes it from any member, for its targets only.
        let dev = RouteCtx { envelope_trust: true, ..ctx(5, &[]) };
        let got = r.route(&dev, &mut s, 4, 16, &p[..m]).unwrap();
        assert!(!got.admin);
        assert_eq!(ControlHeader::decode(got.body).unwrap().1, b"inner");
        let other = RouteCtx { envelope_trust: true, ..ctx(7, &[]) };
        assert_eq!(r.route(&other, &mut s, 4, 16, &p[..m]), Err(RouteReject::NotTargeted));
        assert_eq!((r.stats.untrusted, r.stats.envelope, r.stats.not_targeted), (1, 1, 1));
    }

    #[test]
    fn non_admin_ports_reserved_and_unknown() {
        let mut r = Router::new();
        let mut s = Sessions::new();
        let c = ctx(5, &[]);
        assert_eq!(r.route(&c, &mut s, 1, 17, b"reply").unwrap(), Inbound { origin: 1, port: Port::Reply, body: b"reply", admin: false });
        assert!(r.route(&c, &mut s, 1, 22, b"fresh").is_ok());
        assert_eq!(r.route(&c, &mut s, 1, 26, b"x"), Err(RouteReject::Reserved));
        assert_eq!(r.route(&c, &mut s, 1, 40, b"x"), Err(RouteReject::UnknownPort));
        // The wall clock (RTC PR-8) is admin-class: a bare body is not a command.
        assert!(Port::Clock.admin_class() && !Port::Clock.guest_follows());
        assert_eq!(Port::from_u8(25), Some(Port::Clock));
        assert_eq!(r.route(&c, &mut s, 1, 25, b"x"), Err(RouteReject::Malformed));
    }

    #[test]
    fn guests_follow_only_and_only_signed() {
        let mut r = Router::new();
        let mut s = Sessions::new();
        let c = RouteCtx { role: Role::Guest, ..ctx(5, &[]) };
        assert_eq!(r.route(&c, &mut s, 1, 16, b"x"), Err(RouteReject::GuestForbidden));
        assert_eq!(r.route(&c, &mut s, 1, 20, b"scene"), Err(RouteReject::Unsigned));
    }
}
