//! Micro-benchmarks that price the VM's building blocks on the C6 — the terms
//! the study's gap decomposition is built from.
//!
//! 1. Soft-float primitives (compiler-builtins `__addsf3`/`__mulsf3`/…): the
//!    raw cost of one f32 op on the FPU-less core, vs the integer equivalent.
//! 2. fx_vm's math helpers called natively (`sinf`, `atan2f`, `hash3`, …) and
//!    their fixed-point twins (`sin_fix`, `atan2_fix`, `sqrt_fix`).
//! 3. Hand-assembled `.fxb` programs that isolate the interpreter itself: one
//!    `run()` invocation, a no-op opcode (pure dispatch), operand-stack traffic
//!    per slot, and float vs integer arithmetic opcodes.

use core::hint::black_box;

use ledmapper_fx_vm::{
    atan2_fix, atan2f, expf, floorf, fractf, hash1, hash3, hsv2rgb, logf, powf, sin_fix, sinf, sqrt_fix, sqrtf,
    Frame, Led, Op, Program, Vm,
};

use crate::device::log_line;
use crate::engine::budget;

const N: u32 = 2000;

/// Cycles per iteration of `f` over N iterations, minus an empty loop.
#[inline(never)]
fn per_iter(cyc: fn() -> u32, mut f: impl FnMut(u32) -> u32) -> u32 {
    let mut acc = 0u32;
    let t0 = cyc();
    for i in 0..N {
        acc = acc.wrapping_add(f(black_box(i)));
    }
    let t = cyc().wrapping_sub(t0);
    black_box(acc);
    t / N
}

/// Precomputed float inputs (so the timed loop body is ONLY the op under test —
/// computing `0.37 + i*1e-4` inline would itself cost three soft-float calls).
static mut INPUTS: [f32; 64] = [0.0; 64];

fn fx(i: u32) -> f32 {
    unsafe { black_box((*core::ptr::addr_of!(INPUTS))[(i & 63) as usize]) }
}

pub fn soft_float(cyc: fn() -> u32) {
    unsafe {
        for (k, x) in (*core::ptr::addr_of_mut!(INPUTS)).iter_mut().enumerate() {
            *x = 0.37 + k as f32 * 0.0137;
        }
    }
    // Baseline = the loop + the input load, so each row is the op alone.
    let base = per_iter(cyc, |i| fx(i).to_bits());
    let r = |name: &str, c: u32| log_line(format_args!("micro prim {name} {} cyc", c.saturating_sub(base)));
    r("loop", base);
    r("i32_add", per_iter(cyc, |i| black_box(i).wrapping_add(black_box(7))));
    r("i32_mul", per_iter(cyc, |i| black_box(i).wrapping_mul(black_box(12345))));
    r("i64_mulfix", per_iter(cyc, |i| ((black_box(i) as i64 * black_box(70000i64)) >> 16) as u32));
    r("i32_div", per_iter(cyc, |i| black_box(1_000_000u32) / (black_box(i) | 1)));
    let a = 1.2345f32;
    r("f32_add", per_iter(cyc, |i| (fx(i) + black_box(a)).to_bits()));
    r("f32_sub", per_iter(cyc, |i| (fx(i) - black_box(a)).to_bits()));
    r("f32_mul", per_iter(cyc, |i| (fx(i) * black_box(a)).to_bits()));
    r("ff_add", per_iter(cyc, |i| crate::fastfloat::fadd(fx(i), black_box(a)).to_bits()));
    r("ff_mul", per_iter(cyc, |i| crate::fastfloat::fmul(fx(i), black_box(a)).to_bits()));
    r("f32_div", per_iter(cyc, |i| (fx(i) / black_box(a)).to_bits()));
    r("f32_lt", per_iter(cyc, |i| (fx(i) < black_box(a)) as u32));
    r("f32_mul+to_i32", per_iter(cyc, |i| (fx(i) * black_box(300.0f32)) as i32 as u32));
    r("i32_to_f32", per_iter(cyc, |i| (black_box(i) as i32 as f32).to_bits()));
    r("vm_sinf", per_iter(cyc, |i| sinf(fx(i)).to_bits()));
    r("vm_sqrtf", per_iter(cyc, |i| sqrtf(fx(i)).to_bits()));
    r("vm_atan2f", per_iter(cyc, |i| atan2f(fx(i), black_box(0.7)).to_bits()));
    r("vm_expf", per_iter(cyc, |i| expf(fx(i)).to_bits()));
    r("vm_logf", per_iter(cyc, |i| logf(fx(i)).to_bits()));
    r("vm_powf", per_iter(cyc, |i| powf(fx(i), black_box(2.5)).to_bits()));
    r("vm_floorf", per_iter(cyc, |i| floorf(fx(i)).to_bits()));
    r("vm_fractf", per_iter(cyc, |i| fractf(fx(i)).to_bits()));
    r("vm_hash1", per_iter(cyc, |i| hash1(fx(i)).to_bits()));
    r("vm_hash3", per_iter(cyc, |i| hash3(fx(i), black_box(0.5), black_box(0.25)).to_bits()));
    r("vm_hsv2rgb", per_iter(cyc, |i| hsv2rgb(fx(i), black_box(0.8), black_box(0.9)).0.to_bits()));
    r("fix_sin", per_iter(cyc, |i| sin_fix(black_box(i as i32 * 37), 16) as u32));
    r("fix_atan2", per_iter(cyc, |i| atan2_fix(black_box(i as i32 * 37 + 5), black_box(40000), 16) as u32));
    r("fix_sqrt", per_iter(cyc, |i| sqrt_fix(black_box(i as i32 * 37 + 5), 16) as u32));
}

// --- hand-assembled programs ------------------------------------------------

const CODE_MAX: usize = 1400;
static mut PROG: [u8; 18 + 16 + CODE_MAX] = [0; 18 + 16 + CODE_MAX];

/// Build a shade-only `.fxb`: 4 consts (0.25, 0.5, 2 (int), 3 (int)), body
/// `reps` × `unit`, then `PushConst×3; Ret 3`.
unsafe fn build(unit: &[u8], reps: usize) -> Option<&'static [u8]> {
    let p = &mut *core::ptr::addr_of_mut!(PROG);
    let tail = [Op::PushConst as u8, 0, 0, Op::PushConst as u8, 0, 0, Op::PushConst as u8, 0, 0, Op::Ret as u8, 3];
    let code_len = unit.len() * reps + tail.len();
    if code_len > CODE_MAX {
        return None;
    }
    p[0..4].copy_from_slice(b"FXB1");
    p[4] = 1; // version
    p[5] = 0; // flags
    p[6] = 0; // n_state
    p[7] = 0; // n_uniform
    p[8..10].copy_from_slice(&0u16.to_le_bytes()); // manifest
    p[10..12].copy_from_slice(&4u16.to_le_bytes()); // consts
    p[12..14].copy_from_slice(&(code_len as u16).to_le_bytes());
    p[14..16].copy_from_slice(&0xffffu16.to_le_bytes()); // no update
    p[16..18].copy_from_slice(&0u16.to_le_bytes()); // shade at 0
    let consts: [u32; 4] = [0.25f32.to_bits(), 0.5f32.to_bits(), 2, 3];
    for (k, c) in consts.iter().enumerate() {
        p[18 + k * 4..22 + k * 4].copy_from_slice(&c.to_le_bytes());
    }
    let mut o = 34;
    for _ in 0..reps {
        p[o..o + unit.len()].copy_from_slice(unit);
        o += unit.len();
    }
    p[o..o + tail.len()].copy_from_slice(&tail);
    Some(&p[..o + tail.len()])
}

static mut VMM: Option<Vm> = None;

/// Cycles per shade() invocation of `fxb`, min over 3 sweeps of 64 LEDs.
unsafe fn shade_cycles(fxb: &[u8], cyc: fn() -> u32) -> u32 {
    let prog = Program::parse(fxb).unwrap();
    let vm = (*core::ptr::addr_of_mut!(VMM)).get_or_insert_with(Vm::default);
    let fr = Frame { time: 1.0, dt: 0.033, led_count: 64, ..Default::default() };
    let mut led = Led::default();
    let b = budget();
    let mut best = u32::MAX;
    for _ in 0..3 {
        let t0 = cyc();
        for i in 0..64u32 {
            led.idx = i;
            black_box(vm.run_shade_bounded(&prog, &fr, &led, &b));
        }
        best = best.min(cyc().wrapping_sub(t0) / 64);
    }
    best
}

pub unsafe fn vm_ops(cyc: fn() -> u32) {
    let empty = shade_cycles(build(&[], 0).unwrap(), cyc);
    log_line(format_args!("micro vm run_empty {empty} cyc/invocation (3 PushConst + Ret + epilogue)"));
    let pc = Op::PushConst as u8;
    // (name, unit bytes, ops per unit, reps)
    let cases: &[(&str, &[u8], u32, usize)] = &[
        ("pop0 (pure dispatch)", &[Op::Pop as u8, 0], 1, 200),
        ("pushconst+pop1", &[pc, 0, 0, Op::Pop as u8, 1], 2, 150),
        ("storelocal1+loadlocal1", &[pc, 0, 0, Op::StoreLocal as u8, 0, 1, Op::LoadLocal as u8, 0, 1, Op::Pop as u8, 1], 4, 100),
        ("loadlocal4+pop4 (after store)", &[pc, 0, 0, pc, 0, 0, pc, 0, 0, pc, 0, 0, Op::StoreLocal as u8, 0, 4, Op::LoadLocal as u8, 0, 4, Op::Pop as u8, 4], 7, 50),
        ("f32 add", &[pc, 0, 0, pc, 1, 0, Op::Add as u8, 1, Op::Pop as u8, 1], 4, 100),
        ("f32 mul", &[pc, 0, 0, pc, 1, 0, Op::Mul as u8, 1, Op::Pop as u8, 1], 4, 100),
        ("f32 div", &[pc, 0, 0, pc, 1, 0, Op::Div as u8, 1, Op::Pop as u8, 1], 4, 100),
        ("i32 addi", &[pc, 2, 0, pc, 3, 0, Op::AddI as u8, Op::Pop as u8, 1], 4, 100),
        ("q16 mulfix", &[pc, 2, 0, pc, 3, 0, Op::MulFix as u8, Op::Pop as u8, 1], 4, 100),
        ("f32 sin (UnMath)", &[pc, 0, 0, Op::UnMath as u8, 0, 1, Op::Pop as u8, 1], 3, 100),
        ("q16 sin (SinFix)", &[pc, 2, 0, Op::SinFix as u8, 16, Op::Pop as u8, 1], 3, 100),
        ("vec3 f32 mul", &[pc, 0, 0, pc, 0, 0, pc, 0, 0, pc, 1, 0, pc, 1, 0, pc, 1, 0, Op::Mul as u8, 3, Op::Pop as u8, 3], 8, 40),
        ("loadctx led.pos", &[Op::LoadCtx as u8, 3, Op::Pop as u8, 3], 2, 100),
        ("f32 hash3", &[pc, 0, 0, pc, 1, 0, pc, 0, 0, Op::Hash3 as u8, Op::Pop as u8, 1], 5, 80),
    ];
    for (name, unit, ops, reps) in cases {
        if let Some(fxb) = build(unit, *reps) {
            let c = shade_cycles(fxb, cyc);
            let per_unit = c.saturating_sub(empty) / *reps as u32;
            log_line(format_args!(
                "micro vm {name}: {per_unit} cyc/unit ({ops} ops) = {} cyc/op",
                per_unit / ops
            ));
        }
    }
}
