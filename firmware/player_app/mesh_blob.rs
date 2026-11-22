//! Effect sharing on the netstack player (docs/design/mesh-m6.md): the device's blob store
//! for `splanc_mesh::blob` and what the firmware does with scenes. A submodule of
//! mesh_ffi.rs: its state lives in the mesh's heap block, and blob bytes in heap buffers
//! that exist only while a blob is in use (off and idle cost nothing, desk #68).
//!
//! **Store.** Up to [`SLOTS`] blobs: the one being received, complete ones (served to
//! neighbours on request, applied by a scene), and one staged for the render task. A blob
//! equal to this fixture's persisted effect (`/lfs/fx.pb`, the deck-A frame it resumes at
//! boot) is found there by hash, so a member that already shows the shared effect never
//! fetches it again. Idle blobs are freed after [`IDLE_US`].
//!
//! **Scenes** (member). Hold only: answer "have". Apply: an effect frame is handed to the
//! render task (`lm_fx_stage`, main.cpp) for the first frame at/after its show-clock time,
//! so every fixture switches on the same frame; one whose time has passed (a late member)
//! or a catch-up loads at once on loopTask, as an app upload would. A state blob's frames
//! (uniform values, brightness, crossfade) are dispatched after it, each checked against
//! the relay allow-list. A catch-up does not reload the effect this fixture already shows.
//!
//! **Gateway.** `mesh_send{inner: submit_effect}` of any size (mesh_gw.rs `share`): the
//! frame is checked as the load would check it, copied into a slot and shared in two phases
//! (`MeshStack::distribute`); once every member holds it the gateway picks the time
//! (`lead_ms` ahead on the show clock), tells them, and stages its own copy for the same
//! frame. A member that syncs with the session later gets a catch-up: the effect (from
//! fx.pb) and a state blob of this fixture's current look (`lm_fx_scene_frames`).

use splanc_mesh::blob::{self, id_of, sha256, BlobId, BlobStore, Hash, SceneMsg};
use splanc_mesh::gateway::{arm, client_arm, relay_arm, ReplyMsg, Status};
use splanc_mesh::ports::Targets;
use splanc_mesh::NodeId;

use crate::Mesh;

extern "C" {
    fn malloc(n: usize) -> *mut u8;
    fn free(p: *mut u8);
    fn esp_get_free_heap_size() -> u32;
    // main.cpp: the persisted deck-A effect frame (/lfs/fx.pb): its size with `buf` null,
    // else read into `buf` (`cap` bytes); 0 if there is none.
    fn lm_mesh_effect_file(buf: *mut u8, cap: u32) -> u32;
    // main.cpp: stage an effect frame for the render task (under the player mutex):
    // 1 staged (*replaced: an earlier one handed back), 0 its time has passed, -1 refused.
    fn lm_mesh_stage(frame: *const u8, len: u32, apply_at_ms: u32, replaced: *mut *const u8) -> i32;
    // main.cpp: the staged frame the render task applied, if any (persisted when it
    // loaded): 1 loaded, 2 refused, 0 none yet (or the player is busy: try again).
    fn lm_mesh_staged_take(frame: *mut *const u8) -> u32;
    // main.cpp: this fixture's look as a state blob (lm_fx_scene_frames, under the mutex).
    fn lm_mesh_scene_frames(out: *mut u8, cap: u32) -> i32;
}

/// Blobs a fixture holds at once (receiving + complete + staged).
pub const SLOTS: usize = 3;
/// A complete blob nobody asked for in this long is freed.
pub const IDLE_US: i64 = 20_000_000;
/// The state blob's buffer (uniform values of a rich effect, brightness, crossfade).
pub const STATE_MAX: usize = 768;
/// How far ahead a share's switch goes when the app gives no `lead_ms` (a staged load has
/// to reach every member: one scene packet, ACKed unicasts).
pub const DEFAULT_LEAD_MS: u32 = 250;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SlotState {
    Free,
    Rx,
    Held,
    /// Handed to the render task (do not free before it is taken back).
    Staged,
}

#[derive(Clone, Copy)]
pub struct Slot {
    pub ptr: *mut u8,
    pub len: usize,
    pub hash: Hash,
    pub state: SlotState,
    pub used_us: i64,
    /// Read from /lfs/fx.pb (this fixture shows it already).
    pub fxpb: bool,
    /// The gateway's share source: kept until the share is over.
    pub pinned: bool,
}

impl Slot {
    const FREE: Slot = Slot { ptr: core::ptr::null_mut(), len: 0, hash: [0; 32], state: SlotState::Free, used_us: 0, fxpb: false, pinned: false };

    fn bytes(&self) -> &[u8] {
        // SAFETY: a non-free slot owns `len` bytes at `ptr`.
        unsafe { core::slice::from_raw_parts(self.ptr, self.len) }
    }

    fn release(&mut self) {
        if !self.ptr.is_null() {
            unsafe {
                // The bytes may be an effect someone paid for: don't leave them in freed heap.
                core::ptr::write_bytes(self.ptr, 0, self.len);
                free(self.ptr);
            }
        }
        *self = Slot::FREE;
    }
}

#[derive(Clone, Copy, Default)]
pub struct SlotStats {
    pub allocs: u32,
    pub alloc_fail: u32,
    pub fxpb_hits: u32,
    pub freed: u32,
    pub bytes: usize,
    pub peak: usize,
}

/// The device's [`BlobStore`] (in the mesh block).
pub struct Slots {
    pub s: [Slot; SLOTS],
    pub now_us: i64,
    pub stats: SlotStats,
}

impl Slots {
    pub fn new() -> Slots {
        Slots { s: [Slot::FREE; SLOTS], now_us: 0, stats: SlotStats::default() }
    }

    fn total(&self) -> usize {
        self.s.iter().filter(|s| s.state != SlotState::Free).map(|s| s.len).sum()
    }

    /// A free slot, evicting the oldest idle complete one if need be.
    fn alloc(&mut self, len: usize) -> Option<usize> {
        let i = match self.s.iter().position(|s| s.state == SlotState::Free) {
            Some(i) => i,
            None => {
                let i = (0..SLOTS).filter(|&i| self.s[i].state == SlotState::Held && !self.s[i].pinned).min_by_key(|&i| self.s[i].used_us)?;
                self.s[i].release();
                self.stats.freed += 1;
                i
            }
        };
        let p = unsafe { malloc(len.max(1)) };
        if p.is_null() {
            self.stats.alloc_fail += 1;
            return None;
        }
        self.stats.allocs += 1;
        self.s[i] = Slot { ptr: p, len, hash: [0; 32], state: SlotState::Rx, used_us: self.now_us, fxpb: false, pinned: false };
        Some(i)
    }

    fn note(&mut self) {
        self.stats.bytes = self.total();
        self.stats.peak = self.stats.peak.max(self.stats.bytes);
    }

    /// Keep a copy of `b` as a complete blob (the gateway's share, a state blob).
    pub fn put(&mut self, b: &[u8], pinned: bool) -> Option<usize> {
        let h = sha256(b);
        if let Some(i) = self.held(&h) {
            self.s[i].pinned |= pinned;
            return Some(i);
        }
        let i = self.alloc(b.len())?;
        unsafe { core::ptr::copy_nonoverlapping(b.as_ptr(), self.s[i].ptr, b.len()) };
        self.s[i].hash = h;
        self.s[i].state = SlotState::Held;
        self.s[i].pinned = pinned;
        self.note();
        Some(i)
    }

    /// The complete blob `h`, by slot.
    pub fn held(&self, h: &Hash) -> Option<usize> {
        self.s.iter().position(|s| matches!(s.state, SlotState::Held | SlotState::Staged) && s.hash == *h)
    }

    /// This fixture's persisted effect frame, as a complete blob (it is what a catch-up
    /// sends, and what a member already showing the effect has). Its slot.
    pub fn load_fxpb(&mut self) -> Option<usize> {
        let n = unsafe { lm_mesh_effect_file(core::ptr::null_mut(), 0) } as usize;
        if n == 0 || n > blob::BLOB_MAX {
            return None;
        }
        if let Some(i) = self.s.iter().position(|s| s.fxpb && s.state != SlotState::Free && s.len == n) {
            return Some(i);
        }
        let i = self.alloc(n)?;
        let got = unsafe { lm_mesh_effect_file(self.s[i].ptr, n as u32) } as usize;
        if got != n {
            self.s[i].release();
            return None;
        }
        let h = sha256(self.s[i].bytes());
        if let Some(j) = self.held(&h) {
            // Already held under another slot (the share it came from).
            self.s[i].release();
            self.s[j].fxpb = true;
            return Some(j);
        }
        self.s[i].hash = h;
        self.s[i].state = SlotState::Held;
        self.s[i].fxpb = true;
        self.note();
        Some(i)
    }

    /// Free complete blobs nobody used for [`IDLE_US`] (not pinned, not staged), unless a
    /// neighbour is being served.
    pub fn sweep(&mut self, now_us: i64, serving: bool) {
        if serving {
            return;
        }
        for s in self.s.iter_mut() {
            if s.state == SlotState::Held && !s.pinned && now_us - s.used_us >= IDLE_US {
                s.release();
                self.stats.freed += 1;
            }
        }
        self.note();
    }

    pub fn free_all(&mut self) {
        for s in self.s.iter_mut() {
            s.release();
        }
        self.note();
    }
}

impl Default for Slots {
    fn default() -> Self {
        Self::new()
    }
}

impl BlobStore for Slots {
    fn find(&mut self, id: &BlobId) -> Option<&[u8]> {
        let now = self.now_us;
        let s = self.s.iter_mut().find(|s| matches!(s.state, SlotState::Held | SlotState::Staged) && id_of(&s.hash) == *id)?;
        s.used_us = now;
        Some(s.bytes())
    }

    fn has(&mut self, hash: &Hash, size: usize) -> bool {
        if let Some(i) = self.held(hash).filter(|&i| self.s[i].len == size) {
            self.s[i].used_us = self.now_us;
            return true;
        }
        // The persisted effect, when it is that blob (only read when the sizes match).
        let n = unsafe { lm_mesh_effect_file(core::ptr::null_mut(), 0) } as usize;
        if n != size {
            return false;
        }
        match self.load_fxpb() {
            Some(i) if self.s[i].hash == *hash => {
                self.stats.fxpb_hits += 1;
                true
            }
            Some(i) => {
                if !self.s[i].pinned && self.s[i].state == SlotState::Held {
                    self.s[i].release();
                    self.note();
                }
                false
            }
            None => false,
        }
    }

    fn begin(&mut self, hash: &Hash, size: usize) -> bool {
        for s in self.s.iter_mut().filter(|s| s.state == SlotState::Rx) {
            s.release();
        }
        let Some(i) = self.alloc(size) else { return false };
        self.s[i].hash = *hash;
        self.note();
        true
    }

    fn rx(&mut self) -> Option<&mut [u8]> {
        let s = self.s.iter_mut().find(|s| s.state == SlotState::Rx)?;
        // SAFETY: the receive slot owns `len` bytes.
        Some(unsafe { core::slice::from_raw_parts_mut(s.ptr, s.len) })
    }

    fn finish(&mut self, hash: &Hash, ok: bool) {
        let now = self.now_us;
        if let Some(s) = self.s.iter_mut().find(|s| s.state == SlotState::Rx) {
            if ok && s.hash == *hash {
                s.state = SlotState::Held;
                s.used_us = now;
            } else {
                s.release();
            }
        }
        self.note();
    }
}

/// What the tick reported for the firmware to do after it (on loopTask's stack).
#[derive(Clone, Copy, Default)]
pub struct Work {
    pub scene: Option<(NodeId, SceneMsg)>,
    pub fetched: Option<(u32, usize, usize)>,
    pub catch_up: Option<NodeId>,
}

/// The gateway's share in progress.
#[derive(Clone, Copy)]
pub struct Share {
    pub op: u32,
    pub hash: Hash,
    pub len: usize,
    pub lead_ms: u32,
    pub timeout_us: i64,
    pub started_us: i64,
    /// The gateway switches too (false: `skip_gateway`, the app loaded it here already).
    pub local: bool,
}

/// Frames a scene dispatches (an effect and a state blob's few frames).
pub const DQ: usize = 6;

/// How a scene's dispatches end: its log line and its answer to the gateway.
#[derive(Clone, Copy)]
pub struct DqEnd {
    pub origin: NodeId,
    pub op: u32,
    pub reply: bool,
    pub staged: bool,
    pub late: bool,
    pub catch_up: bool,
    pub skipped: u8,
    pub fetch_ms: i64,
    pub heap_min: u32,
    pub status: Status,
    pub code: u16,
}

#[derive(Clone, Copy, Default)]
pub struct BlobState {
    /// Frames to dispatch, taken by the transport on loopTask's stack (`ns_mesh_take_dispatch`:
    /// the same path as relayed control, so the dispatch never runs under these frames),
    /// and what to do when the last one is done.
    pub dq: [(usize, u32); DQ],
    pub dq_n: u8,
    pub dq_i: u8,
    pub dq_end: Option<DqEnd>,
    pub work: Work,
    pub share: Option<Share>,
    /// The op ids of shares' second phases (their results queue catch-ups for failures).
    pub share_ops: [u32; 2],
    /// The lowest free heap seen while a blob was in flight, and since when one was.
    pub heap_min: u32,
    pub fetch_since: Option<i64>,
    pub applied: u32,
    pub staged: u32,
    pub loaded: u32,
    pub refused: u32,
    pub catchups_sent: u32,
}

impl BlobState {
    pub fn new() -> BlobState {
        BlobState { heap_min: u32::MAX, ..Default::default() }
    }
}

fn reply(m: &mut Mesh, origin: NodeId, op: u32, status: Status, code: u16) {
    let _ = m.stack.reply(origin, &ReplyMsg { op_id: op, status, arm: arm::SUBMIT_EFFECT as u8, code });
}

/// A scene whose blobs are all held (member): apply it.
// Out of line: its frame is not on the dispatch path's stack (loopTask's bound).
#[inline(never)]
fn apply_scene(m: &mut Mesh, origin: NodeId, msg: &SceneMsg, now_us: i64) {
    m.blobs.now_us = now_us;
    let fetch_ms = m.bs.fetch_since.take().map_or(0, |t| (now_us - t) / 1000);
    let heap_min = core::mem::replace(&mut m.bs.heap_min, u32::MAX);
    let heap = unsafe { esp_get_free_heap_size() };
    if msg.flags & SceneMsg::APPLY == 0 {
        for (h, _) in msg.blobs() {
            if let Some(i) = m.blobs.held(h) {
                m.blobs.s[i].used_us = now_us;
            }
        }
        let _ = heap;
        m.log(format_args!("[mesh] scene have op={:x} fetch_ms={fetch_ms} heap_min={heap_min}", msg.op_id));
        if msg.want_reply() {
            reply(m, origin, msg.op_id, Status::Ok, 0);
        }
        return;
    }
    let catch_up = msg.flags & SceneMsg::CATCH_UP != 0;
    let now = msg.flags & SceneMsg::NOW != 0;
    let (mut status, mut code) = (Status::Ok, 0u16);
    let (mut staged, mut late, mut skipped, mut frames) = (false, false, 0u8, 0);
    for (h, _) in msg.blobs() {
        let Some(i) = m.blobs.held(h) else {
            status = Status::Failed;
            code = splanc_mesh::stack::SceneFail::NO_ROOM;
            continue;
        };
        let (ptr, len, fxpb) = (m.blobs.s[i].ptr, m.blobs.s[i].len, m.blobs.s[i].fxpb);
        m.blobs.s[i].used_us = now_us;
        // SAFETY: the slot owns the bytes; nothing frees it during this call.
        let bytes = unsafe { core::slice::from_raw_parts(ptr as *const u8, len) };
        if client_arm(bytes).is_some_and(|(a, _)| a == arm::SUBMIT_EFFECT) {
            if catch_up && fxpb {
                skipped += 1;
                continue;
            }
            if !now {
                let mut replaced: *const u8 = core::ptr::null();
                match unsafe { lm_mesh_stage(ptr, len as u32, msg.apply_at, &mut replaced) } {
                    1 => {
                        staged = true;
                        m.blobs.s[i].state = SlotState::Staged;
                        if let Some(j) = m.blobs.s.iter().position(|s| s.ptr as *const u8 == replaced && !replaced.is_null()) {
                            m.blobs.s[j].state = SlotState::Held;
                        }
                        m.bs.staged += 1;
                        continue;
                    }
                    0 => late = true,
                    _ => {
                        status = Status::Failed;
                        code = 0xb010;
                        continue;
                    }
                }
            }
            dq_push(m, ptr as *const u8, len);
        } else {
            // A state blob: its frames in order, each on the allow-list.
            for f in blob::frames(bytes) {
                if relay_arm(f).is_ok() {
                    frames += 1;
                    dq_push(m, f.as_ptr(), f.len());
                }
            }
        }
    }
    m.bs.applied += 1;
    let _ = (frames, heap);
    m.bs.dq_end = Some(DqEnd { origin, op: msg.op_id, reply: msg.want_reply(), staged, late, catch_up, skipped, fetch_ms, heap_min, status, code });
    if m.bs.dq_i >= m.bs.dq_n {
        dq_finish(m);
    }
}

fn dq_push(m: &mut Mesh, p: *const u8, len: usize) {
    let n = m.bs.dq_n as usize;
    if n < DQ {
        m.bs.dq[n] = (p as usize, len as u32);
        m.bs.dq_n += 1;
    }
}

/// The scene's last dispatch is done: log it and answer the gateway.
fn dq_finish(m: &mut Mesh) {
    m.bs.dq_n = 0;
    m.bs.dq_i = 0;
    let Some(e) = m.bs.dq_end.take() else { return };
    if e.op == 0 {
        return;
    }
    let ok = (e.status == Status::Ok) as u8;
    m.log(format_args!(
        "[mesh] scene apply op={:x} staged={} late={} catch_up={} skipped={} ok={ok} code={:x} fetch_ms={} heap_min={}",
        e.op, e.staged as u8, e.late as u8, e.catch_up as u8, e.skipped, e.code, e.fetch_ms, e.heap_min
    ));
    if e.reply {
        reply(m, e.origin, e.op, e.status, e.code);
    }
}

/// The next frame a scene dispatches (the transport, on loopTask's stack): its bytes in
/// `*frame` / `*len`; 0 if none. Then [`ns_mesh_dispatch_done`].
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_take_dispatch(m: *mut Mesh, frame: *mut *const u8, len: *mut u32) -> u32 {
    let m = &mut *m;
    if m.bs.dq_i >= m.bs.dq_n {
        return 0;
    }
    let (p, n) = m.bs.dq[m.bs.dq_i as usize];
    *frame = p as *const u8;
    *len = n;
    1
}

/// The frame [`ns_mesh_take_dispatch`] handed out was dispatched (`status` 0 ok, else `code`).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_dispatch_done(m: *mut Mesh, status: u32, code: u32) {
    let m = &mut *m;
    m.bs.dq_i += 1;
    if status != 0 {
        if let Some(e) = m.bs.dq_end.as_mut() {
            e.status = Status::Failed;
            e.code = code.min(0xffff) as u16;
        }
    }
    if m.bs.dq_i >= m.bs.dq_n {
        dq_finish(m);
    }
}

/// The gateway's second phase: every target has the blob (or the time ran out).
// Out of line: its frame is not on the dispatch path's stack (loopTask's bound).
#[inline(never)]
fn share_apply(m: &mut Mesh, op: u32, have: usize, of: usize, now_us: i64) {
    let Some(sh) = m.bs.share.take() else { return };
    let at = crate::mesh_gw::local_epoch_ms(m).map(|ep| (now_us / 1000 - ep + i64::from(sh.lead_ms)).clamp(0, u32::MAX as i64) as u32);
    let r = m.stack.distribute_apply(now_us, at, sh.timeout_us);
    m.bs.share_ops = [m.bs.share_ops[1], op];
    let i = m.blobs.held(&sh.hash);
    if let Some(i) = i {
        m.blobs.s[i].pinned = false;
    }
    // This fixture switches on the same frame.
    let mut local = "none";
    if let Some(i) = i.filter(|_| sh.local) {
        let (ptr, len) = (m.blobs.s[i].ptr, m.blobs.s[i].len);
        let mut replaced: *const u8 = core::ptr::null();
        let st = match at {
            Some(at) => unsafe { lm_mesh_stage(ptr, len as u32, at, &mut replaced) },
            None => 0,
        };
        if st == 1 {
            m.blobs.s[i].state = SlotState::Staged;
            m.bs.staged += 1;
            local = "staged";
        } else {
            // Loaded now (no show clock): through the dispatch queue, no answer to send.
            m.bs.dq_end = Some(DqEnd { origin: 0, op: 0, reply: false, staged: false, late: true, catch_up: false, skipped: 0, fetch_ms: 0, heap_min: 0, status: Status::Ok, code: 0 });
            dq_push(m, ptr as *const u8, len);
            local = "now";
        }
    }
    let ms = (now_us - sh.started_us) / 1000;
    let _ = r;
    m.log(format_args!("[mesh] gw share apply op={op:x} have={have}/{of} fetch_ms={ms} local={local}"));
}

/// A member synced with the session after the look changed: send it the current scene.
// Out of line: its frame is not on the dispatch path's stack (loopTask's bound).
#[inline(never)]
fn catch_up(m: &mut Mesh, node: NodeId, now_us: i64) {
    let Some(conn) = m.stack.signing_conn() else { return };
    m.blobs.now_us = now_us;
    let mut blobs: [(Hash, u16); blob::SCENE_BLOBS] = [([0; 32], 0); blob::SCENE_BLOBS];
    let mut n = 0;
    let effect = m.blobs.load_fxpb();
    if let Some(i) = effect {
        blobs[n] = (m.blobs.s[i].hash, m.blobs.s[i].len as u16);
        n += 1;
    }
    let mut st = [0u8; STATE_MAX];
    let k = unsafe { lm_mesh_scene_frames(st.as_mut_ptr(), STATE_MAX as u32) };
    if k > 0 {
        if let Some(i) = m.blobs.put(&st[..k as usize], false) {
            blobs[n] = (m.blobs.s[i].hash, m.blobs.s[i].len as u16);
            n += 1;
        }
    }
    let Some(t) = Targets::nodes(&[node]) else { return };
    let flags = SceneMsg::APPLY | SceneMsg::NOW | SceneMsg::CATCH_UP | SceneMsg::WANT_REPLY;
    let op = CATCH_UP_OP | u32::from(node);
    let Some(msg) = SceneMsg::new(op, flags, 0, t, &blobs[..n]) else { return };
    let r = m.stack.share(now_us, conn, &msg, 20_000_000);
    m.bs.catchups_sent += 1;
    let _ = (effect, k, r);
    m.log(format_args!("[mesh] gw catch-up node={node:04x} blobs={n}"));
}

/// Catch-up ops (their results are not pushed to the app).
pub const CATCH_UP_OP: u32 = 0x0c00_0000;

/// After each tick, on loopTask's stack: the staged load's outcome, scenes to apply, the
/// gateway's second phase and catch-ups, idle blobs freed.
pub unsafe fn after_tick(m: &mut Mesh, now_us: i64) {
    m.blobs.now_us = now_us;
    staged_poll(m, now_us);
    if m.stack.blobs.fetching().is_some() {
        m.bs.fetch_since.get_or_insert(now_us);
        m.bs.heap_min = m.bs.heap_min.min(esp_get_free_heap_size());
    }
    // Each step out of line: this frame stays small (the dispatch below them is deep:
    // loopTask's stack bound).
    if let Some((op, have, of)) = m.bs.work.fetched.take() {
        share_apply(m, op, have, of, now_us);
    }
    if m.bs.work.scene.is_some() {
        scene_work(m, now_us);
    }
    if let Some(node) = m.bs.work.catch_up.take() {
        catch_up(m, node, now_us);
    }
    let serving = m.stack.blobs.serving();
    m.blobs.sweep(now_us, serving);
}

/// The render task applied our staged frame: it is a plain held blob again.
#[inline(never)]
unsafe fn staged_poll(m: &mut Mesh, now_us: i64) {
    if m.blobs.s.iter().any(|s| s.state == SlotState::Staged) {
        let mut f: *const u8 = core::ptr::null();
        let r = lm_mesh_staged_take(&mut f);
        if r != 0 {
            if let Some(s) = m.blobs.s.iter_mut().find(|s| s.ptr as *const u8 == f) {
                s.state = SlotState::Held;
                s.used_us = now_us;
            }
            if r == 1 {
                m.bs.loaded += 1;
            } else {
                m.bs.refused += 1;
            }
            m.log(format_args!("[mesh] staged effect r={r}"));
        }
    }
}

#[inline(never)]
fn scene_work(m: &mut Mesh, now_us: i64) {
    if let Some((origin, msg)) = m.bs.work.scene.take() {
        apply_scene(m, origin, &msg, now_us);
    }
}

/// The gateway's `mesh_send{inner: submit_effect}`: check it, keep a copy, start the share.
/// The app's direct reply (what the load would answer, `result_ready` or the error) in `out`;
/// returns its length, or Err(a MeshResult error).
pub fn share(m: &mut Mesh, conn: usize, op: u32, s: &crate::mesh_gw::Send<'_>, now_us: i64, out: &mut [u8]) -> Result<usize, u32> {
    use crate::mesh_gw::err;
    extern "C" {
        fn lm_fx_check_effect(frame: *const u8, len: usize) -> u32;
    }
    m.blobs.now_us = now_us;
    // The app's direct reply: what the load would answer.
    let check = unsafe { lm_fx_check_effect(s.inner.as_ptr(), s.inner.len()) };
    let n = load_reply(s.inner, check, out).ok_or(err::BAD_REQUEST)?;
    if check != 0 {
        return Ok(n);
    }
    if s.inner.len() > blob::BLOB_MAX {
        return Err(err::TOO_BIG);
    }
    if m.bs.share.is_some() || m.stack.dist.is_some() {
        return Err(err::BUSY);
    }
    let Some(i) = m.blobs.put(s.inner, true) else { return Err(err::BUSY) };
    let (hash, len) = (m.blobs.s[i].hash, m.blobs.s[i].len);
    // The switch goes on the show clock: start one now if there is none (desk #79), so the
    // members have it (signed TIME_BASE / beacons) by the second phase.
    if crate::mesh_gw::local_epoch_ms(m).is_none() && m.stack.time.synced() {
        let e = m.stack.time.mesh_us(now_us);
        if let Some(se) = m.stack.originate_epoch(splanc_mesh::stack::EpochSource::Connection(conn), Some(e)) {
            m.tb_originated += 1;
            crate::log_epoch(m, "originated", se);
        }
    }
    let fetch = if s.timeout_ms == 0 { splanc_mesh::stack::FETCH_TIMEOUT_US } else { i64::from(s.timeout_ms.min(60_000)) * 1000 };
    if let Err(e) = m.stack.distribute(now_us, conn, op, s.targets(), (hash, len as u16), fetch) {
        m.blobs.s[i].pinned = false;
        return Err(crate::mesh_gw::send_err(e));
    }
    let lead_ms = if s.lead_ms > 0 { s.lead_ms } else { DEFAULT_LEAD_MS };
    m.bs.share = Some(Share { op, hash, len, lead_ms, timeout_us: 3_000_000, started_us: now_us, local: !s.skip_gateway });
    let heap = unsafe { esp_get_free_heap_size() };
    m.log(format_args!("[mesh] gw share op={op:x} len={len} heap={heap}"));
    Ok(n)
}

/// `submit_effect`'s `effect_id` (field 1), if any.
fn effect_id(frame: &[u8]) -> &[u8] {
    let Some((_, body)) = client_arm(frame) else { return &[] };
    let b = &frame[body];
    let mut o = 0usize;
    let var = |b: &[u8], o: &mut usize| -> Option<u64> {
        let mut v = 0u64;
        for sh in (0..64).step_by(7) {
            let x = *b.get(*o)?;
            *o += 1;
            v |= u64::from(x & 0x7f) << sh;
            if x & 0x80 == 0 {
                return Some(v);
            }
        }
        None
    };
    while o < b.len() {
        let Some(key) = var(b, &mut o) else { break };
        let len = match key & 7 {
            0 => {
                var(b, &mut o);
                continue;
            }
            2 => var(b, &mut o).unwrap_or(0) as usize,
            1 => 8,
            5 => 4,
            _ => break,
        };
        if key >> 3 == 1 && key & 7 == 2 {
            return b.get(o..o + len).unwrap_or(&[]);
        }
        o += len;
    }
    &[]
}

/// The reply a load of `frame` would give: result_ready{map_id: effect_id} (check 0), or
/// error{code: bad_fxb | effect_too_large}. By hand (one short LEN field: ids < 100 B).
fn load_reply(frame: &[u8], check: u32, out: &mut [u8]) -> Option<usize> {
    let (arm, s): (u8, &[u8]) = match check {
        0 => (8, effect_id(frame)),
        2 => (9, b"effect_too_large"),
        _ => (9, b"bad_fxb"),
    };
    let n = s.len().min(100);
    let o = out.get_mut(..4 + n)?;
    // ServerMessage.<arm> = { field 1: string }.
    o[..4].copy_from_slice(&[(arm << 3) | 2, (2 + n) as u8, 0x0a, n as u8]);
    o[4..].copy_from_slice(&s[..n]);
    Some(4 + n)
}
