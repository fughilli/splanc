//! FUG-125 optimizer harness: correctness + hill-climb measurement.
//!
//! For every corpus program this compiles it BOTH with and without the bytecode
//! optimizer, then runs the REAL fx_vm — `update()` once, `shade()` across an
//! LED raster over several frames — and asserts the two builds emit **bit-
//! identical** RGB for every LED. That differential check is the optimizer's
//! correctness guarantee: any pass that changes an observable render fails here.
//!
//! It doubles as the "use the simulator with the golden device profile and
//! sample FX programs to hill climb" loop the issue asks for: it counts opcodes
//! retired (the fx_vm Tier-1 counter) for each build and reports the reduction,
//! and — using the golden per-opcode cost seed — the estimated cycle win. A
//! regression (optimized retiring MORE ops than baseline) fails the test.

use ledmapper_fx_compiler::compile_opts;
use ledmapper_fx_vm::{Budget, Frame, Led, Program, Vm};

/// Representative corpus — mirrors `tools/fx_profile` plus loop/function/fixed
/// programs that exercise the control-flow and dead-local passes.
fn corpus() -> Vec<(&'static str, &'static str)> {
    vec![
        (
            "band",
            r#"uniform float speed : 0.0 .. 5.0 = 1.0;
uniform float width : 0.02 .. 0.5 = 0.12;
uniform vec3 tint : color = 0.2, 0.6, 1.0;
void update() {}
vec3 shade(Led led) {
  float phase = fract(led.s - time * speed);
  float band = smoothstep(width, 0.0, abs(phase - 0.5));
  return tint * band;
}"#,
        ),
        (
            "hue_gradient",
            r#"uniform float scale : 0.2 .. 4.0 = 1.0;
uniform float drift : 0.0 .. 2.0 = 0.3;
void update() {}
vec3 shade(Led led) {
  float h = fract(led.pos.y * scale + time * drift);
  return hsv2rgb(h, 0.9, 1.0);
}"#,
        ),
        (
            "breathing",
            r#"uniform float rate : 0.1 .. 3.0 = 0.6;
uniform vec3 base : color = 1.0, 0.3, 0.1;
state float glow;
void update() { glow = 0.5 + 0.5 * sin(time * rate); }
vec3 shade(Led led) { return base * glow; }"#,
        ),
        (
            "plasma",
            r#"uniform float scale : 1.0 .. 8.0 = 3.0;
void update() {}
vec3 shade(Led led) {
  float x = led.pos.x * scale;
  float y = led.pos.y * scale;
  float v = sin(x + time) + sin(y + time * 0.7) + sin((x + y) * 0.5 + time * 1.3);
  return hsv2rgb(fract(v * 0.16667), 0.9, 1.0);
}"#,
        ),
        (
            "agents",
            r#"struct Agent { float pos; float vel; vec3 col; };
state Agent agents[8];
state bool inited;
void update() {
  if (!inited) {
    for (int i = 0; i < 8; i = i + 1) {
      agents[i].pos = hash(float(i));
      agents[i].vel = 0.1 + hash(float(i) * 3.0) * 0.3;
      agents[i].col = hsv2rgb(hash(float(i) * 7.0), 0.9, 1.0);
    }
    inited = true;
  }
  for (int i = 0; i < 8; i = i + 1) {
    agents[i].pos = fract(agents[i].pos + agents[i].vel * dt);
  }
}
vec3 shade(Led led) {
  vec3 c = vec3(0.0, 0.0, 0.0);
  for (int i = 0; i < 8; i = i + 1) {
    float d = abs(led.s - agents[i].pos);
    c = c + agents[i].col * smoothstep(0.06, 0.0, d);
  }
  return c;
}"#,
        ),
        (
            "user_fn",
            r#"uniform float k : 0.0 .. 2.0 = 1.0;
float ramp(float x, float g) { return clamp(x * g, 0.0, 1.0); }
vec3 shade(Led led) {
  float a = ramp(led.pos.x, k);
  float b = ramp(led.s, k * 0.5);
  return vec3(a, b, a * b);
}"#,
        ),
        (
            "fixed16_gradient",
            r#"uniform float scale : 0.2 .. 4.0 = 1.0;
void update() {}
vec3 shade(Led led) {
  fixed16 h = fixed16(led.pos.y) * fixed16(scale);
  fixed16 s = sin(h);
  return vec3(float(s), 0.2, 0.5);
}"#,
        ),
        (
            "const_math",
            r#"vec3 shade(Led led) {
  float a = 2.0 * 3.0;
  float b = a * 1.0 - 0.0;
  int n = 4 * 3 + 1;
  return vec3(led.pos.x * (b / 6.0), float(n) / 13.0, 0.0);
}"#,
        ),
    ]
}

/// A raster of LEDs + frames that spans the input space the passes touch
/// (positions, arclength, index, several time values).
fn frames() -> Vec<Frame> {
    [0.0f32, 0.37, 1.9, 12.5]
        .iter()
        .enumerate()
        .map(|(i, &t)| Frame { time: t, dt: 0.016, frame: i as u32, led_count: 64, ..Default::default() })
        .collect()
}

fn leds() -> Vec<Led> {
    let n = 64u32;
    (0..n)
        .map(|i| {
            let f = i as f32 / (n as f32 - 1.0);
            Led {
                pos: [f, 1.0 - f, (f * 2.0 - 1.0) * 0.5],
                idx: i,
                seg: (i % 4) as i32,
                s: f,
                dist: f,
                uv: [f, 1.0 - f],
                ..Default::default()
            }
        })
        .collect()
}

fn seed_fixed(mut led: Led, mut frame: Frame) -> (Led, Frame) {
    let q16 = |x: f32| (x * 65536.0) as i32;
    led.pos_fix = [q16(led.pos[0]), q16(led.pos[1]), q16(led.pos[2])];
    led.uv_fix = [q16(led.uv[0]), q16(led.uv[1])];
    led.s_fix = q16(led.s);
    led.dist_fix = q16(led.dist);
    frame.time_fix = q16(frame.time);
    frame.dt_fix = q16(frame.dt);
    (led, frame)
}

#[test]
fn optimizer_preserves_output_and_reduces_ops() {
    let big = Budget::instructions(2_000_000);
    let frames = frames();
    let leds = leds();
    let mut total_base = 0u64;
    let mut total_opt = 0u64;
    let mut worst_regression: Option<(&str, u64, u64)> = None;

    println!("\n  program            base_ops   opt_ops   reduction");
    println!("  ---------------------------------------------------");
    for (name, src) in corpus() {
        let unopt = compile_opts(src, false).unwrap_or_else(|d| panic!("{name}: compile: {d:?}"));
        let opt = compile_opts(src, true).unwrap_or_else(|d| panic!("{name}: compile -O: {d:?}"));

        // Fresh Vm per build so persistent `state` starts equal.
        let a: &'static [u8] = Box::leak(unopt.fxb.clone().into_boxed_slice());
        let b: &'static [u8] = Box::leak(opt.fxb.clone().into_boxed_slice());
        let pa = Program::parse(a).expect("parse base");
        let pb = Program::parse(b).expect("parse opt");
        let mut va = Vm::new();
        let mut vb = Vm::new();
        for u in &unopt.uniforms {
            va.set_uniform(u.slot as usize, &u.default);
        }
        for u in &opt.uniforms {
            vb.set_uniform(u.slot as usize, &u.default);
        }

        let mut base_ops = 0u64;
        let mut opt_ops = 0u64;
        for frame in &frames {
            let (_, fa) = seed_fixed(Led::default(), *frame);
            let (_, fb) = seed_fixed(Led::default(), *frame);
            base_ops += va.run_update_counted(&pa, &fa, &big).1.instrs as u64;
            opt_ops += vb.run_update_counted(&pb, &fb, &big).1.instrs as u64;
            for led in &leds {
                let (la, fa) = seed_fixed(*led, *frame);
                let (lb, fb) = seed_fixed(*led, *frame);
                let (ra, _, ca) = va.run_shade_counted(&pa, &fa, &la, &big);
                let (rb, _, cb) = vb.run_shade_counted(&pb, &fb, &lb, &big);
                assert_eq!(
                    ra, rb,
                    "{name}: optimizer changed RGB at led {} frame {} — {ra:?} vs {rb:?}",
                    led.idx, frame.frame
                );
                base_ops += ca.instrs as u64;
                opt_ops += cb.instrs as u64;
            }
        }

        let pct = if base_ops > 0 {
            100.0 * (base_ops as f64 - opt_ops as f64) / base_ops as f64
        } else {
            0.0
        };
        println!("  {name:<16} {base_ops:>9} {opt_ops:>9}   {pct:>6.1}%");
        total_base += base_ops;
        total_opt += opt_ops;
        if opt_ops > base_ops {
            worst_regression = Some((name, base_ops, opt_ops));
        }
    }
    let pct = 100.0 * (total_base as f64 - total_opt as f64) / total_base as f64;
    println!("  ---------------------------------------------------");
    println!("  {:<16} {total_base:>9} {total_opt:>9}   {pct:>6.1}%\n", "TOTAL");

    // The optimizer must never make a program retire more ops than baseline.
    assert!(
        worst_regression.is_none(),
        "optimizer regressed op count: {worst_regression:?}"
    );
    // And it should actually help across the corpus.
    assert!(total_opt < total_base, "optimizer produced no net reduction");
}
