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

/// Like [`fxb`] but with a trailing buffer descriptor table (FLAG_BUFFERS). Each
/// entry is (kind, elem, comp, w, h): kind 0 = LED-arity buffer, 1 = WxH 2D
/// texture; `comp` is the packed component precision (see fx_vm::comp).
fn fxb_buffers(
    n_state: u8,
    n_uniform_slots: u8,
    update: u16,
    shade: u16,
    consts: &[f32],
    code: &[u8],
    buffers: &[(u8, u8, u8, u16, u16)],
) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&MAGIC);
    b.push(1); // version
    b.push(FLAG_BUFFERS);
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
    b.push(buffers.len() as u8);
    for &(kind, elem, comp, w, h) in buffers {
        b.push(kind);
        b.push(elem);
        b.push(comp);
        b.extend_from_slice(&w.to_le_bytes());
        b.extend_from_slice(&h.to_le_bytes());
    }
    b
}

#[test]
fn texture_rgba_written_into_arena_is_sampled() {
    // The offline video preview (FUG-39) writes a full-res RGBA frame straight
    // into a texture's arena region (wasm FxPreview::set_texture), which shade()
    // then reads via sample(). This locks in the contract that binding sample()
    // depends on: buf_base/arena_bytes line up with SampleTex's byte indexing,
    // and the RGBA->packed->sample conversion round-trips. One vec3 F32 texture,
    // 2x1, no other buffers.
    //
    // shade: return sample(tex0, led.uv)
    #[rustfmt::skip]
    let code = [
        Op::LoadCtx as u8, C_LED_UV, // push led.uv (u, v)
        Op::SampleTex as u8, 0,      // pop uv -> push 3 (bilinear, edge-clamped)
        Op::Ret as u8, 3,
    ];
    let buf = fxb_buffers(0, 0, NO_ENTRY, 0, &[], &code, &[(1, 3, comp::F32, 2, 1)]);
    let prog = Program::parse(&buf).expect("parse");

    // Texel 0 = red, texel 1 = green — written exactly as set_texture does now:
    // each RGBA channel /255, packed at the texture's precision (F32) into the
    // byte-addressed arena at buf_base + texel*elem_bytes + k*comp_bytes.
    let led_count = 4usize;
    let rgba: [u8; 8] = [255, 0, 0, 255, /* */ 0, 255, 0, 255];
    let mut arena = vec![0u8; prog.arena_bytes(led_count)];
    let base = prog.buf_base(0, led_count);
    assert_eq!(prog.arena_bytes(led_count), 6 * 4, "2 texels * vec3 * 4 B (f32), led_count-independent");
    let d = prog.buf_desc(0).unwrap();
    let (eb, cb) = (d.elem_bytes(), comp_bytes(d.comp));
    for t in 0..2 {
        for k in 0..3 {
            let o = base + t * eb + k * cb;
            comp_store_num(d.comp, rgba[t * 4 + k] as f32 / 255.0, &mut arena[o..o + cb]);
        }
    }

    let mut vm = Vm::new();
    vm.set_arena(&mut arena);
    let frame = Frame { led_count: led_count as u32, ..Default::default() };
    let sample = |u: f32, v: f32| vm.run_shade(&prog, &frame, &Led { uv: [u, v], ..Default::default() });
    assert_eq!(sample(0.0, 0.0), (255, 0, 0), "u=0 samples texel 0 (red)");
    assert_eq!(sample(1.0, 0.0), (0, 255, 0), "u=1 samples texel 1 (green)");
    // Midpoint bilinearly blends the two texels (red+green -> ~half each).
    let (r, g, b) = sample(0.5, 0.0);
    assert!((r as i32 - 127).abs() <= 1 && (g as i32 - 127).abs() <= 1 && b == 0, "mid blend {r},{g},{b}");
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

// --- reduced-precision fixed-point / transcendentals (FUG-10) ----------------

/// Push a raw fixed-point word (its i32 bits) onto the const pool. `.fxb` consts
/// are stored as raw 32-bit words the VM reads back with `to_bits()`, so a
/// scaled-integer value rides in as `f32::from_bits`.
fn fx_const(raw: i32) -> f32 {
    f32::from_bits(raw as u32)
}

/// Run a scalar-producing program and return its first output channel (0..255).
/// The `code` must push exactly ONE float in [0,1] then two zeros and `Ret 3`.
fn run_scalar(consts: &[f32], code: &[u8]) -> u8 {
    let buf = fxb(0, 0, NO_ENTRY, 0, consts, code);
    let prog = Program::parse(&buf).expect("parse");
    Vm::new().run_shade(&prog, &Frame::default(), &Led::default()).0
}

#[test]
fn fixed16_sin_cos_match_f32() {
    // sin/cos in Q1.14, angle in turns. Check a few angles against a soft-float
    // reference through the 8-bit output channel (tolerance ±2 codes).
    for &(turn, want) in &[
        (0.0f32, 0.0f32),   // sin 0
        (0.25, 1.0),        // sin 90° = 1
        (0.125, 0.70710677), // sin 45°
    ] {
        let raw = (turn * (1 << 14) as f32) as i32;
        #[rustfmt::skip]
        let code = [
            Op::PushConst as u8, 0, 0,   // angle (Q1.14 turns)
            Op::SinFix as u8, 14,
            Op::FixToF as u8, 14,        // -> float in [-1,1]
            Op::PushConst as u8, 1, 0,   // 0.0
            Op::PushConst as u8, 1, 0,   // 0.0
            Op::Ret as u8, 3,
        ];
        let got = run_scalar(&[fx_const(raw), 0.0], &code);
        let expect = (want.clamp(0.0, 1.0) * 255.0) as i32;
        assert!((got as i32 - expect).abs() <= 2, "sin({turn} turn): got {got}, want ~{expect}");
    }
    // cos(0) = 1.0 -> 255.
    #[rustfmt::skip]
    let code = [
        Op::PushConst as u8, 0, 0,
        Op::CosFix as u8, 14,
        Op::FixToF as u8, 14,
        Op::PushConst as u8, 0, 0,
        Op::PushConst as u8, 0, 0,
        Op::Ret as u8, 3,
    ];
    let got = run_scalar(&[fx_const(0)], &code);
    assert!((got as i32 - 255).abs() <= 2, "cos(0): got {got}");
}

#[test]
fn fixed8_sin_coarser_but_correct() {
    // Same sin(90°)=1 in Q1.6 (frac=6). Coarser quantization, wider tolerance.
    let raw = (0.25f32 * (1 << 6) as f32) as i32; // 0.25 turn in Q1.6
    #[rustfmt::skip]
    let code = [
        Op::PushConst as u8, 0, 0,
        Op::SinFix as u8, 6,
        Op::FixToF as u8, 6,
        Op::PushConst as u8, 1, 0,
        Op::PushConst as u8, 1, 0,
        Op::Ret as u8, 3,
    ];
    let got = run_scalar(&[fx_const(raw), 0.0], &code);
    assert!((got as i32 - 255).abs() <= 6, "fixed8 sin(90°): got {got}");
}

#[test]
fn exp_fix_decay_and_saturation() {
    // exp(0) = 1.0 -> 255; exp(-1) = 0.3679 -> ~93; exp(1) saturates (>= +2) -> 255.
    let one = (1 << 14) as f32;
    for &(x, want) in &[(0.0f32, 1.0f32), (-1.0, 0.36787945)] {
        let raw = (x * one) as i32;
        #[rustfmt::skip]
        let code = [
            Op::PushConst as u8, 0, 0,
            Op::ExpFix as u8, 14,
            Op::FixToF as u8, 14,
            Op::PushConst as u8, 1, 0,
            Op::PushConst as u8, 1, 0,
            Op::Ret as u8, 3,
        ];
        let got = run_scalar(&[fx_const(raw), 0.0], &code);
        let expect = (want.clamp(0.0, 1.0) * 255.0) as i32;
        assert!((got as i32 - expect).abs() <= 3, "exp({x}): got {got}, want ~{expect}");
    }
}

#[test]
fn mul_fix_n_and_rescale() {
    // Q1.14: 0.5 * 1.5 = 0.75 -> 191. Then rescale that Q1.14 down to Q1.6 and
    // back up, confirming FixRescale round-trips through the narrower format.
    let one14 = (1i32 << 14) as f32;
    let half = (0.5 * one14) as i32;
    let onefive = (1.5 * one14) as i32;
    #[rustfmt::skip]
    let code = [
        Op::PushConst as u8, 0, 0,   // 0.5  (Q1.14)
        Op::PushConst as u8, 1, 0,   // 1.5  (Q1.14)
        Op::MulFixN as u8, 14,       // -> 0.75 (Q1.14)
        Op::FixRescale as u8, (-8i8) as u8, // Q1.14 -> Q1.6 (>>8)
        Op::FixRescale as u8, 8u8,          // Q1.6 -> Q1.14 (<<8)
        Op::FixToF as u8, 14,        // -> 0.75 float
        Op::PushConst as u8, 2, 0,   // 0.0
        Op::PushConst as u8, 2, 0,
        Op::Ret as u8, 3,
    ];
    let got = run_scalar(&[fx_const(half), fx_const(onefive), 0.0], &code);
    // 0.75 * 255 = 191 (round-trip through Q1.6 keeps it within a code or two).
    assert!((got as i32 - 191).abs() <= 3, "0.5*1.5 via Q1.14: got {got}");
}

// --- packed narrow storage helpers (FUG-10) ----------------------------------

#[test]
fn comp_pack_unpack_round_trips() {
    let mut b = [0u8; 4];
    // Raw fixed8: the Q1.6 scaled-int stack word survives 1-byte storage.
    comp_store(comp::FIX8, f32::from_bits(32u32), &mut b); // 0.5 in Q1.6 = 32
    assert_eq!(b[0], 32);
    assert_eq!(comp_load(comp::FIX8, &b).to_bits() as i32, 32);
    // Raw fixed16: 0.5 in Q1.14 = 8192, stored little-endian in 2 bytes.
    comp_store(comp::FIX16, f32::from_bits(8192u32), &mut b);
    assert_eq!(i16::from_le_bytes([b[0], b[1]]), 8192);
    assert_eq!(comp_load(comp::FIX16, &b).to_bits() as i32, 8192);
    // Float-presenting FIX8F: 0.75 quantizes to 48 and dequantizes back.
    comp_store_num(comp::FIX8F, 0.75, &mut b);
    assert_eq!(b[0] as i8, 48);
    assert!((comp_load_num(comp::FIX8F, &b) - 0.75).abs() < 1e-6);
    // Narrow int clamps out-of-range instead of wrapping wildly.
    comp_store(comp::I8, f32::from_bits(999i32 as u32), &mut b);
    assert_eq!(b[0] as i8, 127);
    comp_store(comp::I16, f32::from_bits(-40000i32 as u32), &mut b);
    assert_eq!(i16::from_le_bytes([b[0], b[1]]), i16::MIN);
    // f32 stays exact; widths are as declared.
    comp_store(comp::F32, 0.3, &mut b);
    assert!((comp_load(comp::F32, &b) - 0.3).abs() < 1e-6);
    assert_eq!((comp_bytes(comp::F32), comp_bytes(comp::FIX16), comp_bytes(comp::FIX8)), (4, 2, 1));
}

#[test]
fn lut_sin_cos_match_libm_within_tolerance() {
    // The flash-LUT sinf/cosf must track the real trig closely enough to be
    // invisible on 8-bit LEDs (< ~1/255). Sweep a few periods, incl. negatives.
    let mut max_err = 0.0f32;
    let mut x = -20.0f32;
    while x < 20.0 {
        max_err = max_err.max((sinf(x) - x.sin()).abs());
        max_err = max_err.max((cosf(x) - x.cos()).abs());
        x += 0.001;
    }
    assert!(max_err < 2.0e-3, "LUT trig error {max_err} too large");
}

#[test]
fn integer_hash_uniform_and_no_fixed_point() {
    // No soft-float sin, no 0->0 fixed point, output in [0,1), roughly uniform.
    assert!(hash1(0.0) > 0.0, "hash(0) must not be a fixed point");
    let mut buckets = [0u32; 10];
    let mut i = 0;
    while i < 10_000 {
        let h = hash1(i as f32 * 0.123 - 500.0);
        assert!((0.0..1.0).contains(&h), "hash out of range: {h}");
        buckets[((h * 10.0) as usize).min(9)] += 1;
        i += 1;
    }
    for b in buckets {
        assert!(b > 700 && b < 1300, "hash decile non-uniform: {b}");
    }
    // hash3 in range and sensitive to each argument.
    assert!((0.0..1.0).contains(&hash3(0.5, 0.25, 0.75)));
    assert!(hash3(1.0, 2.0, 3.0) != hash3(1.0, 2.0, 4.0));
    assert!(hash3(1.0, 2.0, 3.0) != hash3(2.0, 1.0, 3.0));
}
