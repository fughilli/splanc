//! The VM never panics (fx-perf-study R3): any `.fxb` that parses runs to an
//! [`Outcome`] (a malformed program ends in `Outcome::Fault`). The firmware's
//! panic handler would otherwise reboot the fixture mid-show, and before R3 a
//! single miscompiled `clamp(vec3, 0.0, 1.0)` underflowed the operand stack and
//! hung the device.
//!
//! Host tests build with overflow checks on, so this is stricter than the
//! device (which wraps): an arithmetic overflow panic here is a finding too.

use ledmapper_fx_vm::*;

fn fxb(flags: u8, update: u16, shade: u16, consts: &[f32], code: &[u8], buffers: &[(u8, u8, u8, u16, u16)]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&MAGIC);
    b.push(FORMAT_VERSION);
    b.push(flags | if buffers.is_empty() { 0 } else { FLAG_BUFFERS });
    b.push(8); // n_state
    b.push(4); // n_uniform_slots
    b.extend_from_slice(&0u16.to_le_bytes());
    b.extend_from_slice(&(consts.len() as u16).to_le_bytes());
    b.extend_from_slice(&(code.len() as u16).to_le_bytes());
    b.extend_from_slice(&update.to_le_bytes());
    b.extend_from_slice(&shade.to_le_bytes());
    for c in consts {
        b.extend_from_slice(&c.to_le_bytes());
    }
    b.extend_from_slice(code);
    if !buffers.is_empty() {
        b.push(buffers.len() as u8);
        for &(kind, elem, comp, w, h) in buffers {
            b.extend_from_slice(&[kind, elem, comp]);
            b.extend_from_slice(&w.to_le_bytes());
            b.extend_from_slice(&h.to_le_bytes());
        }
    }
    b
}

/// xorshift32: deterministic, no deps.
struct Rng(u32);
impl Rng {
    fn next(&mut self) -> u32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x
    }
    fn below(&mut self, n: u32) -> u32 {
        self.next() % n.max(1)
    }
}

const LAST_OP: u8 = Op::I2cRead as u8;

/// A random operand byte: mostly the small values real programs use (lane
/// counts, fracs, slots), sometimes anything.
fn operand(r: &mut Rng) -> u8 {
    match r.below(8) {
        0 => r.next() as u8,
        1 => [6u8, 14, 16, 30, 31, 32, 63, 64, 255][r.below(9) as usize],
        _ => r.below(5) as u8,
    }
}

fn random_code(r: &mut Rng, len: usize) -> Vec<u8> {
    let mut c = Vec::with_capacity(len + 64);
    // Half the programs start with a run of pushes so the deeper (vector,
    // n-lane) opcodes see a populated stack instead of faulting at once.
    if r.below(2) == 0 {
        for _ in 0..4 + r.below(24) {
            match r.below(3) {
                0 => c.extend_from_slice(&[Op::PushConst as u8, r.below(8) as u8, 0]),
                1 => c.extend_from_slice(&[Op::LoadCtx as u8, r.below(24) as u8]),
                _ => c.extend_from_slice(&[Op::LoadUniform as u8, r.below(4) as u8, 1 + r.below(4) as u8]),
            }
        }
    }
    while c.len() < len {
        // Mostly real opcodes (incl. JitCall with no table installed), a few
        // invalid bytes.
        let op = if r.below(32) == 0 { r.next() as u8 } else { r.below(LAST_OP as u32 + 1) as u8 };
        c.push(op);
        // Pushes keep the stack fed so deeper ops are reached; operands follow.
        for _ in 0..r.below(6) {
            c.push(operand(r));
        }
    }
    c
}

fn random_f32(r: &mut Rng) -> f32 {
    match r.below(6) {
        0 => f32::from_bits(r.next()), // NaN, inf, subnormals, ...
        1 => [0.0, -0.0, 1.0, -1.0, f32::MAX, f32::MIN, f32::INFINITY, f32::NAN][r.below(8) as usize],
        2 => f32::from_bits(r.below(70000)), // small ints / fixed raws
        3 => f32::from_bits((r.next() as i32 >> r.below(31)) as u32),
        _ => (r.next() as i32 as f32) / 65536.0,
    }
}

/// Per-outcome counts + total opcodes retired, so the test can check the
/// generator actually reaches deep into programs (not just faulting at op 1).
#[derive(Default)]
struct Stats {
    ok: u32,
    fault: u32,
    other: u32,
    instrs: u64,
}

fn exercise(buf: &[u8], r: &mut Rng, arena: &mut [u8], st: &mut Stats) {
    let Ok(prog) = Program::parse(buf) else { return };
    let mut vm = Vm::new();
    vm.set_arena(arena);
    for s in 0..4 {
        let vals = [random_f32(r), random_f32(r), random_f32(r), random_f32(r)];
        vm.set_uniform(s, &vals);
    }
    let budget = Budget::instructions(3000);
    let frame =
        Frame { time: random_f32(r), dt: 0.033, frame: r.next(), led_count: r.below(600), ..Default::default() };
    let _ = vm.run_update_bounded(&prog, &frame, &budget);
    for _ in 0..3 {
        let led = Led {
            pos: [random_f32(r), random_f32(r), random_f32(r)],
            idx: r.next(),
            seg: r.next() as i32 >> 20,
            ..Default::default()
        };
        let (_, oc, k) = vm.run_shade_counted(&prog, &frame, &led, &budget);
        st.instrs += k.instrs as u64;
        match oc {
            Outcome::Ok => st.ok += 1,
            Outcome::Fault => st.fault += 1,
            _ => st.other += 1,
        }
    }
}

#[test]
fn random_programs_never_panic() {
    let mut arena = vec![0u8; 4096];
    let mut st = Stats::default();
    let cases: u32 = std::env::var("FX_FUZZ_CASES").ok().and_then(|v| v.parse().ok()).unwrap_or(60_000);
    let mut r = Rng(std::env::var("FX_FUZZ_SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(0x9e37_79b9));
    for case in 0..cases {
        let len = 1 + r.below(64) as usize;
        let code = random_code(&mut r, len);
        let consts: Vec<f32> = (0..r.below(6)).map(|_| random_f32(&mut r)).collect();
        let buffers: Vec<(u8, u8, u8, u16, u16)> = (0..r.below(3))
            .map(|_| (r.below(3) as u8, r.below(5) as u8, r.below(6) as u8, r.below(9) as u16, r.below(9) as u16))
            .collect();
        let shade = if r.below(8) == 0 { r.below(code.len() as u32 + 4) as u16 } else { 0 };
        let update = if r.below(2) == 0 { NO_ENTRY } else { r.below(code.len() as u32) as u16 };
        let buf = fxb(r.below(32) as u8, update, shade, &consts, &code, &buffers);
        let seed = r.0;
        let res = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let mut r2 = Rng(seed | 1);
            exercise(&buf, &mut r2, &mut arena, &mut st);
        }));
        assert!(res.is_ok(), "case {case} panicked; fxb = {buf:02x?}");
    }
    let runs = st.ok + st.fault + st.other;
    println!(
        "shade runs {runs}: ok {} fault {} budget/timeout {}; {} ops retired",
        st.ok, st.fault, st.other, st.instrs
    );
    assert!(st.ok > runs / 20 && st.fault > runs / 20, "generator lost coverage");
    assert!(st.instrs > runs as u64 * 4, "programs end too early to exercise the VM");
}

#[test]
fn stack_underflow_faults_instead_of_panicking() {
    // The #338 miscompile: `clamp(vec3, 0.0, 1.0)` emitted Clamp n=3 over 5
    // slots (vec3 + two scalars), so `sp - 3*n` underflowed.
    #[rustfmt::skip]
    let code = [
        Op::PushConst as u8, 0, 0, Op::PushConst as u8, 0, 0, Op::PushConst as u8, 0, 0,
        Op::PushConst as u8, 0, 0, Op::PushConst as u8, 1, 0,
        Op::Clamp as u8, 3,
        Op::Ret as u8, 3,
    ];
    let buf = fxb(0, NO_ENTRY, 0, &[0.5, 1.0], &code, &[]);
    let prog = Program::parse(&buf).unwrap();
    let mut vm = Vm::new();
    let (rgb, oc) = vm.run_shade_bounded(&prog, &Frame::default(), &Led::default(), &Budget::default());
    assert_eq!(oc, Outcome::Fault);
    assert_eq!(rgb, (0, 0, 0));
    assert!(oc.timed_out(), "callers treat a fault like a cancelled invocation");
}

#[test]
fn pop_underflow_and_bad_opcode_fault() {
    let buf = fxb(0, NO_ENTRY, 0, &[], &[Op::Neg as u8, 1, Op::Ret as u8, 3], &[]);
    let prog = Program::parse(&buf).unwrap();
    let (_, oc) = Vm::new().run_shade_bounded(&prog, &Frame::default(), &Led::default(), &Budget::default());
    assert_eq!(oc, Outcome::Fault, "Neg on an empty stack");

    let buf = fxb(0, NO_ENTRY, 0, &[], &[Op::AddI as u8, Op::Ret as u8, 3], &[]);
    let prog = Program::parse(&buf).unwrap();
    let (_, oc) = Vm::new().run_shade_bounded(&prog, &Frame::default(), &Led::default(), &Budget::default());
    assert_eq!(oc, Outcome::Fault, "AddI pops past the bottom");

    let buf = fxb(0, NO_ENTRY, 0, &[], &[0xFE, Op::Ret as u8, 3], &[]);
    let prog = Program::parse(&buf).unwrap();
    let (_, oc) = Vm::new().run_shade_bounded(&prog, &Frame::default(), &Led::default(), &Budget::default());
    assert_eq!(oc, Outcome::Fault, "unknown opcode");

    // Truncated operand at the end of the code: reads 0, then stops at code end.
    let buf = fxb(0, NO_ENTRY, 0, &[], &[Op::PushConst as u8, 7], &[]);
    let prog = Program::parse(&buf).unwrap();
    let (_, oc) = Vm::new().run_shade_bounded(&prog, &Frame::default(), &Led::default(), &Budget::default());
    assert_eq!(oc, Outcome::Ok);
}
