//! Differential test: a lowered + emulated native image must render every LED
//! bit-identically to the real `fx_vm`, over several frames and a varied LED
//! fixture, for the compiler corpus and embedded study/agent effects. Every
//! lowered image is also run through the instruction-stream verifier.

mod raw_cases;
use raw_cases::raw_program;

use ledmapper_fx_aot::{emu, lower, NativeCtx, FRAME_WORDS};
use ledmapper_fx_vm::{self as fxv, Frame, Led, Program, Vm};

fn q16(x: f32) -> i32 {
    (x * 65536.0) as i32
}

/// A varied LED, filled like the firmware's `fx_shade_one` (pos/idx/topology/uv
/// + the Q16 mirrors).
fn make_led(i: usize, n: usize) -> Led {
    let t = i as f32 / n as f32;
    let pos = [
        (t * 6.28).sin() * 0.3,
        t * 1.2 - 0.6,
        (t * 6.28).cos() * 0.3,
    ];
    let seg = (i % 8) as i32;
    let s = (i as f32 * 0.137).fract();
    let uv = [
        (pos[0] + 0.5).clamp(0.0, 1.0),
        (pos[1] + 0.6).clamp(0.0, 1.0),
    ];
    let dist = t;
    Led {
        pos,
        idx: i as u32,
        seg,
        s,
        branch: false,
        dist,
        uv,
        pos_fix: [q16(pos[0]), q16(pos[1]), q16(pos[2])],
        uv_fix: [q16(uv[0]), q16(uv[1])],
        s_fix: q16(s),
        dist_fix: q16(dist),
        room: pos,
        room_fix: [q16(pos[0]), q16(pos[1]), q16(pos[2])],
    }
}

fn make_frame(fi: u32, n: usize) -> Frame {
    let time = 10.0 + fi as f32 * (1.0 / 30.0);
    let dt = 1.0 / 30.0;
    Frame {
        time,
        dt,
        frame: fi,
        led_count: n as u32,
        time_fix: q16(time),
        dt_fix: q16(dt),
        ..Default::default()
    }
}

/// Run `n` LEDs over `frames` frames through the native image; compare each RGB
/// to the VM. Returns Err on the first mismatch.
fn differential(name: &str, fxb: &[u8], uniforms: &[(u8, Vec<f32>)]) -> Result<bool, String> {
    let prog = Program::parse(fxb).map_err(|e| format!("{name}: parse {e:?}"))?;
    let Some(img) = lower(&prog) else {
        return Ok(false); // refused — VM fallback, nothing to compare
    };
    if let Some(e) = img.verify() {
        return Err(format!("{name}: verifier rejected a lowered image: {e:?}"));
    }

    let n = 64usize;
    // VM reference.
    let mut vm = Vm::new();
    for (slot, vals) in uniforms {
        vm.set_uniform(*slot as usize, vals);
    }
    // Native state: a Vm for the few ctx-reading helpers (graph/dist) + separate
    // frame/state/uniform arrays the emitted code bases s1/s11 on.
    let mut nvm = Vm::new();
    let mut uarr = [0.0f32; fxv::MAX_UNIFORM_SLOTS];
    for (slot, vals) in uniforms {
        for (k, v) in vals.iter().enumerate() {
            if (*slot as usize) + k < uarr.len() {
                uarr[*slot as usize + k] = *v;
            }
        }
    }
    let mut frame_mem = [0i32; FRAME_WORDS];
    let mut nstate = [0i32; fxv::MAX_STATE];

    let mut counts = emu::Counts::default();
    for fi in 0..3 {
        let fr = make_frame(fi, n);
        // VM update
        vm.run_update(&prog, &fr);
        // Native update
        if let Some(uoff) = img.update_off {
            let led0 = Led::default();
            let mut ctx = make_ctx(
                &img.op_code,
                &uarr,
                &mut nstate,
                &mut frame_mem,
                &fr,
                &led0,
                &mut nvm,
            );
            let c = unsafe { emu::exec_counted(&img.code, uoff, &mut ctx) };
            counts.instructions += c.instructions;
            counts.helpers += c.helpers;
        }
        // Per-frame prepare (hoisted shade() work), once per frame after update.
        if let Some(poff) = img.prep_off {
            let led0 = Led::default();
            let mut ctx = make_ctx(
                &img.op_code,
                &uarr,
                &mut nstate,
                &mut frame_mem,
                &fr,
                &led0,
                &mut nvm,
            );
            let c = unsafe { emu::exec_counted(&img.code, poff, &mut ctx) };
            counts.instructions += c.instructions;
            counts.helpers += c.helpers;
        }
        for i in 0..n {
            let led = make_led(i, n);
            let vrgb = vm.run_shade(&prog, &fr, &led);
            let nrgb = {
                let mut ctx = make_ctx(
                    &img.op_code,
                    &uarr,
                    &mut nstate,
                    &mut frame_mem,
                    &fr,
                    &led,
                    &mut nvm,
                );
                let c = unsafe { emu::exec_counted(&img.code, img.shade_off, &mut ctx) };
                counts.instructions += c.instructions;
                counts.helpers += c.helpers;
                ctx.finish_rgb()
            };
            for (slot, (&native, reference)) in nstate.iter().zip(&vm.state).enumerate() {
                assert_eq!(
                    native as u32,
                    reference.to_bits(),
                    "{name}: state {slot}, LED {i}, frame {fi}"
                );
            }
            if vrgb != nrgb {
                return Err(format!(
                    "{name}: LED {i} frame {fi} VM={vrgb:?} native={nrgb:?}"
                ));
            }
        }
    }
    println!(
        "aot-estimate {name} bytes={} instructions={} helpers={} leds=64 frames=3",
        img.code.len() * 4,
        counts.instructions,
        counts.helpers
    );
    Ok(true)
}

#[allow(clippy::too_many_arguments)]
fn make_ctx(
    op_code: &[u8],
    uniforms: &[f32],
    state: &mut [i32],
    frame_mem: &mut [i32],
    fr: &Frame,
    led: &Led,
    vm: &mut Vm,
) -> NativeCtx {
    NativeCtx::new(
        ledmapper_fx_aot::aot_win_helper,
        op_code.as_ptr(),
        op_code.len(),
        uniforms.as_ptr(),
        state.as_mut_ptr() as *mut f32,
        frame_mem.as_mut_ptr() as *mut f32,
        fr as *const Frame,
        led as *const Led,
        vm as *mut Vm,
    )
}

/// The compiler's control/function/fixed corpus (mirrors fx_compiler's optimizer
/// test corpus) plus a few extra opcode exercises.
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
            "plasma_c",
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
            "const_math",
            r#"vec3 shade(Led led) {
  float a = 2.0 * 3.0;
  float b = a * 1.0 - 0.0;
  int n = 4 * 3 + 1;
  return vec3(led.pos.x * (b / 6.0), float(n) / 13.0, 0.0);
}"#,
        ),
        (
            "fixed16_grad",
            r#"uniform float scale : 0.2 .. 4.0 = 1.0;
void update() {}
vec3 shade(Led led) {
  fixed16 h = fixed16(led.pos.y) * fixed16(scale);
  fixed16 s = sin(h);
  return vec3(float(s), 0.2, 0.5);
}"#,
        ),
        (
            "loopy",
            r#"void update() {}
vec3 shade(Led led) {
  float acc = 0.0;
  for (int i = 0; i < 6; i = i + 1) {
    acc = acc + sin(led.s * float(i) + time);
  }
  return vec3(fract(acc), 0.5, 1.0 - fract(acc));
}"#,
        ),
    ]
}

const STUDY: &[(&str, &str)] = &[
    ("study_solid", include_str!("../testdata/study_solid.fx")),
    ("study_sweep", include_str!("../testdata/study_sweep.fx")),
    (
        "study_gradient",
        include_str!("../testdata/study_gradient.fx"),
    ),
    ("study_pulses", include_str!("../testdata/study_pulses.fx")),
    (
        "study_sparkle",
        include_str!("../testdata/study_sparkle.fx"),
    ),
    ("study_plasma", include_str!("../testdata/study_plasma.fx")),
    ("study_noise", include_str!("../testdata/study_noise.fx")),
    (
        "study_particles",
        include_str!("../testdata/study_particles.fx"),
    ),
    (
        "study_cylinder",
        include_str!("../testdata/study_cylinder.fx"),
    ),
    ("study_rain", include_str!("../testdata/study_rain.fx")),
    (
        "study_rain_naive",
        include_str!("../testdata/study_rain_naive.fx"),
    ),
    ("study_flood", include_str!("../testdata/study_flood.fx")),
    (
        "study_texture",
        include_str!("../testdata/study_texture.fx"),
    ),
    (
        "opt_rainforest",
        include_str!("../testdata/opt_rainforest_opt.fx"),
    ),
    (
        "opt_metaballs",
        include_str!("../testdata/opt_metaballs_sign_opt.fx"),
    ),
    (
        "opt_fire_helix",
        include_str!("../testdata/opt_fire_helix_moving_opt.fx"),
    ),
    (
        "opt_rainbow2",
        include_str!("../testdata/opt_rainbow_overload_sign_2_opt.fx"),
    ),
    (
        "agent_app_opus_p01",
        include_str!("../testdata/agent_app__opus__p01.fx"),
    ),
    (
        "agent_app_opus_p05",
        include_str!("../testdata/agent_app__opus__p05.fx"),
    ),
    (
        "agent_app_opus_p12",
        include_str!("../testdata/agent_app__opus__p12.fx"),
    ),
    (
        "agent_app_sonnet_p03",
        include_str!("../testdata/agent_app__sonnet__p03.fx"),
    ),
    (
        "agent_app_sonnet_p08",
        include_str!("../testdata/agent_app__sonnet__p08.fx"),
    ),
    (
        "agent_app_lint_opus_p06",
        include_str!("../testdata/agent_app_lint__opus__p06.fx"),
    ),
    (
        "agent_app_perf_opus_p02",
        include_str!("../testdata/agent_app_perf__opus__p02.fx"),
    ),
    (
        "agent_app_perf_opus_p09",
        include_str!("../testdata/agent_app_perf__opus__p09.fx"),
    ),
    (
        "agent_skill_opus_p04",
        include_str!("../testdata/agent_skill__opus__p04.fx"),
    ),
    (
        "agent_skill_opus_p11",
        include_str!("../testdata/agent_skill__opus__p11.fx"),
    ),
    (
        "agent_skill_sonnet_p02",
        include_str!("../testdata/agent_skill__sonnet__p02.fx"),
    ),
    (
        "agent_skill_sonnet_p13",
        include_str!("../testdata/agent_skill__sonnet__p13.fx"),
    ),
];

fn compile(src: &str) -> Option<(Vec<u8>, Vec<(u8, Vec<f32>)>)> {
    let c = ledmapper_fx_compiler::compile(src).ok()?;
    let u = c
        .uniforms
        .iter()
        .map(|ui| (ui.slot, ui.default.clone()))
        .collect();
    Some((c.fxb, u))
}

#[test]
fn native_matches_vm() {
    let mut lowered = 0usize;
    let mut refused = 0usize;
    let mut failures = Vec::new();
    let mut all: Vec<(String, String)> = corpus()
        .into_iter()
        .map(|(n, s)| (n.to_string(), s.to_string()))
        .collect();
    for (n, s) in STUDY {
        all.push((n.to_string(), s.to_string()));
    }
    for (name, src) in &all {
        let Some((fxb, uniforms)) = compile(src) else {
            // A compiler error here is a corpus bug, not ours.
            panic!("{name}: failed to compile");
        };
        match differential(name, &fxb, &uniforms) {
            Ok(true) => {
                lowered += 1;
                println!("lowered  {name}  ({} code bytes)", fxb.len());
            }
            Ok(false) => {
                refused += 1;
                println!("refused  {name} (VM fallback)");
            }
            Err(e) => failures.push(e),
        }
    }
    println!("\n{lowered} lowered + matched, {refused} refused (VM fallback)");
    assert!(
        failures.is_empty(),
        "differential mismatches:\n{}",
        failures.join("\n")
    );
    // The simple float effects must lower (sanity that the pipeline engages).
    assert!(
        lowered >= 8,
        "too few effects lowered ({lowered}); pipeline regressed?"
    );
}

/// The VM faults on a fixed-point `frac` operand above 30; the lowering must
/// refuse it (VM fallback) rather than compute a value.
#[test]
fn frac_over_30_stays_on_vm() {
    for op in [fxv::Op::FixToF, fxv::Op::FixFromF] {
        let bytes = raw_program(&[op as u8, 31], 1, 1, 0);
        let prog = Program::parse(&bytes).unwrap();
        assert!(lower(&prog).is_none(), "{op:?} frac 31 must stay on the VM");
    }
}

#[test]
fn direct_helpers_match_raw_vm_words() {
    use fxv::Op;
    let edges = raw_cases::EDGES;
    let cases = raw_cases::cases();
    let fr = Frame::default();
    let led = Led::default();
    let mut random = 0xa07beefu32;
    let mut comparisons = 0;
    let mut reference_panics = 0;
    for (op, pop, push) in &cases {
        for prefix in [0u8, 7, 8, 13] {
            let bytes = raw_program(op, *pop, *push, prefix);
            let prog = Program::parse(&bytes).unwrap();
            let img = lower(&prog).expect("raw operation must lower");
            assert_eq!(img.verify(), None);
            let mut vm = Vm::new();
            let mut nvm = Vm::new();
            let mut u = [0.0; fxv::MAX_UNIFORM_SLOTS];
            let mut frame = [0; FRAME_WORDS];
            let mut state = [0; fxv::MAX_STATE];
            for sample in 0..edges.len() * edges.len() + 256 {
                for (i, value) in u[..usize::from(prefix + pop)].iter_mut().enumerate() {
                    random ^= random << 13;
                    random ^= random >> 17;
                    random ^= random << 5;
                    let bits = if sample < edges.len() * edges.len() {
                        let k = if i % 2 == 0 {
                            sample % edges.len()
                        } else {
                            sample / edges.len()
                        };
                        edges[k]
                    } else {
                        random
                    };
                    *value = f32::from_bits(bits);
                }
                vm.set_uniform(0, &u);
                // Existing VM maths can panic on extreme inputs with overflow
                // checks enabled (sqrtf/expf). Compare every returning input;
                // -c opt and the RV32 test cover the complete bit-pattern set.
                if cfg!(debug_assertions) {
                    if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        vm.run_shade(&prog, &fr, &led)
                    }))
                    .is_err()
                    {
                        reference_panics += 1;
                        continue;
                    }
                } else {
                    vm.run_shade(&prog, &fr, &led);
                }
                let mut ctx = make_ctx(
                    &img.op_code,
                    &u,
                    &mut state,
                    &mut frame,
                    &fr,
                    &led,
                    &mut nvm,
                );
                unsafe { emu::exec(&img.code, img.shade_off, &mut ctx) };
                for i in 0..usize::from(prefix + push) {
                    assert_eq!(
                        state[i] as u32,
                        vm.state[i].to_bits(),
                        "op={op:?} prefix={prefix} sample={sample} lane={i} inputs={:?}",
                        u[..usize::from(prefix + pop)]
                            .iter()
                            .map(|v| v.to_bits())
                            .collect::<Vec<_>>()
                    );
                }
                comparisons += 1;
            }
        }
    }
    println!(
        "raw VM/native comparisons: {comparisons}; reference debug panics: {reference_panics}"
    );
}
