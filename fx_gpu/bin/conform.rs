//! Host conformance + codegen harness.
//!
//!   fxgpu_conform [--leds N] [--frames F] [--profile native|exact]
//!                 [--emit DIR] [--tol T] [--verbose] FILE.fx...
//!
//! For each effect it: compiles the source to `.fxb`, lowers + legalizes
//! `shade()`, then sweeps a synthetic fixture of `N` LEDs over `F` frames,
//! running BOTH the real `fx_vm` and the `fx_gpu` evaluator on byte-identical
//! inputs, and reports the max / mean absolute per-channel error (0..255).
//! With `--emit DIR` it also writes the GLSL ES 3.10 compute and (where the
//! graph is int-free) ES 1.00 fragment shaders for external validation by
//! glslang / spirv-val. Effects the subset can't lower are reported with the
//! reason and counted as "VM-only".

use fx_gpu::{compile_shade, emit_glsl, eval, kernel, lower, Profile};
use ledmapper_fx_vm as vm;

struct Fixture {
    leds: Vec<vm::Led>,
}

fn build_fixture(n: usize) -> Fixture {
    let mut leds = Vec::with_capacity(n);
    for i in 0..n {
        let t = i as f32 / (n.max(2) - 1) as f32;
        // a helix in a 1 m cube — exercises pos, uv, s, dist, seg
        let ang = t * std::f32::consts::TAU * 3.0;
        let pos = [0.5 + 0.4 * ang.cos(), t, 0.5 + 0.4 * ang.sin()];
        let uv = [t, (t * 7.0).fract()];
        let seg = (i / 16) as i32;
        let s = (t * 7.0).fract();
        let dist = t;
        let mut led = vm::Led {
            pos,
            idx: i as u32,
            seg,
            s,
            branch: i % 3 == 0,
            dist,
            uv,
            ..Default::default()
        };
        // fixed mirrors (Q16.16), as the host fills at map load
        for c in 0..3 {
            led.pos_fix[c] = vm::f32_to_fix(pos[c], 16);
            led.room_fix[c] = led.pos_fix[c];
        }
        led.uv_fix = [vm::f32_to_fix(uv[0], 16), vm::f32_to_fix(uv[1], 16)];
        led.s_fix = vm::f32_to_fix(s, 16);
        led.dist_fix = vm::f32_to_fix(dist, 16);
        leds.push(led);
    }
    Fixture { leds }
}

fn frame_at(f: u32, n: usize) -> vm::Frame {
    let dt = 1.0 / 60.0;
    let time = f as f32 * dt;
    let mut fr = vm::Frame {
        time,
        dt,
        frame: f,
        led_count: n as u32,
        imu_accel: [0.1, 0.98, -0.05],
        imu_gyro: [0.02, -0.01, 0.03],
        ..Default::default()
    };
    fr.time_fix = vm::f32_to_fix(time, 16);
    fr.dt_fix = vm::f32_to_fix(dt, 16);
    for c in 0..3 {
        fr.imu_accel_fix[c] = vm::f32_to_fix(fr.imu_accel[c], 16);
        fr.imu_gyro_fix[c] = vm::f32_to_fix(fr.imu_gyro[c], 16);
    }
    fr
}

struct Report {
    name: String,
    lowered: bool,
    reason: Option<lower::Unsupported>,
    max_err: u32,
    mean_err: f64,
    samples: u64,
    nodes: usize,
}

fn run_one(path: &str, n: usize, frames: u32, prof: Profile, emit_dir: Option<&str>) -> Report {
    let name = std::path::Path::new(path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string();
    let src = std::fs::read_to_string(path).expect("read .fx");
    let compiled = match ledmapper_fx_compiler::compile(&src) {
        Ok(c) => c,
        Err(_e) => {
            return Report {
                name,
                lowered: false,
                reason: Some(lower::Unsupported::BadProgram),
                max_err: 0,
                mean_err: 0.0,
                samples: 0,
                nodes: 0,
            };
        }
    };
    let prog = vm::Program::parse(&compiled.fxb).expect("parse fxb");

    let (g, roots, raw) = match compile_shade(&prog, prof) {
        Ok(x) => x,
        Err(e) => {
            return Report { name, lowered: false, reason: Some(e), max_err: 0, mean_err: 0.0, samples: 0, nodes: 0 };
        }
    };

    // Emit GLSL for external validation.
    if let Some(dir) = emit_dir {
        if let Ok(o) = emit_glsl::emit(&g, &roots, emit_glsl::Target::Es310Compute) {
            let _ = std::fs::write(format!("{dir}/{name}.comp"), o.src);
        }
        if let Ok(o) = emit_glsl::emit(&g, &roots, emit_glsl::Target::Es100Fragment) {
            let _ = std::fs::write(format!("{dir}/{name}.frag"), o.src);
        }
    }

    // Set up the VM with the effect's uniform defaults.
    let mut v = vm::Vm::new();
    for u in &compiled.uniforms {
        v.set_uniform(u.slot as usize, &u.default);
    }
    let fixture = build_fixture(n);

    let mut max_err = 0u32;
    let mut sum_err = 0f64;
    let mut samples = 0u64;
    for f in 0..frames {
        let frame = frame_at(f, n);
        v.run_update(&prog, &frame);
        v.run_prep(&prog, &frame, &vm::Budget::default());
        let uniforms: Vec<f32> = v.uniforms.to_vec();
        let state: Vec<f32> = v.state.to_vec();
        for led in &fixture.leds {
            let (vr, vg, vb) = v.run_shade(&prog, &frame, led);
            let inp = kernel::inputs(&uniforms, &state, &frame, led);
            let rgb = eval::eval_rgb(&g, &roots, &inp);
            let gq = if raw {
                let c = |x: f32| x.clamp(0.0, 255.0) as u8;
                [c(rgb[0]), c(rgb[1]), c(rgb[2])]
            } else {
                [vm::unit_u8(rgb[0]), vm::unit_u8(rgb[1]), vm::unit_u8(rgb[2])]
            };
            let d = [
                (vr as i32 - gq[0] as i32).unsigned_abs(),
                (vg as i32 - gq[1] as i32).unsigned_abs(),
                (vb as i32 - gq[2] as i32).unsigned_abs(),
            ];
            let m = d[0].max(d[1]).max(d[2]);
            max_err = max_err.max(m);
            sum_err += (d[0] + d[1] + d[2]) as f64 / 3.0;
            samples += 1;
        }
    }
    Report {
        name,
        lowered: true,
        reason: None,
        max_err,
        mean_err: if samples > 0 { sum_err / samples as f64 } else { 0.0 },
        samples,
        nodes: g.len(),
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut n = 64usize;
    let mut frames = 8u32;
    let mut prof = Profile::ExactInt;
    let mut emit: Option<String> = None;
    let mut tol = 2u32;
    let mut verbose = false;
    let mut files = Vec::new();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--leds" => {
                n = args[i + 1].parse().unwrap();
                i += 1;
            }
            "--frames" => {
                frames = args[i + 1].parse().unwrap();
                i += 1;
            }
            "--profile" => {
                prof = if args[i + 1] == "native" { Profile::Native } else { Profile::ExactInt };
                i += 1;
            }
            "--emit" => {
                emit = Some(args[i + 1].clone());
                i += 1;
            }
            "--tol" => {
                tol = args[i + 1].parse().unwrap();
                i += 1;
            }
            "--verbose" => verbose = true,
            f => files.push(f.to_string()),
        }
        i += 1;
    }
    if let Some(d) = &emit {
        std::fs::create_dir_all(d).ok();
    }

    let mut reports: Vec<Report> = files.iter().map(|f| run_one(f, n, frames, prof, emit.as_deref())).collect();
    reports.sort_by(|a, b| b.max_err.cmp(&a.max_err));

    let lowered = reports.iter().filter(|r| r.lowered).count();
    let within = reports.iter().filter(|r| r.lowered && r.max_err <= tol).count();
    println!(
        "== fx_gpu conformance: {} effects, {} lowered ({:.0}%), {} within tol={} ({:.0}% of lowered)",
        reports.len(),
        lowered,
        100.0 * lowered as f64 / reports.len().max(1) as f64,
        within,
        tol,
        100.0 * within as f64 / lowered.max(1) as f64,
    );
    println!("profile={prof:?} leds={n} frames={frames}");
    println!("{:<34} {:>7} {:>8} {:>6}  reason", "effect", "maxErr", "meanErr", "nodes");
    for r in &reports {
        if r.lowered {
            if verbose || r.max_err > tol {
                println!("{:<34} {:>7} {:>8.3} {:>6}", r.name, r.max_err, r.mean_err, r.nodes);
            }
        } else {
            println!("{:<34} {:>7} {:>8} {:>6}  VM-only: {:?}", r.name, "-", "-", "-", r.reason.as_ref().unwrap());
        }
    }
    // aggregate over lowered-and-within for the headline tolerance number
    let worst = reports.iter().filter(|r| r.lowered).map(|r| r.max_err).max().unwrap_or(0);
    println!("worst max channel error over lowered effects: {worst}");
}
