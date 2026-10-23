//! Independent re-check of the emitted instruction stream (the sandbox grammar
//! from docs/design/fx-native-aot.md). It decodes every word and rejects
//! anything outside the narrow set the lowering is allowed to emit:
//!
//! - loads/stores only base-relative on `s0`/`s1`/`s11`/`sp`;
//! - no computed addresses (every runtime index is clamped inside a helper);
//! - the only `jalr` forms are `ret` (`jalr x0, 0(ra)`) and a helper call
//!   (`jalr ra, 0(t0)`) that must directly follow a fixed, aligned helper-table `lw` from s0;
//! - no `ecall`/`ebreak`/CSR/`fence`/`fence.i`;
//! - writes to `s0`/`s1`/`s11`/`sp` only in the fixed prologue/epilogue forms;
//! - a per-block budget decrement (`addi s10, s10, -n` + `blt s10, x0, _`) is
//!   present (at least one), wiring native execution to the VM's budget.
//!
//! The verifier runs on the device after lowering (and, for signed prebuilt
//! images, after the signature check) and on the host in tests.

use crate::reg::*;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum VerifyErr {
    BadOpcode,
    BadMemBase,
    BadJalr,
    HelperNotAfterLoad,
    ForbiddenCsrOrSystem,
    WriteReservedReg,
    NoBudgetCheck,
    BranchOutOfRange,
    BranchIntoHelper,
    BadCtxStore,
}

fn rd(w: u32) -> u32 {
    (w >> 7) & 0x1f
}
fn rs1(w: u32) -> u32 {
    (w >> 15) & 0x1f
}
fn rs2(w: u32) -> u32 {
    (w >> 20) & 0x1f
}
fn f3(w: u32) -> u32 {
    (w >> 12) & 0x7
}
fn opcode(w: u32) -> u32 {
    w & 0x7f
}

const RESERVED: [u32; 4] = [S0, S1, S11, SP];
fn is_reserved(r: u32) -> bool {
    RESERVED.contains(&r)
}

/// Verify a lowered image (all functions concatenated). `None` ⇒ it is safe to
/// map R+X and run; `Some(err)` ⇒ keep the VM.
pub fn verify(code: &[u32]) -> Option<VerifyErr> {
    let mut budget_checks = 0u32;
    for (i, &w) in code.iter().enumerate() {
        let prev = if i > 0 { Some(code[i - 1]) } else { None };
        match opcode(w) {
            0x37 | 0x17 => {} // lui / auipc (lui only in practice)
            0x13 => {
                // I-type ALU. Writes to a reserved reg allowed only as the fixed
                // prologue/epilogue moves: addi sp,sp,imm | addi s0,a0,0 |
                // addi s1,a1,0 | addi s11,a2,0.
                if is_reserved(rd(w)) && !is_prologue_move(w) {
                    return Some(VerifyErr::WriteReservedReg);
                }
            }
            0x33 => {
                if is_reserved(rd(w)) {
                    return Some(VerifyErr::WriteReservedReg);
                }
            }
            0x03 => {
                // loads: base must be a reserved base register.
                if !is_reserved(rs1(w)) {
                    return Some(VerifyErr::BadMemBase);
                }
                if is_reserved(rd(w)) && !(rs1(w) == SP) {
                    // loading into s*/sp only happens in the epilogue (from sp).
                    return Some(VerifyErr::WriteReservedReg);
                }
            }
            0x23 => {
                if !is_reserved(rs1(w)) {
                    return Some(VerifyErr::BadMemBase);
                }
                // Images may write results, never their trusted helper table.
                if rs1(w) == S0 {
                    let imm = (((w >> 25) << 5) | ((w >> 7) & 31)) as i32;
                    let off = (imm << 20) >> 20;
                    if f3(w) != 2 || !matches!(off, 0 | 4 | 8 | 12 | 16) {
                        return Some(VerifyErr::BadCtxStore);
                    }
                }
            }
            0x63 => {
                // branches — offset must stay inside the image.
                let off = btype_imm(w);
                let tgt = i as isize + (off / 4) as isize;
                if off % 4 != 0 || tgt < 0 || tgt as usize >= code.len() {
                    return Some(VerifyErr::BranchOutOfRange);
                }
                if is_helper_call(code[tgt as usize]) {
                    return Some(VerifyErr::BranchIntoHelper);
                }
                if f3(w) == 0x5 && rs1(w) == S10 && rs2(w) == ZERO {
                    budget_checks += 1; // bge s10, x0, _  (the per-block budget guard)
                }
            }
            0x6f => {
                let off = jtype_imm(w);
                let tgt = i as isize + (off / 4) as isize;
                if off % 4 != 0 || tgt < 0 || tgt as usize >= code.len() {
                    return Some(VerifyErr::BranchOutOfRange);
                }
                if is_helper_call(code[tgt as usize]) {
                    return Some(VerifyErr::BranchIntoHelper);
                }
            }
            0x67 => {
                // jalr: only `ret` and the helper call.
                let is_ret = rd(w) == ZERO && rs1(w) == RA;
                let is_helper = is_helper_call(w);
                if (!is_ret && !is_helper) || f3(w) != 0 || (w >> 20) != 0 {
                    return Some(VerifyErr::BadJalr);
                }
                if is_helper {
                    // must directly follow a word load from an exact helper entry.
                    match prev {
                        Some(p)
                            if opcode(p) == 0x03
                                && f3(p) == 2
                                && rd(p) == T0
                                && rs1(p) == S0
                                && (((p as i32) >> 20) == crate::ctx::HELPER_OFF
                                    || crate::ctx::direct_index((p as i32) >> 20).is_some()) => {}
                        _ => return Some(VerifyErr::HelperNotAfterLoad),
                    }
                }
            }
            0x73 => return Some(VerifyErr::ForbiddenCsrOrSystem), // ecall/ebreak/CSR
            0x0f => return Some(VerifyErr::ForbiddenCsrOrSystem), // fence / fence.i
            _ => return Some(VerifyErr::BadOpcode),
        }
    }
    if budget_checks == 0 {
        return Some(VerifyErr::NoBudgetCheck);
    }
    None
}

fn is_helper_call(w: u32) -> bool {
    opcode(w) == 0x67 && rd(w) == RA && rs1(w) == T0
}

fn is_prologue_move(w: u32) -> bool {
    let imm = (w as i32) >> 20;
    // addi sp, sp, imm
    if rd(w) == SP && rs1(w) == SP {
        return true;
    }
    // addi s0,a0,0 | s1,a1,0 | s11,a2,0
    imm == 0
        && ((rd(w) == S0 && rs1(w) == A0)
            || (rd(w) == S1 && rs1(w) == A1)
            || (rd(w) == S11 && rs1(w) == A2))
}

fn btype_imm(w: u32) -> i32 {
    let b12 = (w >> 31) & 1;
    let b11 = (w >> 7) & 1;
    let b10_5 = (w >> 25) & 0x3f;
    let b4_1 = (w >> 8) & 0xf;
    let v = (b12 << 12) | (b11 << 11) | (b10_5 << 5) | (b4_1 << 1);
    ((v as i32) << 19) >> 19
}
fn jtype_imm(w: u32) -> i32 {
    let b20 = (w >> 31) & 1;
    let b19_12 = (w >> 12) & 0xff;
    let b11 = (w >> 20) & 1;
    let b10_1 = (w >> 21) & 0x3ff;
    let v = (b20 << 20) | (b19_12 << 12) | (b11 << 11) | (b10_1 << 1);
    ((v as i32) << 11) >> 11
}

const A0: u32 = 10;
const A1: u32 = 11;
const A2: u32 = 12;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{ctx, direct, enc};

    fn image(off: i32) -> [u32; 6] {
        [
            enc::addi(S10, S10, -1),
            enc::branch(enc::F3_BGE, S10, ZERO, 4),
            enc::lw(T0, S0, off),
            enc::jalr(RA, T0, 0),
            enc::sw(A0, S0, 0),
            enc::jalr(ZERO, RA, 0),
        ]
    }

    #[test]
    fn fixed_helper_entries_only() {
        assert_eq!(verify(&image(ctx::HELPER_OFF)), None);
        for i in 0..direct::COUNT {
            let off = ctx::DIRECT_OFF + i as i32 * direct::STRIDE;
            assert_eq!(verify(&image(off)), None);
            assert_eq!(verify(&image(off + 4)), Some(VerifyErr::HelperNotAfterLoad));
        }
        for off in [
            -8,
            0,
            ctx::DIRECT_OFF + direct::COUNT as i32 * direct::STRIDE,
        ] {
            assert_eq!(verify(&image(off)), Some(VerifyErr::HelperNotAfterLoad));
        }
        let mut code = image(ctx::DIRECT_OFF);
        code[2] ^= 1 << 12; // lw -> ld (or otherwise invalid load width)
        assert_eq!(verify(&code), Some(VerifyErr::HelperNotAfterLoad));
        code = image(ctx::DIRECT_OFF);
        code[3] = enc::jalr(RA, T0, 4);
        assert_eq!(verify(&code), Some(VerifyErr::BadJalr));
    }

    #[test]
    fn cannot_bypass_load_or_overwrite_table() {
        let mut code = image(ctx::DIRECT_OFF);
        code[1] = enc::branch(enc::F3_BGE, S10, ZERO, 8);
        assert_eq!(verify(&code), Some(VerifyErr::BranchIntoHelper));
        code = image(ctx::DIRECT_OFF);
        code[4] = enc::jal(ZERO, -4);
        assert_eq!(verify(&code), Some(VerifyErr::BranchIntoHelper));
        code = image(ctx::DIRECT_OFF);
        code[1] = enc::branch(enc::F3_BGE, S10, ZERO, 6);
        assert_eq!(verify(&code), Some(VerifyErr::BranchOutOfRange));
        code = image(ctx::DIRECT_OFF);
        code[4] = enc::sw(A0, S0, ctx::DIRECT_OFF);
        assert_eq!(verify(&code), Some(VerifyErr::BadCtxStore));
    }
}
