//! The mesh gateway on the netstack player (docs/design/mesh.md §8, mesh M5): the app arms
//! `mesh_send` / `get_mesh` and the member side of relayed control, for the C++ transport
//! (mesh_glue.h, main.cpp). A submodule of mesh_ffi.rs: everything lives in its heap block.
//!
//! **Gateway.** `mesh_send` and `get_mesh` reach [`ns_mesh_app`] after the kiosk gate, from
//! the wss or BLE connection they arrived on (`conn`: the kiosk source, 0 wss, 1 BLE). On a
//! mesh with no admin key (the dev site key, desk #67) the first of them opens the gateway's
//! admin session for that connection (`MeshStack::open_gateway`); it lasts until that
//! connection drops ([`ns_mesh_conn_closed`]). The session is what may start a show epoch
//! (desk #79: `MeshStack::originate_epoch`) and relay control. `inner` is checked against the
//! relay allow-list (`splanc_mesh::gateway`), scheduled on the show clock when the app asks
//! (`lead_ms`), flooded once (the backhaul fans it out as ACKed unicasts, desk #70), and, unless
//! `skip_gateway`, handed back to the C++ to dispatch here too, so the app's direct reply is
//! exactly what it would get without the mesh. With `want_reply` the members' answers are
//! collected (`Fanout`) and the `MeshResult` is pushed when they are in ([`ns_mesh_take_result`]).
//!
//! **Member.** Relayed control arrives as `Event::Control` during the tick. Anything off the
//! allow-list is refused at once (logged, answered `REFUSED` when the gateway wants replies);
//! the rest waits in a two-slot inbox until the transport, back on loopTask's stack, takes it
//! ([`ns_mesh_take_control`]), dispatches it like an app message (main.cpp
//! `lm_mesh_member_dispatch`) and reports the outcome ([`ns_mesh_control_done`]).
//!
//! Replies are hand-encoded protobuf (`ServerMessage.mesh`, ledmapper.proto): the player
//! core's by-value structs never carry them (shared/protocol/rust gen_main.rs skips them in
//! the firmware profile).

use splanc_mesh::admin::{Delegation, SessionMsg, UnlockError};
use splanc_mesh::crypto::{ct_eq, DeviceKey};
use splanc_mesh::gateway::{self, client_arm, relay_arm, with_apply_at, OpResult, ReplyMsg, Status, StatusMsg};
use splanc_mesh::membership::{Credentials, Groups, Mode, Phase, ProvisionSource};
use splanc_mesh::meshtime::SyncState;
use splanc_mesh::msg::PendingJoin;
use splanc_mesh::ports::Targets;
use splanc_mesh::rekey::RekeyOrder;
use splanc_mesh::stack::{EpochSource, Event, SendError, REPLY_TIMEOUT_US};
use splanc_mesh::topo::{self, Link, PoseC, PoseKnown, RangeC, Topo, TX_UNKNOWN};
use splanc_mesh::NodeId;

use crate::{Mesh, P};

/// Relayed controls waiting for the transport (a member).
pub const INBOX: usize = 2;
/// The console's pseudo-connection (`MESH CTL`, dev image).
pub const CONSOLE_CONN: usize = 7;
/// The transport's scratch in the block ([`ns_mesh_xfer`]).
pub const XFER: usize = 512;
/// How often the transport hands over the status inputs ([`ns_mesh_status_due`]).
const STATUS_INPUT_US: i64 = 1_000_000;

/// One relayed control waiting to be dispatched.
#[derive(Clone, Copy)]
pub struct InCtl {
    pub origin: NodeId,
    pub op_id: u32,
    pub want_reply: bool,
    pub len: u8,
    pub buf: [u8; P],
}

/// The gateway's and the member's state in the mesh block.
pub struct Gw {
    pub inbox: [Option<InCtl>; INBOX],
    /// The control the transport took last (its answer is due).
    pub taken: Option<(NodeId, u32, bool, u8)>,
    /// The inner of the last mesh_send, rescheduled (apply_at_ms added).
    pub out: [u8; P + 16],
    pub next_op: u32,
    /// The gateway's own answer to recent ops' inner (op id, status) and their apply_at.
    pub local: [(u32, u32, Option<u32>); 4],
    pub local_i: usize,
    /// The device's status, from the transport (fps, heap, brightness, uptime).
    pub status: StatusMsg,
    pub last_error: u16,
    pub last_error_op: u32,
    pub stats: GwStats,
}

#[derive(Clone, Copy, Default)]
pub struct GwStats {
    pub sends: u32,
    pub send_refused: u32,
    pub send_failed: u32,
    pub results: u32,
    pub ctl_in: u32,
    pub ctl_refused: u32,
    pub ctl_busy: u32,
    pub ctl_ok: u32,
    pub ctl_failed: u32,
    pub replies: u32,
    pub reply_fail: u32,
    pub opened: u32,
}

impl Gw {
    pub unsafe fn init_in(g: *mut Gw) {
        use core::ptr::addr_of_mut as f;
        for i in 0..INBOX {
            f!((*g).inbox[i]).write(None);
        }
        f!((*g).taken).write(None);
        f!((*g).out).write_bytes(0, 1);
        f!((*g).next_op).write(0x4000_0000);
        f!((*g).local).write([(0, 0, None); 4]);
        f!((*g).local_i).write(0);
        f!((*g).status).write(StatusMsg::default());
        f!((*g).last_error).write(0);
        f!((*g).last_error_op).write(0);
        f!((*g).stats).write(GwStats::default());
    }

    fn note_local(&mut self, op: u32, status: u32, apply_at: Option<u32>) {
        self.local[self.local_i % 4] = (op, status, apply_at);
        self.local_i += 1;
    }

    fn local_of(&self, op: u32) -> (u32, Option<u32>) {
        self.local.iter().find(|l| l.0 == op && op != 0).map_or((0, None), |l| (l.1, l.2))
    }
}

// ---- protobuf, by hand (fixed buffers, no allocation) ----

fn varint(b: &[u8], o: &mut usize) -> Option<u64> {
    let mut v = 0u64;
    for shift in (0..64).step_by(7) {
        let x = *b.get(*o)?;
        *o += 1;
        v |= u64::from(x & 0x7f) << shift;
        if x & 0x80 == 0 {
            return Some(v);
        }
    }
    None
}

/// A writer into a fixed buffer; `ok` turns false on overflow (the caller sends nothing).
pub struct Pb<'a> {
    pub b: &'a mut [u8],
    pub n: usize,
    pub ok: bool,
}

impl<'a> Pb<'a> {
    pub fn new(b: &'a mut [u8]) -> Self {
        Pb { b, n: 0, ok: true }
    }
    fn byte(&mut self, x: u8) {
        match self.b.get_mut(self.n) {
            Some(c) => {
                *c = x;
                self.n += 1;
            }
            None => self.ok = false,
        }
    }
    fn raw_varint(&mut self, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            self.byte(if v == 0 { b } else { b | 0x80 });
            if v == 0 {
                break;
            }
        }
    }
    fn key(&mut self, f: u32, wire: u8) {
        self.raw_varint((u64::from(f) << 3) | u64::from(wire));
    }
    /// A uint32 / enum / bool field (skipped when 0, as proto3 does).
    pub fn u(&mut self, f: u32, v: u64) {
        if v != 0 {
            self.key(f, 0);
            self.raw_varint(v);
        }
    }
    /// An `optional uint32` (written even when 0).
    pub fn opt(&mut self, f: u32, v: Option<u32>) {
        if let Some(v) = v {
            self.key(f, 0);
            self.raw_varint(u64::from(v));
        }
    }
    /// A bytes field (skipped when empty).
    pub fn bytes(&mut self, f: u32, v: &[u8]) {
        if v.is_empty() {
            return;
        }
        self.key(f, 2);
        self.raw_varint(v.len() as u64);
        for &x in v {
            self.byte(x);
        }
    }
    /// A sint32 (zigzag).
    pub fn s(&mut self, f: u32, v: i32) {
        self.u(f, ((v << 1) ^ (v >> 31)) as u32 as u64);
    }
    /// An `optional float` (written even when 0).
    pub fn f32o(&mut self, f: u32, v: f32) {
        self.key(f, 5);
        for b in v.to_le_bytes() {
            self.byte(b);
        }
    }
    /// A packed `repeated float` (skipped when empty).
    pub fn f32s(&mut self, f: u32, v: &[f32]) {
        if v.is_empty() {
            return;
        }
        self.key(f, 2);
        self.raw_varint(v.len() as u64 * 4);
        for x in v {
            for b in x.to_le_bytes() {
                self.byte(b);
            }
        }
    }
    /// A length-delimited submessage written by `body`, in place: the body goes 6 bytes
    /// ahead (the most a key plus a length can take here) and moves back behind its header.
    pub fn msg(&mut self, f: u32, body: impl FnOnce(&mut Pb<'_>)) {
        if !self.ok {
            return;
        }
        let start = self.n;
        let room = 6;
        if self.b.len() < start + room {
            self.ok = false;
            return;
        }
        let (blen, ok) = {
            let mut w = Pb::new(&mut self.b[start + room..]);
            body(&mut w);
            (w.n, w.ok)
        };
        if !ok {
            self.ok = false;
            return;
        }
        let mut hdr = [0u8; 6];
        let mut h = Pb::new(&mut hdr);
        h.key(f, 2);
        h.raw_varint(blen as u64);
        let hn = h.n;
        self.b[start..start + hn].copy_from_slice(&hdr[..hn]);
        self.b.copy_within(start + room..start + room + blen, start + hn);
        self.n = start + hn + blen;
    }
}

/// A parsed `MeshSend` (borrowing its `inner`).
#[derive(Debug, Default, PartialEq)]
pub struct Send<'a> {
    pub op_id: u32,
    pub nodes: [NodeId; Targets::MAX_NODES],
    pub n_nodes: usize,
    pub group: u8,
    pub skip_gateway: bool,
    pub inner: &'a [u8],
    pub want_reply: bool,
    pub timeout_ms: u32,
    pub lead_ms: u32,
}

impl Send<'_> {
    pub fn targets(&self) -> Targets {
        if self.n_nodes > 0 {
            Targets::nodes(&self.nodes[..self.n_nodes]).unwrap_or(Targets::All)
        } else if self.group != 0 {
            Targets::Group(self.group)
        } else {
            Targets::All
        }
    }
}

/// Skip one field of wire type `wire` at `*o`.
fn skip(b: &[u8], o: &mut usize, wire: u64) -> Option<()> {
    match wire {
        0 => {
            varint(b, o)?;
        }
        1 => *o += 8,
        2 => {
            let n = varint(b, o)? as usize;
            *o = o.checked_add(n)?;
        }
        5 => *o += 4,
        _ => return None,
    }
    (*o <= b.len()).then_some(())
}

fn parse_targets(b: &[u8], s: &mut Send<'_>) -> Option<()> {
    let mut o = 0;
    while o < b.len() {
        let key = varint(b, &mut o)?;
        match (key >> 3, key & 7) {
            (1, 0) => {
                let v = varint(b, &mut o)?;
                if s.n_nodes >= Targets::MAX_NODES {
                    return None;
                }
                s.nodes[s.n_nodes] = v as NodeId;
                s.n_nodes += 1;
            }
            (1, 2) => {
                // Packed.
                let n = varint(b, &mut o)? as usize;
                let end = o.checked_add(n).filter(|&e| e <= b.len())?;
                while o < end {
                    let v = varint(&b[..end], &mut o)?;
                    if s.n_nodes >= Targets::MAX_NODES {
                        return None;
                    }
                    s.nodes[s.n_nodes] = v as NodeId;
                    s.n_nodes += 1;
                }
            }
            (2, 0) => s.group = varint(b, &mut o)?.min(255) as u8,
            (3, 0) => s.skip_gateway = varint(b, &mut o)? != 0,
            (_, w) => skip(b, &mut o, w)?,
        }
    }
    Some(())
}

/// The `MeshSend` body of a `ClientMessage{mesh_send}` frame.
pub fn parse_send(frame: &[u8]) -> Option<Send<'_>> {
    let (a, r) = client_arm(frame)?;
    if a != gateway::arm::MESH_SEND {
        return None;
    }
    let b = &frame[r];
    let mut s = Send::default();
    let mut o = 0;
    while o < b.len() {
        let key = varint(b, &mut o)?;
        match (key >> 3, key & 7) {
            (1, 0) => s.op_id = varint(b, &mut o)? as u32,
            (2, 2) => {
                let n = varint(b, &mut o)? as usize;
                let end = o.checked_add(n).filter(|&e| e <= b.len())?;
                parse_targets(&b[o..end], &mut s)?;
                o = end;
            }
            (3, 2) => {
                let n = varint(b, &mut o)? as usize;
                let end = o.checked_add(n).filter(|&e| e <= b.len())?;
                s.inner = &b[o..end];
                o = end;
            }
            (4, 0) => s.want_reply = varint(b, &mut o)? != 0,
            (5, 0) => s.timeout_ms = varint(b, &mut o)? as u32,
            (6, 0) => s.lead_ms = varint(b, &mut o)? as u32,
            (_, w) => skip(b, &mut o, w)?,
        }
    }
    Some(s)
}

/// `MeshSendError` values (ledmapper.proto).
pub mod err {
    pub const OK: u32 = 0;
    pub const NO_MESH: u32 = 1;
    pub const NOT_ALLOWED: u32 = 2;
    pub const TOO_BIG: u32 = 3;
    pub const BUSY: u32 = 4;
    pub const LOCKED: u32 = 5;
    pub const BAD_REQUEST: u32 = 6;
}

pub(crate) fn send_err(e: SendError) -> u32 {
    match e {
        SendError::Locked => err::LOCKED,
        SendError::NotMember | SendError::NoRecipients => err::NO_MESH,
        SendError::TooBig => err::TOO_BIG,
        SendError::QueueFull | SendError::Counter => err::BUSY,
        SendError::BadOrder => err::BAD_REQUEST,
    }
}

/// `ServerMessage.mesh` field, `MeshInfo.result` / `.state`.
const SMSG_MESH: u32 = 55;

fn write_result<const N: usize>(w: &mut Pb<'_>, op_id: u32, error: u32, r: Option<&OpResult<N>>, apply_at: Option<u32>, gw_status: u32) {
    w.u(1, op_id.into());
    w.u(2, error.into());
    if let Some(r) = r {
        for i in 0..r.n {
            w.msg(3, |m| {
                m.u(1, r.nodes[i].into());
                m.u(2, r.status[i] as u64);
                m.u(3, r.code[i].into());
                m.u(4, r.latency_ms[i].into());
            });
        }
        w.u(4, r.complete as u64);
    }
    w.opt(5, apply_at);
    w.u(6, gw_status.into());
}

/// `ServerMessage{mesh{result}}` into `out`.
pub fn encode_result<const N: usize>(out: &mut [u8], op_id: u32, error: u32, r: Option<&OpResult<N>>, apply_at: Option<u32>, gw_status: u32) -> usize {
    let mut w = Pb::new(out);
    w.msg(SMSG_MESH, |i| i.msg(1, |m| write_result(m, op_id, error, r, apply_at, gw_status)));
    if w.ok {
        w.n
    } else {
        0
    }
}

fn sync_code(s: SyncState) -> u64 {
    match s {
        SyncState::Unsynced => 0,
        SyncState::Forming => 1,
        _ => 2,
    }
}

/// `FixturePose{room, translation, rotation}` (scale and the room box are the host's).
fn write_pose(w: &mut Pb<'_>, p: &PoseC) {
    w.bytes(1, p.room());
    w.f32s(2, &p.t_m());
    if p.q.is_some() {
        w.f32s(3, &p.quat());
    }
}

/// `MeshPoseState`, and the pose when set (field `f`).
fn write_pose_known(w: &mut Pb<'_>, f: u32, state_f: u32, p: &PoseKnown) {
    match p {
        PoseKnown::Unknown => {}
        PoseKnown::Unposed => w.u(state_f, 1),
        PoseKnown::Posed(p) => {
            w.u(state_f, 2);
            w.msg(f, |e| write_pose(e, p));
        }
    }
}

/// `repeated MeshNeighbour` (field `f`).
fn write_links(w: &mut Pb<'_>, f: u32, links: &[Link]) {
    for l in links {
        w.msg(f, |e| {
            e.u(1, l.node.into());
            e.s(2, l.rssi.into());
            if l.tx_pct != TX_UNKNOWN {
                e.opt(3, Some(l.tx_pct.min(100).into()));
            }
            // Link ranging (docs/design/mesh-ftm.md): uncalibrated unless range_calibrated.
            if let Some(r) = l.range {
                e.f32o(4, r.range_m());
                e.f32o(5, r.sigma_m());
                e.u(6, r.phase_self().ticks().into());
                e.u(7, r.phase_peer().ticks().into());
                e.u(8, r.calibrated().into());
            }
        });
    }
}

/// A member's topology fields (MeshMember 14..18).
fn write_member_topo(e: &mut Pb<'_>, t: &Topo, now_us: i64) {
    e.u(14, t.hops.into());
    write_pose_known(e, 15, 18, &t.pose);
    write_links(e, 16, t.links());
    if t.topo_us != 0 {
        e.opt(17, Some(((now_us - t.topo_us).max(0) / 1000).min(u32::MAX as i64) as u32));
    }
}

/// What a `get_mesh` asked for: the topology, from which member on (GetMesh.topology,
/// .topology_from).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct TopoAsk {
    pub from: usize,
}

/// `GetMesh{topology, topology_from}` from a whole ClientMessage frame (None: no topology).
pub fn parse_get_mesh(frame: &[u8]) -> Option<TopoAsk> {
    let (_, r) = client_arm(frame)?;
    let b = &frame[r];
    let (mut o, mut on, mut from) = (0usize, false, 0u64);
    while o < b.len() {
        let key = varint(b, &mut o)?;
        match (key >> 3, key & 7) {
            (1, 0) => on = varint(b, &mut o)? != 0,
            (2, 0) => from = varint(b, &mut o)?,
            (_, w) => skip(b, &mut o, w)?,
        }
    }
    on.then_some(TopoAsk { from: from.min(u16::MAX as u64) as usize })
}

/// `ServerMessage{mesh{state}}` for connection `conn` into `out`. With `topo`, the members
/// from `topo.from` on carry their topology, as many as fit the frame (the rest are left for
/// the next page, MeshState.topology_next).
pub fn encode_state(m: &Mesh, conn: usize, now_us: i64, out: &mut [u8], topo: Option<TopoAsk>) -> usize {
    let Some(ask) = topo else {
        return encode_state_page(m, conn, now_us, out, None);
    };
    // As many members' topology as fit: halve until the whole state does (at worst, the
    // state without any).
    let mut max = 16usize;
    while max > 0 {
        let n = encode_state_page(m, conn, now_us, out, Some((ask.from, max)));
        if n > 0 {
            return n;
        }
        max /= 2;
    }
    encode_state_page(m, conn, now_us, out, None)
}

fn encode_state_page(m: &Mesh, conn: usize, now_us: i64, out: &mut [u8], topo: Option<(usize, usize)>) -> usize {
    let s = &m.stack;
    let t = &s.time;
    let mut w = Pb::new(out);
    w.msg(SMSG_MESH, |i| {
        i.msg(2, |st| {
            st.u(1, 1);
            st.u(2, s.membership.is_member() as u64);
            st.u(3, s.me().into());
            st.u(4, s.membership.mesh_id().unwrap_or(0).into());
            st.u(5, s.node.backhaul.channel().into());
            st.u(6, s.gate.is_unlocked(conn) as u64);
            st.u(7, s.envelope_trust() as u64);
            st.u(8, sync_code(t.state));
            st.u(9, (t.err_us as i64).clamp(0, u32::MAX as i64) as u64);
            st.u(10, t.epoch.map_or(0, |e| e.gen).into());
            let mut next = 0usize;
            for (k, mb) in s.fanout.live(now_us).filter(|mb| mb.node != s.me()).enumerate() {
                let with_topo = topo.is_some_and(|(from, max)| k >= from && k < from + max);
                if topo.is_some_and(|(from, max)| k >= from + max) && next == 0 {
                    next = k;
                }
                st.msg(11, |e| {
                    e.u(1, mb.node.into());
                    if let Some(n) = s.node.backhaul.neighbour(mb.node) {
                        e.s(2, n.rssi_avg().into());
                    }
                    e.u(3, ((now_us - mb.seen_us).max(0) / 1000) as u64);
                    if let Some(x) = mb.status {
                        e.u(4, x.firmware.into());
                        e.u(5, x.uptime_s.into());
                        e.u(6, x.fps.into());
                        e.u(7, x.heap_free.into());
                        e.u(8, x.heap_min.into());
                        e.u(9, x.brightness.into());
                        e.u(10, x.sync.into());
                        e.u(11, x.time_err_us.into());
                        e.u(12, x.last_error.into());
                        e.u(13, x.last_error_op.into());
                    }
                    // Its wall clock (RTC PR-8; absent from older firmware).
                    if let Some((c, _)) = mb.clock {
                        e.u(19, c.source.into());
                        e.u(20, c.err_ms.into());
                    }
                    if with_topo {
                        write_member_topo(e, &mb.topo, now_us);
                    }
                });
            }
            if let Some(r) = s.fanout.last.as_ref() {
                let (gs, at) = m.gw.local_of(r.op_id);
                st.msg(12, |res| write_result(res, r.op_id, err::OK, Some(r), at, gs));
            }
            // Membership (M7).
            let ms = s.membership.state;
            st.u(13, ms.map_or(0, |x| proto_mode(x.mode)).into());
            st.u(14, phase_code(s.membership.phase()).into());
            st.u(15, ms.map_or(0, |x| x.epoch).into());
            st.u(16, ms.is_some_and(|x| x.admin_key.is_some()) as u64);
            st.u(17, ms.is_some_and(|x| x.site_secret.is_some()) as u64);
            st.bytes(18, &s.dev.public_key());
            let session = s.gate.session(conn).unwrap_or(0);
            st.u(19, session.into());
            st.u(20, s.gateway.as_ref().filter(|g| session != 0 && g.grant.session == session).map_or(0, |g| g.len()) as u64);
            for p in s.membership.gateway_pending.iter().flatten() {
                st.msg(21, |e| {
                    e.u(1, p.node.into());
                    e.bytes(2, &p.key_hash);
                    e.u(3, p.firmware.into());
                    e.u(4, p.heard_by.into());
                });
            }
            st.u(22, ms.map_or(0, |x| x.revoked.len()) as u64);
            for g in s.membership.groups().as_slice() {
                st.u(23, (*g).into());
            }
            st.u(24, s.sessions.synced() as u64);
            st.u(25, s.mesh_s(now_us).into());
            // The wall clock (RTC PR-8): this fixture's source and error, and the mesh record
            // it maps schedules through.
            let c = s.wall.status();
            if c.source != 0 {
                st.u(30, c.source.into());
                st.u(31, c.err_ms.into());
            }
            if c.gen != 0 {
                st.u(32, c.gen.into());
                st.u(33, c.origin.into());
            }
            // The topology (GetMesh.topology): this fixture's own, and the next page.
            if topo.is_some() {
                write_pose_known(st, 26, 29, &s.topo.pose);
                let mut links = [Link::EMPTY; topo::NEIGHBOURS];
                let n = s.links(now_us, &mut links);
                write_links(st, 27, &links[..n]);
                st.u(28, next as u64);
            }
        });
    });
    if w.ok {
        w.n
    } else {
        0
    }
}

fn proto_mode(m: Mode) -> u8 {
    match m {
        Mode::Closed => 0,
        Mode::Locked => 1,
        Mode::Open => 2,
    }
}

fn phase_code(p: Phase) -> u8 {
    match p {
        Phase::Unprovisioned => 0,
        Phase::Searching { .. } => 1,
        Phase::Joining => 2,
        Phase::Member => 3,
    }
}

/// The player's local epoch (ms, esp_timer domain) as the mesh last mapped it.
pub(crate) fn local_epoch_ms(m: &Mesh) -> Option<i64> {
    m.tb_mine.flatten()
}

/// An app arm on connection `conn` (after the kiosk gate): `mesh_send` or `get_mesh`.
/// Returns -2 if `frame` is neither (the caller dispatches it as usual), the reply's length
/// in `out` (>= 0), or -3: dispatch `*inner` (`*inner_len` bytes) here too and answer with
/// its reply, then call [`ns_mesh_gw_local_done`].
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_app(m: *mut Mesh, conn: u32, frame: *const u8, len: u32, now_us: i64, out: *mut u8, cap: u32, inner: *mut *const u8, inner_len: *mut u32) -> i32 {
    let m = &mut *m;
    let frame = core::slice::from_raw_parts(frame, len as usize);
    let out = core::slice::from_raw_parts_mut(out, cap as usize);
    let conn = (conn as usize).min(CONSOLE_CONN - 1);
    let Some((a, _)) = client_arm(frame) else { return -2 };
    match a {
        gateway::arm::GET_MESH => {
            if m.stack.membership.is_member() && !m.stack.gate.is_unlocked(conn) && m.stack.open_gateway(conn).is_ok() {
                m.gw.stats.opened += 1;
                m.log(format_args!("[mesh] gateway session open conn={conn}"));
            }
            encode_state(m, conn, now_us, out, parse_get_mesh(frame)) as i32
        }
        gateway::arm::MESH_ADMIN => {
            let Some(a) = parse_admin(frame) else {
                return encode_admin(out, 0, aerr::BAD_REQUEST, 0, None) as i32;
            };
            // Below render (PR-40): unlock verifies the admin's grant, revoke the rotation order.
            let (e, v) = crate::below_render(|| admin(m, conn, &a, now_us));
            // A provision answers with the provisioner token (D-324), to that connection only.
            let tok = if a.op == op::PROVISION && e == aerr::OK { m.owner_token } else { None };
            encode_admin(out, a.op, e, v, tok.as_ref().map(|t| &t[..])) as i32
        }
        gateway::arm::MESH_SEND => {
            let Some(s) = parse_send(frame) else {
                return encode_result::<16>(out, 0, err::BAD_REQUEST, None, None, 0) as i32;
            };
            let op = if s.op_id != 0 {
                s.op_id
            } else {
                m.gw.next_op = m.gw.next_op.wrapping_add(1) | 0x4000_0000;
                m.gw.next_op
            };
            // An effect program (mesh M6): any size, shared as a blob and switched on one
            // frame everywhere; the app's direct reply is what the load answers.
            if client_arm(s.inner).is_some_and(|(a, _)| a == gateway::arm::SUBMIT_EFFECT) {
                let r = gate(m, conn).and_then(|_| crate::mesh_blob::share(m, conn, op, &s, now_us, out));
                return match r {
                    Ok(n) => {
                        m.gw.stats.sends += 1;
                        m.gw.note_local(op, 0, None);
                        n as i32
                    }
                    Err(e) => {
                        m.gw.stats.send_failed += 1;
                        m.log(format_args!("[mesh] gw share op={op} refused err={e}"));
                        encode_result::<16>(out, op, e, None, None, 0) as i32
                    }
                };
            }
            match gateway_send(m, conn, op, &s, now_us) {
                Err(e) => {
                    m.gw.stats.send_refused += (e == err::NOT_ALLOWED) as u32;
                    m.gw.stats.send_failed += (e != err::NOT_ALLOWED) as u32;
                    m.log(format_args!("[mesh] gw send op={op} refused err={e}"));
                    encode_result::<16>(out, op, e, None, None, 0) as i32
                }
                Ok((range, apply_at)) => {
                    m.gw.stats.sends += 1;
                    m.gw.note_local(op, 0, apply_at);
                    if s.skip_gateway {
                        return encode_result::<16>(out, op, err::OK, None, apply_at, 0) as i32;
                    }
                    let (p, n) = match range {
                        Some(n) => (m.gw.out.as_ptr(), n),
                        None => (s.inner.as_ptr(), s.inner.len()),
                    };
                    *inner = p;
                    *inner_len = n as u32;
                    m.gw_local_op = op;
                    -3
                }
            }
        }
        _ => -2,
    }
}

/// The app's mesh arms while the mesh is off (no block): `get_mesh` answers `state{on: false}`
/// and `mesh_send` `result{error: NO_MESH}`, so a mesh-variant player always answers its own
/// arms. -2 for anything else.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_app_off(frame: *const u8, len: u32, out: *mut u8, cap: u32) -> i32 {
    let frame = core::slice::from_raw_parts(frame, len as usize);
    let out = core::slice::from_raw_parts_mut(out, cap as usize);
    app_off(frame, out)
}

/// The answer to a `mesh_admin` provision / leave when the mesh could not turn on for it
/// (`error`: an `aerr` code; `value`: what it needed, e.g. the block's bytes), so the app
/// sees why instead of the player core's generic `unsupported`. -2 if `frame` is not a
/// `mesh_admin`.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_admin_refuse(frame: *const u8, len: u32, out: *mut u8, cap: u32, error: u32, value: u32) -> i32 {
    let frame = core::slice::from_raw_parts(frame, len as usize);
    let out = core::slice::from_raw_parts_mut(out, cap as usize);
    match client_arm(frame) {
        Some((gateway::arm::MESH_ADMIN, _)) => {
            let op = parse_admin(frame).map_or(0, |a| a.op);
            encode_admin(out, op, error, value, None) as i32
        }
        _ => -2,
    }
}

fn app_off(frame: &[u8], out: &mut [u8]) -> i32 {
    match client_arm(frame) {
        Some((gateway::arm::GET_MESH, _)) => {
            let mut w = Pb::new(out);
            w.msg(SMSG_MESH, |i| i.msg(2, |_| {}));
            if w.ok {
                w.n as i32
            } else {
                0
            }
        }
        Some((gateway::arm::MESH_SEND, _)) => {
            let op = parse_send(frame).map_or(0, |s| s.op_id);
            encode_result::<16>(out, op, err::NO_MESH, None, None, 0) as i32
        }
        // Joining (or leaving) a mesh turns it on first: the transport does, then asks again.
        Some((gateway::arm::MESH_ADMIN, _)) => match parse_admin(frame) {
            Some(a) if a.op == op::PROVISION || a.op == op::LEAVE => -4,
            Some(a) => encode_admin(out, a.op, aerr::NO_MESH, 0, None) as i32,
            None => encode_admin(out, 0, aerr::BAD_REQUEST, 0, None) as i32,
        },
        _ => -2,
    }
}

// ---- membership and administration (M7): `mesh_admin` ----

/// `MeshAdmin.op` field numbers.
pub mod op {
    pub const PROVISION: u32 = 1;
    pub const UNLOCK: u32 = 2;
    pub const ADMIT: u32 = 3;
    pub const REVOKE: u32 = 4;
    pub const LEAVE: u32 = 5;
    pub const GROUPS: u32 = 6;
    pub const EJECT: u32 = 7;
}

/// `MeshAdminError` values.
pub mod aerr {
    pub const OK: u32 = 0;
    pub const BAD_REQUEST: u32 = 1;
    pub const LOCKED: u32 = 2;
    pub const LOCKED_OUT: u32 = 3;
    pub const BAD_GRANT: u32 = 4;
    pub const NO_MESH: u32 = 5;
    pub const NO_MEMBERS: u32 = 6;
    pub const BUSY: u32 = 7;
    pub const BAD_ORDER: u32 = 8;
    pub const UNSUPPORTED: u32 = 9;
    pub const NO_MEMORY: u32 = 10;
}

/// A parsed `MeshAdmin`: its op, and the op's fields by number (varints in `v`, bytes in
/// `by`, the one repeated uint32 field in `list`), borrowing the frame.
#[derive(Debug, Default, PartialEq)]
pub struct Admin<'a> {
    pub op: u32,
    pub v: [u64; 8],
    pub by: [Option<&'a [u8]>; 8],
    pub list: [u32; 8],
    pub n_list: usize,
}

/// The repeated uint32 field of each op (groups, exclude).
fn list_field(op: u32) -> u32 {
    match op {
        op::PROVISION => 6,
        op::REVOKE => 4,
        op::GROUPS => 2,
        _ => 0,
    }
}

fn parse_op<'a>(b: &'a [u8], a: &mut Admin<'a>) -> Option<()> {
    let lf = list_field(a.op);
    let mut o = 0;
    while o < b.len() {
        let key = varint(b, &mut o)?;
        let (f, w) = ((key >> 3) as u32, key & 7);
        match w {
            0 if f == lf => {
                let x = varint(b, &mut o)?;
                *a.list.get_mut(a.n_list)? = x as u32;
                a.n_list += 1;
            }
            2 if f == lf => {
                let n = varint(b, &mut o)? as usize;
                let end = o.checked_add(n).filter(|&e| e <= b.len())?;
                while o < end {
                    let x = varint(&b[..end], &mut o)?;
                    *a.list.get_mut(a.n_list)? = x as u32;
                    a.n_list += 1;
                }
            }
            0 if (f as usize) < 8 => a.v[f as usize] = varint(b, &mut o)?,
            2 if (f as usize) < 8 => {
                let n = varint(b, &mut o)? as usize;
                let end = o.checked_add(n).filter(|&e| e <= b.len())?;
                a.by[f as usize] = Some(&b[o..end]);
                o = end;
            }
            _ => skip(b, &mut o, w)?,
        }
    }
    Some(())
}

/// The `MeshAdmin` of a `ClientMessage{mesh_admin}` frame.
pub fn parse_admin(frame: &[u8]) -> Option<Admin<'_>> {
    let (arm, r) = client_arm(frame)?;
    if arm != gateway::arm::MESH_ADMIN {
        return None;
    }
    let b = &frame[r];
    let mut a = Admin::default();
    let mut o = 0;
    while o < b.len() {
        let key = varint(b, &mut o)?;
        let (f, w) = ((key >> 3) as u32, key & 7);
        if w == 2 && (op::PROVISION..=op::EJECT).contains(&f) {
            let n = varint(b, &mut o)? as usize;
            let end = o.checked_add(n).filter(|&e| e <= b.len())?;
            // A oneof: the last op wins.
            a = Admin { op: f, ..Admin::default() };
            parse_op(&b[o..end], &mut a)?;
            o = end;
        } else {
            skip(b, &mut o, w)?;
        }
    }
    (a.op != 0).then_some(a)
}

/// `ServerMessage{mesh{admin{op, error, value, provisioner_token}}}` into `out`.
pub fn encode_admin(out: &mut [u8], op: u32, error: u32, value: u32, token: Option<&[u8]>) -> usize {
    let mut w = Pb::new(out);
    w.msg(SMSG_MESH, |i| {
        i.msg(3, |r| {
            r.u(1, op.into());
            r.u(2, error.into());
            r.u(3, value.into());
            if let Some(t) = token {
                r.bytes(4, t);
            }
        })
    });
    if w.ok {
        w.n
    } else {
        0
    }
}

fn admin_err(e: SendError) -> u32 {
    match e {
        SendError::Locked => aerr::LOCKED,
        SendError::NotMember => aerr::NO_MESH,
        SendError::NoRecipients => aerr::NO_MEMBERS,
        SendError::TooBig => aerr::BAD_REQUEST,
        SendError::QueueFull | SendError::Counter => aerr::BUSY,
        SendError::BadOrder => aerr::BAD_ORDER,
    }
}

fn key8(b: Option<&[u8]>) -> Option<[u8; 8]> {
    b?.try_into().ok()
}

/// Carry out one `mesh_admin` from connection `conn`: (error, value).
fn admin(m: &mut Mesh, conn: usize, a: &Admin<'_>, now_us: i64) -> (u32, u32) {
    // On a fixture that holds an admin key, joining another mesh or leaving needs this
    // connection unlocked (a grant), so nobody on the network can pull it out of its mesh —
    // or the provisioner token the user who provisioned it holds (D-324; field 7 of
    // provision, 1 of leave).
    let held = m.stack.membership.admin_key().is_some();
    let tok_field = if a.op == op::PROVISION { 7 } else { 1 };
    let by_token = match (a.by[tok_field], m.owner_token) {
        (Some(t), Some(o)) => ct_eq(t, &o),
        _ => false,
    };
    let may_reprovision = !held || by_token || m.stack.signing_session(conn);
    match a.op {
        op::PROVISION => {
            if !may_reprovision {
                return (aerr::LOCKED, 0);
            }
            let mesh_id = a.v[1] as u32;
            let site_secret: Option<[u8; 32]> = match a.by[2] {
                None => None,
                Some(b) => match b.try_into() {
                    Ok(x) => Some(x),
                    Err(_) => return (aerr::BAD_REQUEST, 0),
                },
            };
            let admin_key: Option<[u8; 65]> = match a.by[3] {
                None => None,
                Some(b) => match b.try_into() {
                    Ok(x) if b[0] == 0x04 => Some(x),
                    _ => return (aerr::BAD_REQUEST, 0),
                },
            };
            let mode = match a.v[4] {
                0 => Mode::Closed,
                1 => Mode::Locked,
                // Open mode (guests) is M7b.
                _ => return (aerr::UNSUPPORTED, 0),
            };
            if mesh_id == 0 || a.n_list > Groups::MAX {
                return (aerr::BAD_REQUEST, 0);
            }
            let mut groups = Groups::new();
            for &g in &a.list[..a.n_list] {
                if g == 0 || g > 255 || !groups.add(g as u8) {
                    return (aerr::BAD_REQUEST, 0);
                }
            }
            let channel = match a.v[5] {
                0 => m.staged.1,
                c if c <= 14 => c as u8,
                _ => return (aerr::BAD_REQUEST, 0),
            };
            let c = Credentials { mesh_id, channel, mode, site_secret, mesh_key: None, admin_key, groups };
            m.stack.leave();
            m.stack.node.backhaul.cfg.mesh_id = Some(mesh_id);
            m.stack.provision(now_us, &c, ProvisionSource::App);
            m.provisioned_us = Some(now_us);
            m.member_us = None;
            m.persist = true;
            // The provisioner token (D-324): kept for its holder, a fresh one otherwise.
            if !by_token {
                m.owner_token = Some(crate::random_token());
            }
            m.dirty = true;
            m.want_off = false;
            // Presence only: secrets are never logged.
            m.log(format_args!(
                "[mesh] provisioned mesh_id={mesh_id:08x} mode={} site_secret={} admin_key={} groups={} conn={conn}",
                crate::mode_name(mode),
                site_secret.is_some() as u8,
                admin_key.is_some() as u8,
                groups.len()
            ));
            (aerr::OK, 0)
        }
        op::UNLOCK => {
            let Some(SessionMsg::Grant(g)) = a.by[1].and_then(SessionMsg::decode) else {
                return (aerr::BAD_REQUEST, 0);
            };
            if m.stack.membership.state.is_none() {
                return (aerr::NO_MESH, 0);
            }
            // A delegate's grant comes with its certificate (MeshUnlock.delegation).
            let deleg = match (g.by, a.by[2]) {
                (None, _) => None,
                (Some(_), Some(b)) => match Delegation::decode(b) {
                    Some(d) => Some(d),
                    None => return (aerr::BAD_REQUEST, 0),
                },
                (Some(_), None) => return (aerr::BAD_GRANT, 0),
            };
            let r = m.stack.unlock(now_us, conn, &g, deleg.as_ref());
            let e = match r {
                Ok(()) => aerr::OK,
                Err(UnlockError::LockedOut) => aerr::LOCKED_OUT,
                Err(UnlockError::BadGrant) | Err(UnlockError::NoAdminKey) => aerr::BAD_GRANT,
                Err(UnlockError::BadConnection) => aerr::BAD_REQUEST,
            };
            m.log(format_args!(
                "[mesh] unlock conn={conn} session={} not_after={} by={} -> {}",
                g.session,
                g.not_after,
                if g.by.is_some() { "delegate" } else { "admin" },
                if e == aerr::OK { "ok" } else { "refused" }
            ));
            (e, if e == aerr::OK { g.session } else { 0 })
        }
        op::LEAVE => {
            if !may_reprovision {
                return (aerr::LOCKED, 0);
            }
            m.stack.leave();
            m.owner_token = None;
            m.want_off = true;
            m.dirty = true;
            m.log(format_args!("[mesh] left the mesh (app, conn={conn}{})", if by_token { ", provisioner token" } else { "" }));
            (aerr::OK, 0)
        }
        _ => {
            // Admin commands to the mesh: a grant's session (or envelope trust on a dev mesh).
            if !m.stack.gate.is_unlocked(conn) && m.stack.open_gateway(conn).is_ok() {
                m.gw.stats.opened += 1;
            }
            let node = a.v[1] as NodeId;
            let r = match a.op {
                op::ADMIT => match key8(a.by[2]) {
                    Some(key_hash) => m.stack.admit(now_us, conn, &PendingJoin { node, mac: [0; 6], key_hash, firmware: 0, heard_by: 0 }),
                    None => return (aerr::BAD_REQUEST, 0),
                },
                op::EJECT => match key8(a.by[2]) {
                    Some(key_hash) => m.stack.eject(now_us, conn, node, key_hash),
                    None => return (aerr::BAD_REQUEST, 0),
                },
                op::GROUPS => {
                    let mut g = [0u8; 8];
                    for (d, &x) in g.iter_mut().zip(&a.list[..a.n_list]) {
                        *d = x.min(255) as u8;
                    }
                    m.stack.assign_groups(now_us, conn, node, &g[..a.n_list])
                }
                op::REVOKE => {
                    let order = a.by[1].and_then(RekeyOrder::decode);
                    let mk: Option<[u8; 16]> = a.by[2].and_then(|b| b.try_into().ok());
                    let ss: Option<[u8; 32]> = a.by[3].and_then(|b| b.try_into().ok());
                    let (Some(order), Some(mk), Some(ss)) = (order, mk, ss) else { return (aerr::BAD_REQUEST, 0) };
                    let mut ex = [0 as NodeId; 8];
                    for (d, &x) in ex.iter_mut().zip(&a.list[..a.n_list]) {
                        *d = x as NodeId;
                    }
                    let mut keyed = false;
                    let r = m.stack.rotate(now_us, conn, order, &mk, &ss, &ex[..a.n_list], &mut |e| keyed |= matches!(e, Event::Rekeyed { .. }));
                    if r.is_ok() {
                        m.dirty = true;
                        m.log(format_args!("[mesh] rotation started epoch={} revoked={} excluded={}", order.epoch, order.n_revoked, a.n_list));
                    }
                    if keyed {
                        let n = m.stack.membership.state.map_or(0, |s| s.revoked.len());
                        m.log(format_args!("[mesh] rekeyed epoch={} revoked={n}", order.epoch));
                    }
                    r.map(|_| 1)
                }
                _ => return (aerr::BAD_REQUEST, 0),
            };
            match r {
                Ok(n) => {
                    m.dirty |= a.op == op::GROUPS && node == m.stack.me();
                    m.log(format_args!("[mesh] admin op={} node={node:04x} sent={n}", a.op));
                    (aerr::OK, n as u32)
                }
                Err(e) => {
                    m.log(format_args!("[mesh] admin op={} node={node:04x} refused {:?}", a.op, e));
                    (admin_err(e), 0)
                }
            }
        }
    }
}

/// Check, schedule and send one `mesh_send`. Ok: (the rescheduled inner's length in
/// `m.gw.out`, if it was rescheduled; its apply_at_ms).
/// A mesh arm may command the mesh from connection `conn`: a member, and the connection
/// unlocked (on a dev mesh, the first mesh arm opens the session: envelope trust).
fn gate(m: &mut Mesh, conn: usize) -> Result<(), u32> {
    if !m.stack.membership.is_member() {
        return Err(err::NO_MESH);
    }
    if !m.stack.gate.is_unlocked(conn) {
        m.stack.open_gateway(conn).map_err(|_| err::LOCKED)?;
        m.gw.stats.opened += 1;
        m.log(format_args!("[mesh] gateway session open conn={conn}"));
    }
    Ok(())
}

fn gateway_send(m: &mut Mesh, conn: usize, op: u32, s: &Send<'_>, now_us: i64) -> Result<(Option<usize>, Option<u32>), u32> {
    gate(m, conn)?;
    let a = relay_arm(s.inner).map_err(|_| err::NOT_ALLOWED)?;
    // Schedule it on the show clock (the mesh's epoch, mapped onto our time base), if asked.
    let mut resched = None;
    let mut apply_at = None;
    if s.lead_ms > 0 && gateway::apply_at_field(a).is_some() {
        match local_epoch_ms(m) {
            Some(ep) => {
                let at = (now_us / 1000 - ep + i64::from(s.lead_ms)).clamp(0, u32::MAX as i64) as u32;
                if let Some(n) = with_apply_at(s.inner, at, &mut m.gw.out) {
                    resched = Some(n);
                    apply_at = Some(at);
                }
            }
            None if m.stack.time.synced() => {
                // No show clock yet: this session starts one now (desk #79), and this
                // message goes out on arrival (members learn the epoch within a beacon).
                let e = m.stack.time.mesh_us(now_us);
                if let Some(se) = m.stack.originate_epoch(EpochSource::Connection(conn), Some(e)) {
                    m.tb_originated += 1;
                    crate::log_epoch(m, "originated", se);
                }
            }
            None => {}
        }
    }
    let body = match resched {
        Some(n) => &m.gw.out[..n],
        None => s.inner,
    };
    // `body` borrows m.gw.out: copy it out for the send (the stack is another field).
    let mut buf = [0u8; P + 16];
    buf[..body.len()].copy_from_slice(body);
    let body = &buf[..body.len()];
    let targets = s.targets();
    let r = if s.want_reply {
        let timeout = if s.timeout_ms == 0 { REPLY_TIMEOUT_US } else { i64::from(s.timeout_ms.min(30_000)) * 1000 };
        m.stack.send_control_collect(now_us, conn, op, targets, body, a as u8, timeout).map(|_| ())
    } else {
        m.stack.send_control(now_us, conn, op, targets, body).map(|_| ())
    };
    r.map_err(send_err)?;
    // The look changed through this session: members that sync from now on catch up (M6).
    m.stack.scene_changed();
    Ok((resched, apply_at))
}

/// The gateway's own dispatch of the last `mesh_send`'s inner finished: `status` 0 = ok,
/// else its error (a reply of arm `error`, or none).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_gw_local_done(m: *mut Mesh, status: u32) {
    let m = &mut *m;
    let op = core::mem::take(&mut m.gw_local_op);
    if let Some(l) = m.gw.local.iter_mut().find(|l| l.0 == op && op != 0) {
        l.1 = status;
    }
}

/// The app's `set_time_base` on connection `conn` was just handled: the time base the player
/// now holds may start a show epoch (if `conn` holds the gateway session, desk #79).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_app_time_base(m: *mut Mesh, conn: u32) {
    let m = &mut *m;
    m.tb_app = Some((conn as usize).min(CONSOLE_CONN - 1));
    m.tb_next_us = 0;
}

/// The transport's scratch buffer in the block (`XFER` bytes): relayed control on its way to
/// the dispatcher, a result on its way out, a console argument. One user at a time (loopTask).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_xfer(m: *mut Mesh, cap: *mut u32) -> *mut u8 {
    *cap = XFER as u32;
    (*m).xfer.as_mut_ptr()
}

/// Time to hand over the status inputs ([`ns_mesh_status`])? Once a second.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_status_due(m: *mut Mesh, now_us: i64) -> u32 {
    let m = &mut *m;
    if now_us - m.status_us < STATUS_INPUT_US {
        return 0;
    }
    m.status_us = now_us;
    1
}

/// The app connections now (`ws`, `ble`: open or not), every loop pass: a connection that
/// went away or was replaced ends whatever gateway session it held.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_conns(m: *mut Mesh, ws: u32, ble: u32) {
    let now = (ws != 0) as u8 | (((ble != 0) as u8) << 1);
    let was = (*m).conns;
    (*m).conns = now;
    // Kiosk sources: 1 = wss, 2 = BLE (player_ffi.h).
    if (now ^ was) & 1 != 0 {
        ns_mesh_conn_closed(m, 1);
    }
    if (now ^ was) & 2 != 0 {
        ns_mesh_conn_closed(m, 2);
    }
}

/// Connection `conn` dropped: its gateway session (if any) ends.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_conn_closed(m: *mut Mesh, conn: u32) {
    let m = &mut *m;
    let c = conn as usize;
    let signing = m.stack.signing_session(c);
    if m.stack.gate.is_unlocked(c) {
        m.log(format_args!(
            "[mesh] gateway session closed conn={c}{}",
            if signing { " (its grant kept for catch-ups)" } else { "" }
        ));
    }
    m.stack.connection_changed(c);
}

/// A finished `mesh_send` (want_reply) to push: its `ServerMessage` in `out`, the connection
/// in `*conn`; 0 if none.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_take_result(m: *mut Mesh, out: *mut u8, cap: u32, conn: *mut u32) -> u32 {
    let m = &mut *m;
    let Some(r) = m.stack.fanout.take_done() else { return 0 };
    m.gw.stats.results += 1;
    // A share's second phase (M6): a member that did not switch gets a catch-up.
    if m.bs.share_ops.contains(&r.op_id) {
        for k in 0..r.n {
            if r.status[k] != Status::Ok {
                m.stack.queue_catch_up(r.nodes[k]);
            }
        }
    }
    if r.op_id & 0xff00_0000 == crate::mesh_blob::CATCH_UP_OP {
        let ok = r.status[..r.n].iter().filter(|s| **s == Status::Ok).count();
        m.log(format_args!("[mesh] gw catch-up result ok={ok}/{}", r.n));
        return 0;
    }
    let (gs, at) = m.gw.local_of(r.op_id);
    let ok = r.status[..r.n].iter().filter(|s| **s == Status::Ok).count();
    m.log(format_args!(
        "[mesh] gw result op={} n={} ok={ok} complete={} nodes={:04x?} lat_ms={:?} status={:?} codes={:?} gw={gs}",
        r.op_id,
        r.n,
        r.complete as u8,
        &r.nodes[..r.n],
        &r.latency_ms[..r.n],
        &r.status[..r.n],
        &r.code[..r.n],
    ));
    *conn = r.conn as u32;
    if r.conn == CONSOLE_CONN {
        return 0;
    }
    let out = core::slice::from_raw_parts_mut(out, cap as usize);
    encode_result(out, r.op_id, err::OK, Some(&r), at, gs) as u32
}

// ---- member side ----

/// A relayed control from the tick: refuse it now or queue it for the transport.
pub fn on_control(m: &mut Mesh, origin: NodeId, op_id: u32, want_reply: bool, inner: &[u8]) {
    m.gw.stats.ctl_in += 1;
    let arm = client_arm(inner).map_or(0, |a| a.0.min(255) as u8);
    if let Err(r) = relay_arm(inner) {
        m.gw.stats.ctl_refused += 1;
        m.gw.last_error = r.code();
        m.gw.last_error_op = op_id;
        m.log(format_args!("[mesh] ctl refused op={op_id} arm={arm} from={origin:04x} (not relayed over the mesh)"));
        answer(m, origin, op_id, want_reply, Status::Refused, arm, r.code());
        return;
    }
    let Some(slot) = m.gw.inbox.iter_mut().find(|s| s.is_none()) else {
        m.gw.stats.ctl_busy += 1;
        m.log(format_args!("[mesh] ctl busy op={op_id} arm={arm} from={origin:04x}"));
        answer(m, origin, op_id, want_reply, Status::Failed, arm, 0xffff);
        return;
    };
    let mut c = InCtl { origin, op_id, want_reply, len: inner.len().min(P) as u8, buf: [0; P] };
    c.buf[..c.len as usize].copy_from_slice(&inner[..c.len as usize]);
    *slot = Some(c);
}

fn answer(m: &mut Mesh, origin: NodeId, op_id: u32, want_reply: bool, status: Status, arm: u8, code: u16) {
    if !want_reply {
        return;
    }
    match m.stack.reply(origin, &ReplyMsg { op_id, status, arm, code }) {
        Ok(_) => m.gw.stats.replies += 1,
        Err(_) => m.gw.stats.reply_fail += 1,
    }
}

/// The next relayed control to dispatch: its bytes in `out` (returns the length; 0: none).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_take_control(m: *mut Mesh, out: *mut u8, cap: u32, op: *mut u32) -> u32 {
    let m = &mut *m;
    let Some(i) = m.gw.inbox.iter().position(|s| s.is_some()) else { return 0 };
    let c = m.gw.inbox[i].take().expect("some");
    // FIFO: keep the next one first.
    m.gw.inbox.rotate_left(1);
    let n = (c.len as usize).min(cap as usize);
    core::ptr::copy_nonoverlapping(c.buf.as_ptr(), out, n);
    *op = c.op_id;
    let arm = client_arm(&c.buf[..n]).map_or(0, |a| a.0.min(255) as u8);
    m.gw.taken = Some((c.origin, c.op_id, c.want_reply, arm));
    n as u32
}

/// The control [`ns_mesh_take_control`] handed out was dispatched: `status` 0 = ok, else the
/// player answered with an error (`code`). Answers the gateway when it asked.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_control_done(m: *mut Mesh, status: u32, code: u32) {
    let m = &mut *m;
    let Some((origin, op, want, arm)) = m.gw.taken.take() else { return };
    let st = if status == 0 { Status::Ok } else { Status::Failed };
    if st == Status::Ok {
        m.gw.stats.ctl_ok += 1;
    } else {
        m.gw.stats.ctl_failed += 1;
        m.gw.last_error = code.min(0xfffe) as u16;
        m.gw.last_error_op = op;
        m.log(format_args!("[mesh] ctl failed op={op} arm={arm} code={code}"));
    }
    answer(m, origin, op, want, st, arm, code.min(0xffff) as u16);
}

/// The device's status for the member's broadcasts (call every loop pass; cheap).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_status(m: *mut Mesh, fps: u32, heap_free: u32, heap_min: u32, brightness: u32, uptime_s: u32, firmware: u32) {
    let m = &mut *m;
    let t = &m.stack.time;
    let st = StatusMsg {
        firmware,
        uptime_s,
        heap_free,
        heap_min,
        fps: fps.min(u16::MAX as u32) as u16,
        brightness: brightness.min(255) as u8,
        sync: sync_code(t.state) as u8,
        time_err_us: (t.err_us as i64).clamp(0, u16::MAX as i64) as u16,
        last_error: m.gw.last_error,
        last_error_op: m.gw.last_error_op,
    };
    m.gw.status = st;
    m.stack.set_status(st);
}

/// This device's room pose for its topology broadcasts (splanc_mesh::topo), from the
/// firmware's 1 Hz status pass (mesh_glue.h `lm_mesh_pose_fill`): `posed` 0 = no pose, else
/// translation `t` (3 floats, metres), rotation `q` (4 floats x, y, z, w; null = identity)
/// and the room name. Cheap: an unchanged pose is a compare (it goes out on a change, and
/// once a minute).
///
/// # Safety
/// `m` is the mesh; `t` (posed) points at 3 floats, `q` at 4 or is null, `room` at
/// `room_len` bytes or is null.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_pose(m: *mut Mesh, posed: u32, t: *const f32, q: *const f32, room: *const u8, room_len: u32) {
    let m = &mut *m;
    let p = if posed == 0 || t.is_null() {
        PoseKnown::Unposed
    } else {
        let t = core::slice::from_raw_parts(t, 3);
        let q = (!q.is_null()).then(|| {
            let q = core::slice::from_raw_parts(q, 4);
            [q[0], q[1], q[2], q[3]]
        });
        let room = if room.is_null() { &[][..] } else { core::slice::from_raw_parts(room, room_len as usize) };
        PoseKnown::Posed(PoseC::from_pose([t[0], t[1], t[2]], q, room))
    };
    m.stack.set_pose(p);
}

/// Dev image (`MESH CTL`): relay `inner` (a whole ClientMessage) to every member WITHOUT the
/// gateway's allow-list check, collecting answers: how the HITL proves members refuse what
/// the allow-list leaves out. Returns the op id, 0 if it could not be sent.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_dev_ctl(m: *mut Mesh, inner: *const u8, len: u32, now_us: i64) -> u32 {
    let m = &mut *m;
    let inner = core::slice::from_raw_parts(inner, len as usize);
    if !m.stack.gate.is_unlocked(CONSOLE_CONN) && m.stack.open_gateway(CONSOLE_CONN).is_err() {
        return 0;
    }
    m.gw.next_op = m.gw.next_op.wrapping_add(1) | 0x4000_0000;
    let op = m.gw.next_op;
    let arm = client_arm(inner).map_or(0, |a| a.0.min(255) as u8);
    match m.stack.send_control_collect(now_us, CONSOLE_CONN, op, Targets::All, inner, arm, REPLY_TIMEOUT_US) {
        Ok(_) => op,
        Err(_) => 0,
    }
}

/// `[mesh] gw ...` counters for `MESH INFO`.
pub fn report(m: &Mesh, w: &mut crate::Buf<'_>) -> core::fmt::Result {
    use core::fmt::Write;
    let g = &m.gw.stats;
    let f = &m.stack.fanout.stats;
    let r = &m.stack.router.stats;
    write!(
        w,
        "[mesh] gw sends={} send_refused={} send_failed={} results={} opened={} sessions={} ops={} complete={} timed_out={} replies_in={} stray={} statuses={} ctl_in={} ctl_refused={} ctl_busy={} ctl_ok={} ctl_failed={} replies={} reply_fail={} envelope={} untrusted={} not_targeted={} epochs_refused={} members={} max_payload={}",
        g.sends,
        g.send_refused,
        g.send_failed,
        g.results,
        g.opened,
        m.stack.gate.any() as u8,
        f.ops,
        f.complete,
        f.timed_out,
        f.replies,
        f.stray_replies,
        f.statuses,
        g.ctl_in,
        g.ctl_refused,
        g.ctl_busy,
        g.ctl_ok,
        g.ctl_failed,
        g.replies,
        g.reply_fail,
        r.envelope,
        r.untrusted,
        r.not_targeted,
        m.stack.epochs_refused,
        m.stack.fanout.live(m.last_tick_us).count(),
        m.stack.node.max_payload(),
    )
}

/// `[mesh] membership ...` for `MESH INFO` (M7): what the HITL checks join, admin and
/// revocation state by. Pending joins as `pend<node>=<key hash>` (the HITL admits by these).
pub(crate) fn report_membership(m: &Mesh, now_us: i64, w: &mut crate::Buf<'_>) -> core::fmt::Result {
    use core::fmt::Write;
    let s = &m.stack;
    let st = s.membership.state;
    let kh = s.key_hash();
    let gs = s.gateway.as_ref();
    write!(
        w,
        "[mesh] membership phase={} mode={} epoch={} admin_key={} site_secret={} persist={} key=",
        crate::phase(s.membership.phase()),
        st.map_or("none", |x| crate::mode_name(x.mode)),
        st.map_or(0, |x| x.epoch),
        st.is_some_and(|x| x.admin_key.is_some()) as u8,
        st.is_some_and(|x| x.site_secret.is_some()) as u8,
        m.persist as u8,
    )?;
    write!(
        w,
        "{:016x} devkey={} revoked={} pending={} gw_session={} roster={} synced={} mesh_s={} groups=",
        u64::from_be_bytes(kh),
        s.dev.ok as u8,
        st.map_or(0, |x| x.revoked.len()),
        s.membership.gateway_pending.iter().flatten().count(),
        gs.map_or(0, |g| g.grant.session),
        gs.map_or(0, |g| g.len()),
        s.sessions.synced(),
        s.mesh_s(now_us),
    )?;
    let g = s.membership.groups();
    if g.is_empty() {
        w.write_str("-")?;
    }
    for (i, id) in g.as_slice().iter().enumerate() {
        write!(w, "{}{id}", if i > 0 { "." } else { "" })?;
    }
    for p in s.membership.gateway_pending.iter().flatten() {
        write!(w, " pend{:04x}={:016x}", p.node, u64::from_be_bytes(p.key_hash))?;
    }
    Ok(())
}


/// `[mesh] admin ...` for `MESH INFO` (M7): sessions, joins, refusals, signed epochs, crypto.
pub(crate) fn report_admin(m: &Mesh, w: &mut crate::Buf<'_>) -> core::fmt::Result {
    use core::fmt::Write;
    let s = &m.stack;
    let ss = &s.sessions.stats;
    let ms = &s.membership.stats;
    let r = &s.router.stats;
    write!(
        w,
        "[mesh] admin grants_ok={} grants_bad={} confirms={} accepted={} held={} bad_mac={} stale={} admitted={} bad_proofs={} joins_pending={} rejoin_revoked={} joined={} untrusted={} refused={} epochs_signed={} epochs_sent={} epochs_unsigned={} epochs_refused={} crypto_jobs={} crypto_us_max={} crypto_us_last={}",
        ss.grants_verified,
        ss.grants_rejected,
        ss.confirms,
        ss.accepted,
        ss.held,
        ss.bad_mac,
        ss.stale,
        ms.joins_admitted,
        ms.bad_proofs,
        ms.joins_pending,
        ms.revoked,
        ms.joined,
        r.untrusted,
        r.refused,
        s.epochs_signed,
        s.epochs_sent,
        s.time.stats.unsigned,
        s.epochs_refused,
        s.crypto_jobs,
        m.crypto_us_max,
        m.crypto_us_last,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// mesh_admin (M7): the hand parser reads what protobuf writes, per op; the answer is the
    /// golden web/tests/meshGateway.test.ts decodes.
    #[test]
    fn mesh_admin_parse_and_answer() {
        // ClientMessage{mesh_admin(101){provision(1){mesh_id 0x1234, site_secret [7; 32],
        // admin_key 0x04.., mode 1, groups [3, 9] packed}}}.
        let mut body = [0u8; 160];
        let mut w = Pb::new(&mut body);
        w.msg(1, |p| {
            p.u(1, 0x1234);
            p.bytes(2, &[7; 32]);
            let mut k = [4u8; 65];
            k[1] = 9;
            p.bytes(3, &k);
            p.u(4, 1);
            p.key(6, 2);
            p.raw_varint(2);
            p.raw_varint(3);
            p.raw_varint(9);
        });
        let n = w.n;
        let mut frame = vec![0xaa, 0x06];
        let mut lenb = [0u8; 4];
        let ln = {
            let mut lw = Pb::new(&mut lenb);
            lw.raw_varint(n as u64);
            lw.n
        };
        frame.extend_from_slice(&lenb[..ln]);
        frame.extend_from_slice(&body[..n]);
        let a = parse_admin(&frame).expect("parsed");
        assert_eq!((a.op, a.v[1], a.v[4], a.n_list, &a.list[..2]), (op::PROVISION, 0x1234, 1, 2, &[3, 9][..]));
        assert_eq!(a.by[2].map(|b| b.len()), Some(32));
        assert_eq!(a.by[3].map(|b| (b.len(), b[1])), Some((65, 9)));
        // groups(6){node 5, groups 4 (unpacked)}: field 2 is the list here, not bytes.
        let g = [0xaa, 0x06, 6, 0x32, 4, 0x08, 5, 0x10, 4];
        let a = parse_admin(&g).unwrap();
        assert_eq!((a.op, a.v[1], a.n_list, a.list[0], a.by[2]), (op::GROUPS, 5, 1, 4, None));
        // leave(5){}; a truncated frame; another arm.
        assert_eq!(parse_admin(&[0xaa, 0x06, 2, 0x2a, 0]).map(|a| a.op), Some(op::LEAVE));
        assert!(parse_admin(&g[..g.len() - 1]).is_none());
        assert!(parse_admin(&[0xa2, 0x06, 0x00]).is_none(), "get_mesh");
        // The mesh off: provision and leave turn it on first; anything else is NO_MESH.
        let mut out = [0u8; 32];
        assert_eq!(app_off(&frame, &mut out), -4);
        assert_eq!(app_off(&[0xaa, 0x06, 2, 0x2a, 0], &mut out), -4);
        let ad = [0xaa, 0x06, 6, 0x1a, 4, 0x08, 5, 0x12, 0];
        let n = app_off(&ad, &mut out) as usize;
        assert_eq!(&out[..n], &[0xba, 0x03, 6, 0x1a, 4, 0x08, 3, 0x10, aerr::NO_MESH as u8]);
        // The mesh could not turn on for a provision: the answer says why (NO_MEMORY and the
        // bytes it needed), not the player core's bare error{unsupported}.
        let n = unsafe { ns_mesh_admin_refuse(frame.as_ptr(), frame.len() as u32, out.as_mut_ptr(), out.len() as u32, aerr::NO_MEMORY, 59232) } as usize;
        assert_eq!(hex(&out[..n]), "ba030a1a080801100a18e0ce03");
        assert_eq!(unsafe { ns_mesh_admin_refuse([0xa2, 0x06, 0x00].as_ptr(), 3, out.as_mut_ptr(), out.len() as u32, aerr::NO_MEMORY, 0) }, -2, "get_mesh");
        // ServerMessage{mesh{admin{op 2, error BAD_GRANT}}}.
        let n = encode_admin(&mut out, op::UNLOCK, aerr::BAD_GRANT, 0, None);
        assert_eq!(hex(&out[..n]), "ba03061a0408021004");
    }

    #[test]
    fn mesh_off_answers_its_own_arms() {
        let mut out = [0u8; 64];
        // get_mesh (ClientMessage field 100, empty) -> ServerMessage{mesh(55){state(2){}}}.
        let n = app_off(&[0xa2, 0x06, 0x00], &mut out);
        assert_eq!(&out[..n as usize], &[0xba, 0x03, 0x02, 0x12, 0x00]);
        // mesh_send (field 99) -> mesh{result(1){error: NO_MESH}}, op_id echoed.
        let send = [0x9a, 0x06, 0x02, 0x08, 0x07];
        let n = app_off(&send, &mut out) as usize;
        assert_eq!(&out[..2], &[0xba, 0x03]);
        let body = &out[..n];
        assert!(body.windows(2).any(|w| w == [0x08, 0x07]), "op_id 7: {body:02x?}");
        assert!(body.windows(2).any(|w| w == [0x10, err::NO_MESH as u8]), "NO_MESH: {body:02x?}");
        // Anything else is not the mesh's.
        assert_eq!(app_off(&[0x0a, 0x00], &mut out), -2);
    }

    #[test]
    fn pb_nested_and_parse_send() {
        // MeshSend{op 7, targets{nodes [0x1234, 5] packed, skip_gateway}, inner, want_reply,
        // timeout 1500, lead 150} as protobuf-es writes it.
        let inner = [0xfa, 0x01, 5, 0x0d, 0, 0, 0, 0x3f];
        let mut body = [0u8; 64];
        let mut w = Pb::new(&mut body);
        w.u(1, 7);
        w.msg(2, |t| {
            t.key(1, 2);
            t.raw_varint(3);
            t.raw_varint(0x1234);
            t.raw_varint(5);
            t.u(3, 1);
        });
        w.key(3, 2);
        w.raw_varint(inner.len() as u64);
        for b in inner {
            w.byte(b);
        }
        w.u(4, 1);
        w.u(5, 1500);
        w.u(6, 150);
        let n = w.n;
        let mut frame = vec![0x9a, 0x06, n as u8];
        frame.extend_from_slice(&body[..n]);
        let s = parse_send(&frame).unwrap();
        assert_eq!((s.op_id, s.n_nodes, &s.nodes[..2], s.skip_gateway, s.inner, s.want_reply, s.timeout_ms, s.lead_ms), (7, 2, &[0x1234, 5][..], true, &inner[..], true, 1500, 150));
        assert_eq!(s.targets(), Targets::nodes(&[0x1234, 5]).unwrap());
        // Unpacked repeated, a group, and an unknown field are fine; a truncated one is not.
        let t = [0x9a, 0x06, 8, 0x12, 4, 0x08, 9, 0x10, 3, 0x48, 1];
        let s = parse_send(&t).unwrap();
        assert_eq!((s.n_nodes, s.nodes[0], s.group), (1, 9, 3));
        assert!(parse_send(&t[..t.len() - 1]).is_none());
        assert!(parse_send(&inner).is_none(), "not a mesh_send");
    }

    /// ServerMessage{mesh{result{op 9, members [{0x11, 12 ms}, {0x22, REFUSED 27, 300 ms}],
    /// complete, apply_at 1234}}}.
    const MESH_RESULT_GOLDEN: &str = "ba031a0a1808091a040811200c1a0908221002181b20ac02200128d209";

    fn hex(b: &[u8]) -> std::string::String {
        b.iter().map(|x| std::format!("{x:02x}")).collect()
    }

    /// `MeshMember{node 0x1234, hops 2, pose{room "Hall", translation [1.5, 0, -2], rotation
    /// (90° about y)}, neighbours [{0x2001, -41, 97 %}, {0x2002, -70}], topology_ms_ago 1500,
    /// pose_state SET}`: web/tests/meshTopology.test.ts decodes the same bytes with protobuf-es.
    const MEMBER_TOPO_GOLDEN: &str = "08b42470029001027a260a0448616c6c120c0000c03f00000000000000c01a10000000006a05353f000000007c04353f82010708814010511861820106088240108b018801dc0b";

    fn golden_topo() -> Topo {
        let mut t = Topo::EMPTY;
        let pose = PoseKnown::Posed(PoseC::from_pose([1.5, 0.0, -2.0], Some([0.0, 0.70710677, 0.0, 0.70710677]), b"Hall"));
        let mut links = [Link::EMPTY; topo::NEIGHBOURS];
        links[0] = Link { node: 0x2001, rssi: -41, tx_pct: 97, range: None };
        links[1] = Link { node: 0x2002, rssi: -70, tx_pct: TX_UNKNOWN, range: None };
        t.apply(1_000_000, &splanc_mesh::topo::TopoMsg { pose, pose_gen: 1, n: 2, links });
        t.hops = 2;
        t
    }

    #[test]
    fn member_topology_golden() {
        let mut b = [0u8; 160];
        let mut w = Pb::new(&mut b);
        w.u(1, 0x1234);
        write_member_topo(&mut w, &golden_topo(), 2_500_000);
        assert!(w.ok);
        let n = w.n;
        assert_eq!(hex(&b[..n]), MEMBER_TOPO_GOLDEN);
    }

    #[test]
    fn get_mesh_topology_flag() {
        // get_mesh{} / get_mesh{topology: true} / get_mesh{topology, topology_from 5, unknown 9}
        assert_eq!(parse_get_mesh(&[0xa2, 0x06, 0x00]), None);
        assert_eq!(parse_get_mesh(&[0xa2, 0x06, 0x02, 0x08, 0x01]), Some(TopoAsk { from: 0 }));
        assert_eq!(parse_get_mesh(&[0xa2, 0x06, 0x06, 0x08, 0x01, 0x10, 0x05, 0x48, 0x01]), Some(TopoAsk { from: 5 }));
        assert_eq!(parse_get_mesh(&[0xa2, 0x06, 0x02, 0x08, 0x00]), None, "topology: false");
        assert_eq!(parse_get_mesh(&[0xa2, 0x06, 0x02, 0x08]), None, "truncated");
    }

    /// A 16-fixture mesh's topology does not fit one 2 KB frame: get_mesh{topology} pages it
    /// (MeshState.topology_next), every page decodes with the host profile, and together they
    /// carry every member's pose and neighbours once; get_mesh{} is unchanged (no topology).
    #[test]
    fn get_mesh_topology_pages_through_a_full_mesh() {
        // The host profile's ServerMessage is large: decode on a roomy stack.
        std::thread::Builder::new().stack_size(64 << 20).spawn(topology_pages).unwrap().join().unwrap();
    }

    fn topology_pages() {
        use ledmapper_pb::ledmapper_::v1_ as pb;
        use micropb::MessageDecode;
        let mut block = std::vec![0u8; crate::ns_mesh_size() as usize];
        let mac = [0x8c, 0xfd, 0x49, 0x12, 0x31, 0x70];
        let m = unsafe { crate::ns_mesh_create(block.as_mut_ptr(), crate::ns_mesh_size(), mac.as_ptr(), 1, 0, 0) };
        let mut t = 0;
        unsafe {
            crate::ns_mesh_dev_provision(m, 0x5350_4C33, [7u8; 32].as_ptr(), 1, 0);
            while t < 6_000_000 {
                t += 5_000;
                crate::ns_mesh_tick(m, t, 1, 1);
            }
            ns_mesh_pose(m, 1, [0.25f32, 1.0, 0.0].as_ptr(), core::ptr::null(), b"Living room".as_ptr(), 11);
        }
        let m = unsafe { &mut *m };
        assert!(m.stack.membership.is_member());
        let base = golden_topo();
        for i in 0..15u16 {
            let mb = m.stack.fanout.touch(t, 0x4000 + i);
            mb.status = Some(StatusMsg { firmware: 0xdead_beef, uptime_s: 3600, heap_free: 52_000, heap_min: 31_000, fps: 80, brightness: 255, sync: 2, time_err_us: 40, last_error: 0, last_error_op: 0 });
            let mut tp = base;
            tp.n = topo::NEIGHBOURS as u8;
            for (k, l) in tp.links.iter_mut().enumerate() {
                // Neighbour 3 is ranged (uncalibrated: the reporter in phase state 41, it in 39).
                let range = (k == 3).then_some(RangeC { range_cm: 245, sigma_cm: 12, flags: 2 | (1 << 2) });
                *l = Link { node: 0x4000 + k as u16, rssi: -40 - k as i8, tx_pct: 90 + k as u8, range };
            }
            tp.pose = PoseKnown::Posed(PoseC::from_pose([i as f32, 0.5, -1.0], Some([0.1, 0.2, 0.3, 0.9]), b"A long room name!"));
            mb.topo = tp;
        }
        let decode = |b: &[u8]| -> pb::MeshState {
            let mut sm = pb::ServerMessage::default();
            sm.decode_from_bytes(b).expect("decodes");
            match sm.msg {
                Some(pb::ServerMessage_::Msg::Mesh(i)) => match i.info {
                    Some(pb::MeshInfo_::Info::State(s)) => s,
                    o => panic!("{o:?}"),
                },
                o => panic!("{o:?}"),
            }
        };
        let mut out = [0u8; 2048];
        let n = encode_state(m, 0, t, &mut out, None);
        let plain = decode(&out[..n]);
        assert_eq!(plain.members.len(), 15);
        assert!(plain.members.iter().all(|x| x.neighbours.is_empty() && x.hops == 0 && x.pose().is_none()));
        assert!(plain.neighbours.is_empty() && plain.topology_next == 0);
        let mut from = 0usize;
        let mut got = std::vec::Vec::new();
        let mut pages = 0;
        loop {
            let n = encode_state(m, 0, t, &mut out, Some(TopoAsk { from }));
            assert!(n > 0, "page from {from} does not fit");
            let st = decode(&out[..n]);
            pages += 1;
            assert_eq!(st.members.len(), 15, "every page lists every member");
            assert_eq!(st.pose_state, pb::MeshPoseState::MeshPoseSet);
            let p = st.pose().expect("own pose");
            assert_eq!((p.room.as_str(), &p.translation[..]), ("Living room", &[0.25f32, 1.0, 0.0][..]));
            for mm in st.members.iter().filter(|x| !x.neighbours.is_empty()) {
                assert_eq!((mm.hops, mm.neighbours.len(), mm.pose_state), (2, 8, pb::MeshPoseState::MeshPoseSet));
                let pp = mm.pose().unwrap();
                assert_eq!((pp.room.as_str(), pp.rotation.len()), ("A long room name", 4), "cut to 16 bytes");
                assert_eq!(mm.neighbours[3].rssi, -43);
                assert_eq!(mm.neighbours[3].tx_ok_pct(), Some(&93));
                let r = &mm.neighbours[3];
                assert_eq!((r.range_m(), r.range_sigma_m()), (Some(&2.45), Some(&0.12)));
                assert_eq!((r.range_phase_self, r.range_phase_peer, r.range_calibrated), (41, 39, false));
                assert_eq!((mm.neighbours[2].range_m(), mm.neighbours[2].range_phase_self), (None, 0));
                got.push(mm.node);
            }
            if st.topology_next == 0 {
                break;
            }
            assert!(st.topology_next as usize > from);
            from = st.topology_next as usize;
        }
        got.sort();
        got.dedup();
        assert_eq!(got.len(), 15, "each member's topology once");
        assert!(pages >= 2, "a full mesh needs more than one 2 KB page");
        std::println!("get_mesh topology: 15 members in {pages} pages");
    }

    #[test]
    fn encodes_a_result_a_microproto_decoder_reads() {
        let mut r = OpResult::<4> { op_id: 9, conn: 0, arm: 31, started_us: 0, deadline_us: 0, n: 2, nodes: [0x11, 0x22, 0, 0], status: [Status::Ok, Status::Refused, Status::Missing, Status::Missing], code: [0, 27, 0, 0], latency_ms: [12, 300, 0, 0], complete: true };
        r.complete = true;
        let mut out = [0u8; 128];
        let n = encode_result(&mut out, 9, err::OK, Some(&r), Some(1234), 0);
        // The same golden web/tests/meshGateway.test.ts decodes with protobuf-es (and encodes back).
        assert_eq!(hex(&out[..n]), MESH_RESULT_GOLDEN);
        // Too small: nothing.
        assert_eq!(encode_result(&mut [0u8; 8], 9, err::OK, Some(&r), None, 0), 0);
    }
}
