//! C ABI over the Rust player stack, for the Arduino (C++) player app.
//!
//! One player, one arena, one connection at a time — everything lives in
//! `static`s (the C6 app is single-threaded; Arduino `loop()` is the only
//! caller). The transport hands every received protocol frame to
//! [`lm_player_handle`], which routes exactly like the host tests do:
//! upload arms (submit_map / submit_topology) go through the arena decoder
//! (`ledmapper_store`) so the generated envelope never needs upload-sized
//! capacity; everything else decodes through the firmware-profile bindings
//! (`ledmapper_pb_fw`) into the session core (`ledmapper_player`), with
//! `ignore_repeated_cap_err` so oversized Pi-profile telemetry truncates
//! instead of erroring.
//!
//! The render-side accessors (`lm_pattern_*`, `lm_counting_color`) are what
//! the FastLED frame loop polls; they are pure reads.

#![no_std]

use core::convert::Infallible;
use core::ffi::c_void;
use core::ptr::{addr_of, addr_of_mut};

use core::sync::atomic::AtomicBool;

use ledmapper_arena::Arena;
use ledmapper_fx_vm::{
    Budget, Counters as FxCounters, Frame as FxFrame, Led as FxLed, Outcome, Program, Vm as FxVm,
};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::{upload_malformed, upload_too_large, Player};
use ledmapper_pulse::{Graph, Sim, MAX_SEGMENTS};
use ledmapper_store::{
    decode_submit_map, decode_submit_topology, dump, envelope_arm, parse_upload_chunk, BlockReader,
    StoreError, StoredMap, StoredTopology, ARM_GET_STORED_MAP, ARM_SUBMIT_MAP, ARM_SUBMIT_TOPOLOGY,
};
use micropb::{MessageDecode, MessageEncode, PbDecoder, PbEncoder, PbRead};

/// Storage for the decoded map + topology (Phase 3 arena). Reset wholesale per
/// upload, so it only holds ONE map+topology at a time. Sized to the firmware's
/// 256-LED cap (~16 B/LED → ~4 KB map; with topology + bump-arena grow-churn the
/// worst case is ~16 KB). Trimmed 96 KiB → 32 KiB → **16 KiB**: on the C6 the
/// TLS handshake needs a ~17 KB contiguous heap block for its record buffer and
/// the cert-page load was OOMing (alloc(17058) failed → -0x7F00) even after the
/// soft-AP drop, so every KB of .bss reclaimed here is handshake headroom. 16 KB
/// matches the worst-case decode with no spare margin — a full 256-LED upload
/// that churns past it gets the bounded ArenaFull ("map_too_large"), not a
/// crash; today's maps are ~150 LEDs and fit comfortably.
const ARENA_BYTES: usize = 16 * 1024;

/// Reply frames are control traffic (firmware caps): welcome is the
/// largest at a few hundred bytes.
const REPLY_CAP: usize = 2048;

static mut ARENA_MEM: [u8; ARENA_BYTES] = [0; ARENA_BYTES];
static mut ARENA: Option<Arena<'static>> = None;
static mut MAP: Option<StoredMap<'static>> = None;
static mut TOPO: Option<StoredTopology<'static>> = None;
static mut PLAYER: Option<Player> = None;

/// The topology-aware effect simulator, rebuilt lazily from TOPO + the active
/// effect config. `SIM_GEN` records the `playback_gen` it was built for so a
/// config change forces a rebuild; a topology upload nulls SIM directly.
static mut SIM: Option<Sim> = None;
static mut SIM_GEN: u32 = u32::MAX;

// -- effects VM (fx_vm) -------------------------------------------------------
// The active `.fxb` lives in a fixed static buffer the C++ side copies the
// upload into (lm_fx_load); the parsed Program borrows it fresh each call
// (a cheap header parse, like the wasm preview) so nothing is self-referential.
// The Vm holds the persistent uniforms + state across frames. Bounded execution
// (docs/design/effects-runtime.md) guards every invocation: a per-call
// instruction budget (primary) and a wall-time deadline flag a hardware timer
// raises (secondary).

/// Max `.fxb` the player will hold. A compiled effect is small (bytecode +
/// manifest) — a rich shader is well under 2 KiB. Keep this tight: it is static
/// RAM out of the heap pool the TLS record buffers need (mbedtls_ssl_setup
/// fails with -0x7F00 when the heap can't spare ~28 KiB for a session).
/// submit_effect rejects a larger upload with `effect_too_large`.
const FX_MAX_BYTES: usize = 4 * 1024;

static mut FX_BYTES: [u8; FX_MAX_BYTES] = [0; FX_MAX_BYTES];
static mut FX_LEN: usize = 0;
static mut FX_VM: Option<FxVm> = None;
/// Hidden-buffer/texture arena for the fx VM (LoadBuf/StoreBuf). 24 KB, now
/// BYTE-addressed (FUG-10 packed storage) so narrow elements pack tightly — a
/// fixed8 vec4 trail on 256 LEDs is 1 KB, an f32 one 4 KB; the VM clamps a
/// program that would need more. Static, so its pointer is stable for the
/// process; bound once per effect load. Persists across frames (buffer
/// semantics) and is zeroed on (re)load for a clean start.
const FX_ARENA_BYTES: usize = 24 * 1024; // 24 KB
static mut FX_ARENA: [u8; FX_ARENA_BYTES] = [0; FX_ARENA_BYTES];

/// Previous quantized video-texture frame, for set_texture DELTA (XOR) decoding.
/// One buffer — video streams target a single texture at a time. A frame whose
/// quantized byte size exceeds this is dropped (keep the transport small).
const FX_TEX_PREV_MAX: usize = 8 * 1024;
static mut FX_TEX_PREV: [u8; FX_TEX_PREV_MAX] = [0; FX_TEX_PREV_MAX];
/// Whether the loaded effect is the ACTIVE one the render loop drives. An
/// upload with `activate=false` parks the effect (loaded, validated) without
/// taking over rendering; set_effect can activate it, or clear it.
static mut FX_ACTIVE: bool = false;
/// Wall-time cancel flag, raised by the C++ hardware-timer callback at a
/// frame-relative deadline; the VM loop polls it and unwinds to a timeout.
static FX_DEADLINE: AtomicBool = AtomicBool::new(false);
/// Per-invocation instruction budget for one update()/shade(). Tunable from
/// C++ (lm_fx_set_budget); defaults to the VM's default.
static mut FX_BUDGET: u32 = ledmapper_fx_vm::DEFAULT_BUDGET;

// Frame context captured by lm_fx_update and reused by lm_fx_shade, so shade()
// sees the SAME time/dt/frame as update(). Shaders commonly animate by reading
// `time` directly in shade() (e.g. `fract(led.s - time*speed)`); without this
// shade() got a zero Frame and every frame looked identical (a "frozen" effect).
static mut FX_F_TIME: f32 = 0.0;
static mut FX_F_DT: f32 = 0.0;
static mut FX_F_FRAME: u32 = 0;
static mut FX_F_LEDS: u32 = 0;
/// Last update() bounded-exec outcome (0=Ok, 1=Budget, 2=Timeout) — surfaced to
/// C++ for the rate-limited `[fx]` diagnostic log.
static mut FX_LAST_UPDATE_OUTCOME: u32 = 0;

// -- per-LED topology for shade() (led.seg / led.s / led.branch) --------------
// The stored topology maps each LED (StoredAssociation) to a segment + arclength
// + perpendicular offset. shade() exposes that to scripts as `led.seg` (segment
// INDEX, -1 when the LED has no association), `led.s` (normalized 0..1 arclength
// along its segment, from endpoint a) and `led.branch` (true within
// BRANCH_DIST_M of a real junction — a branch point where >=3 segments meet).
//
// We derive it ONCE per topology change into a cache in map-index order, so the
// per-LED shade() sweep is a cheap array read rather than an O(associations)
// scan every call. lm_map_led hands the render loop the map index, which is
// exactly this cache's index.

/// Cache capacity: the firmware's LED cap (main.cpp kMaxLeds). One entry/LED.
const FX_TOPO_CAP: usize = 256;
/// An LED is "at a junction" (`led.branch`) within this arclength (meters) of a
/// segment endpoint that is a real branch point (degree >= 3).
const FX_BRANCH_DIST_M: f32 = 0.05;

/// One LED's derived topology terms. `seg` is the segment INDEX (position in
/// topo.segments), -1 = no association; `s` is normalized 0..1; `branch` = near
/// a junction; `dist` is the geodesic distance from the topology root, 0..1
/// (accumulates across segments — flood/pulse ride it). 12 bytes/entry → 3 KiB
/// for the whole cache.
#[derive(Clone, Copy)]
struct FxLedTopo {
    seg: i16,
    s: f32,
    branch: bool,
    dist: f32,
}
impl FxLedTopo {
    const NONE: FxLedTopo = FxLedTopo { seg: -1, s: 0.0, branch: false, dist: 0.0 };
}

static mut FX_LED_TOPO: [FxLedTopo; FX_TOPO_CAP] = [FxLedTopo::NONE; FX_TOPO_CAP];

/// Map XY bounding box for `led.uv` (a top-down projection of the map to 0..1):
/// `uv = (pos.xy - FX_UV_MIN) * FX_UV_INV`, clamped. Recomputed by
/// fx_rebuild_topo when the map changes; inv = 0 for a degenerate axis (uv 0).
static mut FX_UV_MIN: [f32; 2] = [0.0, 0.0];
static mut FX_UV_INV: [f32; 2] = [0.0, 0.0];
/// False when the cache is stale (a map/topology upload cleared it); rebuilt
/// lazily at the top of the next lm_fx_update frame.
static mut FX_TOPO_READY: bool = false;

// -- perf monitoring (docs/design/perf-monitoring.md) -------------------------
// A small perf ring the render task fills (one PerfFrame per rendered effect
// frame, Tier-0 cycle spans + Tier-1 opcode counts when FULL) and the phone
// drains via get_perf_report — mirroring the FrameLog/get_frame_timing pattern
// one level up. Everything is `static` and single-threaded like the rest of
// this file (render task + message handler take turns under player_mutex).
// Integer-only throughout — no float on the perf path.

/// Perf instrumentation tier. Matches `SetPerf.Mode` on the wire (OFF/BASIC/
/// FULL). BASIC = Tier 0 (cycle spans + heap + counters, always cheap). FULL =
/// Tier 0 + Tier 1 (per-opcode instruction counts + stack high-water); gated so
/// BASIC never pays the counted VM path.
const PERF_OFF: u32 = 0;
/// BASIC (Tier 0) is the wire value 1; the firmware only branches on OFF vs
/// FULL (Tier-1 gating), so BASIC needs no direct reference beyond documenting
/// the enum. Kept for parity with `SetPerf.Mode`.
#[allow(dead_code)]
const PERF_BASIC: u32 = 1;
const PERF_FULL: u32 = 2;

/// Perf ring capacity (recent PerfFrames). 16 frames ≈ 0.5 s at 30 fps — enough
/// for the live graph between polls while keeping the static cost (and the
/// stack window buffer that mirrors it) small; heap headroom matters more here
/// (see FX_MAX_BYTES). On overflow the oldest is dropped (samples_dropped),
/// exactly like FrameLog: a phone that polled too slowly learns its history
/// has gaps rather than reading smoothed data.
const PERF_RING_CAP: usize = 16;

/// Current perf mode (PERF_OFF/BASIC/FULL) and unsolicited-push interval (ms,
/// 0 = poll-only). Read by the render task to gate Tier-1 and by main.cpp to
/// pace the push.
static mut PERF_MODE: u32 = PERF_OFF;
static mut PERF_INTERVAL_MS: u32 = 0;

/// Last invocation's Tier-1 counters, latched by lm_fx_update / lm_fx_shade
/// when FULL is active (else left zero). shade counts accumulate across the
/// per-LED sweep; update is a single call. Read into the pushed PerfFrame.
static mut FX_INSTR_UPDATE: u32 = 0;
static mut FX_INSTR_SHADE: u32 = 0;
static mut FX_STACK_MAX: u16 = 0;

/// The effect identity a PerfReport is pinned to (perf-monitoring.md: the
/// panel/AI must know metrics belong to the running compiled script). A hash of
/// the loaded `.fxb`, recomputed on load; effect_id echoes the last submit.
static mut FX_HASH: u32 = 0;
static mut FX_ID: [u8; 64] = [0; 64];
static mut FX_ID_LEN: usize = 0;

/// One rendered effect frame's Tier-0/Tier-1 sample, in native firmware units
/// (CPU cycles, counts, bytes) — the ring element and the PerfReport tick.
#[derive(Clone, Copy, Default)]
struct PerfSample {
    seq: u32,
    update_cycles: u32,
    shade_cycles: u32,
    frame_cycles: u32,
    show_cycles: u32,
    led_count: u32,
    instr_update: u32,
    instr_shade: u32,
    stack_max: u32,
}

/// Ring of recent PerfSamples with the same overflow discipline as FrameLog:
/// the render task pushes; get_perf_report drains oldest-first. `overruns` and
/// `dropped_frames` are since-last-drain counters (the report resets them);
/// `samples_dropped` counts ring overflow (phone polled too slowly).
struct PerfRing {
    buf: [PerfSample; PERF_RING_CAP],
    head: usize,
    len: usize,
    /// Frames whose (frame + show) cycles exceeded the ~33 ms budget.
    overruns: u32,
    /// Frames the render task skipped (fell behind schedule).
    dropped_frames: u32,
    /// Ring-overflow drops (phone drained too slowly).
    samples_dropped: u32,
}

impl PerfRing {
    const fn new() -> Self {
        PerfRing {
            buf: [PerfSample {
                seq: 0,
                update_cycles: 0,
                shade_cycles: 0,
                frame_cycles: 0,
                show_cycles: 0,
                led_count: 0,
                instr_update: 0,
                instr_shade: 0,
                stack_max: 0,
            }; PERF_RING_CAP],
            head: 0,
            len: 0,
            overruns: 0,
            dropped_frames: 0,
            samples_dropped: 0,
        }
    }

    fn push(&mut self, s: PerfSample) {
        let tail = (self.head + self.len) % PERF_RING_CAP;
        self.buf[tail] = s;
        if self.len == PERF_RING_CAP {
            self.head = (self.head + 1) % PERF_RING_CAP; // overwrite oldest
            self.samples_dropped = self.samples_dropped.saturating_add(1);
        } else {
            self.len += 1;
        }
    }

    fn pop(&mut self) -> Option<PerfSample> {
        if self.len == 0 {
            return None;
        }
        let s = self.buf[self.head];
        self.head = (self.head + 1) % PERF_RING_CAP;
        self.len -= 1;
        Some(s)
    }

    /// Peek the i-th oldest buffered sample (for the rolling-window rollup,
    /// which summarizes without draining).
    fn get(&self, i: usize) -> Option<&PerfSample> {
        if i >= self.len {
            return None;
        }
        Some(&self.buf[(self.head + i) % PERF_RING_CAP])
    }
}

static mut PERF_RING: PerfRing = PerfRing::new();

/// Rolling-window summary computed on-device (integer min/mean/max over the
/// buffered samples), so a single poll shows a stable headroom number and the
/// AI gets a denoised value. Host-testable (pure) — see perf_rollup below.
#[derive(Clone, Copy, Default)]
struct PerfWindow {
    frame_min: u32,
    frame_mean: u32,
    frame_max: u32,
    update_mean: u32,
    shade_mean: u32,
    show_mean: u32,
}

/// Summarize a slice of samples into min/mean/max over frame_cycles plus the
/// per-phase means (integer division; empty → all zero). Pulled out as a free
/// function so it is exercised off-device by the host test.
fn perf_rollup(samples: &[PerfSample]) -> PerfWindow {
    if samples.is_empty() {
        return PerfWindow::default();
    }
    let mut w = PerfWindow {
        frame_min: u32::MAX,
        ..Default::default()
    };
    // u64 accumulators so a full window of large cycle counts can't overflow.
    let mut frame_sum: u64 = 0;
    let mut update_sum: u64 = 0;
    let mut shade_sum: u64 = 0;
    let mut show_sum: u64 = 0;
    for s in samples {
        if s.frame_cycles < w.frame_min {
            w.frame_min = s.frame_cycles;
        }
        if s.frame_cycles > w.frame_max {
            w.frame_max = s.frame_cycles;
        }
        frame_sum += s.frame_cycles as u64;
        update_sum += s.update_cycles as u64;
        shade_sum += s.shade_cycles as u64;
        show_sum += s.show_cycles as u64;
    }
    let n = samples.len() as u64;
    w.frame_mean = (frame_sum / n) as u32;
    w.update_mean = (update_sum / n) as u32;
    w.shade_mean = (shade_sum / n) as u32;
    w.show_mean = (show_sum / n) as u32;
    w
}

/// Cheap 32-bit FNV-1a of the loaded `.fxb`, so a PerfReport pins metrics to the
/// exact compiled script (perf-monitoring.md: a hot-reload can't mis-attribute
/// a frame). Truncated hash is enough — the app only needs equality.
fn fxb_hash(bytes: &[u8]) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for &b in bytes {
        h ^= b as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

// The staticlib is linked into the Arduino app, which has no Rust runtime:
// provide the panic handler on the bare-metal target. Host tests (std)
// bring their own.
#[cfg(all(not(test), target_os = "none"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // The player contract is bounded errors, never panics; reaching this is
    // a firmware bug. Halt where a debugger can see it.
    loop {}
}

unsafe fn player() -> &'static mut Player {
    (*addr_of_mut!(PLAYER)).as_mut().expect("lm_player_init first")
}

unsafe fn arena_ref() -> &'static Arena<'static> {
    (*addr_of!(ARENA)).as_ref().expect("lm_player_init first")
}

unsafe fn arena_mut() -> &'static mut Arena<'static> {
    (*addr_of_mut!(ARENA)).as_mut().expect("lm_player_init first")
}

/// Initialize (or re-initialize) the player state. `default_led_count` is
/// the code-book fallback until set_led_count / start_mapping override it.
#[no_mangle]
pub extern "C" fn lm_player_init(default_led_count: u32) {
    unsafe {
        *addr_of_mut!(MAP) = None;
        *addr_of_mut!(TOPO) = None;
        *addr_of_mut!(SIM) = None;
        *addr_of_mut!(ARENA) = Some(Arena::new(&mut *addr_of_mut!(ARENA_MEM)));
        *addr_of_mut!(PLAYER) = Some(Player::new("esp32c6-player", default_led_count.max(1)));
    }
}

/// Set the player's hardware identity (MAC + current display name) echoed in
/// every `welcome`. Call once after [`lm_player_init`], from the firmware that
/// owns the factory-MAC read and the persisted name.
///
/// # Safety
/// `mac`/`name` point to `mac_len`/`name_len` readable UTF-8 bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_player_set_identity(
    mac: *const u8,
    mac_len: usize,
    name: *const u8,
    name_len: usize,
) {
    let mac_s = if mac.is_null() {
        ""
    } else {
        core::str::from_utf8(core::slice::from_raw_parts(mac, mac_len)).unwrap_or("")
    };
    let name_s = if name.is_null() {
        ""
    } else {
        core::str::from_utf8(core::slice::from_raw_parts(name, name_len)).unwrap_or("")
    };
    player().set_identity(mac_s, name_s);
}

/// Copy the player's CURRENT display name into `out` (cap bytes); returns the
/// length written, or -2 when it doesn't fit. The firmware polls this after each
/// `lm_player_handle` so a `set_device_name` can be persisted + reflected to the
/// BLE advertisement.
///
/// # Safety
/// `out` must point to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_device_name(out: *mut u8, cap: usize) -> i32 {
    let name = player().device_name().as_bytes();
    if name.len() > cap {
        return -2;
    }
    if !out.is_null() && !name.is_empty() {
        core::ptr::copy_nonoverlapping(name.as_ptr(), out, name.len());
    }
    name.len() as i32
}

fn encode_reply(reply: &pb::ServerMessage, out: *mut u8, out_cap: usize) -> i32 {
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, REPLY_CAP>::new());
    if reply.encode(&mut enc).is_err() {
        return -2; // reply exceeds REPLY_CAP — a firmware bug, not remote input
    }
    let bytes = enc.into_writer();
    if bytes.len() > out_cap {
        return -2;
    }
    unsafe { core::ptr::copy_nonoverlapping(bytes.as_ptr(), out, bytes.len()) };
    bytes.len() as i32
}

/// Handle one received protocol frame; writes the reply frame (if any) to
/// `out`. Returns the reply length, 0 for fire-and-forget arms (no reply),
/// -1 for bad arguments, -2 if `out_cap` is too small.
///
/// # Safety
/// `data` must point to `len` readable bytes; `out` to `out_cap` writable.
#[no_mangle]
pub unsafe extern "C" fn lm_player_handle(
    data: *const u8,
    len: usize,
    recv_ms: i64,
    send_ms: i64,
    out: *mut u8,
    out_cap: usize,
) -> i32 {
    if data.is_null() || out.is_null() || len == 0 {
        return -1;
    }
    let frame = core::slice::from_raw_parts(data, len);
    let reply = match envelope_arm(frame) {
        Some(ARM_SUBMIT_MAP) => handle_map_upload(frame, frame.len()),
        Some(ARM_SUBMIT_TOPOLOGY) => handle_topology_upload(frame, frame.len()),
        // Dump the stored map+topology (it lives in the arena, not the session
        // core) back out to the phone, one MappingBundle byte-window per call.
        Some(ARM_GET_STORED_MAP) => handle_get_stored_map(frame),
        // Effects arms: decoded by a hand-rolled walker (the firmware profile
        // caps SubmitEffect.fxb at 64 B), then loaded/selected/tuned on the VM.
        Some(ARM_SUBMIT_EFFECT) => handle_submit_effect(frame),
        Some(ARM_SET_EFFECT) => handle_set_effect(frame),
        Some(ARM_SET_UNIFORMS) => handle_set_uniforms(frame),
        Some(ARM_GET_EFFECT_UNIFORMS) => handle_get_effect_uniforms(frame),
        // Perf-monitoring arms: configure the instrumentation tier / push
        // cadence, or drain the ring into a rolled-up PerfReport.
        Some(ARM_SET_PERF) => handle_set_perf(frame),
        Some(ARM_GET_PERF_REPORT) => handle_get_perf_report(),
        // Video-texture frame: decode into the active effect's texture arena.
        // Fire-and-forget (no reply) so high frame rates aren't gated on a round
        // trip — a malformed/oversized frame is silently dropped.
        Some(ARM_SET_TEXTURE) => {
            handle_set_texture(frame);
            return 0;
        }
        _ => {
            let mut env = pb::ClientMessage::default();
            let mut dec = PbDecoder::new(frame);
            // Oversized repeated fields (Pi-profile telemetry) truncate;
            // the arms that matter carry firmware-sized data.
            dec.ignore_repeated_cap_err = true;
            match env.decode(&mut dec, frame.len()) {
                Ok(()) => match player().handle(env, recv_ms, send_ms) {
                    Some(reply) => reply,
                    None => return 0,
                },
                Err(_) => upload_malformed(),
            }
        }
    };
    encode_reply(&reply, out, out_cap)
}

/// A map upload replaces the stored map AND its topology (a topology is
/// meaningless against a different solve), so the arena resets wholesale.
unsafe fn handle_map_upload<R: PbRead<Error = Infallible>>(
    reader: R,
    total: usize,
) -> pb::ServerMessage {
    *addr_of_mut!(MAP) = None;
    *addr_of_mut!(TOPO) = None;
    *addr_of_mut!(SIM) = None;
    FX_TOPO_READY = false; // map replaced → per-LED topology cache is stale
    arena_mut().reset();
    match decode_submit_map(reader, total, arena_ref()) {
        Ok(map) => {
            let reply = player().map_stored(map.map_id.as_str());
            *addr_of_mut!(MAP) = Some(map);
            reply
        }
        Err(e) => {
            arena_mut().reset();
            upload_error(e)
        }
    }
}

/// Topology appends after the map; a failed decode rolls back to the map.
unsafe fn handle_topology_upload<R: PbRead<Error = Infallible>>(
    reader: R,
    total: usize,
) -> pb::ServerMessage {
    *addr_of_mut!(TOPO) = None;
    *addr_of_mut!(SIM) = None;
    FX_TOPO_READY = false; // topology replaced → per-LED topology cache is stale
    let cp = arena_ref().checkpoint();
    match decode_submit_topology(reader, total, arena_ref()) {
        Ok(topo) => {
            let reply = player().topology_stored(topo.map_id.as_str());
            if matches!(
                reply.r#msg,
                Some(pb::ServerMessage_::Msg::ResultReady(_))
            ) {
                *addr_of_mut!(TOPO) = Some(topo);
            } else {
                drop(topo);
                arena_mut().reset_to(cp);
            }
            reply
        }
        Err(e) => {
            arena_mut().reset_to(cp);
            upload_error(e)
        }
    }
}

fn upload_error(e: StoreError) -> pb::ServerMessage {
    match e {
        StoreError::ArenaFull => upload_too_large(),
        _ => upload_malformed(),
    }
}

/// Stream a byte window of the stored map+topology re-encoded as a
/// MappingBundle. The phone requests [offset, offset+max_len) repeatedly until
/// it has `total_len` bytes. `no_map` when nothing is stored.
unsafe fn handle_get_stored_map(frame: &[u8]) -> pb::ServerMessage {
    let mut env = pb::ClientMessage::default();
    let mut dec = PbDecoder::new(frame);
    dec.ignore_repeated_cap_err = true;
    let (offset, max_len) = match env.decode(&mut dec, frame.len()) {
        Ok(()) => match env.r#msg {
            Some(pb::ClientMessage_::Msg::GetStoredMap(g)) => {
                (g.r#offset.max(0) as usize, g.r#max_len.max(1) as usize)
            }
            _ => return upload_malformed(),
        },
        Err(_) => return upload_malformed(),
    };
    let Some(map) = (*addr_of!(MAP)).as_ref() else {
        return dump_error("no_map", "no stored map to dump");
    };
    let topo = (*addr_of!(TOPO)).as_ref();
    let total = dump::bundle_len(map, topo);
    // Bound the chunk by the reply field capacity (StoredMapChunk.data).
    let cap = max_len.min(1024);
    let mut chunk = [0u8; 1024];
    let n = if offset < total {
        dump::encode_bundle_window(map, topo, offset, &mut chunk[..cap])
    } else {
        0
    };
    let mut m = pb::StoredMapChunk::default();
    m.r#total_len = total as i32;
    m.r#offset = offset as i32;
    let _ = m.r#data.extend_from_slice(&chunk[..n]);
    m.r#has_topology = topo.is_some();
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::StoredMapChunk(m)) }
}

fn dump_error(code: &str, message: &str) -> pb::ServerMessage {
    let mut e = pb::Error::default();
    let _ = e.r#code.push_str(code);
    let _ = e.r#message.push_str(message);
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::Error(e)) }
}

/// The oneof arm (first-tag field number) of a protocol envelope, or -1 if it
/// can't be read. Lets the C app classify a frame without a full protobuf
/// decode — e.g. a request as submit_map (13) / submit_topology (16) and a
/// reply as result_ready (8) — so it can persist only successful uploads.
///
/// # Safety
/// `data` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_envelope_arm(data: *const u8, len: usize) -> i32 {
    if data.is_null() || len == 0 {
        return -1;
    }
    let s = core::slice::from_raw_parts(data, len);
    envelope_arm(s).map(|a| a as i32).unwrap_or(-1)
}

/// Header fields of one sharded-upload window, filled by [`lm_parse_upload_chunk`].
/// `payload_off`/`payload_len` locate the window's bytes WITHIN the frame the
/// caller passed, so the transport copies `data[payload_off .. +payload_len]`
/// into its reassembly buffer without this layer owning any storage.
#[repr(C)]
pub struct LmUploadChunk {
    pub upload_id: u32,
    pub seq: u32,
    pub payload_off: u32,
    pub payload_len: u32,
    pub kind: u32, // 0 = MAP (submit_map), 1 = TOPOLOGY (submit_topology)
    pub last: u8,
}

/// Parse a `ClientMessage{upload_chunk}` frame into `out` without decoding the
/// (bytes-capped) generated bindings. Returns: 1 = parsed an upload_chunk (out
/// filled); 0 = a well-formed frame that is NOT an upload_chunk (handle it as an
/// ordinary message); -1 = bad args; -2 = malformed frame.
///
/// # Safety
/// `data` must point to `len` readable bytes; `out` must be a valid pointer.
#[no_mangle]
pub unsafe extern "C" fn lm_parse_upload_chunk(
    data: *const u8,
    len: usize,
    out: *mut LmUploadChunk,
) -> i32 {
    if data.is_null() || out.is_null() || len == 0 {
        return -1;
    }
    let frame = core::slice::from_raw_parts(data, len);
    match parse_upload_chunk(frame) {
        Ok(Some(v)) => {
            // payload is a sub-slice of `frame`; recover its offset by address.
            let off = (v.payload.as_ptr() as usize).wrapping_sub(frame.as_ptr() as usize);
            *out = LmUploadChunk {
                upload_id: v.upload_id,
                seq: v.seq,
                payload_off: off as u32,
                payload_len: v.payload.len() as u32,
                kind: v.kind,
                last: v.last as u8,
            };
            1
        }
        Ok(None) => 0,
        Err(_) => -2,
    }
}

/// Encode a `ServerMessage{chunk_ack{upload_id, seq}}` reply into `out`. Returns
/// the encoded length, or -2 if it doesn't fit (a firmware bug — ChunkAck is two
/// varints). The transport sends this after each non-final window so the browser
/// flushes one small TLS record per send.
///
/// # Safety
/// `out` must point to `out_cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_encode_chunk_ack(
    upload_id: u32,
    seq: u32,
    out: *mut u8,
    out_cap: usize,
) -> i32 {
    if out.is_null() {
        return -1;
    }
    let mut m = pb::ChunkAck::default();
    m.r#upload_id = upload_id;
    m.r#seq = seq;
    let reply = pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::ChunkAck(m)) };
    encode_reply(&reply, out, out_cap)
}

/// Refill callback for [`lm_decode_upload_stream`]: fill up to `cap` bytes at
/// `buf` from the caller's source (a LittleFS read), returning the count, or 0
/// at EOF. Never called again after it returns 0.
pub type LmRefill = extern "C" fn(ctx: *mut c_void, buf: *mut u8, cap: usize) -> usize;

/// Decode a reassembled upload frame that the caller streams in block-by-block
/// via `refill` — so a whole ~15 KB submit_map is never resident (the C6 keeps
/// it on flash, not in a big static buffer). `arm` selects the decoder
/// (ARM_SUBMIT_MAP / ARM_SUBMIT_TOPOLOGY); `total_len` is the frame's exact byte
/// length. Populates MAP/TOPO exactly like the in-RAM path and returns the
/// encoded reply (result_ready / error) in `out`.
///
/// # Safety
/// `refill` must write ≤ `cap` bytes; `out` must point to `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_decode_upload_stream(
    arm: i32,
    refill: LmRefill,
    ctx: *mut c_void,
    total_len: usize,
    out: *mut u8,
    out_cap: usize,
) -> i32 {
    if out.is_null() {
        return -1;
    }
    let mut block = [0u8; 512];
    let reader = BlockReader::new(&mut block, |b: &mut [u8]| {
        refill(ctx, b.as_mut_ptr(), b.len())
    });
    let reply = match arm as u32 {
        ARM_SUBMIT_MAP => handle_map_upload(reader, total_len),
        ARM_SUBMIT_TOPOLOGY => handle_topology_upload(reader, total_len),
        _ => upload_malformed(),
    };
    encode_reply(&reply, out, out_cap)
}

// -- effects protocol dispatch (submit_effect / set_effect / set_uniforms /
//    get_effect_uniforms) -----------------------------------------------------
//
// These are decoded by a tiny hand-rolled protobuf walker rather than the
// generated envelope, exactly like the arena upload arms: the firmware profile
// caps `SubmitEffect.fxb` at 64 B and `SetUniforms.values` at a handful, far
// too small for a real effect, so the generated decode can't be used. Walking
// the raw frame lets a full `.fxb` (up to FX_MAX_BYTES) and any number of
// uniform slots ride the same fixed statics the VM already owns.

/// ClientMessage oneof field numbers for the effect arms.
const ARM_SUBMIT_EFFECT: u32 = 21;
const ARM_SET_EFFECT: u32 = 22;
const ARM_SET_UNIFORMS: u32 = 23;
const ARM_GET_EFFECT_UNIFORMS: u32 = 24;
const ARM_SET_PERF: u32 = 25;
const ARM_GET_PERF_REPORT: u32 = 26;
const ARM_SET_TEXTURE: u32 = 28;

/// Read a base-128 varint at `buf[*o..]`, advancing `*o`. None on truncation.
fn rd_varint(buf: &[u8], o: &mut usize) -> Option<u64> {
    let mut val: u64 = 0;
    let mut shift = 0u32;
    while *o < buf.len() {
        let b = buf[*o];
        *o += 1;
        val |= u64::from(b & 0x7f) << shift;
        if b & 0x80 == 0 {
            return Some(val);
        }
        shift += 7;
        if shift >= 64 {
            return None;
        }
    }
    None
}

/// Skip a field of the given wire type at `buf[*o..]`. False on truncation.
fn skip_field(buf: &[u8], o: &mut usize, wire: u8) -> bool {
    match wire {
        0 => rd_varint(buf, o).is_some(),
        1 => {
            *o += 8;
            *o <= buf.len()
        }
        5 => {
            *o += 4;
            *o <= buf.len()
        }
        2 => match rd_varint(buf, o) {
            Some(len) => {
                *o += len as usize;
                *o <= buf.len()
            }
            None => false,
        },
        _ => false,
    }
}

/// Unwrap `ClientMessage { <arm> = N }` → the inner message's byte slice for
/// the expected arm number. Returns None if the frame's first field isn't a
/// LEN-delimited field with that number.
fn unwrap_arm(frame: &[u8], arm: u32) -> Option<&[u8]> {
    let mut o = 0;
    let key = rd_varint(frame, &mut o)?;
    let field = (key >> 3) as u32;
    let wire = (key & 7) as u8;
    if field != arm || wire != 2 {
        return None;
    }
    let len = rd_varint(frame, &mut o)? as usize;
    frame.get(o..o + len)
}

/// submit_effect: extract fxb (field 2, LEN) + activate (field 3, varint) from
/// the raw frame, load it into the VM, and (optionally) activate. Reply
/// result_ready(effect_id) or error(bad_fxb / effect_too_large).
unsafe fn handle_submit_effect(frame: &[u8]) -> pb::ServerMessage {
    let Some(body) = unwrap_arm(frame, ARM_SUBMIT_EFFECT) else {
        return fx_error("bad_fxb", "submit_effect is malformed");
    };
    // SubmitEffect { string effect_id = 1; bytes fxb = 2; bool activate = 3; }
    let mut fxb: Option<&[u8]> = None;
    let mut activate = false;
    let mut o = 0;
    while o < body.len() {
        let Some(key) = rd_varint(body, &mut o) else {
            return fx_error("bad_fxb", "submit_effect is malformed");
        };
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        match (field, wire) {
            (2, 2) => {
                let Some(len) = rd_varint(body, &mut o) else {
                    return fx_error("bad_fxb", "submit_effect is malformed");
                };
                let len = len as usize;
                let Some(s) = body.get(o..o + len) else {
                    return fx_error("bad_fxb", "submit_effect is malformed");
                };
                fxb = Some(s);
                o += len;
            }
            (3, 0) => {
                let Some(v) = rd_varint(body, &mut o) else {
                    return fx_error("bad_fxb", "submit_effect is malformed");
                };
                activate = v != 0;
            }
            _ => {
                if !skip_field(body, &mut o, wire) {
                    return fx_error("bad_fxb", "submit_effect is malformed");
                }
            }
        }
    }
    let Some(fxb) = fxb else {
        return fx_error("bad_fxb", "submit_effect without fxb");
    };
    if fxb.len() > FX_MAX_BYTES {
        return fx_error("effect_too_large", "fxb exceeds this player's effect buffer");
    }
    let ok = lm_fx_load(fxb.as_ptr(), fxb.len());
    if !ok {
        // Distinguish size (bounded) from a parse failure.
        if fxb.len() > FX_MAX_BYTES {
            return fx_error("effect_too_large", "fxb exceeds this player's effect buffer");
        }
        return fx_error("bad_fxb", "fxb failed to parse");
    }
    // activate=true takes over rendering now; false parks it (loaded + valid,
    // set_effect can activate later).
    lm_fx_set_active(activate);
    let mut r = pb::ResultReady::default();
    // effect_id echoes back so the app can correlate the ack; also latch it so
    // the PerfReport can pin its metrics to this effect (perf-monitoring.md).
    if let Some(id) = read_effect_id(body) {
        let _ = r.r#map_id.push_str(id);
        perf_set_effect_id(id);
    } else {
        FX_ID_LEN = 0;
    }
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::ResultReady(r)) }
}

// SetTexture.format values (mirror the .proto / web encoder).
const TEX_RGB888: u64 = 0;
const TEX_RGB565: u64 = 1;
const TEX_RGB332: u64 = 2;
// GRAY8 folds into the `_ => 1` byte-per-texel / catch-all arms below, so it's
// never referenced by name — kept to complete the proto-enum mirror.
#[allow(dead_code)]
const TEX_GRAY8: u64 = 3;
const TEX_INDEXED8: u64 = 4;
const TEX_PAL_MAX: usize = 256;

fn tex_bytes_per_texel(format: u64) -> usize {
    match format {
        TEX_RGB888 => 3,
        TEX_RGB565 => 2,
        _ => 1, // RGB332 / GRAY8 / INDEXED8 — 1 byte/texel
    }
}

/// Dequantize one texel's `bpt` bytes to linear RGB in 0..1. `palette` (0x00RRGGBB
/// entries) is used only for INDEXED8.
fn dequant_texel(b: &[u8], format: u64, palette: &[u32]) -> (f32, f32, f32) {
    match format {
        TEX_RGB888 => (b[0] as f32 / 255.0, b[1] as f32 / 255.0, b[2] as f32 / 255.0),
        TEX_RGB565 => {
            let v = (b[0] as u16) | ((b[1] as u16) << 8); // little-endian
            (
                ((v >> 11) & 0x1f) as f32 / 31.0,
                ((v >> 5) & 0x3f) as f32 / 63.0,
                (v & 0x1f) as f32 / 31.0,
            )
        }
        TEX_RGB332 => {
            let v = b[0];
            (((v >> 5) & 7) as f32 / 7.0, ((v >> 2) & 7) as f32 / 7.0, (v & 3) as f32 / 3.0)
        }
        TEX_INDEXED8 => {
            let v = palette.get(b[0] as usize).copied().unwrap_or(0);
            (
                ((v >> 16) & 0xff) as f32 / 255.0,
                ((v >> 8) & 0xff) as f32 / 255.0,
                (v & 0xff) as f32 / 255.0,
            )
        }
        _ => {
            let g = b[0] as f32 / 255.0; // GRAY8
            (g, g, g)
        }
    }
}

/// set_texture: stream a quantized frame into the active effect's 2D texture.
/// Walks SetTexture { tex_index=1, format=2, width=3, height=4, flags=5, data=6 }
/// (palette TODO). The payload is applied as an XOR delta into the kept previous
/// frame (a keyframe zeroes it first), optionally RLE'd (zero-run scheme), then
/// dequantized into the texture's arena slots. Silently drops on any mismatch.
unsafe fn handle_set_texture(frame: &[u8]) {
    let Some(body) = unwrap_arm(frame, ARM_SET_TEXTURE) else {
        return;
    };
    let (mut tex_index, mut format, mut width, mut height, mut flags) = (0u64, 0u64, 0u64, 0u64, 0u64);
    let mut data: &[u8] = &[];
    let mut palette = [0u32; TEX_PAL_MAX]; // INDEXED8 lookup (0x00RRGGBB)
    let mut o = 0;
    while o < body.len() {
        let Some(key) = rd_varint(body, &mut o) else {
            return;
        };
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        macro_rules! rdv {
            ($dst:expr) => {{
                match rd_varint(body, &mut o) {
                    Some(v) => $dst = v,
                    None => return,
                }
            }};
        }
        match (field, wire) {
            (1, 0) => rdv!(tex_index),
            (2, 0) => rdv!(format),
            (3, 0) => rdv!(width),
            (4, 0) => rdv!(height),
            (5, 0) => rdv!(flags),
            (6, 2) => {
                let Some(len) = rd_varint(body, &mut o) else {
                    return;
                };
                let Some(s) = body.get(o..o + len as usize) else {
                    return;
                };
                data = s;
                o += len as usize;
            }
            (7, 2) => {
                // palette (packed repeated uint32, 0x00RRGGBB) for INDEXED8.
                let Some(len) = rd_varint(body, &mut o) else {
                    return;
                };
                let end = o + len as usize;
                let mut pi = 0usize;
                while o < end && pi < TEX_PAL_MAX {
                    match rd_varint(body, &mut o) {
                        Some(v) => {
                            palette[pi] = v as u32;
                            pi += 1;
                        }
                        None => return,
                    }
                }
                o = end; // skip any overflow entries
            }
            _ => {
                if !skip_field(body, &mut o, wire) {
                    return;
                }
            }
        }
    }
    // Resolve the target texture in the active program.
    let bytes = &(*addr_of!(FX_BYTES))[..FX_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return;
    };
    let Some(d) = prog.buf_desc(tex_index as usize) else {
        return;
    };
    if d.kind != 1 || d.w as u64 != width || d.h as u64 != height {
        return; // not a texture, or dimensions don't match the declared texture
    }
    let bpt = tex_bytes_per_texel(format);
    let n_texels = (width * height) as usize;
    let total = n_texels * bpt;
    if total == 0 || total > FX_TEX_PREV_MAX {
        return;
    }
    let prev = &mut (*addr_of_mut!(FX_TEX_PREV))[..total];
    if flags & 0x01 == 0 {
        prev.fill(0); // keyframe: start from black, then XOR-apply the frame
    }
    // Apply the payload as an XOR delta into `prev` (a zero-run leaves it as-is).
    if flags & 0x02 != 0 {
        let mut j = 0usize;
        let mut p = 0usize;
        while j < total && p < data.len() {
            let Some(zeros) = rd_varint(data, &mut p) else {
                break;
            };
            j += zeros as usize;
            let Some(lits) = rd_varint(data, &mut p) else {
                break;
            };
            for _ in 0..lits {
                if j >= total || p >= data.len() {
                    break;
                }
                prev[j] ^= data[p];
                p += 1;
                j += 1;
            }
        }
    } else {
        for j in 0..data.len().min(total) {
            prev[j] ^= data[j];
        }
    }
    // Dequantize prev -> the texture's arena region, PACKED at the texture's
    // declared component precision (FUG-10) so a narrow texture compresses the
    // stream on-device too. `comp_store_num` quantizes each float channel.
    let arena = &mut (*addr_of_mut!(FX_ARENA))[..];
    let base = prog.buf_base(tex_index as usize, FX_F_LEDS as usize);
    let elem = d.elem as usize;
    let cb = ledmapper_fx_vm::comp_bytes(d.comp);
    let eb = d.elem_bytes();
    for t in 0..n_texels {
        let (r, g, b) = dequant_texel(&prev[t * bpt..t * bpt + bpt], format, &palette);
        let ab = base + t * eb;
        if elem == 1 {
            let o = ab;
            if o + cb <= arena.len() {
                let luma = 0.299 * r + 0.587 * g + 0.114 * b;
                ledmapper_fx_vm::comp_store_num(d.comp, luma, &mut arena[o..o + cb]);
            }
        } else {
            let ch = [r, g, b, 1.0];
            for (k, &c) in ch.iter().enumerate().take(elem.min(4)) {
                let o = ab + k * cb;
                if o + cb <= arena.len() {
                    ledmapper_fx_vm::comp_store_num(d.comp, c, &mut arena[o..o + cb]);
                }
            }
        }
    }
}

/// Read a message's `effect_id` (field 1, string) if present.
fn read_effect_id(body: &[u8]) -> Option<&str> {
    let mut o = 0;
    while o < body.len() {
        let key = rd_varint(body, &mut o)?;
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        if field == 1 && wire == 2 {
            let len = rd_varint(body, &mut o)? as usize;
            let s = body.get(o..o + len)?;
            return core::str::from_utf8(s).ok();
        }
        if !skip_field(body, &mut o, wire) {
            return None;
        }
    }
    None
}

/// set_effect: "" / "off" clears the active effect; any other id keeps the
/// loaded effect active (a single effect is held at a time, matching the arena
/// map). Reply: playback_state (via the session core, so the app's playback UI
/// stays consistent). We just clear/keep and echo the current playback state.
unsafe fn handle_set_effect(frame: &[u8]) -> pb::ServerMessage {
    let id = unwrap_arm(frame, ARM_SET_EFFECT).and_then(read_effect_id).unwrap_or("");
    if id.is_empty() || id == "off" {
        lm_fx_clear();
    } else {
        // Select the (single) loaded effect as active. One effect is held at a
        // time, so any non-empty id activates whatever is loaded.
        lm_fx_set_active(true);
    }
    // Ack with the session's playback state so the app's playback UI stays put.
    player().playback_reply()
}

/// set_uniforms: apply every UniformValue{slot, value[]} to the VM. Reply:
/// playback_state.
unsafe fn handle_set_uniforms(frame: &[u8]) -> pb::ServerMessage {
    if let Some(body) = unwrap_arm(frame, ARM_SET_UNIFORMS) {
        // SetUniforms { repeated UniformValue values = 1; }
        let mut o = 0;
        while o < body.len() {
            let Some(key) = rd_varint(body, &mut o) else { break };
            let field = (key >> 3) as u32;
            let wire = (key & 7) as u8;
            if field == 1 && wire == 2 {
                let Some(len) = rd_varint(body, &mut o) else { break };
                let len = len as usize;
                let Some(uv) = body.get(o..o + len) else { break };
                apply_uniform_value(uv);
                o += len;
            } else if !skip_field(body, &mut o, wire) {
                break;
            }
        }
    }
    player().playback_reply()
}

/// Decode one UniformValue{ uint32 slot = 1; repeated float value = 2; } and
/// push it into the VM. `value` may arrive packed (a single LEN field of f32s)
/// or unpacked (repeated fixed32) — handle both.
unsafe fn apply_uniform_value(uv: &[u8]) {
    let mut slot: u32 = 0;
    let mut vals = [0.0f32; 4];
    let mut n = 0usize;
    let mut o = 0;
    while o < uv.len() {
        let Some(key) = rd_varint(uv, &mut o) else { break };
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        match (field, wire) {
            (1, 0) => {
                let Some(v) = rd_varint(uv, &mut o) else { break };
                slot = v as u32;
            }
            (2, 2) => {
                // packed floats
                let Some(len) = rd_varint(uv, &mut o) else { break };
                let len = len as usize;
                let Some(p) = uv.get(o..o + len) else { break };
                let mut k = 0;
                while k + 4 <= p.len() && n < vals.len() {
                    vals[n] = f32::from_le_bytes([p[k], p[k + 1], p[k + 2], p[k + 3]]);
                    n += 1;
                    k += 4;
                }
                o += len;
            }
            (2, 5) => {
                // unpacked single float
                let Some(p) = uv.get(o..o + 4) else { break };
                if n < vals.len() {
                    vals[n] = f32::from_le_bytes([p[0], p[1], p[2], p[3]]);
                    n += 1;
                }
                o += 4;
            }
            _ => {
                if !skip_field(uv, &mut o, wire) {
                    break;
                }
            }
        }
    }
    if n > 0 {
        lm_fx_set_uniform(slot, vals.as_ptr(), n);
    }
}

/// get_effect_uniforms: build an EffectUniforms reply carrying the active
/// effect's manifest bytes. `current` uniform values aren't tracked back out
/// (the app holds them); left empty. Error `no_effect` when nothing is loaded.
unsafe fn handle_get_effect_uniforms(_frame: &[u8]) -> pb::ServerMessage {
    if !lm_fx_active() {
        return fx_error("no_effect", "no active effect to describe");
    }
    let bytes = &(*addr_of!(FX_BYTES))[..FX_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return fx_error("no_effect", "no active effect to describe");
    };
    let mut m = pb::EffectUniforms::default();
    let _ = m.r#manifest.extend_from_slice(prog.manifest);
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::EffectUniforms(m)) }
}

fn fx_error(code: &str, message: &str) -> pb::ServerMessage {
    let mut e = pb::Error::default();
    let _ = e.r#code.push_str(code);
    let _ = e.r#message.push_str(message);
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::Error(e)) }
}

// -- perf-monitoring protocol handlers ---------------------------------------

/// The C6's CPU clock (cycles → ms conversion factor, carried in the report so
/// the app never hardcodes it). The bring-up image runs the C6 at 160 MHz.
/// TODO(hw): read this from the SoC (esp_clk_cpu_freq / rtc_clk_cpu_freq_get)
/// via a C++-provided value instead of the constant, in case a build downclocks.
const PERF_CPU_HZ: u32 = 160_000_000;

/// Target frame budget = 1/30 s. budget_cycles = 33 ms × cpu_hz (perf-
/// monitoring.md); overruns are frames whose frame+show cycles exceed this.
const PERF_BUDGET_CYCLES: u32 = (PERF_CPU_HZ / 1000) * 33;

/// set_perf: store the tier + push interval. Reply is an immediate PerfReport
/// (current window), like get_perf_report — so opening the panel gets one
/// synchronously. FULL flips on Tier-1 counting; OFF/BASIC skip it.
unsafe fn handle_set_perf(frame: &[u8]) -> pb::ServerMessage {
    let mut mode = PERF_OFF;
    let mut interval = 0u32;
    if let Some(body) = unwrap_arm(frame, ARM_SET_PERF) {
        // SetPerf { Mode mode = 1; uint32 interval_ms = 2; }
        let mut o = 0;
        while o < body.len() {
            let Some(key) = rd_varint(body, &mut o) else { break };
            let field = (key >> 3) as u32;
            let wire = (key & 7) as u8;
            match (field, wire) {
                (1, 0) => {
                    let Some(v) = rd_varint(body, &mut o) else { break };
                    mode = v as u32;
                }
                (2, 0) => {
                    let Some(v) = rd_varint(body, &mut o) else { break };
                    interval = v as u32;
                }
                _ => {
                    if !skip_field(body, &mut o, wire) {
                        break;
                    }
                }
            }
        }
    }
    PERF_MODE = if mode > PERF_FULL { PERF_FULL } else { mode };
    PERF_INTERVAL_MS = interval;
    // OFF clears the accumulated ring so a later BASIC/FULL starts clean.
    if PERF_MODE == PERF_OFF {
        perf_reset_ring();
    }
    build_perf_report()
}

/// get_perf_report: roll up the ring window + drain the tail into a PerfReport.
unsafe fn handle_get_perf_report() -> pb::ServerMessage {
    build_perf_report()
}

/// Build a PerfReport: the rolling-window summary over all buffered samples,
/// the since-drain counters (reset here), identity (effect_id + fxb_hash +
/// cpu_hz + budget_cycles), heap, and the raw tail drained into `ticks` (bounded
/// by the field cap; the rest wait for the next poll — the ring buffers them).
unsafe fn build_perf_report() -> pb::ServerMessage {
    let ring = &mut *addr_of_mut!(PERF_RING);
    // Rolling window over everything currently buffered (summary is non-
    // destructive; the drain below is what empties the ring).
    let mut window_buf = [PerfSample::default(); PERF_RING_CAP];
    let mut wn = 0usize;
    while let Some(s) = ring.get(wn) {
        window_buf[wn] = *s;
        wn += 1;
    }
    let w = perf_rollup(&window_buf[..wn]);

    let mut r = pb::PerfReport::default();
    // Identity.
    let id = core::str::from_utf8(&(*addr_of!(FX_ID))[..FX_ID_LEN]).unwrap_or("");
    let _ = r.r#effect_id.push_str(id);
    r.r#fxb_hash = FX_HASH;
    r.r#cpu_hz = PERF_CPU_HZ;
    r.r#budget_cycles = PERF_BUDGET_CYCLES;
    // Rolling window.
    r.r#frame_cycles_min = w.frame_min;
    r.r#frame_cycles_mean = w.frame_mean;
    r.r#frame_cycles_max = w.frame_max;
    r.r#update_cycles_mean = w.update_mean;
    r.r#shade_cycles_mean = w.shade_mean;
    r.r#show_cycles_mean = w.show_mean;
    // Since-drain counters (reset on drain).
    r.r#overruns = ring.overruns;
    r.r#dropped_frames = ring.dropped_frames;
    r.r#samples_dropped = ring.samples_dropped;
    ring.overruns = 0;
    ring.dropped_frames = 0;
    ring.samples_dropped = 0;
    // Memory (heap is read on the C++ side and pushed via lm_perf_set_heap; the
    // latest values ride here).
    r.r#heap_free = PERF_HEAP_FREE;
    r.r#heap_min_free = PERF_HEAP_MIN_FREE;
    // Raw tail: drain oldest-first until the ticks field is at capacity; any
    // remaining samples stay in the ring for the next poll (no loss).
    while r.r#ticks.len() < r.r#ticks.capacity() {
        let Some(s) = ring.pop() else { break };
        let mut t = pb::PerfFrame::default();
        t.r#seq = s.seq;
        t.r#update_cycles = s.update_cycles;
        t.r#shade_cycles = s.shade_cycles;
        t.r#frame_cycles = s.frame_cycles;
        t.r#show_cycles = s.show_cycles;
        t.r#led_count = s.led_count;
        t.r#instr_update = s.instr_update;
        t.r#instr_shade = s.instr_shade;
        t.r#stack_max = s.stack_max;
        let _ = r.r#ticks.push(t);
    }
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::PerfReport(r)) }
}

/// Latest heap figures, refreshed by main.cpp before each ring push (the FFI
/// core has no ESP-IDF; the C++ side reads esp_get_free_heap_size et al.).
static mut PERF_HEAP_FREE: u32 = 0;
static mut PERF_HEAP_MIN_FREE: u32 = 0;

/// Reset the ring + its counters (fresh effect / mode change). Latched Tier-1
/// counters are cleared too so a stale count can't leak into the next frame.
unsafe fn perf_reset_ring() {
    *addr_of_mut!(PERF_RING) = PerfRing::new();
    FX_INSTR_UPDATE = 0;
    FX_INSTR_SHADE = 0;
    FX_STACK_MAX = 0;
}

/// Latch the effect_id (truncated to the fixed buffer) for PerfReport identity.
unsafe fn perf_set_effect_id(id: &str) {
    let b = id.as_bytes();
    let dst = &mut *addr_of_mut!(FX_ID);
    let n = b.len().min(dst.len());
    dst[..n].copy_from_slice(&b[..n]);
    FX_ID_LEN = n;
}

// -- render-side accessors (pure reads; the FastLED loop polls these) --------

/// Mapping-pattern timing, all INTEGER (the render loop touches no f64):
/// writes epoch_ms (i64), bit_period_us (u32), cycle_frames, led_count. False
/// when no capture is active. Absolute frame index at player-clock ms `t` is
/// `((t - epoch_ms) * 1000) / bit_period_us`.
#[no_mangle]
pub unsafe extern "C" fn lm_pattern_timing(
    epoch_ms: *mut i64,
    bit_period_us: *mut u32,
    cycle_frames: *mut u32,
    led_count: *mut u32,
) -> bool {
    match player().pattern_timing() {
        Some((epoch, period_us, frames, leds)) => {
            *epoch_ms = epoch;
            *bit_period_us = period_us;
            *cycle_frames = frames;
            *led_count = leds;
            true
        }
        None => false,
    }
}

/// Record that the frame loop just pushed mapping-pattern frame `seq` (the
/// absolute frame index since the pattern epoch, before the cycle modulo) to
/// the LEDs at player monotonic clock `t_mono_us` (raw micros(), integer µs).
/// Buffered for the phone to drain via get_frame_timing (stutter diagnosis).
/// Cheap ring write — call it unconditionally right after the strip update.
#[no_mangle]
pub unsafe extern "C" fn lm_pattern_frame_shown(seq: u32, t_mono_us: u32) {
    player().record_frame_shown(seq, t_mono_us);
}

/// The color LED `led` shows in mapping cycle frame `frame_index`
/// (caller reduces modulo cycle_frames). False when no capture is active.
#[no_mangle]
pub unsafe extern "C" fn lm_pattern_color(led: u32, frame_index: u32, rgb: *mut u8) -> bool {
    match player().pattern_color(led, frame_index) {
        Some((r, g, b)) => {
            *rgb = r;
            *rgb.add(1) = g;
            *rgb.add(2) = b;
            true
        }
        None => false,
    }
}

/// Whether a playback effect ("pulse"/"flood") is configured — the render loop
/// drives the LEDs via lm_playback_step + lm_playback_color when so (and no
/// capture/counting is running). LEDs stay black until a topology is uploaded.
#[no_mangle]
pub unsafe extern "C" fn lm_playback_active() -> bool {
    player().effect_config().is_some()
}

/// (Re)build the effect simulator from the stored topology + active config if
/// stale, then advance it by `dt_ms`. Returns whether a renderable sim exists
/// (config active AND a topology is stored). Call once per render frame before
/// the per-LED lm_playback_color sweep.
#[no_mangle]
pub unsafe extern "C" fn lm_playback_step(dt_ms: u32) -> bool {
    ensure_sim();
    match (*addr_of_mut!(SIM)).as_mut() {
        Some(sim) => {
            sim.step(dt_ms);
            true
        }
        None => false,
    }
}

/// Ensure SIM reflects the current TOPO + effect config. A config-only change
/// (a live slider) is ADOPTED IN PLACE so the running animation isn't reset; a
/// fresh sim is built only when none exists yet or the topology was (re)uploaded
/// (which nulls SIM). Nulls SIM when the effect is off or no topology is stored.
unsafe fn ensure_sim() {
    let cfg = match player().effect_config() {
        Some(c) => *c,
        None => {
            *addr_of_mut!(SIM) = None;
            return;
        }
    };
    let gen = player().playback_gen();
    // A sim already exists (same topology): adopt config changes smoothly.
    if let Some(sim) = (*addr_of_mut!(SIM)).as_mut() {
        if SIM_GEN != gen {
            sim.set_config(cfg);
            SIM_GEN = gen;
        }
        return;
    }
    let Some(topo) = (*addr_of!(TOPO)).as_ref() else {
        return;
    };
    // Graph::build takes (branch-point a, b, length_mm) per segment in order;
    // the resulting segment index equals the input position, which is how
    // lm_playback_color maps an association's segment_id back to a sim segment.
    let mut segs = [(0i32, 0i32, 0u32); MAX_SEGMENTS];
    let mut n = 0usize;
    for s in topo.segments.iter() {
        if n >= MAX_SEGMENTS {
            break;
        }
        segs[n] = (s.a, s.b, (s.length * 1000.0) as u32);
        n += 1;
    }
    let graph = Graph::build(&segs[..n]);
    // Vary the PRNG seed per config so successive effects don't replay identically.
    *addr_of_mut!(SIM) = Some(Sim::new(graph, cfg, gen ^ 0x9E37_79B9));
    SIM_GEN = gen;
}

/// The color LED `led` shows under the active effect, from the stepped sim and
/// this LED's stored association (segment index, foot arclength, perpendicular
/// offset). False when no sim is renderable or this LED has no association.
/// Meters→mm uses f32 (hardware on the C6); the sim math itself is integer.
#[no_mangle]
pub unsafe extern "C" fn lm_playback_color(led: u32, rgb: *mut u8) -> bool {
    let Some(sim) = (*addr_of!(SIM)).as_ref() else {
        return false;
    };
    let Some(topo) = (*addr_of!(TOPO)).as_ref() else {
        return false;
    };
    let Some(assoc) = topo.associations.iter().find(|a| a.led_id == led) else {
        return false;
    };
    let Some(idx) = topo.segments.iter().position(|s| s.id == assoc.segment_id) else {
        return false;
    };
    if idx >= MAX_SEGMENTS {
        return false;
    }
    let s_mm = (assoc.foot_arclength * 1000.0) as u32;
    let d_perp_mm = (assoc.d_perp * 1000.0) as u32;
    let (r, g, b) = sim.led_color(idx as u16, s_mm, d_perp_mm);
    *rgb = r;
    *rgb.add(1) = g;
    *rgb.add(2) = b;
    true
}

/// The color LED `led` shows under the latched counting pattern (blocks
/// paint, everything else off). False when no counting pattern is latched.
#[no_mangle]
pub unsafe extern "C" fn lm_counting_color(led: u32, rgb: *mut u8) -> bool {
    match player().counting_color(led) {
        Some((r, g, b)) => {
            *rgb = r;
            *rgb.add(1) = g;
            *rgb.add(2) = b;
            true
        }
        None => false,
    }
}

/// The persisted strip length for `channel` (set_led_count); -1 when unset.
#[no_mangle]
pub unsafe extern "C" fn lm_led_count(channel: u32) -> i32 {
    match player().led_count(channel as usize) {
        Some(n) => n as i32,
        None => -1,
    }
}

/// Number of LEDs in the stored (arena-decoded) map; 0 when none stored.
#[no_mangle]
pub unsafe extern "C" fn lm_map_len() -> u32 {
    (*addr_of!(MAP)).as_ref().map_or(0, |m| m.leds.len() as u32)
}

/// The stored map entry at `index`: id + xyz (meters). False out of range.
#[no_mangle]
pub unsafe extern "C" fn lm_map_led(index: u32, id: *mut u32, xyz: *mut f32) -> bool {
    match (*addr_of!(MAP)).as_ref().and_then(|m| m.leds.get(index as usize)) {
        Some(led) => {
            *id = led.id;
            *xyz = led.xyz[0];
            *xyz.add(1) = led.xyz[1];
            *xyz.add(2) = led.xyz[2];
            true
        }
        None => false,
    }
}

// -- effects VM FFI (fx_vm) ---------------------------------------------------
// Single-threaded, like the rest of this file: the render task and the message
// handler both call these under the C++ player_mutex.

/// Rebuild [`FX_LED_TOPO`] from the stored map + topology (in map-index order),
/// deriving each LED's segment index, normalized arclength and junction flag
/// from its [`StoredAssociation`]. Cheap to call every frame — it early-returns
/// via [`FX_TOPO_READY`] unless a map/topology upload invalidated the cache.
/// With no topology stored, every entry stays `NONE` (seg = -1), so unmapped
/// LEDs read `led.seg == -1` and topology-aware effects fall back gracefully.
unsafe fn fx_rebuild_topo() {
    let cache = &mut *addr_of_mut!(FX_LED_TOPO);
    for e in cache.iter_mut() {
        *e = FxLedTopo::NONE;
    }
    FX_TOPO_READY = true;
    // Map XY bounds for led.uv — needs only the map (independent of topology), so
    // compute it before the map+topo gate below.
    if let Some(map) = (*addr_of!(MAP)).as_ref() {
        let mut mn = [f32::INFINITY; 2];
        let mut mx = [f32::NEG_INFINITY; 2];
        for led in map.leds.iter() {
            for k in 0..2 {
                mn[k] = mn[k].min(led.xyz[k]);
                mx[k] = mx[k].max(led.xyz[k]);
            }
        }
        for k in 0..2 {
            let range = mx[k] - mn[k];
            FX_UV_MIN[k] = if range.is_finite() { mn[k] } else { 0.0 };
            FX_UV_INV[k] = if range > 1e-6 { 1.0 / range } else { 0.0 };
        }
    }
    let (Some(map), Some(topo)) = ((*addr_of!(MAP)).as_ref(), (*addr_of!(TOPO)).as_ref()) else {
        return;
    };
    // Precompute which branch points are true junctions (degree >= 3). A branch
    // point's degree is how many segment endpoints (a or b) reference its id; a
    // pass-through has degree 2, a free end/terminal <= 1. Branch points are few.
    const MAX_BP: usize = 64;
    let mut junction = [false; MAX_BP];
    for (bi, bp) in topo.branch_points.iter().enumerate().take(MAX_BP) {
        let id = bp.id as i32;
        let mut deg = 0u32;
        for s in topo.segments.iter() {
            if s.a == id {
                deg += 1;
            }
            if s.b == id {
                deg += 1;
            }
        }
        junction[bi] = deg >= 3;
    }
    // True when branch-point id `bp_id` (a segment endpoint) is a junction.
    let is_junction = |bp_id: i32| -> bool {
        bp_id >= 0
            && topo
                .branch_points
                .iter()
                .position(|b| b.id as i32 == bp_id)
                .is_some_and(|bi| bi < MAX_BP && junction[bi])
    };
    // Geodesic distance field (led.dist): a node graph over branch points + one
    // leaf per free segment end; single-source Dijkstra from a deterministic
    // strand end (the first free end in segment order — a real terminal is a
    // free end, id -1 — else segment 0's 'a'). Each LED's raw distance is the
    // shorter of reaching endpoint a then walking foot_arclength, vs endpoint b
    // then the remainder; normalized 0..1 after the sweep. Node numbering:
    // branch-point index for a real endpoint, else n_bp + seg_idx*2 + side.
    // Mirrors web deriveLedTopology so the editor preview matches the device.
    const MAX_SEG: usize = 128;
    const MAX_NODES: usize = MAX_BP + 2 * MAX_SEG;
    let n_bp = topo.branch_points.len().min(MAX_BP);
    let n_seg = topo.segments.len().min(MAX_SEG);
    let node_of = |si: usize, side: usize| -> usize {
        let sg = &topo.segments[si];
        let bp = if side == 0 { sg.a } else { sg.b };
        if bp >= 0 {
            topo.branch_points
                .iter()
                .position(|b| b.id as i32 == bp)
                .map(|bi| bi.min(MAX_BP - 1))
                .unwrap_or(MAX_BP - 1)
        } else {
            n_bp + (si * 2 + side).min(2 * MAX_SEG - 1)
        }
    };
    let mut root = if n_seg > 0 { node_of(0, 0) } else { 0 };
    for si in 0..n_seg {
        let sg = &topo.segments[si];
        if sg.a < 0 {
            root = node_of(si, 0);
            break;
        }
        if sg.b < 0 {
            root = node_of(si, 1);
            break;
        }
    }
    let n_nodes = (n_bp + n_seg * 2).min(MAX_NODES);
    let mut node_dist = [f32::INFINITY; MAX_NODES];
    let mut seen = [false; MAX_NODES];
    if root < MAX_NODES {
        node_dist[root] = 0.0;
    }
    for _ in 0..n_nodes {
        let (mut u, mut best) = (usize::MAX, f32::INFINITY);
        for k in 0..n_nodes {
            if !seen[k] && node_dist[k] < best {
                best = node_dist[k];
                u = k;
            }
        }
        if u == usize::MAX {
            break;
        }
        seen[u] = true;
        for si in 0..n_seg {
            let (a, b, w) = (node_of(si, 0), node_of(si, 1), topo.segments[si].length);
            if a == u && node_dist[u] + w < node_dist[b] {
                node_dist[b] = node_dist[u] + w;
            }
            if b == u && node_dist[u] + w < node_dist[a] {
                node_dist[a] = node_dist[u] + w;
            }
        }
    }

    let mut max_geo = 0.0f32;
    for (i, led) in map.leds.iter().enumerate() {
        if i >= FX_TOPO_CAP {
            break;
        }
        let Some(assoc) = topo.associations.iter().find(|a| a.led_id == led.id) else {
            continue;
        };
        let Some(seg_idx) = topo.segments.iter().position(|s| s.id == assoc.segment_id) else {
            continue;
        };
        let seg = &topo.segments[seg_idx];
        let s_norm = if seg.length > 1e-6 {
            (assoc.foot_arclength / seg.length).clamp(0.0, 1.0)
        } else {
            0.0
        };
        // Near endpoint a (s≈0) or b (s≈1) AND that endpoint is a real junction.
        let near_a = assoc.foot_arclength <= FX_BRANCH_DIST_M;
        let near_b = (seg.length - assoc.foot_arclength) <= FX_BRANCH_DIST_M;
        let branch = (near_a && is_junction(seg.a)) || (near_b && is_junction(seg.b));
        let geo = if seg_idx < n_seg {
            let da = node_dist[node_of(seg_idx, 0)];
            let db = node_dist[node_of(seg_idx, 1)];
            let g = (da + assoc.foot_arclength).min(db + (seg.length - assoc.foot_arclength));
            if g.is_finite() {
                g
            } else {
                0.0
            }
        } else {
            0.0
        };
        if geo > max_geo {
            max_geo = geo;
        }
        cache[i] = FxLedTopo { seg: seg_idx as i16, s: s_norm, branch, dist: geo };
    }
    // Normalize the raw geodesic distances to 0..1 (unassociated LEDs stay 0).
    if max_geo > 1e-6 {
        for e in cache.iter_mut() {
            e.dist /= max_geo;
        }
    }

    // Push the topology graph to the active VM for the graph-query intrinsics
    // (agentic effects). Compact node ids: a real branch point keeps its index,
    // each free end gets a fresh id after the branch points (kept small so it
    // stays under fx_vm::MAX_NODE). Segment index i matches led.seg / ag.seg.
    if let Some(vm) = (*addr_of_mut!(FX_VM)).as_mut() {
        const G: usize = 64; // fx_vm::MAX_SEG
        let mut seg_len = [0.0f32; G];
        let mut seg_a = [-1i32; G];
        let mut seg_b = [-1i32; G];
        let ng = n_seg.min(G);
        let node_id = |bp: i32, next_free: &mut i32| -> i32 {
            if bp >= 0 {
                topo.branch_points
                    .iter()
                    .position(|b| b.id as i32 == bp)
                    .map(|i| i as i32)
                    .unwrap_or(-1)
            } else {
                let id = *next_free;
                *next_free += 1;
                id
            }
        };
        let mut next_free = n_bp as i32;
        for i in 0..ng {
            let seg = &topo.segments[i];
            seg_len[i] = seg.length;
            seg_a[i] = node_id(seg.a, &mut next_free);
            seg_b[i] = node_id(seg.b, &mut next_free);
        }
        vm.set_graph(&seg_len[..ng], &seg_a[..ng], &seg_b[..ng]);
    }
}

/// The per-invocation bounded-execution guard for the active budget + the
/// wall-time deadline flag.
unsafe fn fx_budget() -> Budget {
    Budget {
        instructions: FX_BUDGET,
        deadline: Some(&FX_DEADLINE as *const AtomicBool),
    }
}

/// Load (parse + hold) a `.fxb` effect, copying `len` bytes into the static
/// buffer. Resets the VM's state (fresh effect). Returns false if the bytes
/// don't fit or don't parse as a valid `.fxb`. After a successful load the
/// effect is HELD but not necessarily active (see lm_fx_active is a pure read
/// of "is a program loaded").
///
/// # Safety
/// `fxb` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_load(fxb: *const u8, len: usize) -> bool {
    if fxb.is_null() || len == 0 || len > FX_MAX_BYTES {
        return false;
    }
    let src = core::slice::from_raw_parts(fxb, len);
    // Validate before committing: reject a malformed .fxb so a bad upload can't
    // wedge the render loop on garbage.
    if Program::parse(src).is_err() {
        return false;
    }
    let buf = &mut *addr_of_mut!(FX_BYTES);
    buf[..len].copy_from_slice(src);
    FX_LEN = len;
    *addr_of_mut!(FX_VM) = Some(FxVm::new());
    // Bind + zero the hidden-buffer arena for the fresh effect (buffers start
    // clean each load; the static memory's pointer is stable so one bind holds).
    {
        let arena = &mut *addr_of_mut!(FX_ARENA);
        arena.fill(0);
        if let Some(vm) = (*addr_of_mut!(FX_VM)).as_mut() {
            vm.set_arena(arena);
        }
    }
    // Force a topology-cache rebuild so the fresh VM gets the current graph
    // (set_graph) + per-LED cache on its first frame, regardless of load order.
    FX_TOPO_READY = false;
    FX_DEADLINE.store(false, core::sync::atomic::Ordering::Relaxed);
    // A fresh effect (re)stamps the perf identity and resets the ring/window so
    // metrics can't be mis-attributed across a hot-reload (perf-monitoring.md).
    FX_HASH = fxb_hash(src);
    perf_reset_ring();
    true
}

/// Clear the loaded effect (back to the built-in playback/idle). Frees nothing
/// (the buffer is static) but marks no program loaded and not active.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_clear() {
    FX_LEN = 0;
    FX_ACTIVE = false;
    *addr_of_mut!(FX_VM) = None;
    FX_HASH = 0;
    FX_ID_LEN = 0;
    perf_reset_ring();
}

/// Whether an effect is loaded, ACTIVE, and renderable — the render loop gates
/// on this, taking priority over the built-in pulse/flood playback.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_active() -> bool {
    FX_ACTIVE && FX_LEN > 0 && (*addr_of!(FX_VM)).is_some()
}

/// Whether an effect is loaded at all (active or parked). Used by persistence.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_loaded() -> bool {
    FX_LEN > 0 && (*addr_of!(FX_VM)).is_some()
}

/// Mark the loaded effect active (true) or parked (false). No-op with nothing
/// loaded.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_active(active: bool) {
    if FX_LEN > 0 && (*addr_of!(FX_VM)).is_some() {
        FX_ACTIVE = active;
    }
}

/// Set the max instruction count for one update()/shade() invocation (bounded
/// execution, primary guard). 0 restores the default.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_budget(instructions: u32) {
    FX_BUDGET = if instructions == 0 {
        ledmapper_fx_vm::DEFAULT_BUDGET
    } else {
        instructions
    };
}

/// Raise/lower the wall-time deadline flag (secondary guard). The C++ hardware
/// timer callback calls this with `true` at the frame deadline; the render loop
/// clears it (false) before each frame's update()/shade() sweep. Cheap atomic
/// store — safe to call from an ISR/timer context. TODO(hw): wire an
/// esp_timer/systimer one-shot armed each frame to invoke this at the deadline.
#[no_mangle]
pub extern "C" fn lm_fx_set_deadline(hit: bool) {
    FX_DEADLINE.store(hit, core::sync::atomic::Ordering::Relaxed);
}

/// Last update() bounded-exec outcome: 0=Ok, 1=budget exceeded, 2=wall-time
/// timeout. For the rate-limited `[fx]` diagnostic log in the render loop.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_last_update_outcome() -> u32 {
    FX_LAST_UPDATE_OUTCOME
}

/// Apply a uniform value (`vals` = its slot count, 1..4) to the active VM.
///
/// # Safety
/// `vals` must point to `n` readable f32.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_uniform(slot: u32, vals: *const f32, n: usize) {
    if vals.is_null() || n == 0 {
        return;
    }
    if let Some(vm) = (*addr_of_mut!(FX_VM)).as_mut() {
        let s = core::slice::from_raw_parts(vals, n);
        vm.set_uniform(slot as usize, s);
    }
}

/// Run `update()` once for this frame (before the per-LED shade sweep). Clears
/// the wall-time deadline flag first (a fresh frame gets the full budget).
/// Returns false when no effect is loaded. A cancelled update (budget/timeout)
/// still returns true — a partial state advance is harmless.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_update(time_s: f32, dt_s: f32, frame: u32, led_count: u32) -> bool {
    FX_DEADLINE.store(false, core::sync::atomic::Ordering::Relaxed);
    let Some(vm) = (*addr_of_mut!(FX_VM)).as_mut() else {
        return false;
    };
    let bytes = &(*addr_of!(FX_BYTES))[..FX_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return false;
    };
    let f = FxFrame {
        time: time_s,
        dt: dt_s,
        frame,
        led_count,
        ..Default::default()
    };
    // Capture the frame context so the per-LED shade() sweep sees the same
    // time/dt/frame (shaders animate off `time` in shade()).
    FX_F_TIME = time_s;
    FX_F_DT = dt_s;
    FX_F_FRAME = frame;
    FX_F_LEDS = led_count;
    // Refresh the per-LED topology cache if a map/topology upload invalidated it,
    // so the coming shade() sweep sees current led.seg / led.s / led.branch.
    if !FX_TOPO_READY {
        fx_rebuild_topo();
    }
    // A new frame: reset the per-frame Tier-1 shade accumulators (they sum over
    // the coming per-LED sweep). update()'s own counts are latched here.
    FX_INSTR_SHADE = 0;
    FX_STACK_MAX = 0;
    let outcome = if PERF_MODE == PERF_FULL {
        // FULL: pay the counted VM path so instr_update / stack_max are real.
        let (oc, c) = vm.run_update_counted(&prog, &f, &fx_budget());
        FX_INSTR_UPDATE = c.instrs;
        FX_STACK_MAX = c.stack_max;
        oc
    } else {
        // BASIC/OFF: the plain path — no per-opcode counting overhead.
        FX_INSTR_UPDATE = 0;
        vm.run_update_bounded(&prog, &f, &fx_budget())
    };
    FX_LAST_UPDATE_OUTCOME = outcome as u32;
    true
}

/// Shade one LED: run `shade(led)` → rgb (3 bytes). `x`,`y`,`z` are the LED's
/// position (the render loop passes the stored map position via lm_map_led).
/// Returns false when no effect is loaded OR the invocation was cancelled by a
/// bounded-execution guard (budget/timeout) — the caller then holds last/black
/// for that LED rather than hanging the render task.
///
/// # Safety
/// `rgb` must point to 3 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_shade(
    idx: u32,
    x: f32,
    y: f32,
    z: f32,
    rgb: *mut u8,
) -> bool {
    let Some(vm) = (*addr_of!(FX_VM)).as_ref() else {
        return false;
    };
    let bytes = &(*addr_of!(FX_BYTES))[..FX_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return false;
    };
    // Reuse the frame context captured by lm_fx_update so `time`/`dt`/`frame`
    // are the same as update() — shaders animate off `time` in shade().
    let f = FxFrame {
        time: FX_F_TIME,
        dt: FX_F_DT,
        frame: FX_F_FRAME,
        led_count: FX_F_LEDS,
        ..Default::default()
    };
    // Per-LED topology (led.seg / led.s / led.branch) from the cache the last
    // lm_fx_update refreshed. `idx` is the map index — exactly this cache's key.
    // No association (or no topology stored) → seg = -1, s = 0, branch = false.
    let t = (*addr_of!(FX_LED_TOPO)).get(idx as usize).copied().unwrap_or(FxLedTopo::NONE);
    let uv = [
        ((x - FX_UV_MIN[0]) * FX_UV_INV[0]).clamp(0.0, 1.0),
        ((y - FX_UV_MIN[1]) * FX_UV_INV[1]).clamp(0.0, 1.0),
    ];
    let led = FxLed {
        pos: [x, y, z],
        idx,
        seg: t.seg as i32,
        s: t.s,
        branch: t.branch,
        dist: t.dist,
        uv,
    };
    let outcome = if PERF_MODE == PERF_FULL {
        // FULL: count this LED's opcodes into the per-frame shade accumulator
        // and lift the stack high-water. This is the hottest path, so the
        // counting is gated behind FULL exactly as perf-monitoring.md requires.
        let ((r, g, b), outcome, c): ((u8, u8, u8), Outcome, FxCounters) =
            vm.run_shade_counted(&prog, &f, &led, &fx_budget());
        FX_INSTR_SHADE = FX_INSTR_SHADE.saturating_add(c.instrs);
        if c.stack_max > FX_STACK_MAX {
            FX_STACK_MAX = c.stack_max;
        }
        if outcome == Outcome::Ok {
            *rgb = r;
            *rgb.add(1) = g;
            *rgb.add(2) = b;
        }
        outcome
    } else {
        let ((r, g, b), outcome) = vm.run_shade_bounded(&prog, &f, &led, &fx_budget());
        if outcome == Outcome::Ok {
            *rgb = r;
            *rgb.add(1) = g;
            *rgb.add(2) = b;
        }
        outcome
    };
    outcome == Outcome::Ok
}

/// Copy the active effect's uniforms manifest into `out` (cap `cap`). Returns
/// the manifest length written, or -1 when no effect is loaded, or -2 when the
/// manifest doesn't fit `cap`. Used to build the get_effect_uniforms reply.
///
/// # Safety
/// `out` must point to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_manifest(out: *mut u8, cap: usize) -> i32 {
    if FX_LEN == 0 {
        return -1;
    }
    let bytes = &(*addr_of!(FX_BYTES))[..FX_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return -1;
    };
    let m = prog.manifest;
    if m.len() > cap {
        return -2;
    }
    if !out.is_null() && !m.is_empty() {
        core::ptr::copy_nonoverlapping(m.as_ptr(), out, m.len());
    }
    m.len() as i32
}

// -- perf-monitoring FFI (render loop pushes samples; loop() paces the push) --
// Single-threaded, under player_mutex like the rest. The C++ side owns the
// cycle counter (esp_cpu_get_cycle_count) + heap reads (esp_get_free_heap_size);
// it hands the integer results here. Tier-1 counts live in FX_* statics latched
// by lm_fx_update / lm_fx_shade during the frame.

/// Current perf tier (0 OFF, 1 BASIC, 2 FULL). The render loop reads this to
/// decide whether to sample at all; loop() reads it to decide whether to push
/// an unsolicited report.
#[no_mangle]
pub unsafe extern "C" fn lm_perf_mode() -> u32 {
    PERF_MODE
}

/// The unsolicited-push interval in ms (0 = poll-only). main.cpp coalesces the
/// push at this cadence, like the playback-save quiet timer.
#[no_mangle]
pub unsafe extern "C" fn lm_perf_interval_ms() -> u32 {
    PERF_INTERVAL_MS
}

/// The latched Tier-1 counters from the just-rendered frame (0 unless FULL):
/// opcodes retired in update() / across the shade sweep, and the stack
/// high-water. The render loop reads these into its PerfFrame push.
#[no_mangle]
pub unsafe extern "C" fn lm_perf_instr_update() -> u32 {
    FX_INSTR_UPDATE
}
#[no_mangle]
pub unsafe extern "C" fn lm_perf_instr_shade() -> u32 {
    FX_INSTR_SHADE
}
#[no_mangle]
pub unsafe extern "C" fn lm_perf_stack_max() -> u32 {
    FX_STACK_MAX as u32
}

/// Refresh the heap figures carried in the next PerfReport. Called by the render
/// loop right before lm_perf_push (esp_get_free_heap_size / _minimum on C++).
#[no_mangle]
pub unsafe extern "C" fn lm_perf_set_heap(free: u32, min_free: u32) {
    PERF_HEAP_FREE = free;
    PERF_HEAP_MIN_FREE = min_free;
}

/// Push one rendered effect frame's Tier-0 cycle spans (+ the latched Tier-1
/// counts) into the perf ring. `overran` marks a frame whose frame+show cycles
/// exceeded the budget (counted since-drain). Cheap ring write — the render task
/// calls it unconditionally once per frame while a perf mode is active.
#[no_mangle]
pub unsafe extern "C" fn lm_perf_push(
    seq: u32,
    update_cycles: u32,
    shade_cycles: u32,
    frame_cycles: u32,
    show_cycles: u32,
    led_count: u32,
    overran: bool,
) {
    let ring = &mut *addr_of_mut!(PERF_RING);
    if overran {
        ring.overruns = ring.overruns.saturating_add(1);
    }
    ring.push(PerfSample {
        seq,
        update_cycles,
        shade_cycles,
        frame_cycles,
        show_cycles,
        led_count,
        // Tier-1 counts ride only when FULL latched them this frame.
        instr_update: FX_INSTR_UPDATE,
        instr_shade: FX_INSTR_SHADE,
        stack_max: FX_STACK_MAX as u32,
    });
}

/// Record that the render task skipped a scheduled frame (fell behind). Counted
/// since the last PerfReport drain (dropped_frames).
#[no_mangle]
pub unsafe extern "C" fn lm_perf_note_dropped() {
    let ring = &mut *addr_of_mut!(PERF_RING);
    ring.dropped_frames = ring.dropped_frames.saturating_add(1);
}

/// Build an UNSOLICITED PerfReport (same rollup + drain as the get_perf_report
/// reply) into `out`, for main.cpp to ship at the configured interval while a
/// perf mode is active. Returns the encoded length, 0 if perf is OFF (nothing
/// to push) or -2 if `out_cap` is too small. Drains the ring like a poll would,
/// so it and get_perf_report share the same no-loss discipline.
///
/// # Safety
/// `out` must point to `out_cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_perf_build_report(out: *mut u8, out_cap: usize) -> i32 {
    if out.is_null() {
        return -1;
    }
    if PERF_MODE == PERF_OFF {
        return 0;
    }
    let reply = build_perf_report();
    encode_reply(&reply, out, out_cap)
}
