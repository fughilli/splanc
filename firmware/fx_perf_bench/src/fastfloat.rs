//! Prototype fast soft-float for RV32IMAC (docs/design/fx-perf-study.md, Q4):
//! IEEE-754 binary32 add/mul with round-to-nearest-even on a normal-operand /
//! normal-result fast path written for a 32-bit integer core, falling back to the
//! toolchain routine (`a + b` / `a * b`, i.e. the C6 ROM libgcc) for zeros,
//! subnormals, infinities, NaNs and over/underflow. Bit-exact with IEEE by
//! construction (checked exhaustively-ish on the host against hardware floats).

#[inline(always)]
fn slow_add(a: f32, b: f32) -> f32 {
    core::hint::black_box(a) + b
}
#[inline(always)]
fn slow_mul(a: f32, b: f32) -> f32 {
    core::hint::black_box(a) * b
}

#[inline]
pub fn fmul(a: f32, b: f32) -> f32 {
    let (ia, ib) = (a.to_bits(), b.to_bits());
    let ea = (ia >> 23) & 0xff;
    let eb = (ib >> 23) & 0xff;
    if ea.wrapping_sub(1) >= 254 || eb.wrapping_sub(1) >= 254 {
        return slow_mul(a, b);
    }
    let sign = (ia ^ ib) & 0x8000_0000;
    let ma = (ia & 0x7f_ffff) | 0x80_0000;
    let mb = (ib & 0x7f_ffff) | 0x80_0000;
    let p = ma as u64 * mb as u64; // 47 or 48 bits
    let mut e = ea as i32 + eb as i32 - 127;
    let (mut m, rest, half);
    if p >> 47 != 0 {
        m = (p >> 24) as u32;
        rest = (p & 0xff_ffff) as u32;
        half = 0x80_0000u32;
        e += 1;
    } else {
        m = (p >> 23) as u32;
        rest = (p & 0x7f_ffff) as u32;
        half = 0x40_0000u32;
    }
    if rest > half || (rest == half && m & 1 == 1) {
        m += 1;
        if m == 0x100_0000 {
            m >>= 1;
            e += 1;
        }
    }
    if e <= 0 || e >= 255 {
        return slow_mul(a, b);
    }
    f32::from_bits(sign | ((e as u32) << 23) | (m & 0x7f_ffff))
}

#[inline]
pub fn fadd(a: f32, b: f32) -> f32 {
    let (mut ia, mut ib) = (a.to_bits(), b.to_bits());
    // order by magnitude: |a| >= |b|
    if (ib & 0x7fff_ffff) > (ia & 0x7fff_ffff) {
        core::mem::swap(&mut ia, &mut ib);
    }
    let ea = (ia >> 23) & 0xff;
    let eb = (ib >> 23) & 0xff;
    if ea.wrapping_sub(1) >= 254 || eb.wrapping_sub(1) >= 254 {
        return slow_add(a, b);
    }
    let sign = ia & 0x8000_0000;
    // 24-bit mantissas with 3 guard bits (guard, round, sticky).
    let ma = ((ia & 0x7f_ffff) | 0x80_0000) << 3;
    let mut mb = ((ib & 0x7f_ffff) | 0x80_0000) << 3;
    let d = ea - eb;
    if d != 0 {
        if d >= 27 {
            mb = 1; // pure sticky
        } else {
            let lost = mb & ((1 << d) - 1);
            mb = (mb >> d) | (lost != 0) as u32;
        }
    }
    let mut e = ea as i32;
    let mut m;
    if (ia ^ ib) & 0x8000_0000 == 0 {
        m = ma + mb; // < 2^28
        if m >> 27 != 0 {
            m = (m >> 1) | (m & 1);
            e += 1;
        }
    } else {
        m = ma - mb;
        if m == 0 {
            return slow_add(a, b); // exact cancellation: +0 (sign rules) via the slow path
        }
        let lz = m.leading_zeros() - 5; // normalise so bit 26 is set
        m <<= lz;
        e -= lz as i32;
    }
    // round to nearest even on the 3 guard bits
    let g = m & 7;
    m >>= 3;
    if g > 4 || (g == 4 && m & 1 == 1) {
        m += 1;
        if m == 0x100_0000 {
            m >>= 1;
            e += 1;
        }
    }
    if e <= 0 || e >= 255 {
        return slow_add(a, b);
    }
    f32::from_bits(sign | ((e as u32) << 23) | (m & 0x7f_ffff))
}

#[cfg(test)]
mod t {
    use super::*;
    fn rnd(s: &mut u64) -> u32 {
        *s ^= *s << 13;
        *s ^= *s >> 7;
        *s ^= *s << 17;
        (*s >> 16) as u32
    }
    #[test]
    fn exact() {
        let mut s = 0x1234_5678_9abc_def0u64;
        let mut n = 0u64;
        for i in 0..4_000_000u64 {
            // mix of fully random bits and "LED-range" values
            let (a, b) = if i % 2 == 0 {
                (f32::from_bits(rnd(&mut s)), f32::from_bits(rnd(&mut s)))
            } else {
                let x = (rnd(&mut s) as f32) / 4.0e9 * 8.0 - 4.0;
                let y = (rnd(&mut s) as f32) / 4.0e9 * 8.0 - 4.0;
                (x, y)
            };
            for (r, w) in [(fadd(a, b), a + b), (fmul(a, b), a * b)] {
                if r.to_bits() != w.to_bits() && !(r.is_nan() && w.is_nan()) {
                    panic!("{a:e} {b:e}: {r:e} vs {w:e}");
                }
            }
            n += 1;
        }
        println!("{n} pairs exact");
    }
}
