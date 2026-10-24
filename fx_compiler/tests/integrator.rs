//! Rate controls: the `time * uniform` phase lint (src/lint.rs), and that the
//! integrator idiom it recommends (`ph = fract(ph + dt * speed);` in update())
//! stays continuous in the real fx_vm when the uniform changes mid-run — with
//! the variance pass hoisting the phase and the per-LED cache bound — where the
//! `fract(time * speed)` form jumps.

use ledmapper_fx_compiler::{compile, compile_with, CompileOptions, MemoConfig};
use ledmapper_fx_vm::{led_cache_bytes, Budget, Frame, Led, Program, Vm};

fn warnings(src: &str) -> Vec<String> {
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {d:?}\n{src}"));
    c.warnings
        .iter()
        .map(|w| format!("{}:{}: {}", w.line, w.col, w.msg))
        .collect()
}

fn assert_warns(src: &str, line: u32, uniform: &str) {
    assert_warns_via(src, line, uniform, uniform);
}

/// `operand` is what multiplied `time` (the uniform, or a variable from it).
fn assert_warns_via(src: &str, line: u32, uniform: &str, operand: &str) {
    let w = warnings(src);
    assert_eq!(w.len(), 1, "want one warning, got {w:#?}\n{src}");
    let c = compile(src).unwrap();
    assert_eq!(c.warnings[0].line, line, "{w:?}");
    let msg = &c.warnings[0].msg;
    assert!(msg.starts_with("warning: "), "{msg}");
    assert!(msg.contains(&format!("uniform `{uniform}`")), "{msg}");
    assert!(
        msg.contains(&format!("fract({operand}_phase + dt * {operand})")),
        "{msg}"
    );
}

fn assert_clean(src: &str) {
    let w = warnings(src);
    assert!(w.is_empty(), "want no warnings, got {w:#?}\n{src}");
}

const HEAD: &str =
    "uniform float speed : 0.0 .. 3.0 = 1.0;\nuniform float scale : 0.5 .. 4.0 = 1.0;\n";

// -- positive cases ---------------------------------------------------------------

#[test]
fn warns_on_rate_times_time_in_fract_in_shade() {
    // line 3 (two uniform lines of HEAD first)
    assert_warns(&format!("{HEAD}vec3 shade(Led led) {{\n  float p = fract(led.s - time * speed);\n  return vec3(p, p, p);\n}}"), 4, "speed");
}

#[test]
fn warns_on_uniform_on_the_left_and_in_sin() {
    assert_warns(
        &format!("{HEAD}state float g;\nvoid update() {{ g = 0.5 + 0.5 * sin(speed * time * 6.2832); }}\nvec3 shade(Led led) {{ return vec3(g, g, g); }}"),
        4,
        "speed",
    );
}

#[test]
fn warns_through_state_assigned_in_update() {
    // noise_field's old `z = time * speed;` — the product is formed in update(),
    // the phase sinks (floor/fract) are in shade(): the warning names the line
    // that formed it.
    let src = format!(
        "{HEAD}state float z;\nvoid update() {{\n  z = time * speed;\n}}\nvec3 shade(Led led) {{\n  vec3 p = led.pos * scale + vec3(0.0, z, z * 0.5);\n  vec3 f = fract(p);\n  return f;\n}}"
    );
    assert_warns(&src, 5, "speed");
}

#[test]
fn warns_through_a_local_and_extra_constant_factors() {
    assert_warns(
        &format!("{HEAD}vec3 shade(Led led) {{\n  float t = time * speed * 0.63;\n  float h = fract(led.s + t);\n  return hsv2rgb(h, 1.0, 1.0);\n}}"),
        4,
        "speed",
    );
}

#[test]
fn warns_on_a_period_uniform_dividing_time() {
    assert_warns(
        &format!("{HEAD}vec3 shade(Led led) {{\n  return vec3(fract(time / scale), 0.0, 0.0);\n}}"),
        4,
        "scale",
    );
}

#[test]
fn warns_through_a_state_copy_of_the_uniform_and_fixed() {
    // A state derived from the uniform still carries it; fixed() and the
    // fixed-point fract keep the taint.
    let src = format!(
        "{HEAD}state float k;\nstate fixed ph;\nvoid update() {{\n  k = speed * 2.0;\n  ph = fixed(fract(time * k));\n}}\nvec3 shade(Led led) {{ return vec3(float(ph), 0.0, 0.0); }}"
    );
    assert_warns_via(&src, 7, "speed", "k");
}

#[test]
fn warns_on_epoch_hashing_and_percent() {
    assert_warns(&format!("{HEAD}vec3 shade(Led led) {{\n  float e = hash(floor(time * speed));\n  return vec3(e, e, e);\n}}"), 4, "speed");
    assert_warns(&format!("{HEAD}vec3 shade(Led led) {{\n  int e = int(time * speed) % 4;\n  return vec3(float(e) * 0.25, 0.0, 0.0);\n}}"), 4, "speed");
}

#[test]
fn one_warning_per_product_line_and_one_per_rate() {
    // The same product reaching three sinks warns once; two products on two
    // lines warn twice.
    let src = format!(
        "{HEAD}vec3 shade(Led led) {{\n  float t = time * speed;\n  float u = time * scale;\n  return vec3(fract(t), sin(t), cos(u));\n}}"
    );
    let w = warnings(&src);
    assert_eq!(w.len(), 2, "{w:#?}");
    assert!(w[0].starts_with("4:") && w[0].contains("`speed`"), "{w:#?}");
    assert!(w[1].starts_with("5:") && w[1].contains("`scale`"), "{w:#?}");
}

// -- negative cases (conservative: no false positives) -------------------------------

#[test]
fn literal_rates_are_fine() {
    assert_clean(&format!("{HEAD}vec3 shade(Led led) {{\n  return vec3(fract(led.s - time * 0.5), sin(time * 0.7 + led.pos.x * 3.0), 0.0);\n}}"));
}

#[test]
fn time_plus_uniform_terms_are_fine() {
    // A uniform scaling space (not time) and a phase-offset uniform added to
    // time: no product of time and a uniform.
    assert_clean(&format!(
        "{HEAD}vec3 shade(Led led) {{\n  float p = fract(led.s * scale - time + speed);\n  return vec3(p, p, p);\n}}"
    ));
}

#[test]
fn the_integrator_idiom_is_clean() {
    assert_clean(&format!(
        "{HEAD}state float ph;\nstate float glow;\nvoid update() {{\n  ph = fract(ph + dt * speed);\n  glow = 0.5 + 0.5 * sin(ph * 6.2832);\n}}\nvec3 shade(Led led) {{\n  float p = fract(led.s * scale - ph);\n  return vec3(p, glow, 0.0);\n}}"
    ));
}

#[test]
fn fixed_integrator_is_clean() {
    assert_clean(&format!(
        "{HEAD}state fixed ph;\nvoid update() {{ ph = fract(ph + fixed(dt) * fixed(speed)); }}\nvec3 shade(Led led) {{\n  fixed16 a = fixed16(ph);\n  float v = float(sin(a));\n  return vec3(v, v, v);\n}}"
    ));
}

#[test]
fn amplitude_of_a_time_oscillation_is_fine() {
    // sin(time) * amp scales an amplitude, not a rate; a uniform scaling a
    // non-phase (exp decay) is not flagged either.
    assert_clean(&format!(
        "{HEAD}vec3 shade(Led led) {{\n  float w = sin(time) * speed;\n  float h = fract(led.s + w);\n  return vec3(h, exp(-time * scale), 0.0);\n}}"
    ));
}

#[test]
fn time_times_uniform_not_reaching_a_phase_is_fine() {
    assert_clean(&format!("{HEAD}vec3 shade(Led led) {{\n  float x = clamp(time * speed, 0.0, 1.0);\n  return vec3(x, x, x);\n}}"));
}

#[test]
fn locals_do_not_leak_between_functions() {
    // `t` is a rate product in one helper and an unrelated value in shade().
    assert_clean(&format!(
        "{HEAD}float f() {{ float t = time * speed; return t; }}\nvec3 shade(Led led) {{\n  float t = led.s;\n  return vec3(fract(t), 0.0, 0.0);\n}}"
    ));
}

// -- runtime: integrators are continuous; time*speed jumps -----------------------------

const INTEGRATOR: &str = r#"
uniform float speed : 0.0 .. 4.0 = 0.2;
state float ph;
void update() { ph = fract(ph + dt * speed); }
vec3 shade(Led led) {
  float a = atan2(led.pos.y, led.pos.x);
  return vec3(ph, fract(a * 0.15 + ph), 0.0);
}"#;

const FIXED_INTEGRATOR: &str = r#"
uniform float speed : 0.0 .. 4.0 = 0.2;
state fixed ph;
void update() { ph = fract(ph + fixed(dt) * fixed(speed)); }
vec3 shade(Led led) {
  float a = atan2(led.pos.y, led.pos.x);
  return vec3(float(ph), fract(a * 0.15 + float(ph)), 0.0);
}"#;

const TIME_TIMES_SPEED: &str = r#"
uniform float speed : 0.0 .. 4.0 = 0.2;
state float ph;
void update() { ph = fract(time * speed); }
vec3 shade(Led led) {
  float a = atan2(led.pos.y, led.pos.x);
  return vec3(ph, fract(a * 0.15 + ph), 0.0);
}"#;

fn leds(n: u32) -> Vec<Led> {
    (0..n)
        .map(|i| {
            let a = i as f32 * 0.7;
            let pos = [a.cos(), a.sin(), 0.0];
            let q = |x: f32| (x * 65536.0) as i32;
            Led {
                pos,
                idx: i,
                pos_fix: [q(pos[0]), q(pos[1]), q(pos[2])],
                ..Default::default()
            }
        })
        .collect()
}

/// Run `frames` frames at dt = 1/30 s starting at `t0` (a player that has been
/// up a while), setting `speed` to `fast` from frame `change_at`. Returns each
/// frame's red channel of LED 0 (the phase, 0..255) — with the memo pass on and
/// the per-LED cache bound when `memo`.
fn red_trace(
    src: &str,
    memo: bool,
    t0: f32,
    frames: u32,
    change_at: u32,
    slow: f32,
    fast: f32,
) -> Vec<Vec<(u8, u8, u8)>> {
    let opts = CompileOptions {
        optimize: true,
        memo: memo.then(MemoConfig::default),
    };
    let c = compile_with(src, &opts).unwrap_or_else(|d| panic!("{d:?}"));
    let prog = Program::parse(&c.fxb).expect("parse");
    let ls = leds(16);
    let n = ls.len();
    let mut vm = Vm::new();
    let mut arena = vec![0u8; prog.arena_bytes(n) + 64];
    vm.set_arena(&mut arena);
    let mut mem = vec![0u8; led_cache_bytes(prog.led_cache_words(), n).max(4)];
    if memo {
        let w = prog.led_cache_fit(n, mem.len());
        vm.set_led_cache(&mut mem, w, n);
    }
    vm.set_uniform(0, &[slow]);
    let big = Budget::instructions(5_000_000);
    let dt = 1.0 / 30.0;
    let mut out = Vec::new();
    for f in 0..frames {
        if f == change_at {
            vm.set_uniform(0, &[fast]);
        }
        let t = t0 + f as f32 * dt;
        let q = |x: f32| (x * 65536.0) as i32;
        let fr = Frame {
            time: t,
            dt,
            frame: f,
            led_count: n as u32,
            time_fix: q(t),
            dt_fix: q(dt),
            ..Default::default()
        };
        vm.run_update_counted(&prog, &fr, &big);
        out.push(
            ls.iter()
                .map(|l| vm.run_shade_counted(&prog, &fr, l, &big).0)
                .collect(),
        );
    }
    out
}

/// Largest frame-to-frame change of the phase channel (red, LED 0), on the
/// circle (a wrap 255 -> 0 is a step of 1, not 255).
fn max_step(trace: &[Vec<(u8, u8, u8)>]) -> u32 {
    trace
        .windows(2)
        .map(|w| {
            let d = (w[1][0].0 as i32 - w[0][0].0 as i32).unsigned_abs();
            d.min(256 - d)
        })
        .max()
        .unwrap()
}

#[test]
fn integrator_phase_is_continuous_across_a_uniform_change() {
    // speed 0.2 -> 2.0 at frame 20, after 10 minutes of uptime. The phase may
    // only ever advance by speed * dt per frame: 2.0 / 30 of a cycle = 17/255.
    let bound = (255.0 * 2.0 / 30.0) as u32 + 2;
    for src in [INTEGRATOR, FIXED_INTEGRATOR] {
        let memo = red_trace(src, true, 600.0, 40, 20, 0.2, 2.0);
        let plain = red_trace(src, false, 600.0, 40, 20, 0.2, 2.0);
        // The variance pass (phase hoisted per frame, per-LED atan2 cached) is
        // bit-identical to the plain build, and re-reads the integrated state
        // every frame (it is per-frame, not per-LED/constant).
        assert_eq!(memo, plain);
        let step = max_step(&memo);
        assert!(
            step <= bound,
            "integrator jumped {step}/255 per frame (bound {bound})\n{src}"
        );
        // ... and it does move, faster after the change.
        let before = max_step(&memo[..20]);
        let after = max_step(&memo[20..]);
        assert!(
            before >= 1 && after > before,
            "before {before} after {after}"
        );
    }
    // The anti-pattern, same change: the phase jumps by fract(1.8 * 600.7) of a
    // cycle at the change — the bug the lint and the prompts warn about.
    let bad = red_trace(TIME_TIMES_SPEED, true, 600.0, 40, 20, 0.2, 2.0);
    assert!(
        max_step(&bad) > bound,
        "time*speed should jump: {}",
        max_step(&bad)
    );
    assert_eq!(warnings(TIME_TIMES_SPEED).len(), 1);
    assert!(warnings(INTEGRATOR).is_empty() && warnings(FIXED_INTEGRATOR).is_empty());
}

#[test]
fn integrator_phase_is_shared_by_every_led_of_a_frame() {
    // update() runs once per frame: every LED sees the same phase (red), even
    // with the LED cache holding the per-LED atan2.
    let tr = red_trace(INTEGRATOR, true, 0.0, 10, 5, 0.5, 1.5);
    for row in &tr {
        assert!(row.iter().all(|c| c.0 == row[0].0), "{row:?}");
    }
}
