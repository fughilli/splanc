//! Abstract-interpret a `.fxb` `shade()` body into the macro IR.
//!
//! The interpreter mirrors `fx_vm::run` exactly, but over IR node ids instead
//! of f32 slots: pushing a value pushes a `NodeId`, an arithmetic opcode pops
//! ids and emits a macro op, a `LoadCtx` pushes an `Input`, a `StoreLocal`
//! records a node in the locals environment. Because `shade()` is pure (it
//! never writes `state` and has no I/O), control flow is **if-converted**: at a
//! `BrFalse`/`BrCmpI` the interpreter forks, runs each successor to its own
//! `Ret` over a cloned machine state, and merges the two results with `MSel` on
//! the branch predicate. Evaluating both arms is exact because neither has side
//! effects. Nested `if/else` recurses; the shared step budget bounds total work.
//!
//! This is the feasibility subset. Anything whose value is not a pure function
//! of (uniforms, state, LED attributes, constants) is refused with
//! [`Unsupported`], and the caller keeps that effect on the VM: user functions
//! (`Call`), buffers/textures, graph/flood queries, dynamic-index ops, the
//! JIT/I2C ops, and any backward branch (a loop — the fork model would not
//! terminate). Forward-only locals and if/else are supported.

use crate::ir::Op::*;
use crate::ir::{Graph, NodeId, Src};
use ledmapper_fx_vm as vm;

const MAX_STEPS: usize = 500_000;
const MAX_STACK: usize = vm::MAX_STACK;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unsupported {
    Opcode(&'static str),
    StackUnderflow,
    Loop,
    Divergence,
    TooManySteps,
    BadProgram,
    NoShade,
}

/// The lowered kernel: a graph plus the 3 RGB root nodes.
pub struct Lowered {
    pub g: Graph,
    pub rgb: [NodeId; 3],
    /// Shade ended in `RetRgb8`/`RetRgbFix` (roots already 0..255) vs. linear
    /// floats needing the `unit_u8` epilogue.
    pub raw_rgb: bool,
}

#[derive(Clone)]
struct State {
    stack: Vec<NodeId>,
    locals: Vec<NodeId>,
}

struct Interp<'a> {
    code: &'a [u8],
    consts: &'a [u8],
    g: Graph,
    steps: usize,
}

impl Interp<'_> {
    fn cb(&self, o: usize) -> u8 {
        *self.code.get(o).unwrap_or(&0)
    }
    fn rd16(&self, o: usize) -> u16 {
        u16::from_le_bytes([self.cb(o), self.cb(o + 1)])
    }
    fn cbits(&self, idx: usize) -> u32 {
        let o = idx * 4;
        match self.consts.get(o..o + 4) {
            Some(b) => u32::from_le_bytes([b[0], b[1], b[2], b[3]]),
            None => 0,
        }
    }
}

pub fn lower_shade(prog: &vm::Program) -> Result<Lowered, Unsupported> {
    if prog.flags & vm::FLAG_DRIVER != 0 {
        return Err(Unsupported::Opcode("driver"));
    }
    let entry = prog.shade_entry;
    if entry == vm::NO_ENTRY {
        return Err(Unsupported::NoShade);
    }
    let mut it = Interp { code: prog.code(), consts: prog.consts_raw(), g: Graph::new(), steps: 0 };
    let mut st = State { stack: Vec::new(), locals: vec![0; vm::MAX_LOCALS] };
    let zero = it.g.cf(0.0);
    st.locals.fill(zero);
    let (rgb, raw) = exec(&mut it, &mut st, entry as usize)?;
    Ok(Lowered { g: it.g, rgb, raw_rgb: raw })
}

/// Run from `pc` to a terminator, returning the 3 colour roots + raw flag.
fn exec(it: &mut Interp, st: &mut State, mut pc: usize) -> Result<([NodeId; 3], bool), Unsupported> {
    use vm::Op as O;
    loop {
        it.steps += 1;
        if it.steps > MAX_STEPS {
            return Err(Unsupported::TooManySteps);
        }
        let b = *it.code.get(pc).ok_or(Unsupported::BadProgram)?;
        let op = O::from_u8(b).ok_or(Unsupported::BadProgram)?;
        pc += 1;
        macro_rules! unsup {
            ($n:expr) => {
                return Err(Unsupported::Opcode($n))
            };
        }
        macro_rules! pop {
            () => {
                st.stack.pop().ok_or(Unsupported::StackUnderflow)?
            };
        }
        macro_rules! push {
            ($v:expr) => {{
                if st.stack.len() >= MAX_STACK {
                    return Err(Unsupported::BadProgram);
                }
                st.stack.push($v);
            }};
        }
        macro_rules! need {
            ($k:expr) => {
                st.stack.len().checked_sub($k).ok_or(Unsupported::StackUnderflow)?
            };
        }
        match op {
            O::PushConst => {
                let bits = it.cbits(it.rd16(pc) as usize);
                pc += 2;
                let v = it.g.cfb(bits);
                push!(v);
            }
            O::PushConsts => {
                let n = it.cb(pc) as usize;
                for j in 0..n {
                    let bits = it.cbits(it.rd16(pc + 1 + 2 * j) as usize);
                    let v = it.g.cfb(bits);
                    push!(v);
                }
                pc += 1 + 2 * n;
            }
            O::LoadUniform => {
                let (slot, n) = (it.cb(pc), it.cb(pc + 1) as usize);
                pc += 2;
                for i in 0..n {
                    let v = it.g.input(Src::Uniform(slot + i as u8));
                    push!(v);
                }
            }
            O::LoadState => {
                let (slot, n) = (it.cb(pc), it.cb(pc + 1) as usize);
                pc += 2;
                for i in 0..n {
                    let v = it.g.input(Src::State(slot + i as u8));
                    push!(v);
                }
            }
            O::LoadLocal => {
                let (slot, n) = (it.cb(pc) as usize, it.cb(pc + 1) as usize);
                pc += 2;
                for i in 0..n {
                    let v = *st.locals.get(slot + i).ok_or(Unsupported::BadProgram)?;
                    push!(v);
                }
            }
            O::StoreLocal => {
                let (slot, n) = (it.cb(pc) as usize, it.cb(pc + 1) as usize);
                pc += 2;
                let base = need!(n);
                for i in 0..n {
                    if let Some(s) = st.locals.get_mut(slot + i) {
                        *s = st.stack[base + i];
                    }
                }
                st.stack.truncate(base);
            }
            O::TeeLocal => {
                let (slot, n) = (it.cb(pc) as usize, it.cb(pc + 1) as usize);
                pc += 2;
                let base = need!(n);
                for i in 0..n {
                    if let Some(s) = st.locals.get_mut(slot + i) {
                        *s = st.stack[base + i];
                    }
                }
            }
            O::FillLocal => {
                let (slot, n) = (it.cb(pc) as usize, it.cb(pc + 1) as usize);
                pc += 2;
                let z = it.g.cf(0.0);
                for i in 0..n {
                    if let Some(s) = st.locals.get_mut(slot + i) {
                        *s = z;
                    }
                }
            }
            O::LoadCtx => {
                let id = it.cb(pc);
                pc += 1;
                for c in 0..ctx_width(id) {
                    let v = it.g.input(Src::LedCtx(id, c as u8));
                    push!(v);
                }
            }
            O::LoadCtxFix => {
                let (id, comp, frac) = (it.cb(pc), it.cb(pc + 1), it.cb(pc + 2));
                pc += 3;
                let raw = it.g.input(src_fix(id, comp));
                let v = rescale_ctxfix(&mut it.g, id, raw, frac);
                push!(v);
            }
            O::LoadCtxLanes => {
                let (id, src, k0, m) = (
                    it.cb(pc),
                    it.cb(pc + 1) as usize,
                    it.cb(pc + 2) as usize,
                    it.cb(pc + 3) as usize,
                );
                pc += 4;
                let k = ctx_width(id);
                let mut ctxv = [0u32; 3];
                for (c, cv) in ctxv.iter_mut().enumerate().take(k) {
                    *cv = it.g.input(Src::LedCtx(id, c as u8));
                }
                let total = st.stack.len() + k;
                let base = total.checked_sub(src).ok_or(Unsupported::StackUnderflow)?;
                if m > 4 {
                    return Err(Unsupported::BadProgram);
                }
                let mut tmp = [0u32; 4];
                for (j, t) in tmp.iter_mut().enumerate().take(m) {
                    let at = base + k0 + j;
                    *t = if at >= st.stack.len() {
                        *ctxv.get(at - st.stack.len()).ok_or(Unsupported::BadProgram)?
                    } else {
                        st.stack[at]
                    };
                }
                st.stack.truncate(base.min(st.stack.len()));
                for &t in tmp.iter().take(m) {
                    push!(t);
                }
            }
            O::Add | O::Sub | O::Mul | O::Div => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let mop = match op {
                    O::Add => MAdd,
                    O::Sub => MSub,
                    O::Mul => MMul,
                    _ => MDiv0,
                };
                let base = need!(2 * n);
                for i in 0..n {
                    let (a, b) = (st.stack[base + i], st.stack[base + n + i]);
                    st.stack[base + i] = it.g.add(mop, &[a, b]);
                }
                st.stack.truncate(base + n);
            }
            O::Neg => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let base = need!(n);
                for i in 0..n {
                    let a = st.stack[base + i];
                    st.stack[base + i] = it.g.add(MNeg, &[a]);
                }
            }
            O::Scale => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let s = pop!();
                let base = need!(n);
                for i in 0..n {
                    let a = st.stack[base + i];
                    st.stack[base + i] = it.g.add(MMul, &[a, s]);
                }
            }
            O::MulAdd => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let base = need!(3 * n);
                for i in 0..n {
                    let bc = it.g.add(MMul, &[st.stack[base + n + i], st.stack[base + 2 * n + i]]);
                    st.stack[base + i] = it.g.add(MAdd, &[st.stack[base + i], bc]);
                }
                st.stack.truncate(base + n);
            }
            O::UnMath => {
                let (f, n) = (it.cb(pc), it.cb(pc + 1) as usize);
                pc += 2;
                let base = need!(n);
                for i in 0..n {
                    let a = st.stack[base + i];
                    st.stack[base + i] = it.g.add(MUn(f), &[a]);
                }
            }
            O::BinMath => {
                let (f, n) = (it.cb(pc), it.cb(pc + 1) as usize);
                pc += 2;
                let base = need!(2 * n);
                for i in 0..n {
                    let (a, b) = (st.stack[base + i], st.stack[base + n + i]);
                    st.stack[base + i] = it.g.add(MBin(f), &[a, b]);
                }
                st.stack.truncate(base + n);
            }
            O::Clamp => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let base = need!(3 * n);
                for i in 0..n {
                    let (x, lo, hi) =
                        (st.stack[base + i], st.stack[base + n + i], st.stack[base + 2 * n + i]);
                    let ltlo = it.g.add(MCmp(0), &[x, lo]);
                    let gthi = it.g.add(MCmp(2), &[x, hi]);
                    let s1 = it.g.add(MSel, &[gthi, hi, x]);
                    st.stack[base + i] = it.g.add(MSel, &[ltlo, lo, s1]);
                }
                st.stack.truncate(base + n);
            }
            O::Mix => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let t = pop!();
                let base = need!(2 * n);
                for i in 0..n {
                    let (a, b) = (st.stack[base + i], st.stack[base + n + i]);
                    let d = it.g.add(MSub, &[b, a]);
                    let dt = it.g.add(MMul, &[d, t]);
                    st.stack[base + i] = it.g.add(MAdd, &[a, dt]);
                }
                st.stack.truncate(base + n);
            }
            O::Smoothstep => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let base = need!(3 * n);
                for i in 0..n {
                    let (e0, e1, x) =
                        (st.stack[base + i], st.stack[base + n + i], st.stack[base + 2 * n + i]);
                    st.stack[base + i] = smoothstep(&mut it.g, e0, e1, x);
                }
                st.stack.truncate(base + n);
            }
            O::Dot => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let base = need!(2 * n);
                let mut acc = it.g.cf(0.0);
                for i in 0..n {
                    let m = it.g.add(MMul, &[st.stack[base + i], st.stack[base + n + i]]);
                    acc = it.g.add(MAdd, &[acc, m]);
                }
                st.stack.truncate(base);
                push!(acc);
            }
            O::Cross => {
                pc += 1;
                let base = need!(6);
                let a = [st.stack[base], st.stack[base + 1], st.stack[base + 2]];
                let bb = [st.stack[base + 3], st.stack[base + 4], st.stack[base + 5]];
                let mut cr = |i, j, k, l| {
                    let m1 = it.g.add(MMul, &[i, j]);
                    let m2 = it.g.add(MMul, &[k, l]);
                    it.g.add(MSub, &[m1, m2])
                };
                st.stack[base] = cr(a[1], bb[2], a[2], bb[1]);
                st.stack[base + 1] = cr(a[2], bb[0], a[0], bb[2]);
                st.stack[base + 2] = cr(a[0], bb[1], a[1], bb[0]);
                st.stack.truncate(base + 3);
            }
            O::Length | O::Distance => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let is_dist = op == O::Distance;
                let base = need!(if is_dist { 2 * n } else { n });
                let mut acc = it.g.cf(0.0);
                for i in 0..n {
                    let d = if is_dist {
                        it.g.add(MSub, &[st.stack[base + i], st.stack[base + n + i]])
                    } else {
                        st.stack[base + i]
                    };
                    let sq = it.g.add(MMul, &[d, d]);
                    acc = it.g.add(MAdd, &[acc, sq]);
                }
                let r = it.g.add(MSqrt, &[acc]);
                st.stack.truncate(base);
                push!(r);
            }
            O::Normalize => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let base = need!(n);
                let mut acc = it.g.cf(0.0);
                for i in 0..n {
                    let sq = it.g.add(MMul, &[st.stack[base + i], st.stack[base + i]]);
                    acc = it.g.add(MAdd, &[acc, sq]);
                }
                let len = it.g.add(MSqrt, &[acc]);
                let eps = it.g.cf(1e-9);
                let big = it.g.add(MCmp(2), &[len, eps]);
                for i in 0..n {
                    let d = it.g.add(MDivRaw, &[st.stack[base + i], len]);
                    st.stack[base + i] = it.g.add(MSel, &[big, d, st.stack[base + i]]);
                }
            }
            O::Swizzle => {
                let (src_n, dst_n) = (it.cb(pc) as usize, it.cb(pc + 1) as usize);
                pc += 2;
                let base = need!(src_n);
                if dst_n > 4 {
                    return Err(Unsupported::BadProgram);
                }
                let mut tmp = [0u32; 4];
                for (i, t) in tmp.iter_mut().enumerate().take(dst_n) {
                    let ci = it.cb(pc + i) as usize;
                    *t = *st.stack.get(base + ci).ok_or(Unsupported::BadProgram)?;
                }
                pc += dst_n;
                st.stack.truncate(base);
                for &t in tmp.iter().take(dst_n) {
                    push!(t);
                }
            }
            O::Swap => {
                let (an, bn) = (it.cb(pc) as usize, it.cb(pc + 1) as usize);
                pc += 2;
                let base = need!(an + bn);
                let a: Vec<NodeId> = st.stack[base..base + an].to_vec();
                let bb: Vec<NodeId> = st.stack[base + an..base + an + bn].to_vec();
                st.stack.truncate(base);
                st.stack.extend(bb);
                st.stack.extend(a);
            }
            O::Pop => {
                let n = it.cb(pc) as usize;
                pc += 1;
                let l = st.stack.len().saturating_sub(n);
                st.stack.truncate(l);
            }
            O::Cmp => {
                let kind = it.cb(pc);
                pc += 1;
                let b = pop!();
                let a = pop!();
                let r = it.g.add(MCmp(kind), &[a, b]);
                push!(r);
            }
            O::CmpI => {
                let kind = it.cb(pc);
                pc += 1;
                let b = pop!();
                let a = pop!();
                let r = it.g.add(MICmp(kind), &[a, b]);
                push!(r);
            }
            O::Logic => {
                let kind = it.cb(pc);
                pc += 1;
                if kind == 2 {
                    let a = pop!();
                    let r = it.g.add(MNot, &[a]);
                    push!(r);
                } else {
                    let b = pop!();
                    let a = pop!();
                    let r = it.g.add(if kind == 0 { MAnd } else { MOr }, &[a, b]);
                    push!(r);
                }
            }
            O::Hash1 => {
                let x = pop!();
                let r = it.g.add(MHash1, &[x]);
                push!(r);
            }
            O::Hash3 => {
                let z = pop!();
                let y = pop!();
                let x = pop!();
                let r = it.g.add(MHash3, &[x, y, z]);
                push!(r);
            }
            O::Hsv2Rgb => {
                let v = pop!();
                let s = pop!();
                let h = pop!();
                for k in 0..3 {
                    let r = it.g.add(MHsv(k), &[h, s, v]);
                    push!(r);
                }
            }
            O::Palette => {
                let id = it.cb(pc);
                pc += 1;
                let t = pop!();
                for k in 0..3 {
                    let r = it.g.add(MPal(id, k), &[t]);
                    push!(r);
                }
            }
            O::AddI => bin_i(it, st, MIAdd)?,
            O::SubI => bin_i(it, st, MISub)?,
            O::MulI => bin_i(it, st, MIMul)?,
            O::DivI => bin_i(it, st, MIDiv0)?,
            O::ModI => bin_i(it, st, MIMod0)?,
            O::MinI => bin_i(it, st, MIMin)?,
            O::MaxI => bin_i(it, st, MIMax)?,
            O::MulFix => bin_i(it, st, MMulFix)?,
            O::NegI => {
                let a = pop!();
                let r = it.g.add(MINeg, &[a]);
                push!(r);
            }
            O::AbsI => {
                let a = pop!();
                let r = it.g.add(MIAbs, &[a]);
                push!(r);
            }
            O::ClampI => {
                let hi = pop!();
                let lo = pop!();
                let x = pop!();
                let s = it.g.add(MIMin, &[x, hi]);
                let r = it.g.add(MIMax, &[s, lo]);
                push!(r);
            }
            O::I2F => {
                let a = pop!();
                let r = it.g.add(MI2F, &[a]);
                push!(r);
            }
            O::F2I => {
                let a = pop!();
                let r = it.g.add(MF2I, &[a]);
                push!(r);
            }
            O::F2Fix => {
                let a = pop!();
                let r = it.g.add(MF2Fix(16), &[a]);
                push!(r);
            }
            O::Fix2F => {
                let a = pop!();
                let r = it.g.add(MFix2F(16), &[a]);
                push!(r);
            }
            O::I2Fix => {
                let a = pop!();
                let r = it.g.add(MShift(16), &[a]);
                push!(r);
            }
            O::Fix2I => {
                let a = pop!();
                let r = it.g.add(MShift(-16), &[a]);
                push!(r);
            }
            O::FixRescale => {
                let sh = it.cb(pc) as i8;
                pc += 1;
                let a = pop!();
                let r = it.g.add(MShift(sh), &[a]);
                push!(r);
            }
            O::BinTop => {
                let mode = it.cb(pc);
                let i = it.rd16(pc + 1) as usize;
                pc += 3;
                let a = pop!();
                let b = bin_src(it, st, mode >> 2, i)?;
                let r = mk_bin(&mut it.g, mode, a, b);
                push!(r);
            }
            O::BinPair => {
                let mode = it.cb(pc);
                let ia = it.rd16(pc + 1) as usize;
                let ib = it.rd16(pc + 3) as usize;
                pc += 5;
                let a = bin_src(it, st, mode >> 2, ia)?;
                let b = bin_src(it, st, mode >> 4, ib)?;
                let r = mk_bin(&mut it.g, mode, a, b);
                push!(r);
            }
            O::Jmp => {
                let rel = it.rd16(pc) as i16;
                pc += 2;
                if rel < 0 {
                    return Err(Unsupported::Loop);
                }
                pc = (pc as isize + rel as isize) as usize;
            }
            O::BrFalse => {
                let rel = it.rd16(pc) as i16;
                pc += 2;
                if rel < 0 {
                    return Err(Unsupported::Loop);
                }
                let c = pop!();
                let taken = (pc as isize + rel as isize) as usize;
                return merge(it, st, c, pc, taken);
            }
            O::BrCmpI => {
                let kind = it.cb(pc);
                let rel = it.rd16(pc + 1) as i16;
                pc += 3;
                if rel < 0 {
                    return Err(Unsupported::Loop);
                }
                let b = pop!();
                let a = pop!();
                // BrCmpI branches when the comparison is FALSE; predicate = true.
                let cmp = it.g.add(MICmp(kind), &[a, b]);
                let taken = (pc as isize + rel as isize) as usize;
                return merge(it, st, cmp, pc, taken);
            }
            O::Ret => {
                let n = it.cb(pc) as usize;
                let base = st.stack.len().saturating_sub(n);
                let zero = it.g.cf(0.0);
                let mut out = [zero; 3];
                for (i, o) in out.iter_mut().enumerate().take(n.min(3)) {
                    *o = st.stack[base + i];
                }
                return Ok((out, false));
            }
            O::RetRgb8 => {
                let base = st.stack.len().saturating_sub(3);
                let zero = it.g.cf(0.0);
                let mut out = [zero; 3];
                for (i, o) in out.iter_mut().enumerate() {
                    if let Some(&v) = st.stack.get(base + i) {
                        *o = it.g.add(MClamp255, &[v]);
                    }
                }
                return Ok((out, true));
            }
            O::RetRgbFix => {
                let frac = it.cb(pc);
                let base = st.stack.len().saturating_sub(3);
                let zero = it.g.cf(0.0);
                let mut out = [zero; 3];
                let c255 = it.g.cf(255.0);
                let c0 = it.g.cf(0.0);
                for (i, o) in out.iter_mut().enumerate() {
                    if let Some(&v) = st.stack.get(base + i) {
                        let f = it.g.add(MFix2F(frac), &[v]);
                        let s = it.g.add(MMul, &[f, c255]);
                        // clamp(s, 0, 255) via min(max(s,0),255) — B_MIN/B_MAX
                        let mx = it.g.add(MBin(vm::B_MAX), &[s, c0]);
                        *o = it.g.add(MBin(vm::B_MIN), &[mx, c255]);
                    }
                }
                return Ok((out, true));
            }
            O::Call | O::RetFn => unsup!("user-fn"),
            O::LoadBuf | O::StoreBuf | O::SampleTex | O::PaintTex => unsup!("buffer/texture"),
            O::GraphQuery | O::FloodFrom => unsup!("graph"),
            O::LoadStateIdx | O::StoreStateIdx | O::LoadLocalIdx | O::StoreLocalIdx => {
                unsup!("dyn-index")
            }
            O::JitCall => unsup!("jit"),
            O::I2cWrite | O::I2cRead => unsup!("i2c"),
            O::StoreState => unsup!("store-state-in-shade"),
            O::IncLocalI => unsup!("inc-local"),
            // Per-LED memo cache: treat as the cache-MISS path — recompute the
            // bracketed expression. LoadLedCache falls through (no push, no
            // skip jump); StoreLedCache is a no-op. Bit-identical to a run with
            // no cache bound, which is what the VM does on the host too.
            O::LoadLedCache => {
                pc += 4; // slot:u8 n:u8 skip:i16
            }
            O::StoreLedCache => {
                pc += 2; // slot:u8 n:u8
            }
            _ => unsup!("fixed-op"),
        }
    }
}

/// Fork at a branch: evaluate the fall-through (predicate TRUE) and the taken
/// target (predicate FALSE) over cloned states, then merge the two RGB roots.
fn merge(
    it: &mut Interp,
    st: &State,
    pred: NodeId,
    fallthrough: usize,
    taken: usize,
) -> Result<([NodeId; 3], bool), Unsupported> {
    let mut s_then = st.clone();
    let (then_rgb, then_raw) = exec(it, &mut s_then, fallthrough)?;
    let mut s_else = st.clone();
    let (else_rgb, else_raw) = exec(it, &mut s_else, taken)?;
    if then_raw != else_raw {
        return Err(Unsupported::Divergence);
    }
    let mut out = [0u32; 3];
    for i in 0..3 {
        out[i] = it.g.add(MSel, &[pred, then_rgb[i], else_rgb[i]]);
    }
    Ok((out, then_raw))
}

fn bin_i(it: &mut Interp, st: &mut State, op: crate::ir::Op) -> Result<(), Unsupported> {
    let b = st.stack.pop().ok_or(Unsupported::StackUnderflow)?;
    let a = st.stack.pop().ok_or(Unsupported::StackUnderflow)?;
    let r = it.g.add(op, &[a, b]);
    st.stack.push(r);
    Ok(())
}

fn bin_src(it: &mut Interp, st: &State, src: u8, i: usize) -> Result<NodeId, Unsupported> {
    Ok(match src & 3 {
        0 => {
            let bits = it.cbits(i);
            it.g.cfb(bits)
        }
        1 => *st.locals.get(i).ok_or(Unsupported::BadProgram)?,
        2 => it.g.input(Src::State(i as u8)),
        _ => it.g.input(Src::Uniform(i as u8)),
    })
}

fn mk_bin(g: &mut Graph, mode: u8, a: NodeId, b: NodeId) -> NodeId {
    if mode & 0x40 != 0 {
        let op = match mode & 3 {
            0 => MIAdd,
            1 => MISub,
            2 => MIMul,
            _ => MMulFix,
        };
        g.add(op, &[a, b])
    } else {
        let op = match mode & 3 {
            0 => MAdd,
            1 => MSub,
            2 => MMul,
            _ => MDiv0,
        };
        g.add(op, &[a, b])
    }
}

fn smoothstep(g: &mut Graph, e0: NodeId, e1: NodeId, x: NodeId) -> NodeId {
    let den = g.add(MSub, &[e1, e0]);
    let num = g.add(MSub, &[x, e0]);
    let q = g.add(MDivRaw, &[num, den]);
    let eq = g.add(MCmp(4), &[e1, e0]);
    let zero = g.cf(0.0);
    let qsel = g.add(MSel, &[eq, zero, q]);
    let t = g.add(MClamp01, &[qsel]);
    let three = g.cf(3.0);
    let two = g.cf(2.0);
    let t2 = g.add(MMul, &[two, t]);
    let inner = g.add(MSub, &[three, t2]);
    let tt = g.add(MMul, &[t, t]);
    g.add(MMul, &[tt, inner])
}

fn ctx_width(id: u8) -> usize {
    match id {
        vm::C_LED_POS | vm::C_IMU_ACCEL | vm::C_IMU_GYRO | vm::C_LED_ROOM | vm::C_ROOM_MIN
        | vm::C_ROOM_MAX => 3,
        vm::C_LED_UV => 2,
        _ => 1,
    }
}

fn src_fix(id: u8, comp: u8) -> Src {
    match id {
        vm::C_TIME | vm::C_DT | vm::C_IMU_ACCEL | vm::C_IMU_GYRO | vm::C_ROOM_MIN
        | vm::C_ROOM_MAX => Src::FrameCtxFix(id, comp),
        _ => Src::LedCtxFix(id, comp),
    }
}

fn rescale_ctxfix(g: &mut Graph, id: u8, raw: NodeId, frac: u8) -> NodeId {
    let canon: i32 = match id {
        vm::C_FRAME | vm::C_LED_IDX | vm::C_LED_COUNT | vm::C_LED_SEG | vm::C_LED_BRANCH => 0,
        _ => vm::CTX_FIX_FRAC as i32,
    };
    let sh = frac as i32 - canon;
    if sh == 0 {
        raw
    } else {
        g.add(MShift(sh as i8), &[raw])
    }
}
