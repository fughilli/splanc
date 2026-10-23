//! Host tool: build the Pi 3 benchmark data for a set of effects.
//!
//!   fxgpu_pack --out DIR [--points 1x500,4x550,20x1024] [--frames 60] FILE.fx...
//!
//! Per effect it writes `DIR/<name>/`:
//!   prog.fxb, uniforms.bin           — what the on-Pi VM bench runs
//!   vs.glsl, fs.glsl                 — the GLES2 (vc4) kernel, if it lowers
//!   meta.json                        — gpu-capable?, reason, input counts
//!   <CxP>.fxp                        — per-LED attribute words, per-frame
//!                                      uniform words, VM golden RGB for the
//!                                      check frames (see fx_gpu::bench)

use fx_gpu::bench::{self, Layout, Pack, CHECK_FRAMES};
use fx_gpu::emit_glsl::{self, Target};
use fx_gpu::{compile_shade, eval, kernel, Profile};
use ledmapper_fx_vm as vm;
use std::io::Write;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut out = String::from("pack");
    let mut points = bench::sweep();
    let mut frames = 60u32;
    let mut files = Vec::new();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--out" => {
                out = args[i + 1].clone();
                i += 1;
            }
            "--points" => {
                points = args[i + 1].split(',').map(|s| bench::parse_layout(s).expect("layout CxP")).collect();
                i += 1;
            }
            "--frames" => {
                frames = args[i + 1].parse().unwrap();
                i += 1;
            }
            f => files.push(f.to_string()),
        }
        i += 1;
    }
    for f in &files {
        pack_one(f, &out, &points, frames);
    }
}

fn pack_one(path: &str, out: &str, points: &[Layout], frames: u32) {
    let name = std::path::Path::new(path).file_stem().unwrap().to_str().unwrap().to_string();
    let src = std::fs::read_to_string(path).expect("read .fx");
    let c = ledmapper_fx_compiler::compile(&src).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    let prog = vm::Program::parse(&c.fxb).expect("parse");
    let dir = format!("{out}/{name}");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(format!("{dir}/prog.fxb"), &c.fxb).unwrap();
    let mut ub = Vec::new();
    for u in &c.uniforms {
        ub.extend_from_slice(&(u.slot as u32).to_le_bytes());
        ub.extend_from_slice(&(u.default.len() as u32).to_le_bytes());
        for v in &u.default {
            ub.extend_from_slice(&v.to_le_bytes());
        }
    }
    std::fs::write(format!("{dir}/uniforms.bin"), ub).unwrap();

    // Lower for GLES2 (vc4): the kernel in the vertex shader.
    let lowered = compile_shade(&prog, Profile::ExactInt);
    let (gpu, reason, emitted, graph) = match lowered {
        Ok((g, roots, raw)) => match emit_glsl::emit(&g, &roots, raw, Target::Es100Vertex) {
            Ok(e) => (true, String::new(), Some(e), Some((g, roots))),
            Err(e) => (false, e, None, None),
        },
        Err(e) => (false, format!("{e:?}"), None, None),
    };
    let (led_inputs, frame_inputs) = match &emitted {
        Some(e) => {
            std::fs::write(format!("{dir}/vs.glsl"), &e.src).unwrap();
            std::fs::write(format!("{dir}/fs.glsl"), e.frag.as_ref().unwrap()).unwrap();
            (e.led_inputs.clone(), e.frame_inputs.clone())
        }
        None => (Vec::new(), Vec::new()),
    };
    let nodes = graph.as_ref().map(|(g, r)| g.live(r).iter().filter(|&&x| x).count()).unwrap_or(0);
    let meta = format!(
        "{{\"name\":\"{name}\",\"gpu\":{gpu},\"reason\":{:?},\"led_inputs\":{},\"frame_inputs\":{},\"gpu_nodes\":{nodes}}}\n",
        reason,
        led_inputs.len(),
        frame_inputs.len()
    );
    std::fs::write(format!("{dir}/meta.json"), meta).unwrap();

    for l in points {
        let leds = bench::leds(l);
        let n = leds.len();
        let mut v = vm::Vm::new();
        for u in &c.uniforms {
            v.set_uniform(u.slot as usize, &u.default);
        }
        // LED attribute words (frame-independent).
        let f0 = bench::frame_at(0, n);
        let mut led_words = Vec::with_capacity(n * led_inputs.len());
        for led in &leds {
            let inp = kernel::inputs(&v.uniforms, &v.state, &f0, led);
            for &s in &led_inputs {
                led_words.push(eval::read_src(&inp, s));
            }
        }
        // Per-frame uniform words + VM goldens on the check frames.
        let mut frame_words = Vec::with_capacity(frames as usize * frame_inputs.len());
        let mut golden = Vec::new();
        for f in 0..frames {
            let fr = bench::frame_at(f, n);
            v.run_update(&prog, &fr);
            v.run_prep(&prog, &fr, &vm::Budget::default());
            let inp = kernel::inputs(&v.uniforms, &v.state, &fr, &leds[0]);
            for &s in &frame_inputs {
                frame_words.push(eval::read_src(&inp, s));
            }
            if CHECK_FRAMES.contains(&f) {
                let mut g = Vec::with_capacity(3 * n);
                for led in &leds {
                    let (r, gg, b) = v.run_shade(&prog, &fr, led);
                    g.extend_from_slice(&[r, gg, b]);
                }
                golden.push(g);
            }
        }
        let p = Pack {
            w: l.per_channel as u32,
            h: l.channels as u32,
            n: n as u32,
            a: led_inputs.len() as u32,
            led_words,
            u: frame_inputs.len() as u32,
            frames,
            frame_words,
            golden,
        };
        std::fs::write(format!("{dir}/{}.fxp", l.name()), p.to_bytes()).unwrap();
    }
    let _ = std::io::stdout().write_all(format!("packed {name}: gpu={gpu} {reason}\n").as_bytes());
}
