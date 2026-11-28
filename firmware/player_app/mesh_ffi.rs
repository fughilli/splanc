//! The mesh on the netstack player (docs/design/mesh.md, M3): the device's `MeshStack`
//! (firmware/mesh) over the 802.11 backhaul (`splanc_mesh::wifi_p2p`) on our own MAC, for
//! the C++ transport (netstack_transport.cpp).
//!
//! **Off costs no RAM** (owner, desk #68): every byte lives in one heap block the transport
//! allocates on `MESH ON` ([`ns_mesh_size`]) and frees on `MESH OFF`; this crate has no
//! statics, and the transport holds one pointer. With it null the RX paths reap exactly as
//! before and nothing here runs.
//!
//! **AP-anchored** (desk #66): fixtures stay on the AP and send mesh frames on its channel;
//! the channel rule follows the AP on a move or a rejoin (§4.2) and pauses mesh TX while a
//! background sweep has the radio elsewhere. Mesh-only mode (`kModeMesh`) is the next PR: it
//! acts on [`ChannelAction::Camp`], which this build only reports.
//!
//! **Membership** (M7, mesh_gw.rs `mesh_admin`): the app provisions a fixture into a closed
//! mesh (the mesh id, the site secret or none for an approval join, the admin public key);
//! the state is persisted in littlefs (`/lfs/mesh.bin`, power-loss safe) and the mesh comes
//! back on at boot. The device key is the per-device TLS key (P-256, its ECDH in main.cpp on
//! MbedTLS, [`DevKey`]); session crypto runs one job per pass outside the tick
//! ([`ns_mesh_crypto`]). The dev-only site key ([`ns_mesh_dev_provision`], desk #67) stays in
//! the `LM_MESH_DEVKEY` image for the older HITLs; it is never persisted. The M2 envelope is
//! always on: nothing leaves unsealed except membership's plain adverts and join messages.
//!
//! **Group traffic** (desk #70, pending): data that must arrive fans out as ACKed unicasts
//! by default (`GroupPolicy::Unicast`); `MESH POLICY bcast` switches to one broadcast.
//!
//! **Mesh time** (M4, `splanc_mesh::meshtime`): the backhaul stamps each time beacon's
//! completion (the clock read before the MAC poll that saw it done, [`Radio::now_us`]), and
//! maps RX-vector stamps onto `esp_timer` through the MAC's TSF counter, which the transport
//! reads next to `esp_timer` every loop pass ([`ns_mesh_clock`]). The show epoch rides in
//! the beacons: this crate maps it onto the player's time base (main.cpp `lm_mesh_tb`), so
//! `apply_at_ms` lands at one instant on every member, and a time base the app sets on this
//! device originates the next generation (M5's gateway session restricts who may). The
//! AP's beacons are logged as an independent reference (`[mt] ap`), once per AP-TSF second:
//! every member hears the same beacon at the same instant, which is how the HITL measures
//! mesh time and `apply_at` skew without trusting mesh time itself.
//!
//! Reports are text lines this crate formats (no_std `core::fmt`) and the transport prints.

#![cfg_attr(not(test), no_std)]
#![allow(clippy::missing_safety_doc)]

use core::fmt::Write;

use splanc_mesh::crypto::{DeviceKey, Entropy, PublicKey};
use splanc_mesh::membership::{Credentials, MeshState, Mode, Phase, ProvisionSource, STATE_LEN};
use splanc_mesh::ports::Port;
use splanc_mesh::meshtime::{ShowEpoch, SyncState};
use splanc_mesh::stack::{EpochSource, Event, MeshStack, StackConfig};
use splanc_mesh::timesync::Adjust;
use splanc_mesh::wifi_p2p::{self, ChannelAction, ChannelRule, GroupPolicy, P2pConfig, Radio, RxVerdict, TxResult, WifiP2p};
use splanc_mesh::NodeId;
use swarm_net::update::Flash;

pub mod mesh_blob;
pub mod mesh_gw;

/// The 802.11 mesh payload (§5.2).
const P: usize = 200;
type Stack = MeshStack<WifiP2p, P, DevKey, EspRng, 16>;
/// `MeshStack::tick` scratch (it needs `scratch_len()`, ~0.7 KB; checked at create).
const SCRATCH: usize = 1024;
/// Test traffic: senders tracked per receiver, seqs per sender (bitmap).
const TEST_PEERS: usize = 6;
const TEST_SEQS: usize = 1024;
/// The event log the transport drains after each tick.
const LOG: usize = 1024;
/// Test packet magic (first byte).
const T_TEST: u8 = b'T';

extern "C" {
    // wifi_sta_ffi (the netstack's MAC).
    fn ns_mac_send_p2p(frame: *const u8, len: u32, queue: u32, rate: u32, pwr: u32, flags: u32) -> u32;
    fn ns_mac_tx_done(queue: u32, pmd: *mut u32) -> u32;
    fn ns_mac_tx_ftm(queue: u32, out: *mut u32);
    fn ns_phy_force_tick_phase(queue: u32) -> u32;
    // ESP-IDF heap: ranging's table while ranging is on (not in the mesh block).
    fn heap_caps_aligned_alloc(align: usize, size: usize, caps: u32) -> *mut u8;
    fn heap_caps_free(p: *mut u8);
    // netstack_transport.cpp: the shared TX pacing (the STA path's g_tx_busy_until_us).
    fn lm_mesh_tx_idle() -> u32;
    fn lm_mesh_tx_hold(us: u32);
    // main.cpp: the frame counter's high-water mark in littlefs (§7.5).
    fn lm_mesh_counter_store(mark: u64) -> u32;
    fn esp_random() -> u32;
    fn esp_timer_get_time() -> i64;
    // main.cpp (M7): this device's P-256 key, the per-device TLS identity's (65 bytes,
    // uncompressed; 0 if there is none yet), and ECDH with it (the shared X; 0 if `peer`
    // is not a valid point). The private key never leaves MbedTLS's context.
    fn lm_mesh_device_key(out: *mut u8) -> u32;
    fn lm_mesh_ecdh(peer: *const u8, out: *mut u8) -> u32;
    // main.cpp: the player's shared time base under its mutex (try-lock: -1 = busy).
    // op 0 = get (1: set, in *epoch_ms; 0: none), 1 = put *epoch_ms and shift the queued
    // apply_at changes by `shift_ms`, 2 = clear, 3 = frame alignment on (*epoch_ms != 0).
    fn lm_mesh_tb(op: i32, epoch_ms: *mut i64, shift_ms: i64) -> i32;
    // main.cpp: loopTask strictly below the render task for a span (PR-40), and back.
    fn lm_prio_below_render() -> u32;
    fn lm_prio_restore(prio: u32);
}

/// Runs `f` below the render task's priority (PR-40: crypto never blocks render). loopTask
/// shares render's priority while a client is on a settled link (#371); an ECDSA verify or
/// an ECDH there (10-55 ms on a C6) would round-robin with frames.
pub(crate) fn below_render<T>(f: impl FnOnce() -> T) -> T {
    let p = unsafe { lm_prio_below_render() };
    let r = f();
    unsafe { lm_prio_restore(p) };
    r
}

/// How often the player's time base is reconciled with the mesh's epoch.
const TB_EVERY_US: i64 = 50_000;
/// A periodic `[mt] st` line this often (the HITL's mesh-time trace).
const TSTAT_EVERY_US: i64 = 2_000_000;

/// The TX queue the mesh uses (the STA path's; pacing keeps them apart).
const QUEUE: u32 = 0;
const P2P_ACK: u32 = 1;
const P2P_KEEP_SEQ: u32 = 2;

struct Mac {
    pwr: u8,
}

impl Radio for Mac {
    fn tx_idle(&mut self, _now_us: i64) -> bool {
        unsafe { lm_mesh_tx_idle() != 0 }
    }
    fn arm(&mut self, frame: &mut [u8], rate: u8, ack: bool, retry: bool) -> bool {
        let flags = if ack { P2P_ACK } else { 0 } | if retry { P2P_KEEP_SEQ } else { 0 };
        unsafe { ns_mac_send_p2p(frame.as_ptr(), frame.len() as u32, QUEUE, rate as u32, self.pwr as u32, flags) != 0 }
    }
    fn tx_done(&mut self) -> Option<TxResult> {
        let mut pmd = 0u32;
        if unsafe { ns_mac_tx_done(QUEUE, &mut pmd) } == 0 {
            return None;
        }
        Some(ledmapper_netstack::p2p::tx_status(pmd).into())
    }
    fn hold(&mut self, _now_us: i64, us: u32) {
        unsafe { lm_mesh_tx_hold(us) }
    }
    fn now_us(&mut self) -> Option<i64> {
        Some(unsafe { esp_timer_get_time() })
    }
    fn tx_ftm(&mut self) -> Option<[u32; 3]> {
        let mut w = [0u32; 3];
        unsafe { ns_mac_tx_ftm(QUEUE, w.as_mut_ptr()) };
        Some(w)
    }
    fn force_phase(&mut self) -> bool {
        unsafe { ns_phy_force_tick_phase(QUEUE) != 0 }
    }
}

/// The device key (M7): the per-device TLS key (docs/design/per-device-cert.md), whose ECDH
/// runs in MbedTLS (main.cpp); only the public half is here. `ok` false: no identity yet
/// (first boot before keygen): joins by approval and admin sessions cannot work.
struct DevKey {
    pk: PublicKey,
    ok: bool,
}
impl DeviceKey for DevKey {
    fn public_key(&self) -> PublicKey {
        self.pk
    }
    fn ecdh(&self, peer: &PublicKey) -> Option<[u8; 32]> {
        if !self.ok {
            return None;
        }
        let mut out = [0u8; 32];
        (unsafe { lm_mesh_ecdh(peer.as_ptr(), out.as_mut_ptr()) } != 0).then_some(out)
    }
}

impl DevKey {
    fn load(mac: &[u8; 6]) -> DevKey {
        let mut pk = [0u8; 65];
        if unsafe { lm_mesh_device_key(pk.as_mut_ptr()) } != 0 && pk[0] == 0x04 {
            return DevKey { pk, ok: true };
        }
        // A placeholder that names the device (no ECDH): site-secret members still work.
        pk = [0u8; 65];
        pk[0] = 0x04;
        pk[1..7].copy_from_slice(mac);
        DevKey { pk, ok: false }
    }
}

struct EspRng;
impl Entropy for EspRng {
    fn fill(&mut self, out: &mut [u8]) {
        for c in out.chunks_mut(4) {
            let r = unsafe { esp_random() }.to_le_bytes();
            c.copy_from_slice(&r[..c.len()]);
        }
    }
}

/// The page protocol's flash (firmware/blob distribution is M6): none yet.
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

#[derive(Clone, Copy, Default)]
struct TestJob {
    active: bool,
    dst: NodeId,
    port: u8,
    want_ack: bool,
    tag: u8,
    len: u16,
    n: u32,
    iv_us: u32,
    next_us: i64,
    seq: u32,
    sent: u32,
    refused: u32,
}

#[derive(Clone, Copy)]
struct TestRx {
    origin: NodeId,
    tag: u8,
    port: u8,
    uniq: u32,
    dups: u32,
    max_seq: u32,
    got: [u8; TEST_SEQS / 8],
}

/// Everything the mesh holds while enabled.
pub struct Mesh {
    stack: Stack,
    radio: Mac,
    rule: ChannelRule,
    scratch: [u8; SCRATCH],
    rxv: [u8; ledmapper_netstack::p2p::RXV_LEN],
    /// The raw allocation (the transport frees it).
    block: *mut u8,
    on_us: i64,
    provisioned_us: Option<i64>,
    member_us: Option<i64>,
    paused_us: i64,
    pause_since: Option<i64>,
    last_tick_us: i64,
    tick_max_us: u32,
    tick_n: u32,
    test: TestJob,
    test_rx: [Option<TestRx>; TEST_PEERS],
    controls: u32,
    packets: u32,
    counter_writes: u32,
    counter_fail: u32,
    camp_reported: u8,
    log: [u8; LOG],
    log_len: usize,
    /// The transport's own words (the tick stack's mutex), and the staged tick arguments
    /// (the tick runs on a stack in this block via a no-argument function).
    aux: [usize; 2],
    staged: (i64, u8, u8),
    // ---- mesh time (M4) ----
    /// The AP we are associated to (its beacons are the HITL's reference), and the AP-TSF
    /// second last logged.
    ap_bssid: [u8; 6],
    ap_last_s: u64,
    /// How the transport reads the TSF (0 = not at all: the reap-lag floor; 1 = the counter
    /// register; 2 = the vendor latch sequence), from its probe at `MESH ON`.
    tsf_mode: u8,
    /// What this crate last wrote into the player's time base (None: never; Some(None):
    /// cleared), for the generation it came from; when the player's differs, the app set it.
    tb_mine: Option<Option<i64>>,
    tb_gen: Option<(u32, u16)>,
    tb_next_us: i64,
    tb_writes: u32,
    tb_busy: u32,
    tb_originated: u32,
    tb_align: bool,
    tstat_next_us: i64,
    last_state: SyncState,
    // ---- the gateway and relayed control (M5, mesh_gw.rs) ----
    gw: mesh_gw::Gw,
    /// The op whose inner the transport is dispatching locally (`ns_mesh_gw_local_done`).
    gw_local_op: u32,
    /// The app's set_time_base just arrived on this connection (desk #79's seam decides).
    tb_app: Option<usize>,
    tb_refused: u32,
    /// The transport's scratch for relayed control, results and the dev console (in the
    /// block, so the transport has no static buffers: desk #68), the connections it last
    /// reported (bit 0 wss, bit 1 BLE), and when it last reported the status inputs.
    xfer: [u8; mesh_gw::XFER],
    conns: u8,
    status_us: i64,
    // ---- membership (M7) ----
    /// The mesh state changed since it was last persisted (`ns_mesh_persist`); `persist`:
    /// it is the app's (or restored), not the dev key's (never written).
    dirty: bool,
    persist: bool,
    /// Leave: the transport erases the persisted state and turns the mesh off.
    want_off: bool,
    crypto_us_max: u32,
    crypto_us_last: u32,
    /// The provisioner's token (desk D-324): issued to the connection that provisioned this
    /// fixture into its mesh, persisted with the membership; it lets that user leave or
    /// re-provision without an admin grant. Erased with the membership.
    pub(crate) owner_token: Option<[u8; OWNER_TOKEN_LEN]>,
    // ---- effect sharing (M6, mesh_blob.rs) ----
    /// The blob store (heap buffers only while a blob is in use) and the scene work.
    pub(crate) blobs: mesh_blob::Slots,
    pub(crate) bs: mesh_blob::BlobState,
}

/// Bytes of the provisioner token (D-324).
pub const OWNER_TOKEN_LEN: usize = 16;
/// The persisted record: the crate's state, then a flag and the provisioner token.
const RECORD_LEN: usize = STATE_LEN + 1 + OWNER_TOKEN_LEN;

/// 16 random bytes from the C6's RNG (a provisioner token).
pub(crate) fn random_token() -> [u8; OWNER_TOKEN_LEN] {
    let mut t = [0u8; OWNER_TOKEN_LEN];
    EspRng.fill(&mut t);
    t
}

impl Mesh {
    fn log(&mut self, args: core::fmt::Arguments<'_>) {
        let mut w = Buf { b: &mut self.log, n: self.log_len };
        if w.write_fmt(args).is_ok() && w.write_str("\n").is_ok() {
            self.log_len = w.n;
        }
    }
}

/// A `core::fmt` sink over a byte buffer (truncates instead of failing mid-line).
struct Buf<'a> {
    b: &'a mut [u8],
    n: usize,
}
impl Write for Buf<'_> {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let room = self.b.len().saturating_sub(self.n);
        if s.len() > room {
            return Err(core::fmt::Error);
        }
        self.b[self.n..self.n + s.len()].copy_from_slice(s.as_bytes());
        self.n += s.len();
        Ok(())
    }
}

const ALIGN: usize = core::mem::align_of::<Mesh>();

/// Bytes the transport allocates for the mesh (the state plus alignment slack).
#[no_mangle]
pub extern "C" fn ns_mesh_size() -> u32 {
    (core::mem::size_of::<Mesh>() + ALIGN) as u32
}

/// Build the mesh in `block` (`ns_mesh_size()` bytes, any alignment) for this node's `mac`
/// on channel `channel`; `counter_mark` is the persisted frame-counter mark (0 if none).
/// Returns the mesh, or null. Built in place, field by field, it needs ~10 KB of stack
/// (above loopTask's headroom): the transport runs it on the tick's stack in the same
/// block, which is idle until the first tick.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_create(block: *mut u8, len: u32, mac: *const u8, channel: u8, counter_mark: u64, now_us: i64) -> *mut Mesh {
    if block.is_null() || (len as usize) < core::mem::size_of::<Mesh>() + ALIGN {
        return core::ptr::null_mut();
    }
    let off = block.align_offset(ALIGN);
    let p = block.add(off) as *mut Mesh;
    let mac = *(mac as *const [u8; 6]);
    let me = wifi_p2p::node_id_from_mac(&mac);
    // In place, field by field: by value, `Mesh` + `MeshStack::new` + `NetOf::new` took ~53 KB
    // of stack temporaries (mesh_smoke r2/r3 overflowed 40 / 30 KB create stacks).
    if !build_stack(core::ptr::addr_of_mut!((*p).stack), me, mac, channel, counter_mark) {
        return core::ptr::null_mut();
    }
    if (*p).stack.scratch_len() > SCRATCH {
        core::ptr::drop_in_place(core::ptr::addr_of_mut!((*p).stack));
        return core::ptr::null_mut();
    }
    use core::ptr::addr_of_mut as f;
    put(f!((*p).radio), || Mac { pwr: 0x14 });
    put(f!((*p).rule), || ChannelRule::default());
    f!((*p).scratch).write_bytes(0, 1);
    f!((*p).rxv).write_bytes(0, 1);
    put(f!((*p).block), || block);
    put(f!((*p).on_us), || now_us);
    put(f!((*p).provisioned_us), || None);
    put(f!((*p).member_us), || None);
    put(f!((*p).paused_us), || 0);
    put(f!((*p).pause_since), || None);
    put(f!((*p).last_tick_us), || 0);
    put(f!((*p).tick_max_us), || 0);
    put(f!((*p).tick_n), || 0);
    put(f!((*p).test), || TestJob::default());
    for i in 0..TEST_PEERS {
        put(f!((*p).test_rx[i]), || None);
    }
    put(f!((*p).controls), || 0);
    put(f!((*p).packets), || 0);
    put(f!((*p).counter_writes), || 0);
    put(f!((*p).counter_fail), || 0);
    put(f!((*p).camp_reported), || 0);
    f!((*p).log).write_bytes(0, 1);
    put(f!((*p).log_len), || 0);
    put(f!((*p).aux), || [0; 2]);
    put(f!((*p).staged), || (0, 0, 0));
    put(f!((*p).ap_bssid), || [0; 6]);
    put(f!((*p).ap_last_s), || 0);
    put(f!((*p).tsf_mode), || 0);
    put(f!((*p).tb_mine), || None);
    put(f!((*p).tb_gen), || None);
    put(f!((*p).tb_next_us), || 0);
    put(f!((*p).tb_writes), || 0);
    put(f!((*p).tb_busy), || 0);
    put(f!((*p).tb_originated), || 0);
    put(f!((*p).tb_align), || false);
    put(f!((*p).tstat_next_us), || 0);
    put(f!((*p).last_state), || SyncState::Unsynced);
    mesh_gw::Gw::init_in(f!((*p).gw));
    put(f!((*p).gw_local_op), || 0);
    put(f!((*p).tb_app), || None);
    put(f!((*p).tb_refused), || 0);
    f!((*p).xfer).write_bytes(0, 1);
    put(f!((*p).conns), || 0);
    put(f!((*p).status_us), || i64::MIN / 2);
    put(f!((*p).dirty), || false);
    put(f!((*p).persist), || false);
    put(f!((*p).want_off), || false);
    put(f!((*p).crypto_us_max), || 0);
    put(f!((*p).crypto_us_last), || 0);
    put(f!((*p).owner_token), || None);
    put(f!((*p).blobs), || mesh_blob::Slots::new());
    put(f!((*p).bs), || mesh_blob::BlobState::new());
    p
}

/// The stack, built in place at `dst` (`MeshStack::init_in_with`: the backhaul and the
/// device key are built in their slots too, and no field is a by-value copy on the stack).
#[inline(never)]
unsafe fn build_stack(dst: *mut Stack, me: NodeId, mac: [u8; 6], channel: u8, counter_mark: u64) -> bool {
    let cfg = StackConfig { counter_mark, ..StackConfig::default() };
    MeshStack::init_in_with(dst, me, mac, |p| put_backhaul(p, mac, channel), |p| put_devkey(p, &mac), EspRng, cfg).is_ok()
}

/// `f()` into `dst` from a frame of its own (see `splanc_mesh::stack`'s `put`): the stack a
/// field-by-field build needs is its largest field's.
#[inline(never)]
unsafe fn put<T>(dst: *mut T, f: impl FnOnce() -> T) {
    dst.write(f())
}

#[inline(never)]
unsafe fn put_backhaul(p: *mut WifiP2p, mac: [u8; 6], channel: u8) {
    p.write(WifiP2p::new(P2pConfig::new(mac), channel));
}

#[inline(never)]
unsafe fn put_devkey(p: *mut DevKey, mac: &[u8; 6]) {
    p.write(DevKey::load(mac));
}

/// The persisted mesh state (`/lfs/mesh.bin`, `len` bytes) at `MESH ON` (M7): the device is
/// provisioned as before and searches for its mesh. 1 if it was valid.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_restore(m: *mut Mesh, state: *const u8, len: u32, now_us: i64) -> u32 {
    let m = &mut *m;
    let b = core::slice::from_raw_parts(state, len as usize);
    // A record with the provisioner token (D-324), or a bare state (written before it).
    let (b, tok) = match b.len() {
        RECORD_LEN => (&b[..STATE_LEN], (b[STATE_LEN] == 1).then(|| b[STATE_LEN + 1..].try_into().unwrap_or([0; OWNER_TOKEN_LEN]))),
        _ => (b, None),
    };
    let Some(s) = MeshState::decode(b) else {
        m.log(format_args!("[mesh] stored state unusable ({len} B): not restored"));
        return 0;
    };
    m.stack.node.backhaul.cfg.mesh_id = Some(s.mesh_id);
    m.stack.restore(now_us, s);
    m.provisioned_us = Some(now_us);
    m.persist = true;
    m.owner_token = tok;
    let me = m.stack.me();
    m.log(format_args!(
        "[mesh] restored id={me:04x} mesh_id={:08x} epoch={} mode={} admin_key={} site_secret={} revoked={} groups={}",
        s.mesh_id,
        s.epoch,
        mode_name(s.mode),
        s.admin_key.is_some() as u8,
        s.site_secret.is_some() as u8,
        s.revoked.len(),
        s.groups.len()
    ));
    1
}

/// The mesh state to persist, if it changed (call after each pass, on loopTask): -1 = erase
/// the stored state, 0 = nothing to do, n = write `out[..n]` (`cap` >= [`ns_mesh_state_len`]).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_persist(m: *mut Mesh, out: *mut u8, cap: u32) -> i32 {
    let m = &mut *m;
    if !m.dirty {
        return 0;
    }
    m.dirty = false;
    if !m.persist {
        return 0;
    }
    let out = core::slice::from_raw_parts_mut(out, cap as usize);
    match m.stack.membership.state {
        None => {
            m.owner_token = None;
            -1
        }
        Some(_) if out.len() < RECORD_LEN => 0,
        Some(s) => {
            if s.encode_into(&mut out[..STATE_LEN]) != STATE_LEN {
                return 0;
            }
            out[STATE_LEN] = m.owner_token.is_some() as u8;
            out[STATE_LEN + 1..RECORD_LEN].copy_from_slice(&m.owner_token.unwrap_or([0; OWNER_TOKEN_LEN]));
            RECORD_LEN as i32
        }
    }
}

/// Bytes of the persisted state.
#[no_mangle]
pub extern "C" fn ns_mesh_state_len() -> u32 {
    RECORD_LEN as u32
}

/// One session crypto job (a grant's ECDSA verify plus an ECDH, or a member Ack's ECDH),
/// if any is waiting. The transport calls it after the tick on the tick's stack: never on
/// the render task, never per command (design §7.9). 1 if it ran one.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_crypto(m: *mut Mesh, now_us: i64) -> u32 {
    let m = &mut *m;
    if !m.stack.crypto_pending() {
        return 0;
    }
    let t0 = esp_timer_get_time();
    let ran = m.stack.run_crypto(now_us);
    let dt = (esp_timer_get_time() - t0).clamp(0, u32::MAX as i64) as u32;
    if ran {
        m.crypto_us_last = dt;
        m.crypto_us_max = m.crypto_us_max.max(dt);
        let n = m.stack.crypto_jobs;
        m.log(format_args!("[mesh] crypto job={n} us={dt}"));
    }
    ran as u32
}

#[no_mangle]
pub unsafe extern "C" fn ns_mesh_crypto_staged(m: *mut Mesh) {
    let t = (*m).staged.0;
    ns_mesh_crypto(m, t);
}

pub(crate) fn mode_name(m: Mode) -> &'static str {
    match m {
        Mode::Open => "open",
        Mode::Closed => "closed",
        Mode::Locked => "locked",
    }
}

/// The raw block the mesh was built in (the transport keeps the tick stack after it).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_block(m: *mut Mesh) -> *mut u8 {
    (*m).block
}

/// Two words the transport keeps in the block (its mutex for the tick stack).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_aux(m: *mut Mesh) -> *mut usize {
    (*m).aux.as_mut_ptr()
}

/// Stage [`ns_mesh_tick`]'s arguments; [`ns_mesh_tick_staged`] runs it (the transport calls
/// that on the tick stack, which takes no arguments).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_stage(m: *mut Mesh, now_us: i64, radio_ch: u8, ap_ch: u8) {
    (*m).staged = (now_us, radio_ch, ap_ch);
}

#[no_mangle]
pub unsafe extern "C" fn ns_mesh_tick_staged(m: *mut Mesh) {
    let (t, r, a) = (*m).staged;
    ns_mesh_tick(m, t, r, a);
}

/// The raw block to free after [`ns_mesh_destroy`].
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_destroy(m: *mut Mesh) -> *mut u8 {
    if m.is_null() {
        return core::ptr::null_mut();
    }
    let b = (*m).block;
    // The transport took back any staged frame first (lm_fx_stage_cancel).
    (*m).blobs.free_all();
    range_enable(&mut *m, false);
    core::ptr::drop_in_place(m);
    b
}

/// The 92-byte buffer the transport reaps RX vectors into while the mesh is on.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_rxv(m: *mut Mesh) -> *mut u8 {
    (*m).rxv.as_mut_ptr()
}

/// A reaped frame, before the STA path: 0 = not Splanc (the STA path's), 1 = a mesh frame
/// (taken), 2 = a Splanc frame of another kind (diagnostics; the caller's).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_rx(m: *mut Mesh, frame: *const u8, len: u32, have_rxv: u32, reap_us: i64) -> u32 {
    let m = &mut *m;
    let f = core::slice::from_raw_parts(frame, len as usize);
    let rxv = if have_rxv != 0 { Some(&m.rxv[..]) } else { None };
    match m.stack.node.backhaul.on_frame(reap_us, f, rxv) {
        RxVerdict::NotSplanc => {
            if have_rxv != 0 {
                ap_beacon(m, f, reap_us);
            }
            0
        }
        RxVerdict::Taken => 1,
        RxVerdict::OtherKind(_) => 2,
    }
}

/// Our AP's beacon (the HITL's common reference, M4): once per AP-TSF second, log the AP's
/// TSF, the beacon's arrival on our clock (the same RX-vector mapping mesh time uses) and
/// mesh time then. Every member hears the same beacon at the same instant (± propagation),
/// so comparing these lines across members measures mesh-time agreement directly.
fn ap_beacon(m: &mut Mesh, f: &[u8], reap_us: i64) {
    // Beacon: FC 0x80, BSSID at 16..22, the TSF at 24..32 (little-endian).
    if f.len() < 32 || f[0] != 0x80 || f[16..22] != m.ap_bssid || m.ap_bssid == [0; 6] {
        return;
    }
    let Some(v) = ledmapper_netstack::p2p::RxVector::decode(&m.rxv) else { return };
    let tsf = u64::from_le_bytes([f[24], f[25], f[26], f[27], f[28], f[29], f[30], f[31]]);
    let s = tsf / 1_000_000;
    if s == m.ap_last_s {
        return;
    }
    m.ap_last_s = s;
    let rx = m.stack.node.backhaul.clock.map(reap_us, v.timestamp_us);
    let t = &m.stack.time;
    let st = t.state.name();
    let mesh = t.mesh_us(rx);
    m.log(format_args!("[mt] ap tsf={tsf} rx={rx} hw={} mesh={mesh} st={st} lag={}", v.timestamp_us, reap_us - rx));
}

/// A TSF reading for the RX-stamp mapping: `esp_before`, the TSF counter, `esp_after`.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_clock(m: *mut Mesh, esp_before: i64, tsf: u32, esp_after: i64) {
    (*m).stack.node.backhaul.clock.anchor(esp_before, tsf, esp_after);
}

/// The AP we are associated to (zero: none).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_set_ap(m: *mut Mesh, bssid: *const u8) {
    (*m).ap_bssid = *(bssid as *const [u8; 6]);
}

/// Read a setting: 5 = the TSF read mode, 6 = mesh time synced (1/0), 7 = the mesh wants
/// to be turned off (it left, or was ejected; M7), 8 = session crypto is waiting.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_get(m: *mut Mesh, what: u32) -> u32 {
    let m = &*m;
    match what {
        5 => m.tsf_mode as u32,
        6 => m.stack.time.synced() as u32,
        7 => m.want_off as u32,
        8 => m.stack.crypto_pending() as u32,
        9 => (m.dirty && m.persist) as u32,
        _ => 0,
    }
}

/// Originate a show epoch `delta_ms` after mesh-time now (console `MESH EPOCH`, tests);
/// `clear` != 0 clears it. 0 if mesh time is not synced yet.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_epoch(m: *mut Mesh, delta_ms: i64, clear: u32, now_us: i64) -> u32 {
    let m = &mut *m;
    if !m.stack.time.synced() {
        return 0;
    }
    let e = if clear != 0 { None } else { Some(m.stack.time.mesh_us(now_us) + delta_ms * 1000) };
    match m.stack.originate_epoch(EpochSource::Console, e) {
        Some(se) => {
            log_epoch(m, "originated", se);
            1
        }
        None => 0,
    }
}

fn log_epoch(m: &mut Mesh, what: &str, e: ShowEpoch) {
    match e.epoch_mesh_us {
        Some(x) => m.log(format_args!("[mt] epoch {what} gen={} origin={:04x} mesh={x}", e.gen, e.origin)),
        None => m.log(format_args!("[mt] epoch {what} gen={} origin={:04x} cleared", e.gen, e.origin)),
    }
}

/// Reconcile the player's time base with the mesh's show epoch (§6.3): a time base the app
/// set here originates a new generation; otherwise the time base is the epoch mapped onto
/// our clock (re-mapped as mesh time slews), and the queued apply_at changes move with it.
unsafe fn time_base(m: &mut Mesh, now_us: i64) {
    if now_us < m.tb_next_us || !m.stack.time.synced() {
        return;
    }
    m.tb_next_us = now_us + TB_EVERY_US;
    let mut cur = 0i64;
    let r = lm_mesh_tb(0, &mut cur, 0);
    if r < 0 {
        m.tb_busy += 1;
        m.tb_next_us = now_us + 2_000;
        return;
    }
    let player = (r == 1).then_some(cur);
    let off = m.stack.time.clock.offset_us;
    // The app changed it (or set one before the mesh had an epoch): a new generation, if
    // the connection it came from may start one (desk #79, `EPOCH_POLICY`). Otherwise the
    // time base goes back to the mesh's epoch below (members follow).
    let changed = match m.tb_mine {
        Some(mine) => mine != player,
        None => player.is_some() && m.stack.time.epoch.is_none(),
    };
    if changed {
        let by = m.tb_app.take();
        match by.and_then(|c| m.stack.originate_epoch(EpochSource::Connection(c), player.map(|ms| ms * 1000 + off))) {
            Some(e) => {
                m.tb_originated += 1;
                m.tb_mine = Some(player);
                m.tb_gen = Some((e.gen, e.origin));
                log_epoch(m, "originated", e);
            }
            None => {
                m.tb_refused += 1;
                let n = m.tb_refused;
                m.log(format_args!("[mt] epoch refused (not the gateway's session: conn={}) n={n}", by.map_or(-1, |c| c as i64)));
                if m.stack.time.epoch.is_none() {
                    // Nothing to follow yet: leave the app's time base alone.
                    m.tb_mine = Some(player);
                    return;
                }
            }
        }
    }
    let Some(e) = m.stack.time.epoch else { return };
    let want = e.epoch_mesh_us.map(|x| (x - off).div_euclid(1000) + i64::from((x - off).rem_euclid(1000) >= 500));
    let same_gen = m.tb_gen == Some((e.gen, e.origin));
    if want != player {
        let mut v = want.unwrap_or(0);
        // Same generation: mesh time moved (a slew or step), so the queued changes move by
        // the same amount and still land on their frames. A new generation re-bases.
        let shift = match (same_gen, want, player) {
            (true, Some(w), Some(p)) => w - p,
            _ => 0,
        };
        let r = if want.is_some() { lm_mesh_tb(1, &mut v, shift) } else { lm_mesh_tb(2, &mut v, 0) };
        if r < 0 {
            m.tb_busy += 1;
            m.tb_next_us = now_us + 2_000;
            return;
        }
        m.tb_writes += 1;
        if !same_gen {
            let (g, o) = (e.gen, e.origin);
            m.log(format_args!("[mt] timebase gen={g} origin={o:04x} local_ms={} shift={shift}", want.unwrap_or(-1)));
        }
    }
    m.tb_mine = Some(want);
    m.tb_gen = Some((e.gen, e.origin));
    let align = want.is_some();
    if align != m.tb_align {
        let mut a = align as i64;
        if lm_mesh_tb(3, &mut a, 0) >= 0 {
            m.tb_align = align;
        }
    }
}

/// Mesh-time log lines: state changes, steps, and a periodic status.
fn time_log(m: &mut Mesh, now_us: i64, adj_before: (u32, u32)) {
    let t = &m.stack.time;
    let (state, steps, epochs) = (t.state, t.stats.steps, t.stats.epochs);
    if state != m.last_state {
        let off = t.clock.offset_us;
        let (j, f) = (t.stats.joined, t.stats.founded);
        m.last_state = state;
        m.log(format_args!("[mt] state {} off={off} joined={j} founded={f}", state.name()));
    }
    if steps != adj_before.0 {
        if let Adjust::Step(d) = m.stack.time.last_adjust {
            m.log(format_args!("[mt] step {d} us"));
        }
    }
    if epochs != adj_before.1 {
        if let Some(e) = m.stack.time.epoch {
            log_epoch(m, "heard", e);
        }
    }
    if now_us >= m.tstat_next_us {
        m.tstat_next_us = now_us + TSTAT_EVERY_US;
        let t = &m.stack.time;
        let est = t.last_est;
        let c = m.stack.node.backhaul.clock.stats;
        let conf = est.map_or("none", |e| match e.confidence {
            splanc_mesh::timesync::Confidence::High => "high",
            splanc_mesh::timesync::Confidence::Low => "low",
            splanc_mesh::timesync::Confidence::None => "none",
        });
        let (name, mesh, off, err, agree) = (t.state.name(), t.mesh_us(now_us), t.clock.offset_us, t.err_us, est.map_or(0, |e| e.agree));
        let (slewed, steps) = (t.stats.slewed_us, t.stats.steps);
        let peers = t.peers.iter().flatten().filter(|p| now_us - p.heard_us < 3_000_000).count();
        let (tw, tbz) = (m.tb_writes, m.tb_busy);
        m.log(format_args!(
            "[mt] st {name} now={now_us} mesh={mesh} off={off} err={err} agree={agree} conf={conf} slewed={slewed} steps={steps} peers={peers} hw={} floor={} lag={}..{} tsf_off={} drift_ppb={} jumps={} tb_writes={tw} tb_busy={tbz}",
            c.mapped_hw, c.mapped_floor, c.lag_min_us, c.lag_max_us, c.offset_us, c.drift_ppb, c.jumps,
        ));
    }
}

/// Collect the in-flight frame's outcome without arming another (the STA path's wait in
/// `tx_pace_before`, so it never arms queue 0 under a mesh frame). 1 while still in flight.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_settle(m: *mut Mesh, now_us: i64) -> u32 {
    let m = &mut *m;
    m.stack.node.backhaul.settle(now_us, &mut m.radio) as u32
}

/// Drive TX (the transport spins on it for a bounded time after each tick). Returns 1
/// while a frame is in flight.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_pump(m: *mut Mesh, now_us: i64) -> u32 {
    let m = &mut *m;
    if m.pause_since.is_none() {
        m.stack.node.backhaul.pump(now_us, &mut m.radio);
    }
    m.stack.node.backhaul.inflight() as u32
}

/// One loop pass: channel rule, the stack (RX, timers, beacons, the mesh slot, delivery),
/// test traffic, the counter mark. `radio_ch`: the channel the radio is on (0: a background
/// sweep has it elsewhere); `ap_ch`: the AP's channel while associated, else 0.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_tick(m: *mut Mesh, now_us: i64, radio_ch: u8, ap_ch: u8) {
    let m = &mut *m;
    let t0 = now_us;
    // Channel (§4.2, AP-anchored).
    if radio_ch == 0 {
        m.pause_since.get_or_insert(now_us);
    } else {
        if let Some(s) = m.pause_since.take() {
            m.paused_us += now_us - s;
        }
        m.stack.node.backhaul.set_channel(radio_ch);
        let heard = m.stack.heard_channel(now_us);
        match m.rule.decide((ap_ch != 0).then_some(ap_ch), radio_ch, heard) {
            ChannelAction::Stay => {}
            ChannelAction::Followed { from, to } => {
                m.stack.set_channel(to);
                let moves = m.rule.moves;
                m.log(format_args!("[mesh] channel: followed the AP {from} -> {to} (moves={moves})"));
            }
            ChannelAction::Camp { to } => {
                // kModeMesh (next PR) tunes here; AP-anchored only reports it, once per channel.
                if m.camp_reported != to {
                    m.camp_reported = to;
                    m.log(format_args!("[mesh] channel: not associated; mesh adverts announce ch {to} (radio on {radio_ch})"));
                }
            }
        }
        if ap_ch != 0 && m.rule.channel == ap_ch {
            m.stack.set_channel(ap_ch);
        }
    }
    // Test traffic (one packet per pass at most, while the mesh can queue it).
    if m.test.active && now_us >= m.test.next_us && m.stack.node.net.mesh.can_send() {
        let j = &mut m.test;
        let mut body = [0u8; P];
        let len = (j.len as usize).clamp(12, P);
        body[0] = T_TEST;
        body[1] = j.tag;
        body[2..6].copy_from_slice(&j.seq.to_le_bytes());
        body[6..10].copy_from_slice(&(now_us as u32).to_le_bytes());
        body[10] = j.port;
        let port = Port::from_u8(j.port).unwrap_or(Port::Status);
        match m.stack.send(j.dst, port, &body[..len], j.want_ack) {
            Ok(_) => {
                j.sent += 1;
                j.seq += 1;
            }
            Err(_) => j.refused += 1,
        }
        j.next_us = j.next_us.max(now_us - 10 * j.iv_us as i64) + j.iv_us as i64;
        if j.sent >= j.n {
            j.active = false;
            let (tag, sent, refused) = (j.tag, j.sent, j.refused);
            m.log(format_args!("[mesh] testend tag={tag} sent={sent} refused={refused}"));
        }
    }
    // The stack.
    let was_member = m.stack.membership.is_member();
    let adj_before = (m.stack.time.stats.steps, m.stack.time.stats.epochs);
    let mut mark = None;
    let (mut ctl, mut pkt) = (0u32, 0u32);
    let mut rx_log: [Option<(NodeId, u8, u8, u32)>; 4] = [None; 4];
    // Relayed control for this member (M5): copied out of the tick, judged after it.
    let mut ctl_in: [Option<(NodeId, u32, bool, u8, [u8; P])>; mesh_gw::INBOX] = [None; mesh_gw::INBOX];
    // Membership (M7): what changed, logged and persisted after the tick.
    let mut changed = false;
    let mut ejected = false;
    let mut joined: Option<u8> = None;
    let mut rekeyed: Option<u8> = None;
    let mut pending: Option<splanc_mesh::msg::PendingJoin> = None;
    let mut synced: Option<(u32, NodeId)> = None;
    let mut renew: Option<(u32, u32)> = None;
    let mut blob_log: Option<(NodeId, u32, u16)> = None;
    {
        let Mesh { stack, scratch, test_rx, blobs, bs, .. } = m;
        blobs.now_us = now_us;
        stack.tick_blobs(now_us, &mut NoFlash, blobs, scratch, &mut |e| match e {
            Event::Control { origin, header, inner } => {
                ctl += 1;
                if let Some(slot) = ctl_in.iter_mut().find(|s| s.is_none()) {
                    let mut b = [0u8; P];
                    let n = inner.len().min(P);
                    b[..n].copy_from_slice(&inner[..n]);
                    *slot = Some((origin, header.op_id, header.want_reply(), n as u8, b));
                }
            }
            Event::Packet { origin, port, body, .. } => {
                pkt += 1;
                if body.len() >= 10 && body[0] == T_TEST {
                    let tag = body[1];
                    let seq = u32::from_le_bytes([body[2], body[3], body[4], body[5]]);
                    let fresh = note_test(test_rx, origin, tag, port as u8, seq);
                    if fresh && seq < 2 {
                        if let Some(s) = rx_log.iter_mut().find(|s| s.is_none()) {
                            *s = Some((origin, tag, port as u8, seq));
                        }
                    }
                }
            }
            Event::PersistCounter(c) => mark = Some(c),
            Event::Joined { epoch } => {
                changed = true;
                joined = Some(epoch);
            }
            Event::Rekeyed { epoch } => {
                changed = true;
                rekeyed = Some(epoch);
            }
            Event::StateChanged => changed = true,
            Event::Ejected => ejected = true,
            Event::Pending(p) => pending = Some(p),
            Event::SessionSynced { session, gateway } => synced = Some((session, gateway)),
            Event::GrantRenewalDue { session, not_after } => renew = Some((session, not_after)),
            // Effect sharing (M6): applied after the tick, on loopTask's stack.
            Event::Scene { origin, msg } => bs.work.scene = Some((origin, msg)),
            Event::Fetched { op_id, have, of } => bs.work.fetched = Some((op_id, have, of)),
            Event::CatchUp { node } => bs.work.catch_up = Some(node),
            Event::SceneFailed { origin, op_id, code } => blob_log = Some((origin, op_id, code)),
            _ => {}
        });
    }
    m.dirty |= changed || ejected;
    if ejected {
        m.want_off = true;
        m.log(format_args!("[mesh] ejected by the admin: left the mesh"));
    }
    if let Some(e) = joined {
        m.log(format_args!("[mesh] joined epoch={e}"));
    }
    if let Some(e) = rekeyed {
        let n = m.stack.membership.state.map_or(0, |s| s.revoked.len());
        m.log(format_args!("[mesh] rekeyed epoch={e} revoked={n}"));
    }
    if let Some(p) = pending {
        m.log(format_args!("[mesh] pending join node={:04x} key={:016x} heard_by={:04x}", p.node, u64::from_be_bytes(p.key_hash), p.heard_by));
    }
    if let Some((s, g)) = synced {
        m.log(format_args!("[mesh] session synced session={s} gateway={g:04x}"));
    }
    if let Some((s, t)) = renew {
        m.log(format_args!("[mesh] grant renewal due session={s} not_after={t}"));
    }
    if let Some((o, op, code)) = blob_log {
        let b = m.stack.blobs.stats;
        let _ = (o, b);
        m.log(format_args!("[mesh] scene failed op={op:x} code={code:x}"));
    }
    m.controls += ctl;
    m.packets += pkt;
    for (origin, op, want, n, b) in ctl_in.into_iter().flatten() {
        mesh_gw::on_control(m, origin, op, want, &b[..n as usize]);
    }
    for (origin, tag, port, seq) in rx_log.into_iter().flatten() {
        m.log(format_args!("[mesh] testrx first from={origin:04x} tag={tag} port={port} seq={seq}"));
    }
    if !was_member && m.stack.membership.is_member() {
        m.member_us = Some(now_us);
        let ms = (now_us - m.provisioned_us.unwrap_or(m.on_us)) / 1000;
        m.log(format_args!("[mesh] member id={:04x} after {ms} ms", m.stack.me()));
    }
    // §7.5: persist the counter's next reservation before the envelope may use it.
    if let Some(c) = mark {
        if lm_mesh_counter_store(c) != 0 {
            m.stack.node.guard.counter_reserved(c);
            m.counter_writes += 1;
        } else {
            m.counter_fail += 1;
        }
    }
    // Mesh time (M4): the player's time base follows the mesh's show epoch.
    time_base(m, now_us);
    time_log(m, now_us, adj_before);
    // TX: a few frames per pass (one in flight at a time; the transport spins on
    // `ns_mesh_pump` only when the STA path needs the queue).
    if m.pause_since.is_none() {
        m.stack.node.backhaul.pump(now_us, &mut m.radio);
    }
    let dt = (now_us - t0).max(0) as u32;
    m.tick_max_us = m.tick_max_us.max(dt);
    m.tick_n += 1;
    m.last_tick_us = now_us;
}

fn note_test(rx: &mut [Option<TestRx>; TEST_PEERS], origin: NodeId, tag: u8, port: u8, seq: u32) -> bool {
    let i = rx
        .iter()
        .position(|r| r.is_some_and(|r| r.origin == origin && r.tag == tag))
        .or_else(|| rx.iter().position(|r| r.is_none()))
        .unwrap_or(TEST_PEERS - 1);
    let r = rx[i].get_or_insert(TestRx { origin, tag, port, uniq: 0, dups: 0, max_seq: 0, got: [0; TEST_SEQS / 8] });
    if r.origin != origin || r.tag != tag {
        *r = TestRx { origin, tag, port, uniq: 0, dups: 0, max_seq: 0, got: [0; TEST_SEQS / 8] };
    }
    r.max_seq = r.max_seq.max(seq);
    if (seq as usize) < TEST_SEQS {
        let (b, bit) = (seq as usize / 8, 1u8 << (seq % 8));
        if r.got[b] & bit != 0 {
            r.dups += 1;
            return false;
        }
        r.got[b] |= bit;
    }
    r.uniq += 1;
    true
}

/// Effect sharing's work after a tick (M6, mesh_blob.rs): the staged load's outcome, a
/// scene to apply, the gateway's second phase and catch-ups. The transport calls it on
/// loopTask's stack (never the tick's): applying dispatches like an app message.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_scenes(m: *mut Mesh, now_us: i64) {
    mesh_blob::after_tick(&mut *m, now_us);
}

/// Move the event log into `out` (`cap` bytes); returns the bytes written (whole lines).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_take_log(m: *mut Mesh, out: *mut u8, cap: u32) -> u32 {
    let m = &mut *m;
    // Whole lines that fit; the rest waits for the next pass (a 300-byte status line and a
    // beacon line can share a pass).
    let mut n = m.log_len.min(cap as usize);
    if n < m.log_len {
        n = m.log[..n].iter().rposition(|&c| c == b'\n').map_or(0, |i| i + 1);
    }
    core::ptr::copy_nonoverlapping(m.log.as_ptr(), out, n);
    m.log.copy_within(n..m.log_len, 0);
    m.log_len -= n;
    n as u32
}

/// Provision with the dev-only site key (owner desk #67: spike only; the transport offers
/// it on the console only in the `LM_MESH_DEVKEY` image). `secret`: 32 bytes. The AP's
/// channel (or the radio's) is the mesh channel (AP-anchored).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_dev_provision(m: *mut Mesh, mesh_id: u32, secret: *const u8, channel: u8, now_us: i64) {
    let m = &mut *m;
    let s = *(secret as *const [u8; 32]);
    let c = Credentials { mesh_id, channel, mode: Mode::Closed, site_secret: Some(s), ..Default::default() };
    m.stack.node.backhaul.cfg.mesh_id = Some(mesh_id);
    m.stack.provision(now_us, &c, ProvisionSource::App);
    m.provisioned_us = Some(now_us);
    m.member_us = None;
    // Never persisted (desk #67): the dev key lives only until MESH OFF or a reboot.
    m.persist = false;
}

/// Leave the mesh from the console (`MESH LEAVE`, physical access: the recovery path when the
/// app lost the admin secret, design §7.9): the state and its admin key are erased and the
/// mesh turns off.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_leave(m: *mut Mesh) {
    let m = &mut *m;
    m.stack.leave();
    m.persist = true;
    m.dirty = true;
    m.want_off = true;
    m.log(format_args!("[mesh] left the mesh (console)"));
}

/// Dev image only (`MESH FORGE`): what an insider holding the mesh key could put on the air,
/// to prove members refuse it on a mesh with an admin key. `kind` 0: relay `data` (an encoded
/// ClientMessage) as envelope-trust control, no grant, no per-receiver MACs; 1: originate a
/// show epoch `data` (i64 ms after mesh-time now, little-endian) in our beacons, bypassing
/// the epoch policy. 1 if it went out.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_dev_forge(m: *mut Mesh, kind: u32, data: *const u8, len: u32, now_us: i64) -> u32 {
    let m = &mut *m;
    let d = core::slice::from_raw_parts(data, len as usize);
    match kind {
        0 => {
            let st = &mut m.stack;
            let mut body = [0u8; P];
            let Some(n) = splanc_mesh::ports::ControlHeader::new(0x7e57_0000 | (now_us as u32 & 0xffff), splanc_mesh::ports::Targets::All).encode(d, &mut body) else { return 0 };
            let Some(seq) = st.node.guard.next_sequence() else { return 0 };
            let mut buf = [0u8; P + 16];
            let mesh_id = st.node.guard.mesh_id;
            let Some(k) = splanc_mesh::admin::seal_command(mesh_id, splanc_mesh::ports::SESSION_ENVELOPE, seq, Port::Control as u8, &body[..n], &[], &mut buf) else { return 0 };
            if k > st.node.max_payload() {
                return 0;
            }
            let ok = st.node.net.send(swarm_net::mesh::BROADCAST, Port::Control as u8, &buf[..k], false).is_some();
            m.log(format_args!("[mesh] forged envelope control len={} sent={}", d.len(), ok as u8));
            ok as u32
        }
        1 if d.len() == 8 && m.stack.time.synced() => {
            let ms = i64::from_le_bytes(d.try_into().unwrap_or([0; 8]));
            let e = m.stack.time.originate(Some(m.stack.time.mesh_us(now_us) + ms * 1000));
            log_epoch(m, "forged", e);
            1
        }
        _ => 0,
    }
}

/// Settings: `what` 0 = group policy (0 bcast, 1 unicast), 1 = broadcast rate code,
/// 2 = unicast rate code, 3 = tries, 4 = TX power byte, 5 = TSF read mode (0 floor, 1 raw,
/// 2 latched), 6 = time beacon period (ms, 0 off), 7 = link ranging on/off, 8 = its zero-range
/// constant K (raw units x 16), 9 = K is calibrated (1/0), 10 = the ranging period (ms),
/// 11 = force the FTM phase state on enable (1/0), 12 = force it again now.
/// Returns 1 if applied.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_set(m: *mut Mesh, what: u32, v: u32) -> u32 {
    let m = &mut *m;
    let c = &mut m.stack.node.backhaul.cfg;
    match what {
        0 => c.policy = if v == 0 { GroupPolicy::Broadcast } else { GroupPolicy::Unicast },
        1 if ledmapper_netstack::p2p::rate_kbps(v as u8) != 0 => c.rate_bcast = v as u8,
        2 if ledmapper_netstack::p2p::rate_kbps(v as u8) != 0 => c.rate_ucast = v as u8,
        3 if (1..=8).contains(&v) => c.tries = v as u8,
        4 if v <= 0x7f => m.radio.pwr = v as u8,
        5 if v <= 2 => m.tsf_mode = v as u8,
        // The time beacon period (ms; 0: off).
        6 if v <= 10_000 => m.stack.set_time_beacon_us(v as i64 * 1000),
        // Link ranging (splanc_mesh::ranging): off by default.
        7 => return range_enable(m, v != 0) as u32,
        8 if (1..=64_000).contains(&v) => m.stack.node.backhaul.ranging.cfg.k_raw_x16 = v as i32,
        9 => m.stack.node.backhaul.ranging.cfg.calibrated = v != 0,
        10 if (500..=600_000).contains(&v) => m.stack.node.backhaul.ranging.cfg.period_us = v as i64 * 1000,
        // 11: force the phase on enable (1/0); 12: force it again now (when TX is idle).
        11 => m.stack.node.backhaul.ranging.cfg.force_phase = v != 0,
        12 => m.stack.node.backhaul.ranging.force_pending = true,
        _ => return 0,
    }
    1
}

/// `MALLOC_CAP_8BIT | MALLOC_CAP_INTERNAL`.
const CAPS_INTERNAL: u32 = (1 << 2) | (1 << 11);

/// Link ranging on (its ~4 KB table from the heap, so ranging off costs the mesh nothing)
/// or off (the table freed). False if the table cannot be allocated.
fn range_enable(m: &mut Mesh, on: bool) -> bool {
    use splanc_mesh::ranging::PeerTable;
    let r = &mut m.stack.node.backhaul.ranging;
    if on {
        if !r.has_table() {
            let p = unsafe { heap_caps_aligned_alloc(core::mem::align_of::<PeerTable>(), core::mem::size_of::<PeerTable>(), CAPS_INTERNAL) } as *mut PeerTable;
            if p.is_null() {
                return false;
            }
            unsafe { p.write(PeerTable::new()) };
            r.attach(unsafe { &mut *p });
        }
        r.set_enabled(true);
    } else {
        r.set_enabled(false);
        if let Some(t) = r.detach() {
            unsafe { heap_caps_free(t as *mut PeerTable as *mut u8) };
        }
    }
    true
}

/// Start a test stream: `n` packets of `len` bytes on `port` (17 = REPLY, 18 = STATUS) to
/// `dst` (0xFFFF: all), every `iv_us`, with the mesh's end-to-end ack if `want_ack`.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_test(m: *mut Mesh, dst: u16, port: u8, n: u32, iv_us: u32, len: u16, want_ack: u32, tag: u8, now_us: i64) -> u32 {
    let m = &mut *m;
    if !m.stack.membership.is_member() || Port::from_u8(port).is_none_or(|p| p.admin_class()) {
        return 0;
    }
    m.test = TestJob { active: n > 0, dst, port, want_ack: want_ack != 0, tag, len, n, iv_us: iv_us.max(1_000), next_us: now_us, ..TestJob::default() };
    1
}

/// Clear the test receive counters.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_test_reset(m: *mut Mesh) {
    (*m).test_rx = [None; TEST_PEERS];
}

/// Re-send the last data frame verbatim `n` times (the envelope's replay check, HITL).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_replay(m: *mut Mesh, n: u32) -> u32 {
    let m = &mut *m;
    let mut k = 0;
    for _ in 0..n {
        if m.stack.node.backhaul.replay_last() {
            k += 1;
        }
    }
    k
}

/// Report line `idx` of section `what` into `out` (`cap` bytes, NUL-terminated); returns
/// its length, 0 past the last line. 0 = info, 1 = neighbours, 2 = link stats, 3 = envelope
/// and mesh stats, 4 = test receive counters.
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_report(m: *mut Mesh, what: u32, idx: u32, out: *mut u8, cap: u32, now_us: i64) -> u32 {
    let m = &*m;
    if cap == 0 {
        return 0;
    }
    let buf = core::slice::from_raw_parts_mut(out, cap as usize - 1);
    let mut w = Buf { b: buf, n: 0 };
    let ok = report(m, what, idx, now_us, &mut w);
    let n = if ok { w.n } else { 0 };
    *out.add(n) = 0;
    n as u32
}

fn phase(p: Phase) -> &'static str {
    match p {
        Phase::Unprovisioned => "unprovisioned",
        Phase::Searching { .. } => "searching",
        Phase::Joining => "joining",
        Phase::Member => "member",
    }
}

fn report(m: &Mesh, what: u32, idx: u32, now: i64, w: &mut Buf<'_>) -> bool {
    let s = &m.stack;
    let b = &s.node.backhaul;
    let since = |t: i64| (t - m.provisioned_us.unwrap_or(m.on_us)) / 1000;
    let r = match (what, idx) {
        (0, 0) => {
            let c = &b.cfg;
            write!(
                w,
                "[mesh] info id={:04x} phase={} mesh_id={:08x} ch={} rule_ch={} moves={} policy={} rate_b={} rate_u={} tries={} pwr={} member_ms={} paused_ms={} tick_max_us={} ticks={} state_bytes={} counter={} counter_writes={} counter_fail={} ts_off_us={}",
                s.me(),
                phase(s.membership.phase()),
                s.membership.mesh_id().unwrap_or(0),
                b.channel(),
                m.rule.channel,
                m.rule.moves,
                if c.policy == GroupPolicy::Unicast { "ucast" } else { "bcast" },
                c.rate_bcast,
                c.rate_ucast,
                c.tries,
                m.radio.pwr,
                m.member_us.map_or(-1, since),
                (m.paused_us + m.pause_since.map_or(0, |p| now - p)) / 1000,
                m.tick_max_us,
                m.tick_n,
                core::mem::size_of::<Mesh>(),
                s.node.guard.current_counter(),
                m.counter_writes,
                m.counter_fail,
                b.clock.offset_us().unwrap_or(0),
            )
        }
        (0, 1) => mesh_gw::report(m, w),
        (0, 2) => mesh_gw::report_membership(m, now, w),
        (0, 3) => mesh_gw::report_admin(m, w),
        (0, 4) => {
            // Effect sharing (M6).
            let (bl, st) = (&s.blobs.stats, &m.bs);
            write!(
                w,
                "[mesh] blobs fetched={} bad_hash={} stalled={} no_room={} chunks_in={} out={} applied={} loaded={} catchups={} peak={}",
                bl.fetched, bl.bad_hash, bl.stalled, bl.no_room, bl.chunks_in, bl.chunks_out, st.applied, st.loaded, st.catchups_sent, m.blobs.stats.peak,
            )
        }
        (1, i) => {
            // Link neighbours (RSSI, ACKs), joined with the stack's advert table.
            let Some(n) = b.neighbours.iter().flatten().nth(i as usize) else { return false };
            let adv = s.neighbours.iter().flatten().find(|a| a.id == n.id);
            write!(
                w,
                "[mesh] nb id={:04x} mac={:02x}:{:02x}:{:02x}:{:02x}:{:02x}:{:02x} rssi={} rssi_avg={} age_ms={} first_ms={} rx={} tx_ok={} tx_fail={} retries={} ch={} advert={} advert_age_ms={} adv_ch={}",
                n.id,
                n.mac[0],
                n.mac[1],
                n.mac[2],
                n.mac[3],
                n.mac[4],
                n.mac[5],
                n.rssi,
                n.rssi_avg(),
                (now - n.last_us) / 1000,
                since(n.first_us),
                n.rx,
                n.tx_ok,
                n.tx_fail,
                n.retries,
                n.channel,
                adv.is_some() as u8,
                adv.map_or(-1, |a| (now - a.last_us) / 1000),
                adv.map_or(0, |a| a.channel),
            )
        }
        (5, 0) => {
            // Link ranging (splanc_mesh::ranging): this device's state and counters.
            let r = &b.ranging;
            let (c, t, v) = (&r.cfg, &r.stats, &r.vote);
            write!(
                w,
                "[mesh] range self on={} phase={} votes={}/{}/{} k_x16={} cal={} period_ms={} force={} forced={} force_pending={} rx_recs={} tx_recs={} rx_bad={} tx_bad={} probes={} reports={} reports_in={} bad_msgs={} matched={} exch={} rejected={} fits={} no_fit={}",
                c.enabled as u8,
                r.phase().ticks(),
                v.low,
                v.high,
                v.other,
                c.k_raw_x16,
                c.calibrated as u8,
                c.period_us / 1000,
                c.force_phase as u8,
                t.forced,
                r.force_pending as u8,
                t.rx_recs,
                t.tx_recs,
                t.rx_bad,
                t.tx_bad,
                t.probes,
                t.reports,
                t.reports_in,
                t.bad_msgs,
                t.matched,
                t.exchanges,
                t.rejected,
                t.fits,
                t.no_fit,
            )
        }
        (5, i) => {
            // One line per ranged neighbour: its LinkRange (or none yet).
            let r = &b.ranging;
            let Some(p) = r.peers().iter().flatten().nth(i as usize - 1) else { return false };
            let l = r.link(now, p.id);
            write!(
                w,
                "[mesh] range id={:04x} range_mm={} sigma_mm={} n={} age_ms={} phase_self={} phase_peer={} cal={} ppb={}",
                p.id,
                l.map_or(i32::MIN, |l| l.range_mm),
                l.map_or(0, |l| l.sigma_mm),
                l.map_or(0, |l| l.n),
                l.map_or(-1, |l| l.age_ms as i64),
                r.phase().ticks(),
                p.phase_peer.ticks(),
                l.is_some_and(|l| l.calibrated) as u8,
                p.ppb.map_or(i64::MIN, |x| x as i64),
            )
        }
        (2, 0) => {
            let t = &b.stats;
            write!(
                w,
                "[mesh] link queued={} full={} bcast={} ucast_ok={} ucast_fail={} attempts={} retries={} ack_to={} other={} nocompl={} refused={} fanouts={} fanout_ucasts={} fanout_bcast={} rx={} overheard={} own={} dup_retry={} not_env={} overflow={} other_kind={} trimmed={} slowed={} ch_changes={}",
                t.tx_queued, t.tx_full, t.tx_bcast, t.tx_ucast_ok, t.tx_ucast_fail, t.attempts, t.retries, t.ack_timeouts, t.tx_other, t.no_completion, t.arm_refused, t.fanouts, t.fanout_ucasts, t.fanout_bcast, t.rx_frames, t.rx_overheard, t.rx_own, t.rx_dup_retry, t.rx_not_envelope, t.rx_overflow, t.rx_other_kind, t.rx_trimmed, t.slowed, t.channel_changes,
            )
        }
        (3, 0) => {
            let g = &s.node.guard.stats;
            let n = &s.node.stats;
            let ms = &s.node.net.mesh.stats;
            write!(
                w,
                "[mesh] env sealed={} sealed_long={} opened={} plain={} not_env={} foreign={} bad_mic={} dup={} too_old={} unsynced={} no_key={} unreserved={} node_rx={} node_tx={} beacons={} rejected={} tx_busy={} controls={} packets={} mesh_acked={}",
                g.sealed, g.sealed_long, g.opened, g.plain, g.not_envelope, g.foreign_mesh, g.bad_mic, g.replay_duplicate, g.replay_too_old, g.unsynced_short, g.no_key, g.counter_unreserved, n.rx, n.tx, n.beacons, n.rx_rejected, n.tx_busy, m.controls, m.packets, ms.acked,
            )
        }
        (3, 1) => {
            let ms = &s.node.net.mesh.stats;
            let mb = &s.membership.stats;
            let n = &s.node.stats;
            write!(
                w,
                "[mesh] meshst originated={} delivered={} relayed={} cancelled={} duplicates={} retries={} acked={} failed={} dropped_full={} oversize={} peak_relays={} peak_outbox={} can_send={} node_rx_plain={} node_guarded={} node_not_mesh={} node_own={} node_unsealed={} adverts_heard={} joins_heard={} foreign_plain={} malformed={} stack_nb={}",
                ms.originated, ms.delivered, ms.relayed, ms.relays_cancelled, ms.duplicates, ms.retries, ms.acked, ms.failed, ms.dropped_full, ms.oversize, ms.peak_relays, ms.peak_outbox, s.node.net.mesh.can_send() as u8, n.rx_plain, n.rx_guarded, n.rx_not_mesh, n.rx_own, n.tx_unsealed, mb.adverts_heard, mb.join_requests_heard, mb.foreign_plain, mb.malformed, s.neighbours.iter().flatten().count(),
            )
        }
        (5, 0) => {
            let t = &s.time;
            let st = &t.stats;
            let c = &b.clock.stats;
            let l = &b.stats;
            write!(
                w,
                "[mt] time st={} off={} err={} seq={} tx={} rx={} stamps={} coarse={} stamped={} lost={} hold_max_us={} bracket_max_us={} steps={} slews={} slewed={} founded={} joined={} epochs={} bad={} tsf_mode={} anchors={} wide={} jumps={} hw={} floor={} implausible={} lag={}..{} tsf_off={} drift_ppb={} floor_off={} tb_writes={} tb_busy={} tb_orig={} align={} epoch={}",
                t.state.name(), t.clock.offset_us, t.err_us, t.seq, st.beacons_tx, st.beacons_rx, st.stamps, st.stamps_coarse, l.time_stamped, l.time_lost, l.hold_max_us, l.bracket_max_us, st.steps, st.slews, st.slewed_us, st.founded, st.joined, st.epochs, st.bad,
                m.tsf_mode, c.anchors, c.anchor_wide, c.jumps, c.mapped_hw, c.mapped_floor, c.implausible, c.lag_min_us, c.lag_max_us, c.offset_us, c.drift_ppb, b.clock.offset_us().unwrap_or(0),
                m.tb_writes, m.tb_busy, m.tb_originated, m.tb_align as u8,
                t.epoch.map_or(-1, |e| e.gen as i64),
            )
        }
        (6, i) => {
            let Some(p) = s.time.peers.iter().flatten().nth(i as usize) else { return false };
            let q = p.fit.predict(now);
            write!(
                w,
                "[mt] peer id={:04x} st={} age_ms={} n={} used={} theta={} rms={} drift_ppb={} lat={} off={} samples={} outliers={} resets={} coarse={} unpaired={}",
                p.id,
                p.state.name(),
                (now - p.heard_us) / 1000,
                p.fit.len(),
                q.map_or(0, |q| q.used),
                p.theta(now).map_or(i64::MIN, |t| t.0),
                q.map_or(-1, |q| q.rms),
                q.map_or(0, |q| q.drift_ppb),
                p.lat_us.unwrap_or(i64::MIN),
                p.off_us,
                p.samples,
                p.outliers,
                p.resets,
                p.coarse,
                p.unpaired,
            )
        }
        (4, i) => {
            let Some(r) = m.test_rx.iter().flatten().nth(i as usize) else { return false };
            write!(w, "[mesh] testrx from={:04x} tag={} port={} uniq={} dups={} max_seq={} sent_here={}", r.origin, r.tag, r.port, r.uniq, r.dups, r.max_seq, m.test.sent)
        }
        _ => return false,
    };
    r.is_ok()
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}

// Host tests link the whole crate: stand-ins for the C side.
#[cfg(test)]
mod stubs {
    // Effect sharing (M6): main.cpp's side, absent on the host.
    #[no_mangle]
    extern "C" fn esp_get_free_heap_size() -> u32 {
        100_000
    }
    #[no_mangle]
    extern "C" fn lm_mesh_effect_file(_: *mut u8, _: u32) -> u32 {
        0
    }
    #[no_mangle]
    extern "C" fn lm_mesh_stage(_: *const u8, _: u32, _: u32, _: *mut *const u8) -> i32 {
        0
    }
    #[no_mangle]
    extern "C" fn lm_mesh_staged_take(_: *mut *const u8) -> u32 {
        0
    }
    #[no_mangle]
    extern "C" fn lm_mesh_scene_frames(_: *mut u8, _: u32) -> i32 {
        -1
    }
    #[no_mangle]
    extern "C" fn lm_mesh_deckb_frame(len: *mut u32) -> *const u8 {
        unsafe { *len = 0 };
        core::ptr::null()
    }
    #[no_mangle]
    extern "C" fn lm_fx_check_effect(_: *const u8, _: usize) -> u32 {
        // Every program loads (a_lone_gateway_applies_mesh_control_itself shares one).
        0
    }
    #[no_mangle]
    extern "C" fn lm_prio_below_render() -> u32 {
        0
    }
    #[no_mangle]
    extern "C" fn lm_prio_restore(_: u32) {}
    #[no_mangle]
    extern "C" fn ns_mac_send_p2p(_: *const u8, _: u32, _: u32, _: u32, _: u32, _: u32) -> u32 {
        1
    }
    #[no_mangle]
    extern "C" fn ns_mac_tx_done(_: u32, _: *mut u32) -> u32 {
        1
    }
    #[no_mangle]
    extern "C" fn ns_mac_tx_ftm(_: u32, _: *mut u32) {}
    #[no_mangle]
    extern "C" fn ns_phy_force_tick_phase(_: u32) -> u32 {
        1
    }
    #[no_mangle]
    extern "C" fn heap_caps_aligned_alloc(align: usize, size: usize, _: u32) -> *mut u8 {
        unsafe { std::alloc::alloc_zeroed(std::alloc::Layout::from_size_align(size, align).unwrap()) }
    }
    #[no_mangle]
    extern "C" fn heap_caps_free(_: *mut u8) {} // tests leak it
    #[no_mangle]
    extern "C" fn lm_mesh_tx_idle() -> u32 {
        1
    }
    #[no_mangle]
    extern "C" fn lm_mesh_tx_hold(_: u32) {}
    #[no_mangle]
    extern "C" fn lm_mesh_counter_store(_: u64) -> u32 {
        1
    }
    #[no_mangle]
    extern "C" fn esp_random() -> u32 {
        0x1234_5678
    }
    #[no_mangle]
    extern "C" fn esp_timer_get_time() -> i64 {
        0
    }
    #[no_mangle]
    extern "C" fn lm_mesh_tb(_: i32, _: *mut i64, _: i64) -> i32 {
        0
    }
    // The device key (main.cpp on MbedTLS): a fixed P-256 key on the host's p256.
    fn host_key() -> splanc_mesh::host_keys::HostKey {
        splanc_mesh::host_keys::HostKey::from_seed(0x3170)
    }
    #[no_mangle]
    extern "C" fn lm_mesh_device_key(out: *mut u8) -> u32 {
        use splanc_mesh::crypto::DeviceKey;
        unsafe { core::ptr::copy_nonoverlapping(host_key().public_key().as_ptr(), out, 65) };
        1
    }
    #[no_mangle]
    extern "C" fn lm_mesh_ecdh(peer: *const u8, out: *mut u8) -> u32 {
        use splanc_mesh::crypto::DeviceKey;
        let p = unsafe { *(peer as *const [u8; 65]) };
        match host_key().ecdh(&p) {
            Some(x) => {
                unsafe { core::ptr::copy_nonoverlapping(x.as_ptr(), out, 32) };
                1
            }
            None => 0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Create, provision with the dev key, tick to membership, report, destroy: the FFI
    /// surface the transport drives, on the host.
    #[test]
    fn lifecycle_over_the_ffi() {
        let mut block = vec![0u8; ns_mesh_size() as usize + 3];
        let raw = unsafe { block.as_mut_ptr().add(3) };
        let mac = [0x8c, 0xfd, 0x49, 0x12, 0x31, 0x70];
        let m = unsafe { ns_mesh_create(raw, ns_mesh_size(), mac.as_ptr(), 1, 0, 0) };
        assert!(!m.is_null());
        assert_eq!(m as usize % ALIGN, 0);
        unsafe {
            ns_mesh_dev_provision(m, 0x5350_4C33, [7u8; 32].as_ptr(), 1, 0);
            let mut t = 0;
            while t < 6_000_000 {
                t += 5_000;
                ns_mesh_tick(m, t, 1, 1);
            }
            assert!((*m).stack.membership.is_member());
            assert!((*m).counter_writes >= 1, "the counter mark was persisted before use");
            let mut out = [0u8; 600];
            let n = ns_mesh_report(m, 0, 0, out.as_mut_ptr(), out.len() as u32, t);
            let line = core::str::from_utf8(&out[..n as usize]).unwrap();
            assert!(line.starts_with("[mesh] info id=3170 phase=member"), "{line}");
            assert_eq!(ns_mesh_report(m, 1, 0, out.as_mut_ptr(), out.len() as u32, t), 0, "no neighbours");
            let mut log = [0u8; LOG];
            let n = ns_mesh_take_log(m, log.as_mut_ptr(), LOG as u32) as usize;
            assert!(core::str::from_utf8(&log[..n]).unwrap().contains("[mesh] member id=3170"));
            assert_eq!(ns_mesh_set(m, 0, 0), 1);
            assert_eq!(ns_mesh_set(m, 1, 0x55), 0, "not a rate code");
            assert_eq!(ns_mesh_test(m, 0xFFFF, 16, 1, 1000, 20, 0, 1, t), 0, "CONTROL is admin-class");
            assert_eq!(ns_mesh_test(m, 0xFFFF, 18, 3, 1000, 20, 0, 1, t), 1);
            assert_eq!(ns_mesh_destroy(m), raw);
        }
    }

    /// M7 over the FFI: the app's mesh_admin provisions (persisted), the admin's grant unlocks
    /// the connection, leave needs it, and the stored bytes restore the membership.
    #[test]
    fn mesh_admin_provision_unlock_leave_restore() {
        use splanc_mesh::crypto::DeviceKey;
        use splanc_mesh::host_keys::AdminSigner;
        fn frame(op: u32, body: impl FnOnce(&mut mesh_gw::Pb<'_>)) -> std::vec::Vec<u8> {
            let mut b = [0u8; 400];
            let n = {
                let mut w = mesh_gw::Pb::new(&mut b);
                w.msg(101, |a| a.msg(op, body));
                assert!(w.ok);
                w.n
            };
            b[..n].to_vec()
        }
        let app = |m: *mut Mesh, conn: u32, f: &[u8]| -> std::vec::Vec<u8> {
            let mut out = [0u8; 1024];
            let (mut ip, mut il) = (core::ptr::null(), 0u32);
            let n = unsafe { mesh_gw::ns_mesh_app(m, conn, f.as_ptr(), f.len() as u32, 0, out.as_mut_ptr(), out.len() as u32, &mut ip, &mut il) };
            assert!(n > 0, "a reply");
            out[..n as usize].to_vec()
        };
        // ServerMessage{mesh{admin{op, error}}}: the error byte, 0 if absent (OK).
        let error = |r: &[u8]| -> u8 {
            // Before the provisioner token (field 4, 16 bytes), whose bytes could look like a tag.
            let r = &r[..r.windows(2).position(|w| w == [0x22, 16]).unwrap_or(r.len())];
            r.windows(1).zip(r.iter().skip(1)).find(|(w, _)| w[0] == 0x10).map_or(0, |(_, e)| *e)
        };
        const MESH: u32 = 0x5350_4c37;
        let admin = AdminSigner::from_secret(b"m7-admin-secret!", MESH);
        let mut block = vec![0u8; ns_mesh_size() as usize];
        let mac = [0x8c, 0xfd, 0x49, 0x12, 0x31, 0x70];
        let m = unsafe { ns_mesh_create(block.as_mut_ptr(), ns_mesh_size(), mac.as_ptr(), 1, 0, 0) };
        assert!(!m.is_null());
        let pk = admin.public();
        let prov = frame(mesh_gw::op::PROVISION, |p| {
            p.u(1, MESH.into());
            p.bytes(2, &[0x51; 32]);
            p.bytes(3, &pk);
        });
        assert_eq!(error(&app(m, 1, &prov)), 0);
        unsafe {
            assert_eq!(ns_mesh_get(m, 9), 1, "to persist");
            let mut st = vec![0u8; ns_mesh_state_len() as usize];
            assert_eq!(ns_mesh_persist(m, st.as_mut_ptr(), st.len() as u32), RECORD_LEN as i32);
            assert_eq!(ns_mesh_get(m, 9), 0);
            let mut t = 0;
            while t < 6_000_000 {
                t += 5_000;
                ns_mesh_tick(m, t, 1, 1);
            }
            assert!((*m).stack.membership.is_member());
            assert!(!(*m).stack.envelope_trust(), "an admin key");
            // Leave (or re-provision) needs a grant on a fixture that holds an admin key.
            let leave = frame(mesh_gw::op::LEAVE, |_| {});
            assert_eq!(error(&app(m, 1, &leave)) as u32, mesh_gw::aerr::LOCKED);
            // A grant for this fixture's device key (the TLS key: the host stub's).
            let me = (*m).stack.me();
            let dk = (*m).stack.dev.public_key();
            let g = admin.grant(MESH, 7, me, dk, 3_600);
            let mut gb = [0u8; 200];
            let gn = splanc_mesh::admin::SessionMsg::Grant(g).encode(&mut gb).unwrap();
            let unlock = frame(mesh_gw::op::UNLOCK, |p| p.bytes(1, &gb[..gn]));
            assert_eq!(error(&app(m, 1, &unlock)), 0);
            assert!((*m).stack.signing_session(1));
            // A grant signed by someone else, on another connection: refused, then locked out.
            let rogue = AdminSigner::from_secret(b"not-the-admin!!!", MESH).grant(MESH, 8, me, dk, 3_600);
            let gn2 = splanc_mesh::admin::SessionMsg::Grant(rogue).encode(&mut gb).unwrap();
            let bad = frame(mesh_gw::op::UNLOCK, |p| p.bytes(1, &gb[..gn2]));
            assert_eq!(error(&app(m, 2, &bad)) as u32, mesh_gw::aerr::BAD_GRANT);
            assert_eq!(error(&app(m, 2, &bad)) as u32, mesh_gw::aerr::LOCKED_OUT);
            // get_mesh lists the membership: mode, phase, the device key, the session.
            let state = app(m, 1, &[0xa2, 0x06, 0x00]);
            assert!(state.windows(dk.len()).any(|w| w == dk), "device key in the state");
            // The grant's connection may leave: state erased, the mesh turns off.
            assert_eq!(error(&app(m, 1, &leave)), 0);
            assert_eq!(ns_mesh_get(m, 7), 1, "wants off");
            assert_eq!(ns_mesh_persist(m, st.as_mut_ptr(), st.len() as u32), -1, "erase");
            assert_eq!(ns_mesh_destroy(m), block.as_mut_ptr());
            // The stored bytes bring the membership back in a fresh mesh.
            let mut block2 = vec![0u8; ns_mesh_size() as usize];
            let m2 = ns_mesh_create(block2.as_mut_ptr(), ns_mesh_size(), mac.as_ptr(), 1, 0, 0);
            assert_eq!(ns_mesh_restore(m2, st.as_ptr(), 10, 0), 0, "torn");
            assert_eq!(ns_mesh_restore(m2, st.as_ptr(), st.len() as u32, 0), 1);
            let s = (*m2).stack.membership.state.unwrap();
            assert_eq!((s.mesh_id, s.admin_key, s.site_secret), (MESH, Some(pk), Some([0x51; 32])));
            ns_mesh_destroy(m2);
        }
    }

    /// D-324: the provision answer carries a provisioner token; with it (and only with it)
    /// that user leaves or re-provisions a fixture holding an admin key without a grant, and
    /// the token survives a reboot with the membership.
    #[test]
    fn provisioner_token_leaves_without_a_grant() {
        use splanc_mesh::host_keys::AdminSigner;
        fn frame(op: u32, body: impl FnOnce(&mut mesh_gw::Pb<'_>)) -> std::vec::Vec<u8> {
            let mut b = [0u8; 400];
            let n = {
                let mut w = mesh_gw::Pb::new(&mut b);
                w.msg(101, |a| a.msg(op, body));
                w.n
            };
            b[..n].to_vec()
        }
        let app = |m: *mut Mesh, conn: u32, f: &[u8]| -> std::vec::Vec<u8> {
            let mut out = [0u8; 1024];
            let (mut ip, mut il) = (core::ptr::null(), 0u32);
            let n = unsafe { mesh_gw::ns_mesh_app(m, conn, f.as_ptr(), f.len() as u32, 0, out.as_mut_ptr(), out.len() as u32, &mut ip, &mut il) };
            assert!(n > 0);
            out[..n as usize].to_vec()
        };
        let error = |r: &[u8]| -> u8 {
            // Before the provisioner token (field 4, 16 bytes), whose bytes could look like a tag.
            let r = &r[..r.windows(2).position(|w| w == [0x22, 16]).unwrap_or(r.len())];
            r.windows(1).zip(r.iter().skip(1)).find(|(w, _)| w[0] == 0x10).map_or(0, |(_, e)| *e)
        };
        // MeshAdminResult.provisioner_token (field 4, 16 bytes).
        let token = |r: &[u8]| -> Option<[u8; 16]> { r.windows(18).find(|w| w[0] == 0x22 && w[1] == 16).map(|w| w[2..].try_into().unwrap()) };
        const MESH: u32 = 0x5350_4c38;
        let pk = AdminSigner::from_secret(b"m7-admin-secret!", MESH).public();
        let prov = |tok: Option<[u8; 16]>| {
            frame(mesh_gw::op::PROVISION, |p| {
                p.u(1, MESH.into());
                p.bytes(2, &[0x52; 32]);
                p.bytes(3, &pk);
                if let Some(t) = tok {
                    p.bytes(7, &t);
                }
            })
        };
        let leave = |tok: Option<[u8; 16]>| {
            frame(mesh_gw::op::LEAVE, |p| {
                if let Some(t) = tok {
                    p.bytes(1, &t);
                }
            })
        };
        let mac = [0x8c, 0xfd, 0x49, 0x12, 0x31, 0x70];
        let mut block = vec![0u8; ns_mesh_size() as usize];
        let m = unsafe { ns_mesh_create(block.as_mut_ptr(), ns_mesh_size(), mac.as_ptr(), 1, 0, 0) };
        let r = app(m, 1, &prov(None));
        assert_eq!(error(&r), 0);
        let tok = token(&r).expect("the provision answer carries the provisioner token");
        unsafe {
            let mut st = vec![0u8; ns_mesh_state_len() as usize];
            assert_eq!(ns_mesh_persist(m, st.as_mut_ptr(), st.len() as u32), RECORD_LEN as i32);
            // Another connection without the token: locked (admin key held, no grant).
            assert_eq!(error(&app(m, 2, &leave(None))) as u32, mesh_gw::aerr::LOCKED);
            let mut wrong = tok;
            wrong[0] ^= 1;
            assert_eq!(error(&app(m, 2, &leave(Some(wrong)))) as u32, mesh_gw::aerr::LOCKED);
            assert_eq!(error(&app(m, 2, &prov(Some(wrong)))) as u32, mesh_gw::aerr::LOCKED);
            // After a reboot the token still works (persisted with the membership).
            ns_mesh_destroy(m);
            let mut block2 = vec![0u8; ns_mesh_size() as usize];
            let m2 = ns_mesh_create(block2.as_mut_ptr(), ns_mesh_size(), mac.as_ptr(), 1, 0, 0);
            assert_eq!(ns_mesh_restore(m2, st.as_ptr(), st.len() as u32, 0), 1);
            assert_eq!((*m2).owner_token, Some(tok));
            // Re-provisioning with it keeps it; leaving with it erases membership and token.
            let r = app(m2, 3, &prov(Some(tok)));
            assert_eq!((error(&r), token(&r)), (0, Some(tok)));
            assert_eq!(error(&app(m2, 3, &leave(Some(tok)))), 0);
            assert_eq!(ns_mesh_get(m2, 7), 1, "wants off");
            assert_eq!(ns_mesh_persist(m2, st.as_mut_ptr(), st.len() as u32), -1, "erase");
            assert_eq!((*m2).owner_token, None);
            // A bare state (written before D-324) still restores, without a token.
            let mut block3 = vec![0u8; ns_mesh_size() as usize];
            let m3 = ns_mesh_create(block3.as_mut_ptr(), ns_mesh_size(), mac.as_ptr(), 1, 0, 0);
            let bare = &st[..STATE_LEN];
            assert_eq!(ns_mesh_restore(m3, bare.as_ptr(), bare.len() as u32, 0), 1);
            assert_eq!((*m3).owner_token, None);
            ns_mesh_destroy(m2);
            ns_mesh_destroy(m3);
        }
    }

    /// A gateway alone in its mesh (every other member off, or none has joined the session
    /// yet) still applies whole-mesh control itself. The app wraps an effect switch, the
    /// uniforms and brightness in `mesh_send` once the connection is unlocked; with an empty
    /// session roster the mesh send has nobody to reach, and the gateway used to answer
    /// MESH_SEND_NO_MEMBERS (NO_MESH on 1.17.0) without dispatching the inner here either:
    /// power (never relayed) worked, effects did nothing. Same for an admin's and a
    /// delegate's session (the shared-mesh report).
    #[test]
    fn a_lone_gateway_applies_mesh_control_itself() {
        use splanc_mesh::crypto::DeviceKey;
        use splanc_mesh::gateway::client_arm;
        use splanc_mesh::host_keys::AdminSigner;
        fn admin_frame(op: u32, body: impl FnOnce(&mut mesh_gw::Pb<'_>)) -> std::vec::Vec<u8> {
            let mut b = [0u8; 600];
            let n = {
                let mut w = mesh_gw::Pb::new(&mut b);
                w.msg(101, |a| a.msg(op, body));
                assert!(w.ok);
                w.n
            };
            b[..n].to_vec()
        }
        // ClientMessage{mesh_send{inner, want_reply, lead_ms?}}.
        fn send_frame(inner: &[u8], lead_ms: u32) -> std::vec::Vec<u8> {
            let mut b = [0u8; 1200];
            let n = {
                let mut w = mesh_gw::Pb::new(&mut b);
                w.msg(99, |s| {
                    s.bytes(3, inner);
                    s.u(4, 1);
                    if lead_ms > 0 {
                        s.u(6, lead_ms.into());
                    }
                });
                assert!(w.ok);
                w.n
            };
            b[..n].to_vec()
        }
        fn client(arm: u32, body: impl FnOnce(&mut mesh_gw::Pb<'_>)) -> std::vec::Vec<u8> {
            let mut b = [0u8; 1024];
            let n = {
                let mut w = mesh_gw::Pb::new(&mut b);
                w.msg(arm, body);
                assert!(w.ok);
                w.n
            };
            b[..n].to_vec()
        }
        /// ns_mesh_app: (its return, the reply bytes, the inner it hands back to dispatch).
        fn app(m: *mut Mesh, conn: u32, f: &[u8]) -> (i32, std::vec::Vec<u8>, std::vec::Vec<u8>) {
            let mut out = [0u8; 1024];
            let (mut ip, mut il) = (core::ptr::null(), 0u32);
            let n = unsafe { mesh_gw::ns_mesh_app(m, conn, f.as_ptr(), f.len() as u32, 0, out.as_mut_ptr(), out.len() as u32, &mut ip, &mut il) };
            let inner = if n == -3 { unsafe { core::slice::from_raw_parts(ip, il as usize) }.to_vec() } else { vec![] };
            (n, out[..n.max(0) as usize].to_vec(), inner)
        }
        const MESH: u32 = 0x5350_4c39;
        let owner = AdminSigner::from_secret(b"lone-gw-admin!!!", MESH);
        let delegate = AdminSigner::from_secret(b"lone-gw-delegate", MESH);
        for by_delegate in [false, true] {
            let mut block = vec![0u8; ns_mesh_size() as usize];
            let mac = [0x8c, 0xfd, 0x49, 0x12, 0x31, 0x70];
            let m = unsafe { ns_mesh_create(block.as_mut_ptr(), ns_mesh_size(), mac.as_ptr(), 1, 0, 0) };
            let pk = owner.public();
            let prov = admin_frame(mesh_gw::op::PROVISION, |p| {
                p.u(1, MESH.into());
                p.bytes(2, &[0x53; 32]);
                p.bytes(3, &pk);
            });
            assert!(app(m, 1, &prov).0 > 0);
            unsafe {
                let mut t = 0;
                while t < 6_000_000 {
                    t += 5_000;
                    ns_mesh_tick(m, t, 1, 1);
                }
                assert!((*m).stack.membership.is_member());
                // The report's mesh had rotated keys to epoch 5 (new site secret) while the
                // owner's phone, which made the share link, still held epoch 1. Nothing of
                // that is in a grant or a delegation: the stale delegate still unlocks.
                if let Some(st) = (*m).stack.membership.state.as_mut() {
                    st.epoch = 5;
                    st.site_secret = Some([0x99; 32]);
                }
                let (me, dk) = ((*m).stack.me(), (*m).stack.dev.public_key());
                let mut gb = [0u8; 200];
                let mut db = [0u8; 200];
                let (g, d) = if by_delegate {
                    (delegate.delegated_grant(MESH, 11, me, dk, 3_600), Some(owner.delegation(MESH, delegate.public(), 0)))
                } else {
                    (owner.grant(MESH, 11, me, dk, 3_600), None)
                };
                let gn = splanc_mesh::admin::SessionMsg::Grant(g).encode(&mut gb).unwrap();
                let dn = d.map(|d| d.encode(&mut db).unwrap());
                let unlock = admin_frame(mesh_gw::op::UNLOCK, |p| {
                    p.bytes(1, &gb[..gn]);
                    if let Some(dn) = dn {
                        p.bytes(2, &db[..dn]);
                    }
                });
                let (n, r, _) = app(m, 1, &unlock);
                assert!(n > 0 && !r.windows(2).any(|w| w[0] == 0x10 && w[1] != 0), "unlocked (delegate={by_delegate}): {r:02x?}");
                assert!((*m).stack.signing_session(1));
                assert_eq!((*m).stack.gateway.as_ref().map(|g| g.len()), Some(0), "nobody else in the session");
            }
            // set_effect{effect_id "rain"} and set_brightness (scheduled ahead, as the app does),
            // set_uniforms{values [{slot 1}]}: each one dispatched here.
            use splanc_mesh::gateway::arm;
            let set_effect = client(arm::SET_EFFECT, |e| e.bytes(1, b"rain"));
            let brightness = client(arm::SET_BRIGHTNESS, |b| b.u(3, 1));
            let uniforms = client(arm::SET_UNIFORMS, |u| u.msg(1, |v| v.u(1, 1)));
            for (what, inner, lead) in [("set_effect", &set_effect, 150), ("set_brightness", &brightness, 150), ("set_uniforms", &uniforms, 0)] {
                let (n, r, dispatched) = app(m, 1, &send_frame(inner, lead));
                assert_eq!(n, -3, "{what} (delegate={by_delegate}) is dispatched on the gateway, not refused: {r:02x?}");
                assert_eq!(client_arm(&dispatched).map(|a| a.0), client_arm(inner).map(|a| a.0), "{what}");
                unsafe { mesh_gw::ns_mesh_gw_local_done(m, 0) };
            }
            // An effect program shared with the mesh (M6): loaded here.
            let effect = client(arm::SUBMIT_EFFECT, |e| {
                e.bytes(1, b"rain");
                e.bytes(2, &[0x46u8; 300]);
                e.u(3, 1);
            });
            let (n, r, dispatched) = app(m, 1, &send_frame(&effect, 0));
            assert_eq!(n, -3, "submit_effect (delegate={by_delegate}) is loaded on the gateway, not refused: {r:02x?}");
            assert_eq!(dispatched, effect);
            unsafe {
                mesh_gw::ns_mesh_gw_local_done(m, 0);
                ns_mesh_destroy(m);
            }
        }
    }

    #[test]
    fn test_rx_counts_unique_and_duplicate_seqs() {
        let mut rx = [None; TEST_PEERS];
        assert!(note_test(&mut rx, 7, 1, 18, 0));
        assert!(note_test(&mut rx, 7, 1, 18, 5));
        assert!(!note_test(&mut rx, 7, 1, 18, 5));
        assert!(note_test(&mut rx, 8, 1, 18, 0));
        let a = rx.iter().flatten().find(|r| r.origin == 7).unwrap();
        assert_eq!((a.uniq, a.dups, a.max_seq), (2, 1, 5));
    }

    #[test]
    fn buf_truncates_without_tearing_a_line() {
        let mut b = [0u8; 8];
        let mut w = Buf { b: &mut b, n: 0 };
        assert!(w.write_str("abc").is_ok());
        assert!(w.write_str("defghi").is_err());
        assert_eq!(w.n, 3);
    }
}
