//! Host tests for the effects VM: hand-assembled `.fxb` → expected LED colors.

use ledmapper_fx_vm::*;

/// Minimal `.fxb` assembler for tests.
fn fxb(n_state: u8, n_uniform_slots: u8, update: u16, shade: u16, consts: &[f32], code: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&MAGIC);
    b.push(1); // version
    b.push(0); // flags
    b.push(n_state);
    b.push(n_uniform_slots);
    b.extend_from_slice(&0u16.to_le_bytes()); // manifest_len
    b.extend_from_slice(&(consts.len() as u16).to_le_bytes());
    b.extend_from_slice(&(code.len() as u16).to_le_bytes());
    b.extend_from_slice(&update.to_le_bytes());
    b.extend_from_slice(&shade.to_le_bytes());
    for c in consts {
        b.extend_from_slice(&c.to_le_bytes());
    }
    b.extend_from_slice(code);
    b
}

#[test]
fn parses_and_shades_uniform_const_ctx() {
    // shade: return vec3(uniform0, const0(=0.5), led.pos.x)
    #[rustfmt::skip]
    let code = [
        Op::LoadUniform as u8, 0, 1,      // push uniforms[0]
        Op::PushConst as u8, 0, 0,        // push consts[0] = 0.5
        Op::LoadCtx as u8, C_LED_POS,     // push led.pos (3)
        Op::Swizzle as u8, 3, 1, 0,       // -> .x
        Op::Ret as u8, 3,
    ];
    let buf = fxb(0, 1, NO_ENTRY, 0, &[0.5], &code);
    let prog = Program::parse(&buf).expect("parse");
    let mut vm = Vm::new();
    vm.set_uniform(0, &[0.8]);
    let frame = Frame { led_count: 10, ..Default::default() };
    let led = Led { pos: [0.4, 0.1, 0.2], idx: 0, ..Default::default() };
    let (r, g, b) = vm.run_shade(&prog, &frame, &led);
    assert_eq!(r, 204); // 0.8 * 255
    assert_eq!(g, 127); // 0.5 * 255 -> 127 (trunc)
    assert_eq!(b, 102); // 0.4 * 255
}

#[test]
fn update_state_and_shade_reads_it() {
    // state phase; update: phase = phase + 0.25 ; shade: return vec3(phase,0,0)
    #[rustfmt::skip]
    let update = [
        Op::LoadState as u8, 0, 1,        // phase
        Op::PushConst as u8, 0, 0,        // 0.25
        Op::Add as u8, 1,
        Op::StoreState as u8, 0, 1,
        Op::Ret as u8, 0,
    ];
    let shade_off = update.len();
    #[rustfmt::skip]
    let shade = [
        Op::LoadState as u8, 0, 1,        // phase
        Op::PushConst as u8, 1, 0,        // 0.0
        Op::PushConst as u8, 1, 0,        // 0.0
        Op::Ret as u8, 3,
    ];
    let mut code = Vec::new();
    code.extend_from_slice(&update);
    code.extend_from_slice(&shade);
    let buf = fxb(1, 0, 0, shade_off as u16, &[0.25, 0.0], &code);
    let prog = Program::parse(&buf).expect("parse");
    let mut vm = Vm::new();
    let frame = Frame::default();
    let led = Led::default();
    // two frames -> phase = 0.5
    vm.run_update(&prog, &frame);
    vm.run_update(&prog, &frame);
    let (r, _g, _b) = vm.run_shade(&prog, &frame, &led);
    assert_eq!(r, 127); // 0.5 * 255
}

#[test]
fn indexed_state_store_load_and_clamp() {
    // update: xs[0]=0.2, xs[1]=0.7, xs[2]=0.3 (dynamic StoreStateIdx over an
    // int index built via F2I). shade: return vec3(xs[int(led.idx)], 0, 0).
    // consts: [0]=0.0 [1]=1.0 [2]=2.0 [3]=0.2 [4]=0.7 [5]=0.3
    let write = |ci: u8, cv: u8| {
        [
            Op::PushConst as u8, ci, 0,  // index (float)
            Op::F2I as u8,               // -> int
            Op::PushConst as u8, cv, 0,  // value
            Op::StoreStateIdx as u8, 0, 1, 0, 1, 3, // base,stride,off,n,count
        ]
    };
    let mut update = Vec::new();
    update.extend_from_slice(&write(0, 3));
    update.extend_from_slice(&write(1, 4));
    update.extend_from_slice(&write(2, 5));
    update.extend_from_slice(&[Op::Ret as u8, 0]);
    let shade_off = update.len();
    #[rustfmt::skip]
    let shade = [
        Op::LoadCtx as u8, C_LED_IDX,          // float led.idx
        Op::F2I as u8,                         // -> int index
        Op::LoadStateIdx as u8, 0, 1, 0, 1, 3, // xs[idx] (clamped to 0..2)
        Op::PushConst as u8, 0, 0,             // 0.0
        Op::PushConst as u8, 0, 0,             // 0.0
        Op::Ret as u8, 3,
    ];
    let mut code = update.clone();
    code.extend_from_slice(&shade);
    let buf = fxb(3, 0, 0, shade_off as u16, &[0.0, 1.0, 2.0, 0.2, 0.7, 0.3], &code);
    let prog = Program::parse(&buf).expect("parse");
    let mut vm = Vm::new();
    let frame = Frame::default();
    vm.run_update(&prog, &frame);
    // idx 1 -> xs[1] = 0.7
    assert_eq!(vm.run_shade(&prog, &frame, &Led { idx: 1, ..Default::default() }).0, 178);
    // idx 0 -> xs[0] = 0.2
    assert_eq!(vm.run_shade(&prog, &frame, &Led { idx: 0, ..Default::default() }).0, 51);
    // idx 9 (out of range) clamps to the last element xs[2] = 0.3
    assert_eq!(vm.run_shade(&prog, &frame, &Led { idx: 9, ..Default::default() }).0, 76);
}

#[test]
fn math_and_palette() {
    // shade: return palette(2 /*rainbow*/, fract(led.pos.x))
    #[rustfmt::skip]
    let code = [
        Op::LoadCtx as u8, C_LED_POS,
        Op::Swizzle as u8, 3, 1, 0,        // .x
        Op::UnMath as u8, F_FRACT, 1,
        Op::Palette as u8, 2,              // rainbow -> vec3
        Op::Ret as u8, 3,
    ];
    let buf = fxb(0, 0, NO_ENTRY, 0, &[], &code);
    let prog = Program::parse(&buf).expect("parse");
    let vm = Vm::new();
    let frame = Frame::default();
    // t=0 rainbow (hsv h=0) => pure red
    let led = Led { pos: [0.0, 0.0, 0.0], ..Default::default() };
    let (r, g, b) = vm.run_shade(&prog, &frame, &led);
    assert!(r > 200 && g < 40 && b < 40, "expected red, got {r},{g},{b}");
}

#[test]
fn branch_control_flow() {
    // shade: if (uniform0 > 0.5) return vec3(1,0,0); else return vec3(0,1,0);
    // layout: [cmp/br][red ret][green ret]
    // We compute the branch offsets by hand.
    #[rustfmt::skip]
    let red = [
        Op::PushConst as u8, 0, 0, // 1.0
        Op::PushConst as u8, 1, 0, // 0.0
        Op::PushConst as u8, 1, 0, // 0.0
        Op::Ret as u8, 3,
    ];
    #[rustfmt::skip]
    let green = [
        Op::PushConst as u8, 1, 0, // 0.0
        Op::PushConst as u8, 0, 0, // 1.0
        Op::PushConst as u8, 1, 0, // 0.0
        Op::Ret as u8, 3,
    ];
    // prologue: load u0, push 0.5, Cmp gt -> bool; BrFalse -> green
    let prologue_len = 3 + 3 + 2 + 3; // LoadUniform(3) PushConst(3) Cmp(2) BrFalse(3)
    let br_to_green = red.len() as i16; // after BrFalse, skip `red` to reach green
    #[rustfmt::skip]
    let mut code = vec![
        Op::LoadUniform as u8, 0, 1,
        Op::PushConst as u8, 2, 0,     // 0.5
        Op::Cmp as u8, 2,              // gt
        Op::BrFalse as u8,
    ];
    code.extend_from_slice(&br_to_green.to_le_bytes());
    assert_eq!(code.len(), prologue_len);
    code.extend_from_slice(&red);
    code.extend_from_slice(&green);
    let buf = fxb(0, 1, NO_ENTRY, 0, &[1.0, 0.0, 0.5], &code);
    let prog = Program::parse(&buf).expect("parse");
    let frame = Frame::default();
    let led = Led::default();

    let mut vm = Vm::new();
    vm.set_uniform(0, &[0.9]); // > 0.5 -> red
    assert_eq!(vm.run_shade(&prog, &frame, &led), (255, 0, 0));

    vm.set_uniform(0, &[0.1]); // <= 0.5 -> green
    assert_eq!(vm.run_shade(&prog, &frame, &led), (0, 255, 0));
}

#[test]
fn budget_trips_on_pathological_loop() {
    // shade: `for (;;) {}` — an unconditional back-branch with no exit. Layout:
    //   [0] Jmp -3   (rel is applied AFTER reading the 2 offset bytes at pc=1..3,
    //                 so pc=3 + (-3) = 0: an infinite self-loop)
    // The VM must trip the instruction budget deterministically rather than hang.
    #[rustfmt::skip]
    let mut code = vec![Op::Jmp as u8];
    code.extend_from_slice(&(-3i16).to_le_bytes());
    let buf = fxb(0, 0, NO_ENTRY, 0, &[], &code);
    let prog = Program::parse(&buf).expect("parse");
    let vm = Vm::new();
    let frame = Frame::default();
    let led = Led::default();

    // A tiny budget trips fast and deterministically.
    let (rgb, outcome) = vm.run_shade_bounded(&prog, &frame, &led, &Budget::instructions(1000));
    assert_eq!(outcome, Outcome::Budget, "runaway loop must exhaust the budget");
    assert!(outcome.timed_out());
    assert_eq!(rgb, (0, 0, 0), "a cancelled shade yields black");

    // Determinism: the same program + budget always stops the same way. And a
    // 10x budget still trips (the loop never exits on its own).
    let (_r2, o2) = vm.run_shade_bounded(&prog, &frame, &led, &Budget::instructions(1000));
    assert_eq!(o2, Outcome::Budget);
    let (_r3, o3) = vm.run_shade_bounded(&prog, &frame, &led, &Budget::instructions(10_000));
    assert_eq!(o3, Outcome::Budget);
}

#[test]
fn budget_leaves_normal_programs_untouched() {
    // A normal, short shade completes well under the budget → Outcome::Ok.
    #[rustfmt::skip]
    let code = [
        Op::PushConst as u8, 0, 0, // 1.0
        Op::PushConst as u8, 1, 0, // 0.0
        Op::PushConst as u8, 1, 0, // 0.0
        Op::Ret as u8, 3,
    ];
    let buf = fxb(0, 0, NO_ENTRY, 0, &[1.0, 0.0], &code);
    let prog = Program::parse(&buf).expect("parse");
    let vm = Vm::new();
    let frame = Frame::default();
    let led = Led::default();
    let (rgb, outcome) = vm.run_shade_bounded(&prog, &frame, &led, &Budget::instructions(1000));
    assert_eq!(outcome, Outcome::Ok);
    assert_eq!(rgb, (255, 0, 0));
}

#[test]
fn deadline_flag_cancels_execution() {
    // Same infinite loop, but here a pre-raised wall-time deadline flag (as a
    // hardware timer would set) cancels it → Outcome::Timeout.
    use core::sync::atomic::AtomicBool;
    #[rustfmt::skip]
    let mut code = vec![Op::Jmp as u8];
    code.extend_from_slice(&(-3i16).to_le_bytes());
    let buf = fxb(0, 0, NO_ENTRY, 0, &[], &code);
    let prog = Program::parse(&buf).expect("parse");
    let vm = Vm::new();
    let frame = Frame::default();
    let led = Led::default();

    let flag = AtomicBool::new(true); // deadline already passed
    let budget = Budget { instructions: 1_000_000, deadline: Some(&flag as *const _) };
    let (_rgb, outcome) = vm.run_shade_bounded(&prog, &frame, &led, &budget);
    assert_eq!(outcome, Outcome::Timeout, "raised deadline flag must cancel");
}

#[test]
fn rejects_bad_magic() {
    let mut buf = fxb(0, 0, NO_ENTRY, 0, &[], &[Op::Ret as u8, 0]);
    buf[0] = b'X';
    assert!(matches!(Program::parse(&buf), Err(ParseErr::BadMagic)));
}

#[test]
fn counters_report_instr_and_stack_high_water() {
    // shade: push led.pos(3), swizzle to .x, then build vec3(x, const0, x) and
    // return. Exercises a handful of ops so the instruction count is a stable,
    // hand-countable number and the stack rises above the 3-slot return.
    #[rustfmt::skip]
    let code = [
        Op::LoadCtx as u8, C_LED_POS,     // +3   (sp: 0 -> 3)
        Op::PushConst as u8, 0, 0,        // +1   (sp: 3 -> 4)  const0 = 0.25
        Op::LoadCtx as u8, C_LED_POS,     // +3   (sp: 4 -> 7)  high-water here
        Op::Swizzle as u8, 3, 1, 0,       // 7 -> 5 (.x of the last vec3)
        Op::Ret as u8, 3,                 // return top 3
    ];
    let buf = fxb(0, 0, NO_ENTRY, 0, &[0.25], &code);
    let prog = Program::parse(&buf).expect("parse");
    let vm = Vm::new();
    let frame = Frame::default();
    let led = Led { pos: [0.5, 0.1, 0.2], ..Default::default() };
    let (_rgb, outcome, c) =
        vm.run_shade_counted(&prog, &frame, &led, &Budget::default());
    assert_eq!(outcome, Outcome::Ok);
    // 5 opcodes retired (LoadCtx, PushConst, LoadCtx, Swizzle, Ret).
    assert_eq!(c.instrs, 5);
    // High-water is the 7 slots pushed before the swizzle collapses them.
    assert_eq!(c.stack_max, 7);
}

#[test]
fn counters_count_budget_exhaustion() {
    // An infinite Jmp loop trips the instruction budget; the counter reports as
    // many opcodes as the budget allowed (the Jmp executed budget times).
    #[rustfmt::skip]
    let mut code = vec![Op::Jmp as u8];
    code.extend_from_slice(&(-3i16).to_le_bytes());
    let buf = fxb(0, 0, NO_ENTRY, 0, &[], &code);
    let prog = Program::parse(&buf).expect("parse");
    let vm = Vm::new();
    let (_rgb, outcome, c) =
        vm.run_shade_counted(&prog, &Frame::default(), &Led::default(), &Budget::instructions(50));
    assert_eq!(outcome, Outcome::Budget);
    assert_eq!(c.instrs, 50, "every budgeted opcode is counted before the cap");
}

#[test]
fn update_counted_reports_counters() {
    // update: state[0] += 0.25 (LoadState, PushConst, Add, StoreState, Ret) = 5 ops.
    #[rustfmt::skip]
    let update = [
        Op::LoadState as u8, 0, 1,
        Op::PushConst as u8, 0, 0,
        Op::Add as u8, 1,
        Op::StoreState as u8, 0, 1,
        Op::Ret as u8, 0,
    ];
    let buf = fxb(1, 0, 0, NO_ENTRY, &[0.25], &update);
    let prog = Program::parse(&buf).expect("parse");
    let mut vm = Vm::new();
    let (outcome, c) = vm.run_update_counted(&prog, &Frame::default(), &Budget::default());
    assert_eq!(outcome, Outcome::Ok);
    assert_eq!(c.instrs, 5);
    assert!(vm.state[0] > 0.24 && vm.state[0] < 0.26);
}
