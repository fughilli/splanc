//! The single generic opcode helper. Reproduces the `fx_vm` interpreter arm for
//! one opcode over a window of operand slots, reusing `fx_vm`'s own (now-public)
//! maths so the native result is bit-identical to the VM. The lowering spills
//! the live top `pop` slots into `win[0..pop]`, calls this, then reloads the
//! `push` result slots from `win[0..push]`.

use ledmapper_fx_vm as fxv;
use ledmapper_fx_vm::Op;

use crate::ctx::NativeCtx;

#[inline]
fn gf(w: &[i32], k: usize) -> f32 {
    f32::from_bits(w[k] as u32)
}
#[inline]
fn sf(w: &mut [i32], k: usize, v: f32) {
    w[k] = v.to_bits() as i32;
}

/// See [`crate::ctx::HelperFn`]. `op` is the opcode byte; `code_off` points at
/// its operand bytes within `ctx.code`.
///
/// # Safety
/// `ctx` and `win` are valid for the call; `win` has room for the op's pop/push.
#[no_mangle]
pub unsafe extern "C" fn aot_win_helper(ctx: *mut NativeCtx, win: *mut i32, op: u32, code_off: u32) {
    let c = &mut *ctx;
    let code = core::slice::from_raw_parts(c.code, c.code_len);
    // Operand bytes for this op (after the opcode byte).
    let o = code_off as usize;
    let b = |k: usize| *code.get(o + k).unwrap_or(&0);
    let Some(op) = Op::from_u8(op as u8) else { return };
    // The window is sized by the lowering for this op's pop/push.
    let w = core::slice::from_raw_parts_mut(win, crate::WIN_WORDS);
    match op {
        Op::Add | Op::Sub | Op::Mul | Op::Div => {
            let n = b(0) as usize;
            for i in 0..n {
                let a = gf(w, i);
                let bb = gf(w, n + i);
                let r = match op {
                    Op::Add => a + bb,
                    Op::Sub => a - bb,
                    Op::Mul => a * bb,
                    _ => {
                        if bb == 0.0 {
                            0.0
                        } else {
                            a / bb
                        }
                    }
                };
                sf(w, i, r);
            }
        }
        Op::Neg => {
            let n = b(0) as usize;
            for i in 0..n {
                sf(w, i, -gf(w, i));
            }
        }
        Op::Scale => {
            let n = b(0) as usize;
            let s = gf(w, n);
            for i in 0..n {
                sf(w, i, gf(w, i) * s);
            }
        }
        Op::UnMath => {
            let (f, n) = (b(0), b(1) as usize);
            for i in 0..n {
                sf(w, i, fxv::un_math(f, gf(w, i)));
            }
        }
        Op::BinMath => {
            let (f, n) = (b(0), b(1) as usize);
            for i in 0..n {
                sf(w, i, fxv::bin_math(f, gf(w, i), gf(w, n + i)));
            }
        }
        Op::Clamp => {
            let n = b(0) as usize;
            for i in 0..n {
                let (x, lo, hi) = (gf(w, i), gf(w, n + i), gf(w, 2 * n + i));
                sf(w, i, if x < lo { lo } else if x > hi { hi } else { x });
            }
        }
        Op::Mix => {
            let n = b(0) as usize;
            let t = gf(w, 2 * n);
            for i in 0..n {
                let (a, bb) = (gf(w, i), gf(w, n + i));
                sf(w, i, a + (bb - a) * t);
            }
        }
        Op::Smoothstep => {
            let n = b(0) as usize;
            for i in 0..n {
                let (e0, e1, x) = (gf(w, i), gf(w, n + i), gf(w, 2 * n + i));
                let t = fxv::clamp01(if e1 == e0 { 0.0 } else { (x - e0) / (e1 - e0) });
                sf(w, i, t * t * (3.0 - 2.0 * t));
            }
        }
        Op::Dot => {
            let n = b(0) as usize;
            let mut acc = 0.0;
            for i in 0..n {
                acc += gf(w, i) * gf(w, n + i);
            }
            sf(w, 0, acc);
        }
        Op::Cross => {
            let a = [gf(w, 0), gf(w, 1), gf(w, 2)];
            let bb = [gf(w, 3), gf(w, 4), gf(w, 5)];
            sf(w, 0, a[1] * bb[2] - a[2] * bb[1]);
            sf(w, 1, a[2] * bb[0] - a[0] * bb[2]);
            sf(w, 2, a[0] * bb[1] - a[1] * bb[0]);
        }
        Op::Length => {
            let n = b(0) as usize;
            let mut acc = 0.0;
            for i in 0..n {
                acc += gf(w, i) * gf(w, i);
            }
            sf(w, 0, fxv::sqrtf(acc));
        }
        Op::Distance => {
            let n = b(0) as usize;
            let mut acc = 0.0;
            for i in 0..n {
                let d = gf(w, i) - gf(w, n + i);
                acc += d * d;
            }
            sf(w, 0, fxv::sqrtf(acc));
        }
        Op::Normalize => {
            let n = b(0) as usize;
            let mut acc = 0.0;
            for i in 0..n {
                acc += gf(w, i) * gf(w, i);
            }
            let len = fxv::sqrtf(acc);
            if len > 1e-9 {
                for i in 0..n {
                    sf(w, i, gf(w, i) / len);
                }
            }
        }
        Op::Cmp => {
            let kind = b(0);
            let (a, bb) = (gf(w, 0), gf(w, 1));
            let r = match kind {
                0 => a < bb,
                1 => a <= bb,
                2 => a > bb,
                3 => a >= bb,
                4 => a == bb,
                _ => a != bb,
            };
            sf(w, 0, if r { 1.0 } else { 0.0 });
        }
        Op::Logic => {
            let kind = b(0);
            if kind == 2 {
                let a = gf(w, 0);
                sf(w, 0, if a != 0.0 { 0.0 } else { 1.0 });
            } else {
                let (a, bb) = (gf(w, 0), gf(w, 1));
                let r = if kind == 0 {
                    (a != 0.0) && (bb != 0.0)
                } else {
                    (a != 0.0) || (bb != 0.0)
                };
                sf(w, 0, if r { 1.0 } else { 0.0 });
            }
        }
        Op::Hash1 => sf(w, 0, fxv::hash1(gf(w, 0))),
        Op::Hash3 => {
            let r = fxv::hash3(gf(w, 0), gf(w, 1), gf(w, 2));
            sf(w, 0, r);
        }
        Op::Hsv2Rgb => {
            let (r, g, bl) = fxv::hsv2rgb(gf(w, 0), gf(w, 1), gf(w, 2));
            sf(w, 0, r);
            sf(w, 1, g);
            sf(w, 2, bl);
        }
        Op::Palette => {
            let (r, g, bl) = fxv::palette(b(0), gf(w, 0));
            sf(w, 0, r);
            sf(w, 1, g);
            sf(w, 2, bl);
        }
        Op::LoadUniform => {
            let (slot, n) = (b(0) as usize, b(1) as usize);
            let u = core::slice::from_raw_parts(c.uniforms, fxv::MAX_UNIFORM_SLOTS);
            for i in 0..n {
                w[i] = u.get(slot + i).copied().unwrap_or(0.0).to_bits() as i32;
            }
        }
        Op::LoadCtx => load_ctx(c, w, b(0)),
        Op::LoadCtxFix => w[0] = load_ctx_fix(c, b(0), b(1) as usize, b(2) as u32),
        Op::I2F => sf(w, 0, w[0] as f32),
        Op::F2I => w[0] = gf(w, 0) as i32,
        Op::Fix2F => sf(w, 0, w[0] as f32 / fxv::FIX_ONE as f32),
        Op::F2Fix => w[0] = (gf(w, 0) * fxv::FIX_ONE as f32) as i32,
        Op::FixToF => {
            let frac = b(0) as u32;
            sf(w, 0, w[0] as f32 / (1u32 << frac) as f32);
        }
        Op::FixFromF => {
            let frac = b(0) as u32;
            w[0] = (gf(w, 0) * (1u32 << frac) as f32) as i32;
        }
        Op::DivI => {
            let bb = w[1];
            w[0] = if bb == 0 { 0 } else { w[0].wrapping_div(bb) };
        }
        Op::ModI => {
            let bb = w[1];
            w[0] = if bb == 0 { 0 } else { w[0].wrapping_rem(bb) };
        }
        Op::DivFix => {
            let (a, bb) = (w[0] as i64, w[1] as i64);
            w[0] = if bb == 0 { 0 } else { ((a << 16) / bb) as i32 };
        }
        Op::DivFixN => {
            let frac = b(0) as u32;
            let (a, bb) = (w[0] as i64, w[1] as i64);
            w[0] = if bb == 0 { 0 } else { ((a << frac) / bb) as i32 };
        }
        Op::CmpI => {
            let kind = b(0);
            let (a, bb) = (w[0], w[1]);
            let r = match kind {
                0 => a < bb,
                1 => a <= bb,
                2 => a > bb,
                3 => a >= bb,
                4 => a == bb,
                _ => a != bb,
            };
            sf(w, 0, if r { 1.0 } else { 0.0 });
        }
        Op::AbsI => w[0] = w[0].wrapping_abs(),
        Op::MinI => w[0] = w[0].min(w[1]),
        Op::MaxI => w[0] = w[0].max(w[1]),
        Op::ClampI => {
            let (x, lo, hi) = (w[0], w[1], w[2]);
            w[0] = if x < lo { lo } else if x > hi { hi } else { x };
        }
        Op::SignI => {
            let frac = b(0) as u32;
            let one = 1i32 << frac;
            let x = w[0];
            #[allow(clippy::comparison_chain)]
            let s = if x > 0 { one } else if x < 0 { -one } else { 0 };
            w[0] = s;
        }
        Op::StepI => {
            let frac = b(0) as u32;
            let (edge, x) = (w[0], w[1]);
            w[0] = if x >= edge { 1i32 << frac } else { 0 };
        }
        Op::FloorFix => {
            let frac = b(0) as u32;
            w[0] = (w[0] >> frac) << frac;
        }
        Op::CeilFix => {
            let frac = b(0) as u32;
            let fl = (w[0] >> frac) << frac;
            w[0] = if fl != w[0] { fl.wrapping_add(1i32 << frac) } else { fl };
        }
        Op::FractFix => {
            let frac = b(0) as u32;
            w[0] &= (1i32 << frac) - 1;
        }
        Op::MixFix => {
            let frac = b(0) as u32;
            let (a, bb, t) = (w[0] as i64, w[1] as i64, w[2] as i64);
            w[0] = (a + (((bb - a) * t) >> frac)) as i32;
        }
        Op::SinFix => w[0] = fxv::sin_fix(w[0], b(0) as u32),
        Op::CosFix => w[0] = fxv::cos_fix(w[0], b(0) as u32),
        Op::ExpFix => w[0] = fxv::exp_fix(w[0], b(0) as u32),
        Op::SqrtFix => w[0] = fxv::sqrt_fix(w[0], b(0) as u32),
        Op::Atan2Fix => {
            let frac = b(0) as u32;
            // VM pops x (top) then y: win[0]=y, win[1]=x.
            w[0] = fxv::atan2_fix(w[0], w[1], frac);
        }
        Op::LogFix => w[0] = fxv::log_fix(w[0], b(0) as u32),
        Op::TanFix => w[0] = fxv::tan_fix(w[0], b(0) as u32),
        Op::PowFix => {
            let frac = b(0) as u32;
            w[0] = fxv::pow_fix(w[0], w[1], frac);
        }
        Op::HashFix => w[0] = fxv::hash_fix(w[0] as u32, b(0) as u32),
        Op::Hash3Fix => {
            let frac = b(0) as u32;
            w[0] = fxv::hash3_fix(w[0] as u32, w[1] as u32, w[2] as u32, frac);
        }
        Op::ScaleFix => {
            let (frac, n) = (b(0) as u32, b(1) as usize);
            let s = w[n] as i64;
            for i in 0..n {
                w[i] = (((w[i] as i64) * s) >> frac) as i32;
            }
        }
        Op::DotFix => {
            let (frac, n) = (b(0) as u32, b(1) as usize);
            let mut acc: i64 = 0;
            for i in 0..n {
                acc += ((w[i] as i64) * (w[n + i] as i64)) >> frac;
            }
            w[0] = acc as i32;
        }
        Op::LengthFix => {
            let (frac, n) = (b(0) as u32, b(1) as usize);
            let mut acc: i64 = 0;
            for i in 0..n {
                acc += ((w[i] as i64) * (w[i] as i64)) >> frac;
            }
            w[0] = fxv::sqrt_fix_i64(acc, frac) as i32;
        }
        Op::DistanceFix => {
            let (frac, n) = (b(0) as u32, b(1) as usize);
            let mut acc: i64 = 0;
            for i in 0..n {
                let d = (w[i] as i64) - (w[n + i] as i64);
                acc += (d * d) >> frac;
            }
            w[0] = fxv::sqrt_fix_i64(acc, frac) as i32;
        }
        Op::NormalizeFix => {
            let (frac, n) = (b(0) as u32, b(1) as usize);
            let mut acc: i64 = 0;
            for i in 0..n {
                acc += ((w[i] as i64) * (w[i] as i64)) >> frac;
            }
            let len = fxv::sqrt_fix_i64(acc, frac);
            if len > 0 {
                for i in 0..n {
                    w[i] = (((w[i] as i64) << frac) / len) as i32;
                }
            }
        }
        Op::CrossFix => {
            let frac = b(0) as u32;
            let a = [w[0] as i64, w[1] as i64, w[2] as i64];
            let bb = [w[3] as i64, w[4] as i64, w[5] as i64];
            w[0] = ((a[1] * bb[2] - a[2] * bb[1]) >> frac) as i32;
            w[1] = ((a[2] * bb[0] - a[0] * bb[2]) >> frac) as i32;
            w[2] = ((a[0] * bb[1] - a[1] * bb[0]) >> frac) as i32;
        }
        Op::SmoothstepFix => {
            let (frac, n) = (b(0) as u32, b(1) as usize);
            let one = 1i64 << frac;
            for i in 0..n {
                let e0 = w[i] as i64;
                let e1 = w[n + i] as i64;
                let x = w[2 * n + i] as i64;
                let t = if e1 == e0 {
                    0
                } else {
                    (((x - e0) << frac) / (e1 - e0)).clamp(0, one)
                };
                let t2 = (t * t) >> frac;
                w[i] = ((t2 * (3 * one - 2 * t)) >> frac) as i32;
            }
        }
        Op::ClampVFix => {
            let n = b(0) as usize;
            for i in 0..n {
                let (x, lo, hi) = (w[i], w[n + i], w[2 * n + i]);
                w[i] = if x < lo { lo } else if x > hi { hi } else { x };
            }
        }
        Op::MixVFix => {
            let (frac, n) = (b(0) as u32, b(1) as usize);
            let t = w[2 * n] as i64;
            for i in 0..n {
                let (a, bb) = (w[i] as i64, w[n + i] as i64);
                w[i] = (a + (((bb - a) * t) >> frac)) as i32;
            }
        }
        Op::Hsv2RgbFix => {
            let frac = b(0) as u32;
            let (r, g, bl) = fxv::hsv2rgb_fix(w[0], w[1], w[2], frac);
            w[0] = r;
            w[1] = g;
            w[2] = bl;
        }
        Op::PaletteFix => {
            let (id, frac) = (b(0), b(1) as u32);
            let (r, g, bl) = fxv::palette_fix(id, w[0], frac);
            w[0] = r;
            w[1] = g;
            w[2] = bl;
        }
        Op::LoadStateIdx | Op::LoadLocalIdx => {
            let (base, stride, off, n, count) =
                (b(0) as usize, b(1) as usize, b(2) as usize, b(3) as usize, b(4) as usize);
            let i = w[0];
            let hi = count.saturating_sub(1) as i32;
            let idx = i.clamp(0, hi) as usize;
            let p = base + idx * stride + off;
            let src = if op == Op::LoadStateIdx {
                core::slice::from_raw_parts(c.state, fxv::MAX_STATE)
            } else {
                core::slice::from_raw_parts(c.locals, fxv::MAX_LOCALS)
            };
            for k in 0..n {
                w[k] = src.get(p + k).copied().unwrap_or(0.0).to_bits() as i32;
            }
        }
        Op::StoreStateIdx | Op::StoreLocalIdx => {
            let (base, stride, off, n, count) =
                (b(0) as usize, b(1) as usize, b(2) as usize, b(3) as usize, b(4) as usize);
            // win[0] = index, win[1..=n] = values (top-of-stack order).
            let i = w[0];
            let hi = count.saturating_sub(1) as i32;
            let idx = i.clamp(0, hi) as usize;
            let p = base + idx * stride + off;
            let (dst, cap) = if op == Op::StoreStateIdx {
                (core::slice::from_raw_parts_mut(c.state, fxv::MAX_STATE), fxv::MAX_STATE)
            } else {
                (core::slice::from_raw_parts_mut(c.locals, fxv::MAX_LOCALS), fxv::MAX_LOCALS)
            };
            for k in 0..n {
                if p + k < cap {
                    dst[p + k] = f32::from_bits(w[1 + k] as u32);
                }
            }
        }
        _ => {}
    }
}

/// `LoadCtx id` → push its components into `w[0..]` (mirrors the VM arm's float
/// fields). The fixed-only ids go through [`load_ctx_fix`].
unsafe fn load_ctx(c: &mut NativeCtx, w: &mut [i32], id: u8) {
    use fxv::*;
    let f = &*c.frame;
    let led = &*c.led;
    let push = |w: &mut [i32], i: usize, v: f32| w[i] = v.to_bits() as i32;
    match id {
        C_TIME => push(w, 0, f.time),
        C_DT => push(w, 0, f.dt),
        C_FRAME => push(w, 0, f.frame as f32),
        C_LED_POS => {
            for k in 0..3 {
                push(w, k, led.pos[k]);
            }
        }
        C_LED_IDX => push(w, 0, led.idx as f32),
        C_LED_COUNT => push(w, 0, f.led_count as f32),
        C_LED_SEG => push(w, 0, led.seg as f32),
        C_LED_S => push(w, 0, led.s),
        C_LED_BRANCH => push(w, 0, if led.branch { 1.0 } else { 0.0 }),
        C_IMU_ACCEL => {
            for k in 0..3 {
                push(w, k, f.imu_accel[k]);
            }
        }
        C_IMU_GYRO => {
            for k in 0..3 {
                push(w, k, f.imu_gyro[k]);
            }
        }
        C_LED_DIST => push(w, 0, (*c.vm).led_dist(led)),
        C_LED_UV => {
            push(w, 0, led.uv[0]);
            push(w, 1, led.uv[1]);
        }
        C_LED_ROOM => {
            let r = if f.room_posed { &led.room } else { &led.pos };
            for k in 0..3 {
                push(w, k, r[k]);
            }
        }
        C_ROOM_MIN => {
            for k in 0..3 {
                push(w, k, f.room_min[k]);
            }
        }
        C_ROOM_MAX => {
            for k in 0..3 {
                push(w, k, f.room_max[k]);
            }
        }
        _ => push(w, 0, 0.0),
    }
}

/// `LoadCtxFix id, comp, frac` → the Q1.frac fixed value (mirrors the VM arm).
unsafe fn load_ctx_fix(c: &mut NativeCtx, id: u8, comp: usize, frac: u32) -> i32 {
    use fxv::*;
    let f = &*c.frame;
    let led = &*c.led;
    let (raw, canon): (i32, u32) = match id {
        C_TIME => (f.time_fix, CTX_FIX_FRAC),
        C_DT => (f.dt_fix, CTX_FIX_FRAC),
        C_FRAME => (f.frame as i32, 0),
        C_LED_POS => (led.pos_fix[comp.min(2)], CTX_FIX_FRAC),
        C_LED_IDX => (led.idx as i32, 0),
        C_LED_COUNT => (f.led_count as i32, 0),
        C_LED_SEG => (led.seg, 0),
        C_LED_S => (led.s_fix, CTX_FIX_FRAC),
        C_LED_BRANCH => (if led.branch { 1 } else { 0 }, 0),
        C_IMU_ACCEL => (f.imu_accel_fix[comp.min(2)], CTX_FIX_FRAC),
        C_IMU_GYRO => (f.imu_gyro_fix[comp.min(2)], CTX_FIX_FRAC),
        C_LED_DIST => (led.dist_fix, CTX_FIX_FRAC),
        C_LED_UV => (led.uv_fix[comp.min(1)], CTX_FIX_FRAC),
        C_LED_ROOM if f.room_posed => (led.room_fix[comp.min(2)], CTX_FIX_FRAC),
        C_LED_ROOM => (led.pos_fix[comp.min(2)], CTX_FIX_FRAC),
        C_ROOM_MIN => (f.room_min_fix[comp.min(2)], CTX_FIX_FRAC),
        C_ROOM_MAX => (f.room_max_fix[comp.min(2)], CTX_FIX_FRAC),
        _ => (0, 0),
    };
    let sh = frac as i32 - canon as i32;
    if sh >= 0 {
        raw.wrapping_shl(sh as u32)
    } else {
        raw >> ((-sh) as u32)
    }
}
