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

/// A native code segment produced by the on-device JIT (`firmware/fx_jit`), for
/// one hot straight-line integer/fixed block. The firmware compiles the block,
/// copies the machine code into an executable region, and hands the VM a table of
/// these; the interpreter's `JitCall` opcode (which the firmware patches over the
/// block's first bytes at load) dispatches to `func`. The VM never allocates or
/// executes anything itself — it just calls a function pointer the firmware set
/// up, so it stays `no_std`/no-alloc.
pub type JitFn = unsafe extern "C" fn(stack: *mut i32, locals: *mut i32, consts: *const i32, state: *mut i32);

/// One JIT block: its native entry, the pc to resume interpreting at, and the net
/// operand-stack depth change to apply after the call (see `firmware/fx_jit`).
#[derive(Clone, Copy)]
pub struct JitBlock {
    pub func: JitFn,
    pub end: u16,
    pub net_delta: i16,
}

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
    // --- fixed/int variants of the remaining vector + transcendental + color +
    // I/O opcodes (FUG-122). These complete the native-datatype ISA: EVERY float
    // opcode now has a strictly-integer/fixed counterpart, so a program can run
    // update()+shade() — inputs and output included — with zero soft-float. The
    // `frac` operand (0 = int, 6/14/16 = the fixed formats) makes one opcode
    // serve every width, matching the existing *FixN convention.
    SqrtFix,      // u8 frac : integer sqrt of a Q1.frac value -> Q1.frac
    ScaleFix,     // u8 frac, u8 n : n-vec(fixed) * scalar(fixed), (a*s)>>frac per comp
    DotFix,       // u8 frac, u8 n : pop a(n),b(n) -> scalar fixed (sum (a*b)>>frac)
    LengthFix,    // u8 frac, u8 n : pop v(n) -> scalar fixed sqrt(sum v^2)
    DistanceFix,  // u8 frac, u8 n : pop a(n),b(n) -> scalar fixed
    NormalizeFix, // u8 frac, u8 n : pop v(n) -> v(n) / |v|
    CrossFix,     // u8 frac : n=3 fixed cross product
    SmoothstepFix, // u8 frac, u8 n : pop e0(n),e1(n),x(n)
    ClampVFix,    // u8 n : vector clamp on fixed/int (pop x(n),lo(n),hi(n)); frac-free
    MixVFix,      // u8 frac, u8 n : pop a(n),b(n),t(1) -> n-vec fixed lerp
    Hsv2RgbFix,   // u8 frac : pop h,s,v (fixed; h in turns, s/v in [0,1]) -> r,g,b fixed
    PaletteFix,   // u8 id, u8 frac : pop t (fixed [0,1]) -> r,g,b fixed
    Atan2Fix,     // u8 frac : pop y,x (fixed) -> angle in TURNS, Q1.frac in [-0.5,0.5)
    LogFix,       // u8 frac : natural log of a Q1.frac value -> Q1.frac (x>0)
    TanFix,       // u8 frac : tan(turns) = sin/cos in fixed
    PowFix,       // u8 frac : a^b via exp(b*log(a)) in fixed
    HashFix,      // u8 frac : pop x (int/fixed bits) -> fixed [0,1) in Q1.frac
    Hash3Fix,     // u8 frac : pop x,y,z -> fixed [0,1) in Q1.frac
    // Float-free output: read the top 3 slots as a colour and emit RGB directly,
    // skipping the shade() epilogue's clamp01()*255 soft-float. RetRgb8 reads
    // int 0..255 channels; RetRgbFix reads Q1.frac channels in [0,1].
    RetRgb8,      // (no operand) top 3 slots = int r,g,b (0..255)
    RetRgbFix,    // u8 frac : top 3 slots = fixed r,g,b in [0,1]
    // Float-free input: push ONE scalar context component already converted to
    // Q1.frac fixed (or int, frac 0), read from the host-provided per-LED fixed
    // cache (positions/uv/s/dist converted once at map-load, not per frame).
    LoadCtxFix,   // u8 id, u8 comp, u8 frac
    // Zero `n` local slots at `slot`. The VM no longer blanket-clears the locals
    // scratch every invocation (it's resident and reused); scalar locals are
    // always initialized by their declaration, so only array/struct locals — the
    // ones the compiler used to lean on the blanket zeroing for — emit this. A
    // big slice of the per-LED framing cost for the common effect that has none.
    FillLocal,    // u8 slot, u8 n
    // --- FUG-125 superinstructions -------------------------------------------
    // Pure fusions of hot opcode sequences the compiler's bytecode optimizer
    // recognizes (see fx_compiler::opt). Each is byte-for-byte equivalent to the
    // sequence it replaces — the differential optimizer test proves identical VM
    // output — trading two-to-four dispatches for one on the FPU-less core.
    // Appended at the end of the enum so every existing discriminant is stable.
    TeeLocal,  // u8 slot, u8 n : copy top n slots to local[slot..] WITHOUT popping
               // (fuses StoreLocal slot,n ; LoadLocal slot,n — the temp reload)
    IncLocalI, // u8 slot, u16 cidx : local[slot] = int(local[slot]) +i const[cidx]
               // (fuses LoadLocal s,1 ; PushConst ; AddI ; StoreLocal s,1 — `i = i + k`)
    BrCmpI,    // u8 kind, i16 rel : pop b,a; branch by rel if NOT cmp_kind(a,b)
               // (fuses CmpI kind ; BrFalse rel — the integer loop-condition tail)
    // --- FUG-125 on-device JIT ------------------------------------------------
    // The firmware patches this over the first bytes of a hot straight-line
    // integer/fixed block at effect load, after compiling that block to a native
    // RV32 segment (firmware/fx_jit). Dispatch calls the segment against the live
    // operand stack + locals + const pool, then resumes interpreting at the
    // block's end. Not emitted by the compiler; the interpreter is the fallback.
    JitCall,   // u16 block-index into the VM's JIT table
    // --- FUG-107 I2C driver intrinsics (docs/design/sensor-core.md §8) --------
    // A driver is a `.fxb` with FLAG_DRIVER whose `poll()` entry sits in the
    // shade slot. Only [`Vm::run_poll`] installs a bus; anywhere else both ops are
    // inert (write -> 0, read -> -1). Args ride the stack as ints. Appended LAST
    // so every discriminant above (FUG-122 / FUG-125) is unchanged.
    I2cWrite, // pop val, reg, addr -> write [reg, val]; push 1 on ACK else 0
    I2cRead,  // u8 mode: n = mode & 3 (1..2 bytes), bit 7 = sign-extend a 16-bit
              // read. pop reg, addr -> read n bytes big-endian; push int (-1 on
              // failure — and the host counts the failure, see I2cBus)
    // --- per-LED memoization (LED-invariant expression cache) ---------------
    // The compiler's variance analysis (fx_compiler::memo) proves a shade()
    // subexpression depends ONLY on per-LED attributes (pos/uv/idx/seg/s/branch
    // + constants) and brackets its code:
    //     LoadLedCache slot,n,skip ; <expr> ; StoreLedCache slot,n
    // With a cache bound (Vm::set_led_cache) and this LED's slot filled,
    // LoadLedCache pushes the n cached words and jumps `skip` past the store —
    // the expression is never evaluated. Otherwise it falls through, the
    // expression runs, and StoreLedCache records the top n words (WITHOUT
    // popping) and marks the slot filled. Words are the raw stack bits (f32 or
    // int/fixed), so a cached result is bit-identical to a computed one, and
    // with no cache bound both ops are no-ops (the original code runs).
    LoadLedCache,  // u8 slot, u8 n, i16 skip
    StoreLedCache, // u8 slot, u8 n
    // --- operand-fused float arithmetic (fx-perf-study R8) ---------------------
    // 110..=119 are reserved for other work in flight; `from_u8` rejects the gap.
    // A scalar float `Add`/`Sub`/`Mul`/`Div` with one or both operands read
    // straight from the const pool / a local / state / a uniform instead of being
    // pushed first: 59–67% of retired opcodes were such stack plumbing. Mode byte:
    // bits 0-1 = the op, bits 2-3 = the first source, bits 4-5 = the second
    // (0 const, 1 local, 2 state, 3 uniform), bit 6 = the integer family. Float:
    // add, sub, mul, div (div by 0 = 0); integer: AddI, SubI, MulI (wrapping),
    // MulFix (Q16.16). Exact fusions: the optimizer emits them for the same ops.
    BinTop = 120, // u8 mode, u16 i : top = top OP src(i)        (src in bits 2-3)
    BinPair,      // u8 mode, u16 a, u16 b : push srcA(a) OP srcB(b)
    // Runs the optimizer collapses (exact: the same pushes / IEEE ops):
    PushConsts,   // u8 n, n x u16 idx : PushConst idx_0 .. PushConst idx_{n-1}
    LoadCtxLanes, // u8 id, u8 src, u8 k, u8 m : LoadCtx id ; Swizzle src->m [k..k+m)
    MulAdd,       // u8 n : a(n) b(n) c(n) -> a + b*c   (Mul n ; Add n)
}

/// The last opcode below the reserved gap, and the last overall.
const LAST_LOW_OP: u8 = Op::StoreLedCache as u8;
pub const LAST_OP: u8 = Op::MulAdd as u8;

/// A register-oriented I2C master for driver programs (FUG-107). The firmware
/// backs it with the same ESP-IDF bus as the native sensor core; host tests
/// and the web preview back it with a register-map fake.
pub trait I2cBus {
    /// Write `bytes` to 7-bit device `addr`; true on ACK.
    fn write(&mut self, addr: u8, bytes: &[u8]) -> bool;
    /// Write the register pointer `reg`, then read `out.len()` bytes; true on
    /// success (`out` untouched on failure).
    fn read_reg(&mut self, addr: u8, reg: u8, out: &mut [u8]) -> bool;
}

/// The bus a running `poll()` sees. Set only for the duration of
/// [`Vm::run_poll`] (single-threaded VM use; never set during shade/update, so
/// the effect hot path is unchanged apart from two unreachable match arms).
static mut POLL_BUS: Option<*mut dyn I2cBus> = None;

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

/// `(x * 2^frac) as i32` — truncating toward zero, saturating, NaN to 0 — with
/// integer ops only, bit-exact with the float expression for `frac <= 31`.
/// The C6 has no FPU: the float form is a soft `__mulsf3` plus `__fixsfsi`
/// (~165 cycles); this is ~15. Used for the Q16.16 context mirrors and the
/// float-to-fixed opcodes. Public so the firmware and native code paths share it.
#[inline]
pub fn f32_to_fix(x: f32, frac: u32) -> i32 {
    let b = x.to_bits();
    let neg = (b as i32) < 0;
    let e = ((b >> 23) & 0xff) as i32;
    if e == 0 {
        return 0; // zero or subnormal: |x * 2^frac| < 1
    }
    if e == 0xff {
        if b & 0x7f_ffff != 0 {
            return 0; // NaN
        }
        return if neg { i32::MIN } else { i32::MAX };
    }
    let m = (b & 0x7f_ffff) | 0x80_0000;
    // |x * 2^frac| = m * 2^sh, and m >= 2^23.
    let sh = e - 150 + frac as i32;
    let mag = if sh >= 8 {
        return if neg { i32::MIN } else { i32::MAX }; // >= 2^31
    } else if sh >= 0 {
        m << sh
    } else if sh > -32 {
        m >> -sh
    } else {
        0
    };
    if neg {
        (mag as i32).wrapping_neg()
    } else {
        mag as i32
    }
}

/// `a as f32 / 2^frac`, bit-exact, without the soft-float divide: the int to
/// float conversion rounds once, and dividing by a power of two only lowers the
/// exponent (the result stays normal for `frac <= 31`).
#[inline]
pub fn fix_to_f32(a: i32, frac: u32) -> f32 {
    let f = a as f32;
    if a == 0 {
        return f;
    }
    f32::from_bits(f.to_bits() - (frac << 23))
}

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
    /// The program was malformed at runtime (operand-stack underflow, an
    /// unknown opcode, an out-of-range operand). The invocation stopped instead
    /// of panicking; treat it like a timeout (hold last/black). A compiler bug,
    /// never a property of a well-formed program.
    Fault,
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
        // Op is contiguous over 0..=LAST_LOW_OP and 120..=LAST_OP (110..=119 are
        // reserved); guard both ranges, then transmute.
        if b <= LAST_LOW_OP || (Op::BinTop as u8..=LAST_OP).contains(&b) {
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
pub const C_LED_ROOM: u8 = 13; // 3 — room-frame position (m); == led.pos while unposed
pub const C_ROOM_MIN: u8 = 14; // 3 — room bounding box (room frame, m)
pub const C_ROOM_MAX: u8 = 15; // 3

pub const MAGIC: [u8; 4] = *b"FXB1";
/// The `.fxb` format version this VM executes: the header's version byte (offset
/// 4). The compiler stamps it, `Program::parse` rejects any other value (the
/// firmware answers `bad_fxb`), and the device reports it (welcome.fxb_format, the
/// agent manifest's protocol.fxb_format) so a host toolchain can check it emits
/// what the device runs.
pub const FORMAT_VERSION: u8 = 1;
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
    /// The `.fxb` header flags byte (FLAG_*), retained so the host can cheaply
    /// query program capabilities without re-scanning the code.
    pub flags: u8,
    /// The raw memo trailer (FLAG_MEMO; empty when absent): `prep_entry(u16)
    /// words(u8) n_groups(u8) group_end(u8) × n_groups`. Held raw and decoded by
    /// [`Program::prep_entry`] / [`Program::led_cache_words`] on demand, so the
    /// per-LED `Program::parse` on the firmware's shade path stays as cheap as
    /// it was (decoding it eagerly cost fx_bench ~300 cycles/LED).
    memo_trailer: &'a [u8],
}

/// flags bit: a buffer descriptor table follows `code` in the `.fxb`.
pub const FLAG_BUFFERS: u8 = 0x01;
/// flags bit: the program uses `LoadCtxFix` (reads the per-LED fixed context
/// cache). Lets the host skip building the fixed mirrors per LED for the common
/// all-float program — zero hot-path overhead for effects that don't need them
/// (FUG-122).
pub const FLAG_USES_CTXFIX: u8 = 0x02;
/// flags bit: the program reads `led.uv` (float or fixed). Lets the host skip the
/// per-LED soft-float uv projection (2 sub + 2 mul + clamp) for the many effects
/// that never touch uv — a chunk of the per-LED framing floor (FUG-122).
pub const FLAG_USES_UV: u8 = 0x04;
/// flags bit: the program reads `led.room` / `room.min` / `room.max`. Lets the
/// host skip fetching the per-LED room-frame position for effects that don't.
pub const FLAG_USES_ROOM: u8 = 0x08;
/// flags bit: a sensor DRIVER (FUG-107), not an effect. Its `poll()` entry is
/// stored in the `shade_entry` header field and its manifest is the export
/// table (`[{"name","slot","width","unit"}]`, slots into `state`). A host must
/// never shade it; [`Vm::run_poll`] runs it.
pub const FLAG_DRIVER: u8 = 0x10;
/// flags bit: a memo trailer follows the buffer table (or the code, when there
/// are no buffers): `prep_entry(u16) words(u8) n_groups(u8) group_end(u8) ×
/// n_groups` — the output of the compiler's variance pass (fx_compiler memo.rs):
///  * `prep_entry`: per-frame-invariant work hoisted out of `shade()`, which the
///    VM runs once per frame on its own (NO_ENTRY = none);
///  * the per-LED memo: the program brackets LED-invariant subexpressions with
///    `LoadLedCache`/`StoreLedCache`; a host that binds a cache
///    ([`Vm::set_led_cache`]) computes each once per LED instead of once per LED
///    per frame. Hosts that don't bind one run the original code unchanged.
/// (0x10 is FUG-107's [`FLAG_DRIVER`].)
pub const FLAG_MEMO: u8 = 0x20;
/// Most memo words one program may request per LED (the validity mask is one
/// bit per word, at most 4 bytes).
pub const LED_CACHE_MAX_WORDS: usize = 32;

/// Validity-mask bytes per LED record for a cache of `words` words.
#[inline]
pub fn led_cache_mask_bytes(words: u8) -> usize {
    (words as usize).div_ceil(8)
}

/// Bytes per LED record (validity mask + `words` 4-byte words).
#[inline]
pub fn led_cache_stride(words: u8) -> usize {
    if words == 0 {
        0
    } else {
        led_cache_mask_bytes(words) + 4 * words as usize
    }
}

/// Total bytes a cache of `words` memo words for `leds` LEDs needs.
#[inline]
pub fn led_cache_bytes(words: u8, leds: usize) -> usize {
    led_cache_stride(words) * leds
}

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
        if buf[4] != FORMAT_VERSION {
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
        // Optional memo trailer (FLAG_MEMO), decoded lazily (see `memo_trailer`).
        let memo_trailer = if flags & FLAG_MEMO != 0 {
            let t = o + buffers.len(); // `o` is past the n_buffers byte when present
            buf.get(t..).unwrap_or(&[])
        } else {
            &[]
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
            flags,
            memo_trailer,
        })
    }

    /// The per-frame PREPARE entry (NO_ENTRY if absent): code the compiler
    /// hoisted out of `shade()` because it is the same for every LED of a frame
    /// (`sin(time*speed)`, uniform math, …). It stores into extra `state` slots
    /// that `shade()` then just loads. The VM runs it itself, once per frame,
    /// right before the first `shade()` (see [`Vm::run_shade_counted`]).
    #[inline]
    pub fn prep_entry(&self) -> u16 {
        match self.memo_trailer {
            [a, b, ..] => {
                let e = u16::from_le_bytes([*a, *b]);
                if (e as usize) < self.code.len() {
                    e
                } else {
                    NO_ENTRY
                }
            }
            _ => NO_ENTRY,
        }
    }

    /// Per-LED memo words the program's `LoadLedCache`/`StoreLedCache` slots
    /// span (0 = no LED cache requested). See [`FLAG_MEMO`].
    pub fn led_cache_words(&self) -> u8 {
        let w = self.memo_trailer.get(2).copied().unwrap_or(0);
        if (w as usize) <= LED_CACHE_MAX_WORDS && self.led_cache_groups().len() == self.memo_trailer.get(3).copied().unwrap_or(0) as usize {
            w
        } else {
            0
        }
    }

    /// Cumulative word boundaries of the memo groups, in the compiler's priority
    /// order (best cycles-saved-per-byte first). A host short on RAM binds the
    /// largest prefix that fits ([`Program::led_cache_fit`]).
    fn led_cache_groups(&self) -> &'a [u8] {
        let ng = self.memo_trailer.get(3).copied().unwrap_or(0) as usize;
        self.memo_trailer.get(4..4 + ng).unwrap_or(&[])
    }

    /// The largest memo prefix (in words, at a group boundary so no expression
    /// is half-cached) whose cache for `leds` LEDs fits in `avail` bytes. 0 when
    /// the program requests no cache or not even the first group fits — the
    /// effect then runs uncached, exactly as before.
    pub fn led_cache_fit(&self, leds: usize, avail: usize) -> u8 {
        let mut best = 0u8;
        let words = self.led_cache_words();
        for &end in self.led_cache_groups() {
            if end <= words && led_cache_bytes(end, leds) <= avail {
                best = best.max(end);
            } else {
                // Groups are in priority order: stop at the first that doesn't
                // fit so a cheap low-priority one never displaces a better one.
                break;
            }
        }
        best
    }

    /// The raw code section (borrowed from the `.fxb`). The device JIT scans this
    /// for hot blocks and the firmware patches `JitCall` into the backing buffer
    /// (FUG-125).
    #[inline]
    pub fn code(&self) -> &'a [u8] {
        self.code
    }

    /// The raw const pool bytes (`n_consts * 4`, little-endian). The device JIT
    /// builds an aligned i32 mirror of these for its segments' `a2` base.
    #[inline]
    pub fn consts_raw(&self) -> &'a [u8] {
        self.consts
    }

    /// Whether the program reads the per-LED fixed context cache (`LoadCtxFix`).
    /// The host uses this to skip building the fixed mirrors for all-float
    /// programs (FUG-122).
    #[inline]
    pub fn uses_ctxfix(&self) -> bool {
        self.flags & FLAG_USES_CTXFIX != 0
    }

    /// Whether the program reads `led.uv`. The host skips the per-LED soft-float
    /// uv projection when this is false (FUG-122).
    #[inline]
    pub fn uses_uv(&self) -> bool {
        self.flags & FLAG_USES_UV != 0
    }

    /// Whether the program reads the room frame (`led.room`, `room.min/max`).
    #[inline]
    pub fn uses_room(&self) -> bool {
        self.flags & FLAG_USES_ROOM != 0
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
        // Out-of-range index reads 0.0 (never panics; see `Outcome::Fault`).
        let o = idx * 4;
        match self.consts.get(o..o + 4) {
            Some(b) => f32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            None => 0.0,
        }
    }
}

/// Per-frame context (constant across all LEDs of one frame).
///
/// Each continuous quantity carries BOTH an `f32` and a pre-converted Q16.16
/// `*_fix` form. A program that only touches fixed/int context (via `LoadCtxFix`)
/// reads the `*_fix` fields and never triggers a soft-float conversion; the host
/// fills whichever representation the loaded `.fxb` actually uses (FUG-122). The
/// fixed forms are computed ONCE per frame in `update()`, not per LED.
#[derive(Clone, Copy, Default)]
pub struct Frame {
    pub time: f32,
    pub dt: f32,
    pub frame: u32,
    pub led_count: u32,
    pub imu_accel: [f32; 3],
    pub imu_gyro: [f32; 3],
    /// Q16.16 fixed mirrors (see struct doc). Filled by the host FFI.
    pub time_fix: i32,
    pub dt_fix: i32,
    pub imu_accel_fix: [i32; 3],
    pub imu_gyro_fix: [i32; 3],
    /// The fixture has a room pose: `led.room` reads `Led::room`. While false
    /// (every host that doesn't know about rooms) `led.room` is `led.pos`, so an
    /// effect written for one fixture keeps working.
    pub room_posed: bool,
    /// The room bounding box (`room.min` / `room.max`) and its Q16.16 mirrors.
    pub room_min: [f32; 3],
    pub room_max: [f32; 3],
    pub room_min_fix: [i32; 3],
    pub room_max_fix: [i32; 3],
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
    /// Q16.16 fixed mirrors of the per-LED geometry (FUG-122). These are the
    /// "convert LED positions to fixed ONCE and cache" fields: the host computes
    /// them at map/topology load, not per frame, so a fixed-only shader reads
    /// them via `LoadCtxFix` with zero soft-float on the hot path.
    pub pos_fix: [i32; 3],
    pub uv_fix: [i32; 2],
    pub s_fix: i32,
    pub dist_fix: i32,
    /// Room-frame position (metres) and its Q16.16 mirror; read only when
    /// `Frame::room_posed` (else `led.room` == `led.pos`).
    pub room: [f32; 3],
    pub room_fix: [i32; 3],
}

/// Canonical fraction width the `*_fix` context fields are cached in (Q16.16).
/// `LoadCtxFix` rescales from this to the shader's requested `frac` with a cheap
/// integer shift.
pub const CTX_FIX_FRAC: u32 = 16;

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
    // Resident execution scratch (operand stack, locals, call-return stack).
    // Kept on the Vm and REUSED across invocations instead of being re-zeroed on
    // every shade()/update() call — the per-LED array zeroing was a large slice
    // of the framing cost. Sound because the VM only ever reads a slot it wrote
    // earlier in the SAME invocation (a stack machine pushes before it pops; the
    // compiler stores a local before loading it), so stale contents are never
    // observed. `sp`/`csp` reset to 0 each run.
    stack: [f32; MAX_STACK],
    locals: [f32; MAX_LOCALS],
    call_stack: [usize; 16],
    // On-device JIT table (FUG-125). Borrowed from the firmware, which owns the
    // block descriptors + the executable segments they point at and keeps them
    // alive for the effect's lifetime; the VM only reads/calls through them.
    // Null/0 = no JIT (the interpreter runs everything). Raw ptr so the Vm needs
    // no lifetime and stays no-alloc.
    jit_blocks: *const JitBlock,
    jit_len: usize,
    // Aligned i32 mirror of the const pool for the JIT segments' `a2` base
    // (the .fxb const bytes may be unaligned; the firmware provides this).
    jit_consts: *const i32,
    // Per-LED memo cache (LoadLedCache/StoreLedCache): host memory bound via
    // set_led_cache. `led_cache_leds` records of `led_cache_stride(words)` bytes
    // each: a validity mask (1 bit per word) then the words. Raw ptr so the Vm
    // needs no lifetime; null/0 = no cache (the memo ops are no-ops).
    memo_ptr: *mut u8,
    memo_words: u8,
    memo_leds: usize,
    // Per-frame prepare (Program::prep_entry): has it run for the frame/program
    // identified by `prep_key`, since the last update()/set_uniform/set_graph?
    prep_valid: bool,
    prep_key: [u32; PREP_KEY_WORDS],
}

const PREP_KEY_WORDS: usize = 3;

/// What identifies "this frame" for the hoisted prepare code: the program, the
/// frame counter and the clock. Kept to three words because it is checked on
/// EVERY shade() (a 12-word key cost ~90 C6 cycles/LED on fx_bench). Everything
/// else prep may read changes only with a new frame (imu/room/led_count are
/// per-frame host inputs) or through `set_uniform` / `run_update` /
/// `set_graph`, which invalidate it.
#[inline(always)]
fn prep_key(prog: &Program, f: &Frame) -> [u32; PREP_KEY_WORDS] {
    [prog.code.as_ptr() as usize as u32, f.frame, f.time.to_bits()]
}

/// `LoadLedCache` hit path: push LED `idx`'s `n` cached words for `slot` (at
/// stack depth `sp`) if filled, returning the new depth (None = miss; the
/// caller then computes the expression). Takes/returns `sp` BY VALUE: taking
/// `&mut sp` would force the interpreter's stack pointer out of a register for
/// the whole dispatch loop (measured ~5% on every fx_bench program).
#[inline(never)]
fn memo_load(idx: u32, slot: usize, n: usize, stack: &mut [f32; MAX_STACK], sp: usize) -> Option<usize> {
    // SAFETY: written only by run_shade_counted while it holds MEMO_LOCK.
    let memo = unsafe { ACTIVE_MEMO }.filter(|m| m.owner == stack.as_ptr())?;
    let o = memo.record(idx, slot, n)?;
    let mem = memo.mem();
    if mem[o + slot / 8] & (1 << (slot % 8)) == 0 || sp + n > MAX_STACK {
        return None;
    }
    let w = o + led_cache_mask_bytes(memo.words) + slot * 4;
    for k in 0..n {
        let b = &mem[w + k * 4..w + k * 4 + 4];
        stack[sp + k] = f32::from_bits(u32::from_le_bytes([b[0], b[1], b[2], b[3]]));
    }
    Some(sp + n)
}

/// `StoreLedCache`: record the top `n` stack words into LED `idx`'s `slot`.
#[inline(never)]
fn memo_store(idx: u32, slot: usize, n: usize, stack: &[f32; MAX_STACK], sp: usize) {
    // SAFETY: as in memo_load.
    let Some(memo) = (unsafe { ACTIVE_MEMO }).filter(|m| m.owner == stack.as_ptr()) else { return };
    let Some(o) = memo.record(idx, slot, n) else { return };
    let mem = memo.mem();
    if sp < n {
        return;
    }
    let w = o + led_cache_mask_bytes(memo.words) + slot * 4;
    for k in 0..n {
        let bits = stack[sp - n + k].to_bits().to_le_bytes();
        mem[w + k * 4..w + k * 4 + 4].copy_from_slice(&bits);
    }
    mem[o + slot / 8] |= 1 << (slot % 8);
}

/// The per-LED memo cache for the shade() invocation in flight: set by
/// `run_shade_counted` while it holds [`MEMO_LOCK`] (None otherwise), read by
/// the interpreter's memo ops. A static, not an argument — see the op arms.
#[derive(Clone, Copy)]
struct Memo {
    /// The owning VM's operand stack: a memo op only honours the binding of the
    /// VM that is executing it (another thread's VM may be mid-invocation).
    owner: *const f32,
    ptr: *mut u8,
    len: usize,
    words: u8,
    leds: usize,
}


static mut ACTIVE_MEMO: Option<Memo> = None;
/// Serializes cache-bound shade() invocations across threads (host tests run
/// VMs concurrently; the device is single-threaded, so it is never contended).
static MEMO_LOCK: core::sync::atomic::AtomicBool = core::sync::atomic::AtomicBool::new(false);

/// Holds MEMO_LOCK with ACTIVE_MEMO set; clears + releases on drop (incl. unwind).
struct MemoGuard;

impl MemoGuard {
    fn bind(memo: Memo) -> MemoGuard {
        use core::sync::atomic::Ordering;
        while MEMO_LOCK
            .compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed)
            .is_err()
        {
            core::hint::spin_loop();
        }
        // SAFETY: we hold MEMO_LOCK.
        unsafe { ACTIVE_MEMO = Some(memo) };
        MemoGuard
    }
}

impl Drop for MemoGuard {
    fn drop(&mut self) {
        // SAFETY: we hold MEMO_LOCK.
        unsafe { ACTIVE_MEMO = None };
        MEMO_LOCK.store(false, core::sync::atomic::Ordering::Release);
    }
}

impl Memo {
    #[inline]
    #[allow(clippy::mut_from_ref)]
    fn mem(&self) -> &mut [u8] {
        // SAFETY: set from a set_led_cache binding of at least `len` bytes.
        unsafe { core::slice::from_raw_parts_mut(self.ptr, self.len) }
    }
    /// Byte offset of LED `idx`'s record if `[slot, slot+n)` is cacheable.
    #[inline]
    fn record(&self, idx: u32, slot: usize, n: usize) -> Option<usize> {
        let idx = idx as usize;
        if idx < self.leds && slot + n <= self.words as usize && n > 0 {
            Some(idx * led_cache_stride(self.words))
        } else {
            None
        }
    }
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
            stack: [0.0; MAX_STACK],
            locals: [0.0; MAX_LOCALS],
            call_stack: [0; 16],
            jit_blocks: core::ptr::null(),
            jit_len: 0,
            jit_consts: core::ptr::null(),
            memo_ptr: core::ptr::null_mut(),
            memo_words: 0,
            memo_leds: 0,
            prep_valid: false,
            prep_key: [0; PREP_KEY_WORDS],
        }
    }
}

impl Vm {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a uniform's value (`vals` length = its slot count).
    pub fn set_uniform(&mut self, slot: usize, vals: &[f32]) {
        self.prep_valid = false; // hoisted per-frame values may read it
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
        self.prep_valid = false;
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

    /// Install the on-device JIT table (FUG-125): `blocks` describe the native
    /// segments the firmware compiled for this effect's hot straight-line blocks,
    /// and `consts` is an aligned i32 mirror of the program's const pool (the
    /// segments' `a2` base). Both must outlive the following run calls; the
    /// firmware owns the executable code the block funcs point at. Pass an empty
    /// slice to disable the JIT (pure interpretation).
    ///
    /// # Safety
    /// `blocks` and `consts` must remain valid + immovable for as long as this Vm
    /// runs the matching (JitCall-patched) program, and each `JitBlock::func` must
    /// point at executable code with the documented ABI.
    pub unsafe fn set_jit(&mut self, blocks: &[JitBlock], consts: *const i32) {
        self.jit_blocks = blocks.as_ptr();
        self.jit_len = blocks.len();
        self.jit_consts = consts;
    }

    /// Bind the per-LED memo cache: the first `words` memo words (pass
    /// [`Program::led_cache_fit`]) for LEDs `0..leds`, in `mem` (at least
    /// [`led_cache_bytes`]`(words, leds)` bytes, else nothing is bound). Every
    /// slot starts EMPTY (the masks are zeroed), so the next frame computes and
    /// records each memoized value once per LED. The caller keeps `mem` alive,
    /// unmoved and otherwise untouched while bound, and must call
    /// [`Vm::invalidate_led_cache`] (or rebind) whenever an LED's attributes —
    /// position, uv, topology (seg/s/branch) — change, i.e. on a map/topology
    /// upload. `idx` must keep naming the same LED between invalidations.
    pub fn set_led_cache(&mut self, mem: &mut [u8], words: u8, leds: usize) {
        let words = words.min(LED_CACHE_MAX_WORDS as u8);
        let need = led_cache_bytes(words, leds);
        if words == 0 || leds == 0 || mem.len() < need {
            self.clear_led_cache();
            return;
        }
        self.memo_ptr = mem.as_mut_ptr();
        self.memo_words = words;
        self.memo_leds = leds;
        self.invalidate_led_cache();
    }

    /// Unbind the per-LED memo cache (the memo ops become no-ops).
    pub fn clear_led_cache(&mut self) {
        self.memo_ptr = core::ptr::null_mut();
        self.memo_words = 0;
        self.memo_leds = 0;
    }

    /// Mark every cached slot empty (keeps the binding). Call when the map or
    /// topology changes; the next frame recomputes each LED's values.
    pub fn invalidate_led_cache(&mut self) {
        if self.memo_ptr.is_null() {
            return;
        }
        let stride = led_cache_stride(self.memo_words);
        let mb = led_cache_mask_bytes(self.memo_words);
        // SAFETY: bound via set_led_cache with at least stride*leds bytes.
        let mem = unsafe { core::slice::from_raw_parts_mut(self.memo_ptr, stride * self.memo_leds) };
        for rec in mem.chunks_exact_mut(stride) {
            rec[..mb].fill(0);
        }
    }

    /// Memo words currently bound (0 = no cache).
    pub fn led_cache_words_bound(&self) -> u8 {
        self.memo_words
    }

    /// Clear the JIT table (back to pure interpretation).
    pub fn clear_jit(&mut self) {
        self.jit_blocks = core::ptr::null();
        self.jit_len = 0;
        self.jit_consts = core::ptr::null();
    }

    /// The JIT table as a slice (empty when unset).
    // Intentional accessor mirroring `set_jit`/`clear_jit`; the hot paths read
    // `jit_blocks`/`jit_len` directly, so this convenience view is currently unused.
    #[allow(dead_code)]
    fn jit_table(&self) -> &[JitBlock] {
        if self.jit_blocks.is_null() {
            &[]
        } else {
            // SAFETY: set via `set_jit` with a slice the firmware keeps alive.
            unsafe { core::slice::from_raw_parts(self.jit_blocks, self.jit_len) }
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
        // Copy the raw arena ptr/len out first so building the slice doesn't hold
        // a borrow of `self` (lets the disjoint field borrows below coexist).
        let (arena_ptr, arena_len) = (self.arena_ptr, self.arena_len);
        let arena: &mut [u8] = if arena_ptr.is_null() || arena_len == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(arena_ptr, arena_len) }
        };
        // Inline the graph borrow (disjoint fields) so `state`/`dist`/scratch can
        // be borrowed mutably at the same time — no per-invocation copies.
        let g = GraphRef {
            n_seg: self.n_seg,
            seg_len: &self.seg_len,
            seg_node: &self.seg_node,
            node_deg: &self.node_deg,
            node_seg: &self.node_seg,
            node_side: &self.node_side,
        };
        // update() writes `state` — the hoisted per-frame values derived from it
        // are recomputed before the next shade().
        self.prep_valid = false;
        // update() writes `state`/`dist_src` in place — the intended persistence.
        let (_out, _rgb, outcome, counters) = run(
            prog,
            &self.uniforms,
            &mut self.state,
            frame,
            &led,
            &g,
            &mut self.dist_src,
            arena,
            &mut self.stack,
            &mut self.locals,
            &mut self.call_stack,
            prog.update_entry as usize,
            budget,
            self.jit_blocks,
            self.jit_len,
            self.jit_consts,
            // update() never touches the per-LED memo (the compiler only brackets
        );
        (outcome, counters)
    }

    /// Run a driver's `poll()` (a FLAG_DRIVER program) with `bus` reachable from
    /// its `i2c_*` intrinsics, writing its exports into `state` in place (read
    /// them back with [`Vm::export`]). A non-driver program is a no-op. Returns
    /// the outcome and Tier-1 counters (opcodes retired) for the A/B cost.
    pub fn run_poll(
        &mut self,
        prog: &Program,
        frame: &Frame,
        bus: &mut dyn I2cBus,
        budget: &Budget,
    ) -> (Outcome, Counters) {
        if prog.flags & FLAG_DRIVER == 0 || prog.shade_entry == NO_ENTRY {
            return (Outcome::Ok, Counters::default());
        }
        let led = Led::default();
        let (arena_ptr, arena_len) = (self.arena_ptr, self.arena_len);
        let arena: &mut [u8] = if arena_ptr.is_null() || arena_len == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(arena_ptr, arena_len) }
        };
        let g = GraphRef {
            n_seg: self.n_seg,
            seg_len: &self.seg_len,
            seg_node: &self.seg_node,
            node_deg: &self.node_deg,
            node_seg: &self.node_seg,
            node_side: &self.node_side,
        };
        // SAFETY: cleared before returning; the VM is single-threaded and `bus`
        // outlives this call. The lifetime is erased only for the static slot.
        unsafe {
            let raw: *mut (dyn I2cBus + '_) = bus;
            POLL_BUS = Some(core::mem::transmute::<*mut (dyn I2cBus + '_), *mut dyn I2cBus>(raw));
        }
        let (_out, _rgb, outcome, counters) = run(
            prog,
            &self.uniforms,
            &mut self.state,
            frame,
            &led,
            &g,
            &mut self.dist_src,
            arena,
            &mut self.stack,
            &mut self.locals,
            &mut self.call_stack,
            prog.shade_entry as usize,
            budget,
            self.jit_blocks,
            self.jit_len,
            self.jit_consts,
        );
        unsafe { POLL_BUS = None };
        (outcome, counters)
    }

    /// A driver export's current value: `state[slot..slot + out.len()]`.
    pub fn export(&self, slot: usize, out: &mut [f32]) {
        for (i, o) in out.iter_mut().enumerate() {
            *o = *self.state.get(slot + i).unwrap_or(&0.0);
        }
    }

    /// Run the prepare entry if this frame (or a uniform / update()) made it stale.
    #[cold]
    #[inline(never)]
    fn prep_if_stale(&mut self, prog: &Program, frame: &Frame, budget: &Budget) -> Counters {
        if prog.prep_entry() == NO_ENTRY {
            return Counters::default();
        }
        let key = prep_key(prog, frame);
        if self.prep_valid && self.prep_key == key {
            return Counters::default();
        }
        self.run_prep(prog, frame, budget)
    }

    /// Run the program's per-frame prepare entry (hoisted shade() work) into its
    /// `state` slots. Normally implicit (run_shade does it once per frame); a host
    /// may call it eagerly right after update() to keep the cost out of the first
    /// LED. update()-like context: no LED, no memo cache.
    pub fn run_prep(&mut self, prog: &Program, frame: &Frame, budget: &Budget) -> Counters {
        let prep_entry = prog.prep_entry();
        if prep_entry == NO_ENTRY {
            return Counters::default();
        }
        let led = Led::default();
        let (arena_ptr, arena_len) = (self.arena_ptr, self.arena_len);
        let arena: &mut [u8] = if arena_ptr.is_null() || arena_len == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(arena_ptr, arena_len) }
        };
        let g = GraphRef {
            n_seg: self.n_seg,
            seg_len: &self.seg_len,
            seg_node: &self.seg_node,
            node_deg: &self.node_deg,
            node_seg: &self.node_seg,
            node_side: &self.node_side,
        };
        let (_out, _rgb, _outcome, counters) = run(
            prog,
            &self.uniforms,
            &mut self.state,
            frame,
            &led,
            &g,
            &mut self.dist_src,
            arena,
            &mut self.stack,
            &mut self.locals,
            &mut self.call_stack,
            prep_entry as usize,
            budget,
            self.jit_blocks,
            self.jit_len,
            self.jit_consts,
        );
        self.prep_key = prep_key(prog, frame);
        self.prep_valid = true;
        counters
    }

    /// Run `shade(led)` → RGB. Does not mutate `state` (read-only in shade).
    /// Uses the default budget.
    pub fn run_shade(&mut self, prog: &Program, frame: &Frame, led: &Led) -> Rgb {
        self.run_shade_bounded(prog, frame, led, &Budget::default()).0
    }

    /// Run `shade(led)` under an explicit [`Budget`]. On a cancelled invocation
    /// (budget/timeout) the returned RGB is black — the caller may instead hold
    /// the LED's previous colour. Returns `(rgb, outcome)`.
    pub fn run_shade_bounded(
        &mut self,
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
        &mut self,
        prog: &Program,
        frame: &Frame,
        led: &Led,
        budget: &Budget,
    ) -> (Rgb, Outcome, Counters) {
        // Per-frame prepare (hoisted shade() work): once per frame, before the
        // first LED. Its ops count toward this invocation's counters.
        // Kept to one flag test on the hot path: shade() runs per LED and fx_bench
        // measures this framing (an eager check here cost ~300 C6 cycles/LED).
        let prep_counters = if prog.flags & FLAG_MEMO != 0 {
            self.prep_if_stale(prog, frame, budget)
        } else {
            Counters::default()
        };
        // shade() is read-only on `state` (the compiler never emits StoreState in
        // shade), so we pass `state`/`dist_src` by mutable ref WITHOUT the old
        // per-LED copy — the values are unchanged on return. This was ~900 B of
        // copying per LED (FUG-122 hill-climb).
        let (arena_ptr, arena_len) = (self.arena_ptr, self.arena_len);
        let arena: &mut [u8] = if arena_ptr.is_null() || arena_len == 0 {
            &mut []
        } else {
            unsafe { core::slice::from_raw_parts_mut(arena_ptr, arena_len) }
        };
        // The per-LED memo cache, if bound (disjoint host memory, see
        // set_led_cache), for this invocation's memo ops.
        let _memo_guard = (!self.memo_ptr.is_null()).then(|| {
            MemoGuard::bind(Memo {
                owner: self.stack.as_ptr(),
                ptr: self.memo_ptr,
                len: led_cache_bytes(self.memo_words, self.memo_leds),
                words: self.memo_words,
                leds: self.memo_leds,
            })
        });
        let g = GraphRef {
            n_seg: self.n_seg,
            seg_len: &self.seg_len,
            seg_node: &self.seg_node,
            node_deg: &self.node_deg,
            node_seg: &self.node_seg,
            node_side: &self.node_side,
        };
        let (out, rgb, outcome, counters) = run(
            prog,
            &self.uniforms,
            &mut self.state,
            frame,
            led,
            &g,
            &mut self.dist_src,
            arena,
            &mut self.stack,
            &mut self.locals,
            &mut self.call_stack,
            prog.shade_entry as usize,
            budget,
            self.jit_blocks,
            self.jit_len,
            self.jit_consts,
        );
        let counters = Counters {
            instrs: counters.instrs.saturating_add(prep_counters.instrs),
            stack_max: counters.stack_max.max(prep_counters.stack_max),
        };
        if outcome.timed_out() {
            return ((0, 0, 0), outcome, counters);
        }
        // A `RetRgb8`/`RetRgbFix` shader already produced the 8-bit colour with no
        // soft-float — skip the clamp01()*255 epilogue entirely (FUG-122).
        if let Some(rgb) = rgb {
            return (rgb, outcome, counters);
        }
        // Integer epilogue: bit-exact `(clamp01(x) * 255.0) as u8`
        // without the ~6 soft-float calls per channel.
        ((unit_u8(out[0]), unit_u8(out[1]), unit_u8(out[2])), outcome, counters)
    }
}

/// Bit-exact integer twin of `(clamp01(x) * 255.0) as u8` (IEEE round-to-nearest-
/// even on the product, then truncation), with no soft-float.
#[inline]
pub fn unit_u8(x: f32) -> u8 {
    let b = x.to_bits();
    if b & 0x8000_0000 != 0 {
        return 0; // negative, -0.0, or a negative NaN
    }
    if b >= 0x3f80_0000 {
        return if b > 0x7f80_0000 { 0 } else { 255 }; // >= 1.0 / inf ; NaN -> 0
    }
    let e = (b >> 23) as i32;
    if e == 0 {
        return 0; // zero / subnormal: x*255 < 1
    }
    let m = (b & 0x007f_ffff) | 0x0080_0000;
    let p = m as u64 * 255; // exact, < 2^32
    let nb = 64 - p.leading_zeros();
    let pr = if nb > 24 {
        let sh = nb - 24;
        let mut q = p >> sh;
        let rem = p & ((1u64 << sh) - 1);
        let half = 1u64 << (sh - 1);
        if rem > half || (rem == half && q & 1 == 1) {
            q += 1;
        }
        q << sh
    } else {
        p
    };
    // value = pr * 2^(e-150); x < 1 so e <= 126 and the shift is >= 24; pr < 2^33,
    // so any shift past 40 is 0 (and must not wrap the shift amount).
    let shift = (150 - e) as u32;
    if shift >= 40 {
        0
    } else {
        (pr >> shift) as u8
    }
}

#[inline]
pub fn clamp01(x: f32) -> f32 {
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

/// `LoadCtx` body, kept out of line on purpose (see the call site).
#[inline(never)]
fn load_ctx(id: u8, frame: &Frame, led: &Led, graph: &GraphRef, dist: &DistSrc, v: &mut [f32; 3]) -> usize {
    let mut k = 0usize;
    match id {
                    C_TIME => { v[k] = frame.time; k += 1; },
                    C_DT => { v[k] = frame.dt; k += 1; },
                    C_FRAME => { v[k] = frame.frame as f32; k += 1; },
                    C_LED_POS => {
                        { v[k] = led.pos[0]; k += 1; }
                        { v[k] = led.pos[1]; k += 1; }
                        { v[k] = led.pos[2]; k += 1; }
                    }
                    C_LED_IDX => { v[k] = led.idx as f32; k += 1; },
                    C_LED_COUNT => { v[k] = frame.led_count as f32; k += 1; },
                    C_LED_SEG => { v[k] = led.seg as f32; k += 1; },
                    C_LED_S => { v[k] = led.s; k += 1; },
                    C_LED_BRANCH => { v[k] = if led.branch { 1.0 } else { 0.0 }; k += 1; },
                    C_IMU_ACCEL => {
                        { v[k] = frame.imu_accel[0]; k += 1; }
                        { v[k] = frame.imu_accel[1]; k += 1; }
                        { v[k] = frame.imu_accel[2]; k += 1; }
                    }
                    C_IMU_GYRO => {
                        { v[k] = frame.imu_gyro[0]; k += 1; }
                        { v[k] = frame.imu_gyro[1]; k += 1; }
                        { v[k] = frame.imu_gyro[2]; k += 1; }
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
                            v[k] = if g.is_finite() { (g / dist.max).min(1.0) } else { 1.0 };
                            k += 1;
                        } else {
                            { v[k] = led.dist; k += 1; }
                        }
                    }
                    C_LED_UV => {
                        { v[k] = led.uv[0]; k += 1; }
                        { v[k] = led.uv[1]; k += 1; }
                    }
                    C_LED_ROOM => {
                        let r = if frame.room_posed { &led.room } else { &led.pos };
                        { v[k] = r[0]; k += 1; }
                        { v[k] = r[1]; k += 1; }
                        { v[k] = r[2]; k += 1; }
                    }
                    C_ROOM_MIN => {
                        { v[k] = frame.room_min[0]; k += 1; }
                        { v[k] = frame.room_min[1]; k += 1; }
                        { v[k] = frame.room_min[2]; k += 1; }
                    }
                    C_ROOM_MAX => {
                        { v[k] = frame.room_max[0]; k += 1; }
                        { v[k] = frame.room_max[1]; k += 1; }
                        { v[k] = frame.room_max[2]; k += 1; }
                    }
                    _ => { v[k] = 0.0; k += 1; },
                }
    k
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
#[allow(clippy::too_many_arguments)]
fn run(
    prog: &Program,
    uniforms: &[f32; MAX_UNIFORM_SLOTS],
    state: &mut [f32; MAX_STATE],
    frame: &Frame,
    led: &Led,
    graph: &GraphRef,
    dist: &mut DistSrc,
    arena: &mut [u8],
    // Resident scratch, reused across invocations (see [`Vm`]); NOT re-zeroed.
    stack: &mut [f32; MAX_STACK],
    locals: &mut [f32; MAX_LOCALS],
    call_stack: &mut [usize; 16],
    entry: usize,
    guard: &Budget,
    // On-device JIT table (FUG-125), passed as raw parts so `run` needs no extra
    // borrow of the Vm; empty/null when the JIT is off.
    jit_blocks: *const JitBlock,
    jit_len: usize,
    jit_consts: *const i32,
) -> ([f32; 3], Option<Rgb>, Outcome, Counters) {
    use core::sync::atomic::Ordering;
    let code = prog.code;
    // NONE of the scratch is cleared per invocation: the VM only reads a slot it
    // wrote earlier in THIS invocation. Stack/call-stack are push-before-pop;
    // scalar locals are initialized by their declaration; array/struct locals are
    // explicitly zeroed by a `FillLocal` the compiler emits at their declaration.
    // So the whole per-LED clear is gone (FUG-122 framing hill-climb).
    let _ = &locals; // (written via StoreLocal / FillLocal; never blanket-cleared)
    let mut sp: usize = 0;
    let mut pc: usize = entry;
    let mut budget: u32 = guard.instructions; // instructions per invocation
    // Tier-1 counters (perf-monitoring.md): opcodes retired + stack high-water.
    // Cheap-by-construction — one add + one max next to the budget decrement.
    // `instrs` (opcodes retired) is derived from the budget at exit: the loop
    // decrements `budget` once per opcode, so one counter serves both.
    let mut sp_max: usize = 0;
    let mut csp: usize = 0;
    let mut outcome = Outcome::Ok;

    #[cfg(feature = "profile")]
    let mut prof_prev: usize = usize::MAX;
    'exec: while pc < code.len() {
        // (The macros live inside the loop so `break 'exec` resolves: labels are
        // hygienic at the macro's definition site.)
        // Never panic (R3): a malformed or miscompiled program (operand-stack
        // underflow, a truncated operand, an out-of-range count) ends the invocation
        // with `Outcome::Fault` instead of indexing out of bounds. Operand bytes past
        // the end of the code read as 0 (the next dispatch then stops at code end).
        macro_rules! fault {
            () => {{
                outcome = Outcome::Fault;
                break 'exec;
            }};
        }
        // `sp - k`, or Fault on underflow.
        macro_rules! sub {
            ($k:expr) => {{
                match sp.checked_sub($k) {
                    Some(b) => b,
                    None => fault!(),
                }
            }};
        }
        // A fixed-point `frac` operand: the compiler emits 0..=16; anything
        // past 30 would shift out of range, so it is a malformed program.
        macro_rules! frac {
            ($e:expr) => {{
                let f = $e as u32;
                if f > 30 {
                    fault!();
                }
                f
            }};
        }
        // Secondary wall-time guard: a hardware timer raises this flag at a
        // frame-relative deadline. Polled on every taken backward branch and
        // call (where a long-running invocation must loop or recurse) instead of
        // every 1024th opcode, which kept two instructions on every dispatch;
        // straight-line code is bounded by the code length and the budget.
        macro_rules! poll_deadline {
            () => {{
                if let Some(flag) = guard.deadline {
                    // SAFETY: `flag` points at a live AtomicBool owned by the
                    // caller for the duration of this call (the C++ FFI holds it
                    // in a static). Atomic load is sound through a shared ref.
                    if unsafe { (*flag).load(Ordering::Relaxed) } {
                        outcome = Outcome::Timeout;
                        break 'exec;
                    }
                }
            }};
        }
        macro_rules! cb {
            ($o:expr) => {
                *code.get($o).unwrap_or(&0)
            };
        }
        macro_rules! rd16 {
            ($o:expr) => {{
                let o = $o;
                u16::from_le_bytes([cb!(o), cb!(o + 1)])
            }};
        }
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
                if sp == 0 {
                    fault!();
                }
                sp -= 1;
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
        if budget == 0 {
            outcome = Outcome::Budget;
            break;
        }
        budget -= 1;
        // Stack high-water: the sp before this op ran (post-op depth is folded
        // in via the NEXT iteration's read, and the terminal Ret is small).
        if sp > sp_max {
            sp_max = sp;
        }
        // One compare for the common opcodes, then the jump table
        // (`Op::from_u8` compiled to a clamp plus a second compare here).
        let b = code[pc];
        if b > LAST_LOW_OP && !(Op::BinTop as u8..=LAST_OP).contains(&b) {
            fault!();
        }
        // SAFETY: `Op` is `repr(u8)` and contiguous over 0..=LAST_LOW_OP and
        // BinTop..=LAST_OP; the gap between was rejected above.
        let op = unsafe { core::mem::transmute::<u8, Op>(b) };
        pc += 1;
        #[cfg(feature = "profile")]
        {
            profile::record(prof_prev, op as usize);
            prof_prev = op as usize;
        }
        match op {
            Op::PushConst => {
                let idx = rd16!(pc) as usize;
                pc += 2;
                push!(prog.const_f32(idx));
            }
            Op::LoadUniform => {
                let slot = cb!(pc) as usize;
                let n = cb!(pc + 1) as usize;
                pc += 2;
                for i in 0..n {
                    push!(*uniforms.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::LoadState => {
                let slot = cb!(pc) as usize;
                let n = cb!(pc + 1) as usize;
                pc += 2;
                for i in 0..n {
                    push!(*state.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::StoreState => {
                let slot = cb!(pc) as usize;
                let n = cb!(pc + 1) as usize;
                pc += 2;
                for i in (0..n).rev() {
                    let v = pop!();
                    if slot + i < MAX_STATE {
                        state[slot + i] = v;
                    }
                }
            }
            Op::LoadLocal => {
                let slot = cb!(pc) as usize;
                let n = cb!(pc + 1) as usize;
                pc += 2;
                for i in 0..n {
                    push!(*locals.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::StoreLocal => {
                let slot = cb!(pc) as usize;
                let n = cb!(pc + 1) as usize;
                pc += 2;
                for i in (0..n).rev() {
                    let v = pop!();
                    if slot + i < MAX_LOCALS {
                        locals[slot + i] = v;
                    }
                }
            }
            Op::LoadCtx => {
                let id = cb!(pc);
                pc += 1;
                // Out of line on purpose (docs/design/fx-perf-study.md): inlined,
                // LLVM hoists this arm's loop-invariant soft-float (1.0 - led.s,
                // int->f32 of idx/seg/frame, ...) into run()'s prologue, so EVERY
                // invocation paid it whether or not the program reads them.
                // The hottest ids are plain f32 copies (no conversion LLVM could
                // hoist), so they stay inline and skip the call.
                match id {
                    C_LED_POS => {
                        push!(led.pos[0]);
                        push!(led.pos[1]);
                        push!(led.pos[2]);
                    }
                    C_LED_UV => {
                        push!(led.uv[0]);
                        push!(led.uv[1]);
                    }
                    C_TIME => push!(frame.time),
                    _ => {
                        let mut v = [0.0f32; 3];
                        let k = load_ctx(id, frame, led, graph, dist, &mut v);
                        for x in v.iter().take(k) {
                            push!(*x);
                        }
                    }
                }
            }
            Op::Add | Op::Sub | Op::Mul | Op::Div => {
                let n = cb!(pc) as usize;
                pc += 1;
                // stack: a(n) b(n) ; result a op b
                let base = sub!(2 * n);
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
            Op::BinTop => {
                let mode = cb!(pc);
                let i = rd16!(pc + 1) as usize;
                pc += 3;
                if sp == 0 {
                    fault!();
                }
                let b = bin_src(mode >> 2, i, prog, uniforms, state, locals);
                stack[sp - 1] = bin_arith(mode, stack[sp - 1], b);
            }
            Op::BinPair => {
                let mode = cb!(pc);
                let ia = rd16!(pc + 1) as usize;
                let ib = rd16!(pc + 3) as usize;
                pc += 5;
                let a = bin_src(mode >> 2, ia, prog, uniforms, state, locals);
                let b = bin_src(mode >> 4, ib, prog, uniforms, state, locals);
                push!(bin_arith(mode, a, b));
            }
            Op::PushConsts => {
                let n = cb!(pc) as usize;
                for j in 0..n {
                    push!(prog.const_f32(rd16!(pc + 1 + 2 * j) as usize));
                }
                pc += 1 + 2 * n;
            }
            Op::LoadCtxLanes => {
                let id = cb!(pc);
                let src = cb!(pc + 1) as usize;
                let k0 = cb!(pc + 2) as usize;
                let m = cb!(pc + 3) as usize;
                pc += 4;
                let mut v = [0.0f32; 3];
                let k = load_ctx(id, frame, led, graph, dist, &mut v);
                // As if the k context values were pushed and then swizzled: lane
                // `ci` of the swizzle window [top - src, top) reads either the
                // stack below the context values or the values themselves.
                let top = (sp + k).min(MAX_STACK);
                let base = match top.checked_sub(src) {
                    Some(b) => b,
                    None => fault!(),
                };
                if m > 4 || base + m > MAX_STACK {
                    fault!();
                }
                let mut tmp = [0.0f32; 4];
                for (j, t) in tmp.iter_mut().enumerate().take(m) {
                    let at = base + k0 + j;
                    *t = if at >= sp { *v.get(at - sp).unwrap_or(&0.0) } else { stack[at] };
                }
                for (j, t) in tmp.iter().enumerate().take(m) {
                    stack[base + j] = *t;
                }
                sp = base + m;
            }
            Op::MulAdd => {
                let n = cb!(pc) as usize;
                pc += 1;
                let base = sub!(3 * n);
                for i in 0..n {
                    let bc = stack[base + n + i] * stack[base + 2 * n + i];
                    stack[base + i] = stack[base + i] + bc;
                }
                sp = base + n;
            }
            Op::Neg => {
                let n = cb!(pc) as usize;
                pc += 1;
                let base = sub!(n);
                for i in 0..n {
                    stack[base + i] = -stack[base + i];
                }
            }
            Op::Scale => {
                let n = cb!(pc) as usize;
                pc += 1;
                let s = pop!();
                let base = sub!(n);
                for i in 0..n {
                    stack[base + i] *= s;
                }
            }
            Op::UnMath => {
                let f = cb!(pc);
                let n = cb!(pc + 1) as usize;
                pc += 2;
                let base = sub!(n);
                for i in 0..n {
                    let x = stack[base + i];
                    stack[base + i] = un_math(f, x);
                }
            }
            Op::BinMath => {
                let f = cb!(pc);
                let n = cb!(pc + 1) as usize;
                pc += 2;
                let base = sub!(2 * n);
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = bin_math(f, a, b);
                }
                sp = base + n;
            }
            Op::Clamp => {
                let n = cb!(pc) as usize;
                pc += 1;
                let base = sub!(3 * n);
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
                let n = cb!(pc) as usize;
                pc += 1;
                let t = pop!(); // scalar t
                let base = sub!(2 * n);
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = a + (b - a) * t;
                }
                sp = base + n;
            }
            Op::Smoothstep => {
                let n = cb!(pc) as usize;
                pc += 1;
                let base = sub!(3 * n);
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
                let n = cb!(pc) as usize;
                pc += 1;
                let base = sub!(2 * n);
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + n + i];
                }
                sp = base;
                push!(acc);
            }
            Op::Cross => {
                pc += 1; // n operand (always 3), ignore
                let base = sub!(6);
                let a = [stack[base], stack[base + 1], stack[base + 2]];
                let b = [stack[base + 3], stack[base + 4], stack[base + 5]];
                stack[base] = a[1] * b[2] - a[2] * b[1];
                stack[base + 1] = a[2] * b[0] - a[0] * b[2];
                stack[base + 2] = a[0] * b[1] - a[1] * b[0];
                sp = base + 3;
            }
            Op::Length => {
                let n = cb!(pc) as usize;
                pc += 1;
                let base = sub!(n);
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + i];
                }
                sp = base;
                push!(sqrtf(acc));
            }
            Op::Distance => {
                let n = cb!(pc) as usize;
                pc += 1;
                let base = sub!(2 * n);
                let mut acc = 0.0;
                for i in 0..n {
                    let d = stack[base + i] - stack[base + n + i];
                    acc += d * d;
                }
                sp = base;
                push!(sqrtf(acc));
            }
            Op::Normalize => {
                let n = cb!(pc) as usize;
                pc += 1;
                let base = sub!(n);
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
                let src_n = cb!(pc) as usize;
                let dst_n = cb!(pc + 1) as usize;
                pc += 2;
                let mut tmp = [0.0f32; 4];
                let base = sub!(src_n);
                if dst_n > 4 || base + dst_n > MAX_STACK {
                    fault!();
                }
                for i in 0..dst_n {
                    let ci = cb!(pc + i) as usize;
                    tmp[i] = *stack.get(base + ci).unwrap_or(&0.0);
                }
                pc += dst_n;
                // Keep the scalar loop: this is a perf-golden hot path (fx_bench)
                // and the manual copy compiles to a stable instruction sequence.
                #[allow(clippy::manual_memcpy)]
                for i in 0..dst_n {
                    stack[base + i] = tmp[i];
                }
                sp = base + dst_n;
            }
            Op::Cmp => {
                let kind = cb!(pc);
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
                let kind = cb!(pc);
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
                let rel = rd16!(pc) as i16;
                pc += 2;
                let c = pop!();
                if c == 0.0 {
                    if rel < 0 {
                        poll_deadline!();
                    }
                    pc = (pc as isize + rel as isize) as usize;
                }
            }
            Op::Jmp => {
                let rel = rd16!(pc) as i16;
                pc += 2;
                if rel < 0 {
                    poll_deadline!();
                }
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
                let id = cb!(pc);
                pc += 1;
                let t = pop!();
                let (r, g, b) = palette(id, t);
                push!(r);
                push!(g);
                push!(b);
            }
            Op::Pop => {
                let n = cb!(pc) as usize;
                pc += 1;
                sp = sp.saturating_sub(n);
            }
            Op::Ret => {
                let n = cb!(pc) as usize;
                let mut out = [0.0f32; 3];
                let base = sp.saturating_sub(n);
                // Perf-golden hot path (fx_bench): keep the scalar copy.
                #[allow(clippy::manual_memcpy)]
                for i in 0..n.min(3) {
                    out[i] = stack[base + i];
                }
                if sp > sp_max {
                    sp_max = sp;
                }
                return (out, None, Outcome::Ok, Counters { instrs: guard.instructions - budget, stack_max: sp_max as u16 });
            }
            Op::Swap => {
                let an = cb!(pc) as usize;
                let bn = cb!(pc + 1) as usize;
                pc += 2;
                // stack: [.. a(an) b(bn)] -> [.. b(bn) a(an)]
                let base = sub!(an + bn);
                if an > 8 {
                    fault!();
                }
                let mut tmp = [0.0f32; 8];
                // Perf-golden hot path (fx_bench): keep the scalar shuffle so the
                // emitted code (and its cycle count) matches the benchmark golden.
                #[allow(clippy::manual_memcpy)]
                for i in 0..an {
                    tmp[i] = stack[base + i];
                }
                for i in 0..bn {
                    stack[base + i] = stack[base + an + i];
                }
                #[allow(clippy::manual_memcpy)]
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
                let kind = cb!(pc);
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
                pushi!(f2i(a));
            }
            Op::Fix2F => {
                let a = popi!();
                push!(fix_to_f32(a, 16));
            }
            Op::F2Fix => {
                let a = pop!();
                pushi!(f32_to_fix(a, 16));
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
                let target = rd16!(pc) as usize;
                pc += 2;
                poll_deadline!();
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
                let base = cb!(pc) as usize;
                let stride = cb!(pc + 1) as usize;
                let off = cb!(pc + 2) as usize;
                let n = cb!(pc + 3) as usize;
                let count = cb!(pc + 4) as usize;
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
                let base = cb!(pc) as usize;
                let stride = cb!(pc + 1) as usize;
                let off = cb!(pc + 2) as usize;
                let n = cb!(pc + 3) as usize;
                let count = cb!(pc + 4) as usize;
                pc += 5;
                // Perf-golden hot path (fx_bench): keep the literal guard form.
                #[allow(clippy::int_plus_one)]
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
                let kind = cb!(pc);
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
                let id = cb!(pc) as usize;
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
                let id = cb!(pc) as usize;
                pc += 1;
                if let Some(d) = prog.buf_desc(id) {
                    let lc = frame.led_count as usize;
                    let elem = d.elem as usize;
                    let cb = comp_bytes(d.comp);
                    let count = if d.kind == 0 { lc } else { d.w as usize * d.h as usize };
                    // Perf-golden hot path (fx_bench): keep the literal guard form.
                    #[allow(clippy::int_plus_one)]
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
                let id = cb!(pc) as usize;
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
                let id = cb!(pc) as usize;
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
                let frac = frac!(cb!(pc));
                pc += 1;
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(((a * b) >> frac) as i32);
            }
            Op::DivFixN => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(if b == 0 { 0 } else { a.wrapping_shl(frac).wrapping_div(b) as i32 });
            }
            Op::FixRescale => {
                let sh = cb!(pc) as i8;
                pc += 1;
                let a = popi!();
                pushi!(if sh >= 0 { a.wrapping_shl(sh as u32) } else { a.wrapping_shr((-(sh as i32)) as u32) });
            }
            Op::FixToF => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let a = popi!();
                push!(fix_to_f32(a, frac & 31));
            }
            Op::FixFromF => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let a = pop!();
                pushi!(f32_to_fix(a, frac & 31));
            }
            Op::SinFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let a = popi!();
                pushi!(sin_fix(a, frac));
            }
            Op::CosFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let a = popi!();
                // cos(t) = sin(t + quarter turn); one turn = 1<<frac.
                pushi!(sin_fix(a.wrapping_add(1i32.wrapping_shl(frac.wrapping_sub(2))), frac));
            }
            Op::ExpFix => {
                let frac = frac!(cb!(pc));
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
                let frac = frac!(cb!(pc));
                pc += 1;
                let x = popi!();
                let one = 1i32 << frac;
                // Perf-golden hot path (fx_bench): keep the explicit if-chain so
                // the emitted branch sequence matches the benchmark golden (a
                // `match x.cmp(&0)` rewrite drifts one effect off its golden).
                #[allow(clippy::comparison_chain)]
                let signed = if x > 0 {
                    one
                } else if x < 0 {
                    -one
                } else {
                    0
                };
                pushi!(signed);
            }
            Op::StepI => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let x = popi!(); // second arg (top)
                let edge = popi!(); // first arg
                pushi!(if x >= edge { 1i32 << frac } else { 0 });
            }
            Op::FloorFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let x = popi!();
                pushi!((x >> frac) << frac); // arithmetic shift rounds toward -inf
            }
            Op::CeilFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let x = popi!();
                let fl = (x >> frac) << frac;
                pushi!(if fl != x { fl.wrapping_add(1i32 << frac) } else { fl });
            }
            Op::FractFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let x = popi!();
                pushi!(x & ((1i32 << frac) - 1)); // frac 0 -> mask 0 -> 0
            }
            Op::MixFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let t = popi!() as i64;
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(a.wrapping_add((b - a).wrapping_mul(t) >> frac) as i32);
            }
            // --- FUG-122: fixed/int variants of the vector, transcendental,
            // colour and I/O opcodes (complete the native-datatype ISA). All read
            // and write the raw scaled integer in the slot word — no soft-float.
            Op::SqrtFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let a = popi!();
                pushi!(sqrt_fix(a, frac));
            }
            Op::ScaleFix => {
                let frac = frac!(cb!(pc));
                let n = cb!(pc + 1) as usize;
                pc += 2;
                let s = popi!() as i64;
                let base = sub!(n);
                for i in 0..n {
                    let a = stack[base + i].to_bits() as i32 as i64;
                    stack[base + i] = f32::from_bits((a.wrapping_mul(s).wrapping_shr(frac) as i32) as u32);
                }
            }
            Op::DotFix => {
                let frac = frac!(cb!(pc));
                let n = cb!(pc + 1) as usize;
                pc += 2;
                let base = sub!(2 * n);
                let mut acc: i64 = 0;
                for i in 0..n {
                    let a = stack[base + i].to_bits() as i32 as i64;
                    let b = stack[base + n + i].to_bits() as i32 as i64;
                    acc = acc.wrapping_add(a.wrapping_mul(b) >> frac);
                }
                sp = base;
                pushi!(acc as i32);
            }
            Op::LengthFix => {
                let frac = frac!(cb!(pc));
                let n = cb!(pc + 1) as usize;
                pc += 2;
                let base = sub!(n);
                let mut acc: i64 = 0;
                for i in 0..n {
                    let a = stack[base + i].to_bits() as i32 as i64;
                    acc = acc.wrapping_add(a.wrapping_mul(a) >> frac);
                }
                sp = base;
                pushi!(sqrt_fix_i64(acc, frac) as i32);
            }
            Op::DistanceFix => {
                let frac = frac!(cb!(pc));
                let n = cb!(pc + 1) as usize;
                pc += 2;
                let base = sub!(2 * n);
                let mut acc: i64 = 0;
                for i in 0..n {
                    let d = (stack[base + i].to_bits() as i32 as i64)
                        - (stack[base + n + i].to_bits() as i32 as i64);
                    acc = acc.wrapping_add(d.wrapping_mul(d) >> frac);
                }
                sp = base;
                pushi!(sqrt_fix_i64(acc, frac) as i32);
            }
            Op::NormalizeFix => {
                let frac = frac!(cb!(pc));
                let n = cb!(pc + 1) as usize;
                pc += 2;
                let base = sub!(n);
                let mut acc: i64 = 0;
                for i in 0..n {
                    let a = stack[base + i].to_bits() as i32 as i64;
                    acc = acc.wrapping_add(a.wrapping_mul(a) >> frac);
                }
                let len = sqrt_fix_i64(acc, frac);
                if len > 0 {
                    for i in 0..n {
                        let a = stack[base + i].to_bits() as i32 as i64;
                        let v = (a.wrapping_shl(frac) / len) as i32;
                        stack[base + i] = f32::from_bits(v as u32);
                    }
                }
            }
            Op::CrossFix => {
                let frac = frac!(cb!(pc));
                pc += 1; // n operand (always 3), folded into the fixed math below
                let base = sub!(6);
                let a = [
                    stack[base].to_bits() as i32 as i64,
                    stack[base + 1].to_bits() as i32 as i64,
                    stack[base + 2].to_bits() as i32 as i64,
                ];
                let b = [
                    stack[base + 3].to_bits() as i32 as i64,
                    stack[base + 4].to_bits() as i32 as i64,
                    stack[base + 5].to_bits() as i32 as i64,
                ];
                let cx = ((a[1] * b[2]).wrapping_sub(a[2] * b[1]) >> frac) as i32;
                let cy = ((a[2] * b[0]).wrapping_sub(a[0] * b[2]) >> frac) as i32;
                let cz = ((a[0] * b[1]).wrapping_sub(a[1] * b[0]) >> frac) as i32;
                stack[base] = f32::from_bits(cx as u32);
                stack[base + 1] = f32::from_bits(cy as u32);
                stack[base + 2] = f32::from_bits(cz as u32);
                sp = base + 3;
            }
            Op::SmoothstepFix => {
                let frac = frac!(cb!(pc));
                let n = cb!(pc + 1) as usize;
                pc += 2;
                let one = 1i64 << frac;
                let base = sub!(3 * n);
                for i in 0..n {
                    let e0 = stack[base + i].to_bits() as i32 as i64;
                    let e1 = stack[base + n + i].to_bits() as i32 as i64;
                    let x = stack[base + 2 * n + i].to_bits() as i32 as i64;
                    let t = if e1 == e0 {
                        0
                    } else {
                        (x - e0).wrapping_shl(frac).wrapping_div(e1 - e0).clamp(0, one)
                    };
                    let t2 = t.wrapping_mul(t) >> frac;
                    let val = t2.wrapping_mul(3 * one - 2 * t) >> frac; // t²(3−2t)
                    stack[base + i] = f32::from_bits((val as i32) as u32);
                }
                sp = base + n;
            }
            Op::ClampVFix => {
                let n = cb!(pc) as usize;
                pc += 1;
                let base = sub!(3 * n);
                for i in 0..n {
                    let x = stack[base + i].to_bits() as i32;
                    let lo = stack[base + n + i].to_bits() as i32;
                    let hi = stack[base + 2 * n + i].to_bits() as i32;
                    let v = if x < lo {
                        lo
                    } else if x > hi {
                        hi
                    } else {
                        x
                    };
                    stack[base + i] = f32::from_bits(v as u32);
                }
                sp = base + n;
            }
            Op::MixVFix => {
                let frac = frac!(cb!(pc));
                let n = cb!(pc + 1) as usize;
                pc += 2;
                let t = popi!() as i64;
                let base = sub!(2 * n);
                for i in 0..n {
                    let a = stack[base + i].to_bits() as i32 as i64;
                    let b = stack[base + n + i].to_bits() as i32 as i64;
                    let v = a.wrapping_add((b - a).wrapping_mul(t) >> frac) as i32;
                    stack[base + i] = f32::from_bits(v as u32);
                }
                sp = base + n;
            }
            Op::Hsv2RgbFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let v = popi!();
                let s = popi!();
                let h = popi!();
                let (r, g, b) = hsv2rgb_fix(h, s, v, frac);
                pushi!(r);
                pushi!(g);
                pushi!(b);
            }
            Op::PaletteFix => {
                let id = cb!(pc);
                let frac = frac!(cb!(pc + 1));
                pc += 2;
                let t = popi!();
                let (r, g, b) = palette_fix(id, t, frac);
                pushi!(r);
                pushi!(g);
                pushi!(b);
            }
            Op::Atan2Fix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let x = popi!();
                let y = popi!();
                pushi!(atan2_fix(y, x, frac));
            }
            Op::LogFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let a = popi!();
                pushi!(log_fix(a, frac));
            }
            Op::TanFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let a = popi!();
                pushi!(tan_fix(a, frac));
            }
            Op::PowFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let b = popi!();
                let a = popi!();
                pushi!(pow_fix(a, b, frac));
            }
            Op::HashFix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let x = pop!().to_bits();
                pushi!(hash_fix(x, frac));
            }
            Op::Hash3Fix => {
                let frac = frac!(cb!(pc));
                pc += 1;
                let z = pop!().to_bits();
                let y = pop!().to_bits();
                let x = pop!().to_bits();
                pushi!(hash3_fix(x, y, z, frac));
            }
            Op::RetRgb8 => {
                // top 3 slots are int channels 0..255 — emit RGB, no soft-float.
                let base = sp.saturating_sub(3);
                let ch = |v: i32| v.clamp(0, 255) as u8;
                let r = ch(stack[base].to_bits() as i32);
                let g = ch(stack.get(base + 1).map(|s| s.to_bits() as i32).unwrap_or(0));
                let b = ch(stack.get(base + 2).map(|s| s.to_bits() as i32).unwrap_or(0));
                if sp > sp_max {
                    sp_max = sp;
                }
                return (
                    [0.0; 3],
                    Some((r, g, b)),
                    Outcome::Ok,
                    Counters { instrs: guard.instructions - budget, stack_max: sp_max as u16 },
                );
            }
            Op::RetRgbFix => {
                let frac = frac!(cb!(pc));
                // (returns immediately; no pc advance needed for the frac operand)
                // top 3 slots are Q1.frac channels in [0,1] — scale to 0..255 in
                // integer ((v*255)>>frac), no clamp01()*255 soft-float.
                let base = sp.saturating_sub(3);
                let to8 = |v: i64| (v.wrapping_mul(255) >> frac).clamp(0, 255) as u8;
                let r = to8(stack[base].to_bits() as i32 as i64);
                let g = to8(stack.get(base + 1).map(|s| s.to_bits() as i32 as i64).unwrap_or(0));
                let b = to8(stack.get(base + 2).map(|s| s.to_bits() as i32 as i64).unwrap_or(0));
                if sp > sp_max {
                    sp_max = sp;
                }
                return (
                    [0.0; 3],
                    Some((r, g, b)),
                    Outcome::Ok,
                    Counters { instrs: guard.instructions - budget, stack_max: sp_max as u16 },
                );
            }
            Op::LoadCtxFix => {
                let id = cb!(pc);
                let comp = cb!(pc + 1) as usize;
                let frac = frac!(cb!(pc + 2));
                pc += 3;
                // Canonical cache form is Q16.16 for continuous quantities, raw
                // int (frac 0) for counters/indices; rescale to the shader's frac.
                let (raw, canon): (i32, u32) = match id {
                    C_TIME => (frame.time_fix, CTX_FIX_FRAC),
                    C_DT => (frame.dt_fix, CTX_FIX_FRAC),
                    C_FRAME => (frame.frame as i32, 0),
                    C_LED_POS => (led.pos_fix[comp.min(2)], CTX_FIX_FRAC),
                    C_LED_IDX => (led.idx as i32, 0),
                    C_LED_COUNT => (frame.led_count as i32, 0),
                    C_LED_SEG => (led.seg, 0),
                    C_LED_S => (led.s_fix, CTX_FIX_FRAC),
                    C_LED_BRANCH => (if led.branch { 1 } else { 0 }, 0),
                    C_IMU_ACCEL => (frame.imu_accel_fix[comp.min(2)], CTX_FIX_FRAC),
                    C_IMU_GYRO => (frame.imu_gyro_fix[comp.min(2)], CTX_FIX_FRAC),
                    C_LED_DIST => (led.dist_fix, CTX_FIX_FRAC),
                    C_LED_UV => (led.uv_fix[comp.min(1)], CTX_FIX_FRAC),
                    C_LED_ROOM if frame.room_posed => (led.room_fix[comp.min(2)], CTX_FIX_FRAC),
                    C_LED_ROOM => (led.pos_fix[comp.min(2)], CTX_FIX_FRAC),
                    C_ROOM_MIN => (frame.room_min_fix[comp.min(2)], CTX_FIX_FRAC),
                    C_ROOM_MAX => (frame.room_max_fix[comp.min(2)], CTX_FIX_FRAC),
                    _ => (0, 0),
                };
                let sh = frac as i32 - canon as i32;
                let v = if sh >= 0 {
                    raw.wrapping_shl(sh as u32)
                } else {
                    raw.wrapping_shr((-sh) as u32)
                };
                pushi!(v);
            }
            Op::FillLocal => {
                let slot = cb!(pc) as usize;
                let n = cb!(pc + 1) as usize;
                pc += 2;
                for i in 0..n {
                    if slot + i < MAX_LOCALS {
                        locals[slot + i] = 0.0;
                    }
                }
            }
            // --- FUG-125 superinstructions ---------------------------------
            Op::TeeLocal => {
                // StoreLocal slot,n ; LoadLocal slot,n : write the top n stack
                // slots to local[slot..] but leave them on the stack.
                let slot = cb!(pc) as usize;
                let n = cb!(pc + 1) as usize;
                pc += 2;
                for i in 0..n {
                    if slot + i < MAX_LOCALS && sp >= n {
                        locals[slot + i] = stack[sp - n + i];
                    }
                }
            }
            Op::IncLocalI => {
                // LoadLocal s,1 ; PushConst k ; AddI ; StoreLocal s,1 : the
                // integer compound-add idiom `i = i + k` (loop counters, indices).
                let slot = cb!(pc) as usize;
                let idx = rd16!(pc + 1) as usize;
                pc += 3;
                let k = prog.const_f32(idx).to_bits() as i32;
                if slot < MAX_LOCALS {
                    let cur = locals[slot].to_bits() as i32;
                    locals[slot] = f32::from_bits(cur.wrapping_add(k) as u32);
                }
            }
            Op::BrCmpI => {
                // CmpI kind ; BrFalse rel : compare two ints and branch when the
                // comparison is FALSE (BrFalse branched on the 0 that CmpI pushed).
                let kind = cb!(pc);
                let rel = rd16!(pc + 1) as i16;
                pc += 3;
                let b = popi!();
                let a = popi!();
                let t = match kind {
                    0 => a < b,
                    1 => a <= b,
                    2 => a > b,
                    3 => a >= b,
                    4 => a == b,
                    _ => a != b,
                };
                if !t {
                    if rel < 0 {
                        poll_deadline!();
                    }
                    pc = (pc as isize + rel as isize) as usize;
                }
            }
            Op::JitCall => {
                // Dispatch to the firmware-compiled native segment for this hot
                // block: a0 = &stack[sp] (the segment's entry top-of-stack, so it
                // reaches live operands at negative offsets), a1 = locals base,
                // a2 = the aligned const pool. Then apply the block's net stack
                // delta and resume interpreting at its end. Ints ride bit-for-bit
                // in the f32 slots, so the i32 view is exact.
                let idx = rd16!(pc) as usize;
                pc += 2;
                // SAFETY: the firmware installed this table via `set_jit` and keeps
                // both the descriptors and the executable code alive for the
                // effect; `func` has the documented ABI. The slot arrays are 4-byte
                // aligned (`[f32; N]`), so the i32 reinterpret is aligned.
                if idx < jit_len {
                    let blk = unsafe { &*jit_blocks.add(idx) };
                    unsafe {
                        (blk.func)(
                            stack.as_mut_ptr().add(sp) as *mut i32,
                            locals.as_mut_ptr() as *mut i32,
                            jit_consts,
                            state.as_mut_ptr() as *mut i32,
                        );
                    }
                    let nsp = sp as isize + blk.net_delta as isize;
                    if nsp < 0 || nsp as usize > MAX_STACK {
                        fault!();
                    }
                    sp = nsp as usize;
                    pc = blk.end as usize;
                }
            }
            // FUG-107 I2C intrinsics: inert unless run_poll installed a bus.
            Op::I2cWrite => {
                let val = popi!();
                let reg = popi!();
                let addr = popi!();
                // SAFETY: POLL_BUS is set only inside run_poll, which outlives this.
                let ok = match unsafe { POLL_BUS } {
                    Some(bus) => unsafe { (*bus).write(addr as u8, &[reg as u8, val as u8]) },
                    None => false,
                };
                pushi!(ok as i32);
            }
            Op::I2cRead => {
                let mode = cb!(pc);
                pc += 1;
                let n = ((mode & 3) as usize).clamp(1, 2);
                let reg = popi!();
                let addr = popi!();
                let mut buf = [0u8; 2];
                let ok = match unsafe { POLL_BUS } {
                    Some(bus) => unsafe { (*bus).read_reg(addr as u8, reg as u8, &mut buf[..n]) },
                    None => false,
                };
                pushi!(if !ok {
                    -1
                } else if n == 1 {
                    buf[0] as i32
                } else if mode & 0x80 != 0 {
                    i16::from_be_bytes([buf[0], buf[1]]) as i32
                } else {
                    u16::from_be_bytes([buf[0], buf[1]]) as i32
                });
            }
            // Out-of-line helpers reading the invocation's cache from a static:
            // anything more (a `run()` argument, a GraphRef field, a combined
            // arm) measurably raised register pressure across the whole dispatch
            // loop — fx_bench +3..7% on EVERY program, cached or not.
            Op::LoadLedCache => {
                let slot = cb!(pc) as usize;
                let n = cb!(pc + 1) as usize;
                let rel = rd16!(pc + 2) as i16;
                pc += 4;
                if let Some(nsp) = memo_load(led.idx, slot, n, stack, sp) {
                    sp = nsp;
                    pc = (pc as isize + rel as isize) as usize;
                }
            }
            Op::StoreLedCache => {
                let slot = cb!(pc) as usize;
                let n = cb!(pc + 1) as usize;
                pc += 2;
                memo_store(led.idx, slot, n, stack, sp);
            }
        }
    }
    ([0.0, 0.0, 0.0], None, outcome, Counters { instrs: guard.instructions - budget, stack_max: sp_max as u16 })
}

/// Operand source of a `BinTop`/`BinPair` (mode bits): the same reads as
/// `PushConst` / `LoadLocal` / `LoadState` / `LoadUniform` (out of range = 0.0).
#[inline(always)]
fn bin_src(src: u8, i: usize, prog: &Program, uniforms: &[f32], state: &[f32], locals: &[f32]) -> f32 {
    match src & 3 {
        0 => prog.const_f32(i),
        1 => *locals.get(i).unwrap_or(&0.0),
        2 => *state.get(i).unwrap_or(&0.0),
        _ => *uniforms.get(i).unwrap_or(&0.0),
    }
}

/// The scalar float `Add`/`Sub`/`Mul`/`Div` (div by zero = 0.0), or with mode
/// bit 6 the integer `AddI`/`SubI`/`MulI`/`MulFix`, exactly as in `run()`.
#[inline(always)]
fn bin_arith(mode: u8, a: f32, b: f32) -> f32 {
    if mode & 0x40 != 0 {
        let (x, y) = (a.to_bits() as i32, b.to_bits() as i32);
        let r = match mode & 3 {
            0 => x.wrapping_add(y),
            1 => x.wrapping_sub(y),
            2 => x.wrapping_mul(y),
            _ => ((x as i64 * y as i64) >> 16) as i32,
        };
        return f32::from_bits(r as u32);
    }
    match mode & 3 {
        0 => a + b,
        1 => a - b,
        2 => a * b,
        _ => {
            if b == 0.0 {
                0.0
            } else {
                a / b
            }
        }
    }
}

// --- soft-float helpers (no libm dependency; small polynomial approximations
// good enough for LED effects, deterministic on host + wasm + device) ---------

pub fn sqrtf(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    // Newton from a bit-twiddle seed.
    let mut y = f32::from_bits(0x5f37_59dfu32.wrapping_sub(x.to_bits() >> 1));
    y = y * (1.5 - 0.5 * x * y * y);
    y = y * (1.5 - 0.5 * x * y * y);
    x * y // x * rsqrt(x) = sqrt(x)
}

/// `x as i32` (truncate toward zero, saturating, NaN to 0) in integer ops,
/// instead of the soft `__fixsfsi` (~110 cycles on the C6).
#[inline]
fn f2i(x: f32) -> i32 {
    f32_to_fix(x, 0)
}

/// Floor, bit-exact with the original `t = x as i32 as f32; if t > x { t - 1 }`
/// (including its saturation at ±2^31 and NaN -> 0), but the truncation is a
/// mantissa mask instead of two soft conversions and a soft compare. Only a
/// negative non-integer still pays the soft `t - 1.0`.
pub fn floorf(x: f32) -> f32 {
    let b = x.to_bits();
    let e = ((b >> 23) & 0xff) as i32 - 127;
    let neg = (b as i32) < 0;
    if e >= 31 {
        if b & 0x7fff_ffff > 0x7f80_0000 {
            return 0.0; // NaN
        }
        return if neg { -2_147_483_648.0 } else { 2_147_483_648.0 };
    }
    let (t, frac) = if e < 0 {
        (0.0f32, b & 0x7fff_ffff != 0) // |x| < 1 truncates to +0.0
    } else if e >= 23 {
        (x, false)
    } else {
        let m = 0x007f_ffffu32 >> e;
        (f32::from_bits(b & !m), b & m != 0)
    };
    if neg && frac {
        t - 1.0
    } else {
        t
    }
}
pub fn fractf(x: f32) -> f32 {
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
    let phase = f32_wrap_u32(x * SIN_PHASE_SCALE);
    let idx = (phase >> 24) as usize; // 0..=255
    let frac = u24_unit(phase & 0x00ff_ffff);
    let a = SINF_LUT[idx];
    let b = SINF_LUT[idx + 1]; // idx+1 ≤ 256; the wrap entry avoids a branch
    a + (b - a) * frac
}

/// `v as i64 as u32` (truncate, saturate to i64, keep the low 32 bits) in
/// integer ops; the soft `__fixsfdi` it replaces costs more than the sine.
#[inline]
fn f32_wrap_u32(v: f32) -> u32 {
    let b = v.to_bits();
    let neg = (b as i32) < 0;
    let e = ((b >> 23) & 0xff) as i32 - 127;
    if e >= 63 {
        if b & 0x7fff_ffff > 0x7f80_0000 {
            return 0; // NaN
        }
        return if neg { 0 } else { u32::MAX }; // i64::MIN / i64::MAX, low word
    }
    if e < 0 {
        return 0;
    }
    let m = (b & 0x007f_ffff) | 0x0080_0000;
    let sh = e - 23;
    let mag = if sh >= 32 {
        0
    } else if sh >= 0 {
        m << sh
    } else {
        m >> -sh
    };
    if neg {
        mag.wrapping_neg()
    } else {
        mag
    }
}

/// `f as f32 * 2^-24` for a 24-bit `f`, exact, built from the bits instead of
/// a soft int-to-float conversion and a soft multiply.
#[inline]
fn u24_unit(f: u32) -> f32 {
    if f == 0 {
        return 0.0;
    }
    let lz = f.leading_zeros(); // 8..=31
    let p = 31 - lz; // the leading bit
    f32::from_bits(((p + 103) << 23) | ((f << (23 - p)) & 0x007f_ffff))
}

pub fn cosf(x: f32) -> f32 {
    sinf(x + PI * 0.5)
}
pub fn expf(x: f32) -> f32 {
    // 2^(x/ln2) via bit manipulation + poly (adequate for decay curves).
    let xln = x * core::f32::consts::LOG2_E; // x / ln2
    let i = floorf(xln);
    let f = xln - i;
    // 2^f on [0, 1): a minimax cubic (max relative error 8.6e-5). The Taylor
    // cubic it replaces reached 1.9888 at f -> 1, a 0.56% jump at every integer.
    let poly = 1.0 + f * (0.695_113_5 + f * (0.227_659_75 + f * 0.077_053_55));
    let bits = (f2i(i).wrapping_add(127) as u32) << 23;
    f32::from_bits(bits) * poly
}
pub fn logf(x: f32) -> f32 {
    if x <= 0.0 {
        return -87.0;
    }
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    // ln x = (e + log2 m) * ln 2 for x = m * 2^e, m in [1, 2), with log2(1 + t)
    // on t = m - 1 in [0, 1) as a degree-5 polynomial through 0 (max error
    // 1.5e-5). The old version added a log2-shaped polynomial straight to
    // e * ln 2 without scaling it by ln 2, so it was off by up to 0.13 (ln 1.5
    // came out 0.276, not 0.405) and pow(x, 8) = exp(8 ln x) by up to 2.8x
    // (docs/design/fx-perf-study.md).
    // t is exactly mantissa * 2^-23 and e is a small integer, so both are built
    // from the bits (bit-identical to `m - 1.0` and `e as f32`) instead of a
    // soft subtract and a soft int-to-float conversion.
    let t = u24_unit((bits & 0x007f_ffff) << 1);
    let p = t * (1.441_966_3 + t * (-0.709_670_9 + t * (0.417_625_8 + t * (-0.196_311_97 + t * 0.046_405_36))));
    (small_i2f(e) + p) * core::f32::consts::LN_2
}

/// `v as f32` for `|v| < 2^24` (exact there), in integer ops instead of the
/// soft `__floatsisf`.
#[inline]
fn small_i2f(v: i32) -> f32 {
    if v == 0 {
        return 0.0;
    }
    let a = v.unsigned_abs();
    let p = 31 - a.leading_zeros(); // the leading bit, <= 23
    let sign = (v as u32) & 0x8000_0000;
    f32::from_bits(sign | ((p + 127) << 23) | ((a << (23 - p)) & 0x007f_ffff))
}
pub fn powf(a: f32, b: f32) -> f32 {
    if a <= 0.0 {
        return 0.0;
    }
    expf(b * logf(a))
}
pub fn tanf(x: f32) -> f32 {
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
pub fn atan2f(y: f32, x: f32) -> f32 {
    // crude atan2 adequate for effects (angles for radial patterns).
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    let ax = x.abs();
    let ay = y.abs();
    let a = if ax >= ay { ay / ax } else { ax / ay };
    let s = a * a;
    let mut r = ((-0.046496475 * s + 0.15931422) * s - 0.327_622_77) * s * a + a;
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
pub fn mix32(mut h: u32) -> u32 {
    h ^= h >> 16;
    h = h.wrapping_mul(0x7feb_352d);
    h ^= h >> 15;
    h = h.wrapping_mul(0x846c_a68b);
    h ^= h >> 16;
    h
}

/// Map a mixed 32-bit hash to a float in [0, 1) (top 24 bits → an exact f32).
#[inline]
pub fn unit_from_hash(h: u32) -> f32 {
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

pub fn hsv2rgb(h: f32, s: f32, v: f32) -> (f32, f32, f32) {
    let h6 = fractf(h) * 6.0;
    let c = v * s;
    let x = c * (1.0 - (fractf(h6 * 0.5) * 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = match f2i(h6) {
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
pub fn sin_fix(raw: i32, frac: u32) -> i32 {
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
pub fn exp_fix(raw: i32, frac: u32) -> i32 {
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

// --- FUG-122: fixed/int helpers for the remaining opcodes ---------------------
// All strictly integer arithmetic (i32/i64), no soft-float, deterministic across
// host/wasm/device. `frac` is the Q1.frac fraction width (0 = int).

/// `cos(turns)` in Q1.`frac`: sin shifted a quarter turn (matches the CosFix op).
#[inline]
pub fn cos_fix(raw: i32, frac: u32) -> i32 {
    sin_fix(raw.wrapping_add(1 << (frac.saturating_sub(2))), frac)
}

/// Integer square root of a non-negative i64 (floor). Newton's method seeded from
/// the bit length; converges in a few iterations, all integer.
#[inline]
fn isqrt_i64(v: i64) -> i64 {
    if v <= 0 {
        return 0;
    }
    let mut x = 1i64 << ((64 - v.leading_zeros() as i64 + 1) / 2); // ~2^(ceil(bits/2))
    // A handful of Newton steps; guard the divide.
    for _ in 0..8 {
        let nx = (x + v / x) >> 1;
        if nx >= x {
            break;
        }
        x = nx;
    }
    // x is now floor(sqrt) or one above; correct down.
    while x * x > v {
        x -= 1;
    }
    x
}

/// `sqrt(x)` in Q1.`frac` for an i64 operand (used by the vector length ops,
/// whose sum-of-squares can exceed i32). `sqrt(x)·2^frac = sqrt(raw·2^frac)`.
fn sqrt_fix_i64(raw: i64, frac: u32) -> i64 {
    if raw <= 0 {
        return 0;
    }
    isqrt_i64(raw << frac)
}

/// `sqrt(x)` in Q1.`frac` for a scalar slot word.
pub fn sqrt_fix(raw: i32, frac: u32) -> i32 {
    sqrt_fix_i64(raw as i64, frac) as i32
}

/// `tan(turns)` in Q1.`frac` = sin/cos. Guards a near-zero cosine (returns 0).
fn tan_fix(raw: i32, frac: u32) -> i32 {
    let c = cos_fix(raw, frac);
    if c == 0 {
        return 0;
    }
    let s = sin_fix(raw, frac);
    (((s as i64) << frac) / c as i64) as i32
}

/// `atan2(y, x)` as a fraction of a TURN in Q1.`frac`, range [-0.5, 0.5). Uses
/// the same minimax atan poly as the float path, evaluated in Q30 fixed then
/// rescaled and converted radians→turns (·1/2π) — all integer.
pub fn atan2_fix(y: i32, x: i32, frac: u32) -> i32 {
    if x == 0 && y == 0 {
        return 0;
    }
    const Q: u32 = 30;
    const ONE: i64 = 1 << Q;
    // Coefficients baked at COMPILE time (const eval — no runtime float).
    const C1: i64 = -((0.0464964749f64 * ONE as f64) as i64);
    const C2: i64 = (0.15931422f64 * ONE as f64) as i64;
    const C3: i64 = -((0.327622764f64 * ONE as f64) as i64);
    const HALF_PI: i64 = (core::f64::consts::FRAC_PI_2 * ONE as f64) as i64;
    const PI_Q: i64 = (core::f64::consts::PI * ONE as f64) as i64;
    const INV_TAU: i64 = (ONE as f64 / core::f64::consts::TAU) as i64;
    let ax = (x as i64).unsigned_abs() as i64;
    let ay = (y as i64).unsigned_abs() as i64;
    let (num, den) = if ax >= ay { (ay, ax) } else { (ax, ay) };
    let a = if den == 0 { 0 } else { (num << Q) / den }; // ratio in [0,1] Q30
    let s = (a * a) >> Q;
    let mut r = ((C1 * s) >> Q) + C2;
    r = ((r * s) >> Q) + C3;
    r = (r * s) >> Q;
    r = ((r * a) >> Q) + a; // atan(ratio) in radians, Q30, range [0, π/4]
    if ay > ax {
        r = HALF_PI - r;
    }
    if x < 0 {
        r = PI_Q - r;
    }
    if y < 0 {
        r = -r;
    }
    let turns_q30 = (r * INV_TAU) >> Q; // radians → turns
    let sh = Q as i32 - frac as i32;
    (if sh >= 0 { turns_q30 >> sh } else { turns_q30 << (-sh) }) as i32
}

/// `ln(x)` in Q1.`frac` for `x = raw/2^frac > 0`. Decomposes x = m·2^e with the
/// mantissa m ∈ [1,2), so ln(x) = e·ln2 + ln(m); ln(m) via a short minimax poly.
/// All integer (Q30 intermediate). Returns 0 for x ≤ 0.
fn log_fix(raw: i32, frac: u32) -> i32 {
    if raw <= 0 {
        return 0;
    }
    const Q: u32 = 30;
    const ONE: i64 = 1 << Q;
    // x = raw / 2^frac. Find e so that m = x / 2^e ∈ [1,2). The MSB index of raw
    // relative to the frac point gives e directly.
    let msb = 31 - (raw as u32).leading_zeros() as i32; // index of top set bit
    let e = msb - frac as i32; // exponent of x
    // mantissa m in Q30: shift raw so the top bit lands at bit Q.
    let shift = Q as i32 - msb;
    let m = if shift >= 0 {
        (raw as i64) << shift
    } else {
        (raw as i64) >> (-shift)
    }; // m ∈ [2^Q, 2^(Q+1)) → represents [1,2) in Q30
    let mf = m - ONE; // (m-1) ∈ [0,1) Q30
    // ln(1+f) ≈ f - f^2/2 + f^3/3 - f^4/4  (f ∈ [0,1))
    let f = mf;
    let f2 = (f * f) >> Q;
    let f3 = (f2 * f) >> Q;
    let f4 = (f3 * f) >> Q;
    let ln_m = f - f2 / 2 + f3 / 3 - f4 / 4; // Q30
    const LN2: i64 = (core::f64::consts::LN_2 * ONE as f64) as i64;
    let r = (e as i64) * LN2 + ln_m; // ln(x) in Q30
    let sh = Q as i32 - frac as i32;
    (if sh >= 0 { r >> sh } else { r << (-sh) }) as i32
}

/// `a^b` in Q1.`frac` via `exp(b·ln a)`, both LUT/poly-based (integer). Uses the
/// bounded [-2,2) `exp_fix`, so large results saturate — adequate for effect
/// shaping curves. `a ≤ 0` returns 0.
fn pow_fix(a: i32, b: i32, frac: u32) -> i32 {
    if a <= 0 {
        return 0;
    }
    let la = log_fix(a, frac) as i64; // Q1.frac
    let prod = ((b as i64) * la) >> frac; // b·ln a, Q1.frac
    exp_fix(prod.clamp(i32::MIN as i64, i32::MAX as i64) as i32, frac)
}

/// Deterministic `hash -> [0,1)` in Q1.`frac` from a raw 32-bit slot word (the
/// int/fixed bits). Reuses the integer avalanche mixer — no soft-float, unlike
/// the f32 `hash1`. The top `frac` bits of the mixed value form the fraction.
fn hash_fix(bits: u32, frac: u32) -> i32 {
    let h = mix32(bits ^ 0x9e37_79b9);
    h.wrapping_shr(32 - frac) as i32
}

/// 3-input fixed hash -> [0,1) in Q1.`frac` (folds three slot words).
fn hash3_fix(x: u32, y: u32, z: u32, frac: u32) -> i32 {
    let mut h = mix32(x ^ 0x9e37_79b9);
    h = mix32(h ^ y.wrapping_add(0x85eb_ca6b));
    h = mix32(h ^ z.wrapping_add(0xc2b2_ae35));
    h.wrapping_shr(32 - frac) as i32
}

/// `hsv2rgb` entirely in Q1.`frac`. `h` is in TURNS (wrapped), `s`,`v` in [0,1];
/// returns `(r,g,b)` each Q1.frac in [0,1]. Mirrors the float `hsv2rgb` using
/// only integer arithmetic (the ±chroma ramp is a fixed abs/sub).
fn hsv2rgb_fix(h: i32, s: i32, v: i32, frac: u32) -> (i32, i32, i32) {
    let one = 1i64 << frac;
    let mulf = |a: i64, b: i64| (a * b) >> frac;
    // hue sextant: h6 = frac_of(h) * 6
    let hfrac = (h as i64) & (one - 1); // [0,1) turn
    let h6 = hfrac * 6; // Q1.frac scaled by 6 → range [0,6) in Q1.frac units
    let sextant = (h6 >> frac) as i32; // 0..5
    let c = mulf(v as i64, s as i64); // chroma
    // x = c * (1 - |(_h6 mod 2) - 1|), where _h6 in [0,6)
    let h6mod2 = h6 % (2 * one);
    let ramp = (h6mod2 - one).abs(); // |frac(h6/2)*2 - 1| scaled: in [0,1]
    let xx = mulf(c, one - ramp);
    let m = v as i64 - c;
    let (r, g, b) = match sextant {
        0 => (c, xx, 0),
        1 => (xx, c, 0),
        2 => (0, c, xx),
        3 => (0, xx, c),
        4 => (xx, 0, c),
        _ => (c, 0, xx),
    };
    ((r + m) as i32, (g + m) as i32, (b + m) as i32)
}

/// Fixed-point palette lookup (mirrors the float `palette`), Q1.`frac` in/out.
fn palette_fix(id: u8, t: i32, frac: u32) -> (i32, i32, i32) {
    let one = 1i64 << frac;
    let clamp01f = |x: i64| x.clamp(0, one);
    let t = clamp01f(t as i64);
    let mul = |a: i64, k: i64| clamp01f((a * k) >> frac); // a·k with clamp
    let msub = |a: i64, k: i64, sub: i64| clamp01f(((a * k) >> frac) - sub);
    match id {
        // fire: black -> red -> orange -> yellow -> white
        0 => (mul(t, 3 * one) as i32, msub(t, 3 * one, one) as i32, msub(t, 3 * one, 2 * one) as i32),
        // ice: black -> blue -> cyan -> white
        1 => (msub(t, 3 * one, 2 * one) as i32, msub(t, 3 * one, one) as i32, mul(t, 2 * one) as i32),
        // rainbow
        _ => {
            let one_i = (1i64 << frac) as i32;
            hsv2rgb_fix(t as i32, one_i, one_i, frac)
        }
    }
}
