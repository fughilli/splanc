//! A minimal RV32IM emulator with a helper-call trap, for host differential
//! tests (no hardware). It executes exactly the instructions the lowering emits
//! and dispatches the one allowed indirect call (`jalr ra, 0(t0)` after
//! `lw t0, 0(s0)`) to the Rust helper, so the emulated image and the device run
//! identical code. Memory is keyed on the base register (s0/s1/s11/sp), matching
//! the sandbox the verifier enforces — an out-of-grammar access panics.

use crate::ctx::NativeCtx;
use crate::reg::*;
use crate::WIN_OFF;

/// Execute the function starting at word `start` until it returns (`ret`).
/// The `s1`-based frame (locals[128] + deep stack + window) and the `s11`-based
/// state array are read through `ctx.locals` / `ctx.state` — the same memory the
/// helper sees — so there is a single owner.
///
/// # Safety
/// `ctx.locals` must point at a [`crate::FRAME_WORDS`]-word frame and `ctx.state`
/// at a `fx_vm::MAX_STATE`-word state array; `ctx.helper` must be
/// `aot_win_helper`.
pub unsafe fn exec(code: &[u32], start: usize, ctx: &mut NativeCtx) {
    let frame: &mut [i32] = core::slice::from_raw_parts_mut(ctx.locals as *mut i32, crate::FRAME_WORDS);
    let state: &mut [i32] =
        core::slice::from_raw_parts_mut(ctx.state as *mut i32, ledmapper_fx_vm::MAX_STATE);
    let mut x = [0i32; 32];
    let mut save = [0i32; 32];
    let mut pc = start;
    let mut steps = 0u64;
    let out_off = core::mem::offset_of!(NativeCtx, out);
    let rk_off = core::mem::offset_of!(NativeCtx, ret_kind);
    let rf_off = core::mem::offset_of!(NativeCtx, ret_frac);
    loop {
        steps += 1;
        assert!(steps < 50_000_000, "emu: runaway");
        let w = code[pc];
        pc += 1;
        let op = w & 0x7f;
        let rd = ((w >> 7) & 0x1f) as usize;
        let f3 = (w >> 12) & 0x7;
        let rs1 = ((w >> 15) & 0x1f) as usize;
        let rs2 = ((w >> 20) & 0x1f) as usize;
        let f7 = w >> 25;
        let set = |x: &mut [i32; 32], r: usize, v: i32| {
            if r != 0 {
                x[r] = v;
            }
        };
        match op {
            0x37 => set(&mut x, rd, (w & 0xffff_f000) as i32), // lui
            0x13 => {
                let a = x[rs1];
                let shamt = (w >> 20) & 0x1f;
                let v = match f3 {
                    0x0 => a.wrapping_add((w as i32) >> 20), // addi
                    0x1 => ((a as u32) << shamt) as i32,
                    0x5 => {
                        if (f7 & 0x20) != 0 {
                            a >> shamt
                        } else {
                            ((a as u32) >> shamt) as i32
                        }
                    }
                    _ => panic!("emu: I-ALU f3={f3}"),
                };
                set(&mut x, rd, v);
            }
            0x33 => {
                let (a, b) = (x[rs1], x[rs2]);
                let v = match (f7, f3) {
                    (0x00, 0x0) => a.wrapping_add(b),
                    (0x20, 0x0) => a.wrapping_sub(b),
                    (0x01, 0x0) => a.wrapping_mul(b),
                    (0x01, 0x1) => ((a as i64 * b as i64) >> 32) as i32, // mulh
                    (0x01, 0x4) => {
                        if b == 0 {
                            -1
                        } else {
                            a.wrapping_div(b)
                        }
                    }
                    (0x01, 0x6) => {
                        if b == 0 {
                            a
                        } else {
                            a.wrapping_rem(b)
                        }
                    }
                    (0x00, 0x6) => a | b,
                    (0x00, 0x7) => a & b,
                    (0x00, 0x4) => a ^ b,
                    _ => panic!("emu: R f7={f7:#x} f3={f3}"),
                };
                set(&mut x, rd, v);
            }
            0x03 => {
                // lw
                assert_eq!(f3, 0x2, "emu: only lw");
                let off = (w as i32) >> 20;
                let v = load(rs1 as u32, off, frame, state, &save, ctx);
                set(&mut x, rd, v);
            }
            0x23 => {
                // sw
                let imm = (((w >> 25) & 0x7f) << 5) | ((w >> 7) & 0x1f);
                let off = ((imm as i32) << 20) >> 20;
                store(rs1 as u32, off, x[rs2], frame, state, &mut save, ctx, out_off, rk_off, rf_off);
            }
            0x63 => {
                let off = btype_imm(w);
                let take = match f3 {
                    0x0 => x[rs1] == x[rs2],
                    0x1 => x[rs1] != x[rs2],
                    0x4 => x[rs1] < x[rs2],
                    0x5 => x[rs1] >= x[rs2],
                    _ => panic!("emu: branch f3={f3}"),
                };
                if take {
                    pc = (pc as isize - 1 + (off / 4) as isize) as usize;
                }
            }
            0x6f => {
                // jal
                let off = jtype_imm(w);
                set(&mut x, rd, (pc as i32) * 4); // link (unused)
                pc = (pc as isize - 1 + (off / 4) as isize) as usize;
            }
            0x67 => {
                // jalr: ret or helper
                if rd == 0 && rs1 == RA as usize {
                    return; // ret
                }
                assert_eq!(rs1, T0 as usize, "emu: unexpected jalr");
                // helper call: aot_win_helper(ctx, &frame[WIN_OFF], a2, a3)
                let win = frame.as_mut_ptr().add(WIN_OFF);
                (ctx.helper)(ctx as *mut NativeCtx, win, x[A2 as usize] as u32, x[A3 as usize] as u32);
            }
            _ => panic!("emu: opcode {op:#x}"),
        }
    }
}

#[allow(clippy::too_many_arguments)]
unsafe fn store(
    base: u32,
    off: i32,
    v: i32,
    frame: &mut [i32],
    state: &mut [i32],
    save: &mut [i32; 32],
    _ctx: *mut NativeCtx,
    out_off: usize,
    rk_off: usize,
    rf_off: usize,
) {
    let w = (off / 4) as usize;
    match base {
        x if x == S1 => frame[w] = v,
        x if x == S11 => state[w] = v,
        x if x == SP => save[w & 31] = v,
        x if x == S0 => {
            let o = off as usize;
            let ctx = &mut *_ctx;
            if (out_off..out_off + 12).contains(&o) {
                ctx.out[(o - out_off) / 4] = v;
            } else if o == rk_off {
                ctx.ret_kind = v as u32;
            } else if o == rf_off {
                ctx.ret_frac = v as u32;
            } else {
                panic!("emu: bad s0 store off={o}");
            }
        }
        _ => panic!("emu: bad store base {base}"),
    }
}

unsafe fn load(base: u32, off: i32, frame: &[i32], state: &[i32], save: &[i32; 32], _ctx: *mut NativeCtx) -> i32 {
    let w = (off / 4) as usize;
    match base {
        x if x == S1 => frame[w],
        x if x == S11 => state[w],
        x if x == SP => save[w & 31],
        x if x == S0 => 0, // helper sentinel (offset 0); value unused by the emu
        _ => panic!("emu: bad load base {base}"),
    }
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

const A2: u32 = 12;
const A3: u32 = 13;
