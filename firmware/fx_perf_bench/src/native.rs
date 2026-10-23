//! Hand-written native twins of the study effects — the "what if this effect
//! were straight-line Rust compiled for riscv32imac at opt-level 3" ceiling.
//!
//! Two variants per effect where both make sense:
//!
//! - `f32`: the SAME math as the VM, operation for operation, through the same
//!   fx_vm helpers (LUT `sinf`, `hash1/3`, `atan2f`, `sqrtf`, `hsv2rgb`, …) and the
//!   same compiler-builtins soft-float. It removes ONLY the interpreter (dispatch,
//!   operand stack, bounds checks, per-op decode) — so `VM − f32` is the
//!   interpretation overhead and the output is (near) bit-identical to the VM.
//! - `q16`: a fixed-point rewrite (Q16.16 / Q1.15 LUTs, integer hash/lerp) of the
//!   same look — what a careful human writes for an FPU-less core. `f32 − q16`
//!   is the soft-float cost. Outputs match the VM within a couple of LSB (the
//!   LUTs differ from the float polys in the last bits); the bench reports the
//!   error next to the timing.
//!
//! Each effect owns its LED loop (the closure is monomorphised into it), so LLVM
//! hoists per-frame-invariant work out of the loop and inlines everything — as it
//! would for an AOT-compiled effect. Nothing is cached ACROSS frames unless the
//! effect source itself does it (rain's 1/16 cloud refresh, the flood trail).

use core::ptr::{addr_of, addr_of_mut};

use ledmapper_fx_vm::{
    atan2f, clamp01, cosf, expf, floorf, fractf, hash1, hash3, hsv2rgb, powf, sin_fix, sinf, sqrtf, Frame,
};

use crate::engine::{Rgb, OUT_NAT};
use crate::fixture::{LedIn, FIX, LEDS};

pub struct Native {
    pub name: &'static str,
    pub variant: &'static str,
    pub reset: unsafe fn(),
    pub update: unsafe fn(&Frame),
    pub frame: unsafe fn(&Frame, usize),
}

const TAU: f32 = 6.2831853;

#[inline(always)]
fn rgb(r: f32, g: f32, b: f32) -> Rgb {
    ((clamp01(r) * 255.0) as u8, (clamp01(g) * 255.0) as u8, (clamp01(b) * 255.0) as u8)
}

/// Q16.16 [0,1] channel → 8-bit, matching the VM's truncating `x * 255`.
#[inline(always)]
fn rgb_q(r: i32, g: i32, b: i32) -> Rgb {
    let c = |x: i32| ((x.clamp(0, 65536) as u32 * 255) >> 16) as u8;
    (c(r), c(g), c(b))
}

#[inline(always)]
fn smooth(e0: f32, e1: f32, x: f32) -> f32 {
    let t = clamp01(if e1 == e0 { 0.0 } else { (x - e0) / (e1 - e0) });
    t * t * (3.0 - 2.0 * t)
}

#[inline(always)]
fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

#[inline(always)]
fn fmin(a: f32, b: f32) -> f32 {
    if a < b {
        a
    } else {
        b
    }
}
#[inline(always)]
fn fmax(a: f32, b: f32) -> f32 {
    if a > b {
        a
    } else {
        b
    }
}
#[inline(always)]
fn fclamp(x: f32, lo: f32, hi: f32) -> f32 {
    if x < lo {
        lo
    } else if x > hi {
        hi
    } else {
        x
    }
}
#[inline(always)]
fn fdiv(a: f32, b: f32) -> f32 {
    if b == 0.0 {
        0.0
    } else {
        a / b
    }
}

/// Q16 multiply, `(a*b) >> 16` (the VM's MulFix).
#[inline(always)]
fn mq(a: i32, b: i32) -> i32 {
    ((a as i64 * b as i64) >> 16) as i32
}

/// Q16 sine of a Q16 angle in TURNS (the VM's SinFix frac=16 LUT).
#[inline(always)]
fn sinq(turns: i32) -> i32 {
    sin_fix(turns, 16)
}

/// Run `f` over every LED into OUT_NAT. `inline(always)` + a generic closure ⇒
/// one monomorphic, fully-inlined loop per effect.
#[inline(always)]
unsafe fn sweep<F: FnMut(usize, &LedIn) -> Rgb>(n: usize, mut f: F) {
    let leds = &*addr_of!(LEDS);
    let out = &mut *addr_of_mut!(OUT_NAT);
    for i in 0..n {
        out[i] = f(i, &leds[i]);
    }
}

unsafe fn nop_reset() {}
unsafe fn nop_update(_: &Frame) {}

// --- solid ------------------------------------------------------------------
static mut SOLID_LEVEL: f32 = 0.0;
unsafe fn solid_update(f: &Frame) {
    let (breathe, rate) = (0.0f32, 0.25f32);
    SOLID_LEVEL = 1.0 - breathe * (0.5 - 0.5 * cosf(f.time * rate));
}
unsafe fn solid_f(_f: &Frame, n: usize) {
    let l = SOLID_LEVEL;
    let c = [1.0f32 * l, 0.55 * l, 0.2 * l];
    sweep(n, |_, _| rgb(c[0], c[1], c[2]));
}

// --- gradient (agent skill example height_gradient.fx) ----------------------
const GR_BOT: [f32; 3] = [0.9, 0.25, 0.05];
const GR_TOP: [f32; 3] = [0.1, 0.2, 0.8];
unsafe fn gradient_f(f: &Frame, n: usize) {
    let (lo, hi, drift) = (0.0f32, 1.0f32, 0.3f32);
    let t = f.time;
    sweep(n, |_, l| {
        let h = fclamp(fdiv(l.uv[1] - lo, fmax(hi - lo, 0.01)), 0.0, 1.0);
        let w = 0.15 * drift * sinf(t * 0.7 + l.pos[0] * 3.0);
        let k = fclamp(h + w, 0.0, 1.0);
        rgb(mix(GR_BOT[0], GR_TOP[0], k), mix(GR_BOT[1], GR_TOP[1], k), mix(GR_BOT[2], GR_TOP[2], k))
    });
}
unsafe fn gradient_q(f: &Frame, n: usize) {
    // drift wobble in Q16: sin(t*0.7 + x*3) radians → turns; uv.y already in Q16.
    let w_amp = (0.15f32 * 0.3 * 65536.0) as i32;
    let t_turn = ((f.time * 0.7 / TAU) * 65536.0) as i32;
    let x_k = (3.0 / TAU * 65536.0) as i32; // turns per metre
    let bot = [58982i32, 16384, 3277];
    let top = [6554i32, 13107, 52429];
    sweep(n, |_, l| {
        let ph = t_turn.wrapping_add(mq(l.posq[0], x_k));
        let w = mq(w_amp, sinq(ph));
        let k = (l.uvq[1] + w).clamp(0, 65536);
        rgb_q(
            bot[0] + mq(top[0] - bot[0], k),
            bot[1] + mq(top[1] - bot[1], k),
            bot[2] + mq(top[2] - bot[2], k),
        )
    });
}

// --- plasma -----------------------------------------------------------------
unsafe fn plasma_f(f: &Frame, n: usize) {
    let (speed, scale) = (1.0f32, 12.0f32);
    let t = f.time * speed;
    sweep(n, |_, l| {
        let p = [l.pos[0] * scale, l.pos[1] * scale, l.pos[2] * scale];
        let len = sqrtf(0.0 + p[0] * p[0] + p[1] * p[1]);
        let mut v = sinf(p[0] + t) + sinf(p[1] * 0.8 - t * 1.3) + sinf((p[0] + p[2]) * 0.7 + t * 0.7)
            + sinf(len * 1.1 - t);
        v *= 0.25;
        rgb(
            0.5 + 0.5 * sinf(v * 3.1416),
            0.5 + 0.5 * sinf(v * 3.1416 + 2.094),
            0.5 + 0.5 * sinf(v * 3.1416 + 4.188),
        )
    });
}
/// Integer sqrt of a non-negative i64 (bit-by-bit).
#[inline(always)]
fn isqrt(mut v: u64) -> u64 {
    let mut r = 0u64;
    let mut b = 1u64 << 62;
    while b > v {
        b >>= 2;
    }
    while b != 0 {
        if v >= r + b {
            v -= r + b;
            r = (r >> 1) + b;
        } else {
            r >>= 1;
        }
        b >>= 2;
    }
    r
}
unsafe fn plasma_q(f: &Frame, n: usize) {
    // Angles carried in Q16 TURNS so the LUT needs no range reduction.
    let (speed, scale) = (1.0f32, 12.0f32);
    let t = f.time * speed;
    let k = (scale / TAU * 65536.0) as i32; // metres → turns (× scale)
    let tq = |x: f32| ((fractf(x / TAU)) * 65536.0) as i32;
    let (t0, t1, t2, t3) = (tq(t), tq(t * 1.3), tq(t * 0.7), tq(t));
    let k08 = mq(k, 52429);
    let k07 = mq(k, 45875);
    let ks = (scale * 1.1 / TAU * 65536.0) as i32;
    sweep(n, |_, l| {
        let (x, y, z) = (l.posq[0], l.posq[1], l.posq[2]);
        let r = isqrt((x as i64 * x as i64 + y as i64 * y as i64) as u64) as i32; // Q16 metres
        let v = sinq(mq(x, k).wrapping_add(t0))
            + sinq(mq(y, k08).wrapping_sub(t1))
            + sinq(mq(x + z, k07).wrapping_add(t2))
            + sinq(mq(r, ks).wrapping_sub(t3));
        // v in Q16 [-4,4] → *0.25*3.1416 rad → turns: v * 0.25 * 0.5 = v/8 turns
        let ph = v >> 3;
        let c = |o: i32| 32768 + (sinq(ph + o) >> 1);
        rgb_q(c(0), c(21844), c(43689))
    });
}

// --- cylinder (#328's motivating case) --------------------------------------
unsafe fn cylinder_f(f: &Frame, n: usize) {
    let (speed, bands) = (0.35f32, 6.0f32);
    let t = f.time * speed;
    let glow = 0.5 + 0.5 * sinf(t * 6.2831853);
    sweep(n, |_, l| {
        let ang = atan2f(l.pos[0], l.pos[2]) * 0.15915494 + 0.5;
        let r = sqrtf(0.0 + l.pos[0] * l.pos[0] + l.pos[2] * l.pos[2]);
        let v = fractf(ang * bands + t);
        let (cr, cg, cb) = hsv2rgb(v, 0.8, fclamp(r * 8.0 * glow, 0.0, 1.0));
        rgb(cr, cg, cb)
    });
}
/// atan2 in Q16 turns ([-0.5, 0.5)), octant-folded with a cubic on the ratio.
#[inline(always)]
fn atan2_turns(y: i32, x: i32) -> i32 {
    if x == 0 && y == 0 {
        return 0;
    }
    let (ax, ay) = (x.unsigned_abs() as i64, y.unsigned_abs() as i64);
    let (num, den) = if ax >= ay { (ay, ax) } else { (ax, ay) };
    let a = ((num << 16) / den) as i32; // Q16 ratio in [0,1]
    // atan(a) ≈ (π/4)a + 0.273·a(1−a) on [0,1] (max err ≈ 0.004 rad), in turns:
    // a·(0.125 + 0.04345·(1−a)).
    let mut r = mq(a, 8192 + mq(2847, 65536 - a));
    if ay > ax {
        r = 16384 - r;
    }
    if x < 0 {
        r = 32768 - r;
    }
    if y < 0 {
        r = -r;
    }
    r
}
/// HSV→RGB in Q16 (h in turns, s,v in [0,1]) — the VM's sector formula.
#[inline(always)]
fn hsv_q(h: i32, s: i32, v: i32) -> (i32, i32, i32) {
    let h6 = (h & 0xffff) * 6; // [0,6) Q16
    let c = mq(v, s);
    let sec = h6 >> 16;
    let f2 = (h6 >> 1) & 0xffff; // fract(h6/2)
    let x = mq(c, 65536 - (f2 * 2 - 65536).abs());
    let m = v - c;
    let (r, g, b) = match sec {
        0 => (c, x, 0),
        1 => (x, c, 0),
        2 => (0, c, x),
        3 => (0, x, c),
        4 => (x, 0, c),
        _ => (c, 0, x),
    };
    (r + m, g + m, b + m)
}
unsafe fn cylinder_q(f: &Frame, n: usize) {
    let (speed, bands) = (0.35f32, 6i32);
    let t = f.time * speed;
    let tq = (fractf(t) * 65536.0) as i32;
    let glow = (((0.5 + 0.5 * sinf(t * 6.2831853)) * 8.0) * 65536.0) as i32;
    sweep(n, |_, l| {
        let (x, z) = (l.posq[0], l.posq[2]);
        let ang = atan2_turns(x, z) + 32768;
        let r = isqrt((x as i64 * x as i64 + z as i64 * z as i64) as u64) as i32;
        let v = (ang * bands + tq) & 0xffff;
        let (cr, cg, cb) = hsv_q(v, 52429, mq(r, glow).clamp(0, 65536));
        rgb_q(cr, cg, cb)
    });
}

// --- sweep ------------------------------------------------------------------
unsafe fn sweep_f(f: &Frame, n: usize) {
    let (speed, width) = (0.5f32, 0.12f32);
    let color = [1.0f32, 0.6, 0.2];
    let base = [0.02f32, 0.01, 0.04];
    let head = fractf(f.time * speed);
    sweep(n, |_, l| {
        let d = (l.uv[1] - head).abs();
        let v = smooth(width, 0.0, d);
        rgb(base[0] + color[0] * v, base[1] + color[1] * v, base[2] + color[2] * v)
    });
}
unsafe fn sweep_q(f: &Frame, n: usize) {
    let head = (fractf(f.time * 0.5) * 65536.0) as i32;
    let width = 7864i32; // 0.12
    let inv_w = ((65536i64 << 16) / width as i64) as i32;
    let color = [65536i32, 39322, 13107];
    let base = [1311i32, 655, 2621];
    sweep(n, |_, l| {
        let d = (l.uvq[1] - head).abs();
        let t = (65536 - mq(d, inv_w)).clamp(0, 65536);
        let v = mq(mq(t, t), 196608 - 2 * t);
        rgb_q(base[0] + mq(color[0], v), base[1] + mq(color[1], v), base[2] + mq(color[2], v))
    });
}

// --- sparkle (hash-of-index twinkle) ---------------------------------------
static mut SPARKLE_T: f32 = 0.0;
unsafe fn sparkle_reset() {
    SPARKLE_T = 0.0;
}
unsafe fn sparkle_update(f: &Frame) {
    SPARKLE_T += f.dt * 1.0;
}
unsafe fn sparkle_f(_f: &Frame, n: usize) {
    let t = SPARKLE_T;
    sweep(n, |i, _| {
        let fi = i as f32;
        let ph = hash1(fi * 7.31 + 0.5);
        let sp = 0.6 + 0.8 * hash1(fi * 3.7 + 1.3);
        let b = powf(0.5 + 0.5 * sinf((t * sp + ph) * 6.2831853), 8.0);
        rgb(b, b, b)
    });
}
unsafe fn sparkle_q(_f: &Frame, n: usize) {
    // Phases stay float-hashed (bit-compatible with the VM's hash of a float);
    // the sine + ^8 are integer (three squarings instead of exp(8 log x)).
    let t = SPARKLE_T;
    let tq = (t * 65536.0) as i64;
    sweep(n, |i, _| {
        let fi = i as f32;
        let ph = (hash1(fi * 7.31 + 0.5) * 65536.0) as i64;
        let sp = ((0.6 + 0.8 * hash1(fi * 3.7 + 1.3)) * 65536.0) as i64;
        let turns = (((tq * sp) >> 16) + ph) as i32;
        let x = 32768 + (sinq(turns) >> 1);
        let x2 = mq(x, x);
        let x4 = mq(x2, x2);
        let b = mq(x4, x4);
        rgb_q(b, b, b)
    });
}

// --- noise field (agent skill example noise_field.fx) -----------------------
static mut NOISE_Z: f32 = 0.0;
unsafe fn noise_update(f: &Frame) {
    NOISE_Z = f.time * 0.3;
}
unsafe fn noise_f(_f: &Frame, n: usize) {
    let (scale, contrast) = (3.0f32, 1.5f32);
    let low = [0.0f32, 0.05, 0.2];
    let high = [0.1f32, 0.9, 0.6];
    let z = NOISE_Z;
    let off = [0.0f32, z, z * 0.5];
    sweep(n, |_, l| {
        let p = [l.pos[0] * scale + off[0], l.pos[1] * scale + off[1], l.pos[2] * scale + off[2]];
        let i = [floorf(p[0]), floorf(p[1]), floorf(p[2])];
        let fr = [p[0] - floorf(p[0]), p[1] - floorf(p[1]), p[2] - floorf(p[2])];
        let u = [
            fr[0] * fr[0] * (3.0 - 2.0 * fr[0]),
            fr[1] * fr[1] * (3.0 - 2.0 * fr[1]),
            fr[2] * fr[2] * (3.0 - 2.0 * fr[2]),
        ];
        let h = |dx: f32, dy: f32, dz: f32| hash3(i[0] + dx, i[1] + dy, i[2] + dz);
        let a = mix(h(0.0, 0.0, 0.0), h(1.0, 0.0, 0.0), u[0]);
        let b = mix(h(0.0, 1.0, 0.0), h(1.0, 1.0, 0.0), u[0]);
        let c = mix(h(0.0, 0.0, 1.0), h(1.0, 0.0, 1.0), u[0]);
        let d = mix(h(0.0, 1.0, 1.0), h(1.0, 1.0, 1.0), u[0]);
        let nn = mix(mix(a, b, u[1]), mix(c, d, u[1]), u[2]);
        let t = fclamp((nn - 0.5) * contrast + 0.5, 0.0, 1.0);
        rgb(mix(low[0], high[0], t), mix(low[1], high[1], t), mix(low[2], high[2], t))
    });
}
unsafe fn noise_q(_f: &Frame, n: usize) {
    // Same lattice (cell ids hashed as the float bits of the integer corner, so
    // the corner values match the VM's hash3 exactly); interpolation in Q16.
    let scale = 196608i64; // 3.0
    let z = NOISE_Z;
    let off = [0i64, (z * 65536.0) as i64, (z * 0.5 * 65536.0) as i64];
    let low = [0i32, 3277, 13107];
    let high = [6554i32, 58982, 39322];
    sweep(n, |_, l| {
        let p = [
            ((l.posq[0] as i64 * scale) >> 16) + off[0],
            ((l.posq[1] as i64 * scale) >> 16) + off[1],
            ((l.posq[2] as i64 * scale) >> 16) + off[2],
        ];
        let ci = [(p[0] >> 16) as i32, (p[1] >> 16) as i32, (p[2] >> 16) as i32];
        let fr = [(p[0] & 0xffff) as i32, (p[1] & 0xffff) as i32, (p[2] & 0xffff) as i32];
        let u = [
            mq(mq(fr[0], fr[0]), 196608 - 2 * fr[0]),
            mq(mq(fr[1], fr[1]), 196608 - 2 * fr[1]),
            mq(mq(fr[2], fr[2]), 196608 - 2 * fr[2]),
        ];
        let h = |dx: i32, dy: i32, dz: i32| {
            (hash3((ci[0] + dx) as f32, (ci[1] + dy) as f32, (ci[2] + dz) as f32) * 65536.0) as i32
        };
        let lq = |a: i32, b: i32, t: i32| a + mq(b - a, t);
        let a = lq(h(0, 0, 0), h(1, 0, 0), u[0]);
        let b = lq(h(0, 1, 0), h(1, 1, 0), u[0]);
        let c = lq(h(0, 0, 1), h(1, 0, 1), u[0]);
        let d = lq(h(0, 1, 1), h(1, 1, 1), u[0]);
        let nn = lq(lq(a, b, u[1]), lq(c, d, u[1]), u[2]);
        let t = (mq(nn - 32768, 98304) + 32768).clamp(0, 65536);
        rgb_q(lq(low[0], high[0], t), lq(low[1], high[1], t), lq(low[2], high[2], t))
    });
}

// --- segment pulses (agent skill example segment_pulses.fx) ------------------
unsafe fn pulses_f(f: &Frame, n: usize) {
    let (speed, tail, pulses, rainbow) = (0.6f32, 0.2f32, 1.0f32, 0.5f32);
    let tint = [0.3f32, 0.8, 1.0];
    let ts = f.time * speed;
    sweep(n, |_, l| {
        let seg = l.seg as f32;
        let phase = fractf(l.s * pulses - ts + hash1(seg));
        let v = smooth(1.0 - tail, 1.0, phase);
        let (hr, hg, hb) = hsv2rgb(hash1(seg * 3.0), 0.8, 1.0);
        rgb(mix(tint[0], hr, rainbow) * v, mix(tint[1], hg, rainbow) * v, mix(tint[2], hb, rainbow) * v)
    });
}
unsafe fn pulses_q(f: &Frame, n: usize) {
    let ts = ((f.time * 0.6) * 65536.0) as i64 as i32;
    let tint = [19661i32, 52429, 65536];
    let e0 = 52429i32; // 1 - tail
    let inv = ((65536i64 << 16) / (65536 - e0) as i64) as i32;
    sweep(n, |_, l| {
        let seg = l.seg as f32;
        let hs = (hash1(seg) * 65536.0) as i32;
        let s = (l.s * 65536.0) as i32;
        let phase = (s.wrapping_sub(ts).wrapping_add(hs)) & 0xffff;
        let t = mq(phase - e0, inv).clamp(0, 65536);
        let v = mq(mq(t, t), 196608 - 2 * t);
        let (hr, hg, hb) = hsv_q((hash1(seg * 3.0) * 65536.0) as i32, 52429, 65536);
        let m = |a: i32, b: i32| mq(a + ((b - a) >> 1), v);
        rgb_q(m(tint[0], hr), m(tint[1], hg), m(tint[2], hb))
    });
}

// --- particles (8 agents, per-LED loop) -------------------------------------
static mut PT_P: [[f32; 3]; 8] = [[0.0; 3]; 8];
static mut PT_V: [[f32; 3]; 8] = [[0.0; 3]; 8];
static mut PT_INIT: bool = false;
unsafe fn particles_reset() {
    PT_INIT = false;
    PT_P = [[0.0; 3]; 8];
    PT_V = [[0.0; 3]; 8];
}
unsafe fn particles_update(f: &Frame) {
    let p = &mut *addr_of_mut!(PT_P);
    let v = &mut *addr_of_mut!(PT_V);
    if !PT_INIT {
        for i in 0..8 {
            let fi = i as f32;
            p[i] = [
                (hash1(fi * 1.3) - 0.5) * 0.2,
                hash1(fi * 2.1 + 0.3) * 0.2,
                (hash1(fi * 3.7 + 0.9) - 0.5) * 0.2,
            ];
            v[i] = [(hash1(fi * 5.1) - 0.5) * 0.3, (hash1(fi * 6.3) - 0.5) * 0.3, (hash1(fi * 7.7) - 0.5) * 0.3];
        }
        PT_INIT = true;
    }
    let speed = 0.6f32;
    for i in 0..8 {
        let q = [
            p[i][0] + v[i][0] * f.dt * speed,
            p[i][1] + v[i][1] * f.dt * speed,
            p[i][2] + v[i][2] * f.dt * speed,
        ];
        let fx = if q[0].abs() > 0.1 { -1.0 } else { 1.0 };
        let fy = if q[1] < 0.0 || q[1] > 0.3 { -1.0 } else { 1.0 };
        let fz = if q[2].abs() > 0.1 { -1.0 } else { 1.0 };
        v[i] = [v[i][0] * fx, v[i][1] * fy, v[i][2] * fz];
        p[i] = [fclamp(q[0], -0.1, 0.1), fclamp(q[1], 0.0, 0.3), fclamp(q[2], -0.1, 0.1)];
    }
}
unsafe fn particles_f(_f: &Frame, n: usize) {
    let p = &*addr_of!(PT_P);
    let radius = 0.04f32;
    let tint = [1.0f32, 0.5, 0.15];
    let r2 = radius * radius;
    sweep(n, |_, l| {
        let mut g = 0.0f32;
        for q in p.iter() {
            let d = [l.pos[0] - q[0], l.pos[1] - q[1], l.pos[2] - q[2]];
            g += fdiv(r2, 0.0 + d[0] * d[0] + d[1] * d[1] + d[2] * d[2] + r2);
        }
        let g = fclamp(g, 0.0, 1.0);
        rgb(tint[0] * g, tint[1] * g, tint[2] * g)
    });
}
unsafe fn particles_q(_f: &Frame, n: usize) {
    let p = &*addr_of!(PT_P);
    let mut pq = [[0i32; 3]; 8];
    for (a, b) in pq.iter_mut().zip(p.iter()) {
        *a = [(b[0] * 65536.0) as i32, (b[1] * 65536.0) as i32, (b[2] * 65536.0) as i32];
    }
    // g = Σ r²/(d²+r²): distances in Q16 metres, squared sums in Q32 (u64),
    // one 64-bit divide per particle.
    let r2 = (2621i64 * 2621) as u64; // (0.04 m in Q16)² = Q32
    let tint = [65536i32, 32768, 9830];
    sweep(n, |_, l| {
        let mut g: u64 = 0;
        for q in pq.iter() {
            let dx = (l.posq[0] - q[0]) as i64;
            let dy = (l.posq[1] - q[1]) as i64;
            let dz = (l.posq[2] - q[2]) as i64;
            let d2 = (dx * dx + dy * dy + dz * dz) as u64;
            g += (r2 << 16) / (d2 + r2);
        }
        let g = g.min(65536) as i32;
        rgb_q(mq(tint[0], g), mq(tint[1], g), mq(tint[2], g))
    });
}

// --- flood (topology re-root + trail buffer) --------------------------------
const MAX_NODE: usize = 96;
static mut FL_D: [f32; MAX_NODE] = [f32::INFINITY; MAX_NODE];
static mut FL_MAX: f32 = 1.0;
static mut FL_SET: bool = false;
static mut FL_SRC: i32 = 0;
static mut FL_HEAD: f32 = 0.0;
static mut FL_TRAIL: [f32; crate::fixture::MAX_LEDS] = [0.0; crate::fixture::MAX_LEDS];
unsafe fn flood_reset() {
    FL_D = [f32::INFINITY; MAX_NODE];
    FL_MAX = 1.0;
    FL_SET = false;
    FL_SRC = 0;
    FL_HEAD = 0.0;
    FL_TRAIL = [0.0; crate::fixture::MAX_LEDS];
}
/// The VM's FloodFrom: Bellman-Ford over the segment edges, same order.
unsafe fn flood_from(src: i32) {
    let fx = &*addr_of!(FIX);
    let d = &mut *addr_of_mut!(FL_D);
    for x in d.iter_mut() {
        *x = f32::INFINITY;
    }
    FL_SET = false;
    if src >= 0 && (src as usize) < MAX_NODE {
        d[src as usize] = 0.0;
        for _ in 0..MAX_NODE {
            let mut changed = false;
            for si in 0..fx.n_seg {
                let (a, b) = (fx.seg_a[si] as usize, fx.seg_b[si] as usize);
                let w = fx.seg_len[si];
                if d[a] + w < d[b] {
                    d[b] = d[a] + w;
                    changed = true;
                }
                if d[b] + w < d[a] {
                    d[a] = d[b] + w;
                    changed = true;
                }
            }
            if !changed {
                break;
            }
        }
        let mut mx = 0.0f32;
        for &x in d.iter() {
            if x.is_finite() && x > mx {
                mx = x;
            }
        }
        FL_MAX = if mx > 1e-6 { mx } else { 1.0 };
        FL_SET = true;
    }
}
unsafe fn flood_update(f: &Frame) {
    let s = floorf(f.time * 0.5) as i32;
    if s != FL_SRC {
        FL_SRC = s;
        let a = s as f32;
        flood_from((a - 9.0 * floorf(a / 9.0)) as i32);
    }
    FL_HEAD = fractf(f.time * 1.2 * 0.2);
}
#[inline(always)]
unsafe fn led_dist(l: &LedIn) -> f32 {
    let fx = &*addr_of!(FIX);
    if FL_SET && l.seg >= 0 && (l.seg as usize) < fx.n_seg {
        let si = l.seg as usize;
        let d = &*addr_of!(FL_D);
        let len = fx.seg_len[si];
        let da = d[fx.seg_a[si] as usize] + l.s * len;
        let db = d[fx.seg_b[si] as usize] + (1.0 - l.s) * len;
        let g = if da < db { da } else { db };
        if g.is_finite() {
            (g / FL_MAX).min(1.0)
        } else {
            1.0
        }
    } else {
        l.dist
    }
}
unsafe fn flood_f(_f: &Frame, n: usize) {
    let (decay, width, rainbow) = (0.85f32, 0.08f32, 0.6f32);
    let tint = [0.2f32, 0.8, 1.0];
    let head = FL_HEAD;
    let trail = &mut *addr_of_mut!(FL_TRAIL);
    sweep(n, |i, l| {
        let dist = led_dist(l);
        let spark = smooth(width, 0.0, (dist - head).abs());
        let v = fmax(trail[i] * decay, spark);
        trail[i] = v;
        let (hr, hg, hb) = hsv2rgb(dist, 0.85, 1.0);
        let c = [
            tint[0] * (1.0 - rainbow) + hr * rainbow,
            tint[1] * (1.0 - rainbow) + hg * rainbow,
            tint[2] * (1.0 - rainbow) + hb * rainbow,
        ];
        rgb(c[0] * v, c[1] * v, c[2] * v)
    });
}

// --- texture (paint in update, bilinear sample in shade) --------------------
static mut TEX: [f32; 16 * 16 * 3] = [0.0; 16 * 16 * 3];
unsafe fn texture_reset() {
    TEX = [0.0; 16 * 16 * 3];
}
unsafe fn texture_update(f: &Frame) {
    let tex = &mut *addr_of_mut!(TEX);
    let tint = [0.2f32, 0.7, 1.0];
    let a = f.time * 1.0;
    for i in 0..16 {
        let r = i as f32 / 15.0 * 0.5;
        let u = 0.5 + r * cosf(a);
        let v = 0.5 + r * sinf(a);
        let x = floorf(u.clamp(0.0, 1.0) * 15.0 + 0.5) as usize;
        let y = floorf(v.clamp(0.0, 1.0) * 15.0 + 0.5) as usize;
        let o = (y.min(15) * 16 + x.min(15)) * 3;
        for k in 0..3 {
            tex[o + k] = tint[k] * (1.0 - r);
        }
    }
}
unsafe fn texture_f(_f: &Frame, n: usize) {
    let tex = &*addr_of!(TEX);
    sweep(n, |_, l| {
        let fx = l.uv[0].clamp(0.0, 1.0) * 15.0;
        let fy = l.uv[1].clamp(0.0, 1.0) * 15.0;
        let x0 = floorf(fx) as usize;
        let y0 = floorf(fy) as usize;
        let x1 = (x0 + 1).min(15);
        let y1 = (y0 + 1).min(15);
        let tx = fx - x0 as f32;
        let ty = fy - y0 as f32;
        let mut c = [0.0f32; 3];
        for (k, ck) in c.iter_mut().enumerate() {
            let tap = |x: usize, y: usize| tex[(y * 16 + x) * 3 + k];
            let a = tap(x0, y0) * (1.0 - tx) + tap(x1, y0) * tx;
            let b = tap(x0, y1) * (1.0 - tx) + tap(x1, y1) * tx;
            *ck = a * (1.0 - ty) + b * ty;
        }
        rgb(c[0], c[1], c[2])
    });
}

// --- rain (the user's hand-optimised effect, fixed-point; mirrors its bytecode)
struct RainState {
    slot: i32,
    cs: i32,
    d1: i32,
    d2: i32,
    d2b: i32,
    d3: i32,
    head: [i32; 32],
    flashing: bool,
    fl_mul: f32,
    a: [i32; 3],
    b: [i32; 3],
    h: [i32; 3],
    rain_c: [f32; 3],
}
static mut RAIN: RainState = RainState {
    slot: 0,
    cs: 0,
    d1: 0,
    d2: 0,
    d2b: 0,
    d3: 0,
    head: [0; 32],
    flashing: false,
    fl_mul: 1.0,
    a: [0; 3],
    b: [0; 3],
    h: [0; 3],
    rain_c: [0.0; 3],
};
static mut RAIN_CLOUD: [[f32; 3]; crate::fixture::MAX_LEDS] = [[0.0; 3]; crate::fixture::MAX_LEDS];
static mut RAIN_COL: [i32; crate::fixture::MAX_LEDS] = [0; crate::fixture::MAX_LEDS];
const R_TINT: [f32; 3] = [0.36, 0.42, 0.52];
unsafe fn rain_reset() {
    RAIN_CLOUD = [[0.0; 3]; crate::fixture::MAX_LEDS];
    RAIN_COL = [0; crate::fixture::MAX_LEDS];
}
#[inline(always)]
fn f2q(x: f32) -> i32 {
    (x * 65536.0) as i32
}
/// The lightning envelope (shared by rain + rain_naive).
#[inline(always)]
fn lightning_env(time: f32) -> f32 {
    let k = floorf(time / 30.0);
    let age = time - (k * 30.0 + 5.0 + 10.0 * hash1(k));
    let mut e = 0.0f32;
    if age > 0.0 && age < 3.0 {
        e = fmin(age / 0.15, 1.0) * expf(-age * 2.5);
        let a2 = age - 0.45;
        if a2 > 0.0 {
            e += 0.4 * fmin(a2 / 0.12, 1.0) * expf(-a2 * 3.0);
        }
    }
    e
}
unsafe fn rain_update(f: &Frame) {
    let (cloud_speed, cloud_scale, rain, rain_speed, lightning) = (0.06f32, 2.5f32, 0.35f32, 1.3f32, 0.5f32);
    let r = &mut *addr_of_mut!(RAIN);
    let fr = f.frame as f32;
    r.slot = (fr - 16.0 * floorf(fr / 16.0)) as i32;
    r.cs = f2q(cloud_scale * 0.5);
    let dr = f.time * cloud_speed;
    r.d1 = f2q(fractf(dr * 0.5));
    r.d2 = f2q(fractf(dr * 0.37));
    r.d2b = f2q(fractf(dr * 0.52));
    r.d3 = f2q(fractf(dr * 0.46));
    let rt = f.time * rain_speed;
    let thr = rain * 0.6;
    for c in 0..32 {
        let h = hash1(c as f32 * 1.37 + 0.5);
        let t = rt * (0.8 + 0.5 * h) + h;
        let mut y = -9.0f32;
        if hash1(c as f32 * 97.0 + floorf(t)) < thr {
            y = 1.15 - fractf(t) * 1.4;
        }
        r.head[c] = f2q(y);
    }
    let e = lightning_env(f.time) * lightning;
    r.flashing = e > 0.004;
    r.fl_mul = 1.0 + e * 1.2;
    for k in 0..3 {
        r.a[k] = f2q(R_TINT[k] * 0.25);
        r.b[k] = f2q(R_TINT[k] * 0.6);
    }
    let hl = [0.62f32, 0.68, 0.78];
    let rc = [0.55f32, 0.68, 0.9];
    for k in 0..3 {
        r.h[k] = f2q((hl[k] - R_TINT[k] * 0.75) * 0.45);
        r.rain_c[k] = (rc[k] - R_TINT[k] * 0.55) * 0.75;
    }
}
unsafe fn rain_f(_f: &Frame, n: usize) {
    let r = &*addr_of!(RAIN);
    let cloud = &mut *addr_of_mut!(RAIN_CLOUD);
    let column = &mut *addr_of_mut!(RAIN_COL);
    sweep(n, |i, l| {
        let ii = i as i32;
        let uy = l.uvq[1];
        if ii.wrapping_rem(16) == r.slot {
            let ux = l.uvq[0];
            let z = l.posq[2];
            let x = mq(ux, r.cs);
            let y = mq(uy, r.cs);
            let w = mq(sinq(mq(y, 39321).wrapping_add(mq(z, 98304)).wrapping_sub(r.d2)), 16384);
            let mut nn = 32768
                + mq(17039, sinq(x.wrapping_sub(r.d1).wrapping_add(w).wrapping_add(mq(y, 19660))))
                + mq(10485, sinq(mq(x, 137625).wrapping_sub(mq(y, 85196)).wrapping_add(mq(z, 131072)).wrapping_sub(r.d2b)))
                + mq(6553, sinq(mq(x, 242483).wrapping_add(mq(y, 190054)).wrapping_sub(r.d3)));
            nn = (mq(nn - 32768, 124518) + 32768).clamp(0, 65536);
            let thin = mq(nn - 39321, 163840).clamp(0, 65536);
            for k in 0..3 {
                cloud[i][k] = (r.a[k] + mq(r.b[k], nn) + mq(r.h[k], thin)) as f32 / 65536.0;
            }
            let mut col = (mq(ux, 1048576) >> 16).min(15);
            if z > 0 {
                col += 16;
            }
            column[i] = col;
        }
        let mut c = cloud[i];
        let d = uy.wrapping_sub(r.head[column[i].clamp(0, 31) as usize]);
        if d.wrapping_sub(7536).wrapping_abs() < 9502 {
            let s = (65536 + mq(d, 2162688)).min(65536 - mq(d, 252313));
            let sf = s as f32 / 65536.0;
            for k in 0..3 {
                c[k] += r.rain_c[k] * sf;
            }
        }
        if r.flashing {
            for ck in c.iter_mut() {
                *ck *= r.fl_mul;
            }
        }
        rgb(c[0], c[1], c[2])
    });
}

// --- rain_naive (reconstructed first draft: everything per LED, float) ------
unsafe fn rain_naive_f(f: &Frame, n: usize) {
    let (cloud_speed, cloud_scale, rain, rain_speed, lightning) = (0.06f32, 2.5f32, 0.35f32, 1.3f32, 0.5f32);
    let t_ = R_TINT;
    let time = f.time;
    sweep(n, |_, l| {
        let x = l.uv[0] * cloud_scale;
        let y = l.uv[1] * cloud_scale;
        let z = l.pos[2];
        let dr = time * cloud_speed;
        let w = sinf((y * 0.6 + z * 1.5 - dr * 0.37) * 6.2831853) * 0.25;
        let mut nn = 0.5
            + 0.26 * sinf((x - dr * 0.5 + w + y * 0.3) * 6.2831853)
            + 0.16 * sinf((x * 2.1 - y * 1.3 + z * 2.0 - dr * 0.52) * 6.2831853)
            + 0.10 * sinf((x * 3.7 + y * 2.9 - dr * 0.46) * 6.2831853);
        nn = fclamp((nn - 0.5) * 1.9 + 0.5, 0.0, 1.0);
        let thin = fclamp((nn - 0.6) * 2.5, 0.0, 1.0);
        let hl = [0.62f32, 0.68, 0.78];
        let mut c = [0.0f32; 3];
        for k in 0..3 {
            c[k] = t_[k] * 0.25 + t_[k] * 0.6 * nn + (hl[k] - t_[k] * 0.75) * 0.45 * thin;
        }
        let mut col = fmin(floorf(l.uv[0] * 16.0), 15.0);
        if z > 0.0 {
            col += 16.0;
        }
        let h = hash1(col * 1.37 + 0.5);
        let t = time * rain_speed * (0.8 + 0.5 * h) + h;
        let mut head = -9.0f32;
        if hash1(col * 97.0 + floorf(t)) < rain * 0.6 {
            head = 1.15 - fractf(t) * 1.4;
        }
        let d = l.uv[1] - head;
        if d > -0.03 && d < 0.26 {
            let s = fmin(1.0 + d * 33.0, 1.0 - d * 3.85);
            let rc = [0.55f32, 0.68, 0.9];
            for k in 0..3 {
                c[k] += (rc[k] - t_[k] * 0.55) * 0.75 * s;
            }
        }
        let e = lightning_env(time);
        let m = 1.0 + e * lightning * 1.2;
        rgb(c[0] * m, c[1] * m, c[2] * m)
    });
}

pub static NATIVES: &[Native] = &[
    Native { name: "solid", variant: "f32", reset: nop_reset, update: solid_update, frame: solid_f },
    Native { name: "gradient", variant: "f32", reset: nop_reset, update: nop_update, frame: gradient_f },
    Native { name: "gradient", variant: "q16", reset: nop_reset, update: nop_update, frame: gradient_q },
    Native { name: "plasma", variant: "f32", reset: nop_reset, update: nop_update, frame: plasma_f },
    Native { name: "plasma", variant: "q16", reset: nop_reset, update: nop_update, frame: plasma_q },
    Native { name: "cylinder", variant: "f32", reset: nop_reset, update: nop_update, frame: cylinder_f },
    Native { name: "cylinder", variant: "q16", reset: nop_reset, update: nop_update, frame: cylinder_q },
    Native { name: "sweep", variant: "f32", reset: nop_reset, update: nop_update, frame: sweep_f },
    Native { name: "sweep", variant: "q16", reset: nop_reset, update: nop_update, frame: sweep_q },
    Native { name: "sparkle", variant: "f32", reset: sparkle_reset, update: sparkle_update, frame: sparkle_f },
    Native { name: "sparkle", variant: "q16", reset: sparkle_reset, update: sparkle_update, frame: sparkle_q },
    Native { name: "noise", variant: "f32", reset: nop_reset, update: noise_update, frame: noise_f },
    Native { name: "noise", variant: "q16", reset: nop_reset, update: noise_update, frame: noise_q },
    Native { name: "pulses", variant: "f32", reset: nop_reset, update: nop_update, frame: pulses_f },
    Native { name: "pulses", variant: "q16", reset: nop_reset, update: nop_update, frame: pulses_q },
    Native { name: "particles", variant: "f32", reset: particles_reset, update: particles_update, frame: particles_f },
    Native { name: "particles", variant: "q16", reset: particles_reset, update: particles_update, frame: particles_q },
    Native { name: "flood", variant: "f32", reset: flood_reset, update: flood_update, frame: flood_f },
    Native { name: "texture", variant: "f32", reset: texture_reset, update: texture_update, frame: texture_f },
    Native { name: "rain", variant: "q16", reset: rain_reset, update: rain_update, frame: rain_f },
    Native { name: "rain_naive", variant: "f32", reset: nop_reset, update: nop_update, frame: rain_naive_f },
];

/// Run one native frame (update + the LED sweep) and return (update, shade) cycles.
///
/// # Safety
/// Single-threaded bench.
pub unsafe fn native_frame(nat: &Native, fr: &Frame, n: usize, cyc: fn() -> u32) -> (u32, u32) {
    let t0 = cyc();
    (nat.update)(fr);
    let t1 = cyc();
    (nat.frame)(fr, n);
    let t2 = cyc();
    (t1.wrapping_sub(t0), t2.wrapping_sub(t1))
}
