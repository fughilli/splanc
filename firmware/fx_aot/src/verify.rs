//! Independent re-check of an emitted instruction stream against the sandbox
//! grammar (docs/design/fx-native-aot.md, "Verifier rules"). The verifier
//! decides from the words, the declared entry offsets and [`VerifyLimits`]
//! alone. It never infers a region size from the image.
//!
//! An image is a sequence of *fixed sequences* (copied byte for byte from
//! [`prologue_words`], [`epilogue_words`] and [`exit_stub_words`]) and *body*
//! words. Summary of the rules (each is enforced below, numbered as in the doc):
//!
//! - **R1 entries.** Each declared entry holds an exact prologue and is word 0
//!   or follows an unconditional transfer (`ret` / `jal x0`). A prologue is
//!   accepted only at a declared entry. The last word is unconditional, so no
//!   path falls off the image.
//! - **R2 reserved registers.** In the body, `rd` must be `x0`, `t0..t6`,
//!   `a0..a7` or `s2..s9`. `ra`, `sp`, `gp`, `tp`, `s0`, `s1`, `s10` and `s11`
//!   are written only by the fixed sequences, with two exceptions: the helper
//!   call `jalr ra, 0(t0)` writes `ra`, and the canonical budget decrement writes
//!   `s10`. No body word reads from or writes to `sp` memory.
//! - **R3 return.** `jalr x0, 0(ra)` (`ret`) appears only as the last word of
//!   an exact epilogue. The epilogue reloads `ra` and `s0..s11` from the
//!   prologue's save slots. Those slots are `sp`-relative, the body can't
//!   address `sp`, and `sp` is never written outside the fixed sequences. So
//!   `ret` always returns to the caller's `ra` with its callee-saved registers
//!   restored.
//! - **R4 memory.** Only `lw`/`sw`, word-aligned, with a base of `s1` (offset in
//!   `[0, frame_bytes)`), `s11` (`[0, state_bytes)`) or `s0`. Stores through
//!   `s0` hit only the `NativeCtx` output words (0..=16). Loads through `s0`
//!   only put an exact helper-table entry in `t0`.
//! - **R5 helper calls.** The only other `jalr` is `jalr ra, 0(t0)`. It must
//!   directly follow `lw t0, E(s0)` for an exact, aligned entry `E`. If the
//!   callee takes pointers, those arguments must be set by fixed instructions
//!   right before the call: the generic helper gets `a0 = s0` and
//!   `a1 = s1 + WIN`, and the colour helpers get `a3 = s1 + WIN`. No control
//!   transfer may land between the pinning instructions and the call.
//! - **R6 control flow.** `jal` must have `rd = x0`. Every branch and `jal`
//!   target must be word-aligned and inside the image. A target may not fall
//!   inside a prologue, past the first word of an epilogue, or inside a
//!   protected helper-call window.
//! - **R7 budget.** Any branch or `jal` whose target is at or before its own pc
//!   must land on a canonical budget check:
//!   `addi s10,s10,-n (1<=n<=2048); bge s10,x0,+8; jal x0,STUB`.
//!   `STUB` is an exact exit stub (out=0, ret_kind=RET_RET) followed directly
//!   by an exact epilogue. Every other control transfer moves forward, and
//!   helpers return to pc+4. Each pass through a cycle therefore decrements
//!   `s10` at least once, and once `s10 < 0` the next back edge leaves through
//!   the straight-line stub and `ret`.
//! - **R8 nothing else.** No `auipc`, no `ecall`/`ebreak`/CSR, no
//!   `fence`/`fence.i`, no other opcode, and no reserved funct3/funct7
//!   encodings.
//!
//! The verifier runs on the device after lowering (and, for signed prebuilt
//! images, after the signature check) and on the host in tests.

use crate::reg::*;
use crate::{enc, WIN_OFF, WIN_WORDS};

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum VerifyErr {
    /// An opcode, funct3 or funct7 outside the allowed subset.
    BadOpcode,
    /// A load/store whose base isn't s0/s1/s11, or a non-word access.
    BadMemBase,
    /// A load/store offset outside its region (or misaligned).
    MemOutOfBounds,
    /// A `jalr` that is neither the helper call nor the epilogue's `ret`.
    BadJalr,
    /// A helper call not directly after an exact helper-table load.
    HelperNotAfterLoad,
    /// A pointer argument of a helper call is not pinned to its fixed value.
    BadHelperArgs,
    ForbiddenCsrOrSystem,
    /// A body instruction writes ra/sp/gp/tp/s0/s1/s10/s11.
    WriteReservedReg,
    /// A write to s10 that isn't the canonical budget-check sequence.
    BadBudgetCheck,
    /// A backward branch/jump whose target isn't a budget check.
    UnbudgetedBackEdge,
    BranchOutOfRange,
    /// A branch/jump into a helper-call window (load/args/call).
    BranchIntoHelper,
    /// A branch/jump into a prologue or the middle of an epilogue.
    BranchIntoFixedSeq,
    /// A store through s0 outside the NativeCtx output words.
    BadCtxStore,
    /// An entry offset without an exact prologue, or reachable by fallthrough.
    BadEntry,
    /// Control can run past the last word.
    FallsOffEnd,
    /// The limits themselves are unusable (negative budget, frame too small).
    BadLimits,
}

/// Region sizes and budget the caller guarantees for every invocation. They
/// come from the lowerer/arena that allocates the buffers, never from the image.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VerifyLimits {
    /// Bytes at the frame pointer (`a1` on entry, `s1` in the body).
    pub frame_bytes: u32,
    /// Bytes at the state pointer (`a2` on entry, `s11` in the body).
    pub state_bytes: u32,
    /// The instruction budget the prologue must load into `s10`.
    pub budget: i32,
}

impl VerifyLimits {
    /// The buffers the in-tree callers allocate: a `FRAME_WORDS` frame, an
    /// `fx_vm::MAX_STATE` state array and the VM's default budget.
    pub const DEFAULT: VerifyLimits = VerifyLimits {
        frame_bytes: (crate::FRAME_WORDS * 4) as u32,
        state_bytes: (ledmapper_fx_vm::MAX_STATE * 4) as u32,
        budget: crate::DEFAULT_BUDGET,
    };
}

impl Default for VerifyLimits {
    fn default() -> Self {
        Self::DEFAULT
    }
}

// --- The fixed sequences (shared with the lowerer so they cannot drift) -----

/// Registers saved by the prologue, in save-slot order (slot k at `k*4(sp)`).
pub(crate) const SAVED: [u32; 13] = [RA, S0, S1, 18, 19, 20, 21, 22, 23, 24, 25, S10, S11];
/// Bytes the prologue reserves on the stack (16-byte aligned).
pub(crate) const SAVE_BYTES: i32 = 64;
pub(crate) const PROLOGUE_LEN: usize = 1 + SAVED.len() + 3 + 2;
pub(crate) const EPILOGUE_LEN: usize = SAVED.len() + 2;
pub(crate) const EXIT_STUB_LEN: usize = 6;

/// `lui rd,hi; addi rd,rd,lo` (always two words, so the shape is fixed).
pub(crate) fn li_words(rd: u32, val: i32) -> [u32; 2] {
    let lo = (val << 20) >> 20;
    let hi = (val.wrapping_sub(lo) >> 12) & 0xf_ffff;
    [enc::lui(rd, hi as u32), enc::addi(rd, rd, lo)]
}

/// The exact prologue: reserve the save area, save ra and s0..s11, take the
/// trusted ctx/frame/state pointers from a0/a1/a2, load the budget into s10.
pub(crate) fn prologue_words(budget: i32) -> [u32; PROLOGUE_LEN] {
    let mut w = [0u32; PROLOGUE_LEN];
    w[0] = enc::addi(SP, SP, -SAVE_BYTES);
    for (k, &r) in SAVED.iter().enumerate() {
        w[1 + k] = enc::sw(r, SP, (k * 4) as i32);
    }
    let m = 1 + SAVED.len();
    w[m] = enc::addi(S0, A0, 0);
    w[m + 1] = enc::addi(S1, A1, 0);
    w[m + 2] = enc::addi(S11, A2, 0);
    let li = li_words(S10, budget);
    w[m + 3] = li[0];
    w[m + 4] = li[1];
    w
}

/// The exact epilogue: restore every saved register, release the save area,
/// return. Its last word is the only `ret` an image may contain.
pub(crate) fn epilogue_words() -> [u32; EPILOGUE_LEN] {
    let mut w = [0u32; EPILOGUE_LEN];
    for (k, &r) in SAVED.iter().enumerate() {
        w[k] = enc::lw(r, SP, (k * 4) as i32);
    }
    w[SAVED.len()] = enc::addi(SP, SP, SAVE_BYTES);
    w[SAVED.len() + 1] = RET;
    w
}

/// Budget-exhausted exit: out = [0,0,0], ret_kind = RET_RET, then (in the
/// image) the epilogue immediately follows.
pub(crate) fn exit_stub_words() -> [u32; EXIT_STUB_LEN] {
    let li = li_words(T0, crate::ctx::RET_RET as i32);
    [
        enc::sw(ZERO, S0, crate::ctx::OUT_OFF),
        enc::sw(ZERO, S0, crate::ctx::OUT_OFF + 4),
        enc::sw(ZERO, S0, crate::ctx::OUT_OFF + 8),
        li[0],
        li[1],
        enc::sw(T0, S0, crate::ctx::RET_KIND_OFF),
    ]
}

/// First two words of the canonical budget check (the third is `jal x0, STUB`).
pub(crate) fn budget_check_head(n: i32) -> [u32; 2] {
    [
        enc::addi(S10, S10, -n),
        enc::branch(enc::F3_BGE, S10, ZERO, 8),
    ]
}
/// Largest per-check decrement (the `addi` immediate is -2048..=-1).
pub(crate) const MAX_BUDGET_STEP: i32 = 2048;

const RET: u32 = 0x0000_8067; // jalr x0, 0(ra)
const WIN_BYTE: i32 = (WIN_OFF * 4) as i32;

// --- Field decoding -----------------------------------------------------------

fn rd(w: u32) -> u32 {
    (w >> 7) & 0x1f
}
fn rs1(w: u32) -> u32 {
    (w >> 15) & 0x1f
}
fn f3(w: u32) -> u32 {
    (w >> 12) & 0x7
}
fn f7(w: u32) -> u32 {
    w >> 25
}
fn opcode(w: u32) -> u32 {
    w & 0x7f
}
fn i_imm(w: u32) -> i32 {
    (w as i32) >> 20
}
fn s_imm(w: u32) -> i32 {
    let imm = ((w >> 25) << 5) | ((w >> 7) & 31);
    ((imm as i32) << 20) >> 20
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

/// Registers a body instruction may write: x0, t0..t6, a0..a7, s2..s9.
fn body_writable(r: u32) -> bool {
    matches!(r, 0 | 5..=7 | 10..=17 | 18..=25 | 28..=31)
}

fn is_helper_call(w: u32) -> bool {
    opcode(w) == 0x67 && rd(w) == RA && rs1(w) == T0
}
fn is_jal_x0(w: u32) -> bool {
    opcode(w) == 0x6f && rd(w) == ZERO
}
/// Control never falls through this word.
fn is_unconditional(w: u32) -> bool {
    w == RET || is_jal_x0(w)
}

fn seq_at(code: &[u32], i: usize, seq: &[u32]) -> bool {
    code.get(i..i + seq.len()) == Some(seq)
}

/// Helper-table entry index loaded by `lw t0, off(s0)`: `None` for the generic
/// helper, `Some(i)` for direct entry `i`. `Err` if `w` is not such a load.
fn table_load(w: u32) -> Result<Option<usize>, ()> {
    if opcode(w) != 0x03 || f3(w) != 2 || rd(w) != T0 || rs1(w) != S0 {
        return Err(());
    }
    let off = i_imm(w);
    if off == crate::ctx::HELPER_OFF {
        return Ok(None);
    }
    crate::ctx::direct_index(off).map(Some).ok_or(())
}

struct V<'a> {
    code: &'a [u32],
    entries: &'a [usize],
    lim: &'a VerifyLimits,
    epi: [u32; EPILOGUE_LEN],
    stub: [u32; EXIT_STUB_LEN],
}

impl V<'_> {
    fn epilogue_at(&self, i: usize) -> bool {
        seq_at(self.code, i, &self.epi)
    }
    /// An exit stub immediately followed by an epilogue.
    fn exit_at(&self, i: usize) -> bool {
        seq_at(self.code, i, &self.stub) && self.epilogue_at(i + EXIT_STUB_LEN)
    }
    fn in_prologue(&self, t: usize) -> bool {
        self.entries.iter().any(|&e| t >= e && t < e + PROLOGUE_LEN)
    }
    /// `t` is inside an epilogue but not its first word. (The epilogue's words
    /// are pairwise distinct, so two matches can't overlap.)
    fn in_epilogue_tail(&self, t: usize) -> bool {
        (t.saturating_sub(EPILOGUE_LEN - 1)..t).any(|s| self.epilogue_at(s))
    }
    /// `t` is inside the protected window of some helper call: from the first
    /// word after its last pinned argument up to and including the `jalr`
    /// (the `jalr` alone for scalar-only helpers: landing on their table load
    /// still performs the load).
    fn in_helper_window(&self, t: usize) -> bool {
        let end = (t + GENERIC_PIN_LEN).min(self.code.len() - 1);
        (t..=end).any(|c| {
            if !is_helper_call(self.code[c]) {
                return false;
            }
            // Generic: a1 pin .. call. Colour: table load .. call (a3 pinned
            // before it). Scalar or unknown: the call itself.
            let protect = match c.checked_sub(1).map(|p| table_load(self.code[p])) {
                Some(Ok(None)) => GENERIC_PIN_LEN - 1,
                Some(Ok(Some(id))) if crate::direct::takes_blue_ptr(id) => 1,
                _ => 0,
            };
            t + protect >= c
        })
    }
    /// The canonical `addi s10,s10,-n; bge s10,x0,+8; jal x0,EXIT` at `t`.
    fn budget_check_at(&self, t: usize) -> bool {
        let c = self.code;
        let Some(&w) = c.get(t) else { return false };
        if opcode(w) != 0x13 || f3(w) != 0 || rd(w) != S10 || rs1(w) != S10 {
            return false;
        }
        let n = -i_imm(w);
        if !(1..=MAX_BUDGET_STEP).contains(&n) || c.get(t + 1) != Some(&budget_check_head(n)[1]) {
            return false;
        }
        let Some(&j) = c.get(t + 2) else { return false };
        if !is_jal_x0(j) {
            return false;
        }
        let tgt = (t + 2) as isize + (jtype_imm(j) / 4) as isize;
        tgt > (t + 2) as isize && self.exit_at(tgt as usize)
    }

    /// Common checks for a branch/jump at `i` with byte offset `off`.
    fn target(&self, i: usize, off: i32) -> Result<(), VerifyErr> {
        let tgt = i as isize + (off / 4) as isize;
        if off % 4 != 0 || tgt < 0 || tgt as usize >= self.code.len() {
            return Err(VerifyErr::BranchOutOfRange);
        }
        let t = tgt as usize;
        if self.in_prologue(t) || self.in_epilogue_tail(t) {
            return Err(VerifyErr::BranchIntoFixedSeq);
        }
        if self.in_helper_window(t) {
            return Err(VerifyErr::BranchIntoHelper);
        }
        if t <= i && !self.budget_check_at(t) {
            return Err(VerifyErr::UnbudgetedBackEdge);
        }
        Ok(())
    }

    fn mem(&self, base: u32, off: i32, store: bool, w: u32) -> Result<(), VerifyErr> {
        let size = match base {
            S1 => self.lim.frame_bytes,
            S11 => self.lim.state_bytes,
            S0 => {
                if store {
                    return if matches!(off, 0 | 4 | 8 | 12 | 16) {
                        Ok(())
                    } else {
                        Err(VerifyErr::BadCtxStore)
                    };
                }
                // Loads via s0: only the helper-table pointer into t0.
                return table_load(w)
                    .map(|_| ())
                    .map_err(|_| VerifyErr::HelperNotAfterLoad);
            }
            _ => return Err(VerifyErr::BadMemBase),
        };
        if off < 0 || off % 4 != 0 || off as i64 + 4 > size as i64 {
            return Err(VerifyErr::MemOutOfBounds);
        }
        Ok(())
    }

    /// Pointer arguments of the call at `i` (the `jalr`) are pinned.
    fn helper_args(&self, i: usize, entry: Option<usize>) -> Result<(), VerifyErr> {
        let c = self.code;
        let win_ok = self.lim.frame_bytes as usize >= (WIN_OFF + WIN_WORDS) * 4;
        match entry {
            None => {
                // addi a0,s0,0; addi a1,s1,WIN; lui a2; addi a2,a2; lui a3; addi a3,a3; lw; jalr
                let s = i
                    .checked_sub(GENERIC_PIN_LEN)
                    .ok_or(VerifyErr::BadHelperArgs)?;
                let li = |w: u32, r: u32| opcode(w) == 0x37 && rd(w) == r;
                let ad =
                    |w: u32, r: u32| opcode(w) == 0x13 && f3(w) == 0 && rd(w) == r && rs1(w) == r;
                if !win_ok
                    || c[s] != enc::addi(A0, S0, 0)
                    || c[s + 1] != enc::addi(A1, S1, WIN_BYTE)
                    || !li(c[s + 2], A2)
                    || !ad(c[s + 3], A2)
                    || !li(c[s + 4], A3)
                    || !ad(c[s + 5], A3)
                {
                    return Err(VerifyErr::BadHelperArgs);
                }
            }
            Some(id) if crate::direct::takes_blue_ptr(id) => {
                if !win_ok || i < 2 || c[i - 2] != enc::addi(A3, S1, WIN_BYTE) {
                    return Err(VerifyErr::BadHelperArgs);
                }
            }
            Some(_) => {} // scalar-only helper
        }
        Ok(())
    }

    fn body(&self, i: usize) -> Result<(), VerifyErr> {
        let w = self.code[i];
        let wr = |r: u32| {
            if body_writable(r) {
                Ok(())
            } else {
                Err(VerifyErr::WriteReservedReg)
            }
        };
        match opcode(w) {
            0x37 => wr(rd(w)), // lui
            0x13 => {
                // OP-IMM; reject the reserved shift encodings.
                let sh_ok = match f3(w) {
                    1 => f7(w) == 0,
                    5 => f7(w) == 0 || f7(w) == 0x20,
                    _ => true,
                };
                if !sh_ok {
                    return Err(VerifyErr::BadOpcode);
                }
                if rd(w) == S10 {
                    return if self.budget_check_at(i) {
                        Ok(())
                    } else {
                        Err(VerifyErr::BadBudgetCheck)
                    };
                }
                wr(rd(w))
            }
            0x33 => {
                let ok = match f7(w) {
                    0x00 | 0x01 => true,            // base ALU / M extension
                    0x20 => matches!(f3(w), 0 | 5), // sub / sra
                    _ => false,
                };
                if !ok {
                    return Err(VerifyErr::BadOpcode);
                }
                wr(rd(w))
            }
            0x03 => {
                if f3(w) != 2 {
                    return Err(VerifyErr::BadMemBase);
                }
                wr(rd(w))?;
                self.mem(rs1(w), i_imm(w), false, w)
            }
            0x23 => {
                if f3(w) != 2 {
                    return Err(VerifyErr::BadMemBase);
                }
                self.mem(rs1(w), s_imm(w), true, w)
            }
            0x63 => {
                if matches!(f3(w), 2 | 3) {
                    return Err(VerifyErr::BadOpcode);
                }
                self.target(i, btype_imm(w))
            }
            0x6f => {
                if rd(w) != ZERO {
                    return Err(VerifyErr::WriteReservedReg);
                }
                self.target(i, jtype_imm(w))
            }
            0x67 => {
                if !is_helper_call(w) || f3(w) != 0 || i_imm(w) != 0 {
                    // includes `ret` outside an epilogue
                    return Err(VerifyErr::BadJalr);
                }
                let entry = match i.checked_sub(1).map(|p| table_load(self.code[p])) {
                    Some(Ok(e)) => e,
                    _ => return Err(VerifyErr::HelperNotAfterLoad),
                };
                self.helper_args(i, entry)
            }
            0x73 | 0x0f => Err(VerifyErr::ForbiddenCsrOrSystem),
            _ => Err(VerifyErr::BadOpcode), // incl. auipc (0x17)
        }
    }
}

/// Words from the generic helper's `addi a0,s0,0` to its `jalr` (exclusive).
const GENERIC_PIN_LEN: usize = 7;

/// Verify a lowered image (all functions concatenated) whose callable entry
/// points are `entries` (word offsets), run against buffers of `limits`.
/// `None` means it is safe to map R+X and call at any of `entries`. `Some(err)`
/// means keep the VM.
pub fn verify(code: &[u32], entries: &[usize], limits: &VerifyLimits) -> Option<VerifyErr> {
    verify_inner(code, entries, limits).err()
}

fn verify_inner(code: &[u32], entries: &[usize], lim: &VerifyLimits) -> Result<(), VerifyErr> {
    if lim.budget < 0 {
        return Err(VerifyErr::BadLimits);
    }
    if entries.is_empty() {
        return Err(VerifyErr::BadEntry);
    }
    let pro = prologue_words(lim.budget);
    let v = V {
        code,
        entries,
        lim,
        epi: epilogue_words(),
        stub: exit_stub_words(),
    };
    for &e in entries {
        if !seq_at(code, e, &pro) || (e > 0 && !is_unconditional(code[e - 1])) {
            return Err(VerifyErr::BadEntry);
        }
    }
    match code.last() {
        Some(&w) if is_unconditional(w) => {}
        _ => return Err(VerifyErr::FallsOffEnd),
    }
    let mut i = 0;
    while i < code.len() {
        if entries.contains(&i) {
            i += PROLOGUE_LEN; // matched exactly above
        } else if v.epilogue_at(i) {
            i += EPILOGUE_LEN;
        } else {
            v.body(i)?;
            i += 1;
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "verify_tests.rs"]
mod tests;
