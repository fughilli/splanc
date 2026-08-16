//! Semihost benchmark CLI (FUG-11). Runs the real firmware VM natively over the
//! calibration micro-programs, times each with the host wall clock, fits a
//! per-opcode cost model, and writes an [`ExecutionProfile`] JSON in the common
//! profile format that the browser simulator consumes — no hardware needed.
//!
//! Usage:
//!   fx_semihost_bench [--out PATH] [--soc NAME] [--cpu-hz HZ]
//!                     [--anchor-cycles N] [--leds N] [--iters N]
//!
//! The wall-clock timing lives here (non-deterministic); the deterministic core
//! (program builders, the fit, serde) is in lib.rs and unit-tested.

use std::hint::black_box;
use std::time::Instant;

use fx_semihost_bench::*;
use ledmapper_fx_vm::{Frame, Led, Program, Vm};

struct Args {
    out: Option<String>,
    soc: String,
    cpu_hz: f64,
    dispatch_ref_cycles: f64,
    leds: u32,
    iters: u32,
}

fn parse_args() -> Args {
    let mut a = Args {
        out: None,
        soc: "esp32c6".to_string(),
        cpu_hz: 160_000_000.0,
        dispatch_ref_cycles: 6.0,
        leds: 64,
        iters: 400,
    };
    let mut it = std::env::args().skip(1);
    while let Some(k) = it.next() {
        match k.as_str() {
            "--out" => a.out = it.next(),
            "--soc" => a.soc = it.next().unwrap_or(a.soc),
            "--cpu-hz" => a.cpu_hz = it.next().and_then(|v| v.parse().ok()).unwrap_or(a.cpu_hz),
            "--dispatch-cycles" => {
                a.dispatch_ref_cycles =
                    it.next().and_then(|v| v.parse().ok()).unwrap_or(a.dispatch_ref_cycles)
            }
            "--leds" => a.leds = it.next().and_then(|v| v.parse().ok()).unwrap_or(a.leds),
            "--iters" => a.iters = it.next().and_then(|v| v.parse().ok()).unwrap_or(a.iters),
            "-h" | "--help" => {
                eprintln!("fx_semihost_bench [--out PATH] [--soc NAME] [--cpu-hz HZ] [--dispatch-cycles N] [--leds N] [--iters N]");
                std::process::exit(0);
            }
            other => eprintln!("warning: ignoring unknown arg {other}"),
        }
    }
    a
}

/// Modeled C6 soft-float arithmetic cost (device cycles) per dispatch opcode,
/// added on top of the measured dispatch. The host (with an FPU) can't measure
/// these — on the host `sin` ≈ `add` — so they encode the FPU-less C6's known
/// soft-float economics: transcendentals dominate, division is dear, int/stack
/// ops (absent here) are pure dispatch. A cycle-accurate target supersedes them.
fn softfloat_weights() -> std::collections::BTreeMap<String, f64> {
    [
        ("Add", 10.0),
        ("Mul", 12.0),
        ("Div", 40.0),
        ("UnMath", 110.0), // sin/cos/exp/log/sqrt/tan
        ("BinMath", 120.0), // pow/atan2/mod/…
        ("Hash1", 50.0),
    ]
    .iter()
    .map(|(k, v)| (k.to_string(), *v))
    .collect()
}

/// Time one shade micro-program: mean nanoseconds per shade() call, over
/// `leds`×`iters` invocations with a warmup pass to settle caches/branch state.
fn time_shade(bytecode: &[u8], leds: u32, iters: u32) -> f64 {
    let prog = Program::parse(bytecode).expect("bench program parses");
    let mut vm = Vm::new();
    let frame = Frame { led_count: leds, ..Default::default() };
    // spread LED positions so pos.x varies (exercises real branch/value paths).
    let led_at = |i: u32| -> Led {
        let t = (i as f32) / (leds.max(1) as f32);
        Led { pos: [t * 2.0 - 1.0, t, 1.0 - t], idx: i, ..Default::default() }
    };
    // warmup
    for i in 0..leds {
        black_box(vm.run_shade(&prog, &frame, &led_at(i)));
    }
    let start = Instant::now();
    let mut acc = 0u32;
    for _ in 0..iters {
        for i in 0..leds {
            let (r, _g, _b) = vm.run_shade(&prog, &frame, black_box(&led_at(i)));
            acc = acc.wrapping_add(r as u32);
        }
    }
    let elapsed = start.elapsed();
    black_box(acc);
    let calls = (leds as f64) * (iters as f64);
    elapsed.as_nanos() as f64 / calls
}

/// Time one update micro-program: mean nanoseconds per update() call.
fn time_update(bytecode: &[u8], iters: u32) -> f64 {
    let prog = Program::parse(bytecode).expect("bench program parses");
    let mut vm = Vm::new();
    let frame = Frame { led_count: 1, ..Default::default() };
    for _ in 0..1000 {
        vm.run_update(&prog, black_box(&frame));
    }
    let reps = iters * 64;
    let start = Instant::now();
    for _ in 0..reps {
        vm.run_update(&prog, black_box(&frame));
    }
    let elapsed = start.elapsed();
    elapsed.as_nanos() as f64 / (reps as f64)
}

fn main() {
    let args = parse_args();

    // per-op slope points
    let mut ops = Vec::new();
    for &op in BENCH_OPS {
        let mut points = Vec::new();
        for &reps in REP_POINTS {
            let bp = build_op_program(op, reps, args.leds);
            let ns = time_shade(&bp.bytecode, args.leds, args.iters);
            points.push(Point { reps, ns });
        }
        eprintln!(
            "measured {op}: {}",
            points.iter().map(|p| format!("{}→{:.1}ns", p.reps, p.ns)).collect::<Vec<_>>().join("  ")
        );
        ops.push(OpMeasurement { op: profile_op_name(op).to_string(), points });
    }

    let empty_shade_ns = time_shade(&build_empty_shade(args.leds).bytecode, args.leds, args.iters);
    let empty_update_ns = time_update(&build_empty_update().bytecode, args.iters);
    eprintln!("empty shade {empty_shade_ns:.1}ns  empty update {empty_update_ns:.1}ns");

    let inp = FitInputs {
        ops,
        empty_shade_ns,
        empty_update_ns,
        soc: args.soc,
        cpu_hz: args.cpu_hz,
        dispatch_ref_cycles: args.dispatch_ref_cycles,
        softfloat: softfloat_weights(),
        // host can't measure LED transmit; carry the shipped default so the
        // profile's show model is complete (device calibration refines it).
        default_show_fixed: 40_000.0,
        default_show_per_led: 480.0,
        budget: BudgetModel::default(),
    };
    let profile = build_profile(&inp);
    let json = profile.to_json();
    match &args.out {
        Some(path) => {
            std::fs::write(path, &json).expect("write profile");
            eprintln!("wrote {path}");
        }
        None => println!("{json}"),
    }
}
