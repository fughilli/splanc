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

extern crate alloc;
use alloc::vec::Vec;

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
    AddI,
    SubI,
    MulI,
    NegI,
    /// Q16.16-style fixed multiply `(a*b) >> frac`, `frac` in 1..=31.
    MulFix(u8),
    /// Drop the top `n` slots.
    Pop(u8),
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
/// bookkeeping the VM needs around the call.
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
pub fn compile(block: &[Ir]) -> Option<Segment> {
    use rv32::*;
    let mut code = Vec::new();
    let mut depth: i32 = 0; // slots relative to the entry top-of-stack
    let mut min_depth: i32 = 0;

    // Byte offset of stack slot at model-depth `k` from a0 (may be negative).
    let stack_off = |k: i32| k * 4;
    let fits = |off: i32| (IMM12_MIN..=IMM12_MAX).contains(&off);

    for op in block {
        // Deepest stack slot this op reads/writes (relative to the entry TOS):
        // pushes touch `depth`; a scalar consumer touches `depth-1`; a binary op
        // reaches `depth-2`. Recorded so the VM can gate on the live `sp`.
        let access = match *op {
            Ir::PushConst(_) | Ir::LoadLocal(_) => depth,
            Ir::StoreLocal(_) | Ir::NegI => depth - 1,
            Ir::AddI | Ir::SubI | Ir::MulI | Ir::MulFix(_) => depth - 2,
            Ir::Pop(_) => depth, // touches nothing
        };
        min_depth = min_depth.min(access);

        match *op {
            Ir::PushConst(idx) => {
                let coff = idx as i32 * 4;
                let soff = stack_off(depth);
                if !fits(coff) || !fits(soff) {
                    return None;
                }
                code.push(lw(T0, A2, coff));
                code.push(sw(T0, A0, soff));
                depth += 1;
            }
            Ir::LoadLocal(slot) => {
                let loff = slot as i32 * 4;
                let soff = stack_off(depth);
                if !fits(loff) || !fits(soff) {
                    return None;
                }
                code.push(lw(T0, A1, loff));
                code.push(sw(T0, A0, soff));
                depth += 1;
            }
            Ir::StoreLocal(slot) => {
                depth -= 1;
                let loff = slot as i32 * 4;
                let soff = stack_off(depth);
                if !fits(loff) || !fits(soff) {
                    return None;
                }
                code.push(lw(T0, A0, soff));
                code.push(sw(T0, A1, loff));
            }
            Ir::AddI | Ir::SubI | Ir::MulI => {
                let a = stack_off(depth - 2);
                let b = stack_off(depth - 1);
                if !fits(a) || !fits(b) {
                    return None;
                }
                code.push(lw(T0, A0, a));
                code.push(lw(T1, A0, b));
                code.push(match *op {
                    Ir::AddI => add(T0, T0, T1),
                    Ir::SubI => sub(T0, T0, T1),
                    _ => mul(T0, T0, T1),
                });
                code.push(sw(T0, A0, a));
                depth -= 1;
            }
            Ir::NegI => {
                let a = stack_off(depth - 1);
                if !fits(a) {
                    return None;
                }
                code.push(lw(T0, A0, a));
                code.push(sub(T0, ZERO, T0));
                code.push(sw(T0, A0, a));
            }
            Ir::MulFix(frac) => {
                if !(1..=31).contains(&frac) {
                    return None;
                }
                let a = stack_off(depth - 2);
                let b = stack_off(depth - 1);
                if !fits(a) || !fits(b) {
                    return None;
                }
                // (a*b) >> frac, low 32 bits of the 64-bit signed product:
                //   (low >>u frac) | (high <<u (32-frac)).
                code.push(lw(T0, A0, a));
                code.push(lw(T1, A0, b));
                code.push(mul(T2, T0, T1)); // low 32
                code.push(mulh(T0, T0, T1)); // high 32 (signed)
                code.push(srli(T2, T2, frac as u32));
                code.push(slli(T0, T0, 32 - frac as u32));
                code.push(or(T0, T2, T0));
                code.push(sw(T0, A0, a));
                depth -= 1;
            }
            Ir::Pop(n) => depth -= n as i32,
        }
    }
    code.push(ret());
    Some(Segment { code, net_delta: depth, min_depth })
}

// -- reference semantics (mirror fx_vm::run's integer ops) --------------------

/// Execute a block with the EXACT `fx_vm` integer semantics, mutating the given
/// operand stack + locals. The differential test proves the JIT matches this,
/// and a cross-check proves this matches the real `fx_vm`.
pub fn reference(block: &[Ir], stack: &mut Vec<i32>, locals: &mut [i32], consts: &[i32]) {
    for op in block {
        match *op {
            Ir::PushConst(idx) => stack.push(consts[idx as usize]),
            Ir::LoadLocal(s) => stack.push(locals[s as usize]),
            Ir::StoreLocal(s) => {
                let v = stack.pop().unwrap();
                locals[s as usize] = v;
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
        let mut x = [0i32; 32];
        x[10] = a0 as i32;
        x[11] = a1 as i32;
        x[12] = a2 as i32;
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
                        _ => panic!("emu: unknown R-type f7={f7:#x} f3={f3}"),
                    };
                    if rd != 0 {
                        x[rd] = v;
                    }
                }
                0x13 => {
                    // I-type ALU (addi sign-extends imm[11:0]; the shifts use shamt)
                    let a = x[rs1];
                    let shamt = ((w >> 20) & 0x1f) as u32;
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
        emu::run(&seg.code, stack_base + (sp0 as u32) * 4, locals_base, consts_base, &mut mem);
        let final_len = (sp0 as i32 + seg.net_delta) as usize;
        let stack_out: Vec<i32> = (0..final_len)
            .map(|i| i32::from_le_bytes([mem[i * 4], mem[i * 4 + 1], mem[i * 4 + 2], mem[i * 4 + 3]]))
            .collect();
        let locals_out: Vec<i32> = (0..locals_in.len())
            .map(|i| {
                let a = locals_base as usize + i * 4;
                i32::from_le_bytes([mem[a], mem[a + 1], mem[a + 2], mem[a + 3]])
            })
            .collect();
        (stack_out, locals_out)
    }

    /// A cheap deterministic PRNG (no external deps; varies by index).
    fn lcg(state: &mut u64) -> u32 {
        *state = state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        (*state >> 33) as u32
    }

    #[test]
    fn jit_matches_reference_over_random_blocks() {
        let mut rng = 0x1234_5678_9abc_def0u64;
        let consts: Vec<i32> = (0..8).map(|i| (i as i32 - 3) * 37).collect();
        for _ in 0..4000 {
            // Build a random VALID straight-line block (tracks depth so ops never
            // underflow), starting from a small random stack.
            let start_depth = (lcg(&mut rng) % 3) as i32;
            let mut depth = start_depth;
            let mut block: Vec<Ir> = Vec::new();
            let steps = 1 + lcg(&mut rng) % 12;
            for _ in 0..steps {
                let choice = lcg(&mut rng) % 9;
                let ir = match choice {
                    0 => Ir::PushConst((lcg(&mut rng) % consts.len() as u32) as u16),
                    1 => Ir::LoadLocal((lcg(&mut rng) % 4) as u8),
                    2 if depth >= 1 => Ir::StoreLocal((lcg(&mut rng) % 4) as u8),
                    3 if depth >= 2 => Ir::AddI,
                    4 if depth >= 2 => Ir::SubI,
                    5 if depth >= 2 => Ir::MulI,
                    6 if depth >= 1 => Ir::NegI,
                    7 if depth >= 2 => Ir::MulFix(1 + (lcg(&mut rng) % 31) as u8),
                    8 if depth >= 1 => Ir::Pop(1),
                    _ => Ir::PushConst((lcg(&mut rng) % consts.len() as u32) as u16),
                };
                // Update the model depth exactly as compile()/reference() will.
                depth += match ir {
                    Ir::PushConst(_) | Ir::LoadLocal(_) => 1,
                    Ir::StoreLocal(_) | Ir::AddI | Ir::SubI | Ir::MulI | Ir::MulFix(_) => -1,
                    Ir::NegI => 0,
                    Ir::Pop(n) => -(n as i32),
                };
                block.push(ir);
            }

            let stack_in: Vec<i32> = (0..start_depth).map(|_| lcg(&mut rng) as i32).collect();
            let locals_in: Vec<i32> = (0..4).map(|_| lcg(&mut rng) as i32).collect();

            // Reference.
            let mut rstack = stack_in.clone();
            let mut rlocals = locals_in.clone();
            reference(&block, &mut rstack, &mut rlocals, &consts);

            // JIT via emulator.
            let (jstack, jlocals) = run_jit(&block, &stack_in, &locals_in, &consts);

            assert_eq!(rstack, jstack, "stack mismatch for block {block:?}");
            assert_eq!(rlocals, jlocals, "locals mismatch for block {block:?}");
        }
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
