//! Variance analysis, per-frame hoisting and per-LED memoization.
//!
//! The user-facing question this answers: *can the engine notice that
//! `atan2(led.pos.x, led.pos.z)` in a cylindrical mapping never changes and
//! stop recomputing it every frame?* Yes — and it is decided HERE, statically,
//! not by the on-device JIT (see docs/design/fx-memoization.md for why).
//!
//! The pass runs over the optimizer's decoded instruction list (stable ids, see
//! `opt.rs`). For every value `shade()` pushes it computes a **variance class**:
//!
//! | class    | depends on                                                   |
//! |----------|--------------------------------------------------------------|
//! | Const    | nothing but literals / the topology graph                    |
//! | Led      | per-LED map attributes only: pos, uv, idx, seg, s, branch    |
//! | Frame    | time/dt/frame/imu/led_count, uniforms, `state` (read-only in shade) |
//! | Dynamic  | anything else (mutable locals, buffers/textures, led.dist/room, calls) |
//!
//! by abstract interpretation of the operand stack within each basic block
//! (`Const ⊔ x = x`, `Led ⊔ Frame = Dynamic`). A value's *range* is the
//! contiguous instruction run that computes exactly it (no side effects, never
//! dips below its starting stack depth); only values with a valid range can be
//! moved or cached. Then:
//!
//! * **Frame** (and non-trivial Const) ranges are **hoisted** into a per-frame
//!   *prepare* entry (fx_vm runs it itself once per frame, before the first
//!   `shade()`, and again whenever a uniform / update() / the frame changes)
//!   that writes fresh `state` slots; `shade()` just does a `LoadState`. Locals
//!   they read are re-derived in the prep code from their single definition.
//! * **Led** ranges are **memoized**: bracketed by `LoadLedCache`/`StoreLedCache`
//!   (fx_vm) so a host that binds a per-LED cache computes each once per LED
//!   (per map) instead of once per LED per frame. The cache stores the raw stack
//!   words, so a hit is bit-identical to recomputing, and a host with no RAM to
//!   spare simply binds nothing and runs the original code.
//!
//! A C6 cycle-cost model (calibrated from the HITL `fx_bench` bundle, see
//! [`op_cycles`]) decides what is worth it: a candidate must save more cycles
//! per LED than the cache/state load costs, and memo candidates compete for a
//! per-LED byte budget by cycles-saved-per-byte. The groups are emitted in that
//! priority order so the firmware, which knows the LED count and its free arena,
//! binds the best prefix that fits.
//!
//! Only code reachable from `shade()` and NOT from `update()` (and not inside a
//! user function) is transformed: a helper called from both would otherwise be
//! evaluated with update()'s default `Led`.

use crate::fx_vm_op as op;
use crate::opt::{op_reads_locals, Ins, Prog};
use std::collections::{BTreeSet, HashMap};

/// Variance lattice (see module docs). Ordered so `max` is NOT the join —
/// use [`join`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Variance {
    /// Literal / graph-derived: the same for every LED and frame.
    Const,
    /// Per-LED map attributes only (pos/uv/idx/seg/s/branch): per-LED cacheable.
    Led,
    /// Per-frame (time, uniforms, state, ...): hoistable to once per frame.
    Frame,
    /// Varies per LED AND per frame, or unknown.
    Dynamic,
}

/// Lattice join: `Const ⊔ x = x`, `Led ⊔ Frame = Dynamic`.
pub fn join(a: Variance, b: Variance) -> Variance {
    use Variance::*;
    match (a, b) {
        (x, y) if x == y => x,
        (Const, y) | (y, Const) => y,
        _ => Dynamic,
    }
}

/// Knobs for the pass (the compiler's defaults are [`MemoConfig::default`]).
#[derive(Clone, Debug)]
pub struct MemoConfig {
    /// Hoist per-frame subexpressions into the per-frame prepare entry.
    pub hoist: bool,
    /// Bracket per-LED-invariant subexpressions with the LED cache ops.
    pub led_cache: bool,
    /// Cap on memo bytes per LED (4 per scalar word; the validity mask is extra
    /// and tiny). 16 B/LED = 8 KB at 500 LEDs — well inside the 24 KB fx arena.
    pub max_led_cache_bytes: usize,
    /// Minimum estimated C6 cycles saved per LED per frame for a memo candidate.
    pub min_memo_saving: u32,
}

impl Default for MemoConfig {
    fn default() -> Self {
        MemoConfig {
            hoist: true,
            led_cache: true,
            max_led_cache_bytes: 16,
            min_memo_saving: 150,
        }
    }
}

/// One transformed expression (for diagnostics, tests and the disassembler).
#[derive(Clone, Debug, PartialEq)]
pub struct MemoItem {
    /// Mnemonic listing of the moved/cached instructions.
    pub expr: String,
    /// Words (stack slots) the expression yields.
    pub words: u8,
    /// `state` slot (hoisted) or memo word slot (cached).
    pub slot: u8,
    /// Estimated C6 cycles the expression costs per evaluation.
    pub cycles: u32,
}

/// What the pass did to a program.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct MemoReport {
    /// Per-frame expressions moved into the prepare entry.
    pub hoisted: Vec<MemoItem>,
    /// Per-LED expressions bracketed by the LED cache, in priority order.
    pub cached: Vec<MemoItem>,
    /// LED-invariant candidates left uncached by the per-LED byte budget.
    pub over_budget: Vec<MemoItem>,
    /// Memo words per LED the program requests (0 = none).
    pub led_cache_words: u8,
    /// Cumulative group boundaries (fx_vm `led_cache_fit` picks a prefix).
    pub led_cache_groups: Vec<u8>,
    /// `n_state` after hoisting.
    pub n_state: u8,
    /// Byte offset of the per-frame prepare entry (0xFFFF = none).
    pub prep_entry: u16,
    /// Estimated C6 cycles saved per LED per steady-state frame (all cached).
    pub cycles_saved_per_led: u32,
}

/// Static per-buffer info the stack model needs (elements per access).
#[derive(Clone, Copy, Debug)]
pub struct BufShape {
    pub elem: u8,
}

// -- C6 cost model -------------------------------------------------------------

/// Interpreter dispatch cost per opcode on the C6 (fetch/decode/budget check/
/// jump table), fitted from the HITL fx_bench bundle
/// (web/tests/testdata/device-bench-esp32c6.json, rms 0.4% over 70 programs):
/// every op pays this on top of its compute. Kept in lockstep with the app's
/// default cost table (web/src/store/costTableStore.ts `@dispatch`) — see
/// docs/design/fx-memoization.md "Calibration".
pub const DISPATCH_CYCLES: u32 = 69;
/// Per-word cost of moving a slot (LoadLocal/StoreLocal/LoadUniform/...).
pub const SLOT_CYCLES: u32 = 18;

/// Estimated C6 cycles for one execution of `ins` (dispatch + compute; soft
/// float for the f32 ops). The f32 compute extras are the fx_bench fit (per
/// lane); the integer/fixed ISA extras come from the memo HITL micro-benchmarks
/// (docs/design/fx-memoization.md, "Calibration").
pub fn op_cycles(ins: &Ins) -> u32 {
    let b = |k: usize| ins.ops.get(k).copied().unwrap_or(1) as u32;
    let extra = match ins.op {
        op::PUSH_CONST | op::LOAD_CTX_FIX => 0,
        op::LOAD_UNIFORM
        | op::LOAD_STATE
        | op::LOAD_LOCAL
        | op::STORE_LOCAL
        | op::STORE_STATE
        | op::TEE_LOCAL => SLOT_CYCLES * b(1),
        op::LOAD_CTX => 10,
        op::SWIZZLE => 8 * b(1),
        op::ADD => 124 * b(0),
        op::SUB => 131 * b(0),
        op::MUL => 126 * b(0),
        op::DIV => 278 * b(0),
        op::NEG => 10 * b(0),
        op::SCALE => 126 * b(0),
        op::UN_MATH => {
            let per = match ins.ops.first().copied().unwrap_or(0) {
                2 => 41,    // abs
                9 => 64,    // sign
                3 => 188,   // floor
                4 => 343,   // ceil
                5 => 269,   // fract
                6 => 614,   // sqrt
                0 => 504,   // sin (LUT)
                1 => 577,   // cos (LUT)
                10 => 1238, // tan
                7 => 816,   // exp
                8 => 783,   // log
                _ => 600,
            };
            per * b(1)
        }
        op::BIN_MATH => {
            let per = match ins.ops.first().copied().unwrap_or(0) {
                0 | 1 => 110, // min/max
                4 => 116,     // step
                3 => 522,     // mod
                2 => 1741,    // pow
                5 => 969,     // atan2
                _ => 600,
            };
            per * b(1)
        }
        op::CLAMP => 166 * b(0),
        op::MIX => 283 * b(0),
        op::SMOOTHSTEP => 637 * b(0),
        op::DOT => 124 * b(0),
        op::CROSS => 650,
        op::LENGTH => 316 * b(0),
        op::NORMALIZE => 505 * b(0),
        op::DISTANCE => 387 * b(0),
        op::CMP => 60,
        op::HASH1 => 115,
        op::HASH3 => 147,
        op::HSV2RGB => 1242,
        op::PALETTE => 433,
        // soft-float boundary conversions (FixFromF measured on the C6: 249)
        op::I2F | op::F2I | op::FIX2F | op::F2FIX | op::FIX_TO_F | op::FIX_FROM_F => 249,
        // integer / fixed ISA — measured on the C6 (memo HITL M/2M chains):
        // AddI 32, MulFixN 45, SinFix 79, Atan2Fix 279, SqrtFix 414; the rest
        // by analogy.
        op::ADD_I | op::SUB_I | op::NEG_I | op::CMP_I | op::ABS_I | op::MIN_I | op::MAX_I
        | op::SIGN_I | op::STEP_I | op::FLOOR_FIX | op::CEIL_FIX | op::FRACT_FIX
        | op::FIX_RESCALE => 32,
        op::CLAMP_I => 40,
        op::MUL_FIX | op::MUL_FIX_N | op::MUL_I => 45,
        op::MIX_FIX => 50,
        op::DIV_I | op::MOD_I | op::DIV_FIX | op::DIV_FIX_N => 80,
        op::SIN_FIX | op::COS_FIX => 79,
        op::EXP_FIX => 100,
        op::SQRT_FIX => 414,
        op::LOG_FIX | op::TAN_FIX => 300,
        op::POW_FIX => 650,
        op::ATAN2_FIX => 279,
        op::LENGTH_FIX | op::DISTANCE_FIX => 450 + 45 * b(1),
        op::NORMALIZE_FIX => 700,
        op::DOT_FIX | op::SCALE_FIX => 45 * b(1),
        op::SMOOTHSTEP_FIX => 150 * b(1),
        op::MIX_V_FIX => 50 * b(1),
        op::CLAMP_V_FIX => 40 * b(0),
        op::CROSS_FIX => 200,
        op::HSV2RGB_FIX => 300,
        op::PALETTE_FIX => 200,
        op::HASH_FIX => 60,
        op::HASH3_FIX => 80,
        op::GRAPH_QUERY => 30,
        op::LOAD_STATE_IDX | op::LOAD_LOCAL_IDX => 20 + SLOT_CYCLES * b(3),
        _ => 4,
    };
    DISPATCH_CYCLES + extra
}

/// Minimum per-LED cycles all hoists together must save for a prep entry to be
/// emitted (it costs each shade() a frame-key check).
const MIN_PREP_SAVING: u32 = 150;

/// Cycles of a `LoadState slot,n` / cache hit that replaces a moved range.
fn load_cycles(n: u8) -> u32 {
    DISPATCH_CYCLES + SLOT_CYCLES * n as u32
}
fn led_cache_hit_cycles(n: u8) -> u32 {
    DISPATCH_CYCLES + 30 + SLOT_CYCLES * n as u32
}

// -- stack model -----------------------------------------------------------------

/// How an instruction touches the operand stack + the world.
#[derive(Clone, Copy, Debug)]
struct Eff {
    pops: usize,
    pushes: usize,
    /// Writes a local/state/buffer/graph source (cannot be skipped or moved).
    side_effect: bool,
    /// Unknown stack effect (Call): the abstract stack resets after it.
    opaque: bool,
    /// Ends the basic block (branch / return).
    terminator: bool,
}

fn ctx_width(id: u8) -> usize {
    match id {
        3 | 9 | 10 | 13 | 14 | 15 => 3, // pos, imu.accel, imu.gyro, room, room.min/max
        12 => 2,                        // uv
        _ => 1,
    }
}

/// Variance of a context id (LoadCtx / LoadCtxFix).
fn ctx_variance(id: u8) -> Variance {
    use Variance::*;
    match id {
        // led.pos, led.idx, led.seg, led.s, led.branch, led.uv: fixed per map.
        3 | 4 | 6 | 7 | 8 | 12 => Led,
        // time, dt, frame, led.count, imu, room box: per frame.
        0 | 1 | 2 | 5 | 9 | 10 | 14 | 15 => Frame,
        // led.dist follows flood_from (update-driven); led.room follows the
        // fixture pose (not a map upload) — keep both out of the LED cache.
        _ => Dynamic,
    }
}

fn eff(ins: &Ins, bufs: &[BufShape]) -> Option<Eff> {
    let b = |k: usize| ins.ops.get(k).copied().unwrap_or(0) as usize;
    let pure = |pops: usize, pushes: usize| Eff {
        pops,
        pushes,
        side_effect: false,
        opaque: false,
        terminator: false,
    };
    let store = |pops: usize, pushes: usize| Eff {
        pops,
        pushes,
        side_effect: true,
        opaque: false,
        terminator: false,
    };
    let term = |pops: usize| Eff {
        pops,
        pushes: 0,
        side_effect: false,
        opaque: false,
        terminator: true,
    };
    let elem = |id: usize| bufs.get(id).map(|s| s.elem as usize);
    Some(match ins.op {
        op::PUSH_CONST => pure(0, 1),
        op::LOAD_UNIFORM | op::LOAD_STATE | op::LOAD_LOCAL => pure(0, b(1)),
        op::STORE_STATE | op::STORE_LOCAL => store(b(1), 0),
        op::LOAD_CTX => pure(0, ctx_width(ins.ops[0])),
        op::ADD | op::SUB | op::MUL | op::DIV => pure(2 * b(0), b(0)),
        op::NEG => pure(b(0), b(0)),
        op::SCALE => pure(b(0) + 1, b(0)),
        op::UN_MATH => pure(b(1), b(1)),
        op::BIN_MATH => pure(2 * b(1), b(1)),
        op::CLAMP | op::SMOOTHSTEP => pure(3 * b(0), b(0)),
        op::MIX => pure(2 * b(0) + 1, b(0)),
        op::DOT | op::DISTANCE => pure(2 * b(0), 1),
        op::CROSS => pure(6, 3),
        op::LENGTH => pure(b(0), 1),
        op::NORMALIZE => pure(b(0), b(0)),
        op::SWIZZLE => pure(b(0), b(1)),
        op::CMP => pure(2, 1),
        op::LOGIC => {
            if b(0) == 2 {
                pure(1, 1)
            } else {
                pure(2, 1)
            }
        }
        op::BR_FALSE => term(1),
        op::JMP => term(0),
        op::BR_CMP_I => term(2),
        op::HASH1 => pure(1, 1),
        op::HASH3 => pure(3, 1),
        op::HSV2RGB => pure(3, 3),
        op::PALETTE => pure(1, 3),
        op::_POP => pure(b(0), 0),
        op::RET | op::RET_FN | op::RET_RGB8 | op::RET_RGB_FIX => term(0),
        op::SWAP => pure(b(0) + b(1), b(0) + b(1)),
        op::ADD_I
        | op::SUB_I
        | op::MUL_I
        | op::DIV_I
        | op::MOD_I
        | op::CMP_I
        | op::MUL_FIX
        | op::DIV_FIX => pure(2, 1),
        op::NEG_I | op::I2F | op::F2I | op::FIX2F | op::F2FIX | op::I2FIX | op::FIX2I => pure(1, 1),
        op::CALL => Eff {
            pops: 0,
            pushes: 0,
            side_effect: true,
            opaque: true,
            terminator: false,
        },
        op::LOAD_STATE_IDX | op::LOAD_LOCAL_IDX => pure(1, b(3)),
        op::STORE_STATE_IDX | op::STORE_LOCAL_IDX => store(b(3) + 1, 0),
        op::GRAPH_QUERY => match ins.ops[0] {
            1 | 3 | 7 => pure(1, 1),
            2 | 4 | 5 => pure(2, 1),
            _ => pure(0, 1),
        },
        op::LOAD_BUF => pure(1, elem(b(0))?),
        op::STORE_BUF => store(elem(b(0))? + 1, 0),
        op::SAMPLE_TEX => pure(2, elem(b(0))?),
        op::PAINT_TEX => store(elem(b(0))? + 2, 0),
        op::FLOOD_FROM => store(1, 0),
        op::MUL_FIX_N
        | op::DIV_FIX_N
        | op::MIN_I
        | op::MAX_I
        | op::STEP_I
        | op::ATAN2_FIX
        | op::POW_FIX => pure(2, 1),
        op::FIX_RESCALE
        | op::FIX_TO_F
        | op::FIX_FROM_F
        | op::SIN_FIX
        | op::COS_FIX
        | op::EXP_FIX
        | op::ABS_I
        | op::SIGN_I
        | op::FLOOR_FIX
        | op::CEIL_FIX
        | op::FRACT_FIX
        | op::SQRT_FIX
        | op::LOG_FIX
        | op::TAN_FIX
        | op::HASH_FIX => pure(1, 1),
        op::CLAMP_I | op::MIX_FIX | op::HASH3_FIX => pure(3, 1),
        op::SCALE_FIX => pure(b(1) + 1, b(1)),
        op::DOT_FIX | op::DISTANCE_FIX => pure(2 * b(1), 1),
        op::LENGTH_FIX => pure(b(1), 1),
        op::NORMALIZE_FIX => pure(b(1), b(1)),
        op::CROSS_FIX => pure(6, 3),
        op::SMOOTHSTEP_FIX => pure(3 * b(1), b(1)),
        op::CLAMP_V_FIX => pure(3 * b(0), b(0)),
        op::MIX_V_FIX => pure(2 * b(1) + 1, b(1)),
        op::HSV2RGB_FIX => pure(3, 3),
        op::PALETTE_FIX => pure(1, 3),
        op::LOAD_CTX_FIX => pure(0, 1),
        op::FILL_LOCAL | op::INC_LOCAL_I => store(0, 0),
        op::TEE_LOCAL => store(b(1), b(1)),
        // Never present before this pass (JitCall is patched in by firmware).
        _ => return None,
    })
}

/// Intrinsic variance an instruction contributes on top of its operands.
fn intrinsic(ins: &Ins, locals: &HashMap<u8, Variance>) -> Vec<Variance> {
    use Variance::*;
    let b = |k: usize| ins.ops.get(k).copied().unwrap_or(0);
    match ins.op {
        op::LOAD_UNIFORM | op::LOAD_STATE => vec![Frame],
        op::LOAD_STATE_IDX => vec![Frame],
        op::LOAD_LOCAL => (0..b(1))
            .map(|k| {
                locals
                    .get(&(b(0).wrapping_add(k)))
                    .copied()
                    .unwrap_or(Dynamic)
            })
            .collect(),
        op::LOAD_CTX | op::LOAD_CTX_FIX => vec![ctx_variance(b(0))],
        // Mutable / aliased storage.
        op::LOAD_LOCAL_IDX | op::LOAD_BUF | op::SAMPLE_TEX => vec![Dynamic],
        // Graph tables change only with the topology (which also invalidates
        // the LED cache and is re-read by every hoisted per-frame range).
        _ => vec![Const],
    }
}

/// One abstract stack value.
#[derive(Clone, Copy, Debug)]
struct AVal {
    var: Variance,
    /// Position where the range computing this value starts (None = no valid
    /// self-contained range, e.g. it crosses a block boundary or a call).
    start: Option<usize>,
}

/// Per-position analysis result.
#[derive(Clone, Debug, Default)]
struct PosInfo {
    block: usize,
    depth_before: isize,
    /// Lowest depth reached while executing (after pops, before pushes).
    low: isize,
    depth_after: isize,
    side_effect: bool,
    outs: Vec<AVal>,
    in_region: bool,
}

/// A local's single definition: where it is stored and what range computes the
/// stored words (for re-deriving it in the prepare entry).
#[derive(Clone, Debug)]
struct LocalDef {
    /// First slot + width the def op writes.
    base: u8,
    n: u8,
    /// Range [start, at-1] computing the stored words, if self-contained.
    range: Option<(usize, usize)>,
}

struct Analysis {
    info: Vec<PosInfo>,
    locals: HashMap<u8, Variance>,
    defs: HashMap<u8, LocalDef>,
}

/// Positions reachable from `entry`, optionally following calls into callees.
fn reach(prog: &Prog, entry: Option<u32>, follow_calls: bool) -> Vec<bool> {
    let n = prog.ins.len();
    let pos_of: HashMap<u32, usize> = prog
        .ins
        .iter()
        .enumerate()
        .map(|(p, i)| (i.id, p))
        .collect();
    let mut seen = vec![false; n];
    let mut stack: Vec<usize> = entry
        .and_then(|e| pos_of.get(&e).copied())
        .into_iter()
        .collect();
    while let Some(i) = stack.pop() {
        if i >= n || seen[i] {
            continue;
        }
        seen[i] = true;
        let ii = &prog.ins[i];
        let tgt = pos_of.get(&ii.target).copied();
        match ii.op {
            op::JMP => stack.extend(tgt),
            op::RET | op::RET_FN | op::RET_RGB8 | op::RET_RGB_FIX => {}
            op::BR_FALSE | op::BR_CMP_I | op::LOAD_LED_CACHE => {
                stack.extend(tgt);
                stack.push(i + 1);
            }
            op::CALL => {
                if follow_calls {
                    stack.extend(tgt);
                }
                stack.push(i + 1);
            }
            _ => stack.push(i + 1),
        }
    }
    seen
}

/// Analyze `shade()`'s own body. `None` when the program contains something the
/// stack model doesn't know (then the pass leaves it untouched).
fn analyze(prog: &Prog, bufs: &[BufShape]) -> Option<Analysis> {
    let n = prog.ins.len();
    let from_update = reach(prog, prog.update, true);
    let shade_all = reach(prog, prog.shade, true);
    let shade_body = reach(prog, prog.shade, false);
    let region: Vec<bool> = (0..n).map(|p| shade_body[p] && !from_update[p]).collect();
    let refd = prog.referenced();
    // shade() is read-only on `state` by construction; if anything it can run
    // writes state anyway, state reads are not frame-invariant.
    let state_written = (0..n)
        .any(|p| shade_all[p] && matches!(prog.ins[p].op, op::STORE_STATE | op::STORE_STATE_IDX));

    // Local definition counts over everything shade can execute (callees too).
    let mut def_count: HashMap<u8, u32> = HashMap::new();
    let mut def_at: HashMap<u8, (usize, u8, u8)> = HashMap::new();
    for p in 0..n {
        if !shade_all[p] {
            continue;
        }
        let ii = &prog.ins[p];
        match ii.op {
            op::STORE_LOCAL | op::TEE_LOCAL => {
                let (base, w) = (ii.ops[0], ii.ops[1]);
                for k in 0..w {
                    *def_count.entry(base.wrapping_add(k)).or_insert(0) += 1;
                    def_at.insert(base.wrapping_add(k), (p, base, w));
                }
            }
            op::FILL_LOCAL => {
                for k in 0..ii.ops[1] {
                    *def_count.entry(ii.ops[0].wrapping_add(k)).or_insert(0) += 2;
                }
            }
            op::INC_LOCAL_I => *def_count.entry(ii.ops[0]).or_insert(0) += 2,
            op::STORE_LOCAL_IDX => {
                // base, stride, off, n, count: may write any element.
                let (base, stride, count) = (ii.ops[0] as u32, ii.ops[1] as u32, ii.ops[4] as u32);
                for s in base..(base + stride * count).min(256) {
                    *def_count.entry(s as u8).or_insert(0) += 2;
                }
            }
            _ => {}
        }
    }
    let single: HashMap<u8, (usize, u8, u8)> = def_at
        .into_iter()
        .filter(|(s, _)| def_count.get(s).copied() == Some(1))
        .collect();

    // Optimistic fixed point over single-def local classes (Const = bottom).
    let mut locals: HashMap<u8, Variance> = single.keys().map(|&s| (s, Variance::Const)).collect();
    for _ in 0..16 {
        let info = blocks(prog, bufs, &region, &refd, &locals, state_written)?;
        let mut next = locals.clone();
        for (&slot, &(at, base, _w)) in &single {
            // The stored word's class (a def outside the shade body — a callee
            // param store, say — is opaque: Dynamic).
            let v = if region[at] {
                let k = slot.wrapping_sub(base) as usize;
                stored_word(prog, &info, at, k)
                    .map(|a| a.var)
                    .unwrap_or(Variance::Dynamic)
            } else {
                Variance::Dynamic
            };
            next.insert(slot, v);
        }
        if next == locals {
            let defs = single
                .iter()
                .map(|(&slot, &(at, base, w))| {
                    let range = if region[at] {
                        def_range(prog, &info, at, w)
                    } else {
                        None
                    };
                    (slot, LocalDef { base, n: w, range })
                })
                .collect();
            return Some(Analysis { info, locals, defs });
        }
        locals = next;
    }
    None
}

/// The abstract value of word `k` (0 = deepest) a store at `at` consumes.
fn stored_word(prog: &Prog, info: &[PosInfo], at: usize, k: usize) -> Option<AVal> {
    let w = prog.ins[at].ops[1] as usize;
    let vals = consumed(prog, info, at, w)?;
    vals.get(k).copied()
}

/// Reconstruct the abstract values the instruction at `at` consumed (the top
/// `count` values before it), by replaying its block. Returns them deepest-first.
fn consumed(prog: &Prog, info: &[PosInfo], at: usize, count: usize) -> Option<Vec<AVal>> {
    let blk = info[at].block;
    let mut start = at;
    while start > 0 && info[start - 1].in_region && info[start - 1].block == blk {
        start -= 1;
    }
    // Replay stack contents from block start using recorded outs/pops.
    let mut stack: Vec<AVal> = Vec::new();
    for p in start..at {
        let pops = (info[p].depth_before - info[p].low) as usize;
        for _ in 0..pops {
            stack.pop();
        }
        if prog.ins[p].op == op::CALL {
            stack.clear();
        }
        stack.extend(info[p].outs.iter().copied());
    }
    let mut out = Vec::with_capacity(count);
    for _ in 0..count {
        out.push(stack.pop().unwrap_or(AVal {
            var: Variance::Dynamic,
            start: None,
        }));
    }
    out.reverse();
    Some(out)
}

/// The self-contained range computing the `w` words a store at `at` writes.
fn def_range(prog: &Prog, info: &[PosInfo], at: usize, w: u8) -> Option<(usize, usize)> {
    let vals = consumed(prog, info, at, w as usize)?;
    let s = vals
        .iter()
        .map(|v| v.start)
        .collect::<Option<Vec<_>>>()?
        .into_iter()
        .min()?;
    if at == 0 {
        return None;
    }
    let e = at - 1;
    // Same block, no side effects, never below the starting depth, and ends
    // exactly w words higher.
    valid_range(info, s, e, w as usize).then_some((s, e))
}

fn valid_range(info: &[PosInfo], s: usize, e: usize, words: usize) -> bool {
    if s > e || !info[s].in_region {
        return false;
    }
    let base = info[s].depth_before;
    let blk = info[s].block;
    for p in s..=e {
        let pi = &info[p];
        if !pi.in_region || pi.block != blk || pi.side_effect || pi.low < base {
            return false;
        }
    }
    info[e].depth_after == base + words as isize
}

/// Abstract-interpret every basic block of the shade body.
fn blocks(
    prog: &Prog,
    bufs: &[BufShape],
    region: &[bool],
    refd: &std::collections::HashSet<u32>,
    locals: &HashMap<u8, Variance>,
    state_written: bool,
) -> Option<Vec<PosInfo>> {
    let n = prog.ins.len();
    let mut info = vec![PosInfo::default(); n];
    let mut block = 0usize;
    let mut stack: Vec<AVal> = Vec::new();
    let mut depth: isize = 0;
    let mut prev_term = true;
    for p in 0..n {
        if !region[p] {
            prev_term = true;
            continue;
        }
        let ii = &prog.ins[p];
        if prev_term || refd.contains(&ii.id) || p == 0 || !region[p - 1] {
            block += 1;
            stack.clear();
            depth = 0;
        }
        let e = eff(ii, bufs)?;
        let pi = &mut info[p];
        pi.in_region = true;
        pi.block = block;
        pi.depth_before = depth;
        pi.side_effect = e.side_effect;
        // Pop operands.
        let mut ins_vals: Vec<AVal> = Vec::with_capacity(e.pops);
        for _ in 0..e.pops {
            ins_vals.push(stack.pop().unwrap_or(AVal {
                var: Variance::Dynamic,
                start: None,
            }));
        }
        ins_vals.reverse();
        depth -= e.pops as isize;
        pi.low = depth;
        if e.opaque {
            // Unknown callee effect: nothing below is trustworthy any more.
            stack.clear();
            pi.outs.clear();
            pi.depth_after = depth;
            prev_term = false;
            continue;
        }
        let start = ins_vals
            .iter()
            .try_fold(p, |m, v| v.start.map(|s| m.min(s)));
        let opv = ins_vals.iter().fold(Variance::Const, |a, v| join(a, v.var));
        let mut intr = intrinsic(ii, locals);
        if state_written && matches!(ii.op, op::LOAD_STATE | op::LOAD_STATE_IDX) {
            intr = vec![Variance::Dynamic];
        }
        let outs: Vec<AVal> = (0..e.pushes)
            .map(|k| {
                let var = if ii.op == op::SWAP || ii.op == op::TEE_LOCAL {
                    // Pure reorder / copy: each word keeps its own class.
                    ins_vals.get(k).map(|v| v.var).unwrap_or(Variance::Dynamic)
                } else if ii.op == op::LOAD_LOCAL {
                    intr[k.min(intr.len() - 1)]
                } else {
                    join(opv, intr[0])
                };
                AVal { var, start }
            })
            .collect();
        depth += e.pushes as isize;
        pi.depth_after = depth;
        stack.extend(outs.iter().copied());
        pi.outs = outs;
        prev_term = e.terminator;
    }
    Some(info)
}

// -- candidate selection ------------------------------------------------------------

#[derive(Clone, Debug)]
struct Cand {
    s: usize,
    e: usize,
    words: u8,
    var: Variance,
    cycles: u32,
    /// Local slots the range reads (for hoisting's re-derivation).
    reads: BTreeSet<u8>,
}

fn range_cycles(prog: &Prog, s: usize, e: usize) -> u32 {
    prog.ins[s..=e].iter().map(op_cycles).sum()
}

fn range_reads(prog: &Prog, s: usize, e: usize) -> BTreeSet<u8> {
    let mut r = BTreeSet::new();
    for ii in &prog.ins[s..=e] {
        if let Some((base, w)) = op_reads_locals(ii) {
            for k in 0..w {
                r.insert(base.wrapping_add(k));
            }
        }
    }
    r
}

/// Every instruction-output group with a valid range, kept only if no strictly
/// larger candidate of the same class contains it (maximal ranges).
fn candidates(prog: &Prog, an: &Analysis) -> Vec<Cand> {
    let mut all: Vec<Cand> = Vec::new();
    for (p, pi) in an.info.iter().enumerate() {
        if !pi.in_region || pi.outs.is_empty() || pi.outs.len() > 8 {
            continue;
        }
        let Some(s) = pi.outs[0].start else { continue };
        if pi.outs.iter().any(|o| o.start != Some(s)) {
            continue;
        }
        let var = pi.outs.iter().fold(Variance::Const, |a, o| join(a, o.var));
        if var == Variance::Dynamic {
            continue;
        }
        if !valid_range(&an.info, s, p, pi.outs.len()) {
            continue;
        }
        all.push(Cand {
            s,
            e: p,
            words: pi.outs.len() as u8,
            var,
            cycles: range_cycles(prog, s, p),
            reads: range_reads(prog, s, p),
        });
    }
    // Keep maximal ranges per kind (Led vs hoistable Frame/Const).
    let kind = |v: Variance| if v == Variance::Led { 0 } else { 1 };
    let mut out: Vec<Cand> = Vec::new();
    for c in &all {
        let dominated = all.iter().any(|o| {
            kind(o.var) == kind(c.var) && o.s <= c.s && o.e >= c.e && (o.s, o.e) != (c.s, c.e)
        });
        if !dominated {
            out.push(c.clone());
        }
    }
    out
}

/// Mnemonic listing of a range (for reports).
fn listing(prog: &Prog, s: usize, e: usize) -> String {
    prog.ins[s..=e]
        .iter()
        .map(crate::opt::mnemonic)
        .collect::<Vec<_>>()
        .join("; ")
}

/// Classification report for tests/tools: every maximal non-dynamic value range
/// in shade() with its class.
pub(crate) fn classify(prog: &Prog, bufs: &[BufShape]) -> Vec<(String, Variance)> {
    let Some(an) = analyze(prog, bufs) else {
        return Vec::new();
    };
    candidates(prog, &an)
        .into_iter()
        .map(|c| (listing(prog, c.s, c.e), c.var))
        .collect()
}

/// Locals a hoisted range needs re-derived in the prep code, dependencies first.
/// `None` if any is not re-derivable (multi-def, opaque def, or non-frame).
fn hoist_deps(an: &Analysis, reads: &BTreeSet<u8>, prog: &Prog) -> Option<Vec<u8>> {
    let mut order: Vec<u8> = Vec::new();
    let mut seen: BTreeSet<u8> = BTreeSet::new();
    fn visit(
        slot: u8,
        an: &Analysis,
        prog: &Prog,
        seen: &mut BTreeSet<u8>,
        order: &mut Vec<u8>,
        depth: u32,
    ) -> Option<()> {
        if depth > 32 {
            return None;
        }
        let def = an.defs.get(&slot)?;
        if seen.contains(&def.base) {
            return Some(());
        }
        let var = an.locals.get(&slot).copied()?;
        if !matches!(var, Variance::Const | Variance::Frame) {
            return None;
        }
        let (s, e) = def.range?;
        seen.insert(def.base);
        for r in range_reads(prog, s, e) {
            visit(r, an, prog, seen, order, depth + 1)?;
        }
        order.push(def.base);
        Some(())
    }
    for &r in reads {
        visit(r, an, prog, &mut seen, &mut order, 0)?;
    }
    // Every slot of a multi-word def is written by one op — dedupe by base.
    let mut uniq: Vec<u8> = Vec::new();
    for b in order {
        if !uniq.contains(&b) {
            uniq.push(b);
        }
    }
    Some(uniq)
}

/// Run the pass. Mutates `prog` (and nothing else) on success; returns the
/// report. `n_state` is the program's state slot count before hoisting.
pub(crate) fn run(prog: &mut Prog, bufs: &[BufShape], n_state: u8, cfg: &MemoConfig) -> MemoReport {
    let mut report = MemoReport {
        n_state,
        prep_entry: 0xFFFF,
        ..Default::default()
    };
    if !cfg.hoist && !cfg.led_cache {
        return report;
    }
    if prog.shade.is_none()
        || prog
            .ins
            .iter()
            .any(|i| i.op == op::LOAD_LED_CACHE || i.op == op::JIT_CALL)
    {
        return report;
    }
    let Some(an) = analyze(prog, bufs) else {
        return report;
    };
    let cands = candidates(prog, &an);

    // --- LED memo selection (knapsack by cycles saved per byte) ------------------
    struct Memo {
        c: Cand,
        slot: u8,
        saving: u32,
    }
    let mut memos: Vec<Memo> = Vec::new();
    if cfg.led_cache {
        let mut led: Vec<(Cand, u32)> = cands
            .iter()
            .filter(|c| c.var == Variance::Led)
            .filter_map(|c| {
                let saving = c.cycles.saturating_sub(led_cache_hit_cycles(c.words));
                (saving >= cfg.min_memo_saving).then(|| (c.clone(), saving))
            })
            .collect();
        // Best cycles-saved-per-byte first (ties: bigger saving, then earlier).
        led.sort_by(|a, b| {
            let da = a.1 as u64 * b.0.words as u64;
            let db = b.1 as u64 * a.0.words as u64;
            db.cmp(&da).then(b.1.cmp(&a.1)).then(a.0.s.cmp(&b.0.s))
        });
        let max_words = (cfg.max_led_cache_bytes / 4).min(fx_vm_max_words());
        let mut used = 0usize;
        let mut keys: HashMap<String, u8> = HashMap::new();
        for (c, saving) in led {
            let key = listing(prog, c.s, c.e);
            // The same LED-invariant expression twice shares one slot (a single
            // def per local + the same code => the same value per LED).
            if let Some(&slot) = keys.get(&key) {
                memos.push(Memo { c, slot, saving });
                continue;
            }
            if used + c.words as usize > max_words {
                report.over_budget.push(MemoItem {
                    expr: key,
                    words: c.words,
                    slot: 0,
                    cycles: c.cycles,
                });
                continue;
            }
            let slot = used as u8;
            used += c.words as usize;
            keys.insert(key, slot);
            memos.push(Memo { c, slot, saving });
        }
    }

    // --- hoists ----------------------------------------------------------------
    struct Hoist {
        c: Cand,
        slot: u8,
        deps: Vec<u8>,
    }
    let mut hoists: Vec<Hoist> = Vec::new();
    let mut next_state = n_state as usize;
    let mut hoist_keys: HashMap<String, u8> = HashMap::new();
    if cfg.hoist {
        for c in cands.iter().filter(|c| c.var != Variance::Led) {
            // A Const subrange inside a chosen memo range is already covered.
            if memos.iter().any(|m| m.c.s <= c.e && c.s <= m.c.e) {
                continue;
            }
            // Worth it only if the range costs more than the load replacing it
            // (a lone LoadUniform/PushConst is already as cheap as it gets).
            if c.e == c.s || c.cycles < load_cycles(c.words) + 60 {
                continue;
            }
            let Some(deps) = hoist_deps(&an, &c.reads, prog) else {
                continue;
            };
            let key = listing(prog, c.s, c.e);
            let slot = if let Some(&s) = hoist_keys.get(&key) {
                s
            } else {
                if next_state + c.words as usize > crate::MAX_STATE {
                    continue;
                }
                let s = next_state as u8;
                next_state += c.words as usize;
                hoist_keys.insert(key, s);
                s
            };
            hoists.push(Hoist {
                c: c.clone(),
                slot,
                deps,
            });
        }
    }

    // A prep entry costs every LED a frame-key check in the VM (~30 cycles on the
    // C6): only worth emitting when the hoists save clearly more than that.
    let hoist_saving: u32 = hoists
        .iter()
        .map(|h| h.c.cycles.saturating_sub(load_cycles(h.c.words)))
        .sum();
    if hoist_saving < MIN_PREP_SAVING {
        hoists.clear();
        next_state = n_state as usize;
    }
    if hoists.is_empty() && memos.is_empty() {
        return report;
    }

    // --- reports (from the pre-rewrite listing) ----------------------------------
    let mut saved: u64 = 0;
    for h in &hoists {
        saved += h.c.cycles.saturating_sub(load_cycles(h.c.words)) as u64;
        report.hoisted.push(MemoItem {
            expr: listing(prog, h.c.s, h.c.e),
            words: h.c.words,
            slot: h.slot,
            cycles: h.c.cycles,
        });
    }
    let mut groups: Vec<u8> = Vec::new();
    for m in &memos {
        saved += m.saving as u64;
        let end = m.slot + m.c.words;
        if !groups.contains(&end) && groups.last().map_or(true, |&g| end > g) {
            groups.push(end);
        }
        report.cached.push(MemoItem {
            expr: listing(prog, m.c.s, m.c.e),
            words: m.c.words,
            slot: m.slot,
            cycles: m.c.cycles,
        });
    }
    report.cycles_saved_per_led = saved.min(u32::MAX as u64) as u32;
    report.led_cache_words = groups.last().copied().unwrap_or(0);
    report.led_cache_groups = groups;
    report.n_state = next_state as u8;

    // --- build the prep block from the ORIGINAL instructions -----------------
    let mut prep: Vec<Ins> = Vec::new();
    let mut derived: BTreeSet<u8> = BTreeSet::new();
    let mut stored_slots: BTreeSet<u8> = BTreeSet::new();
    for h in &hoists {
        if stored_slots.contains(&h.slot) {
            continue; // a duplicate expression shares the first one's slot
        }
        for &base in &h.deps {
            if !derived.insert(base) {
                continue;
            }
            let def = &an.defs[&base];
            let (s, e) = def.range.expect("hoist_deps checked");
            for ii in &prog.ins[s..=e] {
                prep.push(Ins {
                    id: 0,
                    op: ii.op,
                    ops: ii.ops.clone(),
                    target: 0,
                });
            }
            prep.push(Ins {
                id: 0,
                op: op::STORE_LOCAL,
                ops: vec![def.base, def.n],
                target: 0,
            });
        }
        for ii in &prog.ins[h.c.s..=h.c.e] {
            prep.push(Ins {
                id: 0,
                op: ii.op,
                ops: ii.ops.clone(),
                target: 0,
            });
        }
        prep.push(Ins {
            id: 0,
            op: op::STORE_STATE,
            ops: vec![h.slot, h.c.words],
            target: 0,
        });
        stored_slots.insert(h.slot);
    }

    // --- rewrite shade() (highest position first so indices stay valid) ------
    enum Edit {
        Hoist(usize, usize, u8, u8),
        Memo(usize, usize, u8, u8),
    }
    let mut edits: Vec<Edit> = hoists
        .iter()
        .map(|h| Edit::Hoist(h.c.s, h.c.e, h.slot, h.c.words))
        .chain(
            memos
                .iter()
                .map(|m| Edit::Memo(m.c.s, m.c.e, m.slot, m.c.words)),
        )
        .collect();
    edits.sort_by_key(|e| {
        std::cmp::Reverse(match e {
            Edit::Hoist(s, ..) | Edit::Memo(s, ..) => *s,
        })
    });
    for ed in edits {
        match ed {
            Edit::Hoist(s, e, slot, n) => {
                let id = prog.ins[s].id;
                prog.ins.splice(
                    s..=e,
                    [Ins {
                        id,
                        op: op::LOAD_STATE,
                        ops: vec![slot, n],
                        target: 0,
                    }],
                );
            }
            Edit::Memo(s, e, slot, n) => {
                let store_id = prog.fresh_id();
                prog.ins.insert(
                    e + 1,
                    Ins {
                        id: store_id,
                        op: op::STORE_LED_CACHE,
                        ops: vec![slot, n],
                        target: 0,
                    },
                );
                let after = prog.ins[e + 2].id;
                let old = prog.ins[s].id;
                let moved = prog.fresh_id();
                prog.ins[s].id = moved;
                prog.ins.insert(
                    s,
                    Ins {
                        id: old,
                        op: op::LOAD_LED_CACHE,
                        ops: vec![slot, n],
                        target: after,
                    },
                );
            }
        }
    }

    // --- append the prep block as its own entry (the VM runs it once/frame) --
    if !prep.is_empty() {
        for ii in prep.iter_mut() {
            ii.id = prog.fresh_id();
        }
        let first = prep[0].id;
        let ret_id = prog.fresh_id();
        prep.push(Ins {
            id: ret_id,
            op: op::RET,
            ops: vec![0],
            target: 0,
        });
        prog.prep = Some(first);
        prog.ins.extend(prep);
    }
    report
}

fn fx_vm_max_words() -> usize {
    32
}
