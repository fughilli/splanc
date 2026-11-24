//! `shared state` (docs/design/fx-mesh-state-and-agents.md, Part 1): the compiler's
//! shared-state footer, and the VM's snapshot / restore of exactly those slots, so a
//! fixture that rejoins a mesh takes an integrated phase from the gateway while its
//! own (plain) state, an agent list say, starts fresh.

use ledmapper_fx_compiler::compile;
use ledmapper_fx_vm::{Budget, Frame, Program, Vm, FLAG_INIT, FLAG_SHARED_STATE};

const SRC: &str = r#"
uniform float speed : 0.0 .. 5.0 = 1.0;
struct Agent { vec3 pos; float hue; };
state Agent agents[2];
shared state float phase;
state int n;
shared state vec2 drift;
void update() {
    phase = fract(phase + dt * speed);
    drift = drift + vec2(dt, dt * 2.0);
    n = n + 1;
    agents[0].hue = agents[0].hue + dt;
}
vec3 shade(Led led) { return vec3(phase, drift.x, agents[0].hue); }
"#;

fn frame(t: f32, dt: f32) -> Frame {
    Frame { time: t, dt, ..Default::default() }
}

#[test]
fn the_footer_names_the_shared_ranges() {
    let c = compile(SRC).expect("compiles");
    assert!(c.warnings.is_empty(), "{:?}", c.warnings);
    let p = Program::parse(&c.fxb).unwrap();
    assert_ne!(p.flags & FLAG_SHARED_STATE, 0);
    let slot = |name: &str| c.symbols.iter().find(|s| s.name == name).map(|s| (s.slot as usize, s.width as usize)).unwrap();
    let got: Vec<_> = p.shared_state().collect();
    assert_eq!(got, vec![slot("phase"), slot("drift")]);
    assert_eq!(p.shared_words(), 3);
    // Without `shared`, no flag and no footer: the file is what it was before.
    let plain = compile(&SRC.replace("shared state", "state")).unwrap();
    assert_eq!(Program::parse(&plain.fxb).unwrap().flags & FLAG_SHARED_STATE, 0);
    assert_eq!(plain.fxb.len() + 2 * 2 + 1, c.fxb.len());
}

#[test]
fn a_rejoin_restores_shared_state_only() {
    let c = compile(SRC).unwrap();
    let p = Program::parse(&c.fxb).unwrap();
    // The gateway has run a while.
    let mut gw = Vm::new();
    for f in 0..90 {
        gw.run_update(&p, &frame(f as f32 / 30.0, 1.0 / 30.0));
    }
    let mut snap = [0u32; 16];
    let k = gw.snapshot_shared(&p, &mut snap);
    assert_eq!(k, 3);
    // A rebooted member: fresh VM, restore, then both run the same frame.
    let mut m = Vm::new();
    assert!(m.restore_shared(&p, &snap[..k]));
    gw.run_update(&p, &frame(3.0, 1.0 / 30.0));
    m.run_update(&p, &frame(3.0, 1.0 / 30.0));
    let slot = |name: &str| c.symbols.iter().find(|s| s.name == name).unwrap().slot as usize;
    for name in ["phase", "drift"] {
        assert_eq!(m.state[slot(name)].to_bits(), gw.state[slot(name)].to_bits(), "{name}");
    }
    // Plain state is the member's own: it started from zero.
    assert_eq!(m.state[slot("n")].to_bits() as i32, 1);
    assert_ne!(gw.state[slot("n")].to_bits() as i32, 1);
    assert!(m.state[slot("agents")] == 0.0 && m.state[slot("agents") + 3] < gw.state[slot("agents") + 3]);
    // A snapshot of the wrong size (another build) is refused and writes nothing.
    let mut other = Vm::new();
    assert!(!other.restore_shared(&p, &snap[..2]));
    assert_eq!(other.state[slot("phase")], 0.0);
}

#[test]
fn layout_hash_tells_builds_apart() {
    let a = compile(SRC).unwrap();
    let b = compile(&SRC.replace("dt * 2.0", "dt * 3.0")).unwrap();
    let pa = Program::parse(&a.fxb).unwrap();
    assert_eq!(pa.layout_hash(), Program::parse(&compile(SRC).unwrap().fxb).unwrap().layout_hash());
    assert_ne!(pa.layout_hash(), Program::parse(&b.fxb).unwrap().layout_hash());
}

#[test]
fn shared_qualifies_only_state() {
    let e = compile("shared uniform float x = 1.0;\nvec3 shade(Led led) { return vec3(x); }").err().expect("shared on a uniform is an error");
    assert!(e[0].msg.contains("`shared` qualifies a state declaration"), "{e:?}");
}

#[test]
fn the_rate_lint_recommends_shared_state() {
    let c = compile("uniform float speed = 1.0;\nvec3 shade(Led led) { return vec3(fract(time * speed)); }").unwrap();
    assert!(c.warnings.iter().any(|w| w.msg.contains("`shared state float speed_phase;`")), "{:?}", c.warnings);
}

/// `shared state` with D-500's initial values and `void init()` (FLAG_INIT 0x80 next to
/// FLAG_SHARED_STATE 0x40): both flags and the footer survive together, the init `done`
/// guard is not a shared range, and the firmware's order (init at load, then the
/// catch-up's restore, then the first update) leaves the gateway's values in place while
/// the member's own init still ran.
#[test]
fn shared_state_with_init_values_and_init() {
    let src = r#"
uniform float speed : 0.0 .. 5.0 = 1.0;
shared state float phase = 0.25;
state float mine;
void init() { mine = 4.0; }
void update() { phase = fract(phase + dt * speed); }
vec3 shade(Led led) { return vec3(phase, mine, 0.0); }
"#;
    let c = compile(src).expect("compiles");
    let p = Program::parse(&c.fxb).unwrap();
    assert_ne!(p.flags & FLAG_SHARED_STATE, 0);
    assert_ne!(p.flags & FLAG_INIT, 0);
    let slot = |name: &str| c.symbols.iter().find(|s| s.name == name).unwrap().slot as usize;
    let got: Vec<_> = p.shared_state().collect();
    assert_eq!(got, vec![(slot("phase"), 1)], "only `phase` is shared (not init's guard)");
    let budget = Budget::default();
    let load = |vm: &mut Vm| {
        for u in &c.uniforms {
            vm.set_uniform(u.slot as usize, &u.default);
        }
        assert!(vm.run_init(&p, &frame(0.0, 0.0), &budget), "init runs at load");
    };
    let mut gw = Vm::new();
    load(&mut gw);
    assert_eq!(gw.state[slot("phase")], 0.25, "the initial value");
    for f in 0..40 {
        gw.run_update(&p, &frame(f as f32 / 30.0, 1.0 / 30.0));
    }
    let mut snap = [0u32; 4];
    let k = gw.snapshot_shared(&p, &mut snap);
    assert_eq!(k, 1);
    // A member loads the effect (init), then the catch-up restores, then both update.
    let mut m = Vm::new();
    load(&mut m);
    assert!(m.restore_shared(&p, &snap[..k]));
    gw.run_update(&p, &frame(2.0, 1.0 / 30.0));
    m.run_update(&p, &frame(2.0, 1.0 / 30.0));
    assert_eq!(m.state[slot("phase")].to_bits(), gw.state[slot("phase")].to_bits(), "restore survived the first update");
    assert_eq!(m.state[slot("mine")], 4.0, "the member's own init ran");
}
