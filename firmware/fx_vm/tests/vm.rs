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
fn rejects_bad_magic() {
    let mut buf = fxb(0, 0, NO_ENTRY, 0, &[], &[Op::Ret as u8, 0]);
    buf[0] = b'X';
    assert!(matches!(Program::parse(&buf), Err(ParseErr::BadMagic)));
}
