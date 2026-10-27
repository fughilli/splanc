//! Issue #400 range fixes + mat3/mat4: the grammar, the manifest, and the
//! lowering (matrices compile to ordinary vecN bytecode) checked on the real
//! fx_vm against hand-written dot/scale forms, optimized and not.

use ledmapper_fx_compiler::{compile, compile_with, manifest_json, CompileOptions, UiKind};
use ledmapper_fx_vm::{Frame, Led, Program, Vm};

fn manifest(src: &str) -> serde_json::Value {
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {d:?}"));
    let prog = Program::parse(&c.fxb).expect("the device VM accepts the .fxb");
    serde_json::from_slice(prog.manifest).expect("embedded manifest is valid JSON")
}

fn by_name<'a>(m: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    m.as_array().unwrap().iter().find(|u| u["name"] == name).unwrap_or_else(|| panic!("{name}"))
}

fn nums(v: &serde_json::Value) -> Vec<f64> {
    v.as_array().expect("array").iter().map(|x| x.as_f64().unwrap()).collect()
}

fn err_of(src: &str) -> String {
    match compile(src) {
        Ok(_) => panic!("expected a compile error for:\n{src}"),
        Err(d) => d[0].msg.clone(),
    }
}

const SHADE: &str = "vec3 shade(Led led) { return vec3(0.0); }";

// -- #400: signed ranges, vector ranges ---------------------------------------

#[test]
fn signed_scalar_range_and_default() {
    let m = manifest(&format!("uniform float x : -2.0 .. 2.0 = -1.5;\nuniform int n : -5..5 = -2;\n{SHADE}"));
    let x = by_name(&m, "x");
    assert_eq!(x["min"], -2.0);
    assert_eq!(x["max"], 2.0);
    assert_eq!(x["ui"]["kind"], "slider");
    assert_eq!(x["ui"]["min"], -2.0);
    assert_eq!(x["default"][0], -1.5);
    assert_eq!(by_name(&m, "n")["min"], -5.0);
    assert_eq!(by_name(&m, "n")["default"][0], -2.0);
}

#[test]
fn ranged_vectors_are_numeric_not_colour() {
    let m = manifest(&format!(
        "uniform vec4 plane : -5 .. 5 = 0, 1, 0, 0;\n\
         uniform vec3 dir : -1..1 = vec3(0.0, -1.0, 0.0);\n\
         uniform vec3 tint = 1.0, 0.5, 0.0;\n\
         uniform vec4 rgba : color = 1, 1, 1, 1;\n\
         uniform vec2 off = 0.5;\n{SHADE}"
    ));
    for name in ["plane", "dir"] {
        let u = by_name(&m, name);
        assert_eq!(u["ui"]["kind"], "slider", "{name}");
        assert!(u["min"].as_f64().unwrap() < 0.0, "{name}");
    }
    assert_eq!(nums(&by_name(&m, "dir")["default"]), [0.0, -1.0, 0.0]);
    // Unranged vec3/vec4 keep today's colour default exactly; vec2 its 0..1 slider.
    assert_eq!(by_name(&m, "tint")["ui"]["kind"], "color");
    assert_eq!(by_name(&m, "tint")["min"], 0.0);
    assert_eq!(by_name(&m, "rgba")["ui"]["kind"], "color");
    let off = &by_name(&m, "off")["ui"];
    assert_eq!(off["kind"], "slider");
    assert_eq!((off["min"].as_f64(), off["max"].as_f64()), (Some(0.0), Some(1.0)));
}

#[test]
fn old_manifests_are_byte_identical() {
    // No range on a vector: exactly the manifest earlier compilers emitted.
    let c = compile(&format!("uniform vec3 tint = 1.0, 0.5, 0.0;\nuniform float k : 0..5 = 1.0;\n{SHADE}")).unwrap();
    assert_eq!(
        manifest_json(&c.uniforms),
        r#"[{"name":"tint","slot":0,"width":3,"ui":{"kind":"color"},"default":[1,0.5,0],"min":0,"max":1},{"name":"k","slot":3,"width":1,"ui":{"kind":"slider","min":0,"max":5,"step":0.05},"default":[1],"min":0,"max":5}]"#
    );
}

#[test]
fn per_component_vector_range() {
    let src = format!("uniform vec3 p : vec3(-1, -1, 0) .. vec3(1, 1, 2) = vec3(0.0);\n{SHADE}");
    let c = compile(&src).unwrap();
    let u = &c.uniforms[0];
    assert_eq!(u.comp_range, Some((vec![-1.0, -1.0, 0.0], vec![1.0, 1.0, 2.0])));
    assert!(matches!(u.ui, UiKind::Slider { min, max, .. } if min == -1.0 && max == 2.0));
    let m = manifest(&src);
    let p = by_name(&m, "p");
    assert_eq!(nums(&p["mins"]), [-1.0, -1.0, 0.0]);
    assert_eq!(nums(&p["maxs"]), [1.0, 1.0, 2.0]);
    assert_eq!((p["min"].as_f64(), p["max"].as_f64()), (Some(-1.0), Some(2.0)));
    // A broadcast bound and a mismatch.
    assert!(compile(&format!("uniform vec2 q : vec2(-1) .. vec2(1, 3) = 0.0;\n{SHADE}")).is_ok());
    assert!(err_of(&format!("uniform vec3 q : vec3(-1, 0) .. vec3(1) = 0.0;\n{SHADE}")).contains("3 components"));
    assert!(err_of(&format!("uniform vec3 q : vec3(1) .. vec3(0) = 0.0;\n{SHADE}")).contains("exceed"));
    assert!(err_of(&format!("uniform float q : 2 .. -2 = 0.0;\n{SHADE}")).contains("exceed"));
}

#[test]
fn atan_one_and_two_args() {
    let src = r#"
        state float a; state float b; state float c; state float d;
        void update() { a = atan(0.5); b = atan2(0.5, 1.0); c = atan(-1.0, -1.0); d = atan2(-1.0, -1.0); }
        vec3 shade(Led led) { return vec3(0.0); }
    "#;
    let st = run_update(src, &[]);
    assert!((st[0] - 0.5f32.atan()).abs() < 1e-3, "{}", st[0]);
    assert_eq!(st[0], st[1]);
    assert_eq!(st[2], st[3]);
}

// -- mat3 / mat4 --------------------------------------------------------------

#[test]
fn mat_uniform_manifest() {
    let m = manifest(&format!(
        "uniform mat4 pose;\nuniform mat3 rot : -1 .. 1 = mat3(2.0);\nuniform mat4 xf : -10..10 = mat4(1.0);\n{SHADE}"
    ));
    let pose = by_name(&m, "pose");
    assert_eq!(pose["width"], 16);
    assert_eq!(pose["ui"]["kind"], "matrix");
    assert_eq!(pose["min"], -1000.0);
    let id: Vec<f64> = (0..16).map(|i| if i % 5 == 0 { 1.0 } else { 0.0 }).collect();
    assert_eq!(nums(&pose["default"]), id);
    let rot = by_name(&m, "rot");
    assert_eq!((rot["width"].as_u64(), rot["slot"].as_u64()), (Some(9), Some(16)));
    assert_eq!(nums(&rot["default"]), [2.0, 0.0, 0.0, 0.0, 2.0, 0.0, 0.0, 0.0, 2.0]);
    assert_eq!((rot["min"].as_f64(), rot["max"].as_f64()), (Some(-1.0), Some(1.0)));
    assert_eq!(by_name(&m, "xf")["slot"], 25);
    // The device's OSC table resolves the full matrix width.
    let c = compile(&format!("uniform mat4 pose;\n{SHADE}")).unwrap();
    let t = ledmapper_osc::parse_manifest(manifest_json(&c.uniforms).as_bytes());
    assert_eq!(t.resolve("pose").map(|p| p.width), Some(16));
}

/// Run update() once (with `uniforms` set by slot) and return the state slots,
/// for every optimizer/memo configuration — which must all agree.
fn run_update(src: &str, uniforms: &[(usize, &[f32])]) -> Vec<f32> {
    let configs = [
        CompileOptions { optimize: false, memo: None },
        CompileOptions { optimize: true, memo: None },
        CompileOptions::default(),
    ];
    let mut out: Option<Vec<f32>> = None;
    for opts in &configs {
        let c = compile_with(src, opts).unwrap_or_else(|d| panic!("compile error: {d:?}"));
        let prog = Program::parse(&c.fxb).expect("parse");
        let mut vm = Vm::new();
        for u in &c.uniforms {
            vm.set_uniform(u.slot as usize, &u.default);
        }
        for (slot, v) in uniforms {
            vm.set_uniform(*slot, v);
        }
        vm.run_update(&prog, &Frame::default());
        let st = vm.state[..48].to_vec();
        if let Some(prev) = &out {
            assert_eq!(prev, &st, "optimizer config {opts:?} changed the result");
        }
        out = Some(st);
    }
    out.unwrap()
}

/// A non-trivial pose: rotation about y by 30°, scale 1, translation (1, -2, 0.5),
/// with a nonzero bottom row so a wrong row/column order shows up.
fn pose() -> [f32; 16] {
    let (s, c) = (0.5f32, 0.866_025_4f32);
    [c, 0.1, -s, 0.2, 0.3, 1.0, 0.4, 0.5, s, -0.6, c, 0.7, 1.0, -2.0, 0.5, 1.0]
}

fn mul4(m: &[f32; 16], v: [f32; 4]) -> [f32; 4] {
    let mut r = [0.0; 4];
    for (row, out) in r.iter_mut().enumerate() {
        *out = (0..4).map(|k| m[k * 4 + row] * v[k]).sum();
    }
    r
}

fn close(a: &[f32], b: &[f32]) {
    assert_eq!(a.len(), b.len());
    for (x, y) in a.iter().zip(b) {
        assert!((x - y).abs() < 1e-4, "{a:?} != {b:?}");
    }
}

#[test]
fn mat_vec_matches_hand_written_dot_form() {
    // mv = pose * v, hand = the same thing written with dot()s of the rows.
    let src = r#"
        uniform mat4 pose;
        uniform vec4 v : -10..10 = 0.0;
        state vec4 mv;
        state vec4 hand;
        state vec4 vm_;
        state vec4 hand2;
        void update() {
            mv = pose * v;
            vec4 r0 = vec4(pose[0].x, pose[1].x, pose[2].x, pose[3].x);
            vec4 r1 = vec4(pose[0].y, pose[1].y, pose[2].y, pose[3].y);
            vec4 r2 = vec4(pose[0][2], pose[1][2], pose[2][2], pose[3][2]);
            vec4 r3 = vec4(pose[0][3], pose[1][3], pose[2][3], pose[3][3]);
            hand = vec4(dot(r0, v), dot(r1, v), dot(r2, v), dot(r3, v));
            vm_ = v * pose;
            hand2 = vec4(dot(v, pose[0]), dot(v, pose[1]), dot(v, pose[2]), dot(v, pose[3]));
        }
        vec3 shade(Led led) { return vec3(0.0); }
    "#;
    let v = [0.7f32, -1.3, 2.1, 1.0];
    let st = run_update(src, &[(0, &pose()), (16, &v)]);
    close(&st[0..4], &mul4(&pose(), v));
    close(&st[0..4], &st[4..8]);
    close(&st[8..12], &st[12..16]);
}

#[test]
fn mat_ops_lower_correctly() {
    let src = r#"
        uniform mat4 a;
        uniform mat4 b : -5..5 = mat4(2.0);
        state mat4 ab;       // 0
        state mat4 at;       // 16
        void update() {
            ab = a * b;
            at = transpose(a);
        }
        vec3 shade(Led led) { return vec3(0.0); }
    "#;
    let a = pose();
    let b: [f32; 16] = core::array::from_fn(|i| (i as f32 * 0.37).sin());
    let st = run_update(src, &[(0, &a), (16, &b)]);
    // a*b column j = a * b[:, j]
    for j in 0..4 {
        let col = mul4(&a, [b[j * 4], b[j * 4 + 1], b[j * 4 + 2], b[j * 4 + 3]]);
        close(&st[j * 4..j * 4 + 4], &col);
    }
    for c in 0..4 {
        for r in 0..4 {
            assert_eq!(st[16 + c * 4 + r], a[r * 4 + c]);
        }
    }
}

#[test]
fn mat_misc_ops() {
    let src = r#"
        uniform mat4 a;
        uniform vec3 p : -10..10 = 0.0;
        state vec3 t1;       // 0  transform(a, p)
        state vec3 t2;       // 3  (a * vec4(p, 1.0)).xyz
        state mat4 s;        // 6  2*a - a/2 + (-a)
        state mat3 m3;       // 22 mat3(a)
        state vec4 c4;       // 31 mat4(m3)[3]
        state float e;       // 35 one element written through m[c][r]
        state vec4 col;      // 36 a dynamically indexed column of a local copy
        mat4 twice(mat4 m) { return m * 2; }
        void update() {
            t1 = transform(a, p);
            t2 = (a * vec4(p, 1.0)).xyz;
            s = twice(a) - a / 2.0 + (-a);
            m3 = mat3(a);
            mat4 back = mat4(m3);
            c4 = back[3];
            mat4 l;
            l[2][1] = a[2][1] + 1.0;
            e = l[2][1];
            int i = 1;
            mat4 la = a;
            col = la[i];
        }
        vec3 shade(Led led) { return vec3(0.0); }
    "#;
    let a = pose();
    let p = [1.5f32, -0.25, 3.0];
    let st = run_update(src, &[(0, &a), (16, &p)]);
    let full = mul4(&a, [p[0], p[1], p[2], 1.0]);
    close(&st[0..3], &full[..3]);
    close(&st[3..6], &full[..3]);
    let want: Vec<f32> = a.iter().map(|x| 2.0 * x - x / 2.0 - x).collect();
    close(&st[6..22], &want);
    let m3: Vec<f32> = (0..3).flat_map(|c| a[c * 4..c * 4 + 3].to_vec()).collect();
    close(&st[22..31], &m3);
    close(&st[31..35], &[0.0, 0.0, 0.0, 1.0]);
    close(&st[35..36], &[a[2 * 4 + 1] + 1.0]);
    close(&st[36..40], &a[4..8]);
}

#[test]
fn mat_constructors() {
    let src = r#"
        state mat3 d;   // 0
        state mat3 c;   // 9
        state mat3 f;   // 18
        void update() {
            d = mat3(3);
            c = mat3(vec3(1.0, 2.0, 3.0), vec3(4.0, 5.0, 6.0), vec3(7.0, 8.0, 9.0));
            f = mat3(1.0, 2.0, 3.0, vec2(4.0, 5.0), 6.0, vec3(7.0, 8.0, 9.0));
        }
        vec3 shade(Led led) { return vec3(0.0); }
    "#;
    let st = run_update(src, &[]);
    close(&st[0..9], &[3.0, 0.0, 0.0, 0.0, 3.0, 0.0, 0.0, 0.0, 3.0]);
    let seq: Vec<f32> = (1..=9).map(|x| x as f32).collect();
    close(&st[9..18], &seq);
    close(&st[18..27], &seq);
}

#[test]
fn per_led_pose_transform_matches_dot_form_in_shade() {
    // The plane_slice_pose shape: the LED position through a streamed pose,
    // then a plane test; against the same maths written without matrices.
    let lowered = r#"
        uniform mat4 pose;
        uniform vec4 plane : -5..5 = 0.0, 1.0, 0.0, 0.0;
        vec3 shade(Led led) {
            vec3 p = transform(pose, led.pos);
            float d = abs(dot(plane.xyz, p) - plane.w);
            return vec3(clamp(1.0 - d, 0.0, 1.0), fract(p.x), fract(p.z));
        }
    "#;
    let hand = r#"
        uniform vec4 c0 : -9..9 = 0.0; uniform vec4 c1 : -9..9 = 0.0;
        uniform vec4 c2 : -9..9 = 0.0; uniform vec4 c3 : -9..9 = 0.0;
        uniform vec4 plane : -5..5 = 0.0, 1.0, 0.0, 0.0;
        vec3 shade(Led led) {
            vec3 p = c0.xyz * led.pos.x + c1.xyz * led.pos.y + c2.xyz * led.pos.z + c3.xyz;
            float d = abs(dot(plane.xyz, p) - plane.w);
            return vec3(clamp(1.0 - d, 0.0, 1.0), fract(p.x), fract(p.z));
        }
    "#;
    let a = compile(lowered).unwrap();
    let h = compile(hand).unwrap();
    let (pa, ph) = (Program::parse(&a.fxb).unwrap(), Program::parse(&h.fxb).unwrap());
    let (mut va, mut vh) = (Vm::new(), Vm::new());
    let plane = [0.0f32, 0.8, 0.6, -0.4];
    va.set_uniform(0, &pose());
    va.set_uniform(16, &plane);
    vh.set_uniform(0, &pose());
    vh.set_uniform(16, &plane);
    let f = Frame::default();
    va.run_update(&pa, &f);
    vh.run_update(&ph, &f);
    for i in 0..40 {
        let t = i as f32 * 0.173;
        let led = Led { pos: [t.sin() * 1.3, t.cos() * 0.7 - 0.2, (t * 2.0).sin()], idx: i, ..Default::default() };
        assert_eq!(va.run_shade(&pa, &f, &led), vh.run_shade(&ph, &f, &led), "led {i}");
    }
}

#[test]
fn mat_errors_are_clear() {
    let e = err_of("uniform mat4 m; vec3 shade(Led led) { vec4 v = m * led.pos; return v.xyz; }");
    assert!(e.contains("dimension mismatch") && e.contains("transform(m, p)"), "{e}");
    let e = err_of("uniform mat4 m; vec3 shade(Led led) { return sin(m)[0].xyz; }");
    assert!(e.contains("does not take a matrix"), "{e}");
    let e = err_of("vec3 shade(Led led) { mat3 m = mat3(1.0, 2.0); return m[0]; }");
    assert!(e.contains("needs 1 scalar"), "{e}");
    let e = err_of("uniform mat4 m; vec3 shade(Led led) { int i = 1; return m[i].xyz; }");
    assert!(e.contains("indexed by a constant"), "{e}");
    let e = err_of("uniform mat4 m : color; vec3 shade(Led led) { return vec3(0.0); }");
    assert!(e.contains("cannot be a colour"), "{e}");
    let e = err_of("uniform mat3 m = 1, 2; vec3 shade(Led led) { return vec3(0.0); }");
    assert!(e.contains("column-major"), "{e}");
    let e = err_of("uniform mat3 a; uniform mat4 b; vec3 shade(Led led) { mat4 c = a * b; return c[0].xyz; }");
    assert!(e.contains("sizes differ"), "{e}");
    let e = err_of("uniform mat4 m; uniform mat4 q; vec3 shade(Led led) { if (m == q) { return vec3(1.0); } return vec3(0.0); }");
    assert!(e.contains("not supported"), "{e}");
    // 128 uniform slots is the VM's limit.
    let many: String = (0..9).map(|i| format!("uniform mat4 m{i};\n")).collect();
    assert!(err_of(&format!("{many}{SHADE}")).contains("uniform slots"));
}

#[test]
fn plane_slice_pose_example_premultiply_matches_per_led_transform() {
    // The skill example pre-multiplies the world plane into the fixture frame in
    // update(); it must light exactly the LEDs a per-LED transform would.
    let example = include_str!("../../agent/skill/examples/plane_slice_pose.fx");
    let per_led = r#"
        uniform mat4  pose;
        uniform vec4  plane : vec4(-1, -1, -1, -5) .. vec4(1, 1, 1, 5) = 0.0, 1.0, 0.0, 1.0;
        uniform float width : 0.01 .. 1.0 = 0.15;
        uniform vec3  glow = 1.0, 0.45, 0.1;
        vec3 shade(Led led) {
            vec3 n = normalize(plane.xyz);
            float d = abs(dot(n, transform(pose, led.pos)) - plane.w);
            float k = 1.0 - smoothstep(0.0, width, d);
            return glow * (k * k);
        }
    "#;
    let (s, c) = (0.6f32, 0.8f32); // rigid: rotation about y + translation
    let pose = [c, 0.0, -s, 0.0, 0.0, 1.0, 0.0, 0.0, s, 0.0, c, 0.0, 0.4, -0.3, 1.2, 1.0];
    let plane = [0.0f32, -0.6, 0.8, 0.9];
    let a = compile(example).unwrap();
    let b = compile(per_led).unwrap();
    let (pa, pb) = (Program::parse(&a.fxb).unwrap(), Program::parse(&b.fxb).unwrap());
    let (mut va, mut vb) = (Vm::new(), Vm::new());
    for (vm, comp) in [(&mut va, &a), (&mut vb, &b)] {
        for u in &comp.uniforms {
            vm.set_uniform(u.slot as usize, &u.default);
        }
        vm.set_uniform(0, &pose);
        vm.set_uniform(16, &plane);
    }
    let f = Frame::default();
    va.run_update(&pa, &f);
    vb.run_update(&pb, &f);
    let mut lit = 0;
    for i in 0..200 {
        let t = i as f32 * 0.031;
        let led = Led { pos: [t.sin() * 1.5, t * 0.4 - 1.0, (t * 1.7).cos()], idx: i, ..Default::default() };
        let (x, y) = (va.run_shade(&pa, &f, &led), vb.run_shade(&pb, &f, &led));
        let close = |p: u8, q: u8| (p as i16 - q as i16).abs() <= 1;
        assert!(close(x.0, y.0) && close(x.1, y.1) && close(x.2, y.2), "led {i}: {x:?} vs {y:?}");
        lit += (x.0 > 0) as u32;
    }
    assert!(lit > 5, "the slice crosses the test LEDs ({lit})");
}
