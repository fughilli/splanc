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
    // Topology-aware starters using led.dist (geodesic distance).
    let flood = "uniform float speed : 0.05 .. 2.0 = 0.35;\n\
        uniform float tail : 0.05 .. 0.6 = 0.25;\n\
        uniform vec3 tint : color = 0.2, 0.7, 1.0;\n\
        uniform float rainbow : 0.0 .. 1.0 = 0.0;\n\
        state float front;\n\
        state int started;\n\
        void update() {\n\
          if (started == 0) { started = 1; flood_from(term(0)); front = 0.0; }\n\
          front = front + speed * dt;\n\
          if (front > 1.0 + tail) {\n\
            int tc = term_count();\n\
            int k = 0;\n\
            if (tc > 0) { k = int(hash(float(frame) * 0.017) * float(tc)); }\n\
            if (k >= tc) { k = 0; }\n\
            flood_from(term(k));\n\
            front = 0.0;\n\
          }\n\
        }\n\
        vec3 shade(Led led) {\n\
          float reached = front - led.dist;\n\
          float lit = clamp(1.0 - reached / tail, 0.0, 1.0) * step(0.0, reached);\n\
          vec3 hue = hsv2rgb(led.dist, 0.9, 1.0);\n\
          vec3 col = tint * (1.0 - rainbow) + hue * rainbow;\n\
          return col * lit;\n\
        }";
    let pulse = "uniform float speed : 0.05 .. 2.0 = 0.4;\n\
        uniform float width : 0.02 .. 0.35 = 0.1;\n\
        uniform int agents : 1 .. 6 = 2;\n\
        uniform vec3 tint : color = 1.0, 0.4, 0.1;\n\
        uniform float rainbow : 0.0 .. 1.0 = 1.0;\n\
        state float head;\n\
        void update() { head = time * speed; }\n\
        vec3 shade(Led led) {\n\
          float v = 0.0;\n\
          float inv = 1.0 / float(agents);\n\
          for (int k = 0; k < 6; k = k + 1) {\n\
            if (k < agents) {\n\
              float p = fract(head + float(k) * inv);\n\
              float d = abs(led.dist - p);\n\
              v = max(v, smoothstep(width, 0.0, d));\n\
            }\n\
          }\n\
          vec3 hue = hsv2rgb(led.dist, 0.9, 1.0);\n\
          vec3 col = tint * (1.0 - rainbow) + hue * rainbow;\n\
          return col * v;\n\
        }";
    // Buffer-based starter (per-LED feedback trail persisted in a hidden buffer).
    let trails = "uniform float decay : 0.5 .. 0.98 = 0.85;\n\
        uniform float speed : 0.0 .. 4.0 = 1.2;\n\
        uniform float width : 0.02 .. 0.3 = 0.08;\n\
        uniform vec3 tint : color = 0.2, 0.8, 1.0;\n\
        uniform float rainbow : 0.0 .. 1.0 = 0.6;\n\
        buffer float trail;\n\
        state float head;\n\
        void update() { head = fract(time * speed * 0.2); }\n\
        vec3 shade(Led led) {\n\
          float spark = smoothstep(width, 0.0, abs(led.dist - head));\n\
          float v = max(trail[led.idx] * decay, spark);\n\
          trail[led.idx] = v;\n\
          vec3 hue = hsv2rgb(led.dist, 0.85, 1.0);\n\
          vec3 col = tint * (1.0 - rainbow) + hue * rainbow;\n\
          return col * v;\n\
        }";
    // Texture starter: bake a radial gradient into a 2D texture once, then
    // sample it per-LED by led.uv (pixel-space / texture-mapped).
    let texmap = "texture vec3 tex(24, 24);\n\
        state bool baked;\n\
        uniform vec3 a : color = 0.1, 0.2, 0.8;\n\
        uniform vec3 b : color = 1.0, 0.6, 0.1;\n\
        void update() {\n\
          if (!baked) {\n\
            for (int y = 0; y < 24; y = y + 1) {\n\
              for (int x = 0; x < 24; x = x + 1) {\n\
                float fx = float(x) / 23.0;\n\
                float fy = float(y) / 23.0;\n\
                float d = distance(vec2(fx, fy), vec2(0.5, 0.5)) * 2.0;\n\
                tex[y * 24 + x] = a * (1.0 - d) + b * d;\n\
              }\n\
            }\n\
            baked = true;\n\
          }\n\
        }\n\
        vec3 shade(Led led) { return sample(tex, led.uv); }";
    for (name, src) in [
        ("rainbow", rainbow),
        ("breathing", breathing),
        ("comet", comet),
        ("flood", flood),
        ("pulse", pulse),
        ("trails", trails),
        ("texmap", texmap),
    ] {
        compile(src).unwrap_or_else(|d| panic!("starter {name} failed to compile: {:?}", d));
    }
}

#[test]
fn graph_queries_and_agentic_pulse_compile() {
    // Every graph-query intrinsic typechecks (int args, int/float return).
    let g = "vec3 shade(Led led) {\n\
        int z = 0; int one = 1;\n\
        int n = seg_count();\n\
        int node = seg_node(z, one);\n\
        int d = node_deg(node);\n\
        int ns = node_seg(node, z);\n\
        int sd = node_side(node, z);\n\
        float L = seg_len(z);\n\
        return vec3(float(n + d + ns + sd) * 0.0 + L * 0.0, 0.0, 0.0);\n\
    }";
    compile(g).unwrap_or_else(|d| panic!("graph queries failed: {:?}", d));
    // Non-int graph arg is rejected (led.seg is a float ctx value).
    assert!(compile("vec3 shade(Led led){ float l = seg_len(led.seg); return vec3(l); }").is_err());

    // The agentic-pulse starter: agents walk the graph, choosing a random
    // incident segment at each junction (per-agent path choice).
    let agentic = "uniform float speed : 0.05 .. 2.0 = 0.5;\n\
        uniform float glow : 0.01 .. 0.3 = 0.08;\n\
        uniform int count : 1 .. 8 = 3;\n\
        uniform vec3 tint : color = 0.9, 0.5, 0.1;\n\
        struct Agent { int seg; float s; };\n\
        state Agent ag[8];\n\
        state int started;\n\
        void update() {\n\
          if (started == 0) {\n\
            started = 1;\n\
            int tc = term_count();\n\
            for (int i = 0; i < 8; i = i + 1) {\n\
              int node = term(int(hash(float(i) * 3.7 + 1.0) * float(tc)));\n\
              int sg = node_seg(node, 0);\n\
              if (sg < 0) { sg = i; }\n\
              ag[i].seg = sg;\n\
              ag[i].s = 0.0;\n\
            }\n\
          }\n\
          for (int i = 0; i < 8; i = i + 1) {\n\
            if (i < count) {\n\
              int sg = ag[i].seg;\n\
              float L = seg_len(sg);\n\
              if (L < 0.001) { L = 1.0; }\n\
              float ns = ag[i].s + speed * dt / L;\n\
              if (ns < 1.0) {\n\
                ag[i].s = ns;\n\
              } else {\n\
                int node = seg_node(sg, 1);\n\
                int deg = node_deg(node);\n\
                if (deg > 0) {\n\
                  float r = hash(float(frame) * 0.13 + float(i) * 9.7);\n\
                  int choice = int(r * float(deg));\n\
                  if (choice >= deg) { choice = 0; }\n\
                  ag[i].seg = node_seg(node, choice);\n\
                }\n\
                ag[i].s = 0.0;\n\
              }\n\
            }\n\
          }\n\
        }\n\
        vec3 shade(Led led) {\n\
          float v = 0.0;\n\
          for (int i = 0; i < 8; i = i + 1) {\n\
            if (i < count) {\n\
              if (int(led.seg) == ag[i].seg) {\n\
                float d = abs(led.s - ag[i].s);\n\
                v = max(v, smoothstep(glow, 0.0, d));\n\
              }\n\
            }\n\
          }\n\
          return tint * v;\n\
        }";
    compile(agentic).unwrap_or_else(|d| panic!("agentic pulse failed: {:?}", d));
}

#[test]
fn reports_errors() {
    assert!(compile("vec3 shade(Led led) { return nope(); }").is_err());
    assert!(compile("float x = 1;").is_err()); // no shade()
}

// Run `update()` `updates` times, then shade one LED. For array/struct sims.
fn run_program(src: &str, updates: usize, led: Led, frame: Frame) -> (u8, u8, u8) {
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {:?}", d));
    let prog = Program::parse(&c.fxb).expect("parse fxb");
    let mut vm = Vm::new();
    for u in &c.uniforms {
        vm.set_uniform(u.slot as usize, &u.default);
    }
    for _ in 0..updates {
        vm.run_update(&prog, &frame);
    }
    vm.run_shade(&prog, &frame, &led)
}

#[test]
fn scalar_array_dynamic_index() {
    // A state array seeded once, advanced each frame, read by a dynamic index.
    let src = r#"
        state float xs[3];
        state bool init;
        void update() {
            if (!init) {
                xs[0] = 0.1;
                xs[1] = 0.5;
                xs[2] = 0.9;
                init = true;
            }
            for (int i = 0; i < 3; i = i + 1) {
                xs[i] = xs[i] + 0.25;
            }
        }
        vec3 shade(Led led) {
            int k = int(led.idx);
            return vec3(xs[k], 0.0, 0.0);
        }
    "#;
    // After one update: xs = [0.35, 0.75, 1.15].
    let led0 = Led { idx: 0, ..Default::default() };
    let led1 = Led { idx: 1, ..Default::default() };
    assert_eq!(run_program(src, 1, led0, Frame::default()).0, 89); // 0.35*255
    assert_eq!(run_program(src, 1, led1, Frame::default()).0, 191); // 0.75*255
}

#[test]
fn struct_array_agent_sim() {
    // The headline use case: an array of user structs simulated in update(),
    // read back per-LED in shade() (glow around each agent's position along s).
    let src = r#"
        struct Agent { float pos; vec3 col; };
        state Agent agents[2];
        state bool init;
        void update() {
            if (!init) {
                agents[0].pos = 0.25;
                agents[0].col = vec3(1.0, 0.0, 0.0);
                agents[1].pos = 0.75;
                agents[1].col = vec3(0.0, 1.0, 0.0);
                init = true;
            }
            for (int i = 0; i < 2; i = i + 1) {
                agents[i].pos = agents[i].pos + 0.1;
            }
        }
        vec3 shade(Led led) {
            vec3 c = vec3(0.0, 0.0, 0.0);
            for (int i = 0; i < 2; i = i + 1) {
                float d = abs(led.s - agents[i].pos);
                float glow = smoothstep(0.1, 0.0, d);
                c = c + agents[i].col * glow;
            }
            return c;
        }
    "#;
    // After one update agents are at pos 0.35 (red) and 0.85 (green).
    // An LED at s=0.35 lands exactly on agent 0 -> full red, no green.
    assert_eq!(run_program(src, 1, Led { s: 0.35, ..Default::default() }, Frame::default()), (255, 0, 0));
    // An LED at s=0.85 lands on agent 1 -> full green.
    assert_eq!(run_program(src, 1, Led { s: 0.85, ..Default::default() }, Frame::default()), (0, 255, 0));
    // Midway (s=0.6) is >0.1 from both -> dark.
    assert_eq!(run_program(src, 1, Led { s: 0.6, ..Default::default() }, Frame::default()), (0, 0, 0));
}

#[test]
fn whole_struct_copy_and_static_index() {
    // Whole-struct assignment (block copy) + constant array index.
    let src = r#"
        struct P { vec3 col; float k; };
        state P slots[2];
        void update() {
            P a;
            a.col = vec3(0.2, 0.4, 0.6);
            a.k = 1.0;
            slots[0] = a;
            slots[1] = slots[0];
        }
        vec3 shade(Led led) { return slots[1].col; }
    "#;
    assert_eq!(run_program(src, 1, Led::default(), Frame::default()), (51, 102, 153));
}

#[test]
fn array_struct_error_cases() {
    // Index out of range (constant).
    assert!(compile("state float xs[2]; vec3 shade(Led led) { return vec3(xs[5], 0.0, 0.0); }").is_err());
    // Indexing a non-array.
    assert!(compile("state float x; vec3 shade(Led led) { return vec3(x[0], 0.0, 0.0); }").is_err());
    // Unknown struct field.
    assert!(compile(
        "struct A { float p; }; state A a; vec3 shade(Led led) { return vec3(a.q, 0.0, 0.0); }"
    )
    .is_err());
    // Array field inside a struct is not supported yet.
    assert!(compile("struct A { float xs[2]; }; vec3 shade(Led led) { return vec3(0.0,0.0,0.0); }").is_err());
    // Two dynamic indices in one access path (needs a 2D address).
    assert!(compile(
        "struct A { float p; }; state A a[2]; vec3 shade(Led led) { int i = int(led.idx); return vec3(a[i].p, 0.0, 0.0); }"
    )
    .is_ok()); // one dynamic index is fine
}

#[test]
fn buffer_trails_persist_per_led() {
    // A hidden LED-arity buffer read+written in shade() via led.idx: each LED's
    // slot decays and accumulates across frames (the "Trails" pattern). This
    // exercises the `buffer` grammar, LoadBuf/StoreBuf, the .fxb buffer table,
    // and the VM arena end to end.
    let src = r#"
        buffer float trail;
        vec3 shade(Led led) {
            float v = trail[led.idx] * 0.5 + 0.2;
            trail[led.idx] = v;
            return vec3(v, 0.0, 0.0);
        }
    "#;
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {:?}", d));
    let prog = Program::parse(&c.fxb).expect("parse fxb");
    // Buffer table present with one LED-arity (kind 0) float (elem 1) buffer.
    assert_eq!(prog.n_buffers, 1);
    let d = prog.buf_desc(0).expect("buf desc");
    assert_eq!((d.kind, d.elem), (0, 1));

    let led_count = 4usize;
    let mut arena = vec![0.0f32; prog.arena_slots(led_count)];
    assert_eq!(arena.len(), led_count); // 1 slot/elem * 4 LEDs

    let mut vm = Vm::new();
    vm.set_arena(&mut arena);
    let frame = Frame { led_count: led_count as u32, ..Frame::default() };
    let led = Led::default(); // idx 0
    // frame 1: v = 0*0.5 + 0.2 = 0.2 -> 51
    let (r1, _, _) = vm.run_shade(&prog, &frame, &led);
    // frame 2: v = 0.2*0.5 + 0.2 = 0.3 -> 76 (proves the write persisted)
    let (r2, _, _) = vm.run_shade(&prog, &frame, &led);
    assert_eq!(r1, (0.2f32 * 255.0) as u8);
    assert_eq!(r2, (0.3f32 * 255.0) as u8);
    assert!(r2 > r1, "trail should accumulate across frames");
}

#[test]
fn buffer_misuse_errors() {
    // A buffer must be indexed.
    assert!(compile("buffer float b; vec3 shade(Led led) { return vec3(b, 0.0, 0.0); }").is_err());
    // Cannot whole-assign a buffer.
    assert!(
        compile("buffer float b; void update() { b = 1.0; } vec3 shade(Led led) { return vec3(0.0,0.0,0.0); }")
            .is_err()
    );
    // Element type must be a scalar/vec.
    assert!(compile("buffer bool b; vec3 shade(Led led) { return vec3(0.0,0.0,0.0); }").is_err());
    // A vec3 buffer round-trips (elem 3).
    let c = compile(
        "buffer vec3 c; vec3 shade(Led led) { c[led.idx] = vec3(1.0,0.0,0.0); return c[led.idx]; }",
    )
    .expect("vec3 buffer compiles");
    let prog = Program::parse(&c.fxb).unwrap();
    assert_eq!(prog.buf_desc(0).unwrap().elem, 3);
}

#[test]
fn texture_sample_bilinear() {
    // A 2x1 float texture holding [0, 1]; sampling led.uv.x interpolates.
    let src = r#"
        texture float grad(2, 1);
        void update() { grad[0] = 0.0; grad[1] = 1.0; }
        vec3 shade(Led led) { float v = sample(grad, led.uv); return vec3(v, v, v); }
    "#;
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {:?}", d));
    let prog = Program::parse(&c.fxb).expect("parse fxb");
    let d = prog.buf_desc(0).expect("buf desc");
    assert_eq!((d.kind, d.elem, d.w, d.h), (1, 1, 2, 1)); // 2D texture, 2x1

    let led_count = 4usize;
    let mut arena = vec![0.0f32; prog.arena_slots(led_count)];
    assert_eq!(arena.len(), 2); // elem*w*h, independent of led_count
    let mut vm = Vm::new();
    vm.set_arena(&mut arena);
    let frame = Frame { led_count: led_count as u32, ..Frame::default() };
    vm.run_update(&prog, &frame); // grad = [0, 1]

    let at = |ux: f32| {
        vm.run_shade(&prog, &frame, &Led { uv: [ux, 0.0], ..Led::default() }).0
    };
    assert_eq!(at(0.0), 0); // edge -> texel 0
    assert_eq!(at(1.0), 255); // edge -> texel 1
    assert_eq!(at(0.5), 127); // midpoint -> bilinear 0.5
}

#[test]
fn texture_paint_round_trips() {
    // paint a texel via uv, then sample the same uv back (same frame).
    let src = r#"
        texture vec3 img(4, 4);
        void update() {}
        vec3 shade(Led led) {
            paint(img, vec2(0.0, 0.0), vec3(1.0, 0.5, 0.25));
            return sample(img, vec2(0.0, 0.0));
        }
    "#;
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {:?}", d));
    let prog = Program::parse(&c.fxb).expect("parse fxb");
    assert_eq!(prog.buf_desc(0).unwrap().elem, 3);
    let mut arena = vec![0.0f32; prog.arena_slots(8)];
    let mut vm = Vm::new();
    vm.set_arena(&mut arena);
    let frame = Frame { led_count: 8, ..Frame::default() };
    let (r, g, b) = vm.run_shade(&prog, &frame, &Led::default());
    assert_eq!((r, g, b), (255, 127, 63)); // 1.0, 0.5, 0.25
}

#[test]
fn texture_misuse_errors() {
    // sample() on a non-texture buffer.
    assert!(compile(
        "buffer float b; vec3 shade(Led led) { return vec3(sample(b, led.uv), 0.0, 0.0); }"
    )
    .is_err());
    // Bad dimensions.
    assert!(compile("texture float t(0, 4); vec3 shade(Led led) { return vec3(0.0,0.0,0.0); }").is_err());
    // A value-returning call used as a bare statement is rejected.
    assert!(compile(
        "texture float t(2, 2); void update() { sample(t, vec2(0.0,0.0)); } vec3 shade(Led led) { return vec3(0.0,0.0,0.0); }"
    )
    .is_err());
}

#[test]
fn preview_flow_flood_animates_and_texture_lights() {
    // Mirrors the browser preview's update()->shade() loop to guard against a
    // VM/preview regression (the symptoms a stale cached wasm would also show).
    // FLOOD: with topology (varying led.dist), the output must change over time.
    let flood = "uniform float rate : 0.05 .. 2.0 = 0.35;\n\
        uniform float edge : 0.02 .. 0.4 = 0.12;\n\
        uniform vec3 tint : color = 0.2, 0.7, 1.0;\n\
        uniform float rainbow : 0.0 .. 1.0 = 0.0;\n\
        state float front;\n\
        void update() { front = fract(time * rate); }\n\
        vec3 shade(Led led) {\n\
          float lit = 1.0 - smoothstep(front, front + edge, led.dist);\n\
          return tint * lit;\n\
        }";
    let c = compile(flood).unwrap_or_else(|d| panic!("flood: {:?}", d));
    let prog = Program::parse(&c.fxb).unwrap();
    let mut vm = Vm::new();
    for u in &c.uniforms {
        vm.set_uniform(u.slot as usize, &u.default);
    }
    let leds: Vec<Led> = (0..10)
        .map(|i| Led { dist: i as f32 / 9.0, idx: i, ..Default::default() })
        .collect();
    let frame_at = |vm: &mut Vm, t: f32| -> Vec<(u8, u8, u8)> {
        let f = Frame { time: t, dt: 0.033, led_count: 10, ..Default::default() };
        vm.run_update(&prog, &f);
        leds.iter().map(|l| vm.run_shade(&prog, &f, l)).collect()
    };
    let a = frame_at(&mut vm, 0.0);
    let b = frame_at(&mut vm, 0.6);
    assert_ne!(a, b, "flood must evolve over time with topology");

    // TEXTURE-MAP: after the bake, sampling led.uv must be lit (not all dark).
    let texmap = "texture vec3 tex(24, 24);\n\
        state bool baked;\n\
        uniform vec3 a : color = 0.1, 0.2, 0.8;\n\
        uniform vec3 b : color = 1.0, 0.6, 0.1;\n\
        void update() {\n\
          if (!baked) {\n\
            for (int y = 0; y < 24; y = y + 1) {\n\
              for (int x = 0; x < 24; x = x + 1) {\n\
                float fx = float(x) / 23.0;\n\
                float fy = float(y) / 23.0;\n\
                float d = distance(vec2(fx, fy), vec2(0.5, 0.5)) * 2.0;\n\
                tex[y * 24 + x] = a * (1.0 - d) + b * d;\n\
              }\n\
            }\n\
            baked = true;\n\
          }\n\
        }\n\
        vec3 shade(Led led) { return sample(tex, led.uv); }";
    let c2 = compile(texmap).unwrap_or_else(|d| panic!("texmap: {:?}", d));
    let prog2 = Program::parse(&c2.fxb).unwrap();
    let mut vm2 = Vm::new();
    for u in &c2.uniforms {
        vm2.set_uniform(u.slot as usize, &u.default);
    }
    let mut arena = vec![0.0f32; prog2.arena_slots(64)];
    // Mirror the wasm: bind the arena on update, bake on the first frame.
    for f in 0..2u32 {
        let frame = Frame { time: f as f32 * 0.033, dt: 0.033, frame: f, led_count: 64, ..Default::default() };
        vm2.set_arena(&mut arena);
        vm2.run_update(&prog2, &frame);
    }
    let frame = Frame { led_count: 64, ..Default::default() };
    let lit = vm2.run_shade(&prog2, &frame, &Led { uv: [0.5, 0.5], ..Default::default() });
    assert!(
        lit.0 as u32 + lit.1 as u32 + lit.2 as u32 > 0,
        "texture sample must be lit after the bake, got {lit:?}"
    );
}

#[test]
fn flood_from_reseats_the_geodesic_source() {
    // Chain graph: leafA(10) --seg0-- junction(0) --seg1-- leafB(11). Termini are
    // the two deg-1 leaves. flood_from(term(0)=10) makes an LED at leafA read
    // dist 0; flood_from(term(1)=11) makes the SAME LED read dist 1 — proving the
    // source is settable (what Flood needs to start from different endpoints).
    let src = r#"
        uniform int pick : 0 .. 3 = 0;
        void update() { flood_from(term(pick)); }
        vec3 shade(Led led) { return vec3(led.dist, 0.0, 0.0); }
    "#;
    let c = compile(src).unwrap_or_else(|d| panic!("compile: {:?}", d));
    let prog = Program::parse(&c.fxb).unwrap();
    let mut vm = Vm::new();
    vm.set_graph(&[1.0, 1.0], &[10, 0], &[0, 11]);
    let frame = Frame { led_count: 1, ..Default::default() };
    let led_a = Led { seg: 0, s: 0.0, idx: 0, ..Default::default() }; // sits at leafA
    // Flood from term 0 (leafA): distance 0 there.
    vm.set_uniform(0, &[f32::from_bits(0)]); // pick = 0 (int bits)
    vm.run_update(&prog, &frame);
    let d0 = vm.run_shade(&prog, &frame, &led_a).0;
    // Flood from term 1 (leafB): leafA is now the far end → distance ~1.
    vm.set_uniform(0, &[f32::from_bits(1)]);
    vm.run_update(&prog, &frame);
    let d1 = vm.run_shade(&prog, &frame, &led_a).0;
    assert_eq!(d0, 0, "flooding from leafA, leafA is at distance 0");
    assert_eq!(d1, 255, "flooding from leafB, leafA is the far end (dist 1)");
}

// --- reduced-precision embedded types (FUG-10) -------------------------------

#[test]
fn fixed16_arithmetic() {
    // Q1.14 multiply through the language: 0.5 * 1.5 = 0.75 -> 191.
    let src = r#"
        vec3 shade(Led led) {
            fixed16 a = fixed16(0.5);
            fixed16 b = fixed16(1.5);
            fixed16 c = a * b;
            return vec3(float(c), 0.0, 0.0);
        }
    "#;
    let got = run_shade(src, &[], Led::default(), Frame::default()).0;
    assert!((got as i32 - 191).abs() <= 2, "0.5*1.5 in fixed16: {got}");
}

#[test]
fn fixed8_arithmetic() {
    // Q1.6 add/mul: (0.25 + 0.25) * 1.0 = 0.5 -> ~127 (coarser format).
    let src = r#"
        vec3 shade(Led led) {
            fixed8 a = fixed8(0.25);
            fixed8 s = (a + a) * fixed8(1.0);
            return vec3(float(s), 0.0, 0.0);
        }
    "#;
    let got = run_shade(src, &[], Led::default(), Frame::default()).0;
    assert!((got as i32 - 127).abs() <= 5, "fixed8 arithmetic: {got}");
}

#[test]
fn fixed16_sin_dispatches_to_integer_opcode() {
    // sin on a fixed16 argument must compile to the pure-integer SIN_FIX opcode
    // (no UN_MATH / soft-float) and produce the right value. sin(0.25 turn)=1.
    let src = r#"
        vec3 shade(Led led) {
            fixed16 phase = fixed16(0.25);
            fixed16 s = sin(phase);
            return vec3(float(s), 0.0, 0.0);
        }
    "#;
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {:?}", d));
    let dis = ledmapper_fx_compiler::disassemble(&c.fxb);
    assert!(dis.contains("SIN_FIX frac=14"), "expected SIN_FIX in:\n{dis}");
    assert!(!dis.contains("UN_MATH sin"), "sin(fixed16) must not use the float path");
    let got = run_shade(src, &[], Led::default(), Frame::default()).0;
    assert!((got as i32 - 255).abs() <= 2, "fixed16 sin(90°): {got}");
}

#[test]
fn fixed_cos_and_exp_builtins() {
    // cos(0) = 1 -> 255; exp(0) = 1 -> 255 (both via the integer LUT path).
    let cos = r#"vec3 shade(Led led) { fixed16 z = fixed16(0.0); return vec3(float(cos(z)), 0.0, 0.0); }"#;
    assert!((run_shade(cos, &[], Led::default(), Frame::default()).0 as i32 - 255).abs() <= 2);
    let exp = r#"vec3 shade(Led led) { fixed16 z = fixed16(0.0); return vec3(float(exp(z)), 0.0, 0.0); }"#;
    assert!((run_shade(exp, &[], Led::default(), Frame::default()).0 as i32 - 255).abs() <= 2);
    // The float path still works for float args (sin over a float uniform).
    let f = r#"vec3 shade(Led led) { return vec3(sin(1.5707964), 0.0, 0.0); }"#;
    let c = compile(f).unwrap();
    assert!(ledmapper_fx_compiler::disassemble(&c.fxb).contains("UN_MATH sin"));
}

#[test]
fn mixed_promotion_widens_to_float() {
    // fixed16 * float promotes to float (widest wins): 0.5 * 0.5 = 0.25 -> 63.
    let src = r#"
        vec3 shade(Led led) {
            fixed16 a = fixed16(0.5);
            float r = a * 0.5;
            return vec3(r, 0.0, 0.0);
        }
    "#;
    assert_eq!(run_shade(src, &[], Led::default(), Frame::default()).0, 63);
}

#[test]
fn fixed_moving_band_effect() {
    // A realistic hot-path shader: a moving sine band along z, all in Q1.14 —
    // exercises sin, fixed mul/add and the float boundary end to end.
    let src = r#"
        uniform float speed : 0.0 .. 2.0 = 0.0;
        vec3 shade(Led led) {
            fixed16 z = fixed16(led.pos.z);
            fixed16 phase = z * fixed16(1.0);
            fixed16 w = sin(phase);
            float b = float(w) * 0.5 + 0.5;
            return vec3(b, b, b);
        }
    "#;
    // pos.z = 0.25 turn -> sin = 1 -> b = 1.0 -> 255.
    let led = Led { pos: [0.0, 0.0, 0.25], ..Default::default() };
    let got = run_shade(src, &[], led, Frame::default()).0;
    assert!((got as i32 - 255).abs() <= 3, "moving band peak: {got}");
}
