//! End-to-end: compile GLSL-ish source → `.fxb` → run on the real fx_vm.

use ledmapper_fx_compiler::{compile, manifest_json, UiKind};
use ledmapper_fx_vm::{Frame, Led, Program, Vm};

fn run_shade(src: &str, uniforms: &[(u8, &[f32])], led: Led, frame: Frame) -> (u8, u8, u8) {
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {:?}", d));
    let prog = Program::parse(&c.fxb).expect("parse fxb");
    let mut vm = Vm::new();
    // seed uniform defaults from the manifest
    for u in &c.uniforms {
        vm.set_uniform(u.slot as usize, &u.default);
    }
    for (slot, vals) in uniforms {
        vm.set_uniform(*slot as usize, vals);
    }
    vm.run_shade(&prog, &frame, &led)
}

#[test]
fn simple_uniform_and_ctx() {
    let src = r#"
        uniform float k : 0.0 .. 1.0 = 0.5;
        vec3 shade(Led led) {
            return vec3(k, led.pos.x, 0.0);
        }
    "#;
    let led = Led { pos: [0.4, 0.1, 0.2], ..Default::default() };
    let (r, g, b) = run_shade(src, &[(0, &[0.5])], led, Frame::default());
    assert_eq!((r, g, b), (127, 102, 0));
}

#[test]
fn vec_scale_and_swizzle() {
    // c = vec3(1,0,0); return c * amt;   with amt=0.5 -> (0.5,0,0)
    let src = r#"
        uniform float amt : 0.0 .. 1.0 = 0.5;
        vec3 shade(Led led) {
            vec3 c = vec3(1.0, 0.0, 0.0);
            return c * amt;
        }
    "#;
    let (r, g, b) = run_shade(src, &[(0, &[0.5])], Led::default(), Frame::default());
    assert_eq!((r, g, b), (127, 0, 0));
}

#[test]
fn builtins_and_palette() {
    // moving-band-ish: palette2(fract(led.pos.z))
    let src = r#"
        vec3 shade(Led led) {
            float d = fract(led.pos.z);
            return palette2(d);
        }
    "#;
    // pos.z = 0 -> fract 0 -> rainbow hue 0 -> red
    let led = Led { pos: [0.0, 0.0, 0.0], ..Default::default() };
    let (r, g, b) = run_shade(src, &[], led, Frame::default());
    assert!(r > 200 && g < 40 && b < 40, "want red, got {r},{g},{b}");
}

#[test]
fn if_else_branch() {
    let src = r#"
        uniform float sw : 0.0 .. 1.0 = 0.0;
        vec3 shade(Led led) {
            if (sw > 0.5) {
                return vec3(1.0, 0.0, 0.0);
            } else {
                return vec3(0.0, 1.0, 0.0);
            }
        }
    "#;
    assert_eq!(run_shade(src, &[(0, &[0.9])], Led::default(), Frame::default()), (255, 0, 0));
    assert_eq!(run_shade(src, &[(0, &[0.1])], Led::default(), Frame::default()), (0, 255, 0));
}

#[test]
fn update_evolves_state() {
    let src = r#"
        uniform float speed : 0.0 .. 5.0 = 1.0;
        state float phase;
        void update() { phase = phase + speed * dt; }
        vec3 shade(Led led) { return vec3(phase, 0.0, 0.0); }
    "#;
    let c = compile(src).expect("compile");
    let prog = Program::parse(&c.fxb).expect("parse");
    let mut vm = Vm::new();
    vm.set_uniform(0, &[1.0]); // speed
    let frame = Frame { dt: 0.25, ..Default::default() };
    vm.run_update(&prog, &frame);
    vm.run_update(&prog, &frame); // phase = 0.5
    let (r, _, _) = vm.run_shade(&prog, &frame, &Led::default());
    assert_eq!(r, 127); // 0.5 * 255
}

#[test]
fn uniform_manifest() {
    let src = r#"
        uniform float speed : 0.0 .. 5.0 = 1.0;
        uniform vec3 tint : color = vec3(1.0, 0.0, 0.0);
        uniform bool on = true;
        uniform int mode : {"a","b","c"} = 1;
        vec3 shade(Led led) { return tint * speed; }
    "#;
    let c = compile(src).expect("compile");
    assert_eq!(c.uniforms.len(), 4);
    assert!(matches!(c.uniforms[0].ui, UiKind::Slider { min, max, .. } if min == 0.0 && max == 5.0));
    assert!(matches!(c.uniforms[1].ui, UiKind::Color));
    assert!(matches!(c.uniforms[2].ui, UiKind::Toggle));
    assert!(matches!(&c.uniforms[3].ui, UiKind::Dropdown(o) if o.len() == 3));
    let j = manifest_json(&c.uniforms);
    assert!(j.contains("\"kind\":\"slider\""));
    assert!(j.contains("\"kind\":\"dropdown\""));
}

#[test]
fn integer_math_native() {
    // int n = 5; return vec3(float(n) / 10.0, 0, 0) -> 0.5 -> 127
    let src = r#"
        vec3 shade(Led led) {
            int n = 5;
            return vec3(float(n) / 10.0, 0.0, 0.0);
        }
    "#;
    assert_eq!(run_shade(src, &[], Led::default(), Frame::default()).0, 127);
}

#[test]
fn fixed_point_math() {
    // pure Q16.16 multiply: 0.5 * 2.0 = 1.0 -> 255
    let src = r#"
        vec3 shade(Led led) {
            fixed f = 0.5;
            fixed h = fixed(2.0);
            fixed g = f * h;
            return vec3(float(g), 0.0, 0.0);
        }
    "#;
    assert_eq!(run_shade(src, &[], Led::default(), Frame::default()).0, 255);
}

#[test]
fn vec_broadcast_both_sides() {
    // vec + scalar (scalar on right)
    let a = r#"vec3 shade(Led led) { vec3 c = vec3(0.2,0.4,0.6); return c + 0.1; }"#;
    assert_eq!(run_shade(a, &[], Led::default(), Frame::default()), (76, 127, 178));
    // scalar - vec (scalar on left; order must be preserved)
    let b = r#"vec3 shade(Led led) { return 1.0 - vec3(0.2,0.4,0.6); }"#;
    assert_eq!(run_shade(b, &[], Led::default(), Frame::default()), (204, 153, 101));
}

#[test]
fn for_loop_accumulate() {
    let src = r#"
        vec3 shade(Led led) {
            float s = 0.0;
            for (int i = 0; i < 4; i = i + 1) {
                s = s + 0.1;
            }
            return vec3(s, 0.0, 0.0);
        }
    "#;
    // 4 * 0.1 = 0.4 -> 102
    assert_eq!(run_shade(src, &[], Led::default(), Frame::default()).0, 102);
}

#[test]
fn user_function_call() {
    let src = r#"
        float sq(float x) { return x * x; }
        vec3 shade(Led led) {
            float d = sq(led.pos.x);
            return vec3(d, 0.0, 0.0);
        }
    "#;
    let led = Led { pos: [0.5, 0.0, 0.0], ..Default::default() };
    // sq(0.5) = 0.25 -> 63
    assert_eq!(run_shade(src, &[], led, Frame::default()).0, 63);
}

#[test]
fn user_function_two_args() {
    let src = r#"
        float lerp(float a, float b) { return (a + b) * 0.5; }
        vec3 shade(Led led) { return vec3(lerp(0.2, 0.8), 0.0, 0.0); }
    "#;
    // (0.2+0.8)/2 = 0.5 -> 127
    assert_eq!(run_shade(src, &[], Led::default(), Frame::default()).0, 127);
}

#[test]
fn doc_int_fixed_hotpath_snippet() {
    // Mirrors the second code sample in docs/design/effects-runtime.md.
    let src = r#"
        vec3 shade(Led led) {
            int   stripe = int(led.pos.x * 8.0) % 3;
            fixed t      = fixed(led.pos.y) * fixed(0.5);
            return vec3(float(stripe) / 2.0, float(t), 0.0);
        }
    "#;
    let led = Led { pos: [0.5, 0.5, 0.0], ..Default::default() };
    // stripe: int(4.0)%3 = 1 -> 0.5 -> 127; t: 0.5*0.5 = 0.25 -> 63
    assert_eq!(run_shade(src, &[], led, Frame::default()), (127, 63, 0));
}

#[test]
fn vec_uniform_bare_list_default() {
    // A color default written as a bare comma list (no vec3(...) wrapper) — the
    // natural way to write a color, and what the editor's default script uses.
    let src = r#"
        uniform vec3 tint : color = 0.2, 0.6, 1.0;
        vec3 shade(Led led) { return tint; }
    "#;
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {:?}", d));
    assert_eq!(c.uniforms.len(), 1);
    assert_eq!(c.uniforms[0].default, vec![0.2, 0.6, 1.0]);
    assert_eq!(
        run_shade(src, &[(0, &[0.2, 0.6, 1.0])], Led::default(), Frame::default()),
        (51, 153, 255),
    );
    // a lone scalar broadcasts across the vector
    let src2 = r#"uniform vec3 g = 0.5; vec3 shade(Led led) { return g; }"#;
    let c2 = compile(src2).unwrap_or_else(|d| panic!("compile error: {:?}", d));
    assert_eq!(c2.uniforms[0].default, vec![0.5, 0.5, 0.5]);
}

#[test]
fn seeded_starter_effects_compile() {
    // The three built-in starter effects the app seeds (web/src/store/seedEffects.ts)
    // MUST compile, or the effects workspace looks broken on first open.
    let rainbow = "uniform float scale : 0.2 .. 4.0 = 1.0;\n\
        uniform float drift : 0.0 .. 2.0 = 0.3;\n\
        void update() {}\n\
        vec3 shade(Led led) {\n\
          float h = fract(led.pos.y * scale + time * drift);\n\
          return hsv2rgb(h, 0.9, 1.0);\n\
        }";
    let breathing = "uniform float rate : 0.1 .. 3.0 = 0.6;\n\
        uniform vec3 base : color = 1.0, 0.3, 0.1;\n\
        state float glow;\n\
        void update() { glow = 0.5 + 0.5 * sin(time * rate); }\n\
        vec3 shade(Led led) { return base * glow; }";
    let comet = "uniform float speed : 0.0 .. 5.0 = 1.0;\n\
        uniform float width : 0.02 .. 0.5 = 0.12;\n\
        uniform vec3 tint : color = 0.2, 0.6, 1.0;\n\
        void update() {}\n\
        vec3 shade(Led led) {\n\
          float phase = fract(led.s - time * speed);\n\
          float band = smoothstep(width, 0.0, abs(phase - 0.5));\n\
          return tint * band;\n\
        }";
    for (name, src) in [("rainbow", rainbow), ("breathing", breathing), ("comet", comet)] {
        compile(src).unwrap_or_else(|d| panic!("starter {name} failed to compile: {:?}", d));
    }
}

#[test]
fn reports_errors() {
    assert!(compile("vec3 shade(Led led) { return nope(); }").is_err());
    assert!(compile("float x = 1;").is_err()); // no shade()
}
