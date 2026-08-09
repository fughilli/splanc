//! Effects bytecode VM (see docs/design/effects-runtime.md).
//!
//! A tiny stack machine over `f32` slots (a `vecN` is N contiguous slots; the
//! compiler guarantees types so the VM is untyped at runtime). It runs a
//! program's `update()` once per frame (evolving `state`) and `shade(led)` once
//! per LED (returning linear RGB). no_std, no alloc — bounded fixed arrays,
//! borrows the `.fxb` bytes so the firmware can execute straight from the flash
//! range LittleFS mapped. The SAME crate compiles to wasm for the offline
//! preview, so the browser and the device render identically.
#![no_std]

pub type Rgb = (u8, u8, u8);

pub const MAX_STACK: usize = 128; // f32 slots
pub const MAX_STATE: usize = 128; // raised for arrays/structs (agent sims live here)
pub const MAX_LOCALS: usize = 128;
pub const MAX_UNIFORM_SLOTS: usize = 128;

// Topology graph tables the VM carries for graph-walking effects (agentic
// chasers): segments (length + the two endpoint node ids) and, per node, the
// incident segments. Bounded (≈2.6 KiB) and filled via [`Vm::set_graph`] when
// the topology changes — the graph-query intrinsics (seg_len/node_seg/…) read
// these. Excess segments/nodes/degree are dropped (queries clamp/return 0).
pub const MAX_SEG: usize = 64;
pub const MAX_NODE: usize = 96;
pub const MAX_NODE_DEG: usize = 6;

/// Dynamic opcode-execution profiler — HOST-ONLY, compiled in only under the
/// `profile` cargo feature (so the shipped firmware/wasm build carries zero extra
/// code or RAM). Single-threaded use only: the host profiler (tools/fx_profile)
/// runs effects serially, resets between them, and reads the histogram out. It
/// records both per-opcode execution counts and adjacent-pair counts (the latter
/// picks superinstruction fusion candidates).
#[cfg(feature = "profile")]
pub mod profile {
    /// Opcodes fit in a u8, so 256 buckets cover every possible value.
    pub const N_OPS: usize = 256;
    static mut OP_COUNTS: [u64; N_OPS] = [0; N_OPS];
    static mut PAIR_COUNTS: [u32; N_OPS * N_OPS] = [0; N_OPS * N_OPS];

    /// Record one executed opcode `op`, following `prev` (`usize::MAX` = none).
    #[inline]
    pub(crate) fn record(prev: usize, op: usize) {
        unsafe {
            (*core::ptr::addr_of_mut!(OP_COUNTS))[op] += 1;
            if prev < N_OPS {
                (*core::ptr::addr_of_mut!(PAIR_COUNTS))[prev * N_OPS + op] += 1;
            }
        }
    }

    /// Zero all counters (call before running an effect to profile).
    pub fn reset() {
        unsafe {
            for c in (*core::ptr::addr_of_mut!(OP_COUNTS)).iter_mut() {
                *c = 0;
            }
            for c in (*core::ptr::addr_of_mut!(PAIR_COUNTS)).iter_mut() {
                *c = 0;
            }
        }
    }

    /// Total instructions executed since the last [`reset`].
    pub fn total() -> u64 {
        unsafe { (*core::ptr::addr_of!(OP_COUNTS)).iter().sum() }
    }

    /// Execution count for opcode `op`.
    pub fn op_count(op: u8) -> u64 {
        unsafe { (*core::ptr::addr_of!(OP_COUNTS))[op as usize] }
    }

    /// Execution count for the adjacent pair `a` then `b`.
    pub fn pair_count(a: u8, b: u8) -> u32 {
        unsafe { (*core::ptr::addr_of!(PAIR_COUNTS))[a as usize * N_OPS + b as usize] }
    }
}

/// Opcodes. Operands follow inline in the code stream (little-endian).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Op {
    PushConst = 0, // u16 const idx        -> push consts[idx] (1 slot)
    LoadUniform,   // u8 slot, u8 n        -> push uniforms[slot..slot+n]
    LoadState,     // u8 slot, u8 n        -> push state[..]
    StoreState,    // u8 slot, u8 n        -> pop n into state[..]
    LoadLocal,     // u8 slot, u8 n
    StoreLocal,    // u8 slot, u8 n
    LoadCtx,       // u8 id                -> push a context value (size by id)
    // element-wise arithmetic, operand u8 n (components)
    Add,
    Sub,
    Mul,
    Div,
    Neg,
    Scale, // u8 n: pop n-vec then scalar -> n-vec * scalar
    // unary math applied per component, operand: u8 fn, u8 n
    UnMath,
    // binary math per component, operand: u8 fn, u8 n
    BinMath,
    Clamp,      // u8 n: pop x(n),lo(n),hi(n)
    Mix,        // u8 n: pop a(n),b(n),t(1) -> a+(b-a)*t
    Smoothstep, // u8 n: pop e0(n),e1(n),x(n)
    Dot,        // u8 n -> scalar
    Cross,      // (n=3) pop a(3),b(3) -> 3
    Length,     // u8 n -> scalar
    Normalize,  // u8 n
    Distance,   // u8 n -> scalar
    Swizzle,    // u8 srcN, u8 dstN, dstN bytes of component indices
    Cmp,        // u8 kind (0lt 1le 2gt 3ge 4eq 5ne) scalar -> bool(0/1)
    Logic,      // u8 kind (0and 1or 2not)
    BrFalse,    // i16 rel: pop bool; branch if 0
    Jmp,        // i16 rel
    Hash1,      // scalar -> scalar in [0,1)
    Hash3,      // pop vec3 -> scalar
    Hsv2Rgb,    // pop vec3(h,s,v) -> vec3 rgb
    Palette,    // u8 id: pop scalar t -> vec3
    Pop,        // u8 n
    Ret,        // return `n` slots (0 for update, 3 for shade) : u8 n
    // --- integer / Q16.16 fixed-point fast path (scalar, no FPU) ------------
    Swap,   // u8 an, u8 bn : swap the top bn slots with the an below (broadcast)
    AddI,   // i32 add
    SubI,
    MulI,
    DivI,
    ModI,
    NegI,
    CmpI,   // u8 kind : integer compare -> bool
    MulFix, // Q16.16: (a*b)>>16
    DivFix, // Q16.16: (a<<16)/b
    I2F,    // i32 -> f32
    F2I,    // f32 -> i32 (trunc)
    Fix2F,  // Q16.16 -> f32
    F2Fix,  // f32 -> Q16.16
    I2Fix,  // i32 -> Q16.16 (<<16)
    Fix2I,  // Q16.16 -> i32 (>>16)
    // --- user functions -----------------------------------------------------
    Call,  // u16 target : push return pc, jump
    RetFn, // pop return pc, jump back (values left on the operand stack)
    // --- indexed array/struct access (dynamic index) ------------------------
    // Address = base + clamp(i, 0, count-1)*stride + off. The index i (int, in
    // f32 bits) is popped; the clamp keeps a runaway index in-bounds (safe,
    // deterministic) rather than reading/writing past the slot arrays.
    LoadStateIdx, // base:u8 stride:u8 off:u8 n:u8 count:u8 ; pop i -> push n slots
    StoreStateIdx, // base:u8 stride:u8 off:u8 n:u8 count:u8 ; pop n vals then i
    LoadLocalIdx,  // same, over locals
    StoreLocalIdx,
    // --- topology graph queries (agentic/graph-walking effects) --------------
    // u8 kind: 0 seg_count()->int, 1 seg_len(seg)->float, 2 seg_node(seg,side)->int,
    // 3 node_deg(node)->int, 4 node_seg(node,k)->int, 5 node_side(node,k)->int.
    // Int args are popped (2,4,5 pop two; 1,3 pop one; 0 pops none); the result
    // is pushed as a float slot (int results carry their i32 bits). Reads the
    // graph tables the VM was given via set_graph.
    GraphQuery,
    // --- declared buffers / textures (feedback, pixel-space) -----------------
    // LoadBuf u8 id: pop an int index -> push the buffer element's `elem` slots
    // from the arena. StoreBuf u8 id: pop `elem` value slots then an int index ->
    // write the element. The element width/count come from the .fxb buffer desc;
    // the index is clamped in-bounds. No-op / 0 when no arena is bound.
    LoadBuf,
    StoreBuf,
    // --- 2D texture sampling (kind=1 buffers) --------------------------------
    // SampleTex u8 id: pop a uv (vec2, 0..1) -> push `elem` slots, BILINEARLY
    // sampled from the WxH texture (edge-clamped). PaintTex u8 id: pop `elem`
    // colour slots then a uv -> write the NEAREST texel. w/h/elem come from the
    // .fxb buffer desc. No-op / 0 when no arena is bound or the buffer isn't a
    // texture (kind != 1).
    SampleTex,
    PaintTex,
    // --- settable geodesic source (topology flood/agents) --------------------
    // FloodFrom: pop an int node id, run a single-source geodesic sweep over the
    // graph into the VM's DistSrc, so subsequent `led.dist` reads report distance
    // from that node (normalized 0..1 by the reach). Void; call once per cycle in
    // update(). No source set → led.dist stays the map-load root field.
    FloodFrom,
    // --- reduced-precision fixed-point (Q1.f) fast path (FUG-10) --------------
    // Narrow fixed-point types `fixed8` (Q1.6, s1.1.6, 8-bit logical) and
    // `fixed16` (Q1.14, s1.1.14, 16-bit logical) — both range [-2, 2). The value
    // rides in the low bits of the slot as a scaled integer (like Q16.16); +,-,
    // neg and compares reuse the integer ops, so only mul/div and the format
    // boundary need format-aware opcodes. These carry a `frac` operand (bits of
    // fraction: 6 for Q1.6, 14 for Q1.14, and 16 works for Q16.16 too), so a
    // single opcode serves every fixed width. All integer-only — no soft-float.
    MulFixN, // u8 frac : (a*b) >> frac
    DivFixN, // u8 frac : (a << frac) / b
    // Reinterpret an integer/fixed value between formats by an arithmetic shift.
    // Operand is a signed shift (i8 in a u8): >=0 shifts left (more frac bits),
    // <0 shifts right. int↔fixed8 = ±6, int↔fixed16 = ±14, fixed8↔fixed16 = ±8,
    // etc. Pure integer; no float involved.
    FixRescale, // i8 shift
    // Fixed/int ↔ f32 boundary (the only place soft-float appears for these
    // types): FixToF pops a scaled int and pushes raw/2^frac; FixFromF pops a
    // float and pushes trunc(x*2^frac). frac=0 makes them int↔float.
    FixToF,   // u8 frac
    FixFromF, // u8 frac
    // Accelerated reduced-precision transcendentals — the FUG-10 win: sin/cos/exp
    // evaluated in pure integer arithmetic (LUT + linear interpolation), so an
    // effect can do trig without dragging in the f32 soft-float path. The operand
    // is the fixed frac width (6 or 14). sin/cos take the angle in TURNS (1.0 =
    // one full circle) as Q1.frac and return Q1.frac in [-1, 1] — no range
    // reduction needed. exp takes Q1.frac and returns Q1.frac, SATURATED to the
    // ±2 range (so it is meaningful for decay, x ≲ 0.69; larger x pins at +2).
    SinFix, // u8 frac
    CosFix, // u8 frac
    ExpFix, // u8 frac
    // Integer/fixed compare + select + abs. The stack word already rides a scaled
    // integer for `int` AND every fixed format (Q16.16/Q1.14/Q1.6), and these ops
    // are monotonic on that representation, so ONE integer opcode each serves all
    // of them — no soft-float, no reinterpreting the bits as f32.
    AbsI,   // |x|
    MinI,   // min(a, b)
    MaxI,   // max(a, b)
    ClampI, // clamp(x, lo, hi)
    // More int/fixed-native builtins. Those that yield a "1" (sign/step) or round
    // to whole units (floor/ceil/fract) or interpolate (mix) take a u8 `frac`
    // operand so one opcode covers int (frac 0) AND every fixed format.
    SignI,   // u8 frac : -1/0/+1 in the arg's units (±(1<<frac))
    StepI,   // u8 frac : x >= edge ? (1<<frac) : 0
    FloorFix, // u8 frac : round toward -inf to a whole unit (frac 0 = identity)
    CeilFix,  // u8 frac : round toward +inf to a whole unit
    FractFix, // u8 frac : x - floor(x), in [0,1) units (frac 0 = 0)
    MixFix,   // u8 frac : a + ((b-a)*t >> frac)  (fixed lerp)
}

/// Graph-query kinds (the `GraphQuery` opcode operand).
pub mod gq {
    pub const SEG_COUNT: u8 = 0;
    pub const SEG_LEN: u8 = 1;
    pub const SEG_NODE: u8 = 2;
    pub const NODE_DEG: u8 = 3;
    pub const NODE_SEG: u8 = 4;
    pub const NODE_SIDE: u8 = 5;
    pub const TERM_COUNT: u8 = 6; // number of termini (degree-1 nodes)
    pub const TERM: u8 = 7; // the a-th terminus node id (-1 if out of range)
}

pub const FIX_ONE: i32 = 1 << 16;

/// Fraction bits for the narrow fixed formats (FUG-10). `fixed8` is Q1.6
/// (s1.1.6) and `fixed16` is Q1.14 (s1.1.14); both range [-2, 2). These are the
/// `frac` operand the `*FixN` / transcendental opcodes carry.
pub const FRAC8: u8 = 6;
pub const FRAC16: u8 = 14;

/// Default per-invocation instruction budget (one `update()` or one `shade()`).
/// A pathological loop trips this deterministically on every platform, so the
/// render task can never hang on a user script. See [`Budget`].
pub const DEFAULT_BUDGET: u32 = 100_000;

/// A bounded-execution guard for one VM invocation (the DECISION in
/// docs/design/effects-runtime.md "Open questions").
///
/// Two independent guards, primary first:
/// 1. **instruction budget** — a hard, deterministic op count. It is the
///    portable, host-testable wall against runaway loops; when it hits zero the
///    invocation unwinds to a [`Outcome::Budget`] timeout.
/// 2. **wall-time deadline flag** — an optional pointer to a flag the VM loop
///    polls each op. On-device a hardware timer (esp_timer/systimer) raises it
///    at a frame-relative deadline (the C++ side owns that timer); the VM sees
///    the raised flag and unwinds to [`Outcome::Timeout`]. On the host it is
///    left `None`, so tests exercise the budget guard alone.
#[derive(Clone, Copy)]
pub struct Budget {
    /// Max instructions before the invocation is cancelled.
    pub instructions: u32,
    /// Optional wall-time cancel flag (raised asynchronously by a hw timer).
    /// `None` = no time guard (host/preview). Read-only from the VM's view.
    pub deadline: Option<*const core::sync::atomic::AtomicBool>,
}

impl Default for Budget {
    fn default() -> Self {
        Budget { instructions: DEFAULT_BUDGET, deadline: None }
    }
}

impl Budget {
    /// A budget with just an instruction cap (no wall-time guard).
    pub fn instructions(n: u32) -> Self {
        Budget { instructions: n, deadline: None }
    }
}

/// Why a VM invocation stopped.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Outcome {
    /// Ran to a `Ret`/`RetFn`/end-of-code normally.
    Ok,
    /// The instruction budget was exhausted (runaway loop) — treat as timeout.
    Budget,
    /// The wall-time deadline flag was raised (hardware timer) — treat as
    /// timeout. The caller holds last/black for the affected LED.
    Timeout,
}

impl Outcome {
    /// Whether execution was cancelled by a guard (budget or wall-time).
    #[inline]
    pub fn timed_out(self) -> bool {
        !matches!(self, Outcome::Ok)
    }
}

/// Cheap Tier-1 profiling counters for one VM invocation (perf-monitoring.md
/// "Metrics collected"). Both are near-free by construction: `instrs` is one
/// add per opcode next to the budget decrement already in the dispatch loop,
/// and `stack_max` piggybacks the running stack pointer. Integer-only — no
/// float on the perf path. See [`Vm::run_shade_counted`] / [`run_update_counted`].
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Counters {
    /// Opcodes retired this invocation.
    pub instrs: u32,
    /// High-water operand-stack depth (f32 slots) reached this invocation.
    pub stack_max: u16,
}

impl Op {
    #[inline]
    pub fn from_u8(b: u8) -> Option<Op> {
        // Op is a contiguous enum 0..=MixFix; guard the range then transmute.
        if b <= Op::MixFix as u8 {
            Some(unsafe { core::mem::transmute::<u8, Op>(b) })
        } else {
            None
        }
    }
}

// unary math fn ids
pub const F_SIN: u8 = 0;
pub const F_COS: u8 = 1;
pub const F_ABS: u8 = 2;
pub const F_FLOOR: u8 = 3;
pub const F_CEIL: u8 = 4;
pub const F_FRACT: u8 = 5;
pub const F_SQRT: u8 = 6;
pub const F_EXP: u8 = 7;
pub const F_LOG: u8 = 8;
pub const F_SIGN: u8 = 9;
pub const F_TAN: u8 = 10;
// binary math fn ids
pub const B_MIN: u8 = 0;
pub const B_MAX: u8 = 1;
pub const B_POW: u8 = 2;
pub const B_MOD: u8 = 3;
pub const B_STEP: u8 = 4; // step(edge, x)
pub const B_ATAN2: u8 = 5;

// context value ids (LoadCtx)
pub const C_TIME: u8 = 0; // 1
pub const C_DT: u8 = 1; // 1
pub const C_FRAME: u8 = 2; // 1
pub const C_LED_POS: u8 = 3; // 3
pub const C_LED_IDX: u8 = 4; // 1
pub const C_LED_COUNT: u8 = 5; // 1
pub const C_LED_SEG: u8 = 6; // 1
pub const C_LED_S: u8 = 7; // 1
pub const C_LED_BRANCH: u8 = 8; // 1
pub const C_IMU_ACCEL: u8 = 9; // 3
pub const C_IMU_GYRO: u8 = 10; // 3
pub const C_LED_DIST: u8 = 11; // 1 — geodesic distance along the topology, 0..1
pub const C_LED_UV: u8 = 12; // 2 — per-LED texture coord (pos.xy over map bounds)

pub const MAGIC: [u8; 4] = *b"FXB1";
pub const NO_ENTRY: u16 = 0xFFFF;

/// A parsed program, borrowing the `.fxb` byte buffer.
pub struct Program<'a> {
    consts: &'a [u8], // n_consts * 4 bytes (LE f32; read unaligned)
    code: &'a [u8],
    pub n_state: u8,
    pub n_uniform_slots: u8,
    pub update_entry: u16, // NO_ENTRY if absent
    pub shade_entry: u16,
    /// The raw uniforms manifest (for the app; the VM ignores it).
    pub manifest: &'a [u8],
    /// Buffer descriptor table (present when flags & FLAG_BUFFERS): `n_buffers`
    /// entries of `BUF_DESC_LEN` bytes each — kind(u8) elem(u8) comp(u8) w(u16)
    /// h(u16). A buffer of `kind=0` is LED-arity (arity = led_count); `kind=1` is
    /// a WxH 2D texture. `comp` is the per-component storage precision (see
    /// [`comp`]). Held raw; [`buf_desc`] decodes an entry.
    pub n_buffers: u8,
    buffers: &'a [u8],
}

/// flags bit: a buffer descriptor table follows `code` in the `.fxb`.
pub const FLAG_BUFFERS: u8 = 0x01;
/// Bytes per buffer descriptor: kind(u8) elem(u8) comp(u8) w(u16) h(u16).
pub const BUF_DESC_LEN: usize = 7;

/// Component storage precision for a buffer/texture (FUG-10 packed storage). A
/// buffer element is `elem` components each stored at `comp`'s byte width, so an
/// 8-bit format packs a per-LED value into ONE byte instead of a 4-byte f32
/// slot. The `*F` variants store a compressed fixed-point but present as a
/// dequantized `f32` on the stack (for compressing float/vec colors); the plain
/// fixed/int variants present the raw scaled integer (the narrow first-class
/// types). See [`comp_bytes`] / [`comp_load`] / [`comp_store`].
pub mod comp {
    pub const F32: u8 = 0; // 4 B, f32
    pub const FIX16: u8 = 1; // 2 B, Q1.14 raw -> fixed16 on the stack
    pub const FIX8: u8 = 2; // 1 B, Q1.6 raw -> fixed8 on the stack
    pub const I16: u8 = 3; // 2 B, i16 -> int on the stack
    pub const I8: u8 = 4; // 1 B, i8 -> int on the stack
    pub const FIX16F: u8 = 5; // 2 B, Q1.14 stored, dequantized to f32 on the stack
    pub const FIX8F: u8 = 6; // 1 B, Q1.6 stored, dequantized to f32 on the stack
    pub const I32: u8 = 7; // 4 B, i32 -> int on the stack
}

/// Storage width in bytes of one component of precision `c`.
pub fn comp_bytes(c: u8) -> usize {
    match c {
        comp::F32 | comp::I32 => 4,
        comp::FIX16 | comp::I16 | comp::FIX16F => 2,
        comp::FIX8 | comp::I8 | comp::FIX8F => 1,
        _ => 4,
    }
}

/// Unpack one stored component (`b` ≥ [`comp_bytes`] long) into the VM's stack
/// word (an `f32` slot). Raw fixed/int variants ride their scaled integer in the
/// f32 bits (`f32::from_bits`); the `*F`/`F32` variants carry a real float.
#[inline]
pub fn comp_load(c: u8, b: &[u8]) -> f32 {
    match c {
        comp::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        comp::I32 => f32::from_bits(i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as u32),
        comp::FIX16 | comp::I16 => f32::from_bits(i16::from_le_bytes([b[0], b[1]]) as i32 as u32),
        comp::FIX8 | comp::I8 => f32::from_bits((b[0] as i8) as i32 as u32),
        comp::FIX16F => i16::from_le_bytes([b[0], b[1]]) as f32 / (1 << FRAC16) as f32,
        comp::FIX8F => (b[0] as i8) as f32 / (1 << FRAC8) as f32,
        _ => 0.0,
    }
}

/// Pack the VM's stack word `v` into `out` (≥ [`comp_bytes`] long) at precision
/// `c`. Narrow integers/fixed are clamped to their storage range (deterministic,
/// no wild wrap); the `*F` variants quantize a float with rounding.
#[inline]
pub fn comp_store(c: u8, v: f32, out: &mut [u8]) {
    let clamp16 = |x: i32| x.clamp(i16::MIN as i32, i16::MAX as i32) as i16;
    let clamp8 = |x: i32| x.clamp(i8::MIN as i32, i8::MAX as i32) as i8;
    match c {
        comp::F32 => out[..4].copy_from_slice(&v.to_le_bytes()),
        comp::I32 => out[..4].copy_from_slice(&(v.to_bits() as i32).to_le_bytes()),
        comp::FIX16 | comp::I16 => {
            out[..2].copy_from_slice(&clamp16(v.to_bits() as i32).to_le_bytes())
        }
        comp::FIX8 | comp::I8 => out[0] = clamp8(v.to_bits() as i32) as u8,
        comp::FIX16F => {
            let q = round_f32(v * (1 << FRAC16) as f32) as i32;
            out[..2].copy_from_slice(&clamp16(q).to_le_bytes());
        }
        comp::FIX8F => {
            let q = round_f32(v * (1 << FRAC8) as f32) as i32;
            out[0] = clamp8(q) as u8;
        }
        _ => {}
    }
}

#[inline]
fn round_f32(x: f32) -> f32 {
    if x >= 0.0 {
        floorf(x + 0.5)
    } else {
        -floorf(-x + 0.5)
    }
}

/// Load one stored component as its NUMERIC float value (raw fixed/int are
/// dequantized to a real number, not the scaled-int bits). Used by texture
/// sampling, which interpolates and always yields float colours.
#[inline]
pub fn comp_load_num(c: u8, b: &[u8]) -> f32 {
    match c {
        comp::F32 => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
        comp::I32 => i32::from_le_bytes([b[0], b[1], b[2], b[3]]) as f32,
        comp::I16 => i16::from_le_bytes([b[0], b[1]]) as f32,
        comp::I8 => (b[0] as i8) as f32,
        comp::FIX16 | comp::FIX16F => i16::from_le_bytes([b[0], b[1]]) as f32 / (1 << FRAC16) as f32,
        comp::FIX8 | comp::FIX8F => (b[0] as i8) as f32 / (1 << FRAC8) as f32,
        _ => 0.0,
    }
}

/// Store a NUMERIC float value into one component (quantizing/rounding to the
/// component's precision). The paint() counterpart to [`comp_load_num`].
#[inline]
pub fn comp_store_num(c: u8, v: f32, out: &mut [u8]) {
    let clamp16 = |x: f32| round_f32(x).clamp(i16::MIN as f32, i16::MAX as f32) as i16;
    let clamp8 = |x: f32| round_f32(x).clamp(i8::MIN as f32, i8::MAX as f32) as i8;
    match c {
        comp::F32 => out[..4].copy_from_slice(&v.to_le_bytes()),
        comp::I32 => out[..4].copy_from_slice(&(round_f32(v) as i32).to_le_bytes()),
        comp::I16 => out[..2].copy_from_slice(&clamp16(v).to_le_bytes()),
        comp::I8 => out[0] = clamp8(v) as u8,
        comp::FIX16 | comp::FIX16F => {
            out[..2].copy_from_slice(&clamp16(v * (1 << FRAC16) as f32).to_le_bytes())
        }
        comp::FIX8 | comp::FIX8F => out[0] = clamp8(v * (1 << FRAC8) as f32) as u8,
        _ => {}
    }
}

/// One decoded buffer descriptor.
#[derive(Clone, Copy, Default)]
pub struct BufDesc {
    pub kind: u8, // 0 = LED-arity, 1 = 2D texture
    pub elem: u8, // components per element (1 = scalar, 3 = vec3, …)
    pub comp: u8, // component storage precision (see [`comp`])
    pub w: u16,   // texture width (kind 1); 0 for LED-arity
    pub h: u16,   // texture height (kind 1); 0 for LED-arity
}

impl BufDesc {
    /// Storage size in bytes of one element (all `elem` components).
    #[inline]
    pub fn elem_bytes(&self) -> usize {
        self.elem as usize * comp_bytes(self.comp)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseErr {
    TooShort,
    BadMagic,
    BadVersion,
}

fn rd_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

impl<'a> Program<'a> {
    /// Header: magic(4) ver(1) flags(1) n_state(1) n_uniform_slots(1)
    /// manifest_len(2) n_consts(2) code_len(2) update_entry(2) shade_entry(2)
    pub fn parse(buf: &'a [u8]) -> Result<Program<'a>, ParseErr> {
        if buf.len() < 18 {
            return Err(ParseErr::TooShort);
        }
        if buf[0..4] != MAGIC {
            return Err(ParseErr::BadMagic);
        }
        if buf[4] != 1 {
            return Err(ParseErr::BadVersion);
        }
        let flags = buf[5];
        let n_state = buf[6];
        let n_uniform_slots = buf[7];
        let manifest_len = rd_u16(buf, 8) as usize;
        let n_consts = rd_u16(buf, 10) as usize;
        let code_len = rd_u16(buf, 12) as usize;
        let update_entry = rd_u16(buf, 14);
        let shade_entry = rd_u16(buf, 16);
        let mut o = 18;
        let manifest = buf.get(o..o + manifest_len).ok_or(ParseErr::TooShort)?;
        o += manifest_len;
        let consts = buf.get(o..o + n_consts * 4).ok_or(ParseErr::TooShort)?;
        o += n_consts * 4;
        let code = buf.get(o..o + code_len).ok_or(ParseErr::TooShort)?;
        o += code_len;
        // Optional buffer descriptor table (appended after code, back-compatible).
        let (n_buffers, buffers) = if flags & FLAG_BUFFERS != 0 {
            let nb = *buf.get(o).ok_or(ParseErr::TooShort)?;
            o += 1;
            let bytes = buf
                .get(o..o + nb as usize * BUF_DESC_LEN)
                .ok_or(ParseErr::TooShort)?;
            (nb, bytes)
        } else {
            (0, &buf[buf.len()..])
        };
        Ok(Program {
            consts,
            code,
            n_state,
            n_uniform_slots,
            update_entry,
            shade_entry,
            manifest,
            n_buffers,
            buffers,
        })
    }

    /// Decode buffer descriptor `i` (or `None`).
    pub fn buf_desc(&self, i: usize) -> Option<BufDesc> {
        let b = self.buffers.get(i * BUF_DESC_LEN..i * BUF_DESC_LEN + BUF_DESC_LEN)?;
        Some(BufDesc {
            kind: b[0],
            elem: b[1],
            comp: b[2],
            w: u16::from_le_bytes([b[3], b[4]]),
            h: u16::from_le_bytes([b[5], b[6]]),
        })
    }

    /// Number of elements buffer `d` holds (LED-arity buffers scale with the
    /// live `led_count`; 2D textures are `w*h`).
    #[inline]
    fn buf_count(d: &BufDesc, led_count: usize) -> usize {
        if d.kind == 0 {
            led_count
        } else {
            d.w as usize * d.h as usize
        }
    }

    /// Total arena BYTES the program's buffers need, given `led_count` — each
    /// element is packed at its component precision ([`BufDesc::elem_bytes`]), so
    /// an 8-bit buffer costs a quarter of an f32 one.
    pub fn arena_bytes(&self, led_count: usize) -> usize {
        let mut n = 0;
        for i in 0..self.n_buffers as usize {
            if let Some(d) = self.buf_desc(i) {
                n += d.elem_bytes() * Self::buf_count(&d, led_count);
            }
        }
        n
    }

    /// Byte offset of buffer `id`'s region within the (byte-addressed) arena.
    /// Public so the host FFI can stream video frames straight into a texture.
    pub fn buf_base(&self, id: usize, led_count: usize) -> usize {
        let mut base = 0;
        for i in 0..id.min(self.n_buffers as usize) {
            if let Some(d) = self.buf_desc(i) {
                base += d.elem_bytes() * Self::buf_count(&d, led_count);
            }
        }
        base
    }

    #[inline]
    fn const_f32(&self, idx: usize) -> f32 {
        let o = idx * 4;
        f32::from_le_bytes([
            self.consts[o],
            self.consts[o + 1],
            self.consts[o + 2],
            self.consts[o + 3],
        ])
    }
}

/// Per-frame context (constant across all LEDs of one frame).
#[derive(Clone, Copy, Default)]
pub struct Frame {
    pub time: f32,
    pub dt: f32,
    pub frame: u32,
    pub led_count: u32,
    pub imu_accel: [f32; 3],
    pub imu_gyro: [f32; 3],
}

/// Per-LED context.
#[derive(Clone, Copy, Default)]
pub struct Led {
    pub pos: [f32; 3],
    pub idx: u32,
    pub seg: i32,
    pub s: f32,
    pub branch: bool,
    /// Geodesic distance from the topology root, normalized 0..1 along the
    /// segment graph (accumulates across segments, unlike `s` which is per
    /// segment). 0 when there is no topology. Enables flood/pulse effects.
    pub dist: f32,
    /// Per-LED texture coordinate in 0..1, the LED's XY position normalized over
    /// the map's bounding box (a top-down projection of the gravity-leveled
    /// frame). Feeds `led.uv` for texture-mapped effects (`sample(tex, led.uv)`).
    pub uv: [f32; 2],
}

/// Persistent VM state across frames: uniform values + `state` vars + the
/// topology graph tables (for graph-walking effects — see [`Vm::set_graph`]).
pub struct Vm {
    pub uniforms: [f32; MAX_UNIFORM_SLOTS],
    pub state: [f32; MAX_STATE],
    // -- topology graph (read-only; filled by set_graph) --
    n_seg: u32,
    seg_len: [f32; MAX_SEG],       // segment arclength (meters)
    seg_node: [[i32; 2]; MAX_SEG], // endpoint node ids (a, b); -1 = free end w/o node
    node_deg: [u8; MAX_NODE],      // incident-segment count per node (clamped to MAX_NODE_DEG)
    node_seg: [[i16; MAX_NODE_DEG]; MAX_NODE], // incident segment ids
    node_side: [[u8; MAX_NODE_DEG]; MAX_NODE], // which end (0=a,1=b) of that segment touches the node
    // Buffer arena (LED-arity buffers / textures): external memory bound per
    // program via set_arena. BYTE-addressed (FUG-10 packed storage) so narrow
    // elements pack tightly. Raw ptr so Vm needs no lifetime; the caller keeps
    // it alive and disjoint from `state`. Null/0 = no buffers.
    arena_ptr: *mut u8,
    arena_len: usize,
    // Single-source geodesic field for `flood_from` (see [`DistSrc`]). Persists
    // across frames like `state`; reset when a fresh effect is loaded.
    dist_src: DistSrc,
}

/// Single-source geodesic node-distance field, filled by the `flood_from`
/// opcode: `d[node]` is the raw arclength (meters) from the chosen source node
/// to each node, `max` the farthest reach (for normalizing `led.dist` to 0..1).
/// `set` stays false until a shader calls `flood_from`, so `led.dist` defaults
/// to the map-load root field carried in the [`Led`] struct.
#[derive(Clone, Copy)]
pub struct DistSrc {
    d: [f32; MAX_NODE],
    max: f32,
    set: bool,
}

impl Default for DistSrc {
    fn default() -> Self {
        DistSrc { d: [f32::INFINITY; MAX_NODE], max: 1.0, set: false }
    }
}

impl Default for Vm {
    fn default() -> Self {
        Vm {
            uniforms: [0.0; MAX_UNIFORM_SLOTS],
            state: [0.0; MAX_STATE],
            n_seg: 0,
            seg_len: [0.0; MAX_SEG],
            seg_node: [[-1; 2]; MAX_SEG],
            node_deg: [0; MAX_NODE],
            node_seg: [[0; MAX_NODE_DEG]; MAX_NODE],
            node_side: [[0; MAX_NODE_DEG]; MAX_NODE],
            arena_ptr: core::ptr::null_mut(),
            arena_len: 0,
            dist_src: DistSrc::default(),
        }
    }
}

impl Vm {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a uniform's value (`vals` length = its slot count).
    pub fn set_uniform(&mut self, slot: usize, vals: &[f32]) {
        for (i, v) in vals.iter().enumerate() {
            if slot + i < MAX_UNIFORM_SLOTS {
                self.uniforms[slot + i] = *v;
            }
        }
    }

    /// Fill the topology graph tables from per-segment arclengths and endpoint
    /// node ids (`seg_a`/`seg_b`, -1 for a free end with no shared node), then
    /// build the per-node incident-segment lists. Call whenever the topology
    /// changes; pass empty slices to clear. The graph-query intrinsics read this.
    pub fn set_graph(&mut self, seg_len: &[f32], seg_a: &[i32], seg_b: &[i32]) {
        let n = seg_len.len().min(seg_a.len()).min(seg_b.len()).min(MAX_SEG);
        self.n_seg = n as u32;
        self.node_deg = [0; MAX_NODE];
        for i in 0..n {
            self.seg_len[i] = seg_len[i];
            self.seg_node[i] = [seg_a[i], seg_b[i]];
            for side in 0..2usize {
                let node = self.seg_node[i][side];
                if node >= 0 && (node as usize) < MAX_NODE {
                    let d = self.node_deg[node as usize] as usize;
                    if d < MAX_NODE_DEG {
                        self.node_seg[node as usize][d] = i as i16;
                        self.node_side[node as usize][d] = side as u8;
                        self.node_deg[node as usize] = (d + 1) as u8;
                    }
                }
            }
        }
        for i in n..MAX_SEG {
            self.seg_len[i] = 0.0;
            self.seg_node[i] = [-1; 2];
        }
    }

    /// Bind the buffer arena (LED-arity buffers / textures). BYTE-addressed: size
    /// it to `Program::arena_bytes(led_count)`. The slice must outlive the
    /// following run calls and be disjoint from any other access; pass an empty
    /// slice to unbind.
    pub fn set_arena(&mut self, arena: &mut [u8]) {
        self.arena_ptr = arena.as_mut_ptr();
        self.arena_len = arena.len();
    }

    fn graph_ref(&self) -> GraphRef<'_> {
        GraphRef {
            n_seg: self.n_seg,
            seg_len: &self.seg_len,
            seg_node: &self.seg_node,
            node_deg: &self.node_deg,
            node_seg: &self.node_seg,
            node_side: &self.node_side,
        }
    }

    /// Run `update()` (if present), evolving `state`. Uses the default budget.
    pub fn run_update(&mut self, prog: &Program, frame: &Frame) {
        self.run_update_bounded(prog, frame, &Budget::default());
    }

    /// Run `update()` under an explicit [`Budget`], evolving `state`. If the
    /// invocation is cancelled (budget/timeout) `state` is still committed —
    /// update() writes state incrementally and a partial advance is harmless
    /// (the next frame simply continues). Returns why it stopped.
    pub fn run_update_bounded(&mut self, prog: &Program, frame: &Frame, budget: &Budget) -> Outcome {
        self.run_update_counted(prog, frame, budget).0
    }

    /// Like [`run_update_bounded`], additionally returning Tier-1 [`Counters`]
    /// (opcodes retired + stack high-water) for the perf stream. The counters
    /// cost one add/compare per opcode; the firmware gates FULL mode so BASIC
    /// callers stay on the plain path.
    pub fn run_update_counted(
        &mut self,
        prog: &Program,
        frame: &Frame,
        budget: &Budget,
    ) -> (Outcome, Counters) {
        if prog.update_entry == NO_ENTRY {
            return (Outcome::Ok, Counters::default());
        }
        let led = Led::default();
        let mut st = self.state;
        let mut dist = self.dist_src;
        let g = self.graph_ref();
        let arena: &mut [u8] = if self.arena_ptr.is_null() || self.arena_len == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(self.arena_ptr, self.arena_len) }
        };
        let (_out, outcome, counters) = run(
            prog,
            self.uniforms,
            &mut st,
            frame,
            &led,
            &g,
            &mut dist,
            arena,
            prog.update_entry as usize,
            budget,
        );
        self.state = st;
        self.dist_src = dist; // persist a flood_from source across frames
        (outcome, counters)
    }

    /// Run `shade(led)` → RGB. Does not mutate `state` (read-only in shade).
    /// Uses the default budget.
    pub fn run_shade(&self, prog: &Program, frame: &Frame, led: &Led) -> Rgb {
        self.run_shade_bounded(prog, frame, led, &Budget::default()).0
    }

    /// Run `shade(led)` under an explicit [`Budget`]. On a cancelled invocation
    /// (budget/timeout) the returned RGB is black — the caller may instead hold
    /// the LED's previous colour. Returns `(rgb, outcome)`.
    pub fn run_shade_bounded(
        &self,
        prog: &Program,
        frame: &Frame,
        led: &Led,
        budget: &Budget,
    ) -> (Rgb, Outcome) {
        let (rgb, outcome, _counters) = self.run_shade_counted(prog, frame, led, budget);
        (rgb, outcome)
    }

    /// Like [`run_shade_bounded`], additionally returning Tier-1 [`Counters`]
    /// (opcodes retired + stack high-water) for the perf stream.
    pub fn run_shade_counted(
        &self,
        prog: &Program,
        frame: &Frame,
        led: &Led,
        budget: &Budget,
    ) -> (Rgb, Outcome, Counters) {
        let mut st = self.state; // copy; shade shouldn't write it, but be safe
        let mut dist = self.dist_src; // read-only in shade (led.dist); not persisted
        let g = self.graph_ref();
        let arena: &mut [u8] = if self.arena_ptr.is_null() || self.arena_len == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(self.arena_ptr, self.arena_len) }
        };
        let (out, outcome, counters) = run(
            prog,
            self.uniforms,
            &mut st,
            frame,
            led,
            &g,
            &mut dist,
            arena,
            prog.shade_entry as usize,
            budget,
        );
        if outcome.timed_out() {
            return ((0, 0, 0), outcome, counters);
        }
        let r = clamp01(out[0]);
        let g = clamp01(out[1]);
        let b = clamp01(out[2]);
        (
            ((r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8),
            outcome,
            counters,
        )
    }
}

#[inline]
fn clamp01(x: f32) -> f32 {
    if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else if x.is_nan() {
        0.0
    } else {
        x
    }
}

/// A borrow of the VM's topology graph tables, passed to `run()` so the
/// graph-query opcode can read them without giving `run` the whole `Vm`.
struct GraphRef<'a> {
    n_seg: u32,
    seg_len: &'a [f32; MAX_SEG],
    seg_node: &'a [[i32; 2]; MAX_SEG],
    node_deg: &'a [u8; MAX_NODE],
    node_seg: &'a [[i16; MAX_NODE_DEG]; MAX_NODE],
    node_side: &'a [[u8; MAX_NODE_DEG]; MAX_NODE],
}

impl GraphRef<'_> {
    /// Evaluate a graph query. Int results carry their i32 bits in the f32 slot
    /// (the compiler types the result, so consumers read them back as int).
    #[inline]
    fn query(&self, kind: u8, a: i32, b: i32) -> f32 {
        let asi = |v: i32| f32::from_bits(v as u32);
        let node_ok = |n: i32| n >= 0 && (n as usize) < MAX_NODE;
        match kind {
            gq::SEG_COUNT => asi(self.n_seg as i32),
            gq::SEG_LEN => {
                if a >= 0 && (a as usize) < (self.n_seg as usize).min(MAX_SEG) {
                    self.seg_len[a as usize]
                } else {
                    0.0
                }
            }
            gq::SEG_NODE => {
                let v = if a >= 0 && (a as usize) < MAX_SEG && (b == 0 || b == 1) {
                    self.seg_node[a as usize][b as usize]
                } else {
                    -1
                };
                asi(v)
            }
            gq::NODE_DEG => asi(if node_ok(a) { self.node_deg[a as usize] as i32 } else { 0 }),
            gq::TERM_COUNT => {
                let mut c = 0i32;
                for n in 0..MAX_NODE {
                    if self.node_deg[n] == 1 {
                        c += 1;
                    }
                }
                asi(c)
            }
            gq::TERM => {
                let mut want = a;
                let mut found = -1i32;
                if want >= 0 {
                    for n in 0..MAX_NODE {
                        if self.node_deg[n] == 1 {
                            if want == 0 {
                                found = n as i32;
                                break;
                            }
                            want -= 1;
                        }
                    }
                }
                asi(found)
            }
            gq::NODE_SEG | gq::NODE_SIDE => {
                let ok = node_ok(a)
                    && b >= 0
                    && (b as usize) < MAX_NODE_DEG
                    && (b as usize) < self.node_deg[a as usize] as usize;
                let v = if !ok {
                    if kind == gq::NODE_SEG {
                        -1
                    } else {
                        0
                    }
                } else if kind == gq::NODE_SEG {
                    self.node_seg[a as usize][b as usize] as i32
                } else {
                    self.node_side[a as usize][b as usize] as i32
                };
                asi(v)
            }
            _ => 0.0,
        }
    }
}

/// Execute from `entry`, returning `(up to 3 result slots, outcome)`. Two
/// bounded-execution guards hard-cap frame time and trap runaway loops (see
/// [`Budget`]): a per-invocation instruction budget (primary, deterministic)
/// and an optional wall-time deadline flag raised by a hardware timer
/// (secondary). Either firing unwinds to the caller with a timeout outcome.
fn run(
    prog: &Program,
    uniforms: [f32; MAX_UNIFORM_SLOTS],
    state: &mut [f32; MAX_STATE],
    frame: &Frame,
    led: &Led,
    graph: &GraphRef,
    dist: &mut DistSrc,
    arena: &mut [u8],
    entry: usize,
    guard: &Budget,
) -> ([f32; 3], Outcome, Counters) {
    use core::sync::atomic::Ordering;
    let code = prog.code;
    let mut stack = [0.0f32; MAX_STACK];
    let mut locals = [0.0f32; MAX_LOCALS];
    let mut sp: usize = 0;
    let mut pc: usize = entry;
    let mut budget: u32 = guard.instructions; // instructions per invocation
    // Tier-1 counters (perf-monitoring.md): opcodes retired + stack high-water.
    // Cheap-by-construction — one add + one max next to the budget decrement.
    let mut instrs: u32 = 0;
    let mut sp_max: usize = 0;
    // Poll the wall-time flag every N ops (an atomic load per op would dominate
    // the tiny opcodes); the instruction budget bounds the slop between polls.
    const DEADLINE_POLL_MASK: u32 = 0x3FF;
    let mut call_stack = [0usize; 16];
    let mut csp: usize = 0;
    let mut outcome = Outcome::Ok;

    macro_rules! push {
        ($v:expr) => {{
            if sp < MAX_STACK {
                stack[sp] = $v;
                sp += 1;
            }
        }};
    }
    macro_rules! pop {
        () => {{
            sp = sp.saturating_sub(1);
            stack[sp]
        }};
    }
    // Integers/fixed ride in the f32 slots bit-for-bit (the compiler types every
    // op, so the runtime interpretation is unambiguous).
    macro_rules! popi {
        () => {{
            pop!().to_bits() as i32
        }};
    }
    macro_rules! pushi {
        ($v:expr) => {{
            let vv: i32 = $v;
            push!(f32::from_bits(vv as u32));
        }};
    }

    #[cfg(feature = "profile")]
    let mut prof_prev: usize = usize::MAX;
    while pc < code.len() {
        if budget == 0 {
            outcome = Outcome::Budget;
            break;
        }
        budget -= 1;
        instrs += 1;
        // Stack high-water: the sp before this op ran (post-op depth is folded
        // in via the NEXT iteration's read, and the terminal Ret is small).
        if sp > sp_max {
            sp_max = sp;
        }
        // Secondary wall-time guard: a hardware timer raises this flag at a
        // frame-relative deadline; polled sparsely so the load isn't hot.
        if budget & DEADLINE_POLL_MASK == 0 {
            if let Some(flag) = guard.deadline {
                // SAFETY: `flag` points at a live AtomicBool owned by the
                // caller for the duration of this call (the C++ FFI holds it
                // in a static). Atomic load is sound through a shared ref.
                if unsafe { (*flag).load(Ordering::Relaxed) } {
                    outcome = Outcome::Timeout;
                    break;
                }
            }
        }
        let op = match Op::from_u8(code[pc]) {
            Some(o) => o,
            None => break,
        };
        pc += 1;
        #[cfg(feature = "profile")]
        {
            profile::record(prof_prev, op as usize);
            prof_prev = op as usize;
        }
        match op {
            Op::PushConst => {
                let idx = rd_u16(code, pc) as usize;
                pc += 2;
                push!(prog.const_f32(idx));
            }
            Op::LoadUniform => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    push!(*uniforms.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::LoadState => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    push!(*state.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::StoreState => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in (0..n).rev() {
                    let v = pop!();
                    if slot + i < MAX_STATE {
                        state[slot + i] = v;
                    }
                }
            }
            Op::LoadLocal => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    push!(*locals.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::StoreLocal => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in (0..n).rev() {
                    let v = pop!();
                    if slot + i < MAX_LOCALS {
                        locals[slot + i] = v;
                    }
                }
            }
            Op::LoadCtx => {
                let id = code[pc];
                pc += 1;
                match id {
                    C_TIME => push!(frame.time),
                    C_DT => push!(frame.dt),
                    C_FRAME => push!(frame.frame as f32),
                    C_LED_POS => {
                        push!(led.pos[0]);
                        push!(led.pos[1]);
                        push!(led.pos[2]);
                    }
                    C_LED_IDX => push!(led.idx as f32),
                    C_LED_COUNT => push!(frame.led_count as f32),
                    C_LED_SEG => push!(led.seg as f32),
                    C_LED_S => push!(led.s),
                    C_LED_BRANCH => push!(if led.branch { 1.0 } else { 0.0 }),
                    C_IMU_ACCEL => {
                        push!(frame.imu_accel[0]);
                        push!(frame.imu_accel[1]);
                        push!(frame.imu_accel[2]);
                    }
                    C_IMU_GYRO => {
                        push!(frame.imu_gyro[0]);
                        push!(frame.imu_gyro[1]);
                        push!(frame.imu_gyro[2]);
                    }
                    C_LED_DIST => {
                        // With a flood_from source set, report this LED's geodesic
                        // distance from that source (normalized 0..1); otherwise
                        // the map-load root field carried in the Led struct.
                        if dist.set
                            && led.seg >= 0
                            && (led.seg as usize) < (graph.n_seg as usize).min(MAX_SEG)
                        {
                            let si = led.seg as usize;
                            let a = graph.seg_node[si][0];
                            let b = graph.seg_node[si][1];
                            let l = graph.seg_len[si];
                            let da = if a >= 0 && (a as usize) < MAX_NODE {
                                dist.d[a as usize] + led.s * l
                            } else {
                                f32::INFINITY
                            };
                            let db = if b >= 0 && (b as usize) < MAX_NODE {
                                dist.d[b as usize] + (1.0 - led.s) * l
                            } else {
                                f32::INFINITY
                            };
                            let g = if da < db { da } else { db };
                            push!(if g.is_finite() { (g / dist.max).min(1.0) } else { 1.0 });
                        } else {
                            push!(led.dist);
                        }
                    }
                    C_LED_UV => {
                        push!(led.uv[0]);
                        push!(led.uv[1]);
                    }
                    _ => push!(0.0),
                }
            }
            Op::Add | Op::Sub | Op::Mul | Op::Div => {
                let n = code[pc] as usize;
                pc += 1;
                // stack: a(n) b(n) ; result a op b
                let base = sp - 2 * n;
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = match op {
                        Op::Add => a + b,
                        Op::Sub => a - b,
                        Op::Mul => a * b,
                        _ => {
                            if b == 0.0 {
                                0.0
                            } else {
                                a / b
                            }
                        }
                    };
                }
                sp = base + n;
            }
            Op::Neg => {
                let n = code[pc] as usize;
                pc += 1;
                for i in 0..n {
                    stack[sp - n + i] = -stack[sp - n + i];
                }
            }
            Op::Scale => {
                let n = code[pc] as usize;
                pc += 1;
                let s = pop!();
                for i in 0..n {
                    stack[sp - n + i] *= s;
                }
            }
            Op::UnMath => {
                let f = code[pc];
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    let x = stack[sp - n + i];
                    stack[sp - n + i] = un_math(f, x);
                }
            }
            Op::BinMath => {
                let f = code[pc];
                let n = code[pc + 1] as usize;
                pc += 2;
                let base = sp - 2 * n;
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = bin_math(f, a, b);
                }
                sp = base + n;
            }
            Op::Clamp => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 3 * n;
                for i in 0..n {
                    let x = stack[base + i];
                    let lo = stack[base + n + i];
                    let hi = stack[base + 2 * n + i];
                    stack[base + i] = if x < lo {
                        lo
                    } else if x > hi {
                        hi
                    } else {
                        x
                    };
                }
                sp = base + n;
            }
            Op::Mix => {
                let n = code[pc] as usize;
                pc += 1;
                let t = pop!(); // scalar t
                let base = sp - 2 * n;
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = a + (b - a) * t;
                }
                sp = base + n;
            }
            Op::Smoothstep => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 3 * n;
                for i in 0..n {
                    let e0 = stack[base + i];
                    let e1 = stack[base + n + i];
                    let x = stack[base + 2 * n + i];
                    let t = clamp01(if e1 == e0 { 0.0 } else { (x - e0) / (e1 - e0) });
                    stack[base + i] = t * t * (3.0 - 2.0 * t);
                }
                sp = base + n;
            }
            Op::Dot => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 2 * n;
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + n + i];
                }
                sp = base;
                push!(acc);
            }
            Op::Cross => {
                pc += 1; // n operand (always 3), ignore
                let base = sp - 6;
                let a = [stack[base], stack[base + 1], stack[base + 2]];
                let b = [stack[base + 3], stack[base + 4], stack[base + 5]];
                stack[base] = a[1] * b[2] - a[2] * b[1];
                stack[base + 1] = a[2] * b[0] - a[0] * b[2];
                stack[base + 2] = a[0] * b[1] - a[1] * b[0];
                sp = base + 3;
            }
            Op::Length => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - n;
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + i];
                }
                sp = base;
                push!(sqrtf(acc));
            }
            Op::Distance => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 2 * n;
                let mut acc = 0.0;
                for i in 0..n {
                    let d = stack[base + i] - stack[base + n + i];
                    acc += d * d;
                }
                sp = base;
                push!(sqrtf(acc));
            }
            Op::Normalize => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - n;
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + i];
                }
                let len = sqrtf(acc);
                if len > 1e-9 {
                    for i in 0..n {
                        stack[base + i] /= len;
                    }
                }
            }
            Op::Swizzle => {
                let src_n = code[pc] as usize;
                let dst_n = code[pc + 1] as usize;
                pc += 2;
                let mut tmp = [0.0f32; 4];
                let base = sp - src_n;
                for i in 0..dst_n {
                    let ci = code[pc + i] as usize;
                    tmp[i] = *stack.get(base + ci).unwrap_or(&0.0);
                }
                pc += dst_n;
                for i in 0..dst_n {
                    stack[base + i] = tmp[i];
                }
                sp = base + dst_n;
            }
            Op::Cmp => {
                let kind = code[pc];
                pc += 1;
                let b = pop!();
                let a = pop!();
                let r = match kind {
                    0 => a < b,
                    1 => a <= b,
                    2 => a > b,
                    3 => a >= b,
                    4 => a == b,
                    _ => a != b,
                };
                push!(if r { 1.0 } else { 0.0 });
            }
            Op::Logic => {
                let kind = code[pc];
                pc += 1;
                if kind == 2 {
                    let a = pop!();
                    push!(if a != 0.0 { 0.0 } else { 1.0 });
                } else {
                    let b = pop!();
                    let a = pop!();
                    let r = if kind == 0 {
                        (a != 0.0) && (b != 0.0)
                    } else {
                        (a != 0.0) || (b != 0.0)
                    };
                    push!(if r { 1.0 } else { 0.0 });
                }
            }
            Op::BrFalse => {
                let rel = i16::from_le_bytes([code[pc], code[pc + 1]]);
                pc += 2;
                let c = pop!();
                if c == 0.0 {
                    pc = (pc as isize + rel as isize) as usize;
                }
            }
            Op::Jmp => {
                let rel = i16::from_le_bytes([code[pc], code[pc + 1]]);
                pc += 2;
                pc = (pc as isize + rel as isize) as usize;
            }
            Op::Hash1 => {
                let x = pop!();
                push!(hash1(x));
            }
            Op::Hash3 => {
                let z = pop!();
                let y = pop!();
                let x = pop!();
                push!(hash3(x, y, z));
            }
            Op::Hsv2Rgb => {
                let v = pop!();
                let s = pop!();
                let h = pop!();
                let (r, g, b) = hsv2rgb(h, s, v);
                push!(r);
                push!(g);
                push!(b);
            }
            Op::Palette => {
                let id = code[pc];
                pc += 1;
                let t = pop!();
                let (r, g, b) = palette(id, t);
                push!(r);
                push!(g);
                push!(b);
            }
            Op::Pop => {
                let n = code[pc] as usize;
                pc += 1;
                sp = sp.saturating_sub(n);
            }
            Op::Ret => {
                let n = code[pc] as usize;
                let mut out = [0.0f32; 3];
                let base = sp.saturating_sub(n);
                for i in 0..n.min(3) {
                    out[i] = stack[base + i];
                }
                if sp > sp_max {
                    sp_max = sp;
                }
                return (out, Outcome::Ok, Counters { instrs, stack_max: sp_max as u16 });
            }
            Op::Swap => {
                let an = code[pc] as usize;
                let bn = code[pc + 1] as usize;
                pc += 2;
                // stack: [.. a(an) b(bn)] -> [.. b(bn) a(an)]
                let base = sp - an - bn;
                let mut tmp = [0.0f32; 8];
                for i in 0..an {
                    tmp[i] = stack[base + i];
                }
                for i in 0..bn {
                    stack[base + i] = stack[base + an + i];
                }
                for i in 0..an {
                    stack[base + bn + i] = tmp[i];
                }
            }
            Op::AddI => {
                let b = popi!();
                let a = popi!();
                pushi!(a.wrapping_add(b));
            }
            Op::SubI => {
                let b = popi!();
                let a = popi!();
                pushi!(a.wrapping_sub(b));
            }
            Op::MulI => {
                let b = popi!();
                let a = popi!();
                pushi!(a.wrapping_mul(b));
            }
            Op::DivI => {
                let b = popi!();
                let a = popi!();
                pushi!(if b == 0 { 0 } else { a.wrapping_div(b) });
            }
            Op::ModI => {
                let b = popi!();
                let a = popi!();
                pushi!(if b == 0 { 0 } else { a.wrapping_rem(b) });
            }
            Op::NegI => {
                let a = popi!();
                pushi!(a.wrapping_neg());
            }
            Op::CmpI => {
                let kind = code[pc];
                pc += 1;
                let b = popi!();
                let a = popi!();
                let r = match kind {
                    0 => a < b,
                    1 => a <= b,
                    2 => a > b,
                    3 => a >= b,
                    4 => a == b,
                    _ => a != b,
                };
                push!(if r { 1.0 } else { 0.0 });
            }
            Op::MulFix => {
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(((a * b) >> 16) as i32);
            }
            Op::DivFix => {
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(if b == 0 { 0 } else { ((a << 16) / b) as i32 });
            }
            Op::I2F => {
                let a = popi!();
                push!(a as f32);
            }
            Op::F2I => {
                let a = pop!();
                pushi!(a as i32);
            }
            Op::Fix2F => {
                let a = popi!();
                push!(a as f32 / FIX_ONE as f32);
            }
            Op::F2Fix => {
                let a = pop!();
                pushi!((a * FIX_ONE as f32) as i32);
            }
            Op::I2Fix => {
                let a = popi!();
                pushi!(a.wrapping_shl(16));
            }
            Op::Fix2I => {
                let a = popi!();
                pushi!(a >> 16);
            }
            Op::Call => {
                let target = rd_u16(code, pc) as usize;
                pc += 2;
                if csp < call_stack.len() {
                    call_stack[csp] = pc;
                    csp += 1;
                }
                pc = target;
            }
            Op::RetFn => {
                if csp == 0 {
                    break;
                }
                csp -= 1;
                pc = call_stack[csp];
            }
            // Indexed load: pop the (int) index, push `n` slots from
            // base + clamp(i,0,count-1)*stride + off.
            Op::LoadStateIdx | Op::LoadLocalIdx => {
                let base = code[pc] as usize;
                let stride = code[pc + 1] as usize;
                let off = code[pc + 2] as usize;
                let n = code[pc + 3] as usize;
                let count = code[pc + 4] as usize;
                pc += 5;
                let i = popi!();
                let hi = count.saturating_sub(1) as i32;
                let idx = i.clamp(0, hi) as usize;
                let p = base + idx * stride + off;
                let src: &[f32] = if op == Op::LoadStateIdx { &state[..] } else { &locals[..] };
                for k in 0..n {
                    push!(*src.get(p + k).unwrap_or(&0.0));
                }
            }
            // Indexed store: the `n` values are on top, the (int) index just
            // below them. Writes to base + clamp(i,0,count-1)*stride + off.
            Op::StoreStateIdx | Op::StoreLocalIdx => {
                let base = code[pc] as usize;
                let stride = code[pc + 1] as usize;
                let off = code[pc + 2] as usize;
                let n = code[pc + 3] as usize;
                let count = code[pc + 4] as usize;
                pc += 5;
                if sp >= n + 1 {
                    let i = stack[sp - n - 1].to_bits() as i32;
                    let hi = count.saturating_sub(1) as i32;
                    let idx = i.clamp(0, hi) as usize;
                    let p = base + idx * stride + off;
                    let cap = if op == Op::StoreStateIdx { MAX_STATE } else { MAX_LOCALS };
                    for k in 0..n {
                        let v = stack[sp - n + k];
                        if p + k < cap {
                            if op == Op::StoreStateIdx {
                                state[p + k] = v;
                            } else {
                                locals[p + k] = v;
                            }
                        }
                    }
                    sp -= n + 1;
                }
            }
            Op::GraphQuery => {
                let kind = code[pc];
                pc += 1;
                let (a, b) = match kind {
                    gq::SEG_LEN | gq::NODE_DEG | gq::TERM => (popi!(), 0),
                    gq::SEG_NODE | gq::NODE_SEG | gq::NODE_SIDE => {
                        let b = popi!();
                        (popi!(), b)
                    }
                    _ => (0, 0), // SEG_COUNT, TERM_COUNT: no args
                };
                push!(graph.query(kind, a, b));
            }
            Op::LoadBuf => {
                let id = code[pc] as usize;
                pc += 1;
                if let Some(d) = prog.buf_desc(id) {
                    let lc = frame.led_count as usize;
                    let elem = d.elem as usize;
                    let cb = comp_bytes(d.comp);
                    let count = if d.kind == 0 { lc } else { d.w as usize * d.h as usize };
                    let i = popi!().clamp(0, count.saturating_sub(1) as i32) as usize;
                    // Byte offset of element `i`; unpack each packed component to a
                    // stack word at its declared precision.
                    let base = prog.buf_base(id, lc) + i * d.elem_bytes();
                    for k in 0..elem {
                        let o = base + k * cb;
                        push!(arena.get(o..o + cb).map(|b| comp_load(d.comp, b)).unwrap_or(0.0));
                    }
                }
            }
            Op::StoreBuf => {
                let id = code[pc] as usize;
                pc += 1;
                if let Some(d) = prog.buf_desc(id) {
                    let lc = frame.led_count as usize;
                    let elem = d.elem as usize;
                    let cb = comp_bytes(d.comp);
                    let count = if d.kind == 0 { lc } else { d.w as usize * d.h as usize };
                    if sp >= elem + 1 {
                        let i = stack[sp - elem - 1].to_bits() as i32;
                        let idx = i.clamp(0, count.saturating_sub(1) as i32) as usize;
                        let base = prog.buf_base(id, lc) + idx * d.elem_bytes();
                        for k in 0..elem {
                            let v = stack[sp - elem + k];
                            let o = base + k * cb;
                            if o + cb <= arena.len() {
                                comp_store(d.comp, v, &mut arena[o..o + cb]);
                            }
                        }
                        sp -= elem + 1;
                    }
                }
            }
            Op::SampleTex => {
                let id = code[pc] as usize;
                pc += 1;
                let d = prog.buf_desc(id).unwrap_or_default();
                let elem = d.elem as usize;
                let cb = comp_bytes(d.comp);
                // pop uv (2 slots): stack [.., u, v]
                let (u, v) = if sp >= 2 {
                    let v = stack[sp - 1];
                    let u = stack[sp - 2];
                    sp -= 2;
                    (u, v)
                } else {
                    (0.0, 0.0)
                };
                if d.kind == 1 && d.w > 0 && d.h > 0 {
                    let w = d.w as usize;
                    let h = d.h as usize;
                    let base = prog.buf_base(id, frame.led_count as usize);
                    let eb = d.elem_bytes();
                    // Bilinear, edge-clamped — dequantized to float regardless of
                    // the stored precision (sampling always yields a float colour).
                    let fx = u.clamp(0.0, 1.0) * (w as f32 - 1.0);
                    let fy = v.clamp(0.0, 1.0) * (h as f32 - 1.0);
                    let x0 = floorf(fx) as usize;
                    let y0 = floorf(fy) as usize;
                    let x1 = (x0 + 1).min(w - 1);
                    let y1 = (y0 + 1).min(h - 1);
                    let tx = fx - x0 as f32;
                    let ty = fy - y0 as f32;
                    for k in 0..elem {
                        let tap = |x: usize, y: usize| {
                            let o = base + (y * w + x) * eb + k * cb;
                            arena.get(o..o + cb).map(|b| comp_load_num(d.comp, b)).unwrap_or(0.0)
                        };
                        let a = tap(x0, y0) * (1.0 - tx) + tap(x1, y0) * tx;
                        let b = tap(x0, y1) * (1.0 - tx) + tap(x1, y1) * tx;
                        push!(a * (1.0 - ty) + b * ty);
                    }
                } else {
                    for _ in 0..elem {
                        push!(0.0);
                    }
                }
            }
            Op::PaintTex => {
                let id = code[pc] as usize;
                pc += 1;
                let d = prog.buf_desc(id).unwrap_or_default();
                let elem = d.elem as usize;
                let cb = comp_bytes(d.comp);
                // stack: [.., u, v, c0..c_elem] — uv below the colour slots.
                if sp >= elem + 2 {
                    let v = stack[sp - elem - 1];
                    let u = stack[sp - elem - 2];
                    if d.kind == 1 && d.w > 0 && d.h > 0 {
                        let w = d.w as usize;
                        let h = d.h as usize;
                        let base = prog.buf_base(id, frame.led_count as usize);
                        let eb = d.elem_bytes();
                        // Nearest texel; quantize the float colour to the format.
                        let x = floorf(u.clamp(0.0, 1.0) * (w as f32 - 1.0) + 0.5) as usize;
                        let y = floorf(v.clamp(0.0, 1.0) * (h as f32 - 1.0) + 0.5) as usize;
                        let off = base + (y.min(h - 1) * w + x.min(w - 1)) * eb;
                        for k in 0..elem {
                            let c = stack[sp - elem + k];
                            let o = off + k * cb;
                            if o + cb <= arena.len() {
                                comp_store_num(d.comp, c, &mut arena[o..o + cb]);
                            }
                        }
                    }
                    sp -= elem + 2;
                }
            }
            Op::FloodFrom => {
                // Pop the source node; single-source geodesic sweep (Bellman-Ford
                // over segment edges, non-negative weights) into `dist`.
                let src = popi!();
                for x in dist.d.iter_mut() {
                    *x = f32::INFINITY;
                }
                dist.set = false;
                if src >= 0 && (src as usize) < MAX_NODE {
                    dist.d[src as usize] = 0.0;
                    let ns = (graph.n_seg as usize).min(MAX_SEG);
                    for _ in 0..MAX_NODE {
                        let mut changed = false;
                        for si in 0..ns {
                            let a = graph.seg_node[si][0];
                            let b = graph.seg_node[si][1];
                            if a < 0 || b < 0 {
                                continue;
                            }
                            let (a, b) = (a as usize, b as usize);
                            if a >= MAX_NODE || b >= MAX_NODE {
                                continue;
                            }
                            let w = graph.seg_len[si];
                            if dist.d[a] + w < dist.d[b] {
                                dist.d[b] = dist.d[a] + w;
                                changed = true;
                            }
                            if dist.d[b] + w < dist.d[a] {
                                dist.d[a] = dist.d[b] + w;
                                changed = true;
                            }
                        }
                        if !changed {
                            break;
                        }
                    }
                    let mut mx = 0.0f32;
                    for &x in dist.d.iter() {
                        if x.is_finite() && x > mx {
                            mx = x;
                        }
                    }
                    dist.max = if mx > 1e-6 { mx } else { 1.0 };
                    dist.set = true;
                }
            }
            // --- reduced-precision fixed-point (FUG-10) ----------------------
            Op::MulFixN => {
                let frac = code[pc] as u32;
                pc += 1;
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(((a * b) >> frac) as i32);
            }
            Op::DivFixN => {
                let frac = code[pc] as u32;
                pc += 1;
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(if b == 0 { 0 } else { ((a << frac) / b) as i32 });
            }
            Op::FixRescale => {
                let sh = code[pc] as i8;
                pc += 1;
                let a = popi!();
                pushi!(if sh >= 0 { a.wrapping_shl(sh as u32) } else { a >> ((-(sh as i32)) as u32) });
            }
            Op::FixToF => {
                let frac = code[pc] as u32;
                pc += 1;
                let a = popi!();
                push!(a as f32 / (1u32 << frac) as f32);
            }
            Op::FixFromF => {
                let frac = code[pc] as u32;
                pc += 1;
                let a = pop!();
                pushi!((a * (1u32 << frac) as f32) as i32);
            }
            Op::SinFix => {
                let frac = code[pc] as u32;
                pc += 1;
                let a = popi!();
                pushi!(sin_fix(a, frac));
            }
            Op::CosFix => {
                let frac = code[pc] as u32;
                pc += 1;
                let a = popi!();
                // cos(t) = sin(t + quarter turn); one turn = 1<<frac.
                pushi!(sin_fix(a.wrapping_add(1 << (frac - 2)), frac));
            }
            Op::ExpFix => {
                let frac = code[pc] as u32;
                pc += 1;
                let a = popi!();
                pushi!(exp_fix(a, frac));
            }
            // Integer/fixed abs/min/max/clamp — operate on the scaled-integer stack
            // word directly (correct for int + every fixed format, no soft-float).
            Op::AbsI => {
                let a = popi!();
                pushi!(a.wrapping_abs());
            }
            Op::MinI => {
                let b = popi!();
                let a = popi!();
                pushi!(if a < b { a } else { b });
            }
            Op::MaxI => {
                let b = popi!();
                let a = popi!();
                pushi!(if a > b { a } else { b });
            }
            Op::ClampI => {
                let hi = popi!();
                let lo = popi!();
                let x = popi!();
                pushi!(if x < lo {
                    lo
                } else if x > hi {
                    hi
                } else {
                    x
                });
            }
            Op::SignI => {
                let frac = code[pc] as u32;
                pc += 1;
                let x = popi!();
                let one = 1i32 << frac;
                pushi!(if x > 0 {
                    one
                } else if x < 0 {
                    -one
                } else {
                    0
                });
            }
            Op::StepI => {
                let frac = code[pc] as u32;
                pc += 1;
                let x = popi!(); // second arg (top)
                let edge = popi!(); // first arg
                pushi!(if x >= edge { 1i32 << frac } else { 0 });
            }
            Op::FloorFix => {
                let frac = code[pc] as u32;
                pc += 1;
                let x = popi!();
                pushi!((x >> frac) << frac); // arithmetic shift rounds toward -inf
            }
            Op::CeilFix => {
                let frac = code[pc] as u32;
                pc += 1;
                let x = popi!();
                let fl = (x >> frac) << frac;
                pushi!(if fl != x { fl.wrapping_add(1i32 << frac) } else { fl });
            }
            Op::FractFix => {
                let frac = code[pc] as u32;
                pc += 1;
                let x = popi!();
                pushi!(x & ((1i32 << frac) - 1)); // frac 0 -> mask 0 -> 0
            }
            Op::MixFix => {
                let frac = code[pc] as u32;
                pc += 1;
                let t = popi!() as i64;
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!((a + (((b - a) * t) >> frac)) as i32);
            }
        }
    }
    ([0.0, 0.0, 0.0], outcome, Counters { instrs, stack_max: sp_max as u16 })
}

// --- soft-float helpers (no libm dependency; small polynomial approximations
// good enough for LED effects, deterministic on host + wasm + device) ---------

fn sqrtf(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    // Newton from a bit-twiddle seed.
    let mut y = f32::from_bits(0x5f37_59df - (x.to_bits() >> 1));
    y = y * (1.5 - 0.5 * x * y * y);
    y = y * (1.5 - 0.5 * x * y * y);
    x * y // x * rsqrt(x) = sqrt(x)
}

fn floorf(x: f32) -> f32 {
    let t = x as i32 as f32;
    if t > x {
        t - 1.0
    } else {
        t
    }
}
fn fractf(x: f32) -> f32 {
    x - floorf(x)
}

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = 2.0 * PI;

/// 5th-order minimax-ish sine poly, accurate on `a ∈ [-PI/2, PI/2]` (its error
/// blows up to ~0.04 toward ±PI). Used only to BAKE the flash LUT at compile
/// time — never on the hot path.
const fn sin_poly(a: f32) -> f32 {
    let a2 = a * a;
    a * (0.9999966 + a2 * (-0.16664824 + a2 * (0.00830629 + a2 * -0.00018363)))
}

/// `sin(turn * 2PI)` for `turn ∈ [0, 1]`, folded into `[-PI/2, PI/2]` (where the
/// poly is accurate) via `sin(PI - a) = sin(a)`. Compile-time only.
const fn sin_turn(turn: f32) -> f32 {
    let mut a = turn * TAU; // [0, TAU]
    if a > PI {
        a -= TAU; // [-PI, PI]
    }
    if a > PI * 0.5 {
        a = PI - a; // (PI/2, PI] -> [0, PI/2)
    } else if a < -PI * 0.5 {
        a = -PI - a; // [-PI, -PI/2) -> (-PI/2, 0]
    }
    sin_poly(a)
}

/// Flash-resident sine table: `SINF_LUT[i] = sin(i/256 turns)`, one full period
/// plus a wrap entry so interpolation never needs a bounds branch. Baked at
/// compile time → lives in flash (0 RAM), which is exactly the RAM-for-flash
/// trade we want on the C6. 257 × 4 B ≈ 1 KB flash.
static SINF_LUT: [f32; 257] = {
    let mut t = [0.0f32; 257];
    let mut i = 0;
    while i <= 256 {
        t[i] = sin_turn(i as f32 / 256.0);
        i += 1;
    }
    t
};

/// Radians → a 32-bit phase where a full turn is 2^32 (wrapping). f32→i64→u32:
/// the i64 hop keeps the product in range, the u32 truncation wraps mod 2^32 —
/// so no `floorf` range reduction is needed.
const SIN_PHASE_SCALE: f32 = 4_294_967_296.0 / TAU;

/// LUT sine (linear-interpolated). On the FPU-less C6 this replaces the poly's
/// ~13 soft-float ops with a table lookup + one lerp: the top 8 phase bits index
/// the table, the low 24 are the interpolation fraction. Matches the poly to
/// ~1e-4 (≪ 1/255, invisible on 8-bit LEDs); device + wasm preview share this
/// code so they can't drift.
pub fn sinf(x: f32) -> f32 {
    let phase = (x * SIN_PHASE_SCALE) as i64 as u32;
    let idx = (phase >> 24) as usize; // 0..=255
    let frac = (phase & 0x00ff_ffff) as f32 * (1.0 / 16_777_216.0);
    let a = SINF_LUT[idx];
    let b = SINF_LUT[idx + 1]; // idx+1 ≤ 256; the wrap entry avoids a branch
    a + (b - a) * frac
}

pub fn cosf(x: f32) -> f32 {
    sinf(x + PI * 0.5)
}
fn expf(x: f32) -> f32 {
    // 2^(x/ln2) via bit manipulation + poly (adequate for decay curves).
    let xln = x * 1.442695; // x / ln2
    let i = floorf(xln);
    let f = xln - i;
    let poly = 1.0 + f * (0.6931472 + f * (0.2402265 + f * 0.0555041));
    let bits = ((i as i32 + 127) as u32) << 23;
    f32::from_bits(bits) * poly
}
fn logf(x: f32) -> f32 {
    if x <= 0.0 {
        return -87.0;
    }
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000); // [1,2)
    let p = -1.7417939 + m * (2.8212026 + m * (-1.4699568 + m * (0.4471623 - m * 0.0821854)));
    (e as f32) * 0.6931472 + p
}
fn powf(a: f32, b: f32) -> f32 {
    if a <= 0.0 {
        return 0.0;
    }
    expf(b * logf(a))
}
fn tanf(x: f32) -> f32 {
    let c = cosf(x);
    if c.abs() < 1e-6 {
        0.0
    } else {
        sinf(x) / c
    }
}

fn un_math(f: u8, x: f32) -> f32 {
    match f {
        F_SIN => sinf(x),
        F_COS => cosf(x),
        F_ABS => x.abs(),
        F_FLOOR => floorf(x),
        F_CEIL => -floorf(-x),
        F_FRACT => fractf(x),
        F_SQRT => sqrtf(x),
        F_EXP => expf(x),
        F_LOG => logf(x),
        F_SIGN => {
            if x > 0.0 {
                1.0
            } else if x < 0.0 {
                -1.0
            } else {
                0.0
            }
        }
        F_TAN => tanf(x),
        _ => x,
    }
}
fn bin_math(f: u8, a: f32, b: f32) -> f32 {
    match f {
        B_MIN => {
            if a < b {
                a
            } else {
                b
            }
        }
        B_MAX => {
            if a > b {
                a
            } else {
                b
            }
        }
        B_POW => powf(a, b),
        B_MOD => a - b * floorf(a / b),
        B_STEP => {
            if b < a {
                0.0
            } else {
                1.0
            }
        } // step(edge=a, x=b)
        B_ATAN2 => atan2f(a, b),
        _ => a,
    }
}
fn atan2f(y: f32, x: f32) -> f32 {
    // crude atan2 adequate for effects (angles for radial patterns).
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    let ax = x.abs();
    let ay = y.abs();
    let a = if ax >= ay { ay / ax } else { ax / ay };
    let s = a * a;
    let mut r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
    if ay > ax {
        r = PI * 0.5 - r;
    }
    if x < 0.0 {
        r = PI - r;
    }
    if y < 0.0 {
        r = -r;
    }
    r
}

/// Integer avalanche finalizer (Hash Prospector "lowbias32"): near-minimal bias,
/// excellent distribution, ALL integer. RV32IMAC has a hardware multiply, so the
/// two mults are cheap — replacing the old `fract(sin(x)*k)` GLSL hash, which
/// dragged the soft-float `sin` into every `hash()` on the FPU-less C6.
#[inline]
fn mix32(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    h
}

/// Map a mixed 32-bit hash to a float in [0, 1) (top 24 bits → an exact f32).
#[inline]
fn unit_from_hash(h: u32) -> f32 {
    (h >> 8) as f32 * (1.0 / 16_777_216.0)
}

/// Deterministic `hash(x) -> [0, 1)`. Seeds off the input's bit pattern XOR the
/// golden-ratio constant so `hash(0.0)` isn't a fixed point. Exposed for tests.
pub fn hash1(x: f32) -> f32 {
    unit_from_hash(mix32(x.to_bits() ^ 0x9e37_79b9))
}

/// Deterministic 3-input `hash(x, y, z) -> [0, 1)`. Folds the three bit patterns
/// through the mixer (no soft-float dot product). Exposed for tests.
pub fn hash3(x: f32, y: f32, z: f32) -> f32 {
    let mut h = mix32(x.to_bits() ^ 0x9e37_79b9);
    h = mix32(h ^ y.to_bits().wrapping_add(0x85eb_ca6b));
    h = mix32(h ^ z.to_bits().wrapping_add(0xc2b2_ae35));
    unit_from_hash(h)
}

fn hsv2rgb(h: f32, s: f32, v: f32) -> (f32, f32, f32) {
    let h6 = fractf(h) * 6.0;
    let c = v * s;
    let x = c * (1.0 - (fractf(h6 * 0.5) * 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = match h6 as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    (r + m, g + m, b + m)
}

fn palette(id: u8, t: f32) -> (f32, f32, f32) {
    let t = clamp01(t);
    match id {
        // fire: black -> red -> orange -> yellow -> white
        0 => (clamp01(t * 3.0), clamp01(t * 3.0 - 1.0), clamp01(t * 3.0 - 2.0)),
        // ice: black -> blue -> cyan -> white
        1 => (clamp01(t * 3.0 - 2.0), clamp01(t * 3.0 - 1.0), clamp01(t * 2.0)),
        // rainbow
        _ => hsv2rgb(t, 1.0, 1.0),
    }
}

// --- reduced-precision fixed-point transcendentals (FUG-10) ------------------
// Pure-integer sin/exp for the narrow `fixed8` (Q1.6) / `fixed16` (Q1.14)
// formats, so transcendental-heavy effects don't drag in the f32 soft-float
// path. A LUT + linear interpolation; deterministic on host, wasm and device.

/// One full-wave period of sine at 256 samples, Q1.15 (`sin(2π i/256)·32768`).
static SIN_LUT: [i32; 256] = [
    0, 804, 1608, 2411, 3212, 4011, 4808, 5602, 6393, 7180, 7962, 8740, 9512, 10279, 11039,
    11793, 12540, 13279, 14010, 14733, 15447, 16151, 16846, 17531, 18205, 18868, 19520,
    20160, 20788, 21403, 22006, 22595, 23170, 23732, 24279, 24812, 25330, 25833, 26320,
    26791, 27246, 27684, 28106, 28511, 28899, 29269, 29622, 29957, 30274, 30572, 30853,
    31114, 31357, 31581, 31786, 31972, 32138, 32286, 32413, 32522, 32610, 32679, 32729,
    32758, 32768, 32758, 32729, 32679, 32610, 32522, 32413, 32286, 32138, 31972, 31786,
    31581, 31357, 31114, 30853, 30572, 30274, 29957, 29622, 29269, 28899, 28511, 28106,
    27684, 27246, 26791, 26320, 25833, 25330, 24812, 24279, 23732, 23170, 22595, 22006,
    21403, 20788, 20160, 19520, 18868, 18205, 17531, 16846, 16151, 15447, 14733, 14010,
    13279, 12540, 11793, 11039, 10279, 9512, 8740, 7962, 7180, 6393, 5602, 4808, 4011,
    3212, 2411, 1608, 804, 0, -804, -1608, -2411, -3212, -4011, -4808, -5602, -6393, -7180,
    -7962, -8740, -9512, -10279, -11039, -11793, -12540, -13279, -14010, -14733, -15447,
    -16151, -16846, -17531, -18205, -18868, -19520, -20160, -20788, -21403, -22006, -22595,
    -23170, -23732, -24279, -24812, -25330, -25833, -26320, -26791, -27246, -27684, -28106,
    -28511, -28899, -29269, -29622, -29957, -30274, -30572, -30853, -31114, -31357, -31581,
    -31786, -31972, -32138, -32286, -32413, -32522, -32610, -32679, -32729, -32758, -32768,
    -32758, -32729, -32679, -32610, -32522, -32413, -32286, -32138, -31972, -31786, -31581,
    -31357, -31114, -30853, -30572, -30274, -29957, -29622, -29269, -28899, -28511, -28106,
    -27684, -27246, -26791, -26320, -25833, -25330, -24812, -24279, -23732, -23170, -22595,
    -22006, -21403, -20788, -20160, -19520, -18868, -18205, -17531, -16846, -16151, -15447,
    -14733, -14010, -13279, -12540, -11793, -11039, -10279, -9512, -8740, -7962, -7180,
    -6393, -5602, -4808, -4011, -3212, -2411, -1608, -804,
];

/// `e^x` over x ∈ [-2, 2) at 256 samples, Q1.14, clamped to the representable
/// [-2, 2) range (so exp saturates at +2 for x ≳ 0.69 — it is a decay curve).
static EXP_LUT: [i32; 256] = [
    2217, 2252, 2288, 2324, 2360, 2398, 2435, 2474, 2513, 2552, 2592, 2633, 2675, 2717,
    2760, 2803, 2847, 2892, 2937, 2984, 3031, 3078, 3127, 3176, 3226, 3277, 3329, 3381,
    3434, 3488, 3543, 3599, 3656, 3713, 3772, 3831, 3892, 3953, 4015, 4078, 4143, 4208,
    4274, 4341, 4410, 4479, 4550, 4621, 4694, 4768, 4843, 4919, 4997, 5076, 5155, 5237,
    5319, 5403, 5488, 5574, 5662, 5751, 5842, 5934, 6027, 6122, 6219, 6317, 6416, 6517,
    6620, 6724, 6830, 6937, 7047, 7158, 7270, 7385, 7501, 7619, 7739, 7861, 7985, 8111,
    8238, 8368, 8500, 8634, 8770, 8908, 9048, 9191, 9335, 9482, 9632, 9783, 9937, 10094,
    10253, 10414, 10578, 10745, 10914, 11086, 11261, 11438, 11618, 11801, 11987, 12176,
    12367, 12562, 12760, 12961, 13165, 13372, 13583, 13797, 14014, 14235, 14459, 14687,
    14918, 15153, 15391, 15634, 15880, 16130, 16384, 16642, 16904, 17170, 17441, 17715,
    17994, 18278, 18566, 18858, 19155, 19456, 19763, 20074, 20390, 20711, 21037, 21369,
    21705, 22047, 22394, 22747, 23105, 23469, 23839, 24214, 24595, 24983, 25376, 25776,
    26182, 26594, 27013, 27438, 27870, 28309, 28755, 29208, 29668, 30135, 30609, 31091,
    31581, 32078, 32583, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767,
    32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767,
    32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767,
    32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767,
    32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767,
    32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767,
    32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767, 32767,
    32767, 32767,
];

/// `sin(turns)` in Q1.`frac` fixed-point. `raw` is the angle in TURNS (1.0 =
/// 2π) as Q1.`frac`; the result is Q1.`frac` in [-1, 1]. Frac ≤ 15. No range
/// reduction — the phase wraps by masking the fractional turn (power-of-two).
fn sin_fix(raw: i32, frac: u32) -> i32 {
    let one = 1i64 << frac; // 1.0 turn
    let phase = (raw as i64) & (one - 1); // fractional turn, 0..one
    let n = SIN_LUT.len() as i64; // 256
    let pos = phase * n; // in units of `one`
    let idx = (pos >> frac) as usize & 255;
    let sub = pos & (one - 1); // 0..one-1
    let a = SIN_LUT[idx] as i64;
    let b = SIN_LUT[(idx + 1) & 255] as i64;
    let q15 = a + (((b - a) * sub) >> frac); // interpolated Q1.15 sine
    let s = 15i64 - frac as i64;
    (if s >= 0 { q15 >> s } else { q15 << (-s) }) as i32
}

/// `e^x` in Q1.`frac`. `raw` is Q1.`frac` in [-2, 2); the result is Q1.`frac`
/// SATURATED to [-2, 2) (so exp pins at +2 once x ≳ 0.69 — meant for decay).
/// Frac ≤ 14.
fn exp_fix(raw: i32, frac: u32) -> i32 {
    let one = 1i64 << frac;
    let span = 4 * one; // domain width [-2, 2) in Q1.frac
    let shifted = ((raw as i64) + 2 * one).clamp(0, span - 1); // (x+2), 0..span
    let n = EXP_LUT.len() as i64; // 256
    let pos = shifted * n;
    let idx = (pos / span) as usize;
    let sub = pos % span;
    let a = EXP_LUT[idx] as i64;
    let b = EXP_LUT[(idx + 1).min(n as usize - 1)] as i64;
    let q14 = a + ((b - a) * sub) / span; // interpolated Q1.14
    let s = 14i64 - frac as i64;
    let v = if s >= 0 { q14 >> s } else { q14 << (-s) };
    v.clamp(-2 * one, 2 * one - 1) as i32
}
