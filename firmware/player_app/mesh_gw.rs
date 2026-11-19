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

use splanc_mesh::gateway::{self, client_arm, relay_arm, with_apply_at, OpResult, ReplyMsg, Status, StatusMsg};
use splanc_mesh::meshtime::SyncState;
use splanc_mesh::ports::Targets;
use splanc_mesh::stack::{EpochSource, SendError, REPLY_TIMEOUT_US};
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
    /// A sint32 (zigzag).
    pub fn s(&mut self, f: u32, v: i32) {
        self.u(f, ((v << 1) ^ (v >> 31)) as u32 as u64);
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

fn send_err(e: SendError) -> u32 {
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

/// `ServerMessage{mesh{state}}` for connection `conn` into `out`.
pub fn encode_state(m: &Mesh, conn: usize, now_us: i64, out: &mut [u8]) -> usize {
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
            for mb in s.fanout.live(now_us).filter(|mb| mb.node != s.me()) {
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
                });
            }
            if let Some(r) = s.fanout.last.as_ref() {
                let (gs, at) = m.gw.local_of(r.op_id);
                st.msg(12, |res| write_result(res, r.op_id, err::OK, Some(r), at, gs));
            }
        });
    });
    if w.ok {
        w.n
    } else {
        0
    }
}

/// The player's local epoch (ms, esp_timer domain) as the mesh last mapped it.
fn local_epoch_ms(m: &Mesh) -> Option<i64> {
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
            encode_state(m, conn, now_us, out) as i32
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

/// Check, schedule and send one `mesh_send`. Ok: (the rescheduled inner's length in
/// `m.gw.out`, if it was rescheduled; its apply_at_ms).
fn gateway_send(m: &mut Mesh, conn: usize, op: u32, s: &Send<'_>, now_us: i64) -> Result<(Option<usize>, Option<u32>), u32> {
    if !m.stack.membership.is_member() {
        return Err(err::NO_MESH);
    }
    if !m.stack.gate.is_unlocked(conn) {
        // The first mesh arm on a connection opens the session (envelope trust).
        m.stack.open_gateway(conn).map_err(|_| err::LOCKED)?;
        m.gw.stats.opened += 1;
        m.log(format_args!("[mesh] gateway session open conn={conn}"));
    }
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
    if m.stack.gate.is_unlocked(c) {
        m.log(format_args!("[mesh] gateway session closed conn={c}"));
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

#[cfg(test)]
mod tests {
    use super::*;

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
