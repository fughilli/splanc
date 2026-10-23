//! FX debugger (docs/design/fx-debugger.md): pause / step the effect engine and
//! read it back, so a fixture that doesn't match the editor preview can be
//! explained by diffing it against a host replay (web/src/fx/replay.ts).
//!
//! - `fx_debug_control`: PAUSE freezes the frame clock (the render task holds the
//!   last frame and runs nothing), STEP renders N frames (or one at an exact
//!   time) at a fixed dt, RESUME continues. A pause is a LEASE: it lapses
//!   `hold_ms` after the last debugger message, or ~5 s after the last session
//!   closed (`lm_fxdbg_poll`), so a fixture never stays frozen.
//! - `get_fx_snapshot`: one byte window of a section (output, wire bytes,
//!   uniforms, state, buffers, the .fxb, per-LED shade inputs, the LUT, the
//!   pre-LUT effect colour), encoded ZERO-COPY into the reply buffer straight
//!   from the live buffers: nothing is allocated or copied on the device, and a
//!   client pulls a 2048-LED frame window by window (TLS-record sized).
//! - `debug_fx_led`: re-run one LED's shade() on the interpreter (the JIT
//!   un-patched for the run) with zeroed scratch, and return its VM locals.
//!
//! Everything runs under the C++ player_mutex like the rest of the fx layer:
//! the render task's gate calls (lm_fxdbg_hold / lm_fxdbg_step) and the message
//! handlers take turns. RAM: ~40 B of statics (+ the 24 B JIT-patch record in
//! ffi.rs); the handlers' stacks hold a 48-byte record at most.

use core::ptr::{addr_of, addr_of_mut};

use ledmapper_fx_vm::{
    dbg, Frame as FxFrame, Led as FxLed, Program, Vm as FxVm, MAX_LOCALS, MAX_STATE,
    MAX_UNIFORM_SLOTS,
};

use super::{
    client_arm, deck, encode_reply, fx_budget, fx_cap, fx_error, fx_shade_one, led_mapped,
    lm_fx_active, lm_map_led, player, room_of, topo_store, varint_len, CArm, DeckState, FxLedTopo,
    PbOut, DECK_A, DECK_A_IDX, FPS, FX_ARENA, FX_BUDGET, FX_F_DT, FX_F_FRAME, FX_F_LEDS, FX_F_TIME,
    FX_JIT_N, FX_JIT_ORIG, FX_LAST_UPDATE_OUTCOME, FX_ROOM_POSED, FX_SHADE_FRAME, FX_UV_INV,
    FX_UV_MIN, FX_XF_MODE, FX_XF_POS, N_DECKS, TOPO_BRANCH,
};

pub(crate) const ARM_FX_DEBUG_CONTROL: u32 = 80;
pub(crate) const ARM_GET_FX_SNAPSHOT: u32 = 81;
pub(crate) const ARM_DEBUG_FX_LED: u32 = 82;

/// The reply: ServerMessage.fx_debug (FxDebugReply), and its oneof arms.
const SRV_FX_DEBUG: u32 = 50;
const REPLY_STATE: u32 = 1;
const REPLY_CHUNK: u32 = 2;
const REPLY_LED: u32 = 3;

/// Snapshot section layouts this firmware serves (FX_FRAME_V1, FX_LED_V1, ...).
pub const LAYOUT_VERSION: u32 = 1;

const ACTION_PAUSE: i32 = 1;
const ACTION_RESUME: i32 = 2;
const ACTION_STEP: i32 = 3;

pub const SECTION_OUTPUT: i32 = 0;
pub const SECTION_WIRE: i32 = 1;
pub const SECTION_UNIFORMS: i32 = 2;
pub const SECTION_STATE: i32 = 3;
pub const SECTION_ARENA: i32 = 4;
pub const SECTION_PROGRAM: i32 = 5;
pub const SECTION_LED_CONTEXT: i32 = 6;
pub const SECTION_LUT: i32 = 7;
pub const SECTION_RAW: i32 = 8;
pub const SECTION_GRAPH: i32 = 9;

/// Bytes per LED of a SECTION_LED_CONTEXT record (FX_LED_V1) and of the
/// FX_FRAME_V1 frame context (layouts: ledmapper_fx_vm::dbg).
pub use ledmapper_fx_vm::dbg::{FRAME_CTX_BYTES, LED_CTX_BYTES};

const DEFAULT_HOLD_MS: u32 = 120_000;
const MAX_HOLD_MS: u32 = 600_000;
/// With no session open, a pause lapses this long after the last debugger message.
const ORPHAN_HOLD_MS: u32 = 5_000;
const MAX_STEPS: u32 = 600;
const DEFAULT_CHUNK: usize = 768;
const MAX_CHUNK: usize = 1536;
/// dt for a step when no frame has rendered yet (the render loop's default).
const DEFAULT_DT: f32 = 0.033;

// -- debugger state (single-threaded, under the player_mutex) ----------------
static mut PAUSED: bool = false;
static mut STEPS: u32 = 0;
static mut STEP_DT: Option<f32> = None;
static mut STEP_TO: Option<f32> = None;
static mut HOLD_MS: u32 = DEFAULT_HOLD_MS;
/// millis() of the last debugger message (the lease's start).
static mut LAST_MSG_MS: u32 = 0;
static mut RESUME_REASON: &str = "";

// -- the output stage, owned by the C++ render path ---------------------------
static mut OUT_LEDS: *const u8 = core::ptr::null();
static mut OUT_CAP: u32 = 0;
static mut OUT_LUT: *const *const u8 = core::ptr::null();
static mut OUT_BRIGHT: *const u8 = core::ptr::null();

/// Hand the debugger the render path's output stage, once at boot: the `leds`
/// frame buffer (`cap` RGB triples, after the LUT + brightness), the address of
/// the active colour-LUT pointer (3 x 256, or null = none) and of the global
/// brightness byte. All are read only while serving a snapshot.
///
/// # Safety
/// The pointers must stay valid for the process (statics / the boot-time block).
#[no_mangle]
pub unsafe extern "C" fn lm_fxdbg_bind_output(
    leds: *const u8,
    cap: u32,
    lut: *const *const u8,
    brightness: *const u8,
) {
    OUT_LEDS = leds;
    OUT_CAP = if leds.is_null() { 0 } else { cap };
    OUT_LUT = lut;
    OUT_BRIGHT = brightness;
}

unsafe fn resume(reason: &'static str) {
    PAUSED = false;
    STEPS = 0;
    STEP_TO = None;
    RESUME_REASON = reason;
}

unsafe fn lease_expired(now_ms: u32) -> bool {
    now_ms.wrapping_sub(LAST_MSG_MS) as i32 >= HOLD_MS as i32
}

/// Render-task gate, checked before the effect branch: true = the engine is
/// paused with no step pending, so render nothing (the strip keeps showing the
/// last frame) and don't advance the frame clock. Lapses an expired lease.
///
/// # Safety
/// Under the player_mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fxdbg_hold(now_ms: u32) -> bool {
    if !PAUSED {
        return false;
    }
    if lease_expired(now_ms) {
        resume("timeout");
        return false;
    }
    STEPS == 0
}

/// Effect-branch hook, after the frame clock is computed: when a debugger step
/// is pending, consume it and override this frame's effect time / dt (the step's
/// fixed dt, or the exact `to_time`). True = this frame is a debugger step (the
/// render loop then skips the framerate autoscaler for it).
///
/// # Safety
/// `time_s` / `dt_s` must be valid; under the player_mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fxdbg_step(time_s: *mut f32, dt_s: *mut f32) -> bool {
    if !PAUSED || STEPS == 0 || time_s.is_null() || dt_s.is_null() {
        return false;
    }
    let last_t = FX_F_TIME;
    let last_dt = if FX_F_DT > 0.0 { FX_F_DT } else { DEFAULT_DT };
    let (t, dt) = match (STEP_TO, STEP_DT) {
        (Some(to), Some(dt)) => (to, dt),
        (Some(to), None) => (
            to,
            if to - last_t > 0.0 {
                to - last_t
            } else {
                last_dt
            },
        ),
        (None, Some(dt)) => (last_t + dt, dt),
        (None, None) => (last_t + last_dt, last_dt),
    };
    *time_s = t;
    *dt_s = dt;
    STEPS -= 1;
    if STEPS == 0 {
        STEP_TO = None;
    }
    true
}

/// Whether the engine is paused (steps pending or not).
///
/// # Safety
/// Under the player_mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fxdbg_paused() -> bool {
    PAUSED
}

/// Loop-task poll: `session_open` = any client session (wss/ws) is up. With
/// none, a pause lapses ORPHAN_HOLD_MS after the last debugger message (the
/// client that paused went away); the hold lease applies regardless.
///
/// # Safety
/// Under the player_mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_fxdbg_poll(now_ms: u32, session_open: bool) {
    if !PAUSED {
        return;
    }
    if !session_open && now_ms.wrapping_sub(LAST_MSG_MS) >= ORPHAN_HOLD_MS {
        resume("disconnect");
    } else if lease_expired(now_ms) {
        resume("timeout");
    }
}

// -- fx_debug_control ---------------------------------------------------------

pub(crate) unsafe fn handle_control(frame: &[u8], now_ms: i64, out: *mut u8, cap: usize) -> i32 {
    let Some(CArm::FxDebugControl(m)) = client_arm(frame) else {
        return encode_reply(
            &fx_error("bad_message", "fx_debug_control is malformed"),
            out,
            cap,
        );
    };
    LAST_MSG_MS = now_ms as u32;
    let hold = m.hold_ms();
    HOLD_MS = if hold == 0 {
        DEFAULT_HOLD_MS
    } else {
        hold.min(MAX_HOLD_MS)
    };
    match m.action() {
        ACTION_PAUSE | ACTION_STEP if !lm_fx_active() => {
            return encode_reply(&fx_error("no_effect", "no effect is rendering"), out, cap);
        }
        ACTION_PAUSE => {
            PAUSED = true;
            RESUME_REASON = "";
        }
        ACTION_STEP => {
            PAUSED = true;
            RESUME_REASON = "";
            STEP_DT = m.dt().filter(|d| d.is_finite() && *d >= 0.0);
            STEP_TO = m.to_time().filter(|t| t.is_finite());
            STEPS = if (*addr_of!(STEP_TO)).is_some() {
                1
            } else {
                m.frames().clamp(1, MAX_STEPS)
            };
        }
        ACTION_RESUME => resume(""),
        // ACTION_STATUS (and anything newer): just report.
        _ => {}
    }
    write_state(now_ms as u32, out, cap)
}

/// The deck's resident bytes with any JIT patch undone (the .fxb as uploaded).
unsafe fn program_byte(d: usize, p: *const DeckState, i: usize) -> u8 {
    let b = (*p).bytes[i];
    if d == DECK_A_IDX {
        for &(at, orig) in (*addr_of!(FX_JIT_ORIG)).iter().take(FX_JIT_N) {
            let at = at as usize;
            if (at..at + 3).contains(&i) {
                return orig[i - at];
            }
        }
    }
    b
}

unsafe fn program_hash(d: usize, p: *const DeckState) -> u32 {
    let mut h: u32 = 0x811c_9dc5;
    for i in 0..(*p).len {
        h ^= program_byte(d, p, i) as u32;
        h = h.wrapping_mul(0x0100_0193);
    }
    h
}

/// Swap the JIT patches out of (`restore` = true) / back into deck A's bytes.
unsafe fn jit_unpatch(restore: bool) {
    let bytes = &mut *addr_of_mut!(DECK_A.bytes);
    for &(at, orig) in (*addr_of!(FX_JIT_ORIG)).iter().take(FX_JIT_N) {
        let at = at as usize;
        if restore {
            bytes[at..at + 3].copy_from_slice(&orig);
        } else {
            bytes[at] = ledmapper_fx_vm::Op::JitCall as u8;
        }
    }
    if !restore {
        // Re-encode each block index after the opcode (the order they were installed).
        for (k, &(at, _)) in (*addr_of!(FX_JIT_ORIG)).iter().take(FX_JIT_N).enumerate() {
            let at = at as usize;
            bytes[at + 1] = (k & 0xff) as u8;
            bytes[at + 2] = ((k >> 8) & 0xff) as u8;
        }
    }
}

/// Bytes of deck `p`'s buffer arena its program addresses.
unsafe fn arena_bytes(p: *const DeckState) -> usize {
    match Program::parse(&(*p).bytes[..(*p).len]) {
        Ok(prog) => super::arena_need(&prog).min((*p).arena_len),
        Err(_) => 0,
    }
}

/// Write `ServerMessage{fx_debug: FxDebugReply{<arm>: body}}` in ONE pass (the
/// body is written once — a RAW window re-runs shade() — after a reserved
/// header, then slid down to meet the real one, like ffi.rs write_arm).
unsafe fn write_reply(out: *mut u8, cap: usize, arm: u32, body: impl FnOnce(&mut PbOut)) -> i32 {
    const HDR: usize = 8;
    if cap <= HDR {
        return -2;
    }
    let buf = core::slice::from_raw_parts_mut(out, cap);
    let n = {
        let mut w = PbOut {
            buf: Some(&mut buf[HDR..]),
            n: 0,
            ok: true,
        };
        body(&mut w);
        if !w.ok || w.n >= 1 << 14 {
            return -2;
        }
        w.n
    };
    let inner_hdr = 1 + varint_len(n as u64);
    let mut h = PbOut {
        buf: Some(&mut buf[..HDR]),
        n: 0,
        ok: true,
    };
    h.key(SRV_FX_DEBUG, 2);
    h.varint((inner_hdr + n) as u64);
    h.key(arm, 2);
    h.varint(n as u64);
    let hn = h.n;
    buf.copy_within(HDR..HDR + n, hn);
    (hn + n) as i32
}

unsafe fn write_state(now_ms: u32, out: *mut u8, cap: usize) -> i32 {
    write_reply(out, cap, REPLY_STATE, |w| {
        w.uint(1, PAUSED as u64);
        w.uint(2, STEPS as u64);
        if PAUSED {
            let left = (HOLD_MS as i64 - now_ms.wrapping_sub(LAST_MSG_MS) as i64).max(0);
            w.uint(3, left as u64);
        }
        w.fixed32(4, FX_F_TIME.to_bits());
        w.fixed32(5, FX_F_DT.to_bits());
        w.uint(6, FX_F_FRAME as u64);
        w.uint(7, FX_F_LEDS as u64);
        for d in 0..N_DECKS {
            if let Some(p) = deck(d) {
                if (*p).loaded() {
                    write_deck(w, d, p);
                }
            }
        }
        w.fixed32(9, FX_XF_POS.to_bits());
        w.uint(10, FX_XF_MODE as u64);
        let fps = &*addr_of!(FPS);
        w.uint(11, fps.current_fps() as u64);
        w.uint(12, fps.pinned_fps() as u64);
        w.uint(13, brightness() as u64);
        w.uint(14, !lut().is_null() as u64);
        let pl = player();
        let mut order = [0u8; 6];
        order[..3].copy_from_slice(&pl.hw_color_order_perm(0));
        order[3..].copy_from_slice(&pl.hw_color_order_perm(1));
        w.bytes(15, &order);
        let (c0, c1) = channel_split();
        w.uint(16, c0 as u64);
        w.uint(17, c1 as u64);
        let f: FxFrame = (*addr_of!(FX_SHADE_FRAME)).unwrap_or_default();
        w.key(18, 2);
        w.varint(FRAME_CTX_BYTES as u64);
        for i in 0..FRAME_CTX_BYTES {
            w.byte(dbg::frame_word(&f, i / 4).to_le_bytes()[i % 4]);
        }
        w.uint(19, FX_LAST_UPDATE_OUTCOME as u64);
        w.uint(20, FX_BUDGET as u64);
        w.uint(21, pl.time_base_ms().is_some() as u64);
        let reason: &str = *addr_of!(RESUME_REASON);
        if !reason.is_empty() {
            w.bytes(22, reason.as_bytes());
        }
        w.uint(23, LAYOUT_VERSION as u64);
    })
}

unsafe fn write_deck(w: &mut PbOut, d: usize, p: *mut DeckState) {
    let id = &(*p).id[..(*p).id_len];
    let (flags, jit) = match Program::parse(&(*p).bytes[..(*p).len]) {
        Ok(prog) => (
            prog.flags as u64,
            if d == DECK_A_IDX { FX_JIT_N as u64 } else { 0 },
        ),
        Err(_) => (0, 0),
    };
    let fields: [(u32, u64); 9] = [
        (1, d as u64),
        (3, program_hash(d, p) as u64),
        (4, (*p).len as u64),
        (5, (*p).renders() as u64),
        (6, flags),
        (7, jit),
        (8, arena_bytes(p) as u64),
        (9, MAX_STATE as u64),
        (10, MAX_UNIFORM_SLOTS as u64),
    ];
    let morph = (*p).morph.running();
    let mut inner: usize = fields.iter().map(|&(_, v)| 1 + varint_len(v)).sum();
    if !id.is_empty() {
        inner += 1 + varint_len(id.len() as u64) + id.len();
    }
    inner += 2 * morph as usize;
    w.key(8, 2);
    w.varint(inner as u64);
    for (f, v) in fields {
        if f == 3 && !id.is_empty() {
            w.bytes(2, id);
        }
        w.uint(f, v);
    }
    if morph {
        w.uint(11, 1);
    }
}

// -- output stage ----------------------------------------------------------------

unsafe fn brightness() -> u8 {
    if OUT_BRIGHT.is_null() {
        255
    } else {
        core::ptr::read_volatile(OUT_BRIGHT)
    }
}

unsafe fn lut() -> *const u8 {
    if OUT_LUT.is_null() {
        core::ptr::null()
    } else {
        core::ptr::read_volatile(OUT_LUT)
    }
}

/// LEDs on (channel 0, channel 1) as the render loop splits a frame.
unsafe fn channel_split() -> (u32, u32) {
    let pl = player();
    let c0 = pl.led_count(0).unwrap_or(0);
    let c1 = pl.led_count(1).unwrap_or(0);
    (c0, c1)
}

/// The LEDs the last frame shaded (and wrote to the output buffer).
unsafe fn frame_leds() -> usize {
    (FX_F_LEDS as usize).min(OUT_CAP as usize)
}

// -- per-LED shade() inputs (FX_LED_V1) ---------------------------------------------

/// The Led deck `p` hands shade() for LED `i`: the same fields fx_shade_one
/// fills (kept in step by //firmware/player_app:fx_debug_test, which compares
/// this against the deck's real per-LED scratch after a shade).
unsafe fn led_ctx(p: *const DeckState, i: usize) -> Option<FxLed> {
    let mut xyz = [0.0f32; 3];
    let mut id = 0u32;
    if !lm_map_led(i as u32, &mut id, xyz.as_mut_ptr()) {
        return None;
    }
    let [x, y, z] = xyz;
    let t = topo_store().get(i).copied().unwrap_or(FxLedTopo::NONE);
    let mut led = FxLed {
        pos: xyz,
        idx: i as u32,
        seg: -1,
        ..Default::default()
    };
    if t.seg >= 0 {
        led.seg = (t.seg & !TOPO_BRANCH) as i32;
        led.s = t.s.get();
        led.branch = t.seg & TOPO_BRANCH != 0;
        led.dist = t.dist.get();
    }
    if (*p).uses_uv {
        led.uv = [
            ((x - FX_UV_MIN[0]) * FX_UV_INV[0]).clamp(0.0, 1.0),
            ((y - FX_UV_MIN[1]) * FX_UV_INV[1]).clamp(0.0, 1.0),
        ];
    }
    if (*p).uses_room && FX_ROOM_POSED {
        led.room = room_of([x, y, z]);
    }
    Some(led)
}

// -- get_fx_snapshot ----------------------------------------------------------------

/// Total bytes of a section, or None when it doesn't apply (no such deck).
unsafe fn section_len(section: i32, d: usize, p: Option<*mut DeckState>) -> Option<usize> {
    let leds = frame_leds();
    let vm = || p.and_then(|p| (*p).vm.as_ref());
    Some(match section {
        SECTION_OUTPUT | SECTION_WIRE => leds * 3,
        SECTION_RAW => (FX_F_LEDS as usize) * 3,
        SECTION_LED_CONTEXT => (FX_F_LEDS as usize).min(fx_cap()) * LED_CTX_BYTES,
        SECTION_LUT => {
            if lut().is_null() {
                0
            } else {
                768
            }
        }
        SECTION_UNIFORMS => vm().map(|_| MAX_UNIFORM_SLOTS * 4)?,
        SECTION_STATE => vm().map(|_| (MAX_STATE + FxVm::FLOOD_WORDS) * 4)?,
        SECTION_GRAPH => vm().map(|v| 4 + v.graph_len() * 12)?,
        SECTION_ARENA => arena_bytes(p?),
        SECTION_PROGRAM => (*p?).len,
        _ => {
            let _ = d;
            return None;
        }
    })
}

/// Byte `i` of a non-per-LED section (per-LED ones are written record by record).
unsafe fn section_byte(section: i32, d: usize, p: *mut DeckState, i: usize) -> u8 {
    let word_byte = |w: u32| w.to_le_bytes()[i % 4];
    let Some(vm) = (*p).vm.as_ref() else { return 0 };
    match section {
        SECTION_UNIFORMS => word_byte(vm.uniforms[i / 4].to_bits()),
        SECTION_STATE => {
            let k = i / 4;
            word_byte(if k < MAX_STATE {
                vm.state[k].to_bits()
            } else {
                vm.flood_word(k - MAX_STATE)
            })
        }
        SECTION_GRAPH => {
            let k = i / 4;
            if k == 0 {
                return word_byte(vm.graph_len() as u32);
            }
            let (len, a, b) = vm.graph_seg((k - 1) / 3).unwrap_or((0.0, -1, -1));
            word_byte(match (k - 1) % 3 {
                0 => len.to_bits(),
                1 => a as u32,
                _ => b as u32,
            })
        }
        SECTION_ARENA => (*addr_of!(FX_ARENA))[(*p).arena_off + i],
        SECTION_PROGRAM => program_byte(d, p, i),
        _ => 0,
    }
}

pub(crate) unsafe fn handle_snapshot(frame: &[u8], now_ms: i64, out: *mut u8, cap: usize) -> i32 {
    let Some(CArm::GetFxSnapshot(m)) = client_arm(frame) else {
        return encode_reply(
            &fx_error("bad_message", "get_fx_snapshot is malformed"),
            out,
            cap,
        );
    };
    LAST_MSG_MS = now_ms as u32;
    let section = m.section();
    let d = m.deck() as usize;
    let p = deck(d).filter(|&p| (*p).loaded());
    let deck_section = matches!(
        section,
        SECTION_UNIFORMS | SECTION_STATE | SECTION_ARENA | SECTION_PROGRAM | SECTION_GRAPH
    );
    if (deck_section || section == SECTION_LED_CONTEXT) && p.is_none() {
        return encode_reply(
            &fx_error("no_effect", "no effect is loaded on that deck"),
            out,
            cap,
        );
    }
    if section == SECTION_RAW && !(PAUSED && lm_fx_active()) {
        return encode_reply(
            &fx_error("not_paused", "pause the engine to recompute RAW"),
            out,
            cap,
        );
    }
    let Some(total) = section_len(section, d, p) else {
        return encode_reply(
            &fx_error("bad_section", "unknown snapshot section"),
            out,
            cap,
        );
    };
    let want = match m.max_len() as usize {
        0 => DEFAULT_CHUNK,
        n => n.min(MAX_CHUNK),
    };
    // Leave room for the envelope + the other fields in `out`.
    let want = want.min(cap.saturating_sub(48));
    let offset = (m.offset() as usize).min(total);
    let len = want.min(total - offset);
    write_reply(out, cap, REPLY_CHUNK, |w| {
        w.uint(1, section as u64);
        w.uint(2, d as u64);
        w.uint(3, total as u64);
        w.uint(4, offset as u64);
        w.key(5, 2);
        w.varint(len as u64);
        write_window(w, section, d, p, offset, len);
        w.uint(6, FX_F_FRAME as u64);
        w.uint(7, PAUSED as u64);
    })
}

unsafe fn write_window(
    w: &mut PbOut,
    section: i32,
    d: usize,
    p: Option<*mut DeckState>,
    offset: usize,
    len: usize,
) {
    match section {
        SECTION_OUTPUT => {
            for i in offset..offset + len {
                w.byte(*OUT_LEDS.add(i));
            }
        }
        SECTION_WIRE => {
            let (c0, c1) = channel_split();
            let split = if c1 > 0 { c0 as usize } else { usize::MAX };
            let pl = player();
            let perm = [pl.hw_color_order_perm(0), pl.hw_color_order_perm(1)];
            for i in offset..offset + len {
                let led = i / 3;
                let ch = (led >= split) as usize;
                w.byte(*OUT_LEDS.add(led * 3 + perm[ch][i % 3] as usize));
            }
        }
        SECTION_LUT => {
            let l = lut();
            for i in offset..offset + len {
                w.byte(*l.add(i));
            }
        }
        SECTION_RAW => {
            let mut cur = usize::MAX;
            let mut rgb = [0u8; 3];
            for i in offset..offset + len {
                let led = i / 3;
                if led != cur {
                    cur = led;
                    rgb = raw_rgb(led);
                }
                w.byte(rgb[i % 3]);
            }
        }
        SECTION_LED_CONTEXT => {
            let p = p.unwrap();
            let mut cur = usize::MAX;
            let mut rec = [0u8; LED_CTX_BYTES];
            for i in offset..offset + len {
                let led = i / LED_CTX_BYTES;
                if led != cur {
                    cur = led;
                    let ctx = led_ctx(p, led);
                    dbg::encode_led(ctx.as_ref(), led < fx_cap() && led_mapped(led), &mut rec);
                }
                w.byte(rec[i % LED_CTX_BYTES]);
            }
        }
        _ => {
            let p = p.unwrap();
            for i in offset..offset + len {
                w.byte(section_byte(section, d, p, i));
            }
        }
    }
}

/// One LED's per-LED buffer elements, saved around a debugger re-run (see
/// ledmapper_fx_vm::dbg::led_elem_ranges): a re-run then neither perturbs the
/// paused state nor reads its own write. Bounded (stack): an effect with more
/// than SAVE_CAP bytes of per-LED buffers has the excess left as re-run.
const SAVE_CAP: usize = 128;
struct LedSave {
    bytes: [u8; SAVE_CAP],
}

/// Walk deck `p`'s bytes for LED `idx` (in led_elem_ranges order, capped).
unsafe fn led_elems(p: *const DeckState, idx: usize, mut f: impl FnMut(&mut u8, usize)) {
    let Ok(prog) = Program::parse(&(*p).bytes[..(*p).len]) else {
        return;
    };
    let arena =
        &mut (&mut *addr_of_mut!(FX_ARENA))[(*p).arena_off..(*p).arena_off + (*p).arena_len];
    let mut n = 0;
    dbg::led_elem_ranges(&prog, FX_F_LEDS as usize, idx, |o, l| {
        for b in arena.iter_mut().skip(o).take(l) {
            if n < SAVE_CAP {
                f(b, n);
                n += 1;
            }
        }
    });
}

unsafe fn led_save(p: *const DeckState, idx: usize) -> LedSave {
    let mut s = LedSave {
        bytes: [0; SAVE_CAP],
    };
    led_elems(p, idx, |b, k| s.bytes[k] = *b);
    s
}

unsafe fn led_restore(p: *const DeckState, idx: usize, s: &LedSave) {
    led_elems(p, idx, |b, k| *b = s.bytes[k]);
}

/// The blended effect colour of LED `i` before the LUT / brightness, recomputed
/// at the paused frame (the render loop's lm_fx_shade, so a cancelled shade or a
/// missing map entry is black exactly as rendered).
unsafe fn raw_rgb(i: usize) -> [u8; 3] {
    let mut xyz = [0.0f32; 3];
    let mut id = 0u32;
    let mut rgb = [0u8; 3];
    if !lm_map_led(i as u32, &mut id, xyz.as_mut_ptr()) {
        return [0; 3];
    }
    let decks = [deck(DECK_A_IDX), deck(super::DECK_B_IDX)];
    let saved = decks.map(|p| p.filter(|&p| (*p).loaded()).map(|p| (p, led_save(p, i))));
    let ok = super::lm_fx_shade(i as u32, xyz[0], xyz[1], xyz[2], rgb.as_mut_ptr());
    for (p, s) in saved.iter().flatten() {
        led_restore(*p, i, s);
    }
    if ok {
        rgb
    } else {
        [0; 3]
    }
}

// -- debug_fx_led ----------------------------------------------------------------------

pub(crate) unsafe fn handle_debug_led(frame: &[u8], now_ms: i64, out: *mut u8, cap: usize) -> i32 {
    let Some(CArm::DebugFxLed(m)) = client_arm(frame) else {
        return encode_reply(
            &fx_error("bad_message", "debug_fx_led is malformed"),
            out,
            cap,
        );
    };
    LAST_MSG_MS = now_ms as u32;
    if !(PAUSED && lm_fx_active()) {
        return encode_reply(
            &fx_error("not_paused", "pause the engine first (fx_debug_control)"),
            out,
            cap,
        );
    }
    let d = m.deck() as usize;
    let Some(p) = deck(d).filter(|&p| (*p).renders()) else {
        return encode_reply(
            &fx_error("no_effect", "no effect is rendering on that deck"),
            out,
            cap,
        );
    };
    let i = m.led() as usize;
    let mut xyz = [0.0f32; 3];
    let mut id = 0u32;
    if !lm_map_led(i as u32, &mut id, xyz.as_mut_ptr()) {
        return encode_reply(&fx_error("bad_led", "no map entry for that LED"), out, cap);
    }
    let n_locals = match m.max_locals() as usize {
        0 => MAX_LOCALS,
        n => n.min(MAX_LOCALS),
    };
    // 1) The normal path (JIT included): the colour this deck rendered. Each
    // re-run starts from the LED's paused buffer elements, and leaves them so.
    let saved = led_save(p, i);
    let jit_rgb = fx_shade_one(p, i as u32, xyz[0], xyz[1], xyz[2]);
    led_restore(p, i, &saved);
    // The Led that run used (the deck's per-LED scratch), for the record.
    let led: FxLed = (*p).shade_led.unwrap_or_default();
    // 2) The interpreter, JIT patches undone, zeroed scratch: locals to compare.
    let Some(vm) = (*p).vm.as_mut() else {
        return encode_reply(&fx_error("no_effect", "no VM on that deck"), out, cap);
    };
    let jit_parts = vm.jit_raw();
    let patched = d == DECK_A_IDX && FX_JIT_N > 0;
    if patched {
        jit_unpatch(true);
    }
    vm.clear_jit();
    vm.clear_scratch();
    let f: FxFrame = (*addr_of!(FX_SHADE_FRAME)).unwrap_or_default();
    let (rgb, outcome, counters) = match Program::parse(&(*p).bytes[..(*p).len]) {
        Ok(prog) => vm.run_shade_counted(&prog, &f, &led, &fx_budget()),
        Err(_) => ((0, 0, 0), ledmapper_fx_vm::Outcome::Ok, Default::default()),
    };
    led_restore(p, i, &saved);
    let mut rec = [0u8; LED_CTX_BYTES];
    dbg::encode_led(Some(&led), i < fx_cap() && led_mapped(i), &mut rec);
    let output = if i < frame_leds() {
        [
            *OUT_LEDS.add(i * 3),
            *OUT_LEDS.add(i * 3 + 1),
            *OUT_LEDS.add(i * 3 + 2),
        ]
    } else {
        [0; 3]
    };
    let locals: &[f32; MAX_LOCALS] = vm.locals();
    let n = write_reply(out, cap, REPLY_LED, |w| {
        w.uint(1, i as u64);
        w.uint(2, d as u64);
        w.bytes(3, &[rgb.0, rgb.1, rgb.2]);
        if let Some(c) = jit_rgb {
            w.bytes(4, &[c.0, c.1, c.2]);
        }
        w.bytes(5, &output);
        w.uint(6, outcome as u64);
        w.key(7, 2);
        w.varint((n_locals * 4) as u64);
        for v in &locals[..n_locals] {
            for b in v.to_bits().to_le_bytes() {
                w.byte(b);
            }
        }
        w.bytes(8, &rec);
        w.uint(9, counters.instrs as u64);
        w.uint(10, counters.stack_max as u64);
    });
    if patched {
        jit_unpatch(false);
    }
    vm.set_jit_raw(jit_parts);
    n
}
