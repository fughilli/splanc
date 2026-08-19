//! Bytecode optimizer for the fx compiler (FUG-125).
//!
//! The front-end (`lib.rs`) is a single-pass recursive-descent emitter that
//! streams straight to bytecode. Rather than rewrite it around an IR, this
//! module runs a small optimizer over the *emitted* `.fxb` code section: it
//! decodes the flat byte stream into a linear instruction list where every
//! branch/call/entry target is a **stable instruction id** (not a position), so
//! passes can freely delete, splice, or reorder instructions without ever
//! having to fix up offsets. It then applies a fixed-point of peephole + local +
//! control-flow passes, re-encodes, and recomputes every relative branch.
//!
//! The passes here are deliberately conservative: each is a semantics-preserving
//! rewrite, and the whole thing is guarded end-to-end by a differential test
//! (`tests/compile.rs::optimizer_preserves_output`) that runs the real fx_vm
//! over an LED raster for every corpus program with and without the optimizer
//! and asserts **bit-identical** RGB. Constant folds replicate the VM's exact
//! integer/fixed/`f32` arithmetic (see `fx_vm::run`) so a folded constant equals
//! what the interpreter would have produced.
//!
//! Implemented techniques (the issue's "local and scalar optimizations"):
//!   - constant folding (scalar int / Q16.16 / narrow-fixed / `f32` arithmetic)
//!   - algebraic simplification & strength reduction (`x*1`, `x/1`, `x-0`, …)
//!   - dead local elimination (`StoreLocal s; LoadLocal s` of a single-use temp)
//!   - constant-condition branch folding + unreachable-code (dead-code) removal
//!
//! Safety net for the id scheme: if any pass leaves a branch/call/entry pointing
//! at an id that no longer exists (a "dangling" target), or a relative branch
//! that no longer fits `i16`, `encode` bails and `optimize` returns the original
//! bytes untouched. Optimization is best-effort; correctness is absolute.

use crate::fx_vm_op as op;
use std::collections::{HashMap, HashSet};

const NO_ENTRY: u16 = 0xFFFF;

/// One decoded instruction. `id` is a stable identity used as the referent of
/// branch/call/entry targets, so list edits never need offset fix-ups. For
/// `BrFalse`/`Jmp`/`Call` `target` is the id of the destination and `ops` is
/// empty; for every other opcode `ops` is the verbatim operand bytes.
#[derive(Clone)]
struct Ins {
    id: u32,
    op: u8,
    ops: Vec<u8>,
    target: u32,
}

impl Ins {
    /// Encoded byte length (opcode + operands). A branch is `1 + prefix-ops + 2`
    /// (its `ops` hold the prefix bytes; the `i16` rel is implied by `target`);
    /// a `Call` is 3.
    fn enc_len(&self) -> usize {
        if is_branch(self.op) {
            1 + self.ops.len() + 2
        } else if self.op == op::CALL {
            3
        } else {
            1 + self.ops.len()
        }
    }
}

/// Number of operand bytes a branch opcode carries *before* its `i16` relative
/// target (so the target stays symbolic in `Ins::target` while the prefix rides
/// in `ops`). `None` for non-branches.
fn branch_prefix(o: u8) -> Option<usize> {
    match o {
        op::BR_FALSE | op::JMP => Some(0),
        op::BR_CMP_I => Some(1), // the compare `kind` byte
        _ => None,
    }
}

fn is_branch(o: u8) -> bool {
    branch_prefix(o).is_some()
}

fn is_ctrl_target_op(o: u8) -> bool {
    is_branch(o) || o == op::CALL
}

/// Total on-wire length of the opcode at `code[pc]` (opcode byte + operands), or
/// `None` for an unknown opcode. Mirrors `decode_op` in `lib.rs` (a test asserts
/// the two agree over the corpus, so this can never silently drift).
pub(crate) fn op_len(code: &[u8], pc: usize) -> Option<usize> {
    use op::*;
    let o = code[pc];
    let b = |k: usize| *code.get(pc + 1 + k).unwrap_or(&0);
    let n = match o {
        PUSH_CONST => 3,
        LOAD_UNIFORM | LOAD_STATE | STORE_STATE | LOAD_LOCAL | STORE_LOCAL => 3,
        LOAD_CTX => 2,
        ADD | SUB | MUL | DIV | NEG | SCALE => 2,
        UN_MATH | BIN_MATH => 3,
        CLAMP | MIX | SMOOTHSTEP | DOT | CROSS | LENGTH | NORMALIZE | DISTANCE => 2,
        SWIZZLE => 3 + b(1) as usize,
        CMP => 2,
        LOGIC => 2,
        BR_FALSE | JMP => 3,
        HASH1 | HASH3 | HSV2RGB => 1,
        PALETTE => 2,
        _POP => 2,
        RET => 2,
        SWAP => 3,
        ADD_I | SUB_I | MUL_I | DIV_I | MOD_I | NEG_I => 1,
        CMP_I => 2,
        MUL_FIX | DIV_FIX => 1,
        I2F | F2I | FIX2F | F2FIX | I2FIX | FIX2I => 1,
        CALL => 3,
        RET_FN => 1,
        LOAD_STATE_IDX | STORE_STATE_IDX | LOAD_LOCAL_IDX | STORE_LOCAL_IDX => 6,
        GRAPH_QUERY => 2,
        LOAD_BUF | STORE_BUF | SAMPLE_TEX | PAINT_TEX => 2,
        FLOOD_FROM => 1,
        MUL_FIX_N | DIV_FIX_N => 2,
        FIX_RESCALE => 2,
        FIX_TO_F | FIX_FROM_F => 2,
        SIN_FIX | COS_FIX | EXP_FIX => 2,
        ABS_I | MIN_I | MAX_I | CLAMP_I => 1,
        SIGN_I | STEP_I | FLOOR_FIX | CEIL_FIX | FRACT_FIX | MIX_FIX => 2,
        SQRT_FIX => 2,
        SCALE_FIX | DOT_FIX | LENGTH_FIX | DISTANCE_FIX | NORMALIZE_FIX => 3,
        CROSS_FIX => 2,
        SMOOTHSTEP_FIX => 3,
        CLAMP_V_FIX => 2,
        MIX_V_FIX => 3,
        HSV2RGB_FIX => 2,
        PALETTE_FIX => 3,
        ATAN2_FIX | LOG_FIX | TAN_FIX | POW_FIX | HASH_FIX | HASH3_FIX => 2,
        RET_RGB8 => 1,
        RET_RGB_FIX => 2,
        LOAD_CTX_FIX => 4,
        FILL_LOCAL => 3,
        TEE_LOCAL => 3,
        INC_LOCAL_I => 4,
        BR_CMP_I => 4,
        _ => return None,
    };
    Some(n)
}

/// Optimize the emitted code section. `code`/`consts`/`update`/`shade` are the
/// compiler's raw outputs (byte-offset entries). Returns the optimized code with
/// `update`/`shade` repointed. On any structural surprise it returns the input
/// untouched — correctness first, optimization best-effort.
pub(crate) fn optimize(
    code: &[u8],
    consts: &mut Vec<u32>,
    update: &mut u16,
    shade: &mut u16,
) -> Vec<u8> {
    let mut prog = match decode(code, *update, *shade) {
        Some(p) => p,
        None => return code.to_vec(),
    };

    // Fixed-point: passes expose opportunities for each other (folding a
    // constant can make a branch constant, DCE can orphan a store, …). Bounded
    // so a pathological input can't spin.
    for _ in 0..8 {
        let mut changed = false;
        changed |= fold_constants(&mut prog, consts);
        changed |= simplify_algebraic(&mut prog, consts);
        changed |= fold_branches(&mut prog, consts);
        changed |= eliminate_dead_locals(&mut prog);
        changed |= remove_unreachable(&mut prog);
        changed |= fuse_superinstructions(&mut prog, consts);
        if !changed {
            break;
        }
    }

    let (u0, s0) = (*update, *shade);
    match encode(&prog, update, shade) {
        Some(bytes) => bytes,
        None => {
            // Dangling target or an out-of-range branch slipped through: discard
            // the optimized program and ship the original bytes/entries.
            *update = u0;
            *shade = s0;
            code.to_vec()
        }
    }
}

/// Decoded program: instructions (each with a stable id) plus the two
/// entry-point ids (`None` = no such entry). `next_id` hands out fresh ids for
/// instructions the passes synthesize.
struct Prog {
    ins: Vec<Ins>,
    update: Option<u32>,
    shade: Option<u32>,
    next_id: u32,
}

impl Prog {
    fn fresh_id(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
    /// Ids referenced as a branch/call target or an entry point — an
    /// instruction with such an id must not be deleted or its referent dangles.
    fn referenced(&self) -> HashSet<u32> {
        let mut r: HashSet<u32> = self
            .ins
            .iter()
            .filter(|i| is_ctrl_target_op(i.op))
            .map(|i| i.target)
            .collect();
        r.extend(self.update);
        r.extend(self.shade);
        r
    }
}

fn decode(code: &[u8], update: u16, shade: u16) -> Option<Prog> {
    // First walk: byte offset -> instruction index (== id at decode time).
    let mut offs: Vec<usize> = Vec::new();
    let mut pc = 0usize;
    while pc < code.len() {
        let len = op_len(code, pc)?;
        if len == 0 || pc + len > code.len() {
            return None;
        }
        offs.push(pc);
        pc += len;
    }
    let idx_of: HashMap<usize, u32> =
        offs.iter().enumerate().map(|(i, &o)| (o, i as u32)).collect();
    let resolve = |byte: usize| -> Option<u32> { idx_of.get(&byte).copied() };

    let mut ins = Vec::with_capacity(offs.len());
    for (i, &o) in offs.iter().enumerate() {
        let opc = code[o];
        let len = op_len(code, o)?;
        let (ops, target) = if let Some(prefix) = branch_prefix(opc) {
            let rel_at = o + 1 + prefix;
            let rel = i16::from_le_bytes([code[rel_at], code[rel_at + 1]]);
            let target_byte = (rel_at as isize + 2 + rel as isize) as usize;
            (code[o + 1..rel_at].to_vec(), resolve(target_byte)?)
        } else if opc == op::CALL {
            let target_byte = u16::from_le_bytes([code[o + 1], code[o + 2]]) as usize;
            (Vec::new(), resolve(target_byte)?)
        } else {
            (code[o + 1..o + len].to_vec(), 0)
        };
        ins.push(Ins { id: i as u32, op: opc, ops, target });
    }

    let entry = |e: u16| -> Option<Option<u32>> {
        if e == NO_ENTRY {
            Some(None)
        } else {
            resolve(e as usize).map(Some)
        }
    };
    Some(Prog {
        ins,
        update: entry(update)?,
        shade: entry(shade)?,
        next_id: offs.len() as u32,
    })
}

/// Re-encode to bytes, repointing entries. `None` if a target id is missing
/// (dangling) or a relative branch no longer fits `i16` — callers fall back to
/// the original bytes.
fn encode(prog: &Prog, update: &mut u16, shade: &mut u16) -> Option<Vec<u8>> {
    // Byte offset of each instruction id.
    let mut id_off: HashMap<u32, usize> = HashMap::with_capacity(prog.ins.len());
    let mut p = 0usize;
    for ii in &prog.ins {
        id_off.insert(ii.id, p);
        p += ii.enc_len();
    }

    let mut out = Vec::with_capacity(p);
    for ii in &prog.ins {
        let here = id_off[&ii.id];
        out.push(ii.op);
        if is_branch(ii.op) {
            out.extend_from_slice(&ii.ops); // branch prefix bytes (e.g. BrCmpI kind)
            let dst = *id_off.get(&ii.target)?;
            // rel is measured from the byte after the 2-byte i16.
            let rel = dst as isize - (here + 1 + ii.ops.len() + 2) as isize;
            out.extend_from_slice(&i16::try_from(rel).ok()?.to_le_bytes());
        } else if ii.op == op::CALL {
            let dst = *id_off.get(&ii.target)?;
            out.extend_from_slice(&u16::try_from(dst).ok()?.to_le_bytes());
        } else {
            out.extend_from_slice(&ii.ops);
        }
    }
    *update = match prog.update {
        Some(id) => u16::try_from(*id_off.get(&id)?).ok()?,
        None => NO_ENTRY,
    };
    *shade = match prog.shade {
        Some(id) => u16::try_from(*id_off.get(&id)?).ok()?,
        None => NO_ENTRY,
    };
    Some(out)
}

// -- const pool helpers -------------------------------------------------------

fn intern(consts: &mut Vec<u32>, bits: u32) -> Option<u16> {
    if let Some(i) = consts.iter().position(|&c| c == bits) {
        return Some(i as u16);
    }
    if consts.len() >= u16::MAX as usize {
        return None;
    }
    consts.push(bits);
    Some((consts.len() - 1) as u16)
}

/// The constant word a `PushConst` instruction pushes (raw 32 bits).
fn const_bits(ins: &Ins, consts: &[u32]) -> Option<u32> {
    if ins.op != op::PUSH_CONST {
        return None;
    }
    let idx = u16::from_le_bytes([ins.ops[0], ins.ops[1]]) as usize;
    consts.get(idx).copied()
}

// -- pass: constant folding ---------------------------------------------------

/// Fold `PushConst a; PushConst b; <scalar binop>` and `PushConst a; <unop>`
/// into a single `PushConst`. Every fold reproduces `fx_vm::run`'s exact
/// arithmetic (wrapping ints, `>>frac` fixed, IEEE `f32`) so the constant equals
/// what the interpreter would have computed.
fn fold_constants(prog: &mut Prog, consts: &mut Vec<u32>) -> bool {
    let mut changed = false;
    let mut i = 0usize;
    while i < prog.ins.len() {
        let refd = prog.referenced();
        // Binary: two constants then a scalar binop.
        if i + 2 < prog.ins.len()
            && window_deletable(&prog.ins, i, 3, &refd)
        {
            if let (Some(a), Some(b)) = (
                const_bits(&prog.ins[i], consts),
                const_bits(&prog.ins[i + 1], consts),
            ) {
                if let Some(res) = fold_binop(&prog.ins[i + 2], a, b) {
                    if let Some(idx) = intern(consts, res) {
                        let id = prog.fresh_id();
                        prog.ins.splice(
                            i..i + 3,
                            [Ins { id, op: op::PUSH_CONST, ops: idx.to_le_bytes().to_vec(), target: 0 }],
                        );
                        changed = true;
                        continue;
                    }
                }
            }
        }
        // Unary: one constant then a scalar unop.
        if i + 1 < prog.ins.len() && window_deletable(&prog.ins, i, 2, &refd) {
            if let Some(a) = const_bits(&prog.ins[i], consts) {
                if let Some(res) = fold_unop(&prog.ins[i + 1], a) {
                    if let Some(idx) = intern(consts, res) {
                        let id = prog.fresh_id();
                        prog.ins.splice(
                            i..i + 2,
                            [Ins { id, op: op::PUSH_CONST, ops: idx.to_le_bytes().to_vec(), target: 0 }],
                        );
                        changed = true;
                        continue;
                    }
                }
            }
        }
        i += 1;
    }
    changed
}

/// True if none of the `n` instructions at `[i, i+n)` are the referent of a
/// branch/call/entry (so the window can be safely replaced/removed).
fn window_deletable(ins: &[Ins], i: usize, n: usize, refd: &HashSet<u32>) -> bool {
    ins[i..i + n].iter().all(|x| !refd.contains(&x.id))
}

/// Fold a scalar binary op over two constant words. `None` = not foldable
/// (non-scalar, non-arithmetic, or a would-be divide-by-zero we leave to the VM).
fn fold_binop(ins: &Ins, a: u32, b: u32) -> Option<u32> {
    let scalar1 = |ops: &[u8]| ops.first().copied() == Some(1);
    let (af, bf) = (f32::from_bits(a), f32::from_bits(b));
    let (ai, bi) = (a as i32, b as i32);
    Some(match ins.op {
        op::ADD if scalar1(&ins.ops) => (af + bf).to_bits(),
        op::SUB if scalar1(&ins.ops) => (af - bf).to_bits(),
        op::MUL if scalar1(&ins.ops) => (af * bf).to_bits(),
        op::DIV if scalar1(&ins.ops) => (af / bf).to_bits(),
        op::ADD_I => ai.wrapping_add(bi) as u32,
        op::SUB_I => ai.wrapping_sub(bi) as u32,
        op::MUL_I => ai.wrapping_mul(bi) as u32,
        op::DIV_I if bi != 0 => ai.wrapping_div(bi) as u32,
        op::MOD_I if bi != 0 => ai.wrapping_rem(bi) as u32,
        op::MIN_I => if ai < bi { a } else { b },
        op::MAX_I => if ai > bi { a } else { b },
        op::MUL_FIX => (((ai as i64 * bi as i64) >> 16) as i32) as u32,
        op::DIV_FIX if bi != 0 => ((((ai as i64) << 16) / bi as i64) as i32) as u32,
        op::MUL_FIX_N => {
            let frac = ins.ops[0] as u32;
            (((ai as i64 * bi as i64) >> frac) as i32) as u32
        }
        op::DIV_FIX_N if bi != 0 => {
            let frac = ins.ops[0] as u32;
            ((((ai as i64) << frac) / bi as i64) as i32) as u32
        }
        _ => return None,
    })
}

/// Fold a scalar unary op over one constant word.
fn fold_unop(ins: &Ins, a: u32) -> Option<u32> {
    let scalar1 = |ops: &[u8]| ops.first().copied() == Some(1);
    let ai = a as i32;
    Some(match ins.op {
        op::NEG if scalar1(&ins.ops) => (-f32::from_bits(a)).to_bits(),
        op::NEG_I => ai.wrapping_neg() as u32,
        op::ABS_I => ai.wrapping_abs() as u32,
        op::I2F => (ai as f32).to_bits(),
        op::F2I => (f32::from_bits(a) as i32) as u32,
        op::FIX_RESCALE => {
            let sh = ins.ops[0] as i8;
            if sh >= 0 {
                ai.wrapping_shl(sh as u32) as u32
            } else {
                (ai >> ((-(sh as i32)) as u32)) as u32
            }
        }
        _ => return None,
    })
}

// -- pass: algebraic simplification & strength reduction ----------------------

/// Remove identity operations: `x * 1`, `x / 1`, `x - 0` (and their int /
/// Q16.16 twins), plus `-(-x)` involutions. Each removes a balanced
/// `PushConst; <op>` (net stack effect nil) or a `NEG; NEG` pair, so it is safe
/// regardless of what produced `x`. NB: float `x + 0.0` is intentionally *not*
/// folded — it flushes `-0.0` to `+0.0`, so it is not a true identity.
fn simplify_algebraic(prog: &mut Prog, consts: &[u32]) -> bool {
    const F_ZERO: u32 = 0; // 0.0f32
    const F_ONE: u32 = 0x3f80_0000; // 1.0f32
    const FIX_ONE: u32 = 1 << 16; // Q16.16 1.0
    let scalar1 = |ops: &[u8]| ops.first().copied() == Some(1);
    let mut changed = false;
    let mut i = 0usize;
    while i + 1 < prog.ins.len() {
        let refd = prog.referenced();
        if !window_deletable(&prog.ins, i, 2, &refd) {
            i += 1;
            continue;
        }
        // `PushConst k; OP` identities.
        if let Some(k) = const_bits(&prog.ins[i], consts) {
            let next = &prog.ins[i + 1];
            let identity = match next.op {
                op::SUB if scalar1(&next.ops) => k == F_ZERO,
                op::MUL | op::DIV if scalar1(&next.ops) => k == F_ONE,
                op::SCALE => k == F_ONE, // vec * 1.0
                op::ADD_I | op::SUB_I => k == 0,
                op::MUL_I => k == 1,
                op::MUL_FIX | op::DIV_FIX => k == FIX_ONE,
                _ => false,
            };
            if identity {
                prog.ins.drain(i..i + 2);
                changed = true;
                continue;
            }
        }
        // `NEG n; NEG n` and `NEG_I; NEG_I` involutions.
        let (a, b) = (&prog.ins[i], &prog.ins[i + 1]);
        let involution = (a.op == op::NEG && b.op == op::NEG && a.ops == b.ops)
            || (a.op == op::NEG_I && b.op == op::NEG_I);
        if involution {
            prog.ins.drain(i..i + 2);
            changed = true;
            continue;
        }
        i += 1;
    }
    changed
}

// -- pass: constant-condition branch folding ----------------------------------

/// `PushConst c; BrFalse t` with a compile-time-known `c`: drop to an
/// unconditional `Jmp t` (c == 0) or delete both (c != 0). Feeds `remove_unreachable`.
fn fold_branches(prog: &mut Prog, consts: &[u32]) -> bool {
    let mut changed = false;
    let mut i = 0usize;
    while i + 1 < prog.ins.len() {
        let refd = prog.referenced();
        // The BrFalse (i+1) may itself be a branch target (a loop back-edge lands
        // on the condition test); replacing it in place keeps its id, so only the
        // PushConst (i) must be unreferenced.
        if prog.ins[i + 1].op == op::BR_FALSE && !refd.contains(&prog.ins[i].id) {
            if let Some(c) = const_bits(&prog.ins[i], consts) {
                let br_id = prog.ins[i + 1].id;
                let target = prog.ins[i + 1].target;
                if f32::from_bits(c) == 0.0 {
                    // Condition always false -> always branch (keep the id).
                    prog.ins.splice(
                        i..i + 2,
                        [Ins { id: br_id, op: op::JMP, ops: Vec::new(), target }],
                    );
                } else {
                    // Condition always true -> fall through.
                    prog.ins.drain(i..i + 2);
                }
                changed = true;
                continue;
            }
        }
        i += 1;
    }
    changed
}

// -- pass: unreachable-code elimination ---------------------------------------

/// Remove instructions not reachable from either entry via the CFG (a `Jmp`
/// after an `if/else` leaves the other arm's terminator dead; `fold_branches`
/// creates fresh unreachable regions).
fn remove_unreachable(prog: &mut Prog) -> bool {
    let n = prog.ins.len();
    if n == 0 {
        return false;
    }
    let pos_of: HashMap<u32, usize> =
        prog.ins.iter().enumerate().map(|(p, ii)| (ii.id, p)).collect();
    let mut reachable = vec![false; n];
    let mut stack: Vec<usize> = Vec::new();
    for e in [prog.update, prog.shade].into_iter().flatten() {
        if let Some(&p) = pos_of.get(&e) {
            stack.push(p);
        }
    }
    while let Some(i) = stack.pop() {
        if i >= n || reachable[i] {
            continue;
        }
        reachable[i] = true;
        let ii = &prog.ins[i];
        let goto = |id: u32, s: &mut Vec<usize>| {
            if let Some(&p) = pos_of.get(&id) {
                s.push(p);
            }
        };
        match ii.op {
            op::JMP => goto(ii.target, &mut stack),
            op::RET | op::RET_FN | op::RET_RGB8 | op::RET_RGB_FIX => {}
            op::BR_FALSE | op::BR_CMP_I | op::CALL => {
                goto(ii.target, &mut stack);
                stack.push(i + 1);
            }
            _ => stack.push(i + 1),
        }
    }
    if reachable.iter().all(|&r| r) {
        return false;
    }
    let mut i = 0usize;
    prog.ins.retain(|_| {
        let keep = reachable[i];
        i += 1;
        keep
    });
    true
}

// -- pass: dead local elimination ---------------------------------------------

/// Remove `StoreLocal s,n; LoadLocal s,n` (adjacent, same slot & width) when the
/// slot range `[s, s+n)` is touched *nowhere else* in the program — i.e. a
/// single-assignment, single-use temp. Dropping both leaves the value on the
/// stack exactly where the reload put it. Conservative: any dynamic-index local
/// op (`LoadLocalIdx`/`StoreLocalIdx`) could alias an arbitrary slot, so its
/// presence disables the pass.
fn eliminate_dead_locals(prog: &mut Prog) -> bool {
    let has_dyn = prog
        .ins
        .iter()
        .any(|i| i.op == op::LOAD_LOCAL_IDX || i.op == op::STORE_LOCAL_IDX);
    if has_dyn {
        return false;
    }
    // Count references to each local slot from every static local op — including
    // the superinstructions the fusion pass may have already produced (they too
    // read/write a local), so a fused counter/temp is never miscounted as unused.
    let mut touch: HashMap<u8, u32> = HashMap::new();
    for ii in &prog.ins {
        let (slot, n) = match ii.op {
            op::LOAD_LOCAL | op::STORE_LOCAL | op::FILL_LOCAL | op::TEE_LOCAL => {
                (ii.ops[0], ii.ops[1])
            }
            op::INC_LOCAL_I => (ii.ops[0], 1),
            _ => continue,
        };
        for s in slot..slot.saturating_add(n) {
            *touch.entry(s).or_insert(0) += 1;
        }
    }

    let mut changed = false;
    let mut i = 0usize;
    while i + 1 < prog.ins.len() {
        let refd = prog.referenced();
        let (a, b) = (&prog.ins[i], &prog.ins[i + 1]);
        if a.op == op::STORE_LOCAL
            && b.op == op::LOAD_LOCAL
            && a.ops == b.ops
            && window_deletable(&prog.ins, i, 2, &refd)
        {
            let (slot, n) = (a.ops[0], a.ops[1]);
            // The store contributes 1 touch and the load 1 touch per slot; if the
            // whole range is touched exactly twice, this pair is the only user.
            let solo =
                (slot..slot.saturating_add(n)).all(|s| touch.get(&s).copied() == Some(2));
            if solo {
                prog.ins.drain(i..i + 2);
                for s in slot..slot.saturating_add(n) {
                    touch.remove(&s);
                }
                changed = true;
                continue;
            }
        }
        i += 1;
    }
    changed
}

// -- pass: superinstruction fusion --------------------------------------------

/// Fuse the profiler's hottest opcode sequences into the VM's superinstructions
/// (see `fx_vm::Op`): the integer loop-condition tail (`CmpI; BrFalse` →
/// `BrCmpI`), the compound-add counter idiom (`LoadLocal; PushConst; AddI;
/// StoreLocal` → `IncLocalI`), and the temp reload (`StoreLocal; LoadLocal` →
/// `TeeLocal`). Each is an exact fusion, so the differential test still holds.
/// A window is only fused when none of the instructions it consumes is a
/// branch/call/entry target (a jump landing mid-window would change meaning).
fn fuse_superinstructions(prog: &mut Prog, consts: &[u32]) -> bool {
    let mut changed = false;
    let mut i = 0usize;
    while i < prog.ins.len() {
        let refd = prog.referenced();

        // `i = i + k`: LoadLocal s,1 ; PushConst k(int) ; AddI ; StoreLocal s,1.
        if i + 3 < prog.ins.len() && window_deletable(&prog.ins, i, 4, &refd) {
            let w = &prog.ins[i..i + 4];
            if w[0].op == op::LOAD_LOCAL
                && w[0].ops.len() == 2
                && w[0].ops[1] == 1 // width 1 (scalar counter)
                && w[1].op == op::PUSH_CONST
                && w[2].op == op::ADD_I
                && w[3].op == op::STORE_LOCAL
                && w[3].ops == w[0].ops
            {
                let slot = w[0].ops[0];
                let cidx = [w[1].ops[0], w[1].ops[1]];
                let _ = consts; // (const stays in the pool, referenced by idx)
                let id = prog.fresh_id();
                let ops = vec![slot, cidx[0], cidx[1]];
                prog.ins
                    .splice(i..i + 4, [Ins { id, op: op::INC_LOCAL_I, ops, target: 0 }]);
                changed = true;
                continue;
            }
        }

        // Integer loop condition: CmpI kind ; BrFalse rel  ->  BrCmpI kind, rel.
        if i + 1 < prog.ins.len() && window_deletable(&prog.ins, i, 2, &refd) {
            let (a, b) = (&prog.ins[i], &prog.ins[i + 1]);
            if a.op == op::CMP_I && b.op == op::BR_FALSE {
                let kind = a.ops[0];
                let target = b.target;
                let id = prog.fresh_id();
                prog.ins.splice(
                    i..i + 2,
                    [Ins { id, op: op::BR_CMP_I, ops: vec![kind], target }],
                );
                changed = true;
                continue;
            }
        }

        // Temp reload: StoreLocal s,n ; LoadLocal s,n  ->  TeeLocal s,n.
        if i + 1 < prog.ins.len() && window_deletable(&prog.ins, i, 2, &refd) {
            let (a, b) = (&prog.ins[i], &prog.ins[i + 1]);
            if a.op == op::STORE_LOCAL && b.op == op::LOAD_LOCAL && a.ops == b.ops {
                let ops = a.ops.clone();
                let id = prog.fresh_id();
                prog.ins
                    .splice(i..i + 2, [Ins { id, op: op::TEE_LOCAL, ops, target: 0 }]);
                changed = true;
                continue;
            }
        }
        i += 1;
    }
    changed
}
