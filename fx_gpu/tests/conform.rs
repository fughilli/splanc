//! CI conformance: a handful of inline effects covering the lowered subset
//! (pure per-LED arithmetic, trig, colour, fixed-point, if/else) are lowered,
//! legalized and run through the `fx_gpu` evaluator, then compared against the
//! real `fx_vm` over a synthetic fixture. The evaluator must match the VM to
//! within a small tolerance (`TOL` channels of 255). Also checks that the
//! lowering REFUSES the constructs the subset doesn't cover, so an unsupported
//! effect always falls back to the VM instead of rendering wrong.

use fx_gpu::{compile_shade, emit_glsl, eval, kernel, lower, Profile};
use ledmapper_fx_vm as vm;

const TOL: u32 = 2;

/// Quantize the evaluator's linear/raw RGB the way the VM epilogue does.
fn quantize(rgb: [f32; 3], raw: bool) -> [u8; 3] {
    if raw {
        let c = |x: f32| x.clamp(0.0, 255.0) as u8;
        [c(rgb[0]), c(rgb[1]), c(rgb[2])]
    } else {
        [vm::unit_u8(rgb[0]), vm::unit_u8(rgb[1]), vm::unit_u8(rgb[2])]
    }
}

fn fixture(n: usize) -> Vec<vm::Led> {
    (0..n)
        .map(|i| {
            let t = i as f32 / (n.max(2) - 1) as f32;
            let pos = [t, (t * 3.0).fract(), 1.0 - t];
            let mut led = vm::Led {
                pos,
                idx: i as u32,
                seg: (i / 8) as i32,
                s: (t * 5.0).fract(),
                uv: [t, 1.0 - t],
                dist: t,
                ..Default::default()
            };
            for c in 0..3 {
                led.pos_fix[c] = vm::f32_to_fix(pos[c], 16);
            }
            led.uv_fix = [vm::f32_to_fix(led.uv[0], 16), vm::f32_to_fix(led.uv[1], 16)];
            led.s_fix = vm::f32_to_fix(led.s, 16);
            led.dist_fix = vm::f32_to_fix(led.dist, 16);
            led
        })
        .collect()
}

fn frame(f: u32, n: usize) -> vm::Frame {
    let dt = 1.0 / 60.0;
    let time = f as f32 * dt;
    let mut fr = vm::Frame { time, dt, frame: f, led_count: n as u32, ..Default::default() };
    fr.time_fix = vm::f32_to_fix(time, 16);
    fr.dt_fix = vm::f32_to_fix(dt, 16);
    fr
}

fn conform(src: &str, prof: Profile) -> (u32, usize) {
    let compiled = ledmapper_fx_compiler::compile(src).expect("compile");
    let prog = vm::Program::parse(&compiled.fxb).expect("parse");
    let (g, roots, raw) = compile_shade(&prog, prof).expect("lower");
    // GLSL ES 3.10 must emit without error.
    let _ = emit_glsl::emit(&g, &roots, emit_glsl::Target::Es310Compute).expect("glsl310");

    let mut v = vm::Vm::new();
    for u in &compiled.uniforms {
        v.set_uniform(u.slot as usize, &u.default);
    }
    let leds = fixture(48);
    let mut max_err = 0u32;
    for f in 0..6 {
        let fr = frame(f, leds.len());
        v.run_update(&prog, &fr);
        // Run the hoisted per-frame prepare so `state` holds the values shade
        // reads, BEFORE we snapshot it for the evaluator.
        v.run_prep(&prog, &fr, &vm::Budget::default());
        let uniforms = v.uniforms.to_vec();
        let state = v.state.to_vec();
        for led in &leds {
            let (vr, vg, vb) = v.run_shade(&prog, &fr, led);
            let inp = kernel::inputs(&uniforms, &state, &fr, led);
            let rgb = eval::eval_rgb(&g, &roots, &inp);
            let gq = quantize(rgb, raw);
            let d = [
                (vr as i32 - gq[0] as i32).unsigned_abs(),
                (vg as i32 - gq[1] as i32).unsigned_abs(),
                (vb as i32 - gq[2] as i32).unsigned_abs(),
            ];
            max_err = max_err.max(d[0].max(d[1]).max(d[2]));
        }
    }
    (max_err, g.len())
}

#[test]
fn solid_and_gradient() {
    let (e, _) = conform(
        "uniform vec3 col : color = 0.9, 0.3, 0.1;\nvec3 shade(Led led) { return col * led.pos.y; }",
        Profile::ExactInt,
    );
    assert!(e <= TOL, "gradient max err {e}");
}

#[test]
fn trig_radial() {
    let src = "uniform float speed : 0.0..4.0 = 1.0;\n\
               vec3 shade(Led led) {\n  \
                 float w = 0.5 + 0.5 * sin((led.pos.x + led.pos.z) * 3.0 + time * speed);\n  \
                 return vec3(w, w * w, 1.0 - w);\n}";
    let (e, _) = conform(src, Profile::Native);
    // Native trig: VM uses a LUT sine; GPU/eval use std sin. Still close.
    assert!(e <= 6, "radial trig max err {e}");
}

#[test]
fn hsv_and_palette() {
    let src = "vec3 shade(Led led) {\n  \
                 vec3 c = hsv2rgb(vec3(led.s, 1.0, 1.0));\n  \
                 return mix(c, palette0(led.dist), 0.5);\n}";
    let (e, _) = conform(src, Profile::Native);
    assert!(e <= 6, "hsv/palette max err {e}");
}

#[test]
fn hash_noise_exact_int() {
    // Integer hash must be bit-exact on the ExactInt profile.
    let src = "vec3 shade(Led led) {\n  \
                 float h = hash(led.pos * 8.0);\n  \
                 return vec3(h, h, h);\n}";
    let (e, _) = conform(src, Profile::ExactInt);
    assert_eq!(e, 0, "integer hash must be bit-exact, got {e}");
}

#[test]
fn if_else_branch() {
    let src = "vec3 shade(Led led) {\n  \
                 if (led.pos.y > 0.5) { return vec3(1.0, 0.0, 0.0); }\n  \
                 else { return vec3(0.0, 0.0, 1.0); }\n}";
    let (e, _) = conform(src, Profile::ExactInt);
    assert!(e <= TOL, "if/else max err {e}");
}

#[test]
fn refuses_loops() {
    // A for-loop (back edge) must be refused so it stays on the VM.
    let src = "vec3 shade(Led led) {\n  \
                 float a = 0.0;\n  \
                 for (int i = 0; i < 4; i = i + 1) { a = a + 0.1; }\n  \
                 return vec3(a, a, a);\n}";
    let compiled = ledmapper_fx_compiler::compile(src).expect("compile");
    let prog = vm::Program::parse(&compiled.fxb).expect("parse");
    // A bounded for-loop must be refused (Loop back-edge or the IncLocalI loop
    // idiom) so it stays on the VM — the exact reason doesn't matter, only that
    // it is not silently lowered to a wrong straight-line graph.
    let r = compile_shade(&prog, Profile::ExactInt);
    assert!(r.is_err(), "loops must be refused");
}

#[test]
fn es100_refuses_integer_graph() {
    // The int-hash graph can't go to GLES2; the emitter must say so.
    let src = "vec3 shade(Led led) { float h = hash(led.idx); return vec3(h, h, h); }";
    let compiled = ledmapper_fx_compiler::compile(src).expect("compile");
    let prog = vm::Program::parse(&compiled.fxb).expect("parse");
    let (g, roots, _) = compile_shade(&prog, Profile::ExactInt).expect("lower");
    assert!(emit_glsl::emit(&g, &roots, emit_glsl::Target::Es100Fragment).is_err());
}
