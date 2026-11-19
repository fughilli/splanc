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
//! **Keys** (desk #67): until M7's membership, the only way in is the dev-only site key
//! ([`ns_mesh_dev_provision`]), which the transport exposes on the console only in the
//! `LM_MESH_DEVKEY` image. The M2 envelope is always on: nothing leaves unsealed except
//! membership's plain adverts.
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
use splanc_mesh::membership::{Credentials, Mode, Phase, ProvisionSource};
use splanc_mesh::ports::Port;
use splanc_mesh::meshtime::{ShowEpoch, SyncState};
use splanc_mesh::stack::{Event, MeshStack, StackConfig};
use splanc_mesh::timesync::Adjust;
use splanc_mesh::wifi_p2p::{self, ChannelAction, ChannelRule, GroupPolicy, P2pConfig, Radio, RxVerdict, TxResult, WifiP2p};
use splanc_mesh::NodeId;
use swarm_net::update::Flash;

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
    // netstack_transport.cpp: the shared TX pacing (the STA path's g_tx_busy_until_us).
    fn lm_mesh_tx_idle() -> u32;
    fn lm_mesh_tx_hold(us: u32);
    // main.cpp: the frame counter's high-water mark in littlefs (§7.5).
    fn lm_mesh_counter_store(mark: u64) -> u32;
    fn esp_random() -> u32;
    fn esp_timer_get_time() -> i64;
    // main.cpp: the player's shared time base under its mutex (try-lock: -1 = busy).
    // op 0 = get (1: set, in *epoch_ms; 0: none), 1 = put *epoch_ms and shift the queued
    // apply_at changes by `shift_ms`, 2 = clear, 3 = frame alignment on (*epoch_ms != 0).
    fn lm_mesh_tb(op: i32, epoch_ms: *mut i64, shift_ms: i64) -> i32;
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
}

/// The device key until M7 (firmware `DeviceKey` on MbedTLS): a dev placeholder. Only joins
/// by approval and admin sessions use it; site-secret members never do.
struct DevKey([u8; 6]);
impl DeviceKey for DevKey {
    fn public_key(&self) -> PublicKey {
        let mut k = [0u8; 65];
        k[0] = 0x04;
        k[1..7].copy_from_slice(&self.0);
        k
    }
    fn ecdh(&self, _: &PublicKey) -> Option<[u8; 32]> {
        None
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
/// Returns the mesh, or null. Its frames are large: the transport runs this on a
/// short-lived task with a big stack (not loopTask's 12 KB).
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
    f!((*p).radio).write(Mac { pwr: 0x14 });
    f!((*p).rule).write(ChannelRule::default());
    f!((*p).scratch).write_bytes(0, 1);
    f!((*p).rxv).write_bytes(0, 1);
    f!((*p).block).write(block);
    f!((*p).on_us).write(now_us);
    f!((*p).provisioned_us).write(None);
    f!((*p).member_us).write(None);
    f!((*p).paused_us).write(0);
    f!((*p).pause_since).write(None);
    f!((*p).last_tick_us).write(0);
    f!((*p).tick_max_us).write(0);
    f!((*p).tick_n).write(0);
    f!((*p).test).write(TestJob::default());
    for i in 0..TEST_PEERS {
        f!((*p).test_rx[i]).write(None);
    }
    f!((*p).controls).write(0);
    f!((*p).packets).write(0);
    f!((*p).counter_writes).write(0);
    f!((*p).counter_fail).write(0);
    f!((*p).camp_reported).write(0);
    f!((*p).log).write_bytes(0, 1);
    f!((*p).log_len).write(0);
    f!((*p).aux).write([0; 2]);
    f!((*p).staged).write((0, 0, 0));
    f!((*p).ap_bssid).write([0; 6]);
    f!((*p).ap_last_s).write(0);
    f!((*p).tsf_mode).write(0);
    f!((*p).tb_mine).write(None);
    f!((*p).tb_gen).write(None);
    f!((*p).tb_next_us).write(0);
    f!((*p).tb_writes).write(0);
    f!((*p).tb_busy).write(0);
    f!((*p).tb_originated).write(0);
    f!((*p).tb_align).write(false);
    f!((*p).tstat_next_us).write(0);
    f!((*p).last_state).write(SyncState::Unsynced);
    p
}

/// The stack, built in place at `dst` (`MeshStack::init_in`: no by-value copies of it).
#[inline(never)]
unsafe fn build_stack(dst: *mut Stack, me: NodeId, mac: [u8; 6], channel: u8, counter_mark: u64) -> bool {
    let w = WifiP2p::new(P2pConfig::new(mac), channel);
    let cfg = StackConfig { counter_mark, ..StackConfig::default() };
    MeshStack::init_in(dst, me, mac, w, DevKey(mac), EspRng, cfg).is_ok()
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

/// Read a setting: 5 = the TSF read mode, 6 = mesh time synced (1/0).
#[no_mangle]
pub unsafe extern "C" fn ns_mesh_get(m: *mut Mesh, what: u32) -> u32 {
    let m = &*m;
    match what {
        5 => m.tsf_mode as u32,
        6 => m.stack.time.synced() as u32,
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
    let se = m.stack.originate_epoch(e);
    log_epoch(m, "originated", se);
    1
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
    // The app changed it (or set one before the mesh had an epoch): a new generation.
    let changed = match m.tb_mine {
        Some(mine) => mine != player,
        None => player.is_some() && m.stack.time.epoch.is_none(),
    };
    if changed {
        let e = m.stack.originate_epoch(player.map(|ms| ms * 1000 + off));
        m.tb_originated += 1;
        m.tb_mine = Some(player);
        m.tb_gen = Some((e.gen, e.origin));
        log_epoch(m, "originated", e);
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
    {
        let Mesh { stack, scratch, test_rx, .. } = m;
        stack.tick(now_us, &mut NoFlash, scratch, &mut |e| match e {
            Event::Control { .. } => ctl += 1,
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
            _ => {}
        });
    }
    m.controls += ctl;
    m.packets += pkt;
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
}

/// Settings: `what` 0 = group policy (0 bcast, 1 unicast), 1 = broadcast rate code,
/// 2 = unicast rate code, 3 = tries, 4 = TX power byte, 5 = TSF read mode (0 floor, 1 raw,
/// 2 latched), 6 = time beacon period (ms, 0 off). Returns 1 if applied.
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
        _ => return 0,
    }
    1
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
    #[no_mangle]
    extern "C" fn ns_mac_send_p2p(_: *const u8, _: u32, _: u32, _: u32, _: u32, _: u32) -> u32 {
        1
    }
    #[no_mangle]
    extern "C" fn ns_mac_tx_done(_: u32, _: *mut u32) -> u32 {
        1
    }
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
