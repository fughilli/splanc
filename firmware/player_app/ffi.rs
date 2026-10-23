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

// The OTA core's C ABI (ota_ffi.h) rides in this staticlib for the app's
// update hooks (ota_app.cpp): linked here, not referenced from Rust.
extern crate splanc_ota;

use core::convert::Infallible;
use core::ffi::c_void;
use core::ptr::{addr_of, addr_of_mut};

use core::sync::atomic::AtomicBool;

use ledmapper_arena::Arena;
use ledmapper_fps::{FpsController, MAX_FPS};
use ledmapper_fx_jit::{plan_blocks_into, PlanOut};
use ledmapper_fx_vm::{
    Budget, Counters as FxCounters, Frame as FxFrame, JitBlock, JitFn, Led as FxLed, Outcome,
    Program, Rgb as Rgb8, Vm as FxVm,
};
use ledmapper_keypoint::{self as kp, Morph};
use ledmapper_osc::{self as osc, Config as OscConfig, PortTable, Shadow};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player::{upload_malformed, upload_too_large, Player};
use ledmapper_view::ledmapper::v1 as pv;
use pv::client_message::Msg as CArm;
use ledmapper_store::{
    decode_submit_map_streamed, decode_submit_topology_streamed, dump, envelope_arm,
    parse_upload_chunk, BlockReader, StoreError, StoredAssociation, StoredTopoGeom,
    Str64, ARM_GET_STORED_MAP, ARM_SUBMIT_MAP, ARM_SUBMIT_TOPOLOGY,
};
use micropb::PbRead;

// Sensor core glue: lm_sensor_* C ABI, the seqlocked snapshot, get_sensors /
// calibrate_sensors (docs/design/sensor-core.md).
mod sensor_ffi;
pub use sensor_ffi::*;
// Named live values (sensor fusion outputs, driver exports) bound to effect
// uniforms by name (docs/design/sensor-core.md).
mod uniform_pool;
// The driver VM host (FUG-107): one `.fxb` I2C driver, exports into the pool.
mod driver_ffi;
pub use driver_ffi::*;

/// The frame's `ClientMessage` arm, read IN PLACE (pbview: no by-value
/// envelope, no capacity profile). None when the frame isn't a valid encoding.
fn client_arm(frame: &[u8]) -> Option<CArm<'_>> {
    pv::ClientMessageView::parse(frame).ok()?.msg()
}

/// The resident topology GEOMETRY: branch points, segments and their polyline
/// vertices. The per-LED map and associations never land here — they stream
/// straight into the per-LED caches below — so this doesn't scale with LED
/// count, only with the scan's shape. Reset wholesale per topology upload.
///
/// The decode is exact-size (two passes: count, then fill three exactly-sized
/// arrays), so a topology of J branch points, S segments and V polyline
/// vertices needs `16·J + 24·S + 12·V` bytes (+ ≤ 8 B alignment;
/// `ledmapper_store::TopoCounts::arena_bytes`). 12 KB fits e.g. J = 27,
/// S = 51, V = 206 (a 462-LED scan, ~4.1 KB) about 3x over. Beyond it, an
/// upload gets the bounded ArenaFull ("map_too_large"), never a crash.
const ARENA_BYTES: usize = 12 * 1024;

static mut ARENA_MEM: [u8; ARENA_BYTES] = [0; ARENA_BYTES];
static mut ARENA: Option<Arena<'static>> = None;
/// The stored map's id + LED count. The per-LED positions live in FX_LED_POS
/// (below), streamed in — the raw StoredMap is never resident.
static mut MAP_META: Option<(Str64, u32)> = None;
/// The resident topology geometry (branch points + segments); the per-LED
/// associations are folded into FX_LED_TOPO, not kept here. Borrows ARENA.
static mut GEOM: Option<StoredTopoGeom<'static>> = None;
static mut PLAYER: Option<Player> = None;


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

// -- FX decks (docs/design/uniform-keypoints.md) -----------------------------
// Two effects run at once — deck A (0) and deck B (1) — and lm_fx_shade blends
// their per-LED output by the global crossfade. Deck A is resident and is the
// only persisted deck (boot resumes it); the JIT and OSC are deck-A only. Deck B
// lives in FX_AUX, a union with the video-texture delta buffer: loading deck B
// evicts a video stream, and set_texture is dropped while deck B is loaded, so
// the two cost max(), not sum() (the mutex is explicit in the type).

const N_DECKS: usize = 2;
const DECK_A_IDX: usize = 0;
const DECK_B_IDX: usize = 1;

/// One deck's loaded effect: the `.fxb` and its parsed Program (cached at load),
/// its VM, which context mirrors it reads, its identity and its keypoint
/// blend state.
struct DeckState {
    bytes: [u8; FX_MAX_BYTES],
    len: usize,
    /// `bytes[..len]` parsed once at load (after the JIT patch), so the per-LED
    /// shade and per-frame update don't re-parse the header on every call. It
    /// borrows `bytes` (static storage): fx_load clears it before rewriting the
    /// bytes and fx_clear drops it.
    prog: Option<Program<'static>>,
    vm: Option<FxVm>,
    /// ACTIVE = the render loop drives it. An upload with `activate=false` parks
    /// the effect (loaded, validated) without taking over rendering.
    active: bool,
    /// Reads the per-LED fixed context cache (`LoadCtxFix`); all-float effects
    /// skip the per-LED fixed-mirror build entirely (FUG-122).
    uses_ctxfix: bool,
    /// Reads `led.uv` (else the per-LED soft-float uv projection is skipped).
    uses_uv: bool,
    /// Reads the room frame (`led.room`, `room.min/max`).
    uses_room: bool,
    /// effect_id of the submit that loaded it (keypoints are stored under it;
    /// deck A's also pins the PerfReport identity).
    id: [u8; 64],
    id_len: usize,
    /// Hash of the loaded `.fxb` (PerfReport identity, deck A).
    hash: u32,
    /// This deck's slice of FX_ARENA (deck A from the front, B from the back).
    arena_off: usize,
    arena_len: usize,
    /// Keypoint blend rules + cached sources + morph (ledmapper_keypoint).
    morph: Morph,
    /// Per-LED shade() scratch, reused across LEDs: fx_shade_one overwrites every
    /// field this deck's program can read (the base fields always, the fixed /
    /// room mirrors when `uses_ctxfix` / `uses_room` say so), so it needn't
    /// re-zero the struct per LED. Reset on load so no previous effect's values
    /// leak.
    shade_led: Option<FxLed>,
}

impl DeckState {
    const EMPTY: DeckState = DeckState {
        bytes: [0; FX_MAX_BYTES],
        len: 0,
        prog: None,
        vm: None,
        active: false,
        uses_ctxfix: false,
        uses_uv: false,
        uses_room: false,
        id: [0; 64],
        id_len: 0,
        hash: 0,
        arena_off: 0,
        arena_len: 0,
        morph: Morph::new(),
        shade_led: None,
    };

    fn loaded(&self) -> bool {
        self.len > 0 && self.vm.is_some()
    }

    fn renders(&self) -> bool {
        self.active && self.loaded()
    }

    fn effect_id(&self) -> &str {
        core::str::from_utf8(&self.id[..self.id_len]).unwrap_or("")
    }
}

static mut DECK_A: DeckState = DeckState::EMPTY;

// -- FUG-82: framerate autoscaler ----------------------------------------------
//
// The render loop measures every effect frame's cost (update + shade of BOTH
// decks + the crossfade blend, or the strip transmit if that is longer) and
// feeds it to one `FpsController` (//firmware/fps), which picks the target FPS
// on a 5-fps ladder (25..80) keeping 5% headroom, and asks for an abort when even
// the floor (or an app-pinned rate) can't hold. The search restarts whenever what
// renders changes (a load, clear or (de)activation on either deck; FPS_GEN), so
// each program — or deck pairing — finds its own rung; the app's pin and no-abort
// hold survive that. All under the player_mutex, like the perf ring.
static mut FPS: FpsController = FpsController::new();
/// Bumped by every change to what renders (fx_load / fx_clear / fx_set_active);
/// the render side resets the controller when it differs from FPS_SEEN_GEN.
static mut FPS_GEN: u32 = 0;
static mut FPS_SEEN_GEN: u32 = 0;
/// Set when the autoscaler just parked the effect; drained by loop()
/// (lm_fps_take_abort_notify) to push fps_state{aborted=true}.
static mut FPS_NOTIFY_ABORT: bool = false;

/// What renders changed: restart the autoscaler's search on the next frame.
unsafe fn fps_invalidate() {
    FPS_GEN = FPS_GEN.wrapping_add(1);
}

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

// Default ON (FUG-125 follow-up): the on-device RV32IM JIT ships enabled — the
// 3.4 KB of JIT statics are always linked regardless, so enabling is heap-neutral
// and buys ~2.1x on hot straight-line integer/fixed blocks. The bounded-W^X PMP
// carve-out arms lazily on the first JIT-able effect load (lm_jit_arm's g_jit_armed
// guard). Toggle at runtime via lm_fx_set_jit_enabled + reload (fxjitbench A/B).
// NOTE: fx_bench's golden is the INTERPRETER's per-opcode cost on canonical
// bytecode, and the app's offline cost model is interpreter-calibrated — both now
// diverge from what the shipped firmware runs. See WORKLOG / FUG-125 follow-up.
static mut FX_JIT_ENABLED: bool = true;
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
/// Call from `lm_fx_load` after `FX_BYTES`/`DECK_A.len` are set and `prog` was parsed
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
    let code_off = code.as_ptr() as usize - addr_of!(DECK_A.bytes) as usize;

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
    let fxb = &mut *addr_of_mut!(DECK_A.bytes);
    let mut installed = 0usize;
    let mut used_words = 0usize;
    for p in plans.iter().take(n) {
        if installed >= MAX_JIT_BLOCKS {
            break;
        }
        let p = *p;
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

// -- per-LED memo cache (fx_compiler::memo / fx_vm LoadLedCache) --------------
// An effect's LED-invariant subexpressions (atan2(pos.x,pos.z), hash(idx), …)
// are cached per LED in the SPARE tail of the deck's FX_ARENA slice, after its
// buffers — no new RAM: a deck binds only the best prefix of the compiler's
// priority-ordered groups that fits (Program::led_cache_fit), and nothing at all
// when the arena is full (the effect then runs uncached, exactly as before).
// The cache is keyed by LED index for the CURRENT map, so it is invalidated
// (re-bound) whenever the map/topology changes or the LED count does.
/// LED count the deck caches are bound for (the last lm_fx_update's count).
static mut FX_MEMO_LEDS: usize = 0;
/// A map/topology upload changed the per-LED attributes: re-bind (= invalidate)
/// every deck's cache before the next shade sweep.
static mut FX_MEMO_DIRTY: bool = false;

/// Previous quantized video-texture frame, for set_texture DELTA (XOR) decoding.
/// One buffer — video streams target a single texture at a time. A frame whose
/// quantized byte size exceeds this is dropped (keep the transport small).
const FX_TEX_PREV_MAX: usize = 8 * 1024;

/// The mode-exclusive aux region: EITHER the video delta buffer OR deck B
/// (never both — see the FX decks note above). `FX_AUX_OWNER` is the tag.
#[repr(C)]
union FxAux {
    video: [u8; FX_TEX_PREV_MAX],
    deck_b: core::mem::ManuallyDrop<DeckState>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AuxOwner {
    Free,
    Video,
    DeckB,
}

static mut FX_AUX: FxAux = FxAux { video: [0; FX_TEX_PREV_MAX] };
static mut FX_AUX_OWNER: AuxOwner = AuxOwner::Free;

/// The deck at `d`, if it exists (deck B only while it owns the aux region).
unsafe fn deck(d: usize) -> Option<*mut DeckState> {
    match d {
        DECK_A_IDX => Some(addr_of_mut!(DECK_A)),
        DECK_B_IDX if FX_AUX_OWNER == AuxOwner::DeckB => {
            Some(addr_of_mut!(FX_AUX.deck_b) as *mut DeckState)
        }
        _ => None,
    }
}

/// Deck B's storage, claimed from the aux region (evicting a video stream).
/// Initialised IN PLACE (zeroed, then the non-zero fields) so the ~11 KB deck
/// never passes through a stack temporary.
unsafe fn deck_b_claim() -> *mut DeckState {
    let p = addr_of_mut!(FX_AUX.deck_b) as *mut DeckState;
    if FX_AUX_OWNER != AuxOwner::DeckB {
        core::ptr::write_bytes(p as *mut u8, 0, core::mem::size_of::<DeckState>());
        addr_of_mut!((*p).vm).write(None);
        addr_of_mut!((*p).prog).write(None);
        addr_of_mut!((*p).shade_led).write(None);
        (*p).morph.clear();
        FX_AUX_OWNER = AuxOwner::DeckB;
    }
    p
}

/// The video delta buffer, claimed from the aux region; None while deck B owns
/// it (set_texture is then dropped). A fresh claim starts from black.
unsafe fn tex_prev() -> Option<&'static mut [u8; FX_TEX_PREV_MAX]> {
    match FX_AUX_OWNER {
        AuxOwner::DeckB => None,
        AuxOwner::Free => {
            FX_AUX.video = [0; FX_TEX_PREV_MAX];
            FX_AUX_OWNER = AuxOwner::Video;
            Some(&mut *addr_of_mut!(FX_AUX.video))
        }
        AuxOwner::Video => Some(&mut *addr_of_mut!(FX_AUX.video)),
    }
}
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
/// The whole shade() Frame, built ONCE per frame by lm_fx_update. Building it per
/// LED (`FxFrame { .., ..Default::default() }`) costs a ROM memset of its ~70-byte
/// tail on every LED once the struct outgrew LLVM's inline-zeroing threshold (the
/// room fields did it: +~230 cycles/LED on fx_bench), so shade() borrows this.
static mut FX_SHADE_FRAME: Option<FxFrame> = None;
// The per-LED shade() scratch is per deck (DeckState::shade_led).
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

/// Cache capacity: the firmware's LED cap. One entry/LED. SINGLE SOURCE OF TRUTH
/// is //firmware/player_app:led_caps.bzl (`MAX_LEDS`), injected here as the
/// `LM_MAX_LEDS` rustc_env and as `-DLM_MAX_LEDS` into main.cpp / led_config.h.
pub const FX_TOPO_CAP: usize = parse_cap(env!("LM_MAX_LEDS"));
/// LEDs one output channel carries (led_caps.bzl `MAX_LEDS_PER_CHANNEL`).
pub const FX_MAX_LEDS_PER_CHANNEL: usize = parse_cap(env!("LM_MAX_LEDS_PER_CHANNEL"));
const _: () = assert!(FX_MAX_LEDS_PER_CHANNEL <= FX_TOPO_CAP);

/// Parse the LM_MAX_LEDS build env (a decimal literal) at compile time.
const fn parse_cap(s: &str) -> usize {
    let b = s.as_bytes();
    let mut n = 0usize;
    let mut i = 0;
    while i < b.len() {
        assert!(b[i] >= b'0' && b[i] <= b'9', "LM_MAX_LEDS must be decimal");
        n = n * 10 + (b[i] - b'0') as usize;
        i += 1;
    }
    n
}
/// An LED is "at a junction" (`led.branch`) within this arclength (meters) of a
/// segment endpoint that is a real branch point (degree >= 3).
const FX_BRANCH_DIST_M: f32 = 0.05;

/// One LED's derived topology terms, in map-index order (== led_id; the render
/// is index-based), packed into 10 bytes/entry (was 20: at 2048 LEDs that is
/// 20 KB of heap back): `seg` is the segment INDEX (position in topo.segments)
/// with [`TOPO_BRANCH`] (near a junction) in bit 14, -1 = no association; `s`
/// (normalized 0..1 arclength) and `dist` (geodesic distance from the topology
/// root, 0..1) are f32s with the low mantissa byte dropped ([`F24`]: 16-bit
/// mantissa, ~1.5e-5 relative — decoded with a shift, no soft-float on the
/// shade path); `dperp_mm` is the association's perpendicular offset in whole
/// millimetres (echoed by the stored-map dump). The association's foot arclength
/// is NOT kept: the streaming sink parks it in `s` (and the raw segment_id in
/// `seg`) until fx_rebuild_topo resolves both, and the dump re-derives it as
/// `s * segment.length`. This cache is the SOLE resident copy of the
/// associations (the raw upload is not kept).
#[derive(Clone, Copy)]
struct FxLedTopo {
    seg: i16,
    dperp_mm: i16,
    s: F24,
    dist: F24,
}
impl FxLedTopo {
    const NONE: FxLedTopo = FxLedTopo {
        seg: -1,
        dperp_mm: 0,
        s: F24::ZERO,
        dist: F24::ZERO,
    };
    /// Segment index (-1 = none), once resolved.
    #[inline]
    fn seg_index(&self) -> i16 {
        if self.seg < 0 {
            -1
        } else {
            self.seg & !TOPO_BRANCH
        }
    }
    #[inline]
    fn branch(&self) -> bool {
        self.seg >= 0 && self.seg & TOPO_BRANCH != 0
    }
}

/// Bit 14 of a resolved [`FxLedTopo::seg`]: the LED is near a junction. Segment
/// indices stay far below it (a topology's segments fit ARENA_MEM).
const TOPO_BRANCH: i16 = 0x4000;

/// An f32 stored in 3 bytes: sign, exponent and the top 15 mantissa bits (the
/// low byte is rounded away). Exact for 0 and +-1; ~1.5e-5 relative otherwise.
#[derive(Clone, Copy, PartialEq, Debug)]
struct F24([u8; 3]);
impl F24 {
    const ZERO: F24 = F24([0; 3]);
    #[inline]
    fn new(v: f32) -> F24 {
        let b = v.to_bits();
        // Round to nearest (ties away) on the dropped byte; a mantissa carry
        // into the exponent is still the correctly rounded value. Inf/NaN as is.
        let r = if b & 0x7f80_0000 == 0x7f80_0000 {
            b
        } else {
            b + 0x80
        };
        F24([(r >> 8) as u8, (r >> 16) as u8, (r >> 24) as u8])
    }
    #[inline]
    fn get(self) -> f32 {
        f32::from_bits(
            ((self.0[0] as u32) << 8) | ((self.0[1] as u32) << 16) | ((self.0[2] as u32) << 24),
        )
    }
}

/// Metres -> saturating whole millimetres (an association's d_perp).
fn mm_sat(m: f32) -> i16 {
    let v = m * 1000.0;
    (if v >= 0.0 { v + 0.5 } else { v - 0.5 }) as i16
}

/// Convert a float to Q16.16 (the canonical fixed context width, CTX_FIX_FRAC).
/// Used to build the per-LED/-frame fixed mirrors for LoadCtxFix on demand (only
/// when the loaded effect reads them), so this never grows the resident cache.
#[inline]
fn q16_16(x: f32) -> i32 {
    // Bit-exact with `(x * 65536.0) as i32`, in integer ops (~15 cycles instead
    // of a soft mul + f32->i32, ~165): the per-LED fixed mirrors take seven.
    ledmapper_fx_vm::f32_to_fix(x, 16)
}

// -- the per-LED store: sized at boot for the CONFIGURED strip -----------------
// FX_LED_TOPO (10 B/LED), FX_LED_POS (9 B/LED) and FX_LED_MAPPED (1 bit/LED) are
// NOT sized for the 2048-LED cap: the firmware allocates ONE block for them once
// at boot (before the radios fragment the heap), sized for the persisted channel
// counts (lm_led_store_bytes / lm_led_store_bind), so a 300-LED lamp pays for
// 300 LEDs. A count change past it persists and reboots into the new size
// (Player::set_led_capacity). FX_TOPO_CAP stays the hard cap.
//
// FX_LED_TOPO: the per-LED topology cache (see FxLedTopo), map-index order.
// FX_LED_POS: the flash-backed map's per-LED positions (metres), the ONLY map
// data resident at render time. Fed by the streaming submit_map decode;
// lm_map_led / get_stored_map / led.uv all read it (the raw StoredMap is gone).
// Indexed by LED id (= strip position; the render is index-based) — NOT by the
// entry's position in the uploaded list, which skips unmapped LEDs. Unmapped
// slots hold a position interpolated from their mapped neighbours (see
// fill_unmapped). Each axis is an [`F24`] (9 B/LED instead of 12; ~1.5e-5
// relative — 0.08 mm at 5 m, far under a solve's accuracy — and a shift to
// decode, so the per-LED read stays free of soft-float): use pos_get / pos_set.
// FX_LED_MAPPED: one bit per LED id, set when the uploaded map solved that LED
// (its position is measured), clear when it is interpolated.
static mut FX_LED_TOPO: *mut FxLedTopo = core::ptr::null_mut();
static mut FX_LED_POS: *mut [F24; 3] = core::ptr::null_mut();
static mut FX_LED_MAPPED: *mut u32 = core::ptr::null_mut();
/// LEDs the bound store holds (0 = none bound: no map positions are kept).
static mut FX_STORE_LEDS: usize = 0;

/// Bytes the per-LED store needs for `leds` LEDs (incl. alignment): the mapped
/// bitset (u32 words) first, then the topology cache (2-aligned), then the
/// positions.
pub const fn led_store_bytes(leds: usize) -> usize {
    leds.div_ceil(32) * 4 + leds * core::mem::size_of::<FxLedTopo>() + leds * 9
}

/// Bytes the per-LED store needs for `leds` LEDs (see [`lm_led_store_bind`]).
#[no_mangle]
pub extern "C" fn lm_led_store_bytes(leds: u32) -> usize {
    led_store_bytes(leds as usize)
}

/// Bind the per-LED store to `mem[0..bytes)` (4-aligned, from the firmware's
/// boot-time allocation) for `leds` LEDs, at most the FX_TOPO_CAP cap; it is
/// cleared (no map). Returns false when the block is too small or misaligned.
/// Call before [`lm_player_init`]; the block must live for the process.
///
/// # Safety
/// `mem` must be valid for `bytes` writes and never used elsewhere.
#[no_mangle]
pub unsafe extern "C" fn lm_led_store_bind(mem: *mut u8, bytes: usize, leds: u32) -> bool {
    let n = (leds as usize).min(FX_TOPO_CAP);
    if mem.is_null() || (mem as usize) % 4 != 0 || bytes < led_store_bytes(n) {
        return false;
    }
    let words = n.div_ceil(32);
    FX_LED_MAPPED = mem as *mut u32;
    FX_LED_TOPO = mem.add(words * 4) as *mut FxLedTopo;
    FX_LED_POS = mem.add(words * 4 + n * core::mem::size_of::<FxLedTopo>()) as *mut [F24; 3];
    FX_STORE_LEDS = n;
    mapped_store().fill(0);
    topo_store().fill(FxLedTopo::NONE);
    pos_store().fill([F24::ZERO; 3]);
    true
}

/// LEDs the per-LED store holds: map positions / topology past it aren't kept.
#[inline]
fn fx_cap() -> usize {
    unsafe { FX_STORE_LEDS }
}

#[inline]
unsafe fn topo_store() -> &'static mut [FxLedTopo] {
    if FX_STORE_LEDS == 0 {
        return &mut [];
    }
    core::slice::from_raw_parts_mut(FX_LED_TOPO, FX_STORE_LEDS)
}

#[inline]
unsafe fn pos_store() -> &'static mut [[F24; 3]] {
    if FX_STORE_LEDS == 0 {
        return &mut [];
    }
    core::slice::from_raw_parts_mut(FX_LED_POS, FX_STORE_LEDS)
}

#[inline]
unsafe fn mapped_store() -> &'static mut [u32] {
    if FX_STORE_LEDS == 0 {
        return &mut [];
    }
    core::slice::from_raw_parts_mut(FX_LED_MAPPED, FX_STORE_LEDS.div_ceil(32))
}

/// The host build's store (`host_store` feature: the host tests never allocate
/// one): the whole cap, bound by lm_player_init when nothing is.
#[cfg(feature = "host_store")]
static mut HOST_STORE: [u32; led_store_bytes(FX_TOPO_CAP).div_ceil(4)] =
    [0; led_store_bytes(FX_TOPO_CAP).div_ceil(4)];

/// LED `i`'s resident position (metres).
#[inline]
unsafe fn pos_get(i: usize) -> [f32; 3] {
    let p = &pos_store()[i];
    [p[0].get(), p[1].get(), p[2].get()]
}

#[inline]
unsafe fn pos_set(i: usize, v: [f32; 3]) {
    pos_store()[i] = [F24::new(v[0]), F24::new(v[1]), F24::new(v[2])];
}

#[inline]
unsafe fn led_mapped(i: usize) -> bool {
    mapped_store()[i / 32] & (1 << (i % 32)) != 0
}

/// Fill every unmapped LED in [0, n) with a position linearly interpolated (by
/// LED index) between its nearest mapped neighbours; an unmapped run at either
/// end of the strip clamps to the nearest mapped LED. With no mapped LED at all
/// everything stays at the origin. Interpolated points lie on the segment
/// between two mapped ones, so they never widen the map's bounding box.
unsafe fn fill_unmapped(n: usize) {
    let mut prev: Option<usize> = None;
    let mut i = 0;
    while i < n {
        if led_mapped(i) {
            prev = Some(i);
            i += 1;
            continue;
        }
        let mut next = i;
        while next < n && !led_mapped(next) {
            next += 1;
        }
        for j in i..next {
            let v = match (prev, next < n) {
                (Some(a), true) => {
                    let t = (j - a) as f32 / (next - a) as f32;
                    let (pa, pb) = (pos_get(a), pos_get(next));
                    [
                        pa[0] + (pb[0] - pa[0]) * t,
                        pa[1] + (pb[1] - pa[1]) * t,
                        pa[2] + (pb[2] - pa[2]) * t,
                    ]
                }
                (Some(a), false) => pos_get(a),
                (None, true) => pos_get(next),
                (None, false) => [0.0; 3],
            };
            pos_set(j, v);
        }
        i = next;
    }
}

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

// -- room frame (multi-fixture, set_fixture_pose) -----------------------------
/// The pose as an affine map, room = FX_ROOM_T + FX_ROOM_M * pos (M = scale *
/// R(q)): applied per LED in shade() while posed, for effects that read the room
/// frame. There is no per-LED room cache — at the 2048-LED cap it would cost
/// 12 KB of heap (6 B/LED); the transform is 9 multiply-adds per LED, paid only
/// by room-reading effects on a posed fixture (unposed, led.room == led.pos).
static mut FX_ROOM_M: [[f32; 3]; 3] = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
static mut FX_ROOM_T: [f32; 3] = [0.0; 3];
/// The pose + room box match the current map + pose (FX_ROOM_GEN = the pose gen
/// they used).
static mut FX_ROOM_READY: bool = false;
static mut FX_ROOM_GEN: u32 = 0;
/// A pose is set (Frame::room_posed).
static mut FX_ROOM_POSED: bool = false;
/// room.min / room.max (room frame, m) and their Q16.16 mirrors — the host's
/// room box from the pose when given, else this fixture's own (posed) box.
static mut FX_ROOM_MIN: [f32; 3] = [0.0; 3];
static mut FX_ROOM_MAX: [f32; 3] = [0.0; 3];
static mut FX_ROOM_MIN_FIX: [i32; 3] = [0; 3];
static mut FX_ROOM_MAX_FIX: [i32; 3] = [0; 3];

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

// The effect identity a PerfReport is pinned to (perf-monitoring.md: the
// panel/AI must know metrics belong to the running compiled script) is deck A's
// `hash` (of the loaded `.fxb`, recomputed on load) + `id` (the last submit).

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
fn panic(info: &core::panic::PanicInfo) -> ! {
    // The player contract is bounded errors, never panics; reaching this is a
    // firmware bug. Say where on the console, then abort(): ESP-IDF's panic
    // path reboots with reset reason PANIC, which the OTA crash-loop guard
    // (ota_app.cpp) counts, so a crash-looping image falls back to the loader
    // instead of the old `loop {}` that left the fixture dark until power-cycled.
    extern "C" {
        fn esp_rom_printf(fmt: *const u8, ...) -> i32;
        fn abort() -> !;
    }
    unsafe {
        match info.location() {
            Some(l) => {
                let f = l.file();
                esp_rom_printf(
                    b"[rust] panic at %.*s:%u\n\0".as_ptr(),
                    f.len() as i32,
                    f.as_ptr(),
                    l.line(),
                );
            }
            None => {
                esp_rom_printf(b"[rust] panic\n\0".as_ptr());
            }
        }
        abort()
    }
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
        #[cfg(feature = "host_store")]
        if FX_STORE_LEDS == 0 {
            let mem = addr_of_mut!(HOST_STORE) as *mut u8;
            lm_led_store_bind(mem, led_store_bytes(FX_TOPO_CAP), FX_TOPO_CAP as u32);
        }
        *addr_of_mut!(MAP_META) = None;
        *addr_of_mut!(GEOM) = None;
        FX_TOPO_READY = false;
        FX_UV_READY = false;
        FX_ROOM_READY = false;
        for e in topo_store().iter_mut() {
            *e = FxLedTopo::NONE;
        }
        *addr_of_mut!(ARENA) = Some(Arena::new(&mut *addr_of_mut!(ARENA_MEM)));
        let mut p = Player::new("esp32c6-player", default_led_count.max(1));
        // The render buffer (FX_TOPO_CAP == LM_MAX_LEDS) is shared by every
        // output channel, so it's the cap on the SUM of the channel counts; each
        // channel alone is capped at LM_MAX_LEDS_PER_CHANNEL (both at the cap
        // still clock out in parallel).
        p.set_output_caps(ledmapper_player::HW_CHANNELS as u32, FX_TOPO_CAP as u32);
        p.set_channel_cap(FX_MAX_LEDS_PER_CHANNEL as u32);
        // Boot-time sizing (lm_set_led_limits) narrows these to the store.
        p.set_features(FEATURES, ledmapper_fx_vm::FORMAT_VERSION as u32);
        *addr_of_mut!(PLAYER) = Some(p);
    }
}

/// The boot-time LED sizing: this boot's per-LED buffers hold `capacity` LEDs
/// (summed across channels; the persisted counts it was sized from), and the
/// heap can buffer at most `max_leds` (board.max_leds: the largest total whose
/// boot allocation still leaves the safe heap floor). A count change within
/// `max_leds` but past `capacity` is accepted, persisted and answered
/// `reboot_required`; past `max_leds` it is refused. Call after
/// [`lm_player_init`].
///
/// # Safety
/// Single firmware thread; the player must be initialized.
#[no_mangle]
pub unsafe extern "C" fn lm_set_led_limits(capacity: u32, max_leds: u32) {
    let p = player();
    p.set_output_caps(ledmapper_player::HW_CHANNELS as u32, max_leds.min(FX_TOPO_CAP as u32));
    p.set_led_capacity(capacity);
}

/// Read + clear the player's reboot request: a count change outgrew this boot's
/// LED buffers (its config is persisted); restart once the reply is out.
///
/// # Safety
/// Single firmware thread; the player must be initialized.
#[no_mangle]
pub unsafe extern "C" fn lm_take_reboot_request() -> bool {
    player().take_reboot_request()
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

/// Set the firmware build info (git commit + dirty flag + release version) echoed
/// in every `welcome`. `commit` is the full git hash as UTF-8 bytes; `dirty` is
/// true when the working tree had uncommitted changes at build time; `version` is
/// the release version from the nearest `firmware-v*` tag as UTF-8 bytes. Call
/// once after `lm_player_init` (the firmware owns the stamped `build_info.h`).
///
/// # Safety
/// `commit` must point to `commit_len` readable bytes (or be null); `version`
/// must point to `version_len` readable bytes (or be null).
#[no_mangle]
pub unsafe extern "C" fn lm_player_set_build_info(
    commit: *const u8,
    commit_len: usize,
    dirty: bool,
    version: *const u8,
    version_len: usize,
) {
    let commit_s = if commit.is_null() {
        ""
    } else {
        core::str::from_utf8(core::slice::from_raw_parts(commit, commit_len)).unwrap_or("")
    };
    let version_s = if version.is_null() {
        ""
    } else {
        core::str::from_utf8(core::slice::from_raw_parts(version, version_len)).unwrap_or("")
    };
    player().set_build_info(commit_s, dirty, version_s);
}

/// The per-device TLS identity as the firmware last published it (lm_set_tls_info):
/// "generating" | "ready" ("" = never published) + the cert pin.
struct TlsIdentity {
    state: [u8; 16],
    state_len: usize,
    sha: [u8; 64],
    sha_len: usize,
    persisted: bool,
}
static mut TLS_ID: TlsIdentity =
    TlsIdentity { state: [0; 16], state_len: 0, sha: [0; 64], sha_len: 0, persisted: false };

unsafe fn tls_state() -> &'static str {
    let t = &*addr_of!(TLS_ID);
    core::str::from_utf8(&t.state[..t.state_len]).unwrap_or("")
}

unsafe fn tls_sha() -> &'static str {
    let t = &*addr_of!(TLS_ID);
    core::str::from_utf8(&t.sha[..t.sha_len]).unwrap_or("")
}

/// Publish the per-device TLS identity's state ("generating" | "ready"), its cert
/// SHA-256 (lowercase hex, "" while generating) and whether it is persisted. Read
/// by get_tls_info, the agent manifest (tls.state / tls.persisted) and the mDNS
/// TXT `tls` key. Over-long arguments are truncated to the field caps.
///
/// # Safety
/// `state`/`sha` point to `state_len`/`sha_len` readable bytes (or are null).
#[no_mangle]
pub unsafe extern "C" fn lm_set_tls_info(
    state: *const u8,
    state_len: usize,
    sha: *const u8,
    sha_len: usize,
    persisted: bool,
) {
    let t = &mut *addr_of_mut!(TLS_ID);
    let st = str_arg(state, state_len).as_bytes();
    t.state_len = st.len().min(t.state.len());
    t.state[..t.state_len].copy_from_slice(&st[..t.state_len]);
    let sh = str_arg(sha, sha_len).as_bytes();
    t.sha_len = sh.len().min(t.sha.len());
    t.sha[..t.sha_len].copy_from_slice(&sh[..t.sha_len]);
    t.persisted = persisted;
}

/// The device's mDNS service: `<name>._splanc._tcp.local` on the wss/HTTPS port,
/// host `splanc-<mac tail>.local`, TXT id/name/fw/path (+ `tls` = the TLS
/// identity's state, once published) — from the player's live identity, so a
/// rename is advertised on the next reply.
unsafe fn with_mdns_service<R>(ip: [u8; 4], f: impl FnOnce(&ledmapper_mdns::Service) -> R) -> R {
    let p = player();
    let mut hb = [0u8; 13];
    let host = ledmapper_mdns::host_label(p.mac(), &mut hb);
    let tls = tls_state();
    let txt = [
        ("id", p.mac()),
        ("name", p.device_name()),
        ("fw", p.fw_version()),
        ("path", "/.well-known/splanc.json"),
        ("tls", tls),
    ];
    let txt: &[(&str, &str)] = if tls.is_empty() { &txt[..4] } else { &txt };
    let svc = ledmapper_mdns::Service { host, instance: p.device_name(), port: 443, ip, txt };
    f(&svc)
}

/// Answer one mDNS datagram received on UDP:5353 from `src_port`. Writes the reply
/// DNS message into `out` and returns its length (0 = nothing to answer, -2 = too
/// small); `*unicast` is set when the reply goes back to the querier's address and
/// port instead of 224.0.0.251:5353. `ip` is our IPv4 address (4 bytes).
///
/// # Safety
/// `query`/`ip`/`out`/`unicast` point to readable/writable memory of the stated sizes.
#[no_mangle]
pub unsafe extern "C" fn lm_mdns_respond(
    query: *const u8,
    qlen: usize,
    src_port: u16,
    ip: *const u8,
    out: *mut u8,
    cap: usize,
    unicast: *mut bool,
) -> i32 {
    if query.is_null() || ip.is_null() || out.is_null() || unicast.is_null() {
        return -1;
    }
    let q = core::slice::from_raw_parts(query, qlen);
    let ip = [*ip, *ip.add(1), *ip.add(2), *ip.add(3)];
    let o = core::slice::from_raw_parts_mut(out, cap);
    match with_mdns_service(ip, |s| ledmapper_mdns::respond(q, src_port, s, o)) {
        Some(r) => {
            *unicast = r.dest == ledmapper_mdns::Dest::Unicast;
            r.len as i32
        }
        None => 0,
    }
}

/// An unsolicited mDNS announcement of every record (for 224.0.0.251:5353): the
/// DNS message into `out`; returns its length or -2 when it doesn't fit.
///
/// # Safety
/// `ip` points to 4 readable bytes, `out` to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_mdns_announce(ip: *const u8, out: *mut u8, cap: usize) -> i32 {
    if ip.is_null() || out.is_null() {
        return -1;
    }
    let ip = [*ip, *ip.add(1), *ip.add(2), *ip.add(3)];
    let o = core::slice::from_raw_parts_mut(out, cap);
    match with_mdns_service(ip, |s| ledmapper_mdns::announce(s, o)) {
        Some(n) => n as i32,
        None => -2,
    }
}

/// A C (ptr, len) UTF-8 argument as &str ("" when null / not UTF-8).
unsafe fn str_arg<'a>(p: *const u8, len: usize) -> &'a str {
    if p.is_null() {
        ""
    } else {
        core::str::from_utf8(core::slice::from_raw_parts(p, len)).unwrap_or("")
    }
}

/// Render the agent discovery manifest (`GET /.well-known/splanc.json`) into
/// `out`; returns its length, or -2 when it doesn't fit. `cert_sha256` is the
/// TLS certificate's SHA-256 (hex) for the bridge to pin; `bundle_url` /
/// `bundle_sha256` are the build's agent-bundle stamps (empty = derive the URL
/// for a release build / no hash). Device + firmware fields come from the
/// player (they mirror the welcome).
///
/// # Safety
/// `out` points to `cap` writable bytes; each string argument to its length in
/// readable bytes (or is null).
#[no_mangle]
pub unsafe extern "C" fn lm_agent_manifest(
    out: *mut u8,
    cap: usize,
    cert_sha256: *const u8,
    cert_len: usize,
    bundle_url: *const u8,
    url_len: usize,
    bundle_sha256: *const u8,
    sha_len: usize,
) -> i32 {
    if out.is_null() {
        return -1;
    }
    let x = ledmapper_player::ManifestExtras {
        tls_cert_sha256: str_arg(cert_sha256, cert_len),
        tls_state: tls_state(),
        tls_persisted: (*addr_of!(TLS_ID)).persisted,
        bundle_url: str_arg(bundle_url, url_len),
        bundle_sha256: str_arg(bundle_sha256, sha_len),
    };
    match player().agent_manifest(core::slice::from_raw_parts_mut(out, cap), &x) {
        Some(n) => n as i32,
        None => -2,
    }
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
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
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
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
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
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_brightness_gen() -> u32 {
    player().output_brightness_gen()
}

/// The active global output brightness as an 8-bit scale (0..=255, where 255 is
/// unattenuated) — the form FastLED's `nscale8` wants. The firmware multiplies
/// every rendered LED by this just before the strip write.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_brightness_u8() -> u8 {
    // Round 0.0..=1.0 to 0..=255; clamp defends against any out-of-range value
    // that slipped past the core's clamp.
    let b = player().output_brightness().clamp(0.0, 1.0);
    (b * 255.0 + 0.5) as u8
}

/// Seed a hardware channel's config at boot with the GPIO the firmware actually
/// initialized and its wire color order (a NUL-free name like "GRB"; an unknown
/// or null name falls back to the WS2812B default). Call once per wired channel
/// after [`lm_player_init`], BEFORE any client can `set_hardware_config`, so the
/// first `welcome` echoes the real hardware.
///
/// # Safety
/// `order` points to `order_len` readable UTF-8 bytes (or is null).
#[no_mangle]
pub unsafe extern "C" fn lm_hw_seed(channel: u32, gpio: i32, order: *const u8, order_len: usize) {
    let name = if order.is_null() {
        ""
    } else {
        core::str::from_utf8(core::slice::from_raw_parts(order, order_len)).unwrap_or("")
    };
    let idx = ledmapper_player::color_order_index(name).unwrap_or(ledmapper_player::DEFAULT_COLOR_ORDER);
    player().set_hw_defaults(channel as usize, gpio, idx);
}

/// Seed hardware channel `channel`'s LED count at boot from the value the
/// firmware persisted (0 = not set). Call after [`lm_player_init`], BEFORE any
/// client connects, like [`lm_hw_seed`].
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_led_count_seed(channel: u32, led_count: u32) {
    player().seed_led_count(channel as usize, led_count);
}

/// Install this board's static capability descriptor: `data` is a serialized
/// `BoardCapabilities` (the board textproto compiled to a binaryproto at build
/// time and embedded in the image). Kept encoded and echoed in
/// `hardware_config_state` so the app builds its pin picker / LED-type list from
/// what this board supports. Call once after [`lm_player_init`]. A null, empty,
/// or malformed blob is ignored (the app just falls back to its built-in
/// catalog), so a board that ships no descriptor still works.
///
/// # Safety
/// `data` points to `len` readable bytes (or is null) that stay valid and
/// unchanged for the rest of the program (the image-embedded array).
#[no_mangle]
pub unsafe extern "C" fn lm_set_board_caps(data: *const u8, len: usize) {
    if data.is_null() || len == 0 {
        return;
    }
    // Kept encoded (never decoded into the ~4 KiB struct); the player splices
    // it into hardware_config_state replies.
    let _ = player().set_board_caps(core::slice::from_raw_parts(data, len));
}

/// Generation counter for the hardware config, bumped on every
/// `set_hardware_config`. The firmware polls this after each `lm_player_handle`
/// (like `lm_color_correction_gen`) to persist the config to NVS and re-apply it
/// to the RMT driver.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_hw_config_gen() -> u32 {
    player().hw_config_gen()
}

/// Whether the latest `set_hardware_config` should be committed to flash
/// (returns 1) or applied from RAM only (0) — the color-order test previews.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_hw_config_commit() -> i32 {
    player().hw_config_commit() as i32
}

/// The GPIO configured for hardware channel `channel`, or -1 if the channel is
/// out of range or unseeded. The firmware persists this to NVS on a config change.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_hw_gpio(channel: u32) -> i32 {
    player().hw_gpio(channel as usize).unwrap_or(-1)
}

/// Write hardware channel `channel`'s wire color-order SOURCE permutation into
/// `out` as three bytes: `out[i]` is the logical channel (R=0, G=1, B=2) that
/// wire byte `i` carries. The RMT driver applies this on every strip write.
/// Returns 0 on success, -1 if `out` is null.
///
/// # Safety
/// `out` must point to at least three writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_hw_color_order_perm(channel: u32, out: *mut u8) -> i32 {
    if out.is_null() {
        return -1;
    }
    let perm = player().hw_color_order_perm(channel as usize);
    core::ptr::copy_nonoverlapping(perm.as_ptr(), out, perm.len());
    0
}

/// Copy hardware channel `channel`'s wire color-order NAME (e.g. "GRB") into
/// `out` (cap bytes); returns the length written, or -2 when it doesn't fit. The
/// firmware persists this to NVS on a config change.
///
/// # Safety
/// `out` must point to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_hw_color_order_name(channel: u32, out: *mut u8, cap: usize) -> i32 {
    let name = player().hw_color_order_name(channel as usize).as_bytes();
    if name.len() > cap {
        return -2;
    }
    if !out.is_null() && !name.is_empty() {
        core::ptr::copy_nonoverlapping(name.as_ptr(), out, name.len());
    }
    name.len() as i32
}

fn encode_reply(reply: &pb::ServerMessage, out: *mut u8, out_cap: usize) -> i32 {
    // Encoded straight into the caller's tx (no staging copy on this stack).
    let out = unsafe { core::slice::from_raw_parts_mut(out, out_cap) };
    match unsafe { player() }.encode_reply(reply, out) {
        Some(n) => n as i32,
        None => -2, // reply exceeds out_cap — a firmware bug, not remote input
    }
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
        Some(ARM_SUBMIT_TOPOLOGY) => handle_topology_upload(frame, |r: &mut &[u8]| *r = frame, frame.len()),
        // Dump the stored map+topology (it lives in the arena, not the session
        // core) back out to the phone, one MappingBundle byte-window per call.
        // Encoded ZERO-COPY straight into `out` (never a fat by-value
        // StoredMapChunk), so it returns the reply length directly.
        Some(ARM_GET_STORED_MAP) => return handle_get_stored_map(frame, out, out_cap),
        // Effects arms: read in place (pbview — a full .fxb rides the frame, no
        // capacity profile), then loaded/selected/tuned on the VM.
        Some(ARM_SUBMIT_EFFECT) => handle_submit_effect(frame),
        Some(ARM_SET_EFFECT) => handle_set_effect(frame),
        Some(ARM_SET_UNIFORMS) => handle_set_uniforms(frame),
        // Encoded ZERO-COPY into `out`: the manifest is effect-sized (well past
        // the firmware profile's inline bytes cap), so it's spliced from the .fxb.
        Some(ARM_GET_EFFECT_UNIFORMS) => return handle_get_effect_uniforms(frame, out, out_cap),
        Some(ARM_LIST_EFFECTS) => handle_list_effects(),
        // The per-device TLS identity's state + pin (set by the firmware through
        // lm_set_tls_info): answers over BLE too, before wss is reachable.
        Some(ARM_GET_TLS_INFO) => handle_get_tls_info(),
        // Framerate autoscaler override (FUG-82): pin / unpin / hold the target.
        Some(ARM_SET_FPS) => handle_set_fps(frame),
        // The motion sensor's snapshot (sensor_ffi.rs), zero-copy into `out`;
        // calibrate posts to the sensor task's mailbox and replies the same.
        Some(ARM_GET_SENSORS) => return sensor_ffi::handle_get_sensors(out, out_cap),
        Some(ARM_CALIBRATE_SENSORS) => return sensor_ffi::handle_calibrate_sensors(frame, out, out_cap),
        // Driver VM (FUG-107): scan the bus, load / remove the one driver, report it.
        Some(ARM_SCAN_I2C) => return driver_ffi::handle_scan_i2c(out, out_cap),
        Some(ARM_SUBMIT_DRIVER) => return driver_ffi::handle_submit_driver(frame, out, out_cap),
        Some(ARM_REMOVE_DRIVER) => return driver_ffi::handle_remove_driver(out, out_cap),
        Some(ARM_GET_DRIVER_STATE) => return driver_ffi::handle_get_driver_state(out, out_cap),
        // IMU extrinsic + the capture profile (sensor-core.md §7).
        Some(ARM_SET_SENSOR_MOUNT) => return sensor_ffi::handle_set_sensor_mount(frame, out, out_cap),
        Some(ARM_SET_CAPTURE_PROFILE) => return sensor_ffi::handle_set_capture_profile(frame, out, out_cap),
        Some(ARM_GET_CAPTURE_PROFILE) => return sensor_ffi::handle_get_capture_profile(out, out_cap),
        // Uniform keypoints: stored per effect on littlefs (via the C++ hooks),
        // replies encoded zero-copy into `out`; blend runs on the deck's VM.
        Some(ARM_SAVE_KEYPOINT) => return handle_save_keypoint(frame, out, out_cap),
        Some(ARM_DELETE_KEYPOINT) => return handle_delete_keypoint(frame, out, out_cap),
        Some(ARM_LIST_KEYPOINTS) => return handle_list_keypoints(frame, out, out_cap),
        Some(ARM_GET_KEYPOINT) => return handle_get_keypoint(frame, out, out_cap),
        Some(ARM_BLEND_KEYPOINTS) => handle_blend_keypoints(frame),
        // Perf-monitoring arms: configure the instrumentation tier / push
        // cadence, or drain the ring into a rolled-up PerfReport.
        Some(ARM_SET_PERF) => handle_set_perf(frame),
        Some(ARM_GET_PERF_REPORT) => handle_get_perf_report(),
        // Debug/bench: toggle the on-device JIT (FUG-125). Fire-and-forget; takes
        // effect on the next lm_fx_load, so the HITL fx_bench re-submits after.
        Some(ARM_SET_JIT) => {
            handle_set_jit(frame);
            return 0;
        }
        // Video-texture frame: decode into the active effect's texture arena.
        // Fire-and-forget (no reply) so high frame rates aren't gated on a round
        // trip — a malformed/oversized frame is silently dropped.
        Some(ARM_SET_TEXTURE) => {
            handle_set_texture(frame);
            LAST_TEXTURE_MS = Some(recv_ms);
            return 0;
        }
        // Everything else is read IN PLACE from the frame (pbview): no
        // by-value ClientMessage on this stack, and no capacity truncation.
        _ => match player().handle_frame(frame, recv_ms, send_ms) {
            Some(reply) => reply,
            None => return 0,
        },
    };
    encode_reply(&reply, out, out_cap)
}

/// Drop the resident topology (geometry + per-LED cache). The geometry
/// borrows the arena, so this must run before the arena is reset.
unsafe fn reset_topo_cache() {
    FX_MEMO_DIRTY = true; // led.seg/s/branch (and, via a map upload, pos/uv) change
    *addr_of_mut!(GEOM) = None;
    for e in topo_store().iter_mut() {
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
    FX_ROOM_READY = false; // ...and so are the room-frame positions
    // Nothing from a previous map may survive into this one.
    // (Filled in place: a whole-array assignment would build the temporary on
    // the task stack.)
    pos_store().fill([F24::ZERO; 3]);
    mapped_store().fill(0);
    let res = decode_submit_map_streamed(reader, total, |_idx, led_count, led| {
        // Key by the LED's id, not its list position: a map with unmapped LEDs
        // omits them, so positions past the first gap would land in the wrong
        // slot. Ids past the strip (led_count) or the render cap aren't stored
        // (the strip can't drive them); the decode still validates the frame.
        let i = led.id as usize;
        if led.id < led_count && i < fx_cap() {
            pos_set(i, led.xyz);
            mapped_store()[i / 32] |= 1 << (i % 32);
        }
        Ok(())
    });
    match res {
        Ok((map_id, led_count)) => {
            fill_unmapped((led_count as usize).min(fx_cap()));
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
/// A failed / rejected decode rolls the whole thing back. The decode reads the
/// frame twice (count, then fill exactly-sized arrays); `rewind` resets `reader`
/// to the frame's first byte between the passes.
unsafe fn handle_topology_upload<R: PbRead<Error = Infallible>>(
    mut reader: R,
    rewind: impl FnMut(&mut R),
    total: usize,
) -> pb::ServerMessage {
    reset_topo_cache();
    arena_mut().reset();
    let res = decode_submit_topology_streamed(&mut reader, rewind, total, arena_ref(), |a: &StoredAssociation| {
        let i = a.led_id as usize;
        if i < fx_cap() && a.segment_id <= i16::MAX as u32 {
            topo_store()[i] = FxLedTopo {
                seg: a.segment_id as i16, // TEMP raw id; resolved in fx_rebuild_topo
                dperp_mm: mm_sat(a.d_perp),
                s: F24::new(a.foot_arclength), // TEMP foot (m); resolved to s
                dist: F24::ZERO,
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
/// MappingBundle, wrapped in a `ServerMessage{stored_map_chunk}`. The phone
/// requests [offset, offset+max_len) repeatedly until it has `total_len` bytes;
/// `no_map` when nothing is stored.
///
/// Encoded ZERO-COPY, straight into `out` — never through a by-value
/// `pb::StoredMapChunk`. That struct carries a `Vec<u8, 1024>` inline, so
/// materializing it would bloat EVERY `pb::ServerMessage` temporary in the
/// handler to ~1 KiB (the oneof is sized to its largest arm). The firmware
/// profile therefore shrinks `StoredMapChunk.data` to a stub (gen_main.rs) —
/// this is the only place the message is produced, and only the phone decodes
/// it. Returns the encoded length (or an encoded error / `-2` if `out` is small).
unsafe fn handle_get_stored_map(frame: &[u8], out: *mut u8, out_cap: usize) -> i32 {
    // The request, read in place: GetStoredMap = { offset:1, max_len:2 }.
    let Some(CArm::GetStoredMap(req)) = client_arm(frame) else {
        return encode_reply(&upload_malformed(), out, out_cap);
    };
    let offset = req.offset() as usize;
    let max_len = req.max_len().max(1) as usize;

    let Some((map_id, led_count)) = (*addr_of!(MAP_META)).as_ref().map(|(id, c)| (id.clone(), *c))
    else {
        return encode_reply(&dump_error("no_map", "no stored map to dump"), out, out_cap);
    };
    // Resolve the per-LED cache so FX_LED_TOPO.seg is the segment INDEX (not the
    // raw upload id); cheap after the first frame.
    fx_rebuild_topo();
    // Reconstruct the bundle from the resident caches (see dump::*_src): the
    // mapped LEDs (real ids, xyz from FX_LED_POS) + the unmapped ids (their
    // interpolated positions are a render detail, not map data), associations
    // recovered from FX_LED_TOPO with the segment_id read back out of the geometry.
    let n_leds = (led_count as usize).min(fx_cap());
    let led_each = |f: &mut dyn FnMut(u32, [f32; 3])| {
        for i in (0..n_leds).filter(|&i| led_mapped(i)) {
            f(i as u32, pos_get(i));
        }
    };
    let unmapped_each = |f: &mut dyn FnMut(u32)| {
        for i in (0..n_leds).filter(|&i| !led_mapped(i)) {
            f(i as u32);
        }
    };
    let msrc = dump::MapSrc {
        map_id: map_id.as_str(),
        led_count,
        led_each: &led_each,
        unmapped_each: &unmapped_each,
    };
    let geom = (*addr_of!(GEOM)).as_ref();
    let assoc_each = |f: &mut dyn FnMut(u32, u32, f32, f32)| {
        if let Some(g) = geom {
            let n = (led_count as usize).min(fx_cap());
            for i in 0..n {
                let e = &topo_store()[i];
                let si = e.seg_index();
                if si >= 0 && (si as usize) < g.segments.len() {
                    // The foot isn't resident: it is s * the segment length (s was
                    // clamped to the segment by the resolve).
                    let seg = &g.segments[si as usize];
                    f(
                        i as u32,
                        seg.id,
                        e.s.get() * seg.length,
                        e.dperp_mm as f32 * 0.001,
                    );
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
    let total = dump::bundle_len_src(&msrc, tsrc.as_ref());
    // Bound the chunk by the reply field capacity (StoredMapChunk.data).
    let cap = max_len.min(1024);
    let mut chunk = [0u8; 1024];
    let n = if offset < total {
        dump::encode_bundle_window_src(
            &msrc,
            tsrc.as_ref(),
            offset,
            &mut chunk[..cap],
        )
    } else {
        0
    };
    let has_topo = geom.is_some();

    // ServerMessage{ stored_map_chunk=15 { total_len=1, offset=2, data=3,
    // has_topology=4 } }. Proto3 implicit presence: omit fields at default.
    let mut inner_len = 0usize;
    if total > 0 {
        inner_len += 1 + varint_len(total as u64);
    }
    if offset > 0 {
        inner_len += 1 + varint_len(offset as u64);
    }
    if n > 0 {
        inner_len += 1 + varint_len(n as u64) + n;
    }
    if has_topo {
        inner_len += 2;
    }
    let need = 1 + varint_len(inner_len as u64) + inner_len;
    if need > out_cap {
        return -2;
    }
    let ob = core::slice::from_raw_parts_mut(out, out_cap);
    let mut p = 0usize;
    ob[p] = (15 << 3) | 2;
    p += 1;
    wr_varint(ob, &mut p, inner_len as u64);
    if total > 0 {
        ob[p] = 1 << 3;
        p += 1;
        wr_varint(ob, &mut p, total as u64);
    }
    if offset > 0 {
        ob[p] = 2 << 3;
        p += 1;
        wr_varint(ob, &mut p, offset as u64);
    }
    if n > 0 {
        ob[p] = (3 << 3) | 2;
        p += 1;
        wr_varint(ob, &mut p, n as u64);
        ob[p..p + n].copy_from_slice(&chunk[..n]);
        p += n;
    }
    if has_topo {
        ob[p] = 4 << 3;
        p += 1;
        ob[p] = 1;
        p += 1;
    }
    p as i32
}

/// Bytes a base-128 varint of `v` occupies.
fn varint_len(mut v: u64) -> usize {
    let mut n = 1;
    while v >= 0x80 {
        v >>= 7;
        n += 1;
    }
    n
}

/// Write `v` as a base-128 varint into `buf[*p..]`, advancing `*p`.
fn wr_varint(buf: &mut [u8], p: &mut usize, mut v: u64) {
    while v >= 0x80 {
        buf[*p] = (v as u8) | 0x80;
        *p += 1;
        v >>= 7;
    }
    buf[*p] = v as u8;
    *p += 1;
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
    let m = pb::ChunkAck {
        r#upload_id,
        r#seq,
    };
    let reply = pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::ChunkAck(m)) };
    encode_reply(&reply, out, out_cap)
}

/// Refill callback for [`lm_decode_upload_stream`]: fill up to `cap` bytes at
/// `buf` from the caller's source (a LittleFS read), returning the count, or 0
/// at EOF. Not called again after it returns 0 until a `rewind`.
pub type LmRefill = extern "C" fn(ctx: *mut c_void, buf: *mut u8, cap: usize) -> usize;

/// Rewind callback for [`lm_decode_upload_stream`]: reset the caller's source so
/// the next `refill` returns the frame's first byte again (a LittleFS seek to 0).
pub type LmRewind = extern "C" fn(ctx: *mut c_void);

/// Decode a reassembled upload frame that the caller streams in block-by-block
/// via `refill` — so a whole ~15 KB submit_map is never resident (the C6 keeps
/// it on flash, not in a big static buffer). `arm` selects the decoder
/// (ARM_SUBMIT_MAP / ARM_SUBMIT_TOPOLOGY); `total_len` is the frame's exact byte
/// length. A topology is read twice (count, then exact-size fill), with
/// `rewind` between the passes; a map is read once. Populates MAP/TOPO exactly
/// like the in-RAM path and returns the encoded reply (result_ready / error) in
/// `out`.
///
/// # Safety
/// `refill` must write ≤ `cap` bytes; `out` must point to `out_cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_decode_upload_stream(
    arm: i32,
    refill: LmRefill,
    rewind: LmRewind,
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
        ARM_SUBMIT_TOPOLOGY => handle_topology_upload(
            reader,
            |r: &mut BlockReader<_>| {
                rewind(ctx);
                r.reset();
            },
            total_len,
        ),
        _ => upload_malformed(),
    };
    encode_reply(&reply, out, out_cap)
}

// -- effects protocol dispatch (submit_effect / set_effect / set_uniforms /
//    get_effect_uniforms) -----------------------------------------------------
//
// These read the frame IN PLACE through pbview views (client_arm), so a full
// `.fxb` (up to FX_MAX_BYTES) and any number of uniform slots go straight from
// the RX buffer into the fixed statics the VM already owns — no by-value
// envelope, and none of the firmware micropb profile's capacity stubs.

/// ClientMessage oneof field numbers for the effect arms.
const ARM_SUBMIT_EFFECT: u32 = 21;
const ARM_SET_EFFECT: u32 = 22;
const ARM_SET_UNIFORMS: u32 = 23;
const ARM_GET_EFFECT_UNIFORMS: u32 = 24;
const ARM_SET_PERF: u32 = 25;
const ARM_GET_PERF_REPORT: u32 = 26;
const ARM_SET_TEXTURE: u32 = 28;
const ARM_SET_JIT: u32 = 32;
const ARM_LIST_EFFECTS: u32 = 36;
const ARM_SAVE_KEYPOINT: u32 = 40;
const ARM_DELETE_KEYPOINT: u32 = 41;
const ARM_LIST_KEYPOINTS: u32 = 42;
const ARM_GET_KEYPOINT: u32 = 43;
const ARM_BLEND_KEYPOINTS: u32 = 44;
const ARM_GET_TLS_INFO: u32 = 45;
const ARM_SET_FPS: u32 = 46;
const ARM_GET_SENSORS: u32 = 48;
const ARM_CALIBRATE_SENSORS: u32 = 49;
const ARM_SCAN_I2C: u32 = 50;
const ARM_SUBMIT_DRIVER: u32 = 51;
const ARM_REMOVE_DRIVER: u32 = 52;
const ARM_GET_DRIVER_STATE: u32 = 53;
const ARM_SET_SENSOR_MOUNT: u32 = 54;
const ARM_SET_CAPTURE_PROFILE: u32 = 55;
const ARM_GET_CAPTURE_PROFILE: u32 = 56;

/// The protocol features this firmware serves: welcome.features and the agent
/// manifest's protocol.features (/.well-known/splanc.json), so a client needn't
/// infer them from fw_version.
pub const FEATURES: &[&str] =
    &[
        "effects",
        "perf",
        "textures",
        "stored_map",
        "uniform_commit",
        "list_effects",
        "fixture_pose",
        "time_base",
        "decks",
        "crossfade",
        "keypoints",
        "tls_info",
        "fps",
        "sensors",
        "drivers",
        "imu_extrinsic",
        "capture_profile",
        "ota",
    ];

/// Read a base-128 varint at `buf[*o..]`, advancing `*o`. None on truncation.
/// (The set_texture RLE payload's run lengths; protobuf fields go through
/// pbview.)
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

/// submit_effect: read fxb + activate + deck from the frame in place, load it
/// onto the deck, and (optionally) activate. Reply result_ready(effect_id) or
/// error(bad_fxb / effect_too_large).
unsafe fn handle_submit_effect(frame: &[u8]) -> pb::ServerMessage {
    let Some(CArm::SubmitEffect(m)) = client_arm(frame) else {
        return fx_error("bad_fxb", "submit_effect is malformed");
    };
    let fxb = pbview::has_field(m.as_bytes(), pv::SubmitEffectView::FIELD_FXB).then(|| m.fxb());
    let activate = m.activate();
    let d = deck_index(m.deck());
    FX_LAST_DECK = d as u32;
    let Some(fxb) = fxb else {
        return fx_error("bad_fxb", "submit_effect without fxb");
    };
    match fx_load(d, fxb) {
        Ok(()) => {}
        Err(FxLoadError::TooLarge) => {
            return fx_error("effect_too_large", "fxb exceeds this player's effect buffer")
        }
        Err(FxLoadError::ArenaFull) => {
            return fx_error("effect_too_large", "the two decks' buffers exceed the 24 KB fx arena")
        }
        Err(FxLoadError::Bad) => return fx_error("bad_fxb", "fxb failed to parse"),
    }
    // activate=true takes over rendering now; false parks it (loaded + valid,
    // set_effect can activate later).
    fx_set_active(d, activate);
    let mut r = pb::ResultReady::default();
    // effect_id echoes back so the app can correlate the ack; also latch it (the
    // deck's keypoints live under it; deck A's pins the PerfReport identity).
    let id = if pbview::has_field(m.as_bytes(), pv::SubmitEffectView::FIELD_EFFECT_ID) {
        m.effect_id()
    } else {
        ""
    };
    let _ = r.r#map_id.push_str(id);
    if let Some(p) = deck(d) {
        let n = id.len().min((*p).id.len());
        (*p).id[..n].copy_from_slice(&id.as_bytes()[..n]);
        (*p).id_len = n;
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
    let Some(CArm::SetTexture(t)) = client_arm(frame) else {
        return;
    };
    let (tex_index, format, width, height, flags) = (
        u64::from(t.tex_index()),
        u64::from(t.format()),
        u64::from(t.width()),
        u64::from(t.height()),
        u64::from(t.flags()),
    );
    let data = t.data();
    let mut palette = [0u32; TEX_PAL_MAX]; // INDEXED8 lookup (0x00RRGGBB)
    for (slot, v) in palette.iter_mut().zip(t.palette()) {
        *slot = v;
    }
    // Resolve the target texture in deck A's program (video drives deck A).
    let bytes = &(*addr_of!(DECK_A.bytes))[..DECK_A.len];
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
    // The delta buffer shares the aux region with deck B: dropped while deck B
    // is loaded (the mutex is explicit — see FxAux).
    let Some(prev) = tex_prev() else {
        return;
    };
    let prev = &mut prev[..total];
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
    let arena = &mut (*addr_of_mut!(FX_ARENA))[DECK_A.arena_off..DECK_A.arena_off + DECK_A.arena_len];
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
            // `k` drives both the channel value (`ch[k]`) and the byte offset
            // (`ab + k * cb`) into the arena, so an iterator would obscure it.
            #[allow(clippy::needless_range_loop)]
            for k in 0..chans {
                let o = ab + k * cb;
                ledmapper_fx_vm::comp_store_num(comp, ch[k], arena.get_unchecked_mut(o..o + cb));
            }
        }
    }
}

/// The deck the last effect arm targeted (0 = A). main.cpp persists only deck
/// A's frames (deck B is runtime-only), so it reads this after the handle.
static mut FX_LAST_DECK: u32 = 0;

/// The deck the effect arm just handled targeted (0 = A, 1 = B).
///
/// # Safety
/// Single firmware thread, after `lm_player_handle`.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_last_deck() -> u32 {
    FX_LAST_DECK
}

/// A wire `deck` field → a deck index (anything but 1 is deck A, so an older
/// client that never sets it keeps today's single-deck behaviour).
fn deck_index(deck: u32) -> usize {
    if deck == 1 {
        DECK_B_IDX
    } else {
        DECK_A_IDX
    }
}

/// set_effect: "" / "off" clears the deck — deck A back to idle; deck B parks
/// (stays loaded, inactive) so a show can bring it back without a re-upload
/// (a second "off" on a parked deck B frees it). Any other id activates whatever
/// the deck holds (one effect per deck). Reply: playback_state (via the session
/// core, so the app's playback UI stays consistent).
unsafe fn handle_set_effect(frame: &[u8]) -> pb::ServerMessage {
    let (id, d) = match client_arm(frame) {
        Some(CArm::SetEffect(m)) => (m.effect_id(), deck_index(m.deck())),
        _ => ("", DECK_A_IDX),
    };
    FX_LAST_DECK = d as u32;
    if id.is_empty() || id == "off" {
        if d == DECK_B_IDX && deck_renders(DECK_B_IDX) {
            fx_set_active(DECK_B_IDX, false);
        } else {
            fx_clear(d);
        }
    } else {
        fx_set_active(d, true);
    }
    // Ack with the session's playback state so the app's playback UI stays put.
    player().playback_reply()
}

/// Whether the last set_uniforms asked to be persisted (SetUniforms.commit; unset =
/// true, the old always-persist behaviour). main.cpp reads it to skip the
/// coalesced save of an uncommitted (live-only) update.
static mut UNIFORMS_COMMIT: bool = true;

/// Whether the set_uniforms just handled should be persisted (see `UNIFORMS_COMMIT`).
///
/// # Safety
/// Single firmware thread, after `lm_player_handle`.
#[no_mangle]
pub unsafe extern "C" fn lm_set_uniforms_commit() -> bool {
    UNIFORMS_COMMIT
}

/// set_uniforms: apply every UniformValue{slot, value[]} to the deck's VM (a
/// running keypoint morph on that deck stops where it is — the slider wins).
/// Reply: playback_state.
unsafe fn handle_set_uniforms(frame: &[u8]) -> pb::ServerMessage {
    UNIFORMS_COMMIT = true;
    FX_LAST_DECK = 0;
    if let Some(CArm::SetUniforms(m)) = client_arm(frame) {
        let d = deck_index(m.deck());
        FX_LAST_DECK = d as u32;
        // SetUniforms.commit: unset = persist (the old always-persist behaviour).
        // Deck B is never persisted.
        UNIFORMS_COMMIT = m.commit().unwrap_or(true) && d == DECK_A_IDX;
        if let Some(p) = deck(d) {
            (*p).morph.cancel();
        }
        for uv in m.values() {
            // UniformValue { slot, repeated float value } — packed or not.
            let mut vals = [0.0f32; 4];
            let mut n = 0;
            for (dst, v) in vals.iter_mut().zip(uv.value()) {
                *dst = v;
                n += 1;
            }
            if n > 0 {
                fx_set_uniform(d, uv.slot(), &vals[..n]);
            }
        }
    }
    player().playback_reply()
}

/// A protobuf writer over the reply buffer that can also just count (for the
/// length prefix of a message written in place). `n` is bytes written/counted;
/// `ok` turns false when a real write would overflow.
struct PbOut<'a> {
    buf: Option<&'a mut [u8]>,
    n: usize,
    ok: bool,
}

impl PbOut<'_> {
    fn byte(&mut self, b: u8) {
        if let Some(buf) = self.buf.as_deref_mut() {
            match buf.get_mut(self.n) {
                Some(slot) => *slot = b,
                None => self.ok = false,
            }
        }
        self.n += 1;
    }
    fn varint(&mut self, mut v: u64) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                self.byte(b);
                return;
            }
            self.byte(b | 0x80);
        }
    }
    fn key(&mut self, field: u32, wire: u8) {
        self.varint(((field as u64) << 3) | wire as u64);
    }
    fn uint(&mut self, field: u32, v: u64) {
        self.key(field, 0);
        self.varint(v);
    }
    fn bytes(&mut self, field: u32, b: &[u8]) {
        self.key(field, 2);
        self.varint(b.len() as u64);
        for &x in b {
            self.byte(x);
        }
    }
    /// A `{ uint32 slot_or_name = 1; repeated float value = 2 [packed]; }`
    /// submessage (UniformValue / KeypointValue) at `field`; `key1` is the
    /// slot (varint) or the name (bytes).
    fn value_msg(&mut self, field: u32, key1: ValueKey, vals: &[f32]) {
        let k1 = match key1 {
            ValueKey::Slot(s) => 1 + varint_len(s as u64),
            ValueKey::Name(n) => 1 + varint_len(n.len() as u64) + n.len(),
        };
        let inner = k1 + 1 + varint_len((vals.len() * 4) as u64) + vals.len() * 4;
        self.key(field, 2);
        self.varint(inner as u64);
        match key1 {
            ValueKey::Slot(s) => self.uint(1, s as u64),
            ValueKey::Name(n) => self.bytes(1, n),
        }
        self.key(2, 2);
        self.varint((vals.len() * 4) as u64);
        for v in vals {
            for b in v.to_le_bytes() {
                self.byte(b);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum ValueKey<'a> {
    Slot(u32),
    Name(&'a [u8]),
}

/// Write `ServerMessage.<field>` (a LEN arm) around the body `body` writes, in
/// ONE pass: the body goes in after a reserved 4-byte key+length header, which
/// is then filled and the body slid down to meet it. Bodies are < 16 KiB.
unsafe fn write_arm(out: *mut u8, out_cap: usize, field: u32, body: impl FnOnce(&mut PbOut)) -> i32 {
    const HDR: usize = 4;
    if out_cap <= HDR {
        return -2;
    }
    let buf = core::slice::from_raw_parts_mut(out, out_cap);
    let n = {
        let mut w = PbOut { buf: Some(&mut buf[HDR..]), n: 0, ok: true };
        body(&mut w);
        if !w.ok || w.n >= 1 << 14 {
            return -2;
        }
        w.n
    };
    let mut h = PbOut { buf: Some(&mut buf[..HDR]), n: 0, ok: true };
    h.key(field, 2);
    h.varint(n as u64);
    let hn = h.n;
    buf.copy_within(HDR..HDR + n, hn);
    (hn + n) as i32
}

/// The EffectUniforms fields (effect_id, manifest, current, textures, deck) of
/// deck `d`'s loaded effect, into `w`.
unsafe fn write_effect_uniforms(w: &mut PbOut, d: usize, p: *mut DeckState, prog: &Program) {
    let id = &(*p).id[..(*p).id_len];
    if !id.is_empty() {
        w.bytes(1, id);
    }
    w.bytes(2, prog.manifest);
    // current = 3: each manifest uniform's live value, read back from the VM.
    // Deck A walks the OSC table (every uniform it can drive); deck B its blend
    // rules (the same uniforms, within the keypoint bounds).
    if let Some(vm) = (*p).vm.as_ref() {
        let mut put = |slot: usize, width: usize| {
            if let Some(vals) = vm.uniforms.get(slot..slot + width) {
                w.value_msg(3, ValueKey::Slot(slot as u32), vals);
            }
        };
        if d == DECK_A_IDX {
            for port in (*addr_of!(OSC_TABLE)).ports() {
                put(port.slot as usize, port.width as usize);
            }
        } else {
            for r in (*p).morph.rules.rules() {
                put(r.slot as usize, r.width as usize);
            }
        }
    }
    // textures = 4: the declared 2D textures (buffer kind=1), so a texture source
    // learns the exact dimensions set_texture requires (a mismatch is dropped).
    for i in 0..prog.n_buffers as usize {
        let Some(bd) = prog.buf_desc(i) else { continue };
        if bd.kind != 1 {
            continue;
        }
        let fields = [(1, i as u64), (2, bd.w as u64), (3, bd.h as u64), (4, bd.elem as u64)];
        let inner: usize = fields.iter().map(|&(_, v)| 1 + varint_len(v)).sum();
        w.key(4, 2);
        w.varint(inner as u64);
        for (f, v) in fields {
            w.uint(f, v);
        }
    }
    if d != DECK_A_IDX {
        w.uint(5, d as u64);
    }
}

/// get_effect_uniforms: the deck's EffectUniforms (its id, the uniform manifest
/// from its .fxb, each uniform's current value, its texture ports), encoded
/// straight into `out` — the manifest is effect-sized, well past the firmware
/// profile's inline bytes cap. Error `no_effect` when the deck has nothing active.
unsafe fn handle_get_effect_uniforms(frame: &[u8], out: *mut u8, out_cap: usize) -> i32 {
    let no_effect = || encode_reply(&fx_error("no_effect", "no active effect to describe"), out, out_cap);
    let d = match client_arm(frame) {
        Some(CArm::GetEffectUniforms(m)) => deck_index(m.deck()),
        _ => DECK_A_IDX,
    };
    let Some(p) = deck(d) else { return no_effect() };
    if !(*p).renders() {
        return no_effect();
    }
    let bytes = &(*p).bytes[..(*p).len];
    let Ok(prog) = Program::parse(bytes) else {
        return no_effect();
    };
    write_arm(out, out_cap, 16, |w| write_effect_uniforms(w, d, p, &prog))
}

/// set_fps: pin the effect framerate to `target_fps` (snapped to the 5-fps
/// ladder; 0 = autoscale) and set the no-abort hold. Reply: fps_state, so the
/// app's control reflects what the player actually adopted.
unsafe fn handle_set_fps(frame: &[u8]) -> pb::ServerMessage {
    let (target, no_abort) = match client_arm(frame) {
        Some(CArm::SetFps(m)) => (m.target_fps(), m.no_abort()),
        _ => (0, false),
    };
    let c = &mut *addr_of_mut!(FPS);
    // set_target snaps onto the ladder (held to the strip's floor and wire
    // ceiling); cap first so a wild value can't overflow the snap arithmetic.
    c.set_target(target.min(MAX_FPS));
    c.set_abort_enabled(!no_abort);
    build_fps_state(false)
}

/// An FpsState from the live autoscaler; `aborted` flags the unsolicited push
/// sent when the effect was parked because its target couldn't be held.
unsafe fn build_fps_state(aborted: bool) -> pb::ServerMessage {
    let c = &*addr_of!(FPS);
    let mut s = pb::FpsState::default();
    s.r#target_fps = c.pinned_fps();
    s.r#current_fps = c.current_fps();
    // The abort floor for this strip (25 fps up to 512 LEDs, lower past it).
    s.r#min_fps = c.min_fps();
    // The ladder's top as the strip's wire allows it (MAX_FPS when unbounded).
    s.r#max_fps = c.max_fps();
    s.r#auto = !c.is_pinned();
    s.r#aborted = aborted;
    s.r#no_abort = !c.abort_enabled();
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::FpsState(s)) }
}

/// get_tls_info: the per-device TLS identity as the firmware last published it.
unsafe fn handle_get_tls_info() -> pb::ServerMessage {
    let mut t = pb::TlsInfo::default();
    let _ = t.r#state.push_str(tls_state());
    let _ = t.r#cert_sha256.push_str(tls_sha());
    t.r#persisted = (*addr_of!(TLS_ID)).persisted;
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::TlsInfo(t)) }
}

/// list_effects: one entry per loaded deck (deck A's is the persisted one: boot
/// replays it), as an EffectList.
unsafe fn handle_list_effects() -> pb::ServerMessage {
    let mut list = pb::EffectList::default();
    for d in 0..N_DECKS {
        let Some(p) = deck(d) else { continue };
        if !(*p).loaded() {
            continue;
        }
        let mut e = pb::StoredEffect::default();
        let _ = e.r#effect_id.push_str((*p).effect_id());
        e.r#fxb_bytes = (*p).len as u32;
        e.r#active = (*p).active;
        e.r#deck = d as u32;
        let _ = list.r#effects.push(e);
    }
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::EffectList(list)) }
}

// -- uniform keypoints (docs/design/uniform-keypoints.md) ---------------------
// Rust owns the format and the blend (ledmapper_keypoint); C++ owns the
// filesystem and hands three hooks in at boot (lm_kp_set_store). One small
// littlefs file per keypoint: "kp_<fnv32(effect_id)>.<index>" under the FS base,
// written power-loss-safe by the C++ side (temp + fsync + rename).

type KpRead = unsafe extern "C" fn(name: *const u8, name_len: usize, buf: *mut u8, cap: usize) -> i32;
type KpWrite = unsafe extern "C" fn(name: *const u8, name_len: usize, buf: *const u8, len: usize) -> bool;
type KpRemove = unsafe extern "C" fn(name: *const u8, name_len: usize);

static mut KP_READ: Option<KpRead> = None;
static mut KP_WRITE: Option<KpWrite> = None;
static mut KP_REMOVE: Option<KpRemove> = None;
/// The one record buffer (save encodes into it, every read lands in it).
static mut KP_IO: [u8; kp::RECORD_CAP] = [0; kp::RECORD_CAP];
/// Whether the blend just handled asked to persist its target (deck A only).
static mut KP_COMMIT: bool = false;
/// Deck A's last blend target, for lm_kp_commit_frame.
static mut KP_COMMIT_DECK: usize = DECK_A_IDX;

/// Install the keypoint store hooks (C++: littlefs). Without them every
/// keypoint arm answers `no_store`.
///
/// # Safety
/// The hooks must be valid for the process lifetime; single firmware thread.
#[no_mangle]
pub unsafe extern "C" fn lm_kp_set_store(read: Option<KpRead>, write: Option<KpWrite>, remove: Option<KpRemove>) {
    KP_READ = read;
    KP_WRITE = write;
    KP_REMOVE = remove;
}

/// "kp_xxxxxxxx.n" for effect key `key`, index `n`.
fn kp_file(key: u32, n: usize) -> ([u8; 16], usize) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut b = [0u8; 16];
    b[..3].copy_from_slice(b"kp_");
    for i in 0..8 {
        b[3 + i] = HEX[((key >> (28 - 4 * i)) & 0xf) as usize];
    }
    b[11] = b'.';
    let mut len = 12;
    if n >= 10 {
        b[len] = b'0' + (n / 10) as u8;
        len += 1;
    }
    b[len] = b'0' + (n % 10) as u8;
    (b, len + 1)
}

/// Read record `n` of effect `key` into KP_IO; its length, if it exists.
unsafe fn kp_read(key: u32, n: usize) -> Option<usize> {
    let read = KP_READ?;
    let (f, fl) = kp_file(key, n);
    let io = &mut *addr_of_mut!(KP_IO);
    let got = read(f.as_ptr(), fl, io.as_mut_ptr(), io.len());
    (got > 0).then_some(got as usize)
}

/// The stored index of keypoint `name` for effect `key`.
unsafe fn kp_find(key: u32, name: &[u8]) -> Option<usize> {
    (0..kp::MAX_KEYPOINTS).find(|&n| {
        kp_read(key, n).is_some_and(|len| kp::record_info(&(*addr_of!(KP_IO))[..len]).is_ok_and(|i| i.name == name))
    })
}

/// Which effect a keypoint arm addresses: `effect_id` if given, else the one
/// loaded on the deck. (key, the deck when it holds that effect).
unsafe fn kp_target(d: usize, effect_id: Option<&str>) -> Result<(u32, Option<*mut DeckState>), pb::ServerMessage> {
    if (*addr_of!(KP_READ)).is_none() || (*addr_of!(KP_WRITE)).is_none() {
        return Err(fx_error("no_store", "keypoint storage is unavailable"));
    }
    let loaded = deck(d).filter(|p| (**p).loaded());
    let id = match (effect_id, loaded) {
        (Some(id), _) if !id.is_empty() => id,
        (_, Some(p)) => (*p).effect_id(),
        _ => return Err(fx_error("no_effect", "no effect loaded on that deck")),
    };
    if id.is_empty() {
        return Err(fx_error("no_effect", "the deck's effect has no effect_id"));
    }
    let on_deck = loaded.filter(|p| (**p).effect_id() == id);
    Ok((kp::fnv1a(id.as_bytes()), on_deck))
}

/// The KeypointList reply for effect `key` (stale = saved against another build
/// of the effect on the deck).
unsafe fn kp_list_reply(d: usize, key: u32, effect_id: &str, on_deck: Option<*mut DeckState>, out: *mut u8, cap: usize) -> i32 {
    let hash = on_deck.map(|p| (*p).morph.rules.manifest_hash);
    write_arm(out, cap, 22, |w| {
        w.bytes(1, effect_id.as_bytes());
        if d != DECK_A_IDX {
            w.uint(2, d as u64);
        }
        for n in 0..kp::MAX_KEYPOINTS {
            let Some(len) = kp_read(key, n) else { continue };
            let Ok(info) = kp::record_info(&(*addr_of!(KP_IO))[..len]) else { continue };
            let stale = hash.is_some_and(|h| h != info.manifest_hash);
            let inner = 1 + varint_len(n as u64) + 1 + varint_len(info.name.len() as u64) + info.name.len() + if stale { 2 } else { 0 };
            w.key(3, 2);
            w.varint(inner as u64);
            w.uint(1, n as u64);
            w.bytes(2, info.name);
            if stale {
                w.uint(3, 1);
            }
        }
        w.uint(4, kp::MAX_KEYPOINTS as u64);
    })
}

/// The effect id a keypoint arm resolved to (for the reply).
unsafe fn kp_effect_id<'a>(given: Option<&'a str>, on_deck: Option<*mut DeckState>, d: usize) -> &'a str {
    match given {
        Some(id) if !id.is_empty() => id,
        _ => on_deck.or_else(|| deck(d)).map(|p| (*p).effect_id()).unwrap_or(""),
    }
}

/// Reply with `msg` encoded into `out`.
fn reply_msg(msg: &pb::ServerMessage, out: *mut u8, cap: usize) -> i32 {
    encode_reply(msg, out, cap)
}

unsafe fn handle_list_keypoints(frame: &[u8], out: *mut u8, cap: usize) -> i32 {
    let Some(CArm::ListKeypoints(m)) = client_arm(frame) else {
        return reply_msg(&fx_error("bad_keypoint", "list_keypoints is malformed"), out, cap);
    };
    let d = deck_index(m.deck());
    match kp_target(d, m.effect_id()) {
        Ok((key, on_deck)) => {
            let id = kp_effect_id(m.effect_id(), on_deck, d);
            kp_list_reply(d, key, id, on_deck, out, cap)
        }
        Err(e) => reply_msg(&e, out, cap),
    }
}

unsafe fn handle_save_keypoint(frame: &[u8], out: *mut u8, cap: usize) -> i32 {
    let Some(CArm::SaveKeypoint(m)) = client_arm(frame) else {
        return reply_msg(&fx_error("bad_keypoint", "save_keypoint is malformed"), out, cap);
    };
    let d = deck_index(m.deck());
    let (key, on_deck) = match kp_target(d, None) {
        Ok(t) => t,
        Err(e) => return reply_msg(&e, out, cap),
    };
    let Some(p) = on_deck else {
        return reply_msg(&fx_error("no_effect", "no effect loaded on that deck"), out, cap);
    };
    let name = m.name().as_bytes();
    if name.is_empty() || name.len() > kp::MAX_NAME {
        return reply_msg(&fx_error("bad_keypoint", "keypoint names are 1..32 bytes"), out, cap);
    }
    let rules = &(*p).morph.rules;
    if rules.is_empty() {
        return reply_msg(&fx_error("bad_keypoint", "the effect declares no uniforms"), out, cap);
    }
    // The values: the deck's live uniforms, or the given slot-addressed ones.
    let mut vals = kp::UNSET;
    let mut explicit = false;
    for uv in m.values() {
        explicit = true;
        let Some(r) = rules.by_slot(uv.slot()) else { continue };
        let mut c = (uv.slot() - r.slot as u32) as usize;
        for v in uv.value() {
            if c >= r.width as usize {
                break;
            }
            vals[r.off as usize + c] = v;
            c += 1;
        }
    }
    if !explicit {
        if let Some(vm) = (*p).vm.as_ref() {
            vals = rules.pack(&vm.uniforms);
        }
    }
    let Ok(prog) = Program::parse(&(*p).bytes[..(*p).len]) else {
        return reply_msg(&fx_error("no_effect", "no effect loaded on that deck"), out, cap);
    };
    // Overwrite in place by name, else the first free index.
    let slot = kp_find(key, name).or_else(|| (0..kp::MAX_KEYPOINTS).find(|&n| kp_read(key, n).is_none()));
    let Some(n) = slot else {
        return reply_msg(&fx_error("keypoint_full", "16 keypoints per effect; delete one first"), out, cap);
    };
    let io = &mut *addr_of_mut!(KP_IO);
    let len = match kp::encode_record(name, prog.manifest, rules, &vals, io) {
        Ok(len) => len,
        Err(_) => return reply_msg(&fx_error("bad_keypoint", "keypoint does not encode"), out, cap),
    };
    let (f, fl) = kp_file(key, n);
    let ok = KP_WRITE.is_some_and(|w| w(f.as_ptr(), fl, io.as_ptr(), len));
    if !ok {
        return reply_msg(&fx_error("no_store", "keypoint write failed"), out, cap);
    }
    (*p).morph.invalidate();
    let id = (*p).effect_id();
    kp_list_reply(d, key, id, on_deck, out, cap)
}

unsafe fn handle_delete_keypoint(frame: &[u8], out: *mut u8, cap: usize) -> i32 {
    let Some(CArm::DeleteKeypoint(m)) = client_arm(frame) else {
        return reply_msg(&fx_error("bad_keypoint", "delete_keypoint is malformed"), out, cap);
    };
    let d = deck_index(m.deck());
    let (key, on_deck) = match kp_target(d, m.effect_id()) {
        Ok(t) => t,
        Err(e) => return reply_msg(&e, out, cap),
    };
    let Some(n) = kp_find(key, m.name().as_bytes()) else {
        return reply_msg(&fx_error("no_keypoint", "no keypoint by that name"), out, cap);
    };
    if let Some(rm) = KP_REMOVE {
        let (f, fl) = kp_file(key, n);
        rm(f.as_ptr(), fl);
    }
    for dd in 0..N_DECKS {
        if let Some(p) = deck(dd) {
            (*p).morph.invalidate();
        }
    }
    let id = kp_effect_id(m.effect_id(), on_deck, d);
    kp_list_reply(d, key, id, on_deck, out, cap)
}

unsafe fn handle_get_keypoint(frame: &[u8], out: *mut u8, cap: usize) -> i32 {
    let Some(CArm::GetKeypoint(m)) = client_arm(frame) else {
        return reply_msg(&fx_error("bad_keypoint", "get_keypoint is malformed"), out, cap);
    };
    let d = deck_index(m.deck());
    let (key, on_deck) = match kp_target(d, m.effect_id()) {
        Ok(t) => t,
        Err(e) => return reply_msg(&e, out, cap),
    };
    let Some(n) = kp_find(key, m.name().as_bytes()) else {
        return reply_msg(&fx_error("no_keypoint", "no keypoint by that name"), out, cap);
    };
    let Some(len) = kp_read(key, n) else {
        return reply_msg(&fx_error("no_keypoint", "no keypoint by that name"), out, cap);
    };
    let rec = &(*addr_of!(KP_IO))[..len];
    let Ok(info) = kp::record_info(rec) else {
        return reply_msg(&fx_error("no_keypoint", "keypoint record is corrupt"), out, cap);
    };
    let id = kp_effect_id(m.effect_id(), on_deck, d);
    let rules = on_deck.map(|p| &(*p).morph.rules);
    let stale = rules.is_some_and(|r| r.manifest_hash != info.manifest_hash);
    // A full keypoint (32 uniforms, by name AND by slot) can outgrow a 2 KiB
    // reply buffer: then the by-slot copy is dropped (the client resolves names
    // through the manifest it already has).
    let r = kp_keypoint_reply(out, cap, id, n, info.name, stale, rec, rules);
    if r >= 0 {
        return r;
    }
    let r = kp_keypoint_reply(out, cap, id, n, info.name, stale, rec, None);
    if r >= 0 {
        return r;
    }
    reply_msg(&fx_error("too_large", "keypoint exceeds the reply buffer"), out, cap)
}

#[allow(clippy::too_many_arguments)]
unsafe fn kp_keypoint_reply(
    out: *mut u8,
    cap: usize,
    id: &str,
    n: usize,
    name: &[u8],
    stale: bool,
    rec: &[u8],
    rules: Option<&kp::Rules>,
) -> i32 {
    write_arm(out, cap, 23, |w| {
        w.bytes(1, id.as_bytes());
        w.uint(2, n as u64);
        w.bytes(3, name);
        if stale {
            w.uint(4, 1);
        }
        let _ = kp::for_each_value(rec, |uname, v| w.value_msg(5, ValueKey::Name(uname), v));
        if let Some(r) = rules {
            let _ = kp::for_each_value(rec, |uname, v| {
                if let Some(rule) = r.by_name(uname) {
                    if rule.width as usize == v.len() {
                        w.value_msg(6, ValueKey::Slot(rule.slot as u32), v);
                    }
                }
            });
        }
    })
}

unsafe fn handle_blend_keypoints(frame: &[u8]) -> pb::ServerMessage {
    KP_COMMIT = false;
    let Some(CArm::BlendKeypoints(m)) = client_arm(frame) else {
        return fx_error("bad_keypoint", "blend_keypoints is malformed");
    };
    let d = deck_index(m.deck());
    FX_LAST_DECK = d as u32;
    let (key, on_deck) = match kp_target(d, None) {
        Ok(t) => t,
        Err(e) => return e,
    };
    let Some(p) = on_deck else {
        return fx_error("no_effect", "no effect loaded on that deck");
    };
    let mut names: [&[u8]; kp::MAX_BLEND] = [b""; kp::MAX_BLEND];
    let mut weights = [0.0f32; kp::MAX_BLEND];
    let mut n = 0;
    for kw in m.weights() {
        if n >= kp::MAX_BLEND {
            return fx_error("bad_keypoint", "at most 4 keypoints per blend");
        }
        names[n] = kw.name().as_bytes();
        weights[n] = if kw.weight().is_finite() { kw.weight() } else { 0.0 };
        n += 1;
    }
    if n == 0 || !weights[..n].iter().any(|w| *w > 0.0) {
        return fx_error("bad_keypoint", "blend needs a keypoint with a positive weight");
    }
    let morph = &mut (*p).morph;
    // The fader path: the same names as last time reuse the cached sources (no
    // flash read per fader tick).
    if !morph.cached(key, &names[..n]) {
        morph.begin_sources(key);
        for name in &names[..n] {
            let Some(len) = kp_find(key, name).and_then(|i| kp_read(key, i)) else {
                morph.invalidate();
                return fx_error("no_keypoint", "no keypoint by that name");
            };
            let mut vals = kp::UNSET;
            if kp::decode_record(&(*addr_of!(KP_IO))[..len], &morph.rules, &mut vals).is_err() {
                morph.invalidate();
                return fx_error("no_keypoint", "keypoint record is corrupt");
            }
            morph.push_source(name, &vals);
        }
    }
    let Some(vm) = (*p).vm.as_mut() else {
        return fx_error("no_effect", "no effect loaded on that deck");
    };
    let live = morph.rules.pack(&vm.uniforms);
    let seconds = if m.seconds().is_finite() { m.seconds().min(3600.0) } else { 0.0 };
    if let Some(v) = morph.start(&live, &weights[..n], seconds, m.color_mode()) {
        morph.rules.unpack(&v, |slot, vals| vm.set_uniform(slot as usize, vals));
    }
    KP_COMMIT = m.commit().unwrap_or(false) && d == DECK_A_IDX;
    KP_COMMIT_DECK = d;
    player().playback_reply()
}

/// Whether the blend_keypoints just handled asked to persist its target.
///
/// # Safety
/// Single firmware thread, after `lm_player_handle`.
#[no_mangle]
pub unsafe extern "C" fn lm_kp_commit() -> bool {
    KP_COMMIT
}

/// Encode the last blend's TARGET values as a deck-A `set_uniforms` ClientMessage
/// frame into `out` — what main.cpp persists for a committed blend (boot replays
/// it like any set_uniforms). Returns the length, or -2 when it doesn't fit.
///
/// # Safety
/// `out` must point to `cap` writable bytes; single firmware thread.
#[no_mangle]
pub unsafe extern "C" fn lm_kp_commit_frame(out: *mut u8, cap: usize) -> i32 {
    let Some(p) = deck(KP_COMMIT_DECK) else { return -1 };
    let target = (*p).morph.target();
    let rules = &(*p).morph.rules;
    write_arm(out, cap, ARM_SET_UNIFORMS, |w| {
        rules.unpack(&target, |slot, vals| w.value_msg(1, ValueKey::Slot(slot as u32), vals));
    })
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

// The per-frame overrun budget is no longer a fixed 33 ms: with the framerate
// autoscaler (FUG-82) it tracks the live target, budget_cycles = cpu_hz /
// current_fps (lm_fps_budget_cycles, build_perf_report).

/// set_perf: store the tier + push interval. Reply is an immediate PerfReport
/// (current window), like get_perf_report — so opening the panel gets one
/// synchronously. FULL flips on Tier-1 counting; OFF/BASIC skip it.
unsafe fn handle_set_perf(frame: &[u8]) -> pb::ServerMessage {
    // SetPerf { Mode mode = 1; uint32 interval_ms = 2; } (absent = OFF / 0).
    let (mode, interval) = match client_arm(frame) {
        Some(CArm::SetPerf(m)) => (m.mode() as u32, m.interval_ms()),
        _ => (PERF_OFF, 0),
    };
    PERF_MODE = if mode > PERF_FULL { PERF_FULL } else { mode };
    PERF_INTERVAL_MS = interval;
    // OFF clears the accumulated ring so a later BASIC/FULL starts clean.
    if PERF_MODE == PERF_OFF {
        perf_reset_ring();
    }
    build_perf_report()
}

/// set_jit: toggle the on-device JIT (FUG-125 debug/bench control). Takes effect
/// on the NEXT `lm_fx_load` (matching `lm_fx_set_jit_enabled`), so the caller
/// re-submits the effect — the HITL fx_bench sends this before submit_effect to
/// pin the interpreter (off) vs the JIT (on) for its two golden sets against the
/// SAME flashed firmware. Fire-and-forget: no reply, and message ordering on the
/// single-threaded player guarantees it lands before the following submit_effect.
unsafe fn handle_set_jit(frame: &[u8]) {
    // proto3 omits a `false` bool from the wire, so `set_jit(enabled=false)` is an
    // EMPTY body. Default to false and assign AFTER the walk (like handle_set_perf)
    // so an absent field correctly DISABLES the JIT — assigning only inside the
    // match arm would leave a set_jit(false) as a no-op at the default (on).
    let enabled = match client_arm(frame) {
        Some(CArm::SetJit(m)) => m.enabled(),
        _ => false,
    };
    FX_JIT_ENABLED = enabled;
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

    let id = core::str::from_utf8(&(*addr_of!(DECK_A.id))[..DECK_A.id_len]).unwrap_or("");
    // FUG-82: headroom is against the rate the effect actually runs at.
    let fps = (*addr_of!(FPS)).current_fps();
    let mut r = pb::PerfReport {
        // Identity.
        r#fxb_hash: DECK_A.hash,
        r#cpu_hz: PERF_CPU_HZ,
        r#budget_cycles: PERF_CPU_HZ / fps.max(1),
        r#current_fps: fps,
        // Rolling window.
        r#frame_cycles_min: w.frame_min,
        r#frame_cycles_mean: w.frame_mean,
        r#frame_cycles_max: w.frame_max,
        r#update_cycles_mean: w.update_mean,
        r#shade_cycles_mean: w.shade_mean,
        r#show_cycles_mean: w.show_mean,
        // Since-drain counters (reset on drain).
        r#overruns: ring.overruns,
        r#dropped_frames: ring.dropped_frames,
        r#samples_dropped: ring.samples_dropped,
        // Memory (heap is read on the C++ side and pushed via lm_perf_set_heap;
        // the latest values ride here).
        r#heap_free: PERF_HEAP_FREE,
        r#heap_min_free: PERF_HEAP_MIN_FREE,
        r#heap_largest_free: PERF_HEAP_LARGEST_FREE,
        ..Default::default()
    };
    let _ = r.r#effect_id.push_str(id);
    ring.overruns = 0;
    ring.dropped_frames = 0;
    ring.samples_dropped = 0;
    // Raw tail: drain oldest-first until the ticks field is at capacity; any
    // remaining samples stay in the ring for the next poll (no loss).
    while r.r#ticks.len() < r.r#ticks.capacity() {
        let Some(s) = ring.pop() else { break };
        let t = pb::PerfFrame {
            r#seq: s.seq,
            r#update_cycles: s.update_cycles,
            r#shade_cycles: s.shade_cycles,
            r#frame_cycles: s.frame_cycles,
            r#show_cycles: s.show_cycles,
            r#led_count: s.led_count,
            r#instr_update: s.instr_update,
            r#instr_shade: s.instr_shade,
            r#stack_max: s.stack_max,
        };
        let _ = r.r#ticks.push(t);
    }
    pb::ServerMessage { r#msg: Some(pb::ServerMessage_::Msg::PerfReport(r)) }
}

/// Latest heap figures, refreshed by main.cpp before each ring push (the FFI
/// core has no ESP-IDF; the C++ side reads esp_get_free_heap_size et al.).
static mut PERF_HEAP_FREE: u32 = 0;
static mut PERF_HEAP_MIN_FREE: u32 = 0;
static mut PERF_HEAP_LARGEST_FREE: u32 = 0;

/// Reset the ring + its counters (fresh effect / mode change). Latched Tier-1
/// counters are cleared too so a stale count can't leak into the next frame.
unsafe fn perf_reset_ring() {
    *addr_of_mut!(PERF_RING) = PerfRing::new();
    FX_INSTR_UPDATE = 0;
    FX_INSTR_SHADE = 0;
    FX_STACK_MAX = 0;
}

// -- render-side accessors (pure reads; the FastLED loop polls these) --------

/// Mapping-pattern timing, all INTEGER (the render loop touches no f64):
/// writes epoch_ms (i64), bit_period_us (u32), cycle_frames, led_count. False
/// when no capture is active. Absolute frame index at player-clock ms `t` is
/// `((t - epoch_ms) * 1000) / bit_period_us`.
///
/// # Safety
/// The pointer arguments must be null or point to writable/readable memory
/// of the documented size, and the global player must have been initialized
/// by [`lm_player_init`] and not be called reentrantly.
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
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_pattern_frame_shown(seq: u32, t_mono_us: u32) {
    player().record_frame_shown(seq, t_mono_us);
}

/// The color LED `led` shows in mapping cycle frame `frame_index`
/// (caller reduces modulo cycle_frames). False when no capture is active.
///
/// # Safety
/// The pointer arguments must be null or point to writable/readable memory
/// of the documented size, and the global player must have been initialized
/// by [`lm_player_init`] and not be called reentrantly.
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

/// The color LED `led` shows under the latched counting pattern (blocks
/// paint, everything else off). False when no counting pattern is latched.
///
/// # Safety
/// The pointer arguments must be null or point to writable/readable memory
/// of the documented size, and the global player must have been initialized
/// by [`lm_player_init`] and not be called reentrantly.
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
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_counting_len() -> u32 {
    player().counting_len()
}

/// The wire color order for the counting probe's pixels: writes the 3-byte
/// source-index permutation (R=0, G=1, B=2) into `perm`. This is the probe's
/// OWN order — independent of the committed per-channel color order — so the
/// color-order test drives the strip raw (identity) or through a previewed
/// candidate without touching the persisted config. Identity when none latched.
///
/// # Safety
/// The pointer arguments must be null or point to writable/readable memory
/// of the documented size, and the global player must have been initialized
/// by [`lm_player_init`] and not be called reentrantly.
#[no_mangle]
pub unsafe extern "C" fn lm_counting_color_order(perm: *mut u8) {
    let p = player().counting_color_order();
    *perm = p[0];
    *perm.add(1) = p[1];
    *perm.add(2) = p[2];
}

/// The hardware output channel the latched counting pattern paints (its block
/// indices are relative to that channel's strip start); 0 when none latched.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_counting_channel() -> u32 {
    player().counting_channel()
}

/// The LED count for `channel` (set_hardware_config / set_led_count, or the
/// boot seed); -1 when unset.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_led_count(channel: u32) -> i32 {
    match player().led_count(channel as usize) {
        Some(n) => n as i32,
        None => -1,
    }
}

/// Number of LEDs in the stored map; 0 when none stored.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_map_len() -> u32 {
    (*addr_of!(MAP_META)).as_ref().map_or(0, |(_, c)| *c)
}

/// The render position of LED `index`: id + xyz (meters). The map is
/// flash-backed — only positions are resident (FX_LED_POS); id == index (the
/// render is index-based). An LED the map left unmapped reports its position
/// interpolated from its mapped neighbours (see fill_unmapped), so it still
/// shades sensibly. False out of range.
///
/// # Safety
/// The pointer arguments must be null or point to writable/readable memory
/// of the documented size, and the global player must have been initialized
/// by [`lm_player_init`] and not be called reentrantly.
#[no_mangle]
pub unsafe extern "C" fn lm_map_led(index: u32, id: *mut u32, xyz: *mut f32) -> bool {
    let len = (*addr_of!(MAP_META)).as_ref().map_or(0, |(_, c)| *c);
    let i = index as usize;
    if index >= len || i >= fx_cap() {
        return false;
    }
    let pos = pos_get(i);
    *id = index;
    *xyz = pos[0];
    *xyz.add(1) = pos[1];
    *xyz.add(2) = pos[2];
    true
}

// -- effects VM FFI (fx_vm) ---------------------------------------------------
// Single-threaded, like the rest of this file: the render task and the message
// handler both call these under the C++ player_mutex.

/// Rebuild the room transform + room box from the stored map and the player's
/// pose: room = t + R(q) * (scale * pos). Unposed, only the box is derived (this
/// fixture's own map box), since led.room then reads led.pos.
// Cold (once per map/pose change): out of the per-frame update's hot code.
#[cold]
#[inline(never)]
unsafe fn fx_rebuild_room() {
    FX_ROOM_READY = true;
    let p = player();
    FX_ROOM_GEN = p.fixture_pose_gen();
    let len = (*addr_of!(MAP_META)).as_ref().map_or(0, |(_, c)| *c as usize).min(fx_cap());
    let pose = p.fixture_pose();
    FX_ROOM_POSED = pose.is_some();
    // Rotation matrix from the (normalized) quaternion; identity when unposed.
    let (t, q, sc) = match pose {
        Some(ps) => (
            [ps.r#translation[0], ps.r#translation[1], ps.r#translation[2]],
            [ps.r#rotation[0], ps.r#rotation[1], ps.r#rotation[2], ps.r#rotation[3]],
            ps.r#scale,
        ),
        None => ([0.0; 3], [0.0, 0.0, 0.0, 1.0], 1.0),
    };
    let [x, y, z, w] = q;
    let r = [
        [1.0 - 2.0 * (y * y + z * z), 2.0 * (x * y - z * w), 2.0 * (x * z + y * w)],
        [2.0 * (x * y + z * w), 1.0 - 2.0 * (x * x + z * z), 2.0 * (y * z - x * w)],
        [2.0 * (x * z - y * w), 2.0 * (y * z + x * w), 1.0 - 2.0 * (x * x + y * y)],
    ];
    let mut m = [[0.0f32; 3]; 3];
    for k in 0..3 {
        for j in 0..3 {
            m[k][j] = sc * r[k][j];
        }
    }
    *addr_of_mut!(FX_ROOM_M) = m;
    *addr_of_mut!(FX_ROOM_T) = t;
    let mut mn = [f32::INFINITY; 3];
    let mut mx = [f32::NEG_INFINITY; 3];
    for i in 0..len {
        if led_mapped(i) {
            let o = room_of(pos_get(i));
            for k in 0..3 {
                mn[k] = mn[k].min(o[k]);
                mx[k] = mx[k].max(o[k]);
            }
        }
    }
    // The host's room box (the union over every fixture) wins over our own.
    if let Some(ps) = pose.filter(|ps| ps.r#room_min.len() == 3 && ps.r#room_max.len() == 3) {
        mn.copy_from_slice(&ps.r#room_min);
        mx.copy_from_slice(&ps.r#room_max);
    }
    for k in 0..3 {
        FX_ROOM_MIN[k] = if mn[k].is_finite() { mn[k] } else { 0.0 };
        FX_ROOM_MAX[k] = if mx[k].is_finite() { mx[k] } else { 0.0 };
        FX_ROOM_MIN_FIX[k] = q16_16(FX_ROOM_MIN[k]);
        FX_ROOM_MAX_FIX[k] = q16_16(FX_ROOM_MAX[k]);
    }
}

/// A map position in the room frame under the current pose (FX_ROOM_M/T).
#[inline]
unsafe fn room_of(v: [f32; 3]) -> [f32; 3] {
    let m = &*addr_of!(FX_ROOM_M);
    let t = &*addr_of!(FX_ROOM_T);
    [
        t[0] + m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        t[1] + m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        t[2] + m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// The room pose's change generation (set_fixture_pose), polled after each
/// message like lm_color_correction_gen: on a bump the firmware persists the
/// request (when `lm_fixture_pose_commit`).
///
/// # Safety
/// Single firmware thread, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fixture_pose_gen() -> u32 {
    player().fixture_pose_gen()
}

/// Whether the last set_fixture_pose asked to be persisted (commit, unset = true).
///
/// # Safety
/// Single firmware thread, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fixture_pose_commit() -> bool {
    player().fixture_pose_commit()
}

/// The shared effect-time epoch (set_time_base, device-clock ms): writes it to
/// `*epoch_ms` and returns true when one is set. The render loop then derives the
/// effect's `time` as (now - epoch) / 1000 so fixtures animate in step.
///
/// # Safety
/// `epoch_ms` points to a writable i64; under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_time_base(epoch_ms: *mut i64) -> bool {
    match player().time_base_ms() {
        Some(t) if !epoch_ms.is_null() => {
            *epoch_ms = t;
            true
        }
        _ => false,
    }
}

/// Rebuild [`FX_LED_TOPO`] from the stored map + topology (in map-index order),
/// deriving each LED's segment index, normalized arclength and junction flag
/// from its [`StoredAssociation`]. Cheap to call every frame — it early-returns
/// via [`FX_TOPO_READY`] unless a map/topology upload invalidated the cache.
/// With no topology stored, every entry stays `NONE` (seg = -1), so unmapped
/// LEDs read `led.seg == -1` and topology-aware effects fall back gracefully.
// Cold (once per map/pose change): out of the per-frame update's hot code.
#[cold]
#[inline(never)]
unsafe fn fx_rebuild_topo() {
    // UV bounds for led.uv — map-derived (independent of topology). Gated by its
    // OWN flag so a topology upload doesn't recompute it and, crucially, a map
    // upload doesn't re-trigger the topology resolve below.
    if !FX_UV_READY {
        FX_UV_READY = true;
        let len = (*addr_of!(MAP_META))
            .as_ref()
            .map_or(0, |(_, c)| *c as usize)
            .min(fx_cap());
        let mut mn = [f32::INFINITY; 2];
        let mut mx = [f32::NEG_INFINITY; 2];
        // Measured LEDs only (interpolated ones lie inside their hull anyway).
        for p in (0..len).filter(|&i| led_mapped(i)).map(|i| pos_get(i)) {
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
        for e in topo_store().iter_mut() {
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
    // segment_id → map it to the segment INDEX, and derive s/branch/dist.
    // foot/dperp are kept. O(associations × segments), once per upload — and
    // lm_fx_shade's topology reads are then O(1) per frame.
    let cache = topo_store();
    let mut max_geo = 0.0f32;
    for e in cache.iter_mut() {
        if e.seg < 0 {
            continue; // no association
        }
        let seg_id = e.seg as u32; // TEMP raw id from the streaming sink
        let foot = e.s.get(); // TEMP foot from the streaming sink
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
        e.seg = seg_idx as i16 | if branch { TOPO_BRANCH } else { 0 }; // resolve id → index
        e.s = F24::new(s_norm);
        e.dist = F24::new(geo);
    }
    // Normalize the raw geodesic distances to 0..1 (unassociated LEDs stay 0).
    if max_geo > 1e-6 {
        for e in cache.iter_mut() {
            e.dist = F24::new(e.dist.get() / max_geo);
        }
    }

    // (The caller pushes the graph to the decks' VMs — fx_push_graph_all — after
    // this frame is gone, so the two frames never stack.)
}

/// Push the topology graph to every loaded deck's VM.
// Cold (once per map/pose change): out of the per-frame update's hot code.
#[cold]
#[inline(never)]
unsafe fn fx_push_graph_all() {
    for d in 0..N_DECKS {
        if let Some(p) = deck(d) {
            if let Some(vm) = (*p).vm.as_mut() {
                fx_push_graph(vm);
            }
        }
    }
}

/// Hand `vm` the resident topology graph for the graph-query intrinsics
/// (agentic effects); an empty graph when no topology is stored. Compact node
/// ids: a real branch point keeps its index, each free end gets a fresh id after
/// the branch points (kept small so it stays under fx_vm::MAX_NODE). Segment
/// index i matches led.seg / ag.seg.
#[inline(never)]
unsafe fn fx_push_graph(vm: &mut FxVm) {
    let Some(topo) = (*addr_of!(GEOM)).as_ref() else {
        vm.set_graph(&[], &[], &[]);
        return;
    };
    const MAX_BP: usize = 64;
    const MAX_SEG: usize = 128;
    let n_bp = topo.branch_points.len().min(MAX_BP);
    let n_seg = topo.segments.len().min(MAX_SEG);
    {
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

/// Why a deck load failed (submit_effect maps these to its error codes).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum FxLoadError {
    /// The `.fxb` exceeds FX_MAX_BYTES.
    TooLarge,
    /// The two decks' buffers don't fit the shared FX_ARENA together.
    ArenaFull,
    /// Not a valid `.fxb`.
    Bad,
}

/// LED-arity buffers are sized for at least this many LEDs: the LED cap before
/// it grew to 1024 per channel, so an effect that loaded then still loads (and
/// reserves the same deck-B slice) whatever the strip.
const FX_ARENA_LED_FLOOR: usize = 512;

/// LED count an effect's LED-arity buffers are sized for: the stored map / the
/// configured strip (whichever is longer), at least [`FX_ARENA_LED_FLOOR`], at
/// most the cap. Sizing them for the 2048-LED cap would make one f32 vec3 trail
/// fill the whole 24 KB arena; sizing them for the strip that's there keeps
/// short-strip effects loading exactly as before. A map that later outgrows a
/// deck-B slice only degrades that deck (the VM bounds every buffer access:
/// reads past the slice give 0, writes are dropped) — deck A always owns
/// everything deck B doesn't reserve.
unsafe fn fx_arena_leds() -> usize {
    let map = (*addr_of!(MAP_META)).as_ref().map_or(0, |(_, c)| *c as usize);
    let strip = (*addr_of!(PLAYER)).as_ref().map_or(0, |p| {
        (0..ledmapper_player::HW_CHANNELS).map(|c| p.led_count(c).unwrap_or(0) as usize).sum()
    });
    map.max(strip).clamp(FX_ARENA_LED_FLOOR.min(FX_TOPO_CAP), FX_TOPO_CAP)
}

/// Arena bytes a program's buffers need for [`fx_arena_leds`] LEDs, rounded up
/// to a word.
fn arena_need(prog: &Program) -> usize {
    (prog.arena_bytes(unsafe { fx_arena_leds() }) + 3) & !3
}

/// Bind deck `p`'s VM to its slice of FX_ARENA (no zeroing). The per-LED memo
/// cache takes the largest group prefix (for FX_MEMO_LEDS LEDs) that fits in
/// what the buffers' need leaves free, carved from the END of the slice; the
/// buffers keep everything in front of it (all of the slice when there is no
/// cache, exactly as before). (Re)binding the cache empties it.
unsafe fn bind_arena(p: *mut DeckState) {
    let (o, n) = ((*p).arena_off, (*p).arena_len);
    let arena = &mut *addr_of_mut!(FX_ARENA);
    let bytes = &(*p).bytes[..(*p).len];
    let (need, words) = match Program::parse(bytes) {
        Ok(pr) => {
            let need = arena_need(&pr).min(n);
            (need, pr.led_cache_fit(FX_MEMO_LEDS, n - need))
        }
        Err(_) => (n, 0),
    };
    let m = ledmapper_fx_vm::led_cache_bytes(words, FX_MEMO_LEDS).min(n - need);
    if let Some(vm) = (*p).vm.as_mut() {
        // Disjoint sub-slices: the VM never sees the cache as buffer memory.
        let (bufs, tail) = arena[o..o + n].split_at_mut(n - m);
        vm.set_arena(bufs);
        vm.set_led_cache(tail, words, FX_MEMO_LEDS);
    }
}

/// Re-bind every loaded deck's memo cache for `leds` LEDs (empties them). Cold:
/// runs once per map/topology/LED-count change, off the per-LED path.
#[cold]
#[inline(never)]
unsafe fn fx_memo_rebind(leds: usize) {
    FX_MEMO_LEDS = leds.min(FX_TOPO_CAP);
    FX_MEMO_DIRTY = false;
    for d in 0..N_DECKS {
        if let Some(p) = deck(d) {
            if (*p).loaded() {
                bind_arena(p);
            }
        }
    }
}

/// Memo words bound on deck `d` (0 = uncached) — diagnostics / tests.
///
/// # Safety
/// Single firmware thread; the player must be initialized.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_led_cache_words(d: u32) -> u32 {
    deck(deck_index(d))
        .and_then(|p| (*p).vm.as_ref())
        .map_or(0, |vm| vm.led_cache_words_bound() as u32)
}

/// Load (parse + hold) a `.fxb` onto deck `d`, copying it into the deck's
/// static buffer with a fresh VM. The deck is HELD, not activated. Deck A takes
/// FX_ARENA from the front (everything deck B doesn't reserve); deck B reserves
/// exactly its own need from the back, refused when the two don't fit together.
unsafe fn fx_load(d: usize, src: &[u8]) -> Result<(), FxLoadError> {
    if src.is_empty() || src.len() > FX_MAX_BYTES {
        return Err(FxLoadError::TooLarge);
    }
    // Validate before committing: reject a malformed .fxb so a bad upload can't
    // wedge the render loop on garbage.
    let Ok(prog) = Program::parse(src) else {
        return Err(FxLoadError::Bad);
    };
    // A sensor driver (FUG-107) is not an effect: its "shade" slot is poll().
    if prog.flags & ledmapper_fx_vm::FLAG_DRIVER != 0 {
        return Err(FxLoadError::Bad);
    }
    let need = arena_need(&prog);
    let b_reserve = match deck(DECK_B_IDX) {
        Some(b) if (*b).loaded() => (*b).arena_len,
        _ => 0,
    };
    let (off, alen) = if d == DECK_A_IDX {
        if b_reserve > 0 && need > FX_ARENA_BYTES - b_reserve {
            return Err(FxLoadError::ArenaFull);
        }
        (0, FX_ARENA_BYTES - b_reserve)
    } else {
        let a_need = if (*addr_of!(DECK_A)).loaded() {
            Program::parse(&(*addr_of!(DECK_A.bytes))[..DECK_A.len]).map(|p| arena_need(&p)).unwrap_or(0)
        } else {
            0
        };
        if a_need + need > FX_ARENA_BYTES {
            return Err(FxLoadError::ArenaFull);
        }
        // Deck B also takes up to half the spare arena for its per-LED memo
        // cache (deck A keeps the rest of the spare for its own).
        let spare = FX_ARENA_BYTES - a_need - need;
        let words = prog.led_cache_fit(FX_MEMO_LEDS, spare / 2);
        let cache = (ledmapper_fx_vm::led_cache_bytes(words, FX_MEMO_LEDS) + 3) & !3;
        (FX_ARENA_BYTES - need - cache, need + cache)
    };
    let p = if d == DECK_A_IDX { addr_of_mut!(DECK_A) } else { deck_b_claim() };
    if d == DECK_A_IDX {
        // Build the OSC name->slot table for the fresh effect (once, off the
        // render path) and clear the per-slot value shadow so no stale vector
        // component leaks across a hot-reload. OSC drives deck A only.
        *addr_of_mut!(OSC_TABLE) = osc::parse_manifest(prog.manifest);
        (*addr_of_mut!(OSC_SHADOW)).reset();
    }
    // Only build the per-LED fixed context mirrors / uv projection / room read
    // on the hot path when the program actually reads them (FUG-122).
    (*p).uses_ctxfix = prog.uses_ctxfix();
    (*p).uses_uv = prog.uses_uv();
    (*p).uses_room = prog.uses_room();
    (*p).morph.reset(prog.manifest);
    // Bind uniforms named like a pool entry (imu_quat, ...) to the live pool.
    uniform_pool::bind(d, prog.manifest);
    (*p).shade_led = None;
    *addr_of_mut!(FX_SHADE_FRAME) = None;
    (*p).prog = None;
    (*p).bytes[..src.len()].copy_from_slice(src);
    (*p).len = src.len();
    (*p).vm = Some(FxVm::new());
    // Start every uniform at its manifest default (fx-perf-study R7). Clients
    // that send set_uniforms after a deploy still override it; before this, an
    // effect nobody configured ran with every uniform at 0 (fx_bench's
    // lavalamp never entered its wave loop).
    if let Some(vm) = (*p).vm.as_mut() {
        kp::for_each_uniform(prog.manifest, |u| {
            if u.n_default > 0 {
                vm.set_uniform(u.slot as usize, &u.default[..u.n_default as usize]);
            }
        });
    }
    // Bind + zero this deck's arena slice (buffers start clean each load; the
    // static memory's pointer is stable so one bind holds).
    (*p).arena_off = off;
    (*p).arena_len = alen;
    (&mut (*addr_of_mut!(FX_ARENA)))[off..off + alen].fill(0);
    bind_arena(p);
    if d == DECK_A_IDX {
        // FUG-125: build the on-device JIT (patches JitCall into the resident
        // bytes + installs the segment table). Re-parse from the resident copy so
        // the patched offsets + JIT code slice point at it.
        if let Some(vm) = (*addr_of_mut!(DECK_A.vm)).as_mut() {
            if let Ok(resident) = Program::parse(&(*addr_of!(DECK_A.bytes))[..DECK_A.len]) {
                fx_build_jit(&resident, vm);
            }
        }
        // A fresh effect (re)stamps the perf identity and resets the ring/window
        // so metrics can't be mis-attributed across a hot-reload.
        DECK_A.hash = fxb_hash(src);
        perf_reset_ring();
    } else {
        // Deck B reserved the back of the arena: deck A keeps the front (its own
        // buffers sit there already, so the rebind moves nothing).
        DECK_A.arena_off = 0;
        DECK_A.arena_len = FX_ARENA_BYTES - alen;
        bind_arena(addr_of_mut!(DECK_A));
    }
    // Hand the fresh VM the current topology graph now (if it's resolved; else
    // the next update resolves it and pushes to every deck). Re-resolving the
    // per-LED cache on every load would read its already-resolved indices back
    // as raw segment ids.
    if FX_TOPO_READY {
        if let Some(vm) = (*p).vm.as_mut() {
            fx_push_graph(vm);
        }
    }
    // Parse the resident copy once, after the JIT patch (the bytes don't change
    // again until the next load or clear).
    (*p).prog = Program::parse(core::slice::from_raw_parts((*p).bytes.as_ptr(), (*p).len)).ok();
    FX_ROOM_READY = false;
    FX_DEADLINE.store(false, core::sync::atomic::Ordering::Relaxed);
    fps_invalidate();
    Ok(())
}

/// Load (parse + hold) a `.fxb` onto deck A (see [`fx_load`]). False if the
/// bytes don't fit or don't parse as a valid `.fxb`.
///
/// # Safety
/// `fxb` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_load(fxb: *const u8, len: usize) -> bool {
    if fxb.is_null() || len == 0 {
        return false;
    }
    fx_load(DECK_A_IDX, core::slice::from_raw_parts(fxb, len)).is_ok()
}

/// Clear deck `d` (no program, not active). Clearing deck B hands the aux region
/// back (a video stream can claim it) and deck A the whole arena.
unsafe fn fx_clear(d: usize) {
    fps_invalidate();
    if d == DECK_A_IDX {
        DECK_A.prog = None;
        DECK_A.len = 0;
        DECK_A.active = false;
        *addr_of_mut!(DECK_A.vm) = None;
        DECK_A.hash = 0;
        DECK_A.id_len = 0;
        (*addr_of_mut!(DECK_A)).morph.clear();
        *addr_of_mut!(OSC_TABLE) = PortTable::empty();
        (*addr_of_mut!(OSC_SHADOW)).reset();
        // Drop the JIT table (the exec region is a fixed static, reused on next
        // load; the VM was just cleared above, so the installed table goes too).
        FX_JIT_N = 0;
        perf_reset_ring();
    } else if let Some(p) = deck(DECK_B_IDX) {
        (*p).vm = None;
        (*p).prog = None;
        (*p).len = 0;
        FX_AUX_OWNER = AuxOwner::Free;
        DECK_A.arena_off = 0;
        DECK_A.arena_len = FX_ARENA_BYTES;
        bind_arena(addr_of_mut!(DECK_A));
    }
}

/// Clear deck A's effect (back to idle).
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_clear() {
    fx_clear(DECK_A_IDX);
}

/// Enable/disable the on-device JIT (FUG-125). Takes effect on the NEXT
/// `lm_fx_load`; the caller reloads the effect to rebuild (or tear down) the
/// segments — the HITL A/B flips this and re-submits to measure JIT on vs off.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_jit_enabled(enabled: bool) {
    FX_JIT_ENABLED = enabled;
}

/// How many JIT segments the current effect installed (0 = pure interpretation).
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_jit_count() -> u32 {
    FX_JIT_N as u32
}

/// JIT bring-up diagnostics (FUG-125): `*plans` = blocks the planner found,
/// `*words` = total RV32 words, `*alloc_ok` = 1 if the exec alloc succeeded.
/// Lets a bench attribute a segments=0 outcome (no hot blocks vs no exec IRAM).
///
/// # Safety
/// The pointer arguments must be null or point to writable/readable memory
/// of the documented size, and the global player must have been initialized
/// by [`lm_player_init`] and not be called reentrantly.
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

/// Whether deck `d` is loaded AND active.
unsafe fn deck_renders(d: usize) -> bool {
    deck(d).is_some_and(|p| (*p).renders())
}

/// Whether ANY deck is loaded, ACTIVE and renderable — the render loop gates on
/// this (below an active capture / counting probe).
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_active() -> bool {
    (0..N_DECKS).any(|d| deck_renders(d))
}

/// Whether deck A has an effect loaded at all (active or parked). Used by
/// persistence (deck A is the persisted deck).
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_loaded() -> bool {
    (*addr_of!(DECK_A)).loaded()
}

/// Mark deck `d`'s loaded effect active (true) or parked (false). No-op with
/// nothing loaded.
unsafe fn fx_set_active(d: usize, active: bool) {
    if let Some(p) = deck(d) {
        if (*p).loaded() {
            if (*p).active != active {
                fps_invalidate();
            }
            (*p).active = active;
        }
    }
}

/// Mark deck A's loaded effect active (true) or parked (false).
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_active(active: bool) {
    fx_set_active(DECK_A_IDX, active);
}

/// Set the max instruction count for one update()/shade() invocation (bounded
/// execution, primary guard). 0 restores the default.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
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
/// timeout, 3=fault (a malformed program stopped instead of panicking). For
/// the rate-limited `[fx]` diagnostic log in the render loop.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_last_update_outcome() -> u32 {
    FX_LAST_UPDATE_OUTCOME
}

/// Apply a uniform value to deck `d`'s VM.
unsafe fn fx_set_uniform(d: usize, slot: u32, vals: &[f32]) {
    if let Some(p) = deck(d) {
        if let Some(vm) = (*p).vm.as_mut() {
            vm.set_uniform(slot as usize, vals);
        }
    }
}

/// Apply a uniform value (`vals` = its slot count, 1..4) to deck A's VM.
///
/// # Safety
/// `vals` must point to `n` readable f32.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_set_uniform(slot: u32, vals: *const f32, n: usize) {
    if vals.is_null() || n == 0 {
        return;
    }
    fx_set_uniform(DECK_A_IDX, slot, core::slice::from_raw_parts(vals, n));
}

/// Select OSC addressing mode: `true` (default) resolves uniform names via the
/// active effect's manifest (falling back to slot index for unknown names);
/// `false` treats every address as a raw slot number. Exposed so the app / a
/// bench can A-B the name-lookup cost and so slot-only can be forced.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
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
        if let Some(vm) = (*addr_of_mut!(DECK_A.vm)).as_mut() {
            vm.set_uniform(slot as usize, vals);
        }
    }) as u32
}

/// The global crossfade (Player::set_crossfade), latched once per frame by
/// lm_fx_update so the per-LED blend reads two plain statics.
static mut FX_XF_POS: f32 = 0.0;
static mut FX_XF_MODE: u32 = 0;

/// Run `update()` once for this frame (before the per-LED shade sweep) on EVERY
/// active deck, first advancing any keypoint morph on that deck. Clears the
/// wall-time deadline flag first (a fresh frame gets the full budget) and
/// latches the frame context + crossfade the shade sweep reuses. Returns false
/// when no deck has an effect loaded. A cancelled update (budget/timeout) still
/// counts — a partial state advance is harmless.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_fx_update(time_s: f32, dt_s: f32, frame: u32, led_count: u32) -> bool {
    FX_DEADLINE.store(false, core::sync::atomic::Ordering::Relaxed);
    let b_loaded = FX_AUX_OWNER == AuxOwner::DeckB;
    if !(*addr_of!(DECK_A)).loaded() && !b_loaded {
        return false;
    }
    if b_loaded {
        fx_latch_crossfade();
    }
    // The room frame follows the map and the pose: rebuild when either changed
    // (only for effects that read it — the rest never pay the sweep).
    let uses_room = DECK_A.uses_room || (b_loaded && deck(DECK_B_IDX).is_some_and(|p| (*p).uses_room));
    if uses_room && (!FX_ROOM_READY || FX_ROOM_GEN != player().fixture_pose_gen()) {
        fx_rebuild_room();
    }
    #[allow(unused_mut)]
    let mut f = FxFrame {
        time: time_s,
        dt: dt_s,
        frame,
        led_count,
        // Q16.16 mirrors for LoadCtxFix (computed once per frame, not per LED).
        time_fix: q16_16(time_s),
        dt_fix: q16_16(dt_s),
        room_posed: FX_ROOM_POSED,
        room_min: FX_ROOM_MIN,
        room_max: FX_ROOM_MAX,
        room_min_fix: FX_ROOM_MIN_FIX,
        room_max_fix: FX_ROOM_MAX_FIX,
        ..Default::default()
    };
    // imu.accel (g) / imu.gyro (rad/s) + Q16.16 mirrors, only while a sensor
    // runs: one inline flag load otherwise (the sensor code stays out of the
    // per-frame cache footprint — fx_bench sweep16 is sensitive to it).
    if sensor_ffi::SENSOR_LIVE.load(core::sync::atomic::Ordering::Relaxed) {
        sensor_ffi::fill_frame_imu(&mut f);
    }
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
    *addr_of_mut!(FX_SHADE_FRAME) = Some(f);
    // Refresh the per-LED topology cache if a map/topology upload invalidated it,
    // so the coming shade() sweep sees current led.seg / led.s / led.branch.
    if !FX_TOPO_READY {
        fx_rebuild_topo();
        fx_push_graph_all();
    }
    // Per-LED memo caches follow the map: a map/topology upload (dirty) or a new
    // LED count re-binds them (empty) before this frame's shade sweep refills.
    if FX_MEMO_DIRTY || FX_MEMO_LEDS != (led_count as usize).min(FX_TOPO_CAP) {
        fx_memo_rebind(led_count as usize);
    }
    // A new frame: reset the per-frame Tier-1 accumulators (they sum over both
    // decks' update + the coming per-LED sweep).
    FX_INSTR_UPDATE = 0;
    FX_INSTR_SHADE = 0;
    FX_STACK_MAX = 0;
    // Live pool values (sensor fusion, driver exports) into their bound uniforms
    // before update(), so update() and every shade() see the same sample.
    if uniform_pool::ANY_BOUND {
        uniform_pool::apply_frame();
    }
    if let Some(oc) = fx_update_deck(addr_of_mut!(DECK_A), &f, dt_s) {
        FX_LAST_UPDATE_OUTCOME = oc as u32;
    }
    if b_loaded {
        if let Some(p) = deck(DECK_B_IDX) {
            fx_update_deck(p, &f, dt_s);
        }
    }
    true
}

/// Latch the crossfade for this frame's blend (only read with deck B loaded).
#[cold]
#[inline(never)]
unsafe fn fx_latch_crossfade() {
    let pl = player();
    FX_XF_POS = pl.crossfade();
    FX_XF_MODE = pl.crossfade_mode();
}

/// Run one deck's update() for this frame (advancing its keypoint morph first);
/// None when the deck doesn't render.
#[inline(always)]
unsafe fn fx_update_deck(p: *mut DeckState, f: &FxFrame, dt_s: f32) -> Option<Outcome> {
    if !(*p).renders() {
        return None;
    }
    let prog = (*p).prog.as_ref()?;
    let vm = (*p).vm.as_mut()?;
    // A keypoint morph moves the uniforms first, so this frame's update and
    // shade see the same in-between position (out of line: rarely running).
    if (*p).morph.running() {
        fx_advance_morph(p, dt_s);
    }
    Some(if PERF_MODE == PERF_FULL {
        // FULL: pay the counted VM path so instr_update / stack_max are real.
        let (oc, c) = vm.run_update_counted(prog, f, &fx_budget());
        FX_INSTR_UPDATE = FX_INSTR_UPDATE.saturating_add(c.instrs);
        FX_STACK_MAX = FX_STACK_MAX.max(c.stack_max);
        oc
    } else {
        // BASIC/OFF: the plain path — no per-opcode counting overhead.
        vm.run_update_bounded(prog, f, &fx_budget())
    })
}

#[cold]
#[inline(never)]
unsafe fn fx_advance_morph(p: *mut DeckState, dt_s: f32) {
    if let (Some(v), Some(vm)) = ((*p).morph.advance(dt_s), (*p).vm.as_mut()) {
        (*p).morph.rules.unpack(&v, |slot, vals| vm.set_uniform(slot as usize, vals));
    }
}

/// Shade one LED on deck `p`: run `shade(led)` → rgb. None when the deck has no
/// program OR the invocation was cancelled by a bounded-execution guard.
// Inlined into both lm_fx_shade paths: the single-deck one must stay exactly the
// one-function hot path it was (fx_bench measures it; an extra call frame and a
// second hot code block per LED cost several percent through the flash cache).
#[inline(always)]
unsafe fn fx_shade_one(p: *mut DeckState, idx: u32, x: f32, y: f32, z: f32) -> Option<Rgb8> {
    // &mut: run_shade writes the VM's resident scratch (stack/locals) in place
    // instead of allocating per LED (FUG-122 framing hill-climb).
    let vm = (*p).vm.as_mut()?;
    // Parsed once at load (DeckState::prog), not per LED.
    let prog = (*p).prog.as_ref()?;
    // Borrow the frame context lm_fx_update built for this frame (shared by both
    // decks), so `time`/`dt`/`frame` are the same as update() and nothing
    // frame-wide is rebuilt per LED. Before the first update() of a fresh
    // effect, a zero Frame (the render loop always updates first).
    let f: &FxFrame = (*addr_of_mut!(FX_SHADE_FRAME)).get_or_insert_with(FxFrame::default);
    // Per-LED topology (led.seg / led.s / led.branch) from the cache the last
    // lm_fx_update refreshed. `idx` is the map index — exactly this cache's key.
    // No association (or no topology stored) → seg = -1, s = 0, branch = false.
    let t = topo_store().get(idx as usize).copied().unwrap_or(FxLedTopo::NONE);
    // The uv projection is per-LED soft-float; skip it entirely unless the effect
    // reads led.uv (FUG-122).
    let uv = if (*p).uses_uv {
        [
            ((x - FX_UV_MIN[0]) * FX_UV_INV[0]).clamp(0.0, 1.0),
            ((y - FX_UV_MIN[1]) * FX_UV_INV[1]).clamp(0.0, 1.0),
        ]
    } else {
        [0.0, 0.0]
    };
    // Overwrite this deck's reused scratch field by field — no per-LED struct
    // re-zero. Per deck: each deck's program reads (and so refreshes) a
    // different set of the optional mirrors, so a shared scratch would leak one
    // deck's room / fixed values into the other.
    let led: &mut FxLed = (*p).shade_led.get_or_insert_with(FxLed::default);
    led.pos = [x, y, z];
    led.idx = idx;
    if t.seg < 0 {
        // No association (or no topology stored): skip the decode.
        led.seg = -1;
        led.s = 0.0;
        led.branch = false;
        led.dist = 0.0;
    } else {
        led.seg = (t.seg & !TOPO_BRANCH) as i32;
        led.s = t.s.get();
        led.branch = t.seg & TOPO_BRANCH != 0;
        led.dist = t.dist.get();
    }
    led.uv = uv;
    if (*p).uses_room && FX_ROOM_POSED {
        let o = room_of([x, y, z]);
        led.room = o;
        led.room_fix = [q16_16(o[0]), q16_16(o[1]), q16_16(o[2])];
    }
    // Fixed (Q16.16) mirrors read by LoadCtxFix — built ONLY when the effect
    // actually reads them (FUG-122), so an all-float shader pays zero per-LED
    // overhead and the resident cache never grows.
    if (*p).uses_ctxfix {
        led.pos_fix = [q16_16(x), q16_16(y), q16_16(z)];
        led.uv_fix = [q16_16(uv[0]), q16_16(uv[1])];
        led.s_fix = q16_16(led.s);
        led.dist_fix = q16_16(led.dist);
    }
    let (c, outcome) = if PERF_MODE == PERF_FULL {
        // FULL: count this LED's opcodes into the per-frame shade accumulator
        // and lift the stack high-water. This is the hottest path, so the
        // counting is gated behind FULL exactly as perf-monitoring.md requires.
        let (c, outcome, k): (Rgb8, Outcome, FxCounters) = vm.run_shade_counted(prog, f, led, &fx_budget());
        FX_INSTR_SHADE = FX_INSTR_SHADE.saturating_add(k.instrs);
        if k.stack_max > FX_STACK_MAX {
            FX_STACK_MAX = k.stack_max;
        }
        (c, outcome)
    } else {
        vm.run_shade_bounded(prog, f, led, &fx_budget())
    };
    (outcome == Outcome::Ok).then_some(c)
}

/// Shade one LED: each active deck's `shade(led)`, blended by the crossfade
/// lm_fx_update latched (position 0 = all deck A .. 1 = all deck B; mode 0 =
/// linear RGB, 1 = HSV). At either endpoint only that deck shades, so a parked
/// crossfader costs one deck; a lone active deck shows at full. `x`,`y`,`z` are
/// the LED's position (the render loop passes the stored map position via
/// lm_map_led). Returns false when no deck produced a colour (nothing loaded, or
/// a bounded-execution guard cancelled it) — the caller holds black for that LED
/// rather than hanging the render task.
///
/// # Safety
/// `rgb` must point to 3 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_shade(idx: u32, x: f32, y: f32, z: f32, rgb: *mut u8) -> bool {
    // The common case — deck B not loaded (the aux region is free or holds a
    // video stream): deck A alone, straight through.
    if FX_AUX_OWNER != AuxOwner::DeckB {
        return match fx_shade_one(addr_of_mut!(DECK_A), idx, x, y, z) {
            Some((r, g, b)) => {
                *rgb = r;
                *rgb.add(1) = g;
                *rgb.add(2) = b;
                true
            }
            None => false,
        };
    }
    fx_shade_decks(idx, x, y, z, rgb)
}

/// The two-deck shade + crossfade blend (deck B loaded).
#[cold]
#[inline(never)]
unsafe fn fx_shade_decks(idx: u32, x: f32, y: f32, z: f32, rgb: *mut u8) -> bool {
    let t = FX_XF_POS;
    let a = (*addr_of!(DECK_A)).renders();
    let b = deck_renders(DECK_B_IDX);
    let ca = if a && !(b && t >= 1.0) { fx_shade_one(addr_of_mut!(DECK_A), idx, x, y, z) } else { None };
    let cb = match deck(DECK_B_IDX) {
        Some(p) if b && !(a && t <= 0.0) => fx_shade_one(p, idx, x, y, z),
        _ => None,
    };
    let (r, g, bl) = match (ca, cb) {
        (Some(ca), Some(cb)) => kp::blend_rgb8(ca, cb, t, FX_XF_MODE),
        (Some(c), None) | (None, Some(c)) => c,
        (None, None) => return false,
    };
    *rgb = r;
    *rgb.add(1) = g;
    *rgb.add(2) = bl;
    true
}

/// Copy deck A's uniforms manifest into `out` (cap `cap`). Returns the manifest
/// length written, or -1 when no effect is loaded, or -2 when the manifest
/// doesn't fit `cap`.
///
/// # Safety
/// `out` must point to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_fx_manifest(out: *mut u8, cap: usize) -> i32 {
    if DECK_A.len == 0 {
        return -1;
    }
    let bytes = &(*addr_of!(DECK_A.bytes))[..DECK_A.len];
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
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_perf_mode() -> u32 {
    PERF_MODE
}

/// The unsolicited-push interval in ms (0 = poll-only). main.cpp coalesces the
/// push at this cadence, like the playback-save quiet timer.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_perf_interval_ms() -> u32 {
    PERF_INTERVAL_MS
}

/// The latched Tier-1 counters from the just-rendered frame (0 unless FULL):
/// opcodes retired in update() / across the shade sweep, and the stack
/// high-water. The render loop reads these into its PerfFrame push.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_perf_instr_update() -> u32 {
    FX_INSTR_UPDATE
}
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_perf_instr_shade() -> u32 {
    FX_INSTR_SHADE
}
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_perf_stack_max() -> u32 {
    FX_STACK_MAX as u32
}

/// Refresh the heap figures carried in the next PerfReport. Called by the render
/// loop right before lm_perf_push. `free` / `min_free` are esp_get_free_heap_size
/// / _minimum; `largest_free` is heap_caps_get_largest_free_block (the biggest
/// contiguous block, i.e. the real ceiling on a single allocation) — all read on
/// the C++ side.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
#[no_mangle]
pub unsafe extern "C" fn lm_perf_set_heap(free: u32, min_free: u32, largest_free: u32) {
    PERF_HEAP_FREE = free;
    PERF_HEAP_MIN_FREE = min_free;
    PERF_HEAP_LARGEST_FREE = largest_free;
}

/// Push one rendered effect frame's Tier-0 cycle spans (+ the latched Tier-1
/// counts) into the perf ring. `overran` marks a frame whose frame+show cycles
/// exceeded the budget (counted since-drain). Cheap ring write — the render task
/// calls it unconditionally once per frame while a perf mode is active.
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
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
///
/// # Safety
/// The global player must have been initialized by [`lm_player_init`] and
/// this must not be called reentrantly (single firmware thread).
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

// -- Memory-mode tracking (docs/design/memory-regions.md, integration step 1) --
//
// The firmware's mode switches are checked against the sysmode model, LOG-ONLY:
// the loop hands lm_mode_observe a snapshot of what it sees; the tracker derives
// the model events and applies them through sysmode::step. A refusal (the device
// took a transition the model calls unreachable) is reported to the caller to
// log once per kind, counted in LM_MODE, and the axis is forced so tracking
// continues. LM_MODE is a fixed-layout static a JTAG watcher can read without
// disturbing the device (no network reporting).

use ledmapper_sysmode::observe::{event_code, refuse_code, state_code, Observed, Stats, Tracker};
use ledmapper_sysmode::SysMode;

/// Video is "streaming" while a set_texture frame arrived within this long.
const VIDEO_QUIET_MS: i64 = 2000;
static mut LAST_TEXTURE_MS: Option<i64> = None;

static mut MODE: Tracker = Tracker::new(SysMode::BOOT_UNPROVISIONED);

/// The tracker's counters, mirrored after every observation (fixed C layout;
/// read over JTAG by symbol, see ledmapper_sysmode::observe::Stats).
#[no_mangle]
pub static mut LM_MODE: Stats = Stats {
    polls: 0,
    accepted: 0,
    refused: 0,
    refused_by_kind: [0; 4],
    unmodeled: 0,
    state: 0,
    last_refusal: 0,
};

/// One refused (or unmodeled) transition, for the caller to log:
/// `state` = sysmode state_code before it, `event` = index in Event::ALL (0xff
/// = a change no event models), `why` = refuse code (0xff = unmodeled).
#[repr(C)]
pub struct LmModeRefusal {
    pub state: u32,
    pub event: u32,
    pub why: u32,
}

/// The network-side facts only the transport knows.
#[repr(C)]
pub struct LmNetObserved {
    pub creds: bool,
    pub leased: bool,
    pub ble_connected: bool,
    pub wss: bool,
    pub upload: bool,
}

/// Start tracking from the boot state, after fs_replay restored (or didn't) a
/// map and an effect. WiFi credentials are RAM-only, so boot is unprovisioned.
///
/// # Safety
/// Single firmware thread (loopTask), after [`lm_player_init`].
#[no_mangle]
pub unsafe extern "C" fn lm_mode_boot() {
    let mut boot = SysMode::BOOT_UNPROVISIONED;
    if lm_map_len() > 0 {
        boot.map = true;
    }
    if lm_fx_loaded() {
        boot.activity = ledmapper_sysmode::Activity::Effect { video: false, deck_b: false };
    }
    (*addr_of_mut!(MODE)).reset(boot);
    *addr_of_mut!(LM_MODE) = (*addr_of!(MODE)).stats;
}

/// Observe the device now (`now_ms`: millis) and track it through the model.
/// Writes up to `cap` refusals into `out` and returns how many occurred (may
/// exceed `cap`). Cheap: a handful of compares when nothing changed.
///
/// # Safety
/// `net` points to a valid struct; `out` to `cap` writable entries (or is null
/// with cap 0). Single firmware thread, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_mode_observe(
    net: *const LmNetObserved,
    now_ms: i64,
    out: *mut LmModeRefusal,
    cap: usize,
) -> u32 {
    if net.is_null() {
        return 0;
    }
    let n = &*net;
    let p = player();
    let effect = lm_fx_loaded();
    let video = effect
        && n.wss
        && LAST_TEXTURE_MS.is_some_and(|t| now_ms.wrapping_sub(t) < VIDEO_QUIET_MS);
    let o = Observed {
        creds: n.creds,
        leased: n.leased,
        ble_connected: n.ble_connected,
        wss: n.wss,
        upload: n.upload,
        mapping: p.pattern_timing().is_some() || p.counting_len() > 0,
        effect,
        video,
        deck_b: deck(DECK_B_IDX).is_some_and(|d| (*d).loaded()),
        map: lm_map_len() > 0,
    };
    let mut count = 0u32;
    (*addr_of_mut!(MODE)).observe(o, |r| {
        if (count as usize) < cap && !out.is_null() {
            *out.add(count as usize) = LmModeRefusal {
                state: state_code(r.from),
                event: r.event.map_or(0xff, event_code),
                why: r.why.map_or(0xff, refuse_code),
            };
        }
        count += 1;
    });
    *addr_of_mut!(LM_MODE) = (*addr_of!(MODE)).stats;
    count
}

/// Apply one explicit model event (index in `ledmapper_sysmode::Event::ALL`).
/// Returns 0 if the model accepts it, 1 + the refuse code if it refuses, -1 for
/// an unknown event. Log-only like lm_mode_observe: nothing is gated on it yet.
///
/// # Safety
/// Single firmware thread.
#[no_mangle]
pub unsafe extern "C" fn lm_mode_event(event: u32) -> i32 {
    let Some(&e) = ledmapper_sysmode::Event::ALL.get(event as usize) else {
        return -1;
    };
    let r = (*addr_of_mut!(MODE)).event(e);
    *addr_of_mut!(LM_MODE) = (*addr_of!(MODE)).stats;
    match r {
        Ok(_) => 0,
        Err(why) => 1 + refuse_code(why) as i32,
    }
}

// -- framerate autoscaler render-side accessors (FUG-82) ---------------------

/// Account for one rendered effect frame whose measured cost was `cost_us`
/// (update + shade of every rendering deck incl. the crossfade blend, or the
/// strip transmit if longer — they overlap). Returns how many ms the render task
/// sleeps before the next frame (period − work, never less than the controller's
/// minimum yield). If the effect can't hold its floor / pinned rate this parks
/// every rendering deck (they stay loaded; set_effect resumes) and latches a
/// notify-the-app request for loop(). Restarts the search first when what renders
/// changed since the last frame.
///
/// The strip comes with it: `wire_leds` LEDs clocked out one after another (the
/// longest channel — both go out in parallel), whose WS2812 wire time
/// (`ledmapper_fps::wire_frame_us`) caps the ladder at what the wire can carry,
/// and the `leds` the frame shaded set the abort floor
/// (`ledmapper_fps::floor_fps_for`: past 512 LEDs a heavy effect runs slower
/// instead of being parked).
///
/// # Safety
/// Render task, under the player_mutex (single-threaded player state).
#[no_mangle]
pub unsafe extern "C" fn lm_fps_on_frame(cost_us: u32, wire_leds: u32, leds: u32) -> u32 {
    let c = &mut *addr_of_mut!(FPS);
    if FPS_SEEN_GEN != FPS_GEN {
        FPS_SEEN_GEN = FPS_GEN;
        c.reset();
    }
    c.set_wire_us(ledmapper_fps::wire_frame_us(wire_leds));
    c.set_leds(leds);
    let d = c.on_frame(cost_us);
    if d.abort {
        c.take_abort();
        for k in 0..N_DECKS {
            fx_set_active(k, false);
        }
        // Parking is ours, not a new search: don't let it reset the rung the
        // fps_state{aborted} reports.
        FPS_SEEN_GEN = FPS_GEN;
        FPS_NOTIFY_ABORT = true;
    }
    d.delay_ms
}

/// The autoscaler's current target FPS (the rate the effect runs at now).
///
/// # Safety
/// Under the player_mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fps_current_fps() -> u32 {
    (*addr_of!(FPS)).current_fps()
}

/// Per-frame overrun budget in CPU cycles for the current target (cpu_hz /
/// current_fps); the render loop flags a perf-ring overrun against it.
///
/// # Safety
/// Under the player_mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fps_budget_cycles() -> u32 {
    PERF_CPU_HZ / (*addr_of!(FPS)).current_fps().max(1)
}

/// Read + clear the abort-notify latch; loop() pushes fps_state{aborted=true}.
///
/// # Safety
/// Under the player_mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fps_take_abort_notify() -> bool {
    let n = FPS_NOTIFY_ABORT;
    FPS_NOTIFY_ABORT = false;
    n
}

/// Encode an FpsState frame (`aborted` as given) into `out`: the unsolicited
/// abort push. Returns the encoded length, -1 bad args, -2 out_cap too small.
///
/// # Safety
/// `out` must point to `out_cap` writable bytes; under the player_mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fps_build_state(out: *mut u8, out_cap: usize, aborted: bool) -> i32 {
    if out.is_null() {
        return -1;
    }
    encode_reply(&build_fps_state(aborted), out, out_cap)
}
