//! On-Pi VM baseline: run each packed effect through the real `fx_vm` at each
//! layout and report ms/frame (update + prepare + shade every LED), checking
//! the check frames against the host VM golden. One JSON object per line.
//!
//!   fxvm_bench --dir KERNELS --points 1x500,20x1024 [--budget-ms 1500] [--max-frames 30]
//!
//! Built statically (crt-static) so it runs on the NixOS Pi with no loader.

use fx_gpu::bench::{self, Pack, CHECK_FRAMES};
use ledmapper_fx_vm as vm;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut dir = String::from("kernels");
    let mut points = bench::sweep();
    let mut budget_ms = 1500.0f64;
    let mut max_frames = 30u32;
    let mut only: Vec<String> = Vec::new();
    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--dir" => {
                dir = args[i + 1].clone();
                i += 1;
            }
            "--points" => {
                points = args[i + 1].split(',').filter_map(bench::parse_layout).collect();
                i += 1;
            }
            "--budget-ms" => {
                budget_ms = args[i + 1].parse().unwrap();
                i += 1;
            }
            "--max-frames" => {
                max_frames = args[i + 1].parse().unwrap();
                i += 1;
            }
            "--kernels" => {
                only = args[i + 1].split(',').map(String::from).collect();
                i += 1;
            }
            _ => {}
        }
        i += 1;
    }
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .expect("kernels dir")
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().to_string()))
        .filter(|n| only.is_empty() || only.contains(n))
        .collect();
    names.sort();
    for name in names {
        let kd = format!("{dir}/{name}");
        let Ok(fxb) = std::fs::read(format!("{kd}/prog.fxb")) else { continue };
        let prog = vm::Program::parse(&fxb).expect("parse");
        let ub = std::fs::read(format!("{kd}/uniforms.bin")).unwrap_or_default();
        for l in &points {
            let pack = std::fs::read(format!("{kd}/{}.fxp", l.name())).ok();
            let golden = pack.as_deref().and_then(Pack::golden_from_bytes).map(|(_, g)| g);
            let leds = bench::leds(l);
            let n = leds.len();
            let mut v = vm::Vm::new();
            set_uniforms(&mut v, &ub);
            let mut out = vec![0u8; 3 * n];
            let mut times = Vec::new();
            let (mut max_err, mut mismatch) = (0u32, 0u64);
            let start = Instant::now();
            let mut f = 0u32;
            loop {
                let fr = bench::frame_at(f, n);
                let t0 = Instant::now();
                v.run_update(&prog, &fr);
                v.run_prep(&prog, &fr, &vm::Budget::default());
                for (k, led) in leds.iter().enumerate() {
                    let (r, g, b) = v.run_shade(&prog, &fr, led);
                    out[3 * k] = r;
                    out[3 * k + 1] = g;
                    out[3 * k + 2] = b;
                }
                times.push(t0.elapsed().as_secs_f64() * 1e3);
                if let (Some(gs), Some(ci)) = (&golden, CHECK_FRAMES.iter().position(|&c| c == f)) {
                    for (a, b) in out.iter().zip(gs[ci].iter()) {
                        let d = (*a as i32 - *b as i32).unsigned_abs();
                        max_err = max_err.max(d);
                        mismatch += (d != 0) as u64;
                    }
                }
                f += 1;
                let elapsed = start.elapsed().as_secs_f64() * 1e3;
                if f >= max_frames || (f as usize >= CHECK_FRAMES.len() && elapsed > budget_ms) {
                    break;
                }
            }
            let (med, p95, min) = stats(&mut times);
            println!(
                "{{\"bench\":\"vm\",\"kernel\":\"{name}\",\"layout\":\"{}\",\"n\":{n},\"frames\":{},\
                 \"ms_median\":{med:.3},\"ms_p95\":{p95:.3},\"ms_min\":{min:.3},\"us_per_led\":{:.3},\
                 \"golden_checked\":{},\"golden_max_err\":{max_err},\"golden_mismatch_bytes\":{mismatch}}}",
                l.name(),
                times.len(),
                med * 1e3 / n as f64,
                golden.is_some()
            );
        }
    }
}

fn set_uniforms(v: &mut vm::Vm, b: &[u8]) {
    let rd = |o: usize| u32::from_le_bytes(b[o..o + 4].try_into().unwrap());
    let mut o = 0;
    while o + 8 <= b.len() {
        let (slot, len) = (rd(o) as usize, rd(o + 4) as usize);
        o += 8;
        let vals: Vec<f32> = (0..len).map(|k| f32::from_bits(rd(o + 4 * k))).collect();
        o += 4 * len;
        v.set_uniform(slot, &vals);
    }
}

pub fn stats(t: &mut [f64]) -> (f64, f64, f64) {
    if t.is_empty() {
        return (0.0, 0.0, 0.0);
    }
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p = |q: f64| t[((t.len() - 1) as f64 * q).round() as usize];
    (p(0.5), p(0.95), t[0])
}
