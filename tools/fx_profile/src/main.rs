//! Dynamic opcode profiler for the effects VM (VM hill-climb, step 0).
//!
//! Compiles a corpus of representative effects, runs the REAL firmware VM
//! (`ledmapper_fx_vm`, built with the host-only `profile` feature) over update()
//! once + shade() across a full LED raster, and reports the runtime op-mix: which
//! opcodes actually execute, the hottest adjacent pairs (superinstruction fusion
//! candidates), and a COARSE soft-float-vs-cheap cycle split — the data that says
//! whether an effect is math-bound (→ LUTs/fixed-point win) or dispatch-bound
//! (→ superinstructions/JIT win) on the FPU-less C6.
//!
//! Coarse: the soft-float/cheap weights below are ballpark C6 cycles for the
//! split only. The op-count + pair columns are exact and are the actionable part;
//! the authoritative per-opcode cost model is the HITL fx_bench golden.

use ledmapper_fx_vm::{profile, Frame, Led, Op, Program, Vm};

/// (name, source). Representative of what users / the effect-AI write.
const CORPUS: &[(&str, &str)] = &[
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
        "rainbow_flood",
        r#"uniform float speed : 0.0 .. 3.0 = 0.5;
void update() {}
vec3 shade(Led led) { return hsv2rgb(fract(led.dist - time * speed), 0.9, 1.0); }"#,
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
        "trail_feedback",
        r#"uniform float decay : 0.8 .. 0.99 = 0.9;
buffer vec3 trail;
void update() {}
vec3 shade(Led led) {
  vec3 spark = hsv2rgb(fract(led.s * 3.0 + time * 0.2), 0.9, 1.0)
             * step(0.98, hash(led.s + floor(time * 4.0)));
  vec3 p = trail[led.idx];
  vec3 v = p * decay + spark;
  trail[led.idx] = v;
  return v;
}"#,
    ),
    (
        "texmap",
        r#"texture vec3 tex(24, 24);
state bool baked;
uniform vec3 a : color = 0.1, 0.2, 0.8;
uniform vec3 b : color = 1.0, 0.6, 0.1;
void update() {
  if (!baked) {
    for (int y = 0; y < 24; y = y + 1) {
      for (int x = 0; x < 24; x = x + 1) {
        float fx = float(x) / 23.0;
        float fy = float(y) / 23.0;
        float d = distance(vec2(fx, fy), vec2(0.5, 0.5)) * 2.0;
        tex[y * 24 + x] = a * (1.0 - d) + b * d;
      }
    }
    baked = true;
  }
}
vec3 shade(Led led) { return sample(tex, led.uv); }"#,
    ),
    (
        "fixed16_gradient",
        r#"uniform float speed : 0.0 .. 5.0 = 1.0;
void update() {}
vec3 shade(Led led) {
  fixed16 a = fixed16(led.s) + fixed16(time * speed);
  fixed16 s = sin(a) * fixed16(0.5) + fixed16(0.5);
  float v = float(s);
  return vec3(v, v, v);
}"#,
    ),
];

const LED_COUNT: usize = 256;

/// Coarse per-opcode C6 cycle weight + class, for the soft-float/cheap split.
/// (name-keyed off the Op Debug name.) Only the split uses these; op counts are exact.
fn weight(name: &str) -> (u32, Class) {
    use Class::*;
    match name {
        // Transcendentals / color — the soft-float heavyweights.
        "UnMath" => (45, SoftFloat),
        "BinMath" => (40, SoftFloat),
        "Hash1" => (50, SoftFloat),
        "Hash3" => (90, SoftFloat),
        "Hsv2Rgb" => (40, SoftFloat),
        "Palette" => (40, SoftFloat),
        // Soft-float divide + elementwise arithmetic.
        "Div" => (30, SoftFloat),
        "Add" | "Sub" | "Mul" | "Neg" | "Scale" => (8, SoftFloat),
        // Vector composites expand to several soft-float ops.
        "Dot" => (15, SoftFloat),
        "Cross" => (25, SoftFloat),
        "Length" => (45, SoftFloat),
        "Normalize" => (60, SoftFloat),
        "Distance" => (50, SoftFloat),
        "Mix" => (20, SoftFloat),
        "Clamp" => (15, SoftFloat),
        "Smoothstep" => (30, SoftFloat),
        // Texture sampling (bilinear + dequant).
        "SampleTex" => (40, SoftFloat),
        "PaintTex" => (20, Mem),
        "LoadBuf" | "StoreBuf" => (8, Mem),
        // Accelerated integer / fixed paths — the CHEAP escape hatch.
        "SinFix" | "CosFix" | "ExpFix" => (8, Cheap),
        "MulFix" | "MulFixN" => (6, Cheap),
        "DivFix" | "DivFixN" => (25, Cheap),
        "AddI" | "SubI" | "MulI" | "ModI" | "NegI" | "CmpI" | "DivI" => (3, Cheap),
        "I2F" | "F2I" | "Fix2F" | "F2Fix" | "I2Fix" | "Fix2I" | "FixRescale" | "FixToF"
        | "FixFromF" => (4, Cheap),
        // Everything else: stack / load / control / compare — pure dispatch.
        _ => (4, Cheap),
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Class {
    SoftFloat,
    Cheap,
    Mem,
}

fn op_name(i: u8) -> String {
    Op::from_u8(i).map(|o| format!("{o:?}")).unwrap_or_else(|| format!("op{i}"))
}

fn run_effect(fxb: &[u8]) -> Result<(), String> {
    let prog = Program::parse(fxb).map_err(|e| format!("parse: {e:?}"))?;
    let mut arena = vec![0u8; prog.arena_bytes(LED_COUNT)];
    let mut vm = Vm::new();
    vm.set_arena(&mut arena);
    let frame = Frame {
        time: 1.234,
        dt: 0.033,
        frame: 42,
        led_count: LED_COUNT as u32,
        ..Default::default()
    };
    vm.run_update(&prog, &frame);
    for i in 0..LED_COUNT {
        let t = i as f32 / (LED_COUNT as f32 - 1.0);
        let led = Led {
            pos: [t, (t * 7.0).fract(), 0.5 - t],
            idx: i as u32,
            s: t,
            dist: t,
            uv: [t, (t * 3.0).fract()],
            ..Default::default()
        };
        vm.run_shade(&prog, &frame, &led);
    }
    Ok(())
}

struct Report {
    name: String,
    total: u64,
    softfloat_cycles: u64,
    cheap_cycles: u64,
    top_ops: Vec<(String, u64)>,
}

fn profile_effect(name: &str, fxb: &[u8]) -> Result<Report, String> {
    profile::reset();
    run_effect(fxb)?;
    let total = profile::total();
    let (mut sf, mut cheap) = (0u64, 0u64);
    let mut ops: Vec<(String, u64)> = Vec::new();
    for i in 0u16..=255 {
        let c = profile::op_count(i as u8);
        if c == 0 {
            continue;
        }
        let nm = op_name(i as u8);
        let (w, class) = weight(&nm);
        let cyc = c * w as u64;
        match class {
            Class::SoftFloat => sf += cyc,
            _ => cheap += cyc,
        }
        ops.push((nm, c));
    }
    ops.sort_by(|a, b| b.1.cmp(&a.1));
    ops.truncate(10);
    Ok(Report {
        name: name.to_string(),
        total,
        softfloat_cycles: sf,
        cheap_cycles: cheap,
        top_ops: ops,
    })
}

fn main() {
    let compile = |src: &str| ledmapper_fx_compiler::compile(src);
    let mut reports = Vec::new();
    let mut pair_totals: std::collections::HashMap<(u8, u8), u64> = Default::default();

    println!("fx VM dynamic profiler — {LED_COUNT} LEDs, update()x1 + shade()xN\n");
    for (name, src) in CORPUS {
        let compiled = match compile(src) {
            Ok(c) => c,
            Err(diags) => {
                println!("[skip] {name}: compile failed: {diags:?}");
                continue;
            }
        };
        match profile_effect(name, &compiled.fxb) {
            Ok(r) => {
                // Fold this effect's pairs into the corpus total.
                for a in 0u16..=255 {
                    for b in 0u16..=255 {
                        let c = profile::pair_count(a as u8, b as u8) as u64;
                        if c > 0 {
                            *pair_totals.entry((a as u8, b as u8)).or_default() += c;
                        }
                    }
                }
                reports.push(r);
            }
            Err(e) => println!("[skip] {name}: {e}"),
        }
    }

    println!("{:<18} {:>10} {:>10}   top opcodes (exec count)", "effect", "instrs", "softfloat");
    println!("{}", "-".repeat(90));
    for r in &reports {
        let sfpct = if r.softfloat_cycles + r.cheap_cycles > 0 {
            100.0 * r.softfloat_cycles as f64 / (r.softfloat_cycles + r.cheap_cycles) as f64
        } else {
            0.0
        };
        let tops: Vec<String> = r.top_ops.iter().take(6).map(|(n, c)| format!("{n}:{c}")).collect();
        println!("{:<18} {:>10} {:>9.0}%   {}", r.name, r.total, sfpct, tops.join("  "));
    }

    // Corpus-wide hottest adjacent pairs — the superinstruction fusion shortlist.
    let mut pairs: Vec<((u8, u8), u64)> = pair_totals.into_iter().collect();
    pairs.sort_by(|a, b| b.1.cmp(&a.1));
    println!("\nHottest adjacent opcode pairs across the corpus (fusion candidates):");
    for ((a, b), c) in pairs.iter().take(20) {
        println!("  {:>28}  {}", format!("{} -> {}", op_name(*a), op_name(*b)), c);
    }
}
