//! Gateway fan-out and aggregation (design §8.2, mesh M5): what a fixture the app is connected
//! to needs to command the whole mesh, and what a member needs to answer it.
//!
//! - **The relay allow-list** ([`relay_arm`]): the `ClientMessage` arms a member dispatches
//!   when they arrive over the mesh. Live look control only: effect selection, uniforms,
//!   brightness, crossfade, keypoint blends, and an effect upload small enough for one mesh
//!   packet. Never firmware updates, renames, Wi-Fi credentials or policy, trust, kiosk, or
//!   anything that reads bulk state. The gateway checks it before sending; every member checks
//!   it again before dispatching (a member never trusts the sender's check).
//! - **Scheduling** ([`with_apply_at`]): the gateway stamps `apply_at_ms` (on the mesh's show
//!   clock, which every member's time base follows, M4) into a discrete change, so the
//!   gateway and every member apply it on the same frame.
//! - **Replies** ([`ReplyMsg`], `REPLY` port, ACKed unicast to the gateway): op id, status,
//!   the inner arm and an error code.
//! - **Member status** ([`StatusMsg`], `STATUS` port, broadcast every 10 s and on change):
//!   firmware, uptime, heap, fps, brightness, mesh-time state and error, last error.
//! - **Aggregation** ([`Fanout`]): the gateway's member table (from adverts, status and
//!   replies) and its pending operations; an operation completes when every expected member
//!   answered or its timeout passed, and becomes one [`OpResult`] (the app's `MeshResult`).
//!
//! Fixed-size, no allocation; wire formats big-endian like the rest of the layer.

use crate::backhaul::NodeId;
use crate::ports::Targets;

/// `ClientMessage` arm numbers (ledmapper.proto) the relay policy names.
pub mod arm {
    pub const SUBMIT_EFFECT: u32 = 21;
    pub const SET_EFFECT: u32 = 22;
    pub const SET_UNIFORMS: u32 = 23;
    pub const SET_DEVICE_NAME: u32 = 27;
    pub const SET_BRIGHTNESS: u32 = 31;
    pub const SET_TIME_BASE: u32 = 38;
    pub const SET_CROSSFADE: u32 = 39;
    pub const BLEND_KEYPOINTS: u32 = 44;
    pub const OTA_BEGIN: u32 = 70;
    pub const SET_WIFI_POLICY: u32 = 90;
    pub const MESH_SEND: u32 = 99;
    pub const GET_MESH: u32 = 100;
    /// Membership and administration (mesh M7): never relayed.
    pub const MESH_ADMIN: u32 = 101;
}

/// The arms a member dispatches from the mesh (module docs).
pub const RELAYED: [u32; 6] = [arm::SUBMIT_EFFECT, arm::SET_EFFECT, arm::SET_UNIFORMS, arm::SET_BRIGHTNESS, arm::SET_CROSSFADE, arm::BLEND_KEYPOINTS];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refuse {
    /// Not one protobuf `ClientMessage` arm (length-delimited, exactly the whole buffer).
    Malformed,
    /// A real arm, not on the allow-list.
    NotAllowed(u32),
}

impl Refuse {
    /// The code a member reports (and the gateway's `MeshResult` carries): the arm, or 0.
    pub fn code(self) -> u16 {
        match self {
            Refuse::Malformed => 0,
            Refuse::NotAllowed(a) => a.min(u16::MAX as u32) as u16,
        }
    }
}

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

fn put_varint(mut v: u64, out: &mut [u8], o: &mut usize) -> Option<()> {
    loop {
        let b = (v & 0x7f) as u8;
        v >>= 7;
        *out.get_mut(*o)? = if v == 0 { b } else { b | 0x80 };
        *o += 1;
        if v == 0 {
            return Some(());
        }
    }
}

/// The arm of one encoded `ClientMessage` and its body's range (`key ‖ len ‖ body`, nothing
/// after it).
pub fn client_arm(inner: &[u8]) -> Option<(u32, core::ops::Range<usize>)> {
    let mut o = 0;
    let key = varint(inner, &mut o)?;
    if key & 7 != 2 || key >> 3 == 0 || key >> 3 > u32::MAX as u64 {
        return None;
    }
    let len = varint(inner, &mut o)? as usize;
    if o.checked_add(len)? != inner.len() {
        return None;
    }
    Some(((key >> 3) as u32, o..inner.len()))
}

/// The allow-list check: the inner's arm if a member may dispatch it.
pub fn relay_arm(inner: &[u8]) -> Result<u32, Refuse> {
    let (a, _) = client_arm(inner).ok_or(Refuse::Malformed)?;
    if RELAYED.contains(&a) {
        Ok(a)
    } else {
        Err(Refuse::NotAllowed(a))
    }
}

/// The `apply_at_ms` field number of a schedulable arm (ledmapper.proto).
pub fn apply_at_field(arm: u32) -> Option<u32> {
    match arm {
        arm::SET_EFFECT => Some(3),
        arm::SET_UNIFORMS => Some(5),
        arm::SET_BRIGHTNESS => Some(2),
        arm::SET_CROSSFADE => Some(4),
        _ => None,
    }
}

/// Does the message body carry field `f` (top level)?
fn has_field(body: &[u8], f: u32) -> Option<bool> {
    let mut o = 0;
    while o < body.len() {
        let key = varint(body, &mut o)?;
        if (key >> 3) as u32 == f {
            return Some(true);
        }
        match key & 7 {
            0 => {
                varint(body, &mut o)?;
            }
            1 => o += 8,
            2 => {
                let n = varint(body, &mut o)? as usize;
                o = o.checked_add(n)?;
            }
            5 => o += 4,
            _ => return None,
        }
    }
    (o == body.len()).then_some(false)
}

/// `inner` with `apply_at_ms = at` added to its body, into `out`; None if the arm is not
/// schedulable, already carries one, or `out` is too small (the caller then sends it as is).
pub fn with_apply_at(inner: &[u8], at: u32, out: &mut [u8]) -> Option<usize> {
    let (a, body) = client_arm(inner)?;
    let f = apply_at_field(a)?;
    if has_field(&inner[body.clone()], f)? {
        return None;
    }
    let mut extra = [0u8; 12];
    let mut k = 0;
    put_varint(u64::from(f) << 3, &mut extra, &mut k)?;
    put_varint(u64::from(at), &mut extra, &mut k)?;
    let mut o = 0;
    put_varint((u64::from(a) << 3) | 2, out, &mut o)?;
    put_varint((body.len() + k) as u64, out, &mut o)?;
    let blen = body.len();
    out.get_mut(o..o + blen)?.copy_from_slice(&inner[body]);
    o += blen;
    out.get_mut(o..o + k)?.copy_from_slice(&extra[..k]);
    Some(o + k)
}

/// A member's answer to one relayed control.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Status {
    Ok = 0,
    /// No answer before the operation's timeout (the gateway's verdict, never sent).
    Missing = 1,
    /// Not on the allow-list (or malformed): not dispatched.
    Refused = 2,
    /// Dispatched; the player answered with an error.
    Failed = 3,
}

impl Status {
    pub fn from_u8(v: u8) -> Option<Status> {
        Some(match v {
            0 => Status::Ok,
            1 => Status::Missing,
            2 => Status::Refused,
            3 => Status::Failed,
            _ => return None,
        })
    }
}

/// `REPLY` port body: `'R' ‖ op_id (4) ‖ status (1) ‖ arm (1) ‖ code (2)`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ReplyMsg {
    pub op_id: u32,
    pub status: Status,
    pub arm: u8,
    pub code: u16,
}

pub const T_REPLY: u8 = b'R';
pub const REPLY_LEN: usize = 9;

impl ReplyMsg {
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let o = out.get_mut(..REPLY_LEN)?;
        o[0] = T_REPLY;
        o[1..5].copy_from_slice(&self.op_id.to_be_bytes());
        o[5] = self.status as u8;
        o[6] = self.arm;
        o[7..9].copy_from_slice(&self.code.to_be_bytes());
        Some(REPLY_LEN)
    }

    pub fn decode(b: &[u8]) -> Option<ReplyMsg> {
        if b.len() != REPLY_LEN || b[0] != T_REPLY {
            return None;
        }
        Some(ReplyMsg { op_id: u32::from_be_bytes(b[1..5].try_into().ok()?), status: Status::from_u8(b[5])?, arm: b[6], code: u16::from_be_bytes([b[7], b[8]]) })
    }
}

/// `STATUS` port tag of a member status (next to `T_PROBE` / `T_PENDING_JOIN`).
pub const T_STATUS: u8 = 0x23;
pub const STATUS_LEN: usize = 27;
/// A member broadcasts its status this often, and on a change of state.
pub const STATUS_EVERY_US: i64 = 10_000_000;
/// A member is listed while heard (advert, status, reply) within this long.
pub const MEMBER_STALE_US: i64 = 30_000_000;

/// A member's status (design §5.4, the compact subset a C6 gateway keeps).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct StatusMsg {
    pub firmware: u32,
    pub uptime_s: u32,
    pub heap_free: u32,
    pub heap_min: u32,
    pub fps: u16,
    /// 0..=255 (brightness × 255).
    pub brightness: u8,
    /// Mesh time: 0 unsynced, 1 forming, 2 synced.
    pub sync: u8,
    /// Mesh-time error estimate (µs, saturating).
    pub time_err_us: u16,
    /// The last relayed control this member refused or failed (its code), 0 if none.
    pub last_error: u16,
    /// The op id of that control.
    pub last_error_op: u32,
}

impl StatusMsg {
    pub fn encode(&self, out: &mut [u8]) -> Option<usize> {
        let o = out.get_mut(..STATUS_LEN)?;
        o[0] = T_STATUS;
        o[1..5].copy_from_slice(&self.firmware.to_be_bytes());
        o[5..9].copy_from_slice(&self.uptime_s.to_be_bytes());
        o[9..13].copy_from_slice(&self.heap_free.to_be_bytes());
        o[13..17].copy_from_slice(&self.heap_min.to_be_bytes());
        o[17..19].copy_from_slice(&self.fps.to_be_bytes());
        o[19] = self.brightness;
        o[20] = self.sync;
        o[21..23].copy_from_slice(&self.time_err_us.to_be_bytes());
        o[23..25].copy_from_slice(&self.last_error.to_be_bytes());
        // The op id's low 16 bits: enough to match it to the app's recent ops.
        o[25..27].copy_from_slice(&(self.last_error_op as u16).to_be_bytes());
        Some(STATUS_LEN)
    }

    pub fn decode(b: &[u8]) -> Option<StatusMsg> {
        if b.len() != STATUS_LEN || b[0] != T_STATUS {
            return None;
        }
        let u32_at = |i: usize| u32::from_be_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]);
        let u16_at = |i: usize| u16::from_be_bytes([b[i], b[i + 1]]);
        Some(StatusMsg {
            firmware: u32_at(1),
            uptime_s: u32_at(5),
            heap_free: u32_at(9),
            heap_min: u32_at(13),
            fps: u16_at(17),
            brightness: b[19],
            sync: b[20],
            time_err_us: u16_at(21),
            last_error: u16_at(23),
            last_error_op: u32::from(u16_at(25)),
        })
    }

    /// A change worth an early broadcast (not the counters that move every second).
    pub fn differs(&self, o: &StatusMsg) -> bool {
        self.sync != o.sync || self.brightness != o.brightness || self.last_error != o.last_error || self.last_error_op != o.last_error_op || self.firmware != o.firmware
    }
}

/// One member as the gateway knows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Member {
    pub node: NodeId,
    pub seen_us: i64,
    pub status: Option<StatusMsg>,
    pub status_us: i64,
}

/// One relayed control the gateway is collecting answers for (or has finished).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct OpResult<const N: usize> {
    pub op_id: u32,
    /// The app connection that sent it (where the result is pushed).
    pub conn: usize,
    pub arm: u8,
    pub started_us: i64,
    pub deadline_us: i64,
    pub n: usize,
    pub nodes: [NodeId; N],
    /// [`Status`] per node (`Missing` until it answers).
    pub status: [Status; N],
    pub code: [u16; N],
    /// ms from sending to the answer.
    pub latency_ms: [u16; N],
    /// Every expected member answered (vs. the timeout ran out).
    pub complete: bool,
}

impl<const N: usize> OpResult<N> {
    pub fn answered(&self) -> usize {
        self.status[..self.n].iter().filter(|s| **s != Status::Missing).count()
    }
}

/// Operations a gateway collects at once (the oldest is finished early to make room).
pub const OPS: usize = 4;
/// Finished results waiting for the device to push them.
pub const DONE: usize = 2;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct FanoutStats {
    pub ops: u32,
    pub complete: u32,
    pub timed_out: u32,
    pub replies: u32,
    pub stray_replies: u32,
    pub statuses: u32,
    pub evicted: u32,
}

/// The gateway's member table and pending operations (`N` members).
pub struct Fanout<const N: usize> {
    pub members: [Option<Member>; N],
    ops: [Option<OpResult<N>>; OPS],
    done: [Option<OpResult<N>>; DONE],
    /// The last finished operation (`MeshState.last_result`).
    pub last: Option<OpResult<N>>,
    pub stats: FanoutStats,
}

impl<const N: usize> Default for Fanout<N> {
    fn default() -> Self {
        Self::new()
    }
}

impl<const N: usize> Fanout<N> {
    pub const fn new() -> Self {
        Fanout {
            members: [None; N],
            ops: [None; OPS],
            done: [None; DONE],
            last: None,
            stats: FanoutStats { ops: 0, complete: 0, timed_out: 0, replies: 0, stray_replies: 0, statuses: 0, evicted: 0 },
        }
    }

    /// `node` was heard from (an advert, a status, a reply): keep it listed.
    pub fn touch(&mut self, now_us: i64, node: NodeId) -> &mut Member {
        let i = self
            .members
            .iter()
            .position(|m| m.is_some_and(|m| m.node == node))
            .or_else(|| self.members.iter().position(|m| m.is_none()))
            .unwrap_or_else(|| (0..N).min_by_key(|&i| self.members[i].map_or(i64::MIN, |m| m.seen_us)).unwrap_or(0));
        let m = self.members[i].get_or_insert(Member { node, seen_us: now_us, status: None, status_us: 0 });
        if m.node != node {
            *m = Member { node, seen_us: now_us, status: None, status_us: 0 };
        }
        m.seen_us = now_us;
        m
    }

    /// `node` left the mesh (ejected or revoked by the admin): stop listing it now, not
    /// [`MEMBER_STALE_US`] later.
    pub fn forget(&mut self, node: NodeId) {
        for m in self.members.iter_mut() {
            if m.is_some_and(|m| m.node == node) {
                *m = None;
            }
        }
    }

    pub fn on_status(&mut self, now_us: i64, node: NodeId, s: StatusMsg) {
        self.stats.statuses += 1;
        let m = self.touch(now_us, node);
        m.status = Some(s);
        m.status_us = now_us;
    }

    /// Members heard within [`MEMBER_STALE_US`].
    pub fn live(&self, now_us: i64) -> impl Iterator<Item = &Member> {
        self.members.iter().flatten().filter(move |m| now_us - m.seen_us < MEMBER_STALE_US)
    }

    /// Start collecting answers to `op_id` from the live members `targets` names (all live
    /// members for `All` and a group: the gateway does not know their groups; a member outside
    /// the group never answers and is reported missing).
    pub fn begin(&mut self, now_us: i64, conn: usize, op_id: u32, arm: u8, targets: &Targets, timeout_us: i64, me: NodeId) -> usize {
        let mut r = OpResult { op_id, conn, arm, started_us: now_us, deadline_us: now_us + timeout_us.max(1), n: 0, nodes: [0; N], status: [Status::Missing; N], code: [0; N], latency_ms: [0; N], complete: false };
        let mut add = |r: &mut OpResult<N>, id: NodeId| {
            if id != me && r.n < N && !r.nodes[..r.n].contains(&id) {
                r.nodes[r.n] = id;
                r.n += 1;
            }
        };
        match targets {
            Targets::Nodes { ids, n } => ids[..*n as usize].iter().for_each(|&id| add(&mut r, id)),
            _ => {
                let live: [Option<NodeId>; N] = core::array::from_fn(|i| self.members[i].filter(|m| now_us - m.seen_us < MEMBER_STALE_US).map(|m| m.node));
                live.iter().flatten().for_each(|&id| add(&mut r, id));
            }
        }
        self.stats.ops += 1;
        let n = r.n;
        if n == 0 {
            r.complete = true;
            self.finish(r);
            return 0;
        }
        let slot = match self.ops.iter().position(|o| o.is_none()) {
            Some(i) => i,
            None => {
                // Finish the oldest early to make room.
                let i = (0..OPS).min_by_key(|&i| self.ops[i].map_or(i64::MAX, |o| o.started_us)).unwrap_or(0);
                if let Some(o) = self.ops[i].take() {
                    self.stats.evicted += 1;
                    self.finish(o);
                }
                i
            }
        };
        self.ops[slot] = Some(r);
        n
    }

    pub fn on_reply(&mut self, now_us: i64, from: NodeId, r: &ReplyMsg) {
        self.touch(now_us, from);
        let Some(i) = self.ops.iter().position(|o| o.is_some_and(|o| o.op_id == r.op_id)) else {
            self.stats.stray_replies += 1;
            return;
        };
        let o = self.ops[i].as_mut().expect("found");
        let Some(k) = o.nodes[..o.n].iter().position(|&n| n == from) else {
            // Not expected (it joined after the send): note it, if there is room.
            if o.n < N {
                o.nodes[o.n] = from;
                o.n += 1;
                return self.on_reply(now_us, from, r);
            }
            self.stats.stray_replies += 1;
            return;
        };
        self.stats.replies += 1;
        o.status[k] = r.status;
        o.code[k] = r.code;
        o.latency_ms[k] = ((now_us - o.started_us).max(0) / 1_000).min(u16::MAX as i64) as u16;
        if o.answered() == o.n {
            let mut o = self.ops[i].take().expect("found");
            o.complete = true;
            self.stats.complete += 1;
            self.finish(o);
        }
    }

    /// Time out what is due.
    pub fn poll(&mut self, now_us: i64) {
        for i in 0..OPS {
            if self.ops[i].is_some_and(|o| now_us >= o.deadline_us) {
                let o = self.ops[i].take().expect("due");
                self.stats.timed_out += 1;
                self.finish(o);
            }
        }
    }

    fn finish(&mut self, o: OpResult<N>) {
        self.last = Some(o);
        match self.done.iter().position(|d| d.is_none()) {
            Some(i) => self.done[i] = Some(o),
            None => {
                // The device is not draining: keep the newest.
                self.done.rotate_left(1);
                self.done[DONE - 1] = Some(o);
            }
        }
    }

    /// The next finished operation to push to the app.
    pub fn take_done(&mut self) -> Option<OpResult<N>> {
        let i = self.done.iter().position(|d| d.is_some())?;
        self.done[i].take()
    }

    pub fn pending(&self) -> usize {
        self.ops.iter().flatten().count()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// set_brightness{brightness: 0.5} as the app encodes it (field 31, LEN; float field 1).
    fn brightness() -> Vec<u8> {
        let body = [0x0d, 0, 0, 0, 0x3f];
        let mut v = vec![0xfa, 0x01, body.len() as u8];
        v.extend_from_slice(&body);
        v
    }

    #[test]
    fn allow_list() {
        assert_eq!(relay_arm(&brightness()), Ok(arm::SET_BRIGHTNESS));
        // set_device_name{name: "x"} (27), ota_begin{} (70), set_wifi_policy{} (90).
        assert_eq!(relay_arm(&[0xda, 0x01, 3, 0x0a, 1, b'x']), Err(Refuse::NotAllowed(27)));
        assert_eq!(relay_arm(&[0xb2, 0x04, 0]), Err(Refuse::NotAllowed(70)));
        assert_eq!(relay_arm(&[0xd2, 0x05, 0]), Err(Refuse::NotAllowed(90)));
        // Trailing bytes, a varint arm, a short body, nothing.
        let mut b = brightness();
        b.push(0);
        assert_eq!(relay_arm(&b), Err(Refuse::Malformed));
        assert_eq!(relay_arm(&[0xf8, 0x01, 1]), Err(Refuse::Malformed));
        assert_eq!(relay_arm(&brightness()[..4]), Err(Refuse::Malformed));
        assert_eq!(relay_arm(&[]), Err(Refuse::Malformed));
        assert_eq!(Refuse::NotAllowed(27).code(), 27);
    }

    #[test]
    fn apply_at_is_added_once() {
        let mut out = [0u8; 32];
        let n = with_apply_at(&brightness(), 300_000, &mut out).unwrap();
        // field 2 varint 300000 = 0x10 0xe0 0xa7 0x12
        assert_eq!(&out[..n], &[0xfa, 0x01, 9, 0x0d, 0, 0, 0, 0x3f, 0x10, 0xe0, 0xa7, 0x12]);
        assert_eq!(client_arm(&out[..n]).unwrap().0, arm::SET_BRIGHTNESS);
        // Already scheduled: left alone.
        assert_eq!(with_apply_at(&out[..n].to_vec(), 5, &mut [0u8; 32]), None);
        // Not schedulable (blend_keypoints), or no room.
        assert_eq!(with_apply_at(&[0xe2, 0x02, 0], 5, &mut out), None);
        assert_eq!(with_apply_at(&brightness(), 5, &mut [0u8; 8]), None);
    }

    #[test]
    fn reply_and_status_roundtrip() {
        let r = ReplyMsg { op_id: 0xdead_beef, status: Status::Refused, arm: 27, code: 27 };
        let mut b = [0u8; 16];
        let n = r.encode(&mut b).unwrap();
        assert_eq!(ReplyMsg::decode(&b[..n]), Some(r));
        assert_eq!(ReplyMsg::decode(&b[..n - 1]), None);
        let s = StatusMsg { firmware: 7, uptime_s: 99, heap_free: 52_000, heap_min: 30_000, fps: 80, brightness: 128, sync: 2, time_err_us: 40, last_error: 27, last_error_op: 0x1234 };
        let mut b = [0u8; 32];
        let n = s.encode(&mut b).unwrap();
        assert_eq!(n, STATUS_LEN);
        assert_eq!(StatusMsg::decode(&b[..n]), Some(s));
        assert!(s.differs(&StatusMsg { brightness: 1, ..s }));
        assert!(!s.differs(&StatusMsg { uptime_s: 100, heap_free: 1, ..s }));
    }

    #[test]
    fn op_completes_on_every_answer_or_times_out() {
        let mut f = Fanout::<4>::new();
        f.touch(0, 2);
        f.touch(0, 3);
        f.touch(0, 1); // the gateway itself (never expected)
        assert_eq!(f.begin(100, 0, 7, 31, &Targets::All, 2_000_000, 1), 2);
        f.on_reply(5_100, 2, &ReplyMsg { op_id: 7, status: Status::Ok, arm: 31, code: 0 });
        assert!(f.take_done().is_none());
        f.on_reply(9_100, 3, &ReplyMsg { op_id: 7, status: Status::Refused, arm: 31, code: 31 });
        let r = f.take_done().unwrap();
        assert!(r.complete);
        assert_eq!((r.n, &r.status[..2], r.latency_ms[0], r.latency_ms[1]), (2, &[Status::Ok, Status::Refused][..], 5, 9));
        // An ejected member drops out at once.
        f.touch(200, 9);
        assert_eq!(f.live(300).filter(|m| m.node == 9).count(), 1);
        f.forget(9);
        assert_eq!(f.live(300).filter(|m| m.node == 9).count(), 0);
        // A stale member drops out of "all"; a timeout reports the silent one missing.
        assert_eq!(f.begin(MEMBER_STALE_US + 10_000, 0, 8, 31, &Targets::All, 1_000, 1), 0);
        assert!(f.take_done().unwrap().complete);
        assert_eq!(f.begin(0, 1, 9, 22, &Targets::nodes(&[2, 3]).unwrap(), 1_000, 1), 2);
        f.on_reply(500, 3, &ReplyMsg { op_id: 9, status: Status::Ok, arm: 22, code: 0 });
        f.poll(999);
        assert!(f.take_done().is_none());
        f.poll(1_000);
        let r = f.take_done().unwrap();
        assert!(!r.complete);
        assert_eq!(&r.status[..2], &[Status::Missing, Status::Ok]);
        assert_eq!(f.stats.timed_out, 1);
        // A reply nobody waits for.
        f.on_reply(2_000, 3, &ReplyMsg { op_id: 99, status: Status::Ok, arm: 0, code: 0 });
        assert_eq!(f.stats.stray_replies, 1);
    }

    #[test]
    fn full_tables_keep_the_newest() {
        let mut f = Fanout::<2>::new();
        f.touch(10, 2);
        f.touch(20, 3);
        f.touch(30, 4); // evicts 2 (oldest)
        let ids: Vec<_> = f.members.iter().flatten().map(|m| m.node).collect();
        assert!(ids.contains(&3) && ids.contains(&4) && !ids.contains(&2));
        for op in 0..OPS as u32 + 1 {
            f.begin(op as i64, 0, op, 1, &Targets::All, 1_000_000, 1);
        }
        assert_eq!((f.stats.evicted, f.pending()), (1, OPS));
        assert_eq!(f.take_done().unwrap().op_id, 0);
    }
}
