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
fn reports_errors() {
    assert!(compile("vec3 shade(Led led) { return nope(); }").is_err());
    assert!(compile("float x = 1;").is_err()); // no shade()
}
