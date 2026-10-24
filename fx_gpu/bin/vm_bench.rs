//! On-Pi VM baseline: run each packed effect through the real `fx_vm` at each
//! layout and report ms/frame (update + prepare + shade every LED), checking
//! the check frames against the host VM golden. One JSON object per line.
//!
//!   fxvm_bench --dir KERNELS --points 1x500,20x1024 [--budget-ms 1500] [--max-frames 30]
//!              [--threads N]
//!
//! `--threads N` (default 1) splits each frame's LEDs across N worker threads,
//! each with its own VM (update/prepare run redundantly per worker: deterministic
//! and cheap), in lockstep per frame, to measure a multi-core VM. Output is
//! still checked against the golden.
//!
//! Built statically (crt-static) so it runs on the NixOS Pi with no loader.

use fx_gpu::bench::{self, Pack, CHECK_FRAMES};
use ledmapper_fx_vm as vm;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::{Barrier, Mutex};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut dir = String::from("kernels");
    let mut points = bench::sweep();
    let mut budget_ms = 1500.0f64;
    let mut max_frames = 30u32;
    let mut only: Vec<String> = Vec::new();
    let mut threads = 1usize;
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
            "--threads" => {
                threads = args[i + 1].parse::<usize>().unwrap().max(1);
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
            let (times, max_err, mismatch) =
                run_point(&prog, &ub, &leds, golden.as_deref(), threads, budget_ms, max_frames);
            let mut times = times;
            let (med, p95, min) = stats(&mut times);
            println!(
                "{{\"bench\":\"vm\",\"kernel\":\"{name}\",\"layout\":\"{}\",\"n\":{n},\"frames\":{},\
                 \"ms_median\":{med:.3},\"ms_p95\":{p95:.3},\"ms_min\":{min:.3},\"us_per_led\":{:.3},\
                 \"threads\":{threads},\"golden_checked\":{},\"golden_max_err\":{max_err},\"golden_mismatch_bytes\":{mismatch}}}",
                l.name(),
                times.len(),
                med * 1e3 / n as f64,
                golden.is_some()
            );
        }
    }
}

/// Time frames of one kernel x layout on `threads` lockstepped workers.
/// Returns (per-frame ms, golden max err, golden mismatch bytes).
fn run_point(
    prog: &vm::Program,
    ub: &[u8],
    leds: &[vm::Led],
    golden: Option<&[Vec<u8>]>,
    threads: usize,
    budget_ms: f64,
    max_frames: u32,
) -> (Vec<f64>, u32, u64) {
    let n = leds.len();
    let chunk = n.div_ceil(threads);
    let outs: Vec<Mutex<Vec<u8>>> = (0..threads).map(|_| Mutex::new(Vec::new())).collect();
    let start_b = Barrier::new(threads + 1);
    let end_b = Barrier::new(threads + 1);
    let frame = AtomicU32::new(0);
    let stop = AtomicBool::new(false);
    let mut times = Vec::new();
    let (mut max_err, mut mismatch) = (0u32, 0u64);
    std::thread::scope(|s| {
        for t in 0..threads {
            let (outs, start_b, end_b, frame, stop) = (&outs, &start_b, &end_b, &frame, &stop);
            s.spawn(move || {
                let lo = (t * chunk).min(n);
                let hi = ((t + 1) * chunk).min(n);
                let mut v = vm::Vm::new();
                set_uniforms(&mut v, ub);
                let mut local = vec![0u8; 3 * (hi - lo)];
                loop {
                    start_b.wait();
                    if stop.load(Ordering::SeqCst) {
                        break;
                    }
                    let fr = bench::frame_at(frame.load(Ordering::SeqCst), n);
                    v.run_update(prog, &fr);
                    v.run_prep(prog, &fr, &vm::Budget::default());
                    for (k, led) in leds[lo..hi].iter().enumerate() {
                        let (r, g, b) = v.run_shade(prog, &fr, led);
                        local[3 * k] = r;
                        local[3 * k + 1] = g;
                        local[3 * k + 2] = b;
                    }
                    *outs[t].lock().unwrap() = local.clone();
                    end_b.wait();
                }
            });
        }
        let begin = Instant::now();
        let mut f = 0u32;
        loop {
            frame.store(f, Ordering::SeqCst);
            let t0 = Instant::now();
            start_b.wait();
            end_b.wait();
            times.push(t0.elapsed().as_secs_f64() * 1e3);
            if let (Some(gs), Some(ci)) = (golden, CHECK_FRAMES.iter().position(|&c| c == f)) {
                let mut off = 0;
                for o in &outs {
                    let o = o.lock().unwrap();
                    for (a, b) in o.iter().zip(gs[ci][off..].iter()) {
                        let d = (*a as i32 - *b as i32).unsigned_abs();
                        max_err = max_err.max(d);
                        mismatch += (d != 0) as u64;
                    }
                    off += o.len();
                }
            }
            f += 1;
            let elapsed = begin.elapsed().as_secs_f64() * 1e3;
            if f >= max_frames || (f as usize >= CHECK_FRAMES.len() && elapsed > budget_ms) {
                stop.store(true, Ordering::SeqCst);
                start_b.wait();
                break;
            }
        }
    });
    (times, max_err, mismatch)
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
