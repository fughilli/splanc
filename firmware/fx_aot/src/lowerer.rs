//! The lowering: static operand-stack-depth analysis over the CFG, then RV32IM
//! emission with fixed slot homes (s2..s9 for slots 0..7, a frame for deeper
//! slots), inline integer/control codegen and helper calls for the rest.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::vec::Vec;

use ledmapper_fx_jit::op_len;
use ledmapper_fx_vm::{self as fxv, Op};

use crate::ctx::{HELPER_OFF, OUT_OFF, RET_FRAC_OFF, RET_KIND_OFF, RET_RET, RET_RGB8, RET_RGBFIX};
use crate::enc::*;
use crate::reg::*;
use crate::verify;
use crate::{deep_off, effect, Kind, DEFAULT_BUDGET, WIN_OFF, WIN_WORDS};

/// Load the raw 32-bit bits of const-pool entry `idx` (little-endian).
fn const_bits(prog: &fxv::Program, idx: usize) -> i32 {
    let c = prog.consts_raw();
    let o = idx * 4;
    i32::from_le_bytes([
        *c.get(o).unwrap_or(&0),
        *c.get(o + 1).unwrap_or(&0),
        *c.get(o + 2).unwrap_or(&0),
        *c.get(o + 3).unwrap_or(&0),
    ])
}

fn rd_u16(code: &[u8], o: usize) -> usize {
    u16::from_le_bytes([code[o], code[o + 1]]) as usize
}
fn rel16(code: &[u8], o: usize) -> isize {
    i16::from_le_bytes([code[o], code[o + 1]]) as isize
}

/// Branch target of a branch/jump op at `pc`, else `None`.
fn target_of(code: &[u8], pc: usize) -> Option<usize> {
    match Op::from_u8(code[pc])? {
        Op::BrFalse | Op::Jmp => Some((pc as isize + 3 + rel16(code, pc + 1)) as usize),
        Op::BrCmpI => Some((pc as isize + 4 + rel16(code, pc + 2)) as usize),
        _ => None,
    }
}

fn is_terminal(op: Op) -> bool {
    matches!(op, Op::Ret | Op::RetRgb8 | Op::RetRgbFix)
}

/// Lower one entry (`update` or `shade`) into `out`, appending its words.
pub(crate) fn lower_body(prog: &fxv::Program, entry: usize, out: &mut Vec<u32>) -> Option<()> {
    let code = prog.code();

    // --- 1. Static depth analysis (worklist over the CFG) --------------------
    let mut depth: BTreeMap<usize, usize> = BTreeMap::new();
    let mut headers: BTreeSet<usize> = BTreeSet::new();
    let mut work: Vec<(usize, usize)> = alloc::vec![(entry, 0)];
    headers.insert(entry);
    while let Some((pc, d)) = work.pop() {
        if pc >= code.len() {
            return None;
        }
        if let Some(&old) = depth.get(&pc) {
            if old != d {
                return None; // inconsistent depth at a join — bail to the VM
            }
            continue;
        }
        depth.insert(pc, d);
        let op = Op::from_u8(code[pc])?;
        let (pop, push, kind) = effect(code, pc)?;
        if kind == Kind::No {
            return None;
        }
        if d < pop {
            return None;
        }
        let nd = d - pop + push;
        if nd > fxv::MAX_STACK {
            return None;
        }
        // Validate static slot operands are in range (loads/stores).
        if !operands_in_range(code, pc, op) {
            return None;
        }
        let len = op_len(code, pc)?;
        if is_terminal(op) {
            continue;
        }
        match op {
            Op::Jmp => {
                let t = target_of(code, pc)?;
                headers.insert(t);
                work.push((t, nd));
            }
            Op::BrFalse | Op::BrCmpI => {
                let t = target_of(code, pc)?;
                headers.insert(t);
                headers.insert(pc + len); // fallthrough starts a block
                work.push((t, nd));
                work.push((pc + len, nd));
            }
            _ => work.push((pc + len, nd)),
        }
    }

    // Per-header block op-count (for the per-block budget decrement).
    let pcs: Vec<usize> = depth.keys().copied().collect();
    let mut block_ops: BTreeMap<usize, i32> = BTreeMap::new();
    {
        let mut cur_header = None;
        let mut count = 0i32;
        for &pc in &pcs {
            if headers.contains(&pc) {
                if let Some(h) = cur_header {
                    block_ops.insert(h, count);
                }
                cur_header = Some(pc);
                count = 0;
            }
            count += 1;
        }
        if let Some(h) = cur_header {
            block_ops.insert(h, count);
        }
    }
    // One canonical check per block: its decrement must fit the `addi` immediate.
    if block_ops.values().any(|&n| n > verify::MAX_BUDGET_STEP) {
        return None;
    }

    // --- 2. Emission ---------------------------------------------------------
    let mut e = Emit {
        out,
        pc_word: BTreeMap::new(),
        fixups: Vec::new(),
    };
    let func_start = e.out.len();
    e.prologue();
    for &pc in &pcs {
        e.pc_word.insert(pc, e.out.len());
        if let Some(&n) = block_ops.get(&pc) {
            e.budget_block(n);
        }
        e.op(prog, code, pc, depth[&pc])?;
    }
    // Shared epilogues at the end of the function.
    let budget_exit = e.out.len();
    e.emit_budget_exit();
    let epilogue = e.out.len();
    e.epilogue();
    e.patch(func_start, budget_exit, epilogue)?;
    Some(())
}

/// Validate a load/store op's static slot/count operands are in range (so the
/// inline codegen can skip per-access bounds checks, as the VM's verified path
/// would). Returns false to bail to the VM.
fn operands_in_range(code: &[u8], pc: usize, op: Op) -> bool {
    let b = |k: usize| code[pc + 1 + k] as usize;
    match op {
        Op::LoadLocal | Op::StoreLocal | Op::TeeLocal | Op::FillLocal => {
            b(0) + b(1) <= fxv::MAX_LOCALS
        }
        Op::LoadState | Op::StoreState => b(0) + b(1) <= fxv::MAX_STATE,
        Op::IncLocalI => b(0) < fxv::MAX_LOCALS,
        Op::PushConst => rd_u16(code, pc + 1) * 4 + 4 <= 0x1_0000, // sane const idx
        _ => true,
    }
}

struct Fixup {
    word: usize,   // index of the branch/jump instruction word
    target: usize, // target pc (resolved via pc_word)
    is_jal: bool,
    budget: bool, // branch to the shared budget-exit (target ignored)
    epi: bool,    // jump to the shared epilogue (target ignored)
}

struct Emit<'a> {
    out: &'a mut Vec<u32>,
    pc_word: BTreeMap<usize, usize>,
    fixups: Vec<Fixup>,
}

impl Emit<'_> {
    fn push(&mut self, w: u32) {
        self.out.push(w);
    }

    /// Materialize a 32-bit immediate into `rd` (lui + addi).
    fn li(&mut self, rd: u32, val: i32) {
        let lo = (val << 20) >> 20; // sign-extended low 12 bits
        let hi = ((val - lo) >> 12) & 0xf_ffff;
        self.push(lui(rd, hi as u32));
        self.push(addi(rd, rd, lo));
    }

    /// The verifier's exact prologue (save ra/s0..s11, s0/s1/s11 from a0..a2,
    /// s10 = budget).
    fn prologue(&mut self) {
        self.out
            .extend_from_slice(&verify::prologue_words(DEFAULT_BUDGET));
    }

    /// The verifier's exact epilogue (restore, release, `ret`).
    fn epilogue(&mut self) {
        self.out.extend_from_slice(&verify::epilogue_words());
    }

    /// Per-block budget: `s10 -= n; if s10 >= 0 skip; jal budget_exit`. The
    /// skip-branch is a fixed +2 words (always in range); the far jump to the
    /// shared exit uses `jal` (±1 MiB).
    fn budget_block(&mut self, n: i32) {
        // addi s10,s10,-n; bge s10,x0,+8 (skip the jal when s10 >= 0)
        self.out.extend_from_slice(&verify::budget_check_head(n));
        let word = self.out.len();
        self.push(jal(ZERO, 0)); // patched to budget_exit
        self.fixups.push(Fixup {
            word,
            target: 0,
            is_jal: true,
            budget: true,
            epi: false,
        });
    }

    /// out = [0,0,0]; ret_kind = RET_RET; falls into the epilogue emitted
    /// right after (the verifier requires exactly this stub + epilogue).
    fn emit_budget_exit(&mut self) {
        self.out.extend_from_slice(&verify::exit_stub_words());
    }

    /// Read operand slot `i` (depth-relative) into a register usable as a source.
    /// For slots 0..7 that is the home register; deeper slots are loaded into
    /// `scratch` from the frame.
    fn slot_src(&mut self, i: usize, scratch: u32) -> u32 {
        if i < 8 {
            slot(i)
        } else {
            self.push(lw(scratch, S1, (deep_off(i) * 4) as i32));
            scratch
        }
    }

    /// Write `src` into operand slot `i`.
    fn slot_dst(&mut self, i: usize, src: u32) {
        if i < 8 {
            if slot(i) != src {
                self.push(addi(slot(i), src, 0));
            }
        } else {
            self.push(sw(src, S1, (deep_off(i) * 4) as i32));
        }
    }

    /// Emit one opcode. `d` is the operand-stack depth on entry.
    fn op(&mut self, prog: &fxv::Program, code: &[u8], pc: usize, d: usize) -> Option<()> {
        let op = Op::from_u8(code[pc])?;
        let b = |k: usize| code[pc + 1 + k] as usize;
        let (pop, push, kind) = effect(code, pc)?;
        let base = d - pop;
        match kind {
            Kind::Helper => self.helper_call(code, pc, base, pop, push),
            Kind::Ret => self.emit_ret(op, code, pc, d),
            Kind::Inline => self.inline(prog, code, pc, op, b, d, base),
            Kind::No => return None,
        }
        Some(())
    }

    /// Spill the top `pop` slots into the window, call the generic helper, then
    /// reload the `push` result slots.
    fn helper_call(&mut self, code: &[u8], pc: usize, base: usize, pop: usize, push: usize) {
        if self.direct_op(code, pc, base) {
            return;
        }
        for k in 0..pop {
            let r = self.slot_src(base + k, T0);
            self.push(sw(r, S1, ((WIN_OFF + k) * 4) as i32));
        }
        self.push(addi(A0, S0, 0)); // ctx
        self.push(addi(A1, S1, (WIN_OFF * 4) as i32)); // win ptr
        self.li(A2, code[pc] as i32); // op byte
        self.li(A3, (pc + 1) as i32); // operand byte offset in code
        self.push(lw(T0, S0, HELPER_OFF)); // helper pointer in ctx
        self.push(jalr(RA, T0, 0));
        for k in 0..push {
            self.push(lw(T1, S1, ((WIN_OFF + k) * 4) as i32));
            self.slot_dst(base + k, T1);
        }
        let _ = (pc, WIN_WORDS);
    }

    /// Move only the consumed operands. All other slots keep their callee-saved
    /// register homes (or their existing deep-frame homes) across the call.
    fn direct_args(&mut self, args: &[usize]) {
        for (i, &src) in args.iter().enumerate() {
            let dst = A0 + i as u32;
            let r = self.slot_src(src, dst);
            if r != dst {
                self.push(addi(dst, r, 0));
            }
        }
    }

    fn direct_call(&mut self, id: crate::direct::Id) {
        let off = crate::ctx::DIRECT_OFF + id as i32 * crate::direct::STRIDE;
        self.push(lw(T0, S0, off));
        self.push(jalr(RA, T0, 0));
    }

    /// Lane-wise operations write only their own first input lane; subsequent
    /// lanes therefore remain live through all calls.
    fn direct_lanes(&mut self, id: crate::direct::Id, base: usize, n: usize, arity: usize) {
        for lane in 0..n {
            let mut args = [0; 3];
            for (k, arg) in args.iter_mut().enumerate().take(arity) {
                *arg = base + k * n + lane;
            }
            self.direct_args(&args[..arity]);
            self.direct_call(id);
            self.slot_dst(base + lane, A0);
        }
    }

    fn direct_op(&mut self, code: &[u8], pc: usize, base: usize) -> bool {
        use crate::direct::Id;
        let op = Op::from_u8(code[pc]).unwrap();
        let b = |k: usize| code[pc + 1 + k] as usize;
        let (id, n, arity) = match op {
            Op::Add => (Id::Add, b(0), 2),
            Op::Sub => (Id::Sub, b(0), 2),
            Op::Mul => (Id::Mul, b(0), 2),
            Op::Div => (Id::Div, b(0), 2),
            Op::Neg => (Id::Neg, b(0), 1),
            // These VM arms choose NaN payloads in a different operand order
            // after optimization. Keep their existing exact window helper.
            Op::Scale | Op::Mix => return false,
            Op::UnMath => {
                let id = match b(0) as u8 {
                    fxv::F_SIN => Id::Sin,
                    fxv::F_COS => Id::Cos,
                    fxv::F_ABS => Id::Abs,
                    fxv::F_FLOOR => Id::Floor,
                    fxv::F_CEIL => Id::Ceil,
                    fxv::F_FRACT => Id::Fract,
                    fxv::F_SQRT => Id::Sqrt,
                    fxv::F_EXP => Id::Exp,
                    fxv::F_LOG => Id::Log,
                    fxv::F_SIGN => Id::Sign,
                    fxv::F_TAN => Id::Tan,
                    _ => return false,
                };
                (id, b(1), 1)
            }
            Op::BinMath => {
                let id = match b(0) as u8 {
                    fxv::B_MIN => Id::Min,
                    fxv::B_MAX => Id::Max,
                    fxv::B_POW => Id::Pow,
                    fxv::B_MOD => Id::Mod,
                    fxv::B_STEP => Id::Step,
                    fxv::B_ATAN2 => Id::Atan2,
                    _ => return false,
                };
                (id, b(1), 2)
            }
            Op::Clamp => (Id::Clamp, b(0), 3),
            Op::Smoothstep => (Id::Smoothstep, b(0), 3),
            Op::Cmp => {
                let id = match b(0) {
                    0 => Id::Lt,
                    1 => Id::Le,
                    2 => Id::Gt,
                    3 => Id::Ge,
                    4 => Id::Eq,
                    _ => Id::Ne,
                };
                (id, 1, 2)
            }
            Op::Logic => match b(0) {
                0 => (Id::And, 1, 2),
                2 => (Id::Not, 1, 1),
                _ => (Id::Or, 1, 2),
            },
            Op::Hash1 => (Id::Hash1, 1, 1),
            Op::Hash3 => (Id::Hash3, 1, 3),
            Op::I2F => (Id::I2F, 1, 1),
            Op::F2I => (Id::F2I, 1, 1),
            Op::Fix2F => (Id::Fix2F, 1, 1),
            Op::F2Fix => (Id::F2Fix, 1, 1),
            Op::FixToF | Op::FixFromF => {
                self.direct_args(&[base]);
                self.li(A1, b(0) as i32);
                self.direct_call(if op == Op::FixToF {
                    Id::FixToF
                } else {
                    Id::FixFromF
                });
                self.slot_dst(base, A0);
                return true;
            }
            Op::Hsv2Rgb | Op::Palette => {
                if op == Op::Hsv2Rgb {
                    self.direct_args(&[base, base + 1, base + 2]);
                } else {
                    self.direct_args(&[base]);
                    self.li(A1, b(0) as i32);
                }
                // RV32's C ABI returns at most two words in registers. Only
                // blue uses a fixed output word; no colour inputs are spilled.
                self.push(addi(A3, S1, (WIN_OFF * 4) as i32));
                self.direct_call(if op == Op::Hsv2Rgb {
                    Id::Hsv2Rgb
                } else {
                    Id::Palette
                });
                self.slot_dst(base, A0);
                self.slot_dst(base + 1, A1);
                self.push(lw(T1, S1, (WIN_OFF * 4) as i32));
                self.slot_dst(base + 2, T1);
                return true;
            }
            _ => return false,
        };
        self.direct_lanes(id, base, n, arity);
        true
    }

    fn emit_ret(&mut self, op: Op, code: &[u8], pc: usize, d: usize) {
        let (n, kind, frac) = match op {
            Op::Ret => (code[pc + 1] as usize, RET_RET, 0u32),
            Op::RetRgb8 => (3, RET_RGB8, 0),
            _ => (3, RET_RGBFIX, code[pc + 1] as u32),
        };
        let base = d.saturating_sub(n);
        for k in 0..n.min(3) {
            let r = self.slot_src(base + k, T0);
            self.push(sw(r, S0, OUT_OFF + (k * 4) as i32));
        }
        self.li(T0, kind as i32);
        self.push(sw(T0, S0, RET_KIND_OFF));
        if kind == RET_RGBFIX {
            self.li(T0, frac as i32);
            self.push(sw(T0, S0, RET_FRAC_OFF));
        }
        // jump to epilogue
        let word = self.out.len();
        self.push(jal(ZERO, 0));
        self.fixups.push(Fixup {
            word,
            target: 0,
            is_jal: true,
            budget: false,
            epi: true,
        });
    }

    #[allow(clippy::too_many_arguments)]
    fn inline(
        &mut self,
        prog: &fxv::Program,
        code: &[u8],
        pc: usize,
        op: Op,
        b: impl Fn(usize) -> usize,
        d: usize,
        base: usize,
    ) {
        match op {
            Op::PushConst => {
                let idx = rd_u16(code, pc + 1);
                let bits = const_bits(prog, idx);
                if d < 8 {
                    self.li(slot(d), bits);
                } else {
                    self.li(T0, bits);
                    self.slot_dst(d, T0);
                }
            }
            Op::Pop => {}
            Op::LoadLocal => {
                let (sl, n) = (b(0), b(1));
                for i in 0..n {
                    self.push(lw(T0, S1, ((sl + i) * 4) as i32));
                    self.slot_dst(d + i, T0);
                }
            }
            Op::StoreLocal => {
                let (sl, n) = (b(0), b(1));
                for i in 0..n {
                    let r = self.slot_src(base + i, T0);
                    self.push(sw(r, S1, ((sl + i) * 4) as i32));
                }
            }
            Op::LoadState => {
                let (sl, n) = (b(0), b(1));
                for i in 0..n {
                    self.push(lw(T0, S11, ((sl + i) * 4) as i32));
                    self.slot_dst(d + i, T0);
                }
            }
            Op::StoreState => {
                let (sl, n) = (b(0), b(1));
                for i in 0..n {
                    let r = self.slot_src(base + i, T0);
                    self.push(sw(r, S11, ((sl + i) * 4) as i32));
                }
            }
            Op::FillLocal => {
                let (sl, n) = (b(0), b(1));
                for i in 0..n {
                    self.push(sw(ZERO, S1, ((sl + i) * 4) as i32));
                }
            }
            Op::TeeLocal => {
                let n = b(1);
                let sl = b(0);
                let top = d - n;
                for i in 0..n {
                    let r = self.slot_src(top + i, T0);
                    self.push(sw(r, S1, ((sl + i) * 4) as i32));
                }
            }
            Op::IncLocalI => {
                let sl = b(0);
                let idx = rd_u16(code, pc + 2);
                let k = const_bits(prog, idx);
                self.push(lw(T0, S1, (sl * 4) as i32));
                self.li(T1, k);
                self.push(add(T0, T0, T1));
                self.push(sw(T0, S1, (sl * 4) as i32));
            }
            Op::AddI | Op::SubI | Op::MulI => {
                let a = self.slot_src(base, T0);
                let bb = self.slot_src(base + 1, T1);
                let r = match op {
                    Op::AddI => add(T2, a, bb),
                    Op::SubI => sub(T2, a, bb),
                    _ => mul(T2, a, bb),
                };
                self.push(r);
                self.slot_dst(base, T2);
            }
            Op::NegI => {
                let a = self.slot_src(base, T0);
                self.push(sub(T2, ZERO, a));
                self.slot_dst(base, T2);
            }
            Op::I2Fix => {
                let a = self.slot_src(base, T0);
                self.push(slli(T2, a, 16));
                self.slot_dst(base, T2);
            }
            Op::Fix2I => {
                let a = self.slot_src(base, T0);
                self.push(srai(T2, a, 16));
                self.slot_dst(base, T2);
            }
            Op::FixRescale => {
                let sh = code[pc + 1] as i8;
                let a = self.slot_src(base, T0);
                if sh >= 0 {
                    self.push(slli(T2, a, (sh as u32) & 31));
                } else {
                    self.push(srai(T2, a, ((-(sh as i32)) as u32) & 31));
                }
                self.slot_dst(base, T2);
            }
            Op::MulFix | Op::MulFixN => {
                let frac = if op == Op::MulFix { 16 } else { b(0) as u32 };
                let a = self.slot_src(base, T0);
                let bb = self.slot_src(base + 1, T1);
                // (a*b)>>frac over the 64-bit product: lo>>frac | hi<<(32-frac).
                self.push(mul(T2, a, bb));
                self.push(mulh(T3, a, bb));
                self.push(srli(T2, T2, frac));
                self.push(slli(T3, T3, 32 - frac));
                self.push(or(T2, T2, T3));
                self.slot_dst(base, T2);
            }
            Op::Swizzle => {
                let (src_n, dst_n) = (b(0), b(1));
                // Copy src window to the scratch window, then scatter.
                for i in 0..src_n {
                    let r = self.slot_src(base + i, T0);
                    self.push(sw(r, S1, ((WIN_OFF + i) * 4) as i32));
                }
                for i in 0..dst_n {
                    let ci = code[pc + 3 + i] as usize;
                    self.push(lw(T0, S1, ((WIN_OFF + ci) * 4) as i32));
                    self.slot_dst(base + i, T0);
                }
            }
            Op::Swap => {
                let (an, bn) = (b(0), b(1));
                for i in 0..an + bn {
                    let r = self.slot_src(base + i, T0);
                    self.push(sw(r, S1, ((WIN_OFF + i) * 4) as i32));
                }
                // new layout: b(bn) then a(an)
                for i in 0..bn {
                    self.push(lw(T0, S1, ((WIN_OFF + an + i) * 4) as i32));
                    self.slot_dst(base + i, T0);
                }
                for i in 0..an {
                    self.push(lw(T0, S1, ((WIN_OFF + i) * 4) as i32));
                    self.slot_dst(base + bn + i, T0);
                }
            }
            Op::Jmp => {
                let word = self.out.len();
                self.push(jal(ZERO, 0));
                let t = target_of(code, pc).unwrap();
                self.fixups.push(Fixup {
                    word,
                    target: t,
                    is_jal: true,
                    budget: false,
                    epi: false,
                });
            }
            Op::BrFalse => {
                let c = self.slot_src(base, T0);
                self.push(addi(T2, c, 0)); // keep value if c is a home reg
                let word = self.out.len();
                self.push(branch(F3_BEQ, T2, ZERO, 0));
                let t = target_of(code, pc).unwrap();
                self.fixups.push(Fixup {
                    word,
                    target: t,
                    is_jal: false,
                    budget: false,
                    epi: false,
                });
            }
            Op::BrCmpI => {
                let kind = code[pc + 1];
                let a = self.slot_src(base, T0);
                let bb = self.slot_src(base + 1, T1);
                // Branch when the comparison is FALSE (mirrors the VM fusion).
                let (f3, swap) = match kind {
                    0 => (F3_BGE, false), // !(a<b)  -> a>=b
                    1 => (F3_BLT, true),  // !(a<=b) -> a>b  -> b<a
                    2 => (F3_BGE, true),  // !(a>b)  -> a<=b -> b>=a
                    3 => (F3_BLT, false), // !(a>=b) -> a<b
                    4 => (F3_BNE, false), // !(a==b) -> a!=b
                    _ => (F3_BEQ, false), // !(a!=b) -> a==b
                };
                let (r1, r2) = if swap { (bb, a) } else { (a, bb) };
                let word = self.out.len();
                self.push(branch(f3, r1, r2, 0));
                let t = target_of(code, pc).unwrap();
                self.fixups.push(Fixup {
                    word,
                    target: t,
                    is_jal: false,
                    budget: false,
                    epi: false,
                });
            }
            _ => unreachable!("inline op {:?}", op),
        }
    }

    /// Resolve all branch/jump fixups to word offsets.
    fn patch(&mut self, _func_start: usize, budget_exit: usize, epilogue: usize) -> Option<()> {
        for f in &self.fixups {
            let tgt_word = if f.budget {
                budget_exit
            } else if f.epi {
                epilogue
            } else {
                *self.pc_word.get(&f.target)?
            };
            let off = (tgt_word as isize - f.word as isize) * 4;
            let w = &mut self.out[f.word];
            // Re-encode the instruction keeping its operands, with the real imm.
            if f.is_jal {
                if !(-(1 << 20)..(1 << 20)).contains(&off) {
                    return None; // jump out of jal range — refuse to the VM
                }
                *w = reencode_jal(*w, off as i32);
            } else {
                if !(-(1 << 12)..(1 << 12)).contains(&off) {
                    return None; // conditional branch out of B-type range — refuse
                }
                *w = reencode_branch(*w, off as i32);
            }
        }
        Some(())
    }
}

/// Replace the immediate of a `jal` word (keeps rd).
fn reencode_jal(w: u32, off: i32) -> u32 {
    let rd = (w >> 7) & 0x1f;
    jal(rd, off)
}
/// Replace the immediate of a B-type word (keeps funct3/rs1/rs2).
fn reencode_branch(w: u32, off: i32) -> u32 {
    let f3 = (w >> 12) & 0x7;
    let rs1 = (w >> 15) & 0x1f;
    let rs2 = (w >> 20) & 0x1f;
    branch(f3, rs1, rs2, off)
}
