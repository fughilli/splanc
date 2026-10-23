//! A tiny RV32IM JIT for the effects VM's hot straight-line integer/fixed paths
//! (FUG-125). The ESP32-C6 core is RISC-V RV32IMC, so a hot basic block of cheap
//! integer opcodes — loop counters, index math, Q16.16 multiplies — can be
//! lowered to a **short position-independent code (PIC) segment** that runs
//! natively, skipping the interpreter's per-opcode fetch/decode/dispatch/budget
//! overhead entirely.
//!
//! Scope (deliberately small, so it is provably correct and never a hazard):
//!   - Only *straight-line* blocks of the supported integer/fixed opcodes below.
//!     Anything else (control flow, soft-float, vectors, memory-indexed access)
//!     is simply not offered to the JIT; the VM keeps interpreting it.
//!   - The generated segment is PIC: it touches memory only through three base
//!     pointers passed in registers (operand stack, locals, const pool) and
//!     returns via `ret`. No absolute addresses, no relocations — copy it into an
//!     executable IRAM window and call it.
//!
//! Correctness is established entirely on the host, with no hardware in the loop:
//!   - `rv32` encodes each instruction; unit tests pin the encodings.
//!   - `emu` is a minimal RV32IM interpreter that executes the emitted segment.
//!   - `reference` re-implements the block with the EXACT `fx_vm` integer
//!     semantics (wrapping arithmetic, `>>frac` fixed multiply).
//!   - the differential test runs random blocks over random state through both
//!     the reference and the JIT-via-emulator and asserts identical results, and
//!     a cross-check ties the reference back to the real `fx_vm` interpreter.
//!
//! Wiring the segment into the device render loop (executable IRAM allocation +
//! I-cache flush + the call) is the on-device integration step; this crate is the
//! portable, host-verified heart that produces the code.
#![cfg_attr(not(test), no_std)]

// The `alloc` feature enables the Vec-based convenience API (compile / plan_blocks
// / reference) used by host tools + tests. The firmware links WITHOUT it and uses
// only the no-alloc path (compile_into / plan_blocks_into), so `fx_jit` needs no
// global allocator on-device.
#[cfg(feature = "alloc")]
extern crate alloc;
#[cfg(feature = "alloc")]
use alloc::vec::Vec;
use ledmapper_fx_vm::Op;

/// The straight-line opcode subset the JIT accepts. These mirror `fx_vm::Op`
/// (scalar integer/fixed), the cheap dispatch-bound ops that dominate hot loops.
/// The VM translates a candidate block into this IR before offering it here.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ir {
    /// Push const-pool word `idx` (raw i32 bits).
    PushConst(u16),
    /// Push `locals[slot]` (scalar).
    LoadLocal(u8),
    /// Pop into `locals[slot]` (scalar).
    StoreLocal(u8),
    /// Copy the top of stack into `locals[slot]` WITHOUT popping (the VM's
    /// `TeeLocal` superinstruction — `StoreLocal; LoadLocal` fused).
    TeeLocal(u8),
    AddI,
    SubI,
    MulI,
    NegI,
    /// Q16.16-style fixed multiply `(a*b) >> frac`, `frac` in 1..=31.
    MulFix(u8),
    /// Drop the top `n` slots.
    Pop(u8),
    /// Push `state[slot]` (scalar; `a3` = the state base).
    LoadState(u8),
    /// Pop into `state[slot]` (scalar).
    StoreState(u8),
    /// The VM's integer `AbsI` (wrapping), `MinI`, `MaxI` and `ClampI`
    /// (`x < lo ? lo : x > hi ? hi : x`), branch-free.
    AbsI,
    MinI,
    MaxI,
    ClampI,
}

// -- RV32IM instruction encoder ----------------------------------------------

/// RV32I/M encodings for the small instruction set the translator emits. Kept
/// standalone (returns the 32-bit word) so the unit tests can pin each field.
pub mod rv32 {
    // ABI registers we use.
    pub const ZERO: u32 = 0;
    pub const RA: u32 = 1;
    pub const T0: u32 = 5;
    pub const T1: u32 = 6;
    pub const T2: u32 = 7;
    pub const A0: u32 = 10; // operand-stack base
    pub const A1: u32 = 11; // locals base
    pub const A2: u32 = 12; // const-pool base
    pub const A3: u32 = 13; // state base

    fn r(funct7: u32, rs2: u32, rs1: u32, funct3: u32, rd: u32, opcode: u32) -> u32 {
        (funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode
    }
    fn i(imm: i32, rs1: u32, funct3: u32, rd: u32, opcode: u32) -> u32 {
        let imm = (imm as u32) & 0xfff;
        (imm << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode
    }
    fn s(imm: i32, rs2: u32, rs1: u32, funct3: u32, opcode: u32) -> u32 {
        let imm = (imm as u32) & 0xfff;
        let hi = (imm >> 5) & 0x7f;
        let lo = imm & 0x1f;
        (hi << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (lo << 7) | opcode
    }

    pub fn add(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x00, rs2, rs1, 0x0, rd, 0x33)
    }
    pub fn sub(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x20, rs2, rs1, 0x0, rd, 0x33)
    }
    pub fn mul(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x01, rs2, rs1, 0x0, rd, 0x33)
    }
    pub fn mulh(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x01, rs2, rs1, 0x1, rd, 0x33)
    }
    pub fn or(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x00, rs2, rs1, 0x6, rd, 0x33)
    }
    pub fn slt(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x00, rs2, rs1, 0x2, rd, 0x33)
    }
    pub fn xor(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x00, rs2, rs1, 0x4, rd, 0x33)
    }
    pub fn and(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x00, rs2, rs1, 0x7, rd, 0x33)
    }
    pub fn addi(rd: u32, rs1: u32, imm: i32) -> u32 {
        i(imm, rs1, 0x0, rd, 0x13)
    }
    pub fn slli(rd: u32, rs1: u32, shamt: u32) -> u32 {
        i((shamt & 0x1f) as i32, rs1, 0x1, rd, 0x13)
    }
    pub fn srli(rd: u32, rs1: u32, shamt: u32) -> u32 {
        i((shamt & 0x1f) as i32, rs1, 0x5, rd, 0x13)
    }
    pub fn srai(rd: u32, rs1: u32, shamt: u32) -> u32 {
        i(0x400 | (shamt & 0x1f) as i32, rs1, 0x5, rd, 0x13)
    }
    pub fn lw(rd: u32, rs1: u32, off: i32) -> u32 {
        i(off, rs1, 0x2, rd, 0x03)
    }
    pub fn sw(rs2: u32, rs1: u32, off: i32) -> u32 {
        s(off, rs2, rs1, 0x2, 0x23)
    }
    /// `ret` == `jalr x0, 0(ra)`.
    pub fn ret() -> u32 {
        i(0, RA, 0x0, ZERO, 0x67)
    }
}

/// A compiled straight-line segment: PIC machine code plus the operand-stack
/// bookkeeping the VM needs around the call. (`alloc`-only; the firmware uses the
/// no-alloc [`compile_into`].)
#[cfg(feature = "alloc")]
pub struct Segment {
    /// RV32IM words. Copy into executable memory and call as
    /// `extern "C" fn(stack: *mut i32, locals: *mut i32, consts: *const i32)`;
    /// `stack` points at the current top-of-stack slot (`&stack[sp]`).
    pub code: Vec<u32>,
    /// Slots pushed minus popped over the block (added to the VM's `sp` after).
    pub net_delta: i32,
    /// The deepest the block reaches below entry (≤ 0): it reads/writes stack
    /// slots down to `sp + min_depth`, so the VM must have `sp >= -min_depth`
    /// operands live before it may run this segment.
    pub min_depth: i32,
}

// lw/sw carry a 12-bit SIGNED immediate: entry operands sit at negative offsets
// from a0 (the entry top-of-stack), so the block can consume values already on
// the stack. A block whose access reaches outside this window is not JIT-able.
const IMM12_MIN: i32 = -2048;
const IMM12_MAX: i32 = 2047;

/// Translate a straight-line block into a PIC RV32IM segment, or `None` if it is
/// not JIT-able (an offset would exceed the signed load/store immediate range, or
/// a bad fixed `frac`). The generated code models the operand stack exactly like
/// the interpreter — a byte-addressed i32 array based at `a0` = the entry TOS —
/// with the depth tracked at compile time (it may go negative, consuming entry
/// operands), so no runtime stack pointer is needed. Runtime stack sufficiency is
/// the caller's check via [`Segment::min_depth`].
#[cfg(feature = "alloc")]
pub fn compile(block: &[Ir]) -> Option<Segment> {
    let mut code = Vec::new();
    let meta = emit_block(block, &mut code)?;
    Some(Segment { code, net_delta: meta.net_delta, min_depth: meta.min_depth })
}

/// Metadata for a compiled block, returned by the no-alloc [`compile_into`].
#[derive(Clone, Copy)]
pub struct SegMeta {
    /// Number of RV32 words written.
    pub len: usize,
    pub net_delta: i32,
    pub min_depth: i32,
}

/// no-alloc twin of [`compile`]: emit the segment into `out` (the firmware's
/// static code arena) instead of a `Vec`. `None` on the same rejections, or if
/// `out` is too small. This is the path the firmware uses (it has no heap).
pub fn compile_into(block: &[Ir], out: &mut [u32]) -> Option<SegMeta> {
    let mut sink = SliceSink { buf: out, n: 0 };
    let meta = emit_block(block, &mut sink)?;
    Some(SegMeta { len: sink.n, net_delta: meta.net_delta, min_depth: meta.min_depth })
}

/// A destination for emitted RV32 words. `emit` returns false when full, so the
/// codegen (shared by the `Vec` and slice paths) can bail identically.
trait Sink {
    fn emit(&mut self, w: u32) -> bool;
}
#[cfg(feature = "alloc")]
impl Sink for Vec<u32> {
    fn emit(&mut self, w: u32) -> bool {
        self.push(w);
        true
    }
}
struct SliceSink<'a> {
    buf: &'a mut [u32],
    n: usize,
}
impl Sink for SliceSink<'_> {
    fn emit(&mut self, w: u32) -> bool {
        if self.n < self.buf.len() {
            self.buf[self.n] = w;
            self.n += 1;
            true
        } else {
            false
        }
    }
}

/// Net stack effect of a compiled block.
struct BlockMeta {
    net_delta: i32,
    min_depth: i32,
}

/// Scratch registers the register-cached codegen may hold stack values in: the
/// caller-saved temporaries plus a4-a7 (a0-a3 are the ABI bases).
const POOL: [u32; 11] = [5, 6, 7, 28, 29, 30, 31, 14, 15, 16, 17];
/// Model depths a block can reach: [`MAX_BLOCK_IR`] ops each move it by at most
/// one slot, except `Pop(n)`, which only lowers it (bounded by the access check).
const DEPTH_SPAN: i32 = 4 * MAX_BLOCK_IR as i32;

/// The shared codegen: lower `block` into `sink`. Semantics are identical to the
/// documented `compile`; only the output destination differs.
///
/// Stack slots are cached in registers: a value pushed in the block lives in a
/// scratch register until it is consumed (or spilled when the 12-register pool
/// runs out, deepest first), and the values still live at the end are written
/// back to their stack slots before `ret`. Entry operands (below the entry top
/// of stack) are read from memory when first consumed. The interpreter sees the
/// same stack and locals as with the old one-load-one-store-per-op code; slots
/// above the final depth are dead to it either way.
fn emit_block(block: &[Ir], sink: &mut impl Sink) -> Option<BlockMeta> {
    use rv32::*;
    let mut depth: i32 = 0; // slots relative to the entry top-of-stack
    let mut min_depth: i32 = 0;

    // Byte offset of stack slot at model-depth `k` from a0 (may be negative).
    let stack_off = |k: i32| k * 4;
    let fits = |off: i32| (IMM12_MIN..=IMM12_MAX).contains(&off);

    // `slot[k + DEPTH_SPAN]`: the register caching model-depth k, or 0 (= in
    // memory). `busy[i]` marks POOL[i] in use.
    let mut slot = [0u32; (2 * DEPTH_SPAN + 1) as usize];
    let mut busy = [false; POOL.len()];
    let idx = |k: i32| -> Option<usize> {
        let i = k + DEPTH_SPAN;
        (0..=2 * DEPTH_SPAN).contains(&i).then_some(i as usize)
    };

    macro_rules! emit {
        ($w:expr) => {
            if !sink.emit($w) {
                return None;
            }
        };
    }
    macro_rules! free {
        ($r:expr) => {{
            let r: u32 = $r;
            if let Some(i) = POOL.iter().position(|&p| p == r) {
                busy[i] = false;
            }
        }};
    }
    // A free scratch register; spills the deepest cached slot when none is.
    macro_rules! alloc {
        () => {{
            let r = match busy.iter().position(|b| !b) {
                Some(i) => {
                    busy[i] = true;
                    POOL[i]
                }
                None => {
                    let mut k = min_depth.min(0) - 1;
                    let mut found = None;
                    while k < depth {
                        k += 1;
                        if let Some(i) = idx(k) {
                            if slot[i] != 0 {
                                found = Some((k, i));
                                break;
                            }
                        }
                    }
                    let (k, i) = found?;
                    let r = slot[i];
                    let off = stack_off(k);
                    if !fits(off) {
                        return None;
                    }
                    emit!(sw(r, A0, off));
                    slot[i] = 0;
                    r // stays busy: handed to the caller
                }
            };
            r
        }};
    }
    // Pop the top slot into a register the caller owns (load it if in memory).
    macro_rules! pop_reg {
        () => {{
            depth -= 1;
            let i = idx(depth)?;
            if slot[i] != 0 {
                let r = slot[i];
                slot[i] = 0;
                r
            } else {
                let off = stack_off(depth);
                if !fits(off) {
                    return None;
                }
                let r = alloc!();
                emit!(lw(r, A0, off));
                r
            }
        }};
    }
    macro_rules! push_reg {
        ($r:expr) => {{
            let i = idx(depth)?;
            slot[i] = $r;
            depth += 1;
        }};
    }

    for op in block {
        // Deepest stack slot this op reads/writes (relative to the entry TOS):
        // pushes touch `depth`; a scalar consumer touches `depth-1`; a binary op
        // reaches `depth-2`. Recorded so the VM can gate on the live `sp`.
        let access = match *op {
            Ir::PushConst(_) | Ir::LoadLocal(_) | Ir::LoadState(_) => depth,
            Ir::StoreLocal(_) | Ir::NegI | Ir::TeeLocal(_) | Ir::StoreState(_) | Ir::AbsI => depth - 1,
            Ir::AddI | Ir::SubI | Ir::MulI | Ir::MulFix(_) | Ir::MinI | Ir::MaxI => depth - 2,
            Ir::ClampI => depth - 3,
            Ir::Pop(_) => depth, // touches nothing
        };
        min_depth = min_depth.min(access);
        if !fits(stack_off(access)) || idx(access).is_none() {
            return None;
        }

        match *op {
            Ir::PushConst(cidx) => {
                let coff = cidx as i32 * 4;
                if !fits(coff) || !fits(stack_off(depth)) {
                    return None;
                }
                let r = alloc!();
                emit!(lw(r, A2, coff));
                push_reg!(r);
            }
            Ir::LoadLocal(lslot) => {
                let loff = lslot as i32 * 4;
                if !fits(loff) || !fits(stack_off(depth)) {
                    return None;
                }
                let r = alloc!();
                emit!(lw(r, A1, loff));
                push_reg!(r);
            }
            Ir::StoreLocal(lslot) => {
                let loff = lslot as i32 * 4;
                if !fits(loff) {
                    return None;
                }
                let r = pop_reg!();
                emit!(sw(r, A1, loff));
                free!(r);
            }
            Ir::TeeLocal(lslot) => {
                // Copy the top of stack to local[slot], leaving it on the stack.
                let loff = lslot as i32 * 4;
                if !fits(loff) {
                    return None;
                }
                let r = pop_reg!();
                emit!(sw(r, A1, loff));
                push_reg!(r);
            }
            Ir::AddI | Ir::SubI | Ir::MulI => {
                let b = pop_reg!();
                let a = pop_reg!();
                emit!(match *op {
                    Ir::AddI => add(a, a, b),
                    Ir::SubI => sub(a, a, b),
                    _ => mul(a, a, b),
                });
                free!(b);
                push_reg!(a);
            }
            Ir::NegI => {
                let a = pop_reg!();
                emit!(sub(a, ZERO, a));
                push_reg!(a);
            }
            Ir::MulFix(frac) => {
                if !(1..=31).contains(&frac) {
                    return None;
                }
                // (a*b) >> frac, low 32 bits of the 64-bit signed product:
                //   (low >>u frac) | (high <<u (32-frac)).
                let b = pop_reg!();
                let a = pop_reg!();
                let lo = alloc!();
                emit!(mul(lo, a, b)); // low 32
                emit!(mulh(a, a, b)); // high 32 (signed)
                emit!(srli(lo, lo, frac as u32));
                emit!(slli(a, a, 32 - frac as u32));
                emit!(or(a, lo, a));
                free!(lo);
                free!(b);
                push_reg!(a);
            }
            Ir::LoadState(sslot) => {
                let off = sslot as i32 * 4;
                if !fits(off) || !fits(stack_off(depth)) {
                    return None;
                }
                let r = alloc!();
                emit!(lw(r, A3, off));
                push_reg!(r);
            }
            Ir::StoreState(sslot) => {
                let off = sslot as i32 * 4;
                if !fits(off) {
                    return None;
                }
                let r = pop_reg!();
                emit!(sw(r, A3, off));
                free!(r);
            }
            Ir::AbsI => {
                // m = a >> 31; (a ^ m) - m  (wrapping: i32::MIN stays MIN)
                let a = pop_reg!();
                let m = alloc!();
                emit!(srai(m, a, 31));
                emit!(xor(a, a, m));
                emit!(sub(a, a, m));
                free!(m);
                push_reg!(a);
            }
            Ir::MinI | Ir::MaxI => {
                // pick = MinI: a < b, MaxI: b < a; r = b ^ ((a ^ b) & -pick)
                let b = pop_reg!();
                let a = pop_reg!();
                let t = alloc!();
                emit!(if *op == Ir::MinI { slt(t, a, b) } else { slt(t, b, a) });
                emit!(sub(t, ZERO, t));
                emit!(xor(a, a, b));
                emit!(and(a, a, t));
                emit!(xor(a, a, b));
                free!(t);
                free!(b);
                push_reg!(a);
            }
            Ir::ClampI => {
                // r1 = x > hi ? hi : x ; x = x < lo ? lo : r1
                let hi = pop_reg!();
                let lo = pop_reg!();
                let x = pop_reg!();
                let t = alloc!();
                let r1 = alloc!();
                emit!(slt(t, hi, x));
                emit!(sub(t, ZERO, t));
                emit!(xor(r1, hi, x));
                emit!(and(r1, r1, t));
                emit!(xor(r1, r1, x));
                emit!(slt(t, x, lo));
                emit!(sub(t, ZERO, t));
                emit!(xor(x, lo, r1));
                emit!(and(x, x, t));
                emit!(xor(x, x, r1));
                free!(t);
                free!(r1);
                free!(lo);
                free!(hi);
                push_reg!(x);
            }
            Ir::Pop(n) => {
                for _ in 0..n {
                    depth -= 1;
                    let i = idx(depth)?;
                    if slot[i] != 0 {
                        free!(slot[i]);
                        slot[i] = 0;
                    }
                }
            }
        }
    }
    // Write back every value still cached in a register below the final depth.
    let mut k = min_depth.min(0);
    while k < depth {
        let i = idx(k)?;
        if slot[i] != 0 {
            let off = stack_off(k);
            if !fits(off) {
                return None;
            }
            emit!(sw(slot[i], A0, off));
        }
        k += 1;
    }
    emit!(ret());
    Some(BlockMeta { net_delta: depth, min_depth })
}

// -- bytecode planner: find + compile hot blocks ------------------------------

/// A JIT plan for one hot block found in a program's bytecode: the byte range to
/// patch (`start..end`), the compiled PIC segment, and the operand-stack delta.
/// (`alloc`-only; the firmware uses [`plan_blocks_into`] + [`PlanOut`].)
#[cfg(feature = "alloc")]
pub struct Plan {
    pub start: usize,
    pub end: usize,
    pub net_delta: i32,
    pub code: Vec<u32>,
}

/// A block must retire at least this many interpreter ops to be worth a JIT call
/// (each fused op saves a dispatch; the native call has fixed overhead).
const MIN_BLOCK_OPS: usize = 4;

/// Total on-wire length of the opcode at `code[pc]` (opcode + operands), via the
/// `fx_vm::Op` enum so it can never drift from the ISA (exhaustive match — a new
/// opcode fails to compile until sized here). `None` = unknown opcode byte.
pub fn op_len(code: &[u8], pc: usize) -> Option<usize> {
    use Op::*;
    let op = Op::from_u8(code[pc])?;
    Some(match op {
        // Variable: 3 header bytes + one component byte per dst lane.
        Swizzle => 3 + *code.get(pc + 2).unwrap_or(&0) as usize,
        Hash1 | Hash3 | Hsv2Rgb | AddI | SubI | MulI | DivI | ModI | NegI | MulFix | DivFix
        | I2F | F2I | Fix2F | F2Fix | I2Fix | Fix2I | RetFn | FloodFrom | AbsI | MinI | MaxI
        | ClampI | RetRgb8 | I2cWrite => 1,
        LoadCtx | Add | Sub | Mul | Div | Neg | Scale | Clamp | Mix | Smoothstep | Dot | Cross
        | Length | Normalize | Distance | Cmp | Logic | Palette | Pop | Ret | CmpI | GraphQuery
        | LoadBuf | StoreBuf | SampleTex | PaintTex | MulFixN | DivFixN | FixRescale | FixToF
        | FixFromF | SinFix | CosFix | ExpFix | SignI | StepI | FloorFix | CeilFix | FractFix
        | MixFix | SqrtFix | CrossFix | ClampVFix | Hsv2RgbFix | Atan2Fix | LogFix | TanFix
        | PowFix | HashFix | Hash3Fix | RetRgbFix | I2cRead => 2,
        PushConst | LoadUniform | LoadState | StoreState | LoadLocal | StoreLocal | UnMath
        | BinMath | BrFalse | Jmp | Swap | Call | ScaleFix | DotFix | LengthFix | DistanceFix
        | NormalizeFix | SmoothstepFix | MixVFix | PaletteFix | FillLocal | TeeLocal | JitCall
        | StoreLedCache => 3,
        LoadCtxFix | IncLocalI | BrCmpI | BinTop => 4,
        LoadLedCache | LoadCtxLanes => 5,
        BinPair => 6,
        MulAdd => 2,
        PushConsts => 2 + 2 * *code.get(pc + 1).unwrap_or(&0) as usize,
        LoadStateIdx | StoreStateIdx | LoadLocalIdx | StoreLocalIdx => 6,
    })
}

/// Map one fx_vm opcode to its JIT [`Ir`], or `None` if it isn't in the supported
/// straight-line integer/fixed subset. Returns `(ir, byte_len)`.
fn op_to_ir(code: &[u8], pc: usize) -> Option<(Ir, usize)> {
    let op = Op::from_u8(code[pc])?;
    let b = |k: usize| *code.get(pc + 1 + k).unwrap_or(&0);
    Some(match op {
        Op::PushConst => (Ir::PushConst(u16::from_le_bytes([b(0), b(1)])), 3),
        Op::LoadLocal if b(1) == 1 => (Ir::LoadLocal(b(0)), 3),
        Op::StoreLocal if b(1) == 1 => (Ir::StoreLocal(b(0)), 3),
        Op::TeeLocal if b(1) == 1 => (Ir::TeeLocal(b(0)), 3),
        Op::AddI => (Ir::AddI, 1),
        Op::SubI => (Ir::SubI, 1),
        Op::MulI => (Ir::MulI, 1),
        Op::NegI => (Ir::NegI, 1),
        Op::MulFix => (Ir::MulFix(16), 1),
        Op::MulFixN => (Ir::MulFix(b(0)), 2),
        Op::Pop => (Ir::Pop(b(0)), 2),
        Op::LoadState if b(1) == 1 => (Ir::LoadState(b(0)), 3),
        Op::StoreState if b(1) == 1 => (Ir::StoreState(b(0)), 3),
        Op::AbsI => (Ir::AbsI, 1),
        Op::MinI => (Ir::MinI, 1),
        Op::MaxI => (Ir::MaxI, 1),
        Op::ClampI => (Ir::ClampI, 1),
        _ => return None,
    })
}

/// Like [`op_to_ir`], but an opcode may lower to several IR ops: the optimizer's
/// `PushConsts` run is its `PushConst`s. Writes into `out` (room for 4) and
/// returns `(ir_count, byte_len)`.
fn op_to_irs(code: &[u8], pc: usize, out: &mut [Ir]) -> Option<(usize, usize)> {
    if Op::from_u8(code[pc])? == Op::PushConsts {
        let n = *code.get(pc + 1)? as usize;
        if n == 0 || n > out.len() || pc + 2 + 2 * n > code.len() {
            return None;
        }
        for (j, o) in out.iter_mut().enumerate().take(n) {
            *o = Ir::PushConst(u16::from_le_bytes([code[pc + 2 + 2 * j], code[pc + 3 + 2 * j]]));
        }
        return Some((n, 2 + 2 * n));
    }
    // An integer-family BinTop/BinPair whose operands are consts/locals is
    // the PushConst/LoadLocal + AddI/SubI/MulI/MulFix it fused.
    let op = Op::from_u8(code[pc])?;
    if matches!(op, Op::BinTop | Op::BinPair) {
        let mode = *code.get(pc + 1)?;
        if mode & 0x40 == 0 || out.len() < 3 {
            return None;
        }
        let rd = |at: usize| Some(u16::from_le_bytes([*code.get(at)?, *code.get(at + 1)?]));
        let src = |s: u8, i: u16| match s & 3 {
            0 => Some(Ir::PushConst(i)),
            1 if i <= u8::MAX as u16 => Some(Ir::LoadLocal(i as u8)),
            2 if i <= u8::MAX as u16 => Some(Ir::LoadState(i as u8)),
            _ => None,
        };
        let arith = match mode & 3 {
            0 => Ir::AddI,
            1 => Ir::SubI,
            2 => Ir::MulI,
            _ => Ir::MulFix(16),
        };
        return if op == Op::BinTop {
            out[0] = src(mode >> 2, rd(pc + 2)?)?;
            out[1] = arith;
            Some((2, 4))
        } else {
            out[0] = src(mode >> 2, rd(pc + 2)?)?;
            out[1] = src(mode >> 4, rd(pc + 4)?)?;
            out[2] = arith;
            Some((3, 6))
        };
    }
    let (ir, len) = op_to_ir(code, pc)?;
    *out.first_mut()? = ir;
    Some((1, len))
}

/// The absolute byte target of a branch/call at `code[pc]`, if any (so a block is
/// never started/extended across a jump into its interior).
fn branch_target(code: &[u8], pc: usize) -> Option<usize> {
    let op = Op::from_u8(code[pc])?;
    let rel16 = |at: usize| i16::from_le_bytes([code[at], code[at + 1]]);
    match op {
        Op::BrFalse | Op::Jmp => Some((pc as isize + 3 + rel16(pc + 1) as isize) as usize),
        Op::BrCmpI => Some((pc as isize + 4 + rel16(pc + 2) as isize) as usize),
        // The per-LED memo's cache-hit skip lands just past its StoreLedCache, so
        // a JIT block must never swallow that landing point.
        Op::LoadLedCache => Some((pc as isize + 5 + rel16(pc + 3) as isize) as usize),
        Op::Call => Some(u16::from_le_bytes([code[pc + 1], code[pc + 2]]) as usize),
        _ => None,
    }
}

/// Longest straight-line JIT block a single plan will hold (in ops). A run longer
/// than this is split; blocks this long are already well past the dispatch
/// break-even, so the tail keeps interpreting.
pub const MAX_BLOCK_IR: usize = 64;

/// no-alloc block scan shared by [`plan_blocks`] and [`plan_blocks_into`]. Walks
/// `code`, marks branch/call targets into `is_target` (caller scratch, len ≥
/// `code.len()+1`), and invokes `on_block(start, end, &irs)` for every maximal
/// supported straight-line run of ≥ [`MIN_BLOCK_OPS`] ops (≥ 3 bytes) that no
/// branch enters mid-way. Returns `false` (scanning nothing) if the stream is
/// malformed. `on_block` decides whether to keep the block.
fn scan_blocks(code: &[u8], is_target: &mut [bool], mut on_block: impl FnMut(usize, usize, &[Ir])) -> bool {
    // Pass 1: mark every branch/call target.
    let mut pc = 0usize;
    while pc < code.len() {
        let len = match op_len(code, pc) {
            Some(l) if l > 0 && pc + l <= code.len() => l,
            _ => return false,
        };
        if let Some(t) = branch_target(code, pc) {
            if t < is_target.len() {
                is_target[t] = true;
            }
        }
        pc += len;
    }
    // Pass 2: form maximal JIT-able blocks.
    let mut irs = [Ir::AddI; MAX_BLOCK_IR];
    let mut pc = 0usize;
    while pc < code.len() {
        let start = pc;
        let mut n = 0usize;
        let mut end = pc;
        let mut q = pc;
        while q < code.len() && n < MAX_BLOCK_IR {
            if q > start && is_target[q] {
                break; // a jump lands here — the block must not swallow it
            }
            let mut tmp = [Ir::AddI; 4];
            match op_to_irs(code, q, &mut tmp) {
                Some((k, len)) if n + k <= MAX_BLOCK_IR => {
                    irs[n..n + k].copy_from_slice(&tmp[..k]);
                    n += k;
                    end = q + len;
                    q += len;
                }
                _ => break,
            }
        }
        if n >= MIN_BLOCK_OPS && end - start >= 3 {
            on_block(start, end, &irs[..n]);
        }
        // Advance past the run we just consumed (or one op if none was JIT-able),
        // so blocks never overlap.
        pc = if end > start && n > 0 {
            end
        } else {
            start + op_len(code, start).unwrap_or(1).max(1)
        };
    }
    true
}

/// Scan a program's `code` and return a compiled JIT [`Plan`] for every hot
/// block. `Vec`-based (host/tests); the firmware uses [`plan_blocks_into`].
#[cfg(feature = "alloc")]
pub fn plan_blocks(code: &[u8]) -> Vec<Plan> {
    let mut is_target = alloc::vec![false; code.len() + 1];
    let mut plans = Vec::new();
    scan_blocks(code, &mut is_target, |start, end, irs| {
        if let Some(seg) = compile(irs) {
            plans.push(Plan { start, end, net_delta: seg.net_delta, code: seg.code });
        }
    });
    plans
}

/// A JIT plan in no-alloc form: the byte range to patch and the segment's
/// location in the shared code arena the firmware passed to [`plan_blocks_into`].
#[derive(Clone, Copy, Default)]
pub struct PlanOut {
    pub start: u16,
    pub end: u16,
    pub net_delta: i16,
    pub code_off: u16,
    pub code_len: u16,
}

/// no-alloc twin of [`plan_blocks`] for the firmware: find hot blocks, compile
/// each into the shared `seg_code` arena, and record a [`PlanOut`] per block.
/// `is_target` is caller scratch (len ≥ `code.len()+1`). Stops early if `plans`
/// or `seg_code` fills. Returns the number of plans written.
pub fn plan_blocks_into(
    code: &[u8],
    is_target: &mut [bool],
    plans: &mut [PlanOut],
    seg_code: &mut [u32],
) -> usize {
    plan_blocks_into_consts(code, is_target, plans, seg_code, usize::MAX)
}

/// [`plan_blocks_into`], skipping any block that reads a const-pool index at or
/// above `n_consts` (the firmware mirrors only the first `n_consts` words for
/// the segments, so a large pool no longer disables the JIT for the whole
/// program).
pub fn plan_blocks_into_consts(
    code: &[u8],
    is_target: &mut [bool],
    plans: &mut [PlanOut],
    seg_code: &mut [u32],
    n_consts: usize,
) -> usize {
    let mut count = 0usize;
    let mut cursor = 0usize;
    scan_blocks(code, is_target, |start, end, irs| {
        if count >= plans.len() {
            return;
        }
        if irs.iter().any(|ir| matches!(*ir, Ir::PushConst(i) if i as usize >= n_consts)) {
            return;
        }
        if let Some(meta) = compile_into(irs, &mut seg_code[cursor..]) {
            plans[count] = PlanOut {
                start: start as u16,
                end: end as u16,
                net_delta: meta.net_delta as i16,
                code_off: cursor as u16,
                code_len: meta.len as u16,
            };
            cursor += meta.len;
            count += 1;
        }
    });
    count
}

// -- reference semantics (mirror fx_vm::run's integer ops) --------------------

/// Execute a block with the EXACT `fx_vm` integer semantics, mutating the given
/// operand stack + locals. The differential test proves the JIT matches this,
/// and a cross-check proves this matches the real `fx_vm`.
#[cfg(feature = "alloc")]
pub fn reference(block: &[Ir], stack: &mut Vec<i32>, locals: &mut [i32], consts: &[i32]) {
    reference_state(block, stack, locals, consts, &mut [])
}

/// [`reference`] with a `state` array for `LoadState`/`StoreState`.
#[cfg(feature = "alloc")]
pub fn reference_state(block: &[Ir], stack: &mut Vec<i32>, locals: &mut [i32], consts: &[i32], state: &mut [i32]) {
    for op in block {
        match *op {
            Ir::LoadState(s) => stack.push(state[s as usize]),
            Ir::StoreState(s) => {
                let v = stack.pop().unwrap();
                state[s as usize] = v;
            }
            Ir::AbsI => {
                let a = stack.pop().unwrap();
                stack.push(a.wrapping_abs());
            }
            Ir::MinI => {
                let b = stack.pop().unwrap();
                let a = stack.pop().unwrap();
                stack.push(if a < b { a } else { b });
            }
            Ir::MaxI => {
                let b = stack.pop().unwrap();
                let a = stack.pop().unwrap();
                stack.push(if a > b { a } else { b });
            }
            Ir::ClampI => {
                let hi = stack.pop().unwrap();
                let lo = stack.pop().unwrap();
                let x = stack.pop().unwrap();
                stack.push(if x < lo {
                    lo
                } else if x > hi {
                    hi
                } else {
                    x
                });
            }
            Ir::PushConst(idx) => stack.push(consts[idx as usize]),
            Ir::LoadLocal(s) => stack.push(locals[s as usize]),
            Ir::StoreLocal(s) => {
                let v = stack.pop().unwrap();
                locals[s as usize] = v;
            }
            Ir::TeeLocal(s) => {
                locals[s as usize] = *stack.last().unwrap();
            }
            Ir::AddI => {
                let b = stack.pop().unwrap();
                let a = stack.pop().unwrap();
                stack.push(a.wrapping_add(b));
            }
            Ir::SubI => {
                let b = stack.pop().unwrap();
                let a = stack.pop().unwrap();
                stack.push(a.wrapping_sub(b));
            }
            Ir::MulI => {
                let b = stack.pop().unwrap();
                let a = stack.pop().unwrap();
                stack.push(a.wrapping_mul(b));
            }
            Ir::NegI => {
                let a = stack.pop().unwrap();
                stack.push(a.wrapping_neg());
            }
            Ir::MulFix(frac) => {
                let b = stack.pop().unwrap() as i64;
                let a = stack.pop().unwrap() as i64;
                stack.push(((a * b) >> frac) as i32);
            }
            Ir::Pop(n) => {
                for _ in 0..n {
                    stack.pop();
                }
            }
        }
    }
}

// -- minimal RV32IM emulator (host verification of the emitted segment) -------

/// Execute an emitted PIC segment (a `&[u32]`) against a flat byte memory, with
/// `a0`/`a1`/`a2` pointing at caller-provided regions. Runs until `ret`. Only
/// the instructions [`compile`] emits are decoded (an unknown word panics, which
/// would flag an encoder/translator mismatch in tests).
pub mod emu {
    /// `mem` is little-endian byte memory; `a0/a1/a2` are byte addresses into it.
    pub fn run(code: &[u32], a0: u32, a1: u32, a2: u32, mem: &mut [u8]) {
        run_state(code, a0, a1, a2, 0, mem)
    }

    /// [`run`] with `a3` = the state base.
    pub fn run_state(code: &[u32], a0: u32, a1: u32, a2: u32, a3: u32, mem: &mut [u8]) {
        let mut x = [0i32; 32];
        x[10] = a0 as i32;
        x[11] = a1 as i32;
        x[12] = a2 as i32;
        x[13] = a3 as i32;
        let mut pc = 0usize;
        let lw = |mem: &[u8], addr: i32| -> i32 {
            let a = addr as usize;
            i32::from_le_bytes([mem[a], mem[a + 1], mem[a + 2], mem[a + 3]])
        };
        let sw = |mem: &mut [u8], addr: i32, v: i32| {
            let a = addr as usize;
            mem[a..a + 4].copy_from_slice(&v.to_le_bytes());
        };
        while pc < code.len() {
            let w = code[pc];
            pc += 1;
            let opcode = w & 0x7f;
            let rd = ((w >> 7) & 0x1f) as usize;
            let f3 = (w >> 12) & 0x7;
            let rs1 = ((w >> 15) & 0x1f) as usize;
            let rs2 = ((w >> 20) & 0x1f) as usize;
            let f7 = w >> 25;
            match opcode {
                0x33 => {
                    // R-type
                    let a = x[rs1];
                    let b = x[rs2];
                    let v = match (f7, f3) {
                        (0x00, 0x0) => a.wrapping_add(b),
                        (0x20, 0x0) => a.wrapping_sub(b),
                        (0x01, 0x0) => a.wrapping_mul(b),
                        (0x01, 0x1) => ((a as i64 * b as i64) >> 32) as i32, // mulh
                        (0x00, 0x6) => a | b,
                        (0x00, 0x2) => (a < b) as i32, // slt
                        (0x00, 0x4) => a ^ b,
                        (0x00, 0x7) => a & b,
                        _ => panic!("emu: unknown R-type f7={f7:#x} f3={f3}"),
                    };
                    if rd != 0 {
                        x[rd] = v;
                    }
                }
                0x13 => {
                    // I-type ALU (addi sign-extends imm[11:0]; the shifts use shamt)
                    let a = x[rs1];
                    let shamt = (w >> 20) & 0x1f;
                    let v = match f3 {
                        0x0 => a.wrapping_add((w as i32) >> 20), // addi
                        0x1 => ((a as u32) << shamt) as i32,     // slli
                        0x5 => {
                            if (f7 & 0x20) != 0 {
                                a >> shamt // srai (arithmetic)
                            } else {
                                ((a as u32) >> shamt) as i32 // srli
                            }
                        }
                        _ => panic!("emu: unknown I-ALU f3={f3}"),
                    };
                    if rd != 0 {
                        x[rd] = v;
                    }
                }
                0x03 => {
                    // loads (only lw)
                    assert_eq!(f3, 0x2, "emu: only lw supported");
                    let off = (w as i32) >> 20;
                    let v = lw(mem, x[rs1].wrapping_add(off));
                    if rd != 0 {
                        x[rd] = v;
                    }
                }
                0x23 => {
                    // stores (only sw)
                    assert_eq!(f3, 0x2, "emu: only sw supported");
                    let imm = (((w >> 25) & 0x7f) << 5) | ((w >> 7) & 0x1f);
                    let off = ((imm as i32) << 20) >> 20; // sign-extend 12 bits
                    sw(mem, x[rs1].wrapping_add(off), x[rs2]);
                }
                0x67 => break, // jalr -> ret
                _ => panic!("emu: unknown opcode {opcode:#x}"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodings_match_known_words() {
        // Pinned against the RISC-V ISA manual encodings.
        assert_eq!(rv32::add(rv32::T0, rv32::T0, rv32::T1), 0x006282b3);
        assert_eq!(rv32::sub(rv32::T0, rv32::ZERO, rv32::T0), 0x405002b3);
        assert_eq!(rv32::mul(rv32::T2, rv32::T0, rv32::T1), 0x026283b3);
        assert_eq!(rv32::ret(), 0x00008067);
        // lw t0, 8(a0) ; sw t0, 12(a0)
        assert_eq!(rv32::lw(rv32::T0, rv32::A0, 8), 0x00852283);
        assert_eq!(rv32::sw(rv32::T0, rv32::A0, 12), 0x00552623);
    }

    /// Run an emitted segment over the given state via the emulator, returning
    /// the resulting operand stack (length = entry len + net_delta).
    fn run_jit(block: &[Ir], stack_in: &[i32], locals_in: &[i32], consts: &[i32]) -> (Vec<i32>, Vec<i32>) {
        let seg = compile(block).expect("block should be JIT-able");
        // Flat memory: [stack region | locals region | consts region].
        const STACK_BYTES: usize = 256 * 4;
        const LOCAL_BYTES: usize = 256 * 4;
        let const_bytes = consts.len().max(1) * 4;
        let mut mem = alloc::vec![0u8; STACK_BYTES + LOCAL_BYTES + const_bytes];
        let stack_base = 0u32;
        let locals_base = STACK_BYTES as u32;
        let consts_base = (STACK_BYTES + LOCAL_BYTES) as u32;
        // a0 points at the current TOS (== stack_in.len()).
        let sp0 = stack_in.len();
        for (i, &v) in stack_in.iter().enumerate() {
            mem[i * 4..i * 4 + 4].copy_from_slice(&v.to_le_bytes());
        }
        for (i, &v) in locals_in.iter().enumerate() {
            let a = locals_base as usize + i * 4;
            mem[a..a + 4].copy_from_slice(&v.to_le_bytes());
        }
        for (i, &v) in consts.iter().enumerate() {
            let a = consts_base as usize + i * 4;
            mem[a..a + 4].copy_from_slice(&v.to_le_bytes());
        }
        // The state array sits in the upper half of the locals region.
        let state_base = locals_base + 128 * 4;
        for (i, &v) in STATE_IN.iter().enumerate() {
            let a = state_base as usize + i * 4;
            mem[a..a + 4].copy_from_slice(&v.to_le_bytes());
        }
        emu::run_state(&seg.code, stack_base + (sp0 as u32) * 4, locals_base, consts_base, state_base, &mut mem);
        let final_len = (sp0 as i32 + seg.net_delta) as usize;
        let stack_out: Vec<i32> = (0..final_len)
            .map(|i| i32::from_le_bytes([mem[i * 4], mem[i * 4 + 1], mem[i * 4 + 2], mem[i * 4 + 3]]))
            .collect();
        // Locals then the state array (so one comparison covers both).
        let locals_out: Vec<i32> = (0..locals_in.len())
            .map(|i| locals_base as usize + i * 4)
            .chain((0..STATE_IN.len()).map(|i| state_base as usize + i * 4))
            .map(|a| i32::from_le_bytes([mem[a], mem[a + 1], mem[a + 2], mem[a + 3]]))
            .collect();
        (stack_out, locals_out)
    }

    /// The state array every emulated block starts from.
    const STATE_IN: [i32; 4] = [7, -70_000, i32::MIN, 123_456];

    /// The reference run, with its locals and state concatenated like
    /// [`run_jit`]'s.
    fn run_ref(block: &[Ir], stack_in: &[i32], locals_in: &[i32], consts: &[i32]) -> (Vec<i32>, Vec<i32>) {
        let mut st = stack_in.to_vec();
        let mut lo = locals_in.to_vec();
        let mut state = STATE_IN.to_vec();
        reference_state(block, &mut st, &mut lo, consts, &mut state);
        lo.extend(state);
        (st, lo)
    }

    /// A cheap deterministic PRNG (no external deps; varies by index).
    fn lcg(state: &mut u64) -> u32 {
        *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (*state >> 33) as u32
    }

    #[test]
    fn jit_matches_reference_over_random_blocks() {
        let mut rng = 0x1234_5678_9abc_def0u64;
        let consts: Vec<i32> = (0..8).map(|i| (i - 3) * 37).collect();
        for _ in 0..20000 {
            // Build a random VALID straight-line block (tracks depth so ops never
            // underflow), starting from a small random stack.
            let start_depth = (lcg(&mut rng) % 3) as i32;
            let mut depth = start_depth;
            let mut block: Vec<Ir> = Vec::new();
            // Up to the planner's block cap, so long blocks exercise the 12-
            // register pool running out (spills) as well as short ones.
            let steps = 1 + lcg(&mut rng) % if lcg(&mut rng) % 4 == 0 { MAX_BLOCK_IR as u32 } else { 12 };
            for _ in 0..steps {
                let choice = lcg(&mut rng) % 16;
                let ir = match choice {
                    10 => Ir::LoadState((lcg(&mut rng) % 4) as u8),
                    11 if depth >= 1 => Ir::StoreState((lcg(&mut rng) % 4) as u8),
                    12 if depth >= 1 => Ir::AbsI,
                    13 if depth >= 2 => Ir::MinI,
                    14 if depth >= 2 => Ir::MaxI,
                    15 if depth >= 3 => Ir::ClampI,
                    0 => Ir::PushConst((lcg(&mut rng) % consts.len() as u32) as u16),
                    1 => Ir::LoadLocal((lcg(&mut rng) % 4) as u8),
                    2 if depth >= 1 => Ir::StoreLocal((lcg(&mut rng) % 4) as u8),
                    3 if depth >= 2 => Ir::AddI,
                    4 if depth >= 2 => Ir::SubI,
                    5 if depth >= 2 => Ir::MulI,
                    6 if depth >= 1 => Ir::NegI,
                    7 if depth >= 2 => Ir::MulFix(1 + (lcg(&mut rng) % 31) as u8),
                    8 if depth >= 1 => Ir::Pop(1),
                    9 if depth >= 1 => Ir::TeeLocal((lcg(&mut rng) % 4) as u8),
                    _ => Ir::PushConst((lcg(&mut rng) % consts.len() as u32) as u16),
                };
                // Update the model depth exactly as compile()/reference() will.
                depth += match ir {
                    Ir::PushConst(_) | Ir::LoadLocal(_) | Ir::LoadState(_) => 1,
                    Ir::StoreLocal(_) | Ir::AddI | Ir::SubI | Ir::MulI | Ir::MulFix(_) => -1,
                    Ir::StoreState(_) | Ir::MinI | Ir::MaxI => -1,
                    Ir::ClampI => -2,
                    Ir::NegI | Ir::TeeLocal(_) | Ir::AbsI => 0,
                    Ir::Pop(n) => -(n as i32),
                };
                block.push(ir);
            }

            let stack_in: Vec<i32> = (0..start_depth).map(|_| lcg(&mut rng) as i32).collect();
            let locals_in: Vec<i32> = (0..4).map(|_| lcg(&mut rng) as i32).collect();

            // Reference.
            let (rstack, rlocals) = run_ref(&block, &stack_in, &locals_in, &consts);

            // JIT via emulator.
            let (jstack, jlocals) = run_jit(&block, &stack_in, &locals_in, &consts);

            assert_eq!(rstack, jstack, "stack mismatch for block {block:?}");
            assert_eq!(rlocals, jlocals, "locals mismatch for block {block:?}");
        }
    }

    #[test]
    fn deep_blocks_spill_and_match_the_reference() {
        // Push past the 12-register pool, then fold it back down: every push
        // beyond 12 spills the deepest cached slot; the result must still match.
        let mut rng = 0x0bad_cafe_u64;
        let consts: Vec<i32> = (0..8).map(|i| 1000 * i - 3500).collect();
        for _ in 0..2000 {
            let start_depth = (lcg(&mut rng) % 4) as i32;
            let pushes = 13 + lcg(&mut rng) % 18;
            let mut block = Vec::new();
            for _ in 0..pushes {
                block.push(if lcg(&mut rng) % 2 == 0 {
                    Ir::PushConst((lcg(&mut rng) % 8) as u16)
                } else {
                    Ir::LoadLocal((lcg(&mut rng) % 4) as u8)
                });
            }
            let mut depth = start_depth + pushes as i32;
            while block.len() < MAX_BLOCK_IR && depth >= 2 {
                block.push(match lcg(&mut rng) % 4 {
                    0 => Ir::AddI,
                    1 => Ir::SubI,
                    2 => Ir::MulI,
                    _ => Ir::MulFix(1 + (lcg(&mut rng) % 31) as u8),
                });
                depth -= 1;
                if lcg(&mut rng) % 5 == 0 {
                    block.push(Ir::TeeLocal((lcg(&mut rng) % 4) as u8));
                }
            }
            let stack_in: Vec<i32> = (0..start_depth).map(|_| lcg(&mut rng) as i32).collect();
            let locals_in: Vec<i32> = (0..4).map(|_| lcg(&mut rng) as i32).collect();
            let (rstack, rlocals) = run_ref(&block, &stack_in, &locals_in, &consts);
            let (jstack, jlocals) = run_jit(&block, &stack_in, &locals_in, &consts);
            assert_eq!(rstack, jstack, "stack mismatch for block {block:?}");
            assert_eq!(rlocals, jlocals, "locals mismatch for block {block:?}");
        }
    }

    #[test]
    fn register_caching_shrinks_the_code() {
        // a*b + c over locals: the old codegen did a load+store per op (5 ops,
        // ~14 words); cached, it is 3 loads, 2 ALU ops, 1 write-back and ret.
        let s = compile(&[Ir::LoadLocal(0), Ir::LoadLocal(1), Ir::MulI, Ir::LoadLocal(2), Ir::AddI]).unwrap();
        assert_eq!(s.code.len(), 7, "{:08x?}", s.code);
    }

    #[test]
    fn blocks_consuming_entry_operands_report_min_depth() {
        // Consuming values already on the stack is valid; the segment reports how
        // deep it reaches so the VM can gate on the live `sp`.
        let s = compile(&[Ir::AddI]).expect("AddI is JIT-able against entry operands");
        assert_eq!(s.min_depth, -2, "AddI reads two entry operands");
        assert_eq!(s.net_delta, -1);
        let s = compile(&[Ir::StoreLocal(0)]).expect("StoreLocal is JIT-able");
        assert_eq!(s.min_depth, -1);
        assert_eq!(s.net_delta, -1);
    }

    #[test]
    fn compile_into_matches_the_vec_compile() {
        // The no-alloc firmware path must emit byte-identical code to the Vec path.
        let block = [
            Ir::LoadLocal(0),
            Ir::PushConst(2),
            Ir::MulI,
            Ir::PushConst(1),
            Ir::AddI,
            Ir::MulFix(16),
        ];
        let seg = compile(&block).unwrap();
        let mut out = [0u32; 64];
        let meta = compile_into(&block, &mut out).unwrap();
        assert_eq!(&out[..meta.len], &seg.code[..]);
        assert_eq!(meta.net_delta, seg.net_delta);
        assert_eq!(meta.min_depth, seg.min_depth);
        // Too-small buffer is rejected, not overrun.
        let mut tiny = [0u32; 2];
        assert!(compile_into(&block, &mut tiny).is_none());
    }

    #[test]
    fn plan_blocks_into_matches_plan_blocks() {
        use ledmapper_fx_vm::Op;
        #[rustfmt::skip]
        let code = [
            Op::LoadCtx as u8, 0,
            Op::LoadLocal as u8, 0, 1,
            Op::PushConst as u8, 0, 0,
            Op::MulI as u8,
            Op::PushConst as u8, 1, 0,
            Op::AddI as u8,
            Op::Ret as u8, 0,
        ];
        let vec_plans = plan_blocks(&code);
        let mut is_target = [false; 64];
        let mut plans = [PlanOut::default(); 8];
        let mut seg = [0u32; 256];
        let n = plan_blocks_into(&code, &mut is_target, &mut plans, &mut seg);
        assert_eq!(n, vec_plans.len());
        for (i, vp) in vec_plans.iter().enumerate() {
            assert_eq!(plans[i].start as usize, vp.start);
            assert_eq!(plans[i].end as usize, vp.end);
            assert_eq!(plans[i].net_delta as i32, vp.net_delta);
            let po = &plans[i];
            assert_eq!(&seg[po.code_off as usize..(po.code_off + po.code_len) as usize], &vp.code[..]);
        }
    }

    #[test]
    fn plan_blocks_finds_the_integer_run_between_non_jit_ops() {
        use ledmapper_fx_vm::Op;
        // LoadCtx (non-JIT) | LoadLocal;PushConst;MulI;PushConst;AddI (5-op block) | Ret
        #[rustfmt::skip]
        let code = [
            Op::LoadCtx as u8, 0,          // 0: non-JIT (2 bytes)
            Op::LoadLocal as u8, 0, 1,     // 2: block start
            Op::PushConst as u8, 0, 0,     // 5
            Op::MulI as u8,                // 8
            Op::PushConst as u8, 1, 0,     // 9
            Op::AddI as u8,                // 12: block end -> 13
            Op::Ret as u8, 0,              // 13: non-JIT
        ];
        let plans = plan_blocks(&code);
        assert_eq!(plans.len(), 1, "one JIT-able block");
        assert_eq!((plans[0].start, plans[0].end), (2, 13));
        assert_eq!(plans[0].net_delta, 1, "5 ops net +1 on the stack");
        assert!(!plans[0].code.is_empty());
    }

    #[test]
    fn plan_blocks_lowers_a_push_consts_run() {
        use ledmapper_fx_vm::Op;
        // The optimizer's PushConsts (2 consts) stays inside a JIT block, as the
        // two PushConst it replaced did: LoadLocal; PushConsts c0 c1; MulI; AddI.
        #[rustfmt::skip]
        let code = [
            Op::LoadCtx as u8, 0,                  // 0: non-JIT
            Op::LoadLocal as u8, 0, 1,             // 2: block start
            Op::PushConsts as u8, 2, 0, 0, 1, 0,   // 5
            Op::MulI as u8,                        // 11
            Op::AddI as u8,                        // 12: block end -> 13
            Op::Ret as u8, 0,                      // 13
        ];
        let plans = plan_blocks(&code);
        assert_eq!(plans.len(), 1);
        assert_eq!((plans[0].start, plans[0].end), (2, 13));
        assert_eq!(plans[0].net_delta, 1);
    }

    #[test]
    fn plan_blocks_lowers_integer_bin_ops_and_skips_float_ones() {
        use ledmapper_fx_vm::Op;
        // BinPair mulfix(local0, c1) ; BinTop addi(c0) ; BinTop subi(local2) is
        // JIT-able (+1 net); a float BinTop (mode bit 6 clear) ends the block.
        #[rustfmt::skip]
        let code = [
            Op::LoadCtx as u8, 0,                         // 0
            Op::BinPair as u8, 0x43 | 1 << 2, 0, 0, 1, 0, // 2: local0 *fix c1
            Op::BinTop as u8, 0x40, 0, 0,                 // 8: + c0
            Op::BinTop as u8, 0x41 | 1 << 2, 2, 0,        // 12: - local2 -> 16
            Op::BinTop as u8, 0x02, 0, 0,                 // 16: float mul (not JIT)
            Op::Ret as u8, 0,
        ];
        let plans = plan_blocks(&code);
        assert_eq!(plans.len(), 1);
        assert_eq!((plans[0].start, plans[0].end), (2, 16));
        assert_eq!(plans[0].net_delta, 1);
    }

    #[test]
    fn plan_blocks_stops_at_a_branch_target_interior() {
        use ledmapper_fx_vm::Op;
        // A Jmp lands in the MIDDLE of an otherwise-JIT-able run; the block must
        // not swallow the target, so no single block spans it. Layout:
        //   0: PushConst        (block A candidate)
        //   3: PushConst
        //   6: AddI
        //   7: PushConst        <- Jmp target (interior) -> A ends at 7
        //   10: AddI
        //   11: Jmp -> 7
        #[rustfmt::skip]
        let code = [
            Op::PushConst as u8, 0, 0, // 0
            Op::PushConst as u8, 0, 0, // 3
            Op::AddI as u8,            // 6
            Op::PushConst as u8, 0, 0, // 7  <- target
            Op::AddI as u8,            // 10
            Op::Jmp as u8, 0xF8, 0xFF, // 11: rel -8 -> 14-8 = ... target 7
        ];
        // rel: target = pc(11)+3 + rel; want 7 => rel = 7 - 14 = -7 => 0xFFF9.
        let mut code = code;
        code[12] = 0xF9;
        code[13] = 0xFF;
        let plans = plan_blocks(&code);
        // Block A = [0,7) (PushConst;PushConst;AddI = 3 ops < MIN 4) -> dropped.
        // The run from 7 (PushConst;AddI = 2 ops) is also < MIN. So no plans, and
        // crucially none spans the target at 7.
        assert!(plans.iter().all(|p| !(p.start < 7 && p.end > 7)), "no block crosses the target");
    }

    #[test]
    fn unjitable_blocks_are_rejected_not_miscompiled() {
        // Bad fixed frac.
        assert!(compile(&[Ir::PushConst(0), Ir::PushConst(0), Ir::MulFix(0)]).is_none());
        assert!(compile(&[Ir::PushConst(0), Ir::PushConst(0), Ir::MulFix(32)]).is_none());
        // A const index whose byte offset exceeds the signed load immediate range.
        assert!(compile(&[Ir::PushConst(1000)]).is_none());
        // A local slot whose byte offset exceeds the range.
        assert!(compile(&[Ir::LoadLocal(255), Ir::LoadLocal(255)]).is_some()); // 255*4 = 1020, fits
    }
}
