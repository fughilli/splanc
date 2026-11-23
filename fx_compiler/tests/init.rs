//! D-500: `state` initial values (`state float x = 0.5;`) and `void init()`,
//! which run once before the first update() after the state starts fresh —
//! compiled to an init block in front of update() (no new opcode, no format
//! change), checked here on the real fx_vm with the optimizer on and off.

use ledmapper_fx_compiler::{compile, compile_opts, disassemble, Compiled};
use ledmapper_fx_vm::{Frame, Led, Program, Vm};

fn build(src: &str, optimize: bool) -> Compiled {
    compile_opts(src, optimize).unwrap_or_else(|d| panic!("compile error: {:?}", d))
}

/// Run `updates` update()s (uniforms at their defaults) and return the VM.
fn run(c: &Compiled, updates: usize) -> Vm {
    let prog = Program::parse(&c.fxb).expect("parse fxb");
    let mut vm = Vm::new();
    for u in &c.uniforms {
        vm.set_uniform(u.slot as usize, &u.default);
    }
    for i in 0..updates {
        let f = Frame { frame: i as u32, time: i as f32 * 0.02, dt: 0.02, ..Default::default() };
        vm.run_update(&prog, &f);
    }
    vm
}

fn state(c: &Compiled, vm: &Vm, name: &str) -> Vec<f32> {
    let s = c
        .symbols
        .iter()
        .find(|s| s.kind == "state" && s.name == name)
        .unwrap_or_else(|| panic!("no state {name}"));
    vm.state[s.slot as usize..(s.slot + s.width) as usize].to_vec()
}

/// Both optimizer settings: (state after `updates` frames).
fn both(src: &str, updates: usize, name: &str) -> Vec<f32> {
    let a = build(src, false);
    let b = build(src, true);
    let va = state(&a, &run(&a, updates), name);
    let vb = state(&b, &run(&b, updates), name);
    assert_eq!(va, vb, "optimizer changed `{name}`");
    va
}

const SHADE: &str = "vec3 shade(Led led) { return vec3(0.0); }";

#[test]
fn initialiser_applies_before_the_first_update() {
    let src = format!(
        "state float x = 0.5;
         state vec3 c = vec3(0.1, 0.2, 0.3);
         state int n = 7;
         state float plain;
         void update() {{ x = x + 1.0; }}
         {SHADE}"
    );
    assert_eq!(both(&src, 0, "x"), vec![0.0], "nothing runs before the first update()");
    assert_eq!(both(&src, 1, "x"), vec![1.5], "initialised, then update() ran once");
    assert_eq!(both(&src, 3, "x"), vec![3.5], "initialised only once");
    assert_eq!(both(&src, 1, "c"), vec![0.1, 0.2, 0.3]);
    // An int rides its slot as raw i32 bits.
    assert_eq!(both(&src, 1, "n")[0].to_bits(), 7);
    assert_eq!(both(&src, 1, "plain"), vec![0.0], "no initialiser stays zero");
}

#[test]
fn shade_sees_initialised_state_on_the_first_frame() {
    let src = "state float level = 0.5;
               vec3 shade(Led led) { return vec3(level, 0.0, 0.0); }";
    for opt in [false, true] {
        let c = build(src, opt);
        let prog = Program::parse(&c.fxb).unwrap();
        let mut vm = run(&c, 1);
        let rgb = vm.run_shade(&prog, &Frame::default(), &Led::default());
        assert_eq!(rgb.0, 127, "shade-only effect: the init block is its update()");
    }
}

#[test]
fn init_runs_once_before_update() {
    let src = format!(
        "state float runs;
         state float x;
         void init() {{ runs = runs + 1.0; x = 10.0; }}
         void update() {{ x = x + 1.0; }}
         {SHADE}"
    );
    assert_eq!(both(&src, 1, "x"), vec![11.0], "init() ran before the first update() body");
    assert_eq!(both(&src, 5, "runs"), vec![1.0], "init() ran once");
    assert_eq!(both(&src, 5, "x"), vec![15.0]);
}

#[test]
fn initialisers_run_in_order_then_init() {
    let src = format!(
        "uniform float start : 0.0 .. 10.0 = 4.0;
         state float a = start;
         state float b = a * 3.0;
         state float c = 1.0;
         void init() {{ c = b + a; }}
         {SHADE}"
    );
    assert_eq!(both(&src, 1, "a"), vec![4.0], "an initialiser may read a uniform");
    assert_eq!(both(&src, 1, "b"), vec![12.0], "and the state declared above it");
    assert_eq!(both(&src, 1, "c"), vec![16.0], "init() runs after every initialiser");
}

#[test]
fn init_can_fill_arrays_with_loops_and_return_early() {
    let src = format!(
        "state float xs[4];
         state float after;
         float twice(float v) {{ return v * 2.0; }}
         void init() {{
             for (int i = 0; i < 4; i = i + 1) {{
                 xs[i] = twice(float(i));
             }}
             if (xs[3] > 1.0) {{
                 return;
             }}
             after = 1.0;
         }}
         void update() {{ xs[0] = xs[0] + 0.5; }}
         {SHADE}"
    );
    assert_eq!(both(&src, 1, "xs"), vec![0.5, 2.0, 4.0, 6.0]);
    assert_eq!(both(&src, 2, "after"), vec![0.0], "`return;` left init()");
}

#[test]
fn programs_without_init_are_unchanged() {
    // No initialiser and no init(): not even the hidden flag slot.
    let src = format!("state float a; state float b; void update() {{ a = a + dt; }} {SHADE}");
    let c = build(&src, true);
    assert_eq!(Program::parse(&c.fxb).unwrap().n_state, 2);
    assert!(!disassemble(&c.fxb).is_empty());
    // An initialiser adds exactly one (hidden) state slot.
    let src2 = format!("state float a = 1.0; state float b; void update() {{ a = a + dt; }} {SHADE}");
    assert_eq!(Program::parse(&build(&src2, true).fxb).unwrap().n_state, 3);
}

#[test]
fn a_fresh_vm_reinitialises() {
    // Loading the effect again (a fresh VM, as the firmware does on every
    // load) runs the initialisers again.
    let src = format!("state float x = 2.0; void update() {{ x = x * 2.0; }} {SHADE}");
    let c = build(&src, true);
    assert_eq!(state(&c, &run(&c, 3), "x"), vec![16.0]);
    assert_eq!(state(&c, &run(&c, 1), "x"), vec![4.0]);
}

#[test]
fn a_driver_initialises_before_poll() {
    let src = "export float level;
               state float k = 3.0;
               void init() { level = 1.0; }
               void poll() { level = level + k; }";
    let c = compile(src).unwrap_or_else(|d| panic!("{d:?}"));
    let prog = Program::parse(&c.fxb).unwrap();
    let mut vm = Vm::new();
    struct NoBus;
    impl ledmapper_fx_vm::I2cBus for NoBus {
        fn write(&mut self, _: u8, _: &[u8]) -> bool {
            false
        }
        fn read_reg(&mut self, _: u8, _: u8, _: &mut [u8]) -> bool {
            false
        }
    }
    let budget = ledmapper_fx_vm::Budget::default();
    for _ in 0..2 {
        vm.run_poll(&prog, &Frame::default(), &mut NoBus, &budget);
    }
    assert_eq!(state(&c, &vm, "level"), vec![7.0]);
}

#[test]
fn rejects_bad_init_declarations() {
    let err = |src: &str| -> String {
        match compile(&format!("{src} {SHADE}")) {
            Ok(_) => panic!("compiled: {src}"),
            Err(d) => d[0].msg.clone(),
        }
    };
    assert!(err("float init() { return 1.0; }").contains("void init()"));
    assert!(err("void init(float x) { }").contains("no parameters"));
    assert!(err("void init() { } void init() { }").contains("twice"));
    assert!(err("void init() { return 1.0; }").contains("returns nothing"));
    assert!(err("state float xs[4] = 1.0;").contains("init()"));
    assert!(err("state float a = b; state float b = 1.0;").contains("unknown identifier"));
    assert!(err("state float a = a + 1.0;").contains("unknown identifier"));
    assert!(err("state float a = ;").contains("initial value"));
    // An initialiser's own error points at it.
    let d = compile(&format!("state float a = 1.0;\nstate vec3 c = nope;\n{SHADE}")).err().unwrap();
    assert_eq!(d[0].line, 2);
}

#[test]
fn a_state_named_init_still_works() {
    // Existing effects use `state bool init;` as a hand-rolled first-frame flag.
    let src = format!("state bool init; state float x; void update() {{ if (!init) {{ x = 5.0; init = true; }} }} {SHADE}");
    assert_eq!(both(&src, 2, "x"), vec![5.0]);
}

#[test]
fn hitl_dbg_init_state_layout() {
    // pi/hitl/harness/ab_demo/dbgInit.fx: hitl_fx_debug.py's INIT_CHECKS read
    // these slots off the paused device, so pin them here.
    let src = include_str!("../../pi/hitl/harness/ab_demo/dbgInit.fx");
    let c = build(src, true);
    let vm = run(&c, 10);
    for (slot, want) in [(0usize, 0.75f32), (1, 0.75), (2, 0.25), (3, 0.5), (5, 1.0)] {
        assert_eq!(vm.state[slot], want, "slot {slot}");
    }
}
