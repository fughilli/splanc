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
use ledmapper_fx_jit::{plan_blocks_into, PlanOut};
use ledmapper_fx_vm::{
    Budget, Counters as FxCounters, Frame as FxFrame, I2cBus, JitBlock, JitFn, Led as FxLed,
    Outcome, Program, Vm as FxVm, NO_ENTRY,
};
use ledmapper_osc::{self as osc, Config as OscConfig, PortTable, Shadow};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::{upload_malformed, upload_too_large, Player};
use ledmapper_pulse::{Graph, Sim, MAX_SEGMENTS};
use ledmapper_store::{
    decode_submit_map_streamed, decode_submit_topology_streamed, dump, envelope_arm,
    parse_upload_chunk, BlockReader, StoreError, StoredAssociation, StoredSegment, StoredTopoGeom,
    Str64, ARM_GET_STORED_MAP, ARM_SUBMIT_MAP, ARM_SUBMIT_TOPOLOGY,
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
// Flash-backed storage: the arena no longer holds the per-LED map + topology
// (those stream straight into the resident per-LED caches below). It holds ONLY
// the small per-segment topology GEOMETRY (branch points + segments + polylines,
// one entry each — independent of LED count), so 8 KB is ample and the arena no
// longer scales with the strip length.
const ARENA_BYTES: usize = 8 * 1024;

/// Reply frames are control traffic (firmware caps): welcome is the
/// largest at a few hundred bytes.
const REPLY_CAP: usize = 2048;

static mut ARENA_MEM: [u8; ARENA_BYTES] = [0; ARENA_BYTES];
static mut ARENA: Option<Arena<'static>> = None;
/// The stored map's id + LED count. The per-LED positions live in FX_LED_POS
/// (below), streamed in — the raw StoredMap is never resident.
static mut MAP_META: Option<(Str64, u32)> = None;
/// The resident topology geometry (branch points + segments); the per-LED
/// associations are folded into FX_LED_TOPO, not kept here. Borrows ARENA.
static mut GEOM: Option<StoredTopoGeom<'static>> = None;
static mut PLAYER: Option<Player> = None;

/// The topology-aware effect simulator, rebuilt lazily from GEOM + the active
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

// -- FUG-125: on-device JIT ---------------------------------------------------
//
// At effect load the firmware scans the (interpreter) bytecode for hot
// straight-line integer/fixed blocks (fx_jit::plan_blocks_into), compiles each to
// a short RV32 PIC segment, copies the segments into ONE executable IRAM block,
// patches `Op::JitCall` over each block's first bytes in FX_BYTES, and installs a
// JitBlock table on the VM. The interpreter runs everything else and is the
// fallback. Toggle at runtime with `lm_fx_set_jit_enabled` (for the HITL A/B).

// Small, bounded JIT state. This device is heap-critically-tight (TLS needs
// ~28 KB), so the footprint is kept minimal: the segments are compiled DIRECTLY
// into the firmware's 2 KB exec region (no separate scratch/copy), and the
// planning scratch below totals ~1.4 KB. Programs whose code exceeds
// JIT_MAX_CODE stay fully interpreted.
const MAX_JIT_BLOCKS: usize = 8;
const MAX_JIT_CONSTS: usize = 64;
const JIT_MAX_CODE: usize = 1024;

// Default OFF: the interpreter is the shipped default (the golden device cost
// model the app + fx_bench validate against is the interpreter's), and the
// bounded-W^X PMP carve-out is armed only when the JIT is explicitly enabled.
// Flip via lm_fx_set_jit_enabled + reload (the bench does this for the A/B).
static mut FX_JIT_ENABLED: bool = false;
static mut FX_JIT_BLOCKS: [JitBlock; MAX_JIT_BLOCKS] =
    [JitBlock { func: jit_noop, end: 0, net_delta: 0 }; MAX_JIT_BLOCKS];
static mut FX_JIT_N: usize = 0;
// Diagnostics for the HITL bring-up: how many blocks the planner found + the
// segment words used. Surfaced via lm_fx_jit_diag.
static mut FX_JIT_DIAG_PLANS: u32 = 0;
static mut FX_JIT_DIAG_WORDS: u32 = 0;
static mut FX_JIT_DIAG_ALLOC_OK: u32 = 0;
static mut FX_JIT_CONSTS: [i32; MAX_JIT_CONSTS] = [0; MAX_JIT_CONSTS];
static mut FX_JIT_PLANS: [PlanOut; MAX_JIT_BLOCKS] = [PlanOut {
    start: 0,
    end: 0,
    net_delta: 0,
    code_off: 0,
    code_len: 0,
}; MAX_JIT_BLOCKS];
static mut FX_JIT_TARGETS: [bool; JIT_MAX_CODE + 1] = [false; JIT_MAX_CODE + 1];

/// Placeholder segment for the never-called table slots (a real segment always
/// overwrites the slots we install). Must be a valid function, not null.
unsafe extern "C" fn jit_noop(_stack: *mut i32, _locals: *mut i32, _consts: *const i32) {}

// Executable-memory primitives, provided by the C++ firmware: a fixed 2 KB
// static region the Rust side compiles segments straight into, made RWX by a
// spare RISC-V PMP entry (`lm_jit_arm`), plus the instruction-stream sync. Host
// builds can't execute RV32, so `lm_jit_region_words` returns 0 there and the JIT
// installs nothing; these host stubs just satisfy the linker.
#[cfg(target_arch = "riscv32")]
extern "C" {
    fn lm_jit_region_ptr() -> *mut u32;
    fn lm_jit_region_words() -> usize;
    fn lm_jit_arm();
    fn lm_jit_sync_icache();
}
#[cfg(not(target_arch = "riscv32"))]
unsafe fn lm_jit_region_ptr() -> *mut u32 {
    core::ptr::null_mut()
}
#[cfg(not(target_arch = "riscv32"))]
unsafe fn lm_jit_region_words() -> usize {
    0
}
#[cfg(not(target_arch = "riscv32"))]
unsafe fn lm_jit_arm() {}
#[cfg(not(target_arch = "riscv32"))]
unsafe fn lm_jit_sync_icache() {}

/// Build (or tear down) the JIT for the freshly-loaded `prog` and install it on
/// `vm`. A no-op that clears the table when the JIT is disabled, the program is
/// too big / has too many consts, or no hot block is found — the VM then purely
/// interprets. Compiles the segments straight into the exec region (no heap, no
/// scratch copy).
///
/// # Safety
/// Call from `lm_fx_load` after `FX_BYTES`/`FX_LEN` are set and `prog` was parsed
/// from them; mutates `FX_BYTES` (patches `JitCall`) and the JIT statics.
unsafe fn fx_build_jit(prog: &Program, vm: &mut FxVm) {
    FX_JIT_N = 0;
    vm.clear_jit();
    FX_JIT_DIAG_PLANS = 0;
    FX_JIT_DIAG_WORDS = 0;
    FX_JIT_DIAG_ALLOC_OK = 0;
    if !FX_JIT_ENABLED {
        return;
    }
    let region_words = lm_jit_region_words();
    let region_ptr = lm_jit_region_ptr();
    if region_words == 0 || region_ptr.is_null() {
        return; // host / no exec region
    }

    // Aligned i32 mirror of the const pool (the segments' `a2` base).
    let craw = prog.consts_raw();
    let n_consts = craw.len() / 4;
    if n_consts > MAX_JIT_CONSTS {
        return;
    }
    let consts = &mut *addr_of_mut!(FX_JIT_CONSTS);
    for i in 0..n_consts {
        consts[i] = i32::from_le_bytes([craw[i * 4], craw[i * 4 + 1], craw[i * 4 + 2], craw[i * 4 + 3]]);
    }

    let code = prog.code();
    let code_len = code.len();
    if code_len + 1 > JIT_MAX_CODE {
        return; // too big to plan with the bounded scratch — interpret it
    }
    // Byte offset of the code section within FX_BYTES, so we can patch JitCall.
    let code_off = code.as_ptr() as usize - addr_of!(FX_BYTES) as usize;

    // Compile the hot blocks STRAIGHT into the exec region (no scratch/copy).
    let region = core::slice::from_raw_parts_mut(region_ptr, region_words);
    let n = {
        let targets = &mut (*addr_of_mut!(FX_JIT_TARGETS))[..code_len + 1];
        for t in targets.iter_mut() {
            *t = false;
        }
        plan_blocks_into(code, targets, &mut *addr_of_mut!(FX_JIT_PLANS), region)
    };
    FX_JIT_DIAG_PLANS = n as u32;
    if n == 0 {
        return;
    }
    // Segments now live in the region: arm the PMP W^X carve-out + sync i-stream.
    lm_jit_arm();
    lm_jit_sync_icache();

    // Build the block table + patch JitCall over each block's first 3 bytes.
    let blocks = &mut *addr_of_mut!(FX_JIT_BLOCKS);
    let plans = &*addr_of!(FX_JIT_PLANS);
    let fxb = &mut *addr_of_mut!(FX_BYTES);
    let mut installed = 0usize;
    let mut used_words = 0usize;
    for k in 0..n {
        if installed >= MAX_JIT_BLOCKS {
            break;
        }
        let p = plans[k];
        // SAFETY: region_ptr+code_off is the compiled+synced segment for this block.
        let func: JitFn = core::mem::transmute::<*mut u32, JitFn>(region_ptr.add(p.code_off as usize));
        blocks[installed] = JitBlock { func, end: p.end, net_delta: p.net_delta };
        let at = code_off + p.start as usize;
        fxb[at] = ledmapper_fx_vm::Op::JitCall as u8;
        fxb[at + 1] = (installed & 0xff) as u8;
        fxb[at + 2] = ((installed >> 8) & 0xff) as u8;
        installed += 1;
        used_words = used_words.max(p.code_off as usize + p.code_len as usize);
    }
    FX_JIT_DIAG_WORDS = used_words as u32;
    FX_JIT_DIAG_ALLOC_OK = 1;
    FX_JIT_N = installed;
    vm.set_jit(&blocks[..installed], consts.as_ptr());
}

/// Native OSC control (FUG-121). The active effect's uniform manifest reduced to
/// a `name -> (slot, width)` table, rebuilt once per `lm_fx_load` so the UDP
/// task's per-packet path is a table scan, not a JSON parse. `OSC_SHADOW` retains
/// each slot's last values so per-axis vector messages (`/tint/x`) patch one
/// component without clobbering the others. `OSC_BY_NAME` toggles name
/// resolution vs raw slot-index addressing (`false` = the slot-only fallback /
/// the A-B benchmark leg).
static mut OSC_TABLE: PortTable = PortTable::empty();
static mut OSC_SHADOW: Shadow = Shadow::new();
static mut OSC_BY_NAME: bool = true;
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
// Q16.16 mirrors of time/dt, converted ONCE per frame in lm_fx_update so the
// per-LED shade sweep copies them (no soft-float per LED) — FUG-122.
static mut FX_F_TIME_FIX: i32 = 0;
static mut FX_F_DT_FIX: i32 = 0;
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
const FX_TOPO_CAP: usize = 1024;
/// An LED is "at a junction" (`led.branch`) within this arclength (meters) of a
/// segment endpoint that is a real branch point (degree >= 3).
const FX_BRANCH_DIST_M: f32 = 0.05;

/// One LED's derived topology terms, in map-index order (== led_id; the render
/// is index-based). `seg` is the segment INDEX (position in topo.segments, which
/// equals the sim segment index — see ensure_sim), -1 = no association; `s` is
/// normalized 0..1; `branch` = near a junction; `dist` is the geodesic distance
/// from the topology root, 0..1. `foot`/`dperp` are the raw association terms
/// (meters) the pulse/flood sim needs — caching them here makes lm_playback_color
/// an O(1) array read instead of an O(associations) scan per LED per frame. This
/// cache is the SOLE render-time source of topology (the raw associations are no
/// longer resident). 20 bytes/entry.
#[derive(Clone, Copy)]
struct FxLedTopo {
    seg: i16,
    s: f32,
    branch: bool,
    dist: f32,
    foot: f32,
    dperp: f32,
}
impl FxLedTopo {
    const NONE: FxLedTopo =
        FxLedTopo { seg: -1, s: 0.0, branch: false, dist: 0.0, foot: 0.0, dperp: 0.0 };
}

/// Convert a float to Q16.16 (the canonical fixed context width, CTX_FIX_FRAC).
/// Used to build the per-LED/-frame fixed mirrors for LoadCtxFix on demand (only
/// when the loaded effect reads them), so this never grows the resident cache.
#[inline]
fn q16_16(x: f32) -> i32 {
    (x * 65536.0) as i32
}

static mut FX_LED_TOPO: [FxLedTopo; FX_TOPO_CAP] = [FxLedTopo::NONE; FX_TOPO_CAP];

/// Flash-backed map: the per-LED positions (meters), the ONLY map data resident
/// at render time. Fed by the streaming submit_map decode; lm_map_led /
/// get_stored_map / led.uv all read this (the raw StoredMap is gone). Indexed by
/// map index, which IS the LED id (the render is index-based).
static mut FX_LED_POS: [[f32; 3]; FX_TOPO_CAP] = [[0.0; 3]; FX_TOPO_CAP];

/// Map XY bounding box for `led.uv` (a top-down projection of the map to 0..1):
/// `uv = (pos.xy - FX_UV_MIN) * FX_UV_INV`, clamped. Recomputed from FX_LED_POS
/// when the map changes; inv = 0 for a degenerate axis (uv 0).
static mut FX_UV_MIN: [f32; 2] = [0.0, 0.0];
static mut FX_UV_INV: [f32; 2] = [0.0, 0.0];
/// Stale flags for the two independent caches: FX_UV_READY covers the map-derived
/// uv bounds (a map upload clears it), FX_TOPO_READY covers the per-LED topology
/// resolve (a topology upload clears it + refills FX_LED_TOPO.seg with the raw
/// segment_id, which the rebuild resolves to a segment index exactly once). Kept
/// separate so a map upload never re-triggers the topology resolve (which would
/// treat an already-resolved index as an id). Rebuilt lazily before a frame.
static mut FX_TOPO_READY: bool = false;
static mut FX_UV_READY: bool = false;
/// True when the loaded effect reads the per-LED fixed context cache
/// (`LoadCtxFix`). All-float effects leave this false and skip the per-LED
/// fixed-mirror build entirely — zero hot-path overhead (FUG-122).
static mut FX_USES_CTXFIX: bool = false;
/// True when the loaded effect reads `led.uv`. Effects that don't skip the
/// per-LED soft-float uv projection entirely — a chunk of the framing floor.
static mut FX_USES_UV: bool = false;

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
        *addr_of_mut!(MAP_META) = None;
        *addr_of_mut!(GEOM) = None;
        *addr_of_mut!(SIM) = None;
        FX_TOPO_READY = false;
        FX_UV_READY = false;
        for e in (*addr_of_mut!(FX_LED_TOPO)).iter_mut() {
            *e = FxLedTopo::NONE;
        }
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

/// Generation counter for the active color-correction profile, bumped on every
/// `set_color_correction`. The firmware polls this after each `lm_player_handle`
/// (like `lm_device_name`) to notice a change and regenerate + re-persist the
/// per-channel flash LUTs.
#[no_mangle]
pub unsafe extern "C" fn lm_color_correction_gen() -> u32 {
    player().color_correction_gen()
}

/// Copy the active color-correction profile into `out` as six `f32`:
/// `gamma[0..3]` then `luminance[0..3]` (channel order R, G, B). Returns 0 on
/// success, -1 if `out` is null. The firmware builds the LUTs from these.
///
/// # Safety
/// `out` must point to at least six writable `f32`.
#[no_mangle]
pub unsafe extern "C" fn lm_color_correction_params(out: *mut f32) -> i32 {
    if out.is_null() {
        return -1;
    }
    let (gamma, luminance) = player().color_correction();
    let vals = [
        gamma[0], gamma[1], gamma[2], luminance[0], luminance[1], luminance[2],
    ];
    core::ptr::copy_nonoverlapping(vals.as_ptr(), out, vals.len());
    0
}

/// Whether the latest color-correction update should be committed to flash
/// (returns 1) or applied from RAM only (0, live preview). The firmware reads
/// this alongside `lm_color_correction_params` when the generation changes.
#[no_mangle]
pub unsafe extern "C" fn lm_color_correction_commit() -> i32 {
    if player().color_correction_commit() {
        1
    } else {
        0
    }
}

/// Generation counter for the global output brightness, bumped on every
/// `set_brightness`. The firmware polls this after each `lm_player_handle` (like
/// `lm_color_correction_gen`) to notice a change and re-apply the scale.
#[no_mangle]
pub unsafe extern "C" fn lm_brightness_gen() -> u32 {
    player().output_brightness_gen()
}

/// The active global output brightness as an 8-bit scale (0..=255, where 255 is
/// unattenuated) — the form FastLED's `nscale8` wants. The firmware multiplies
/// every rendered LED by this just before the strip write.
#[no_mangle]
pub unsafe extern "C" fn lm_brightness_u8() -> u8 {
    // Round 0.0..=1.0 to 0..=255; clamp defends against any out-of-range value
    // that slipped past the core's clamp.
    let b = player().output_brightness().clamp(0.0, 1.0);
    (b * 255.0 + 0.5) as u8
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
        // Auto hardware discovery (FUG-107): enumerate the qwiic bus, and
        // load/clear a sensor driver whose poll() feeds effect uniforms.
        Some(ARM_SCAN_I2C) => handle_scan_i2c(),
        Some(ARM_SUBMIT_DRIVER) => handle_submit_driver(frame),
        Some(ARM_REMOVE_DRIVER) => handle_remove_driver(),
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

/// Drop the resident topology (geometry + sim + per-LED cache). The geometry
/// borrows the arena, so this must run before the arena is reset.
unsafe fn reset_topo_cache() {
    *addr_of_mut!(GEOM) = None;
    *addr_of_mut!(SIM) = None;
    for e in (*addr_of_mut!(FX_LED_TOPO)).iter_mut() {
        *e = FxLedTopo::NONE;
    }
    FX_TOPO_READY = false;
}

/// A map upload STREAMS each LED's position into FX_LED_POS (never a resident
/// StoredMap) and replaces the topology (meaningless against a different solve).
unsafe fn handle_map_upload<R: PbRead<Error = Infallible>>(
    reader: R,
    total: usize,
) -> pb::ServerMessage {
    *addr_of_mut!(MAP_META) = None;
    reset_topo_cache();
    FX_UV_READY = false; // positions changed → uv bounds stale
    let res = decode_submit_map_streamed(reader, total, |idx, _led_count, led| {
        if (idx as usize) < FX_TOPO_CAP {
            (*addr_of_mut!(FX_LED_POS))[idx as usize] = led.xyz;
        }
        // LEDs past the render cap simply aren't stored (the strip can't drive
        // them); the decode still validates the whole frame.
        Ok(())
    });
    match res {
        Ok((map_id, led_count)) => {
            let reply = player().map_stored(map_id.as_str());
            *addr_of_mut!(MAP_META) = Some((map_id, led_count));
            reply
        }
        Err(e) => upload_error(e),
    }
}

/// A topology upload STREAMS the per-LED associations into FX_LED_TOPO (seg holds
/// the raw segment_id until the first render frame resolves it to a segment
/// index) and keeps only the small per-segment geometry resident in the arena.
/// A failed / rejected decode rolls the whole thing back.
unsafe fn handle_topology_upload<R: PbRead<Error = Infallible>>(
    reader: R,
    total: usize,
) -> pb::ServerMessage {
    reset_topo_cache();
    arena_mut().reset();
    let res = decode_submit_topology_streamed(reader, total, arena_ref(), |a: &StoredAssociation| {
        let i = a.led_id as usize;
        if i < FX_TOPO_CAP && a.segment_id <= i16::MAX as u32 {
            (*addr_of_mut!(FX_LED_TOPO))[i] = FxLedTopo {
                seg: a.segment_id as i16, // TEMP raw id; resolved in fx_rebuild_topo
                s: 0.0,
                branch: false,
                dist: 0.0,
                foot: a.foot_arclength,
                dperp: a.d_perp,
            };
        }
        Ok(())
    });
    match res {
        Ok(geom) => {
            let reply = player().topology_stored(geom.map_id.as_str());
            if matches!(reply.r#msg, Some(pb::ServerMessage_::Msg::ResultReady(_))) {
                *addr_of_mut!(GEOM) = Some(geom); // FX_TOPO_READY stays false → resolved next frame
            } else {
                drop(geom);
                reset_topo_cache();
                arena_mut().reset();
            }
            reply
        }
        Err(e) => {
            reset_topo_cache();
            arena_mut().reset();
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
    let Some((map_id, led_count)) = (*addr_of!(MAP_META)).as_ref().map(|(id, c)| (id.clone(), *c))
    else {
        return dump_error("no_map", "no stored map to dump");
    };
    // Resolve the per-LED cache so FX_LED_TOPO.seg is the segment INDEX (not the
    // raw upload id); cheap after the first frame.
    fx_rebuild_topo();
    // Reconstruct the bundle from the resident caches (see dump::*_src): id == map
    // index, xyz from FX_LED_POS, associations recovered from FX_LED_TOPO with the
    // segment_id read back out of the geometry.
    let led = |i: u32| -> (u32, [f32; 3]) { (i, (*addr_of!(FX_LED_POS))[i as usize]) };
    let geom = (*addr_of!(GEOM)).as_ref();
    let assoc_each = |f: &mut dyn FnMut(u32, u32, f32, f32)| {
        if let Some(g) = geom {
            let n = (led_count as usize).min(FX_TOPO_CAP);
            for i in 0..n {
                let e = &(*addr_of!(FX_LED_TOPO))[i];
                if e.seg >= 0 && (e.seg as usize) < g.segments.len() {
                    f(i as u32, g.segments[e.seg as usize].id, e.foot, e.dperp);
                }
            }
        }
    };
    let tsrc = geom.map(|g| dump::TopoSrc {
        map_id: g.map_id.as_str(),
        branch_points: g.branch_points,
        segments: g.segments,
        assoc_each: &assoc_each,
    });
    let total = dump::bundle_len_src(map_id.as_str(), led_count, &led, tsrc.as_ref());
    // Bound the chunk by the reply field capacity (StoredMapChunk.data).
    let cap = max_len.min(1024);
    let mut chunk = [0u8; 1024];
    let n = if offset < total {
        dump::encode_bundle_window_src(
            map_id.as_str(),
            led_count,
            &led,
            tsrc.as_ref(),
            offset,
            &mut chunk[..cap],
        )
    } else {
        0
    };
    let mut m = pb::StoredMapChunk::default();
    m.r#total_len = total as i32;
    m.r#offset = offset as i32;
    let _ = m.r#data.extend_from_slice(&chunk[..n]);
    m.r#has_topology = geom.is_some();
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
/// Auto hardware discovery arms (FUG-107).
const ARM_SCAN_I2C: u32 = 32;
const ARM_SUBMIT_DRIVER: u32 = 33;
const ARM_REMOVE_DRIVER: u32 = 34;

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

// SetTexture.format values (mirror the .proto / web encoder / td_ledmapper).
const TEX_RGB888: u64 = 0;
const TEX_RGB565: u64 = 1;
const TEX_RGB332: u64 = 2;
const TEX_GRAY8: u64 = 3;
const TEX_INDEXED8: u64 = 4;
const TEX_GRAY4: u64 = 5; // 4 bits/texel, 2 texels/byte (low nibble = even texel)
const TEX_MONO: u64 = 6; // 1 bit/texel, 8 texels/byte (bit i&7 = texel i, LSB first)
const TEX_PAL_MAX: usize = 256;

/// Packed length in bytes of a frame of `n` texels. Sub-byte formats round up
/// (matches the host `Format::packed_len` and the web codec).
fn tex_packed_len(format: u64, n: usize) -> usize {
    match format {
        TEX_RGB888 => n * 3,
        TEX_RGB565 => n * 2,
        TEX_GRAY4 => n.div_ceil(2),
        TEX_MONO => n.div_ceil(8),
        _ => n, // RGB332 / GRAY8 / INDEXED8
    }
}

/// The packed bytes an 8-bit channel value (`i`, meaning colour `i/255`) stores
/// as for component precision `comp` — for every byte value, cached and rebuilt
/// only when `comp` changes (a texture's comp is fixed per effect). The C6 has no
/// FPU, so decoding a texture channel via this table (a load + copy) instead of a
/// per-texel software-float dequant+requantize is the streaming decoder's biggest
/// per-texel win. Works for ANY comp — f32 OR a narrow fixed8/fixed16 arena — so
/// a `texture … : fixed8` decodes with zero per-texel float too. Serves
/// gray8/rgb888 directly and gray4/mono by scaling their level onto the 0..255
/// index. Each entry holds up to 4 bytes; callers copy `comp_bytes(comp)` of it.
fn tex_comp_lut8(comp: u8) -> &'static [[u8; 4]; 256] {
    static mut LUT: [[u8; 4]; 256] = [[0; 4]; 256];
    static mut BUILT_FOR: i32 = -1;
    unsafe {
        if BUILT_FOR != comp as i32 {
            let cb = ledmapper_fx_vm::comp_bytes(comp);
            let mut i = 0usize;
            while i < 256 {
                let mut b = [0u8; 4];
                ledmapper_fx_vm::comp_store_num(comp, i as f32 / 255.0, &mut b[..cb]);
                LUT[i] = b;
                i += 1;
            }
            BUILT_FOR = comp as i32;
        }
        &*addr_of!(LUT)
    }
}

/// Dequantize texel `t` from the packed `prev` buffer to linear RGB in 0..1.
/// `palette` (0x00RRGGBB entries) is used only for INDEXED8. Grayscale formats
/// return `(g, g, g)`. Used by the general (non-f32-arena) store path; the f32
/// fast path in `handle_set_texture` bypasses this with byte-LUTs.
#[inline]
fn dequant_at(prev: &[u8], t: usize, format: u64, palette: &[u32]) -> (f32, f32, f32) {
    match format {
        TEX_RGB888 => {
            let o = t * 3;
            (prev[o] as f32 / 255.0, prev[o + 1] as f32 / 255.0, prev[o + 2] as f32 / 255.0)
        }
        TEX_RGB565 => {
            let o = t * 2;
            let v = (prev[o] as u16) | ((prev[o + 1] as u16) << 8); // little-endian
            (
                ((v >> 11) & 0x1f) as f32 / 31.0,
                ((v >> 5) & 0x3f) as f32 / 63.0,
                (v & 0x1f) as f32 / 31.0,
            )
        }
        TEX_RGB332 => {
            let v = prev[t];
            (((v >> 5) & 7) as f32 / 7.0, ((v >> 2) & 7) as f32 / 7.0, (v & 3) as f32 / 3.0)
        }
        TEX_INDEXED8 => {
            let v = palette.get(prev[t] as usize).copied().unwrap_or(0);
            (
                ((v >> 16) & 0xff) as f32 / 255.0,
                ((v >> 8) & 0xff) as f32 / 255.0,
                (v & 0xff) as f32 / 255.0,
            )
        }
        TEX_GRAY4 => {
            let byte = prev[t >> 1];
            let nib = if t & 1 == 0 { byte & 0x0f } else { byte >> 4 };
            let g = nib as f32 * (1.0 / 15.0);
            (g, g, g)
        }
        TEX_MONO => {
            let g = ((prev[t >> 3] >> (t & 7)) & 1) as f32;
            (g, g, g)
        }
        _ => {
            let g = prev[t] as f32 / 255.0; // GRAY8
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
    let n_texels = (width * height) as usize;
    let total = tex_packed_len(format, n_texels);
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
    let comp = d.comp;
    // Hoist the arena bounds check out of the hot loop: every texel writes within
    // [base, base + n_texels*eb), so validate that span once, then write unchecked
    // per texel (this is the streaming decode's inner loop, run w*h times/frame).
    let end = base + n_texels * eb;
    if eb == 0 || end > arena.len() {
        return;
    }
    let gray = matches!(format, TEX_GRAY8 | TEX_GRAY4 | TEX_MONO);
    let chans = elem.min(4);

    // Fast path (any comp): precompute each channel level's packed `cb` bytes ONCE
    // and copy it per texel — no per-texel software-float on the FPU-less C6. The
    // LUTs are built with `comp_store_num`, so this is byte-identical to the
    // general path below for EVERY component precision, including a narrow
    // `: fixed8`/`: fixed16` arena (which decodes with zero per-texel float too).
    // Skips INDEXED8 (palette) and colour-into-scalar (needs a luma dot product).
    let lut_fast = (elem != 1 || gray)
        && matches!(
            format,
            TEX_GRAY8 | TEX_GRAY4 | TEX_MONO | TEX_RGB888 | TEX_RGB565 | TEX_RGB332
        );
    if lut_fast {
        let lut8 = tex_comp_lut8(comp); // 8-bit-channel levels -> packed `cb` bytes
        let mut alpha = [0u8; 4];
        ledmapper_fx_vm::comp_store_num(comp, 1.0, &mut alpha[..cb]);
        // Reduced-bit colour channels get their own small tables (built once per
        // frame via comp_store_num; only the active format's are populated).
        let mut l31 = [[0u8; 4]; 32];
        let mut l63 = [[0u8; 4]; 64];
        let mut l7 = [[0u8; 4]; 8];
        let mut l3 = [[0u8; 4]; 4];
        let build = |lut: &mut [[u8; 4]], denom: f32| {
            for (i, e) in lut.iter_mut().enumerate() {
                ledmapper_fx_vm::comp_store_num(comp, i as f32 / denom, &mut e[..cb]);
            }
        };
        match format {
            TEX_RGB565 => {
                build(&mut l31, 31.0);
                build(&mut l63, 63.0);
            }
            TEX_RGB332 => {
                build(&mut l7, 7.0);
                build(&mut l3, 3.0);
            }
            _ => {}
        }
        for t in 0..n_texels {
            let ab = base + t * eb;
            let (rb, gb, bb): (&[u8; 4], &[u8; 4], &[u8; 4]) = match format {
                TEX_GRAY4 => {
                    let byte = prev[t >> 1];
                    let nib = if t & 1 == 0 { byte & 0x0f } else { byte >> 4 };
                    let p = &lut8[nib as usize * 17]; // nib/15 == (nib*17)/255
                    (p, p, p)
                }
                TEX_MONO => {
                    let p = &lut8[((prev[t >> 3] >> (t & 7)) & 1) as usize * 255];
                    (p, p, p)
                }
                TEX_RGB888 => {
                    let o = t * 3;
                    (&lut8[prev[o] as usize], &lut8[prev[o + 1] as usize], &lut8[prev[o + 2] as usize])
                }
                TEX_RGB565 => {
                    let o = t * 2;
                    let v = (prev[o] as u16) | ((prev[o + 1] as u16) << 8);
                    (
                        &l31[((v >> 11) & 0x1f) as usize],
                        &l63[((v >> 5) & 0x3f) as usize],
                        &l31[(v & 0x1f) as usize],
                    )
                }
                TEX_RGB332 => {
                    let v = prev[t];
                    (&l7[((v >> 5) & 7) as usize], &l7[((v >> 2) & 7) as usize], &l3[(v & 3) as usize])
                }
                _ => {
                    let p = &lut8[prev[t] as usize]; // GRAY8
                    (p, p, p)
                }
            };
            for k in 0..chans {
                let o = ab + k * cb;
                let src: &[u8; 4] = match k {
                    0 => rb,
                    1 => gb,
                    2 => bb,
                    _ => &alpha,
                };
                arena.get_unchecked_mut(o..o + cb).copy_from_slice(&src[..cb]);
            }
        }
        return;
    }

    // General path: any component precision. `comp_store_num` quantizes each float
    // channel to the arena's storage precision.
    // A vec4 texture's 4th channel is a constant 1.0 — quantize it once.
    let mut alpha = [0u8; 4];
    ledmapper_fx_vm::comp_store_num(comp, 1.0, &mut alpha[..cb]);
    for t in 0..n_texels {
        let (r, g, b) = dequant_at(prev, t, format, &palette);
        let ab = base + t * eb;
        if elem == 1 {
            // Scalar texture stores the luma; a grayscale source already carries
            // it (r==g==b==g), so skip the Rec.601 dot product there.
            let luma = if gray { g } else { 0.299 * r + 0.587 * g + 0.114 * b };
            ledmapper_fx_vm::comp_store_num(comp, luma, arena.get_unchecked_mut(ab..ab + cb));
        } else if gray {
            // Grayscale: all colour channels are equal, so quantize once and
            // replicate the packed bytes; the alpha channel is the const stamp.
            let mut stamp = [0u8; 4];
            ledmapper_fx_vm::comp_store_num(comp, g, &mut stamp[..cb]);
            for k in 0..chans {
                let o = ab + k * cb;
                let src = if k < 3 { &stamp[..cb] } else { &alpha[..cb] };
                arena.get_unchecked_mut(o..o + cb).copy_from_slice(src);
            }
        } else {
            let ch = [r, g, b, 1.0];
            for k in 0..chans {
                let o = ab + k * cb;
                ledmapper_fx_vm::comp_store_num(comp, ch[k], arena.get_unchecked_mut(o..o + cb));
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
    // Advertise the declared 2D textures (buffer kind=1) so a texture source
    // can learn the exact dimensions set_texture requires — a mismatch is
    // silently dropped, so without this a client is left guessing.
    for i in 0..prog.n_buffers as usize {
        if m.r#textures.len() >= m.r#textures.capacity() {
            break;
        }
        if let Some(d) = prog.buf_desc(i) {
            if d.kind == 1 {
                let mut t = pb::TexturePort::default();
                t.r#index = i as u32;
                t.r#width = d.w as u32;
                t.r#height = d.h as u32;
                t.r#elem = d.elem as u32;
                let _ = m.r#textures.push(t);
            }
        }
    }
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::EffectUniforms(m)) }
}

fn fx_error(code: &str, message: &str) -> pb::ServerMessage {
    let mut e = pb::Error::default();
    let _ = e.r#code.push_str(code);
    let _ = e.r#message.push_str(message);
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::Error(e)) }
}

// -- sensor drivers / auto hardware discovery (FUG-107) -----------------------
// A sensor driver is a `.fxb` with a `poll()` entry that reads a qwiic module
// over I2C and writes `export`s. It runs in its OWN fx_vm instance, off the
// render loop, every `DRV_INTERVAL_MS`; each poll's export values are copied
// into the active effect's uniforms per the app-supplied bindings — the same
// slot path set_uniforms uses, so a live sensor drives an effect exactly like a
// slider does. The C++ side owns the qwiic bus and provides the lm_i2c_* hooks.

/// Max driver `.fxb` held. A driver is tiny (a few reads + arithmetic → a few
/// hundred bytes of bytecode), so 1 KiB is generous — kept tight because this is
/// static .bss out of the same pool the TLS handshake's record buffer needs (see
/// the FX/arena sizing notes above). submit_driver rejects a larger upload.
const DRV_MAX_BYTES: usize = 1024;
static mut DRV_BYTES: [u8; DRV_MAX_BYTES] = [0; DRV_MAX_BYTES];
static mut DRV_LEN: usize = 0;
static mut DRV_VM: Option<FxVm> = None;
/// Whether the driver is actively polling.
static mut DRV_RUNNING: bool = false;
/// poll() cadence in ms (clamped to a sane floor on load).
static mut DRV_INTERVAL_MS: u32 = 100;
/// Monotonic ms of the last poll (0 = never), so lm_drv_poll self-paces.
static mut DRV_LAST_POLL_MS: i64 = 0;
/// Last poll outcome: 0=Ok 1=Budget 2=Timeout 3=never-run.
static mut DRV_LAST_OUTCOME: u32 = 3;
/// n_state slots the driver declares (reported to the app as export_count).
static mut DRV_STATE_SLOTS: u32 = 0;

/// One export→uniform binding. Slots are u8 (the VM's slot space is < 256).
#[derive(Clone, Copy, Default)]
struct DrvBinding {
    export_slot: u8,
    width: u8,
    uniform_slot: u8,
}
const DRV_MAX_BINDINGS: usize = 32;
static mut DRV_BINDINGS: [DrvBinding; DRV_MAX_BINDINGS] =
    [DrvBinding { export_slot: 0, width: 0, uniform_slot: 0 }; DRV_MAX_BINDINGS];
static mut DRV_N_BINDINGS: usize = 0;

extern "C" {
    /// Write `n` bytes to 7-bit `addr` on the qwiic bus. True on ACK.
    fn lm_i2c_write(addr: u8, bytes: *const u8, n: usize) -> bool;
    /// Read `n` bytes from 7-bit `addr` after writing register pointer `reg`.
    fn lm_i2c_read(addr: u8, reg: u8, out: *mut u8, n: usize) -> bool;
    /// Probe 0x08..0x77; write the ACKing 7-bit addresses into `out` (up to
    /// `cap`), returning the count.
    fn lm_i2c_scan(out: *mut u8, cap: usize) -> usize;
}

/// [`I2cBus`] backed by the C++ qwiic hooks. Zero-sized; one per poll call.
struct FfiI2c;
impl I2cBus for FfiI2c {
    fn write(&mut self, addr: u8, bytes: &[u8]) -> bool {
        unsafe { lm_i2c_write(addr, bytes.as_ptr(), bytes.len()) }
    }
    fn read_reg(&mut self, addr: u8, reg: u8, out: &mut [u8]) -> bool {
        unsafe { lm_i2c_read(addr, reg, out.as_mut_ptr(), out.len()) }
    }
}

/// scan_i2c: probe the bus and reply with the responding addresses.
unsafe fn handle_scan_i2c() -> pb::ServerMessage {
    let mut buf = [0u8; 128];
    let n = lm_i2c_scan(buf.as_mut_ptr(), buf.len()).min(buf.len());
    let mut r = pb::I2cScanResult::default();
    for &a in &buf[..n] {
        let _ = r.r#addresses.push(a as u32);
    }
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::I2CScanResult(r)) }
}

/// The current driver runtime status (reply to submit_driver / remove_driver).
unsafe fn driver_state_reply() -> pb::ServerMessage {
    let mut ds = pb::DriverState::default();
    ds.r#running = DRV_RUNNING && DRV_LEN > 0;
    ds.r#poll_interval_ms = DRV_INTERVAL_MS;
    ds.r#export_count = DRV_STATE_SLOTS;
    ds.r#binding_count = DRV_N_BINDINGS as u32;
    let _ = ds.r#last_poll.push_str(match DRV_LAST_OUTCOME {
        0 => "ok",
        1 => "budget",
        2 => "timeout",
        _ => "",
    });
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::DriverState(ds)) }
}

/// Parse one DriverBinding submessage (`export_slot` f1, `width` f2,
/// `uniform_slot` f3 — all varint). Best-effort: unknown fields are skipped.
fn parse_binding(sub: &[u8]) -> DrvBinding {
    let mut b = DrvBinding::default();
    let mut p = 0;
    while p < sub.len() {
        let Some(key) = rd_varint(sub, &mut p) else { break };
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        match (field, wire) {
            (1, 0) => match rd_varint(sub, &mut p) {
                Some(v) => b.export_slot = v as u8,
                None => break,
            },
            (2, 0) => match rd_varint(sub, &mut p) {
                Some(v) => b.width = v as u8,
                None => break,
            },
            (3, 0) => match rd_varint(sub, &mut p) {
                Some(v) => b.uniform_slot = v as u8,
                None => break,
            },
            _ => {
                if !skip_field(sub, &mut p, wire) {
                    break;
                }
            }
        }
    }
    b
}

/// submit_driver: hand-walk fxb (f1) / poll_interval_ms (f2) / bindings (f3,
/// repeated message) / activate (f4), like handle_submit_effect (the firmware
/// micropb profile caps the generated fields). Load the driver VM and, if
/// `activate`, start polling. Reply driver_state, or error (bad_fxb /
/// driver_too_large / no_poll).
unsafe fn handle_submit_driver(frame: &[u8]) -> pb::ServerMessage {
    let Some(body) = unwrap_arm(frame, ARM_SUBMIT_DRIVER) else {
        return fx_error("bad_fxb", "submit_driver is malformed");
    };
    let mut fxb: Option<&[u8]> = None;
    let mut interval: u32 = 100;
    let mut activate = false;
    let mut binds: [DrvBinding; DRV_MAX_BINDINGS] = [DrvBinding::default(); DRV_MAX_BINDINGS];
    let mut nb = 0usize;
    let mut o = 0;
    while o < body.len() {
        let Some(key) = rd_varint(body, &mut o) else {
            return fx_error("bad_fxb", "submit_driver is malformed");
        };
        let field = (key >> 3) as u32;
        let wire = (key & 7) as u8;
        match (field, wire) {
            (1, 2) => {
                let Some(len) = rd_varint(body, &mut o) else {
                    return fx_error("bad_fxb", "submit_driver is malformed");
                };
                let len = len as usize;
                let Some(s) = body.get(o..o + len) else {
                    return fx_error("bad_fxb", "submit_driver is malformed");
                };
                fxb = Some(s);
                o += len;
            }
            (2, 0) => {
                let Some(v) = rd_varint(body, &mut o) else {
                    return fx_error("bad_fxb", "submit_driver is malformed");
                };
                interval = v as u32;
            }
            (3, 2) => {
                let Some(len) = rd_varint(body, &mut o) else {
                    return fx_error("bad_fxb", "submit_driver is malformed");
                };
                let len = len as usize;
                let Some(sub) = body.get(o..o + len) else {
                    return fx_error("bad_fxb", "submit_driver is malformed");
                };
                o += len;
                if nb < DRV_MAX_BINDINGS {
                    binds[nb] = parse_binding(sub);
                    nb += 1;
                }
            }
            (4, 0) => {
                let Some(v) = rd_varint(body, &mut o) else {
                    return fx_error("bad_fxb", "submit_driver is malformed");
                };
                activate = v != 0;
            }
            _ => {
                if !skip_field(body, &mut o, wire) {
                    return fx_error("bad_fxb", "submit_driver is malformed");
                }
            }
        }
    }
    let Some(fxb) = fxb else {
        return fx_error("bad_fxb", "submit_driver without fxb");
    };
    if fxb.len() > DRV_MAX_BYTES {
        return fx_error("driver_too_large", "fxb exceeds this player's driver buffer");
    }
    let Ok(prog) = Program::parse(fxb) else {
        return fx_error("bad_fxb", "fxb failed to parse");
    };
    if prog.poll_entry == NO_ENTRY {
        return fx_error("no_poll", "driver .fxb has no poll() entry");
    }
    let buf = &mut *addr_of_mut!(DRV_BYTES);
    buf[..fxb.len()].copy_from_slice(fxb);
    DRV_LEN = fxb.len();
    DRV_STATE_SLOTS = prog.n_state as u32;
    *addr_of_mut!(DRV_VM) = Some(FxVm::new());
    DRV_INTERVAL_MS = interval.max(10); // floor: never busy-poll the bus
    let dst = &mut *addr_of_mut!(DRV_BINDINGS);
    dst[..nb].copy_from_slice(&binds[..nb]);
    DRV_N_BINDINGS = nb;
    DRV_LAST_OUTCOME = 3;
    DRV_LAST_POLL_MS = 0;
    DRV_RUNNING = activate;
    driver_state_reply()
}

/// remove_driver: stop polling and clear the driver.
unsafe fn handle_remove_driver() -> pb::ServerMessage {
    DRV_LEN = 0;
    DRV_RUNNING = false;
    *addr_of_mut!(DRV_VM) = None;
    DRV_N_BINDINGS = 0;
    DRV_STATE_SLOTS = 0;
    DRV_LAST_OUTCOME = 3;
    driver_state_reply()
}

/// Run the driver's poll() if it's due (self-paced against `now_ms`), then copy
/// its exports into the active effect's uniforms per the bindings. The C++
/// render/service loop calls this every iteration under `player_mutex`; it's a
/// cheap early-return when no driver is running or the interval hasn't elapsed.
/// Returns true iff poll() actually ran this call.
///
/// # Safety
/// Single-threaded like the rest of this module (called under player_mutex).
#[no_mangle]
pub unsafe extern "C" fn lm_drv_poll(now_ms: i64) -> bool {
    if !DRV_RUNNING || DRV_LEN == 0 {
        return false;
    }
    if DRV_LAST_POLL_MS != 0 && now_ms.wrapping_sub(DRV_LAST_POLL_MS) < DRV_INTERVAL_MS as i64 {
        return false; // not due yet
    }
    DRV_LAST_POLL_MS = now_ms;
    let bytes = &(*addr_of!(DRV_BYTES))[..DRV_LEN];
    let Ok(prog) = Program::parse(bytes) else {
        return false;
    };
    let f = FxFrame { time: now_ms as f32 / 1000.0, ..Default::default() };
    let mut bus = FfiI2c;
    let outcome = {
        let Some(vm) = (*addr_of_mut!(DRV_VM)).as_mut() else {
            return false;
        };
        vm.run_poll(&prog, &f, &mut bus, &Budget::instructions(ledmapper_fx_vm::DEFAULT_BUDGET))
    };
    DRV_LAST_OUTCOME = outcome as u32;
    // Bridge exports → active effect uniforms (same path as set_uniforms).
    if let Some(dvm) = (*addr_of!(DRV_VM)).as_ref() {
        let n = DRV_N_BINDINGS;
        for b in &(*addr_of!(DRV_BINDINGS))[..n] {
            let w = (b.width as usize).clamp(1, 4);
            let mut vals = [0.0f32; 4];
            dvm.export(b.export_slot as usize, &mut vals[..w]);
            lm_fx_set_uniform(b.uniform_slot as u32, vals.as_ptr(), w);
        }
    }
    true
}

/// Whether a driver is currently loaded + polling (persistence / diagnostics).
#[no_mangle]
pub unsafe extern "C" fn lm_drv_running() -> bool {
    DRV_RUNNING && DRV_LEN > 0
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
    // The per-LED topology cache backs lm_playback_color (O(1) reads); build it
    // here too (not just on the fx path) so pulse/flood playback has it fresh.
    // Cheap: early-returns unless a map/topology upload invalidated it.
    fx_rebuild_topo();
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
    let Some(topo) = (*addr_of!(GEOM)).as_ref() else {
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
    // O(1): the per-LED cache (built in lm_playback_step) already holds this LED's
    // segment index + foot arclength + perpendicular offset — no per-frame scan of
    // the associations/segments. seg is the sim segment index (see ensure_sim).
    let i = led as usize;
    if i >= FX_TOPO_CAP {
        return false;
    }
    let e = &(*addr_of!(FX_LED_TOPO))[i];
    if e.seg < 0 || e.seg as usize >= MAX_SEGMENTS {
        return false;
    }
    let s_mm = (e.foot * 1000.0) as u32;
    let d_perp_mm = (e.dperp * 1000.0) as u32;
    let (r, g, b) = sim.led_color(e.seg as u16, s_mm, d_perp_mm);
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

/// Highest LED the latched counting pattern lights + 1 (0 when none). The frame
/// loop transmits exactly this many LEDs for the calibration pattern.
#[no_mangle]
pub unsafe extern "C" fn lm_counting_len() -> u32 {
    player().counting_len()
}

/// The persisted strip length for `channel` (set_led_count); -1 when unset.
#[no_mangle]
pub unsafe extern "C" fn lm_led_count(channel: u32) -> i32 {
    match player().led_count(channel as usize) {
        Some(n) => n as i32,
        None => -1,
    }
}

/// Number of LEDs in the stored map; 0 when none stored.
#[no_mangle]
pub unsafe extern "C" fn lm_map_len() -> u32 {
    (*addr_of!(MAP_META)).as_ref().map_or(0, |(_, c)| *c)
}

/// The stored map entry at `index`: id + xyz (meters). The map is flash-backed —
/// only positions are resident (FX_LED_POS); id == index (the render is
/// index-based). False out of range.
#[no_mangle]
pub unsafe extern "C" fn lm_map_led(index: u32, id: *mut u32, xyz: *mut f32) -> bool {
    let len = (*addr_of!(MAP_META)).as_ref().map_or(0, |(_, c)| *c);
    let i = index as usize;
    if index >= len || i >= FX_TOPO_CAP {
        return false;
    }
    let pos = (*addr_of!(FX_LED_POS))[i];
    *id = index;
    *xyz = pos[0];
    *xyz.add(1) = pos[1];
    *xyz.add(2) = pos[2];
    true
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
    // UV bounds for led.uv — map-derived (independent of topology). Gated by its
    // OWN flag so a topology upload doesn't recompute it and, crucially, a map
    // upload doesn't re-trigger the topology resolve below.
    if !FX_UV_READY {
        FX_UV_READY = true;
        let len = (*addr_of!(MAP_META))
            .as_ref()
            .map_or(0, |(_, c)| *c as usize)
            .min(FX_TOPO_CAP);
        let mut mn = [f32::INFINITY; 2];
        let mut mx = [f32::NEG_INFINITY; 2];
        for p in (*addr_of!(FX_LED_POS)).iter().take(len) {
            for k in 0..2 {
                mn[k] = mn[k].min(p[k]);
                mx[k] = mx[k].max(p[k]);
            }
        }
        for k in 0..2 {
            let range = mx[k] - mn[k];
            FX_UV_MIN[k] = if range.is_finite() { mn[k] } else { 0.0 };
            FX_UV_INV[k] = if range > 1e-6 { 1.0 / range } else { 0.0 };
        }
    }
    // The per-LED topology resolve: the streaming upload sink filled FX_LED_TOPO
    // with each LED's RAW segment_id (in `seg`) + foot/dperp; here we resolve seg
    // to a segment INDEX and derive s/branch/dist from the resident geometry.
    // Gated so it runs exactly once per topology upload — seg holds the id only
    // until this resolves it in place.
    if FX_TOPO_READY {
        return;
    }
    FX_TOPO_READY = true;
    let Some(topo) = (*addr_of!(GEOM)).as_ref() else {
        // No topology stored — clear any stale association entries.
        for e in (*addr_of_mut!(FX_LED_TOPO)).iter_mut() {
            *e = FxLedTopo::NONE;
        }
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

    // Resolve each sink-filled entry in place: `seg` currently holds the raw
    // segment_id → map it to the segment INDEX (== sim segment index), and derive
    // s/branch/dist. foot/dperp are kept. O(associations × segments), once per
    // upload — and lm_playback_color/shade are then O(1) reads per frame.
    let cache = &mut *addr_of_mut!(FX_LED_TOPO);
    let mut max_geo = 0.0f32;
    for e in cache.iter_mut() {
        if e.seg < 0 {
            continue; // no association
        }
        let seg_id = e.seg as u32; // TEMP raw id from the streaming sink
        let foot = e.foot;
        let Some(seg_idx) = topo.segments.iter().position(|s| s.id == seg_id) else {
            *e = FxLedTopo::NONE; // dangling association
            continue;
        };
        let seg = &topo.segments[seg_idx];
        let s_norm = if seg.length > 1e-6 { (foot / seg.length).clamp(0.0, 1.0) } else { 0.0 };
        // Near endpoint a (s≈0) or b (s≈1) AND that endpoint is a real junction.
        let near_a = foot <= FX_BRANCH_DIST_M;
        let near_b = (seg.length - foot) <= FX_BRANCH_DIST_M;
        let branch = (near_a && is_junction(seg.a)) || (near_b && is_junction(seg.b));
        let geo = if seg_idx < n_seg {
            let da = node_dist[node_of(seg_idx, 0)];
            let db = node_dist[node_of(seg_idx, 1)];
            let g = (da + foot).min(db + (seg.length - foot));
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
        e.seg = seg_idx as i16; // resolve id → index
        e.s = s_norm;
        e.branch = branch;
        e.dist = geo;
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
    let Ok(prog) = Program::parse(src) else {
        return false;
    };
    // Build the OSC name->slot table for the fresh effect (once, off the render
    // path) and clear the per-slot value shadow so no stale vector component
    // leaks across a hot-reload.
    *addr_of_mut!(OSC_TABLE) = osc::parse_manifest(prog.manifest);
    (*addr_of_mut!(OSC_SHADOW)).reset();
    // Only build the per-LED fixed context mirrors on the hot path when the
    // program actually reads them (FUG-122) — an all-float effect pays nothing.
    FX_USES_CTXFIX = prog.uses_ctxfix();
    // Likewise skip the per-LED soft-float uv projection unless led.uv is read.
    FX_USES_UV = prog.uses_uv();
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
    // FUG-125: build the on-device JIT for this effect (patches JitCall into the
    // resident FX_BYTES + installs the segment table on the VM). Re-parse from
    // FX_BYTES so the patched offsets + JIT code slice point at the resident copy.
    if let Some(vm) = (*addr_of_mut!(FX_VM)).as_mut() {
        if let Ok(resident) = Program::parse(&(*addr_of!(FX_BYTES))[..len]) {
            fx_build_jit(&resident, vm);
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
    *addr_of_mut!(OSC_TABLE) = PortTable::empty();
    (*addr_of_mut!(OSC_SHADOW)).reset();
    // Drop the JIT table (the exec region is a fixed static, reused on next load;
    // FX_VM was just cleared above, so the installed table goes with it).
    FX_JIT_N = 0;
    perf_reset_ring();
}

/// Enable/disable the on-device JIT (FUG-125). Takes effect on the NEXT
/// `lm_fx_load`; the caller reloads the effect to rebuild (or tear down) the
/// segments — the HITL A/B flips this and re-submits to measure JIT on vs off.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_jit_enabled(enabled: bool) {
    FX_JIT_ENABLED = enabled;
}

/// How many JIT segments the current effect installed (0 = pure interpretation).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_jit_count() -> u32 {
    FX_JIT_N as u32
}

/// JIT bring-up diagnostics (FUG-125): `*plans` = blocks the planner found,
/// `*words` = total RV32 words, `*alloc_ok` = 1 if the exec alloc succeeded.
/// Lets a bench attribute a segments=0 outcome (no hot blocks vs no exec IRAM).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_jit_diag(plans: *mut u32, words: *mut u32, alloc_ok: *mut u32) {
    if !plans.is_null() {
        *plans = FX_JIT_DIAG_PLANS;
    }
    if !words.is_null() {
        *words = FX_JIT_DIAG_WORDS;
    }
    if !alloc_ok.is_null() {
        *alloc_ok = FX_JIT_DIAG_ALLOC_OK;
    }
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

/// Select OSC addressing mode: `true` (default) resolves uniform names via the
/// active effect's manifest (falling back to slot index for unknown names);
/// `false` treats every address as a raw slot number. Exposed so the app / a
/// bench can A-B the name-lookup cost and so slot-only can be forced.
#[no_mangle]
pub unsafe extern "C" fn lm_osc_set_by_name(by_name: bool) {
    OSC_BY_NAME = by_name;
}

/// Ingest one OSC datagram and drive the active effect's uniforms from it.
/// Returns the number of uniform writes applied (0 if no effect is active, the
/// datagram isn't valid OSC, or nothing matched). Meant to be called from the
/// UDP receive task — it never blocks and never allocates.
///
/// # Safety
/// `data` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_osc_ingest(data: *const u8, len: usize) -> u32 {
    if data.is_null() || len == 0 || !lm_fx_active() {
        return 0;
    }
    let bytes = core::slice::from_raw_parts(data, len);
    let cfg = OscConfig { prefix: "/", by_name: OSC_BY_NAME };
    let table = &*addr_of!(OSC_TABLE);
    let shadow = &mut *addr_of_mut!(OSC_SHADOW);
    osc::ingest(bytes, &cfg, table, shadow, &mut |slot, vals| {
        if let Some(vm) = (*addr_of_mut!(FX_VM)).as_mut() {
            vm.set_uniform(slot as usize, vals);
        }
    }) as u32
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
        // Q16.16 mirrors for LoadCtxFix (computed once per frame, not per LED).
        time_fix: q16_16(time_s),
        dt_fix: q16_16(dt_s),
        ..Default::default()
    };
    // Capture the frame context so the per-LED shade() sweep sees the same
    // time/dt/frame (shaders animate off `time` in shade()).
    FX_F_TIME = time_s;
    FX_F_DT = dt_s;
    FX_F_FRAME = frame;
    FX_F_LEDS = led_count;
    // Convert the frame's fixed mirrors ONCE here (not per LED) so lm_fx_shade
    // just copies the ints — a fixed-only shader pays no per-LED soft-float, and
    // an all-float shader pays nothing at all (FUG-122).
    FX_F_TIME_FIX = q16_16(time_s);
    FX_F_DT_FIX = q16_16(dt_s);
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
    // &mut: run_shade now writes the VM's resident scratch (stack/locals) in
    // place instead of allocating per LED (FUG-122 framing hill-climb).
    let Some(vm) = (*addr_of_mut!(FX_VM)).as_mut() else {
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
        // Cheap int copies of the once-per-frame conversions — NO per-LED
        // soft-float (FUG-122; this was the fx_bench overhead regression).
        time_fix: FX_F_TIME_FIX,
        dt_fix: FX_F_DT_FIX,
        ..Default::default()
    };
    // Per-LED topology (led.seg / led.s / led.branch) from the cache the last
    // lm_fx_update refreshed. `idx` is the map index — exactly this cache's key.
    // No association (or no topology stored) → seg = -1, s = 0, branch = false.
    let t = (*addr_of!(FX_LED_TOPO)).get(idx as usize).copied().unwrap_or(FxLedTopo::NONE);
    // The uv projection is per-LED soft-float; skip it entirely unless the effect
    // reads led.uv (FUG-122) — a chunk of the framing floor for the many effects
    // that don't use it.
    let uv = if FX_USES_UV {
        [
            ((x - FX_UV_MIN[0]) * FX_UV_INV[0]).clamp(0.0, 1.0),
            ((y - FX_UV_MIN[1]) * FX_UV_INV[1]).clamp(0.0, 1.0),
        ]
    } else {
        [0.0, 0.0]
    };
    let mut led = FxLed {
        pos: [x, y, z],
        idx,
        seg: t.seg as i32,
        s: t.s,
        branch: t.branch,
        dist: t.dist,
        uv,
        ..Default::default()
    };
    // Fixed (Q16.16) mirrors read by LoadCtxFix — built ONLY when the loaded
    // effect actually reads them (FUG-122), so an all-float shader pays zero
    // per-LED overhead and the resident cache never grows. Positions come from
    // this frame's map fetch; uv/s/dist from the already-derived values.
    if FX_USES_CTXFIX {
        led.pos_fix = [q16_16(x), q16_16(y), q16_16(z)];
        led.uv_fix = [q16_16(uv[0]), q16_16(uv[1])];
        led.s_fix = q16_16(t.s);
        led.dist_fix = q16_16(t.dist);
    }
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
