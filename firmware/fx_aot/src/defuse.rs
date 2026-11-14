//! Expand the VM's fused superinstructions (#350: `BinTop`, `BinPair`,
//! `PushConsts`, `LoadCtxLanes`, `MulAdd`) and the per-LED memo brackets
//! (#328: `LoadLedCache`/`StoreLedCache`) back into the base opcodes the
//! lowerer already handles, before lowering.
//!
//! Every fusion is *exact* by construction in `fx_vm` (the optimizer only emits
//! them for the same pushes / IEEE ops), so the expansion is too:
//!
//! | fused | expansion |
//! |---|---|
//! | `BinTop m,i` | `push src(i) ; OP` |
//! | `BinPair m,a,b` | `push srcA(a) ; push srcB(b) ; OP` |
//! | `PushConsts n,i..` | `PushConst i_0 .. PushConst i_{n-1}` |
//! | `LoadCtxLanes id,s,k,m` | `LoadCtx id ; Swizzle s->m [k..k+m)` |
//! | `MulAdd n` | `Mul n ; Add n` |
//! | `LoadLedCache` / `StoreLedCache` | `Pop 0` (native code binds no memo cache, which the VM defines as a no-op) |
//!
//! The memo cache only skips recomputation of a value that is bit-identical to
//! the computed one, so running without it changes speed, never output.
//!
//! Branch offsets are re-targeted to the expanded layout. The VM's instruction
//! budget counts a fused op once, so the expansion carries a per-op *weight*
//! (1 for the first op of an expansion, 0 for the rest) that the lowerer's
//! per-block budget decrement sums: budget exhaustion stays where the VM has it.
//!
//! The generic window helper reads operand bytes through `NativeCtx::code`, so
//! the runtime must hand it the *expanded* bytes ([`crate::Image::op_code`]).

use alloc::collections::BTreeMap;
use alloc::vec::Vec;

use ledmapper_fx_jit::op_len;
use ledmapper_fx_vm::Op;

/// The expanded program.
pub(crate) struct Defused {
    /// Base-opcode bytes (what lowering and the generic helper read).
    pub code: Vec<u8>,
    /// Budget weight of the op starting at each byte offset of `code`.
    pub weight: BTreeMap<usize, i32>,
    /// Original op offset -> expanded op offset.
    pub map: BTreeMap<usize, usize>,
}

fn rd16(code: &[u8], o: usize) -> Option<u16> {
    Some(u16::from_le_bytes([*code.get(o)?, *code.get(o + 1)?]))
}

/// Push of a `BinTop`/`BinPair` operand source (0 const, 1 local, 2 state,
/// 3 uniform). Slot-indexed sources only encode a u8 slot: a wider index bails.
fn push_src(out: &mut Vec<u8>, src: u8, i: u16) -> Option<()> {
    match src & 3 {
        0 => {
            out.push(Op::PushConst as u8);
            out.extend_from_slice(&i.to_le_bytes());
        }
        s => {
            let slot = u8::try_from(i).ok()?;
            let op = match s {
                1 => Op::LoadLocal,
                2 => Op::LoadState,
                _ => Op::LoadUniform,
            };
            out.extend_from_slice(&[op as u8, slot, 1]);
        }
    }
    Some(())
}

/// The scalar arithmetic op a `BinTop`/`BinPair` mode byte names.
fn push_arith(out: &mut Vec<u8>, mode: u8) {
    if mode & 0x40 != 0 {
        out.push(match mode & 3 {
            0 => Op::AddI,
            1 => Op::SubI,
            2 => Op::MulI,
            _ => Op::MulFix,
        } as u8);
    } else {
        let op = match mode & 3 {
            0 => Op::Add,
            1 => Op::Sub,
            2 => Op::Mul,
            _ => Op::Div,
        };
        out.extend_from_slice(&[op as u8, 1]);
    }
}

/// Branch offset field position (relative to the op start) and the op length
/// the VM measures it from, for the relative branches the lowerer follows.
fn branch_field(op: Op) -> Option<usize> {
    match op {
        Op::BrFalse | Op::Jmp => Some(1),
        Op::BrCmpI => Some(2),
        _ => None,
    }
}

/// Expand `code`. `None` if the program can't be expressed in base ops (a
/// fused slot index > 255, an out-of-range re-targeted branch, or a malformed
/// stream) — the effect then stays on the VM.
pub(crate) fn defuse(code: &[u8]) -> Option<Defused> {
    let mut out: Vec<u8> = Vec::with_capacity(code.len() + code.len() / 2);
    let mut weight = BTreeMap::new();
    let mut map = BTreeMap::new();
    // (expanded op offset, expanded len, original target)
    let mut fix: Vec<(usize, usize, usize, usize)> = Vec::new();
    let mut pc = 0usize;
    while pc < code.len() {
        let op = Op::from_u8(code[pc])?;
        let len = op_len(code, pc)?;
        if pc + len > code.len() {
            return None;
        }
        let at = out.len();
        map.insert(pc, at);
        let b = |k: usize| code[pc + 1 + k];
        // Record each emitted op's weight (first of an expansion = 1).
        let mut starts: Vec<usize> = Vec::new();
        let mut mark = |out: &Vec<u8>| starts.push(out.len());
        match op {
            Op::BinTop => {
                let (mode, i) = (b(0), rd16(code, pc + 2)?);
                mark(&out);
                push_src(&mut out, mode >> 2, i)?;
                mark(&out);
                push_arith(&mut out, mode);
            }
            Op::BinPair => {
                let mode = b(0);
                let (ia, ib) = (rd16(code, pc + 2)?, rd16(code, pc + 4)?);
                mark(&out);
                push_src(&mut out, mode >> 2, ia)?;
                mark(&out);
                push_src(&mut out, mode >> 4, ib)?;
                mark(&out);
                push_arith(&mut out, mode);
            }
            Op::PushConsts => {
                for j in 0..b(0) as usize {
                    mark(&out);
                    out.push(Op::PushConst as u8);
                    out.extend_from_slice(&rd16(code, pc + 2 + 2 * j)?.to_le_bytes());
                }
                if b(0) == 0 {
                    mark(&out);
                    out.extend_from_slice(&[Op::Pop as u8, 0]);
                }
            }
            Op::LoadCtxLanes => {
                let (id, src, k, m) = (b(0), b(1), b(2), b(3));
                if m > 4 {
                    return None;
                }
                mark(&out);
                out.extend_from_slice(&[Op::LoadCtx as u8, id]);
                mark(&out);
                out.extend_from_slice(&[Op::Swizzle as u8, src, m]);
                for j in 0..m {
                    out.push(k.checked_add(j)?);
                }
            }
            Op::MulAdd => {
                mark(&out);
                out.extend_from_slice(&[Op::Mul as u8, b(0)]);
                mark(&out);
                out.extend_from_slice(&[Op::Add as u8, b(0)]);
            }
            Op::LoadLedCache | Op::StoreLedCache => {
                mark(&out);
                out.extend_from_slice(&[Op::Pop as u8, 0]);
            }
            _ => {
                mark(&out);
                out.extend_from_slice(&code[pc..pc + len]);
                if let Some(f) = branch_field(op) {
                    let rel = i16::from_le_bytes([code[pc + f], code[pc + f + 1]]) as isize;
                    let t = pc as isize + (f + 2) as isize + rel;
                    if t < 0 {
                        return None;
                    }
                    fix.push((at, f, f + 2, t as usize));
                }
            }
        }
        for (k, &s) in starts.iter().enumerate() {
            weight.insert(s, if k == 0 { 1 } else { 0 });
        }
        pc += len;
    }
    map.insert(code.len(), out.len());
    for (at, f, end, t) in fix {
        let nt = *map.get(&t)? as isize;
        let rel = nt - (at + end) as isize;
        let rel = i16::try_from(rel).ok()?;
        out[at + f..at + f + 2].copy_from_slice(&rel.to_le_bytes());
    }
    Some(Defused {
        code: out,
        weight,
        map,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_without_fused_ops() {
        // PushConst 0 ; Jmp +0 ; Ret 1
        let code = [
            Op::PushConst as u8,
            0,
            0,
            Op::Jmp as u8,
            0,
            0,
            Op::Ret as u8,
            1,
        ];
        let d = defuse(&code).unwrap();
        assert_eq!(d.code, code);
        assert!(d.weight.values().all(|&w| w == 1));
    }

    #[test]
    fn branches_retarget_over_expansions() {
        // 0: Jmp -> 7 ; 3: PushConsts 1 [0] ; 7: Ret 1
        let code = [
            Op::Jmp as u8,
            4,
            0,
            Op::PushConsts as u8,
            1,
            0,
            0,
            Op::Ret as u8,
            1,
        ];
        let d = defuse(&code).unwrap();
        // PushConsts(4 bytes) -> PushConst(3 bytes): target moves 7 -> 6.
        assert_eq!(d.map[&7], 6);
        assert_eq!(i16::from_le_bytes([d.code[1], d.code[2]]), 3);
    }

    #[test]
    fn fused_weights_sum_to_one() {
        // BinPair add const0 + const1 ; Ret 1
        let code = [Op::BinPair as u8, 0, 0, 0, 1, 0, Op::Ret as u8, 1];
        let d = defuse(&code).unwrap();
        let w: i32 = d
            .weight
            .iter()
            .filter(|(&k, _)| k < d.map[&6])
            .map(|(_, &w)| w)
            .sum();
        assert_eq!(w, 1);
    }
}
