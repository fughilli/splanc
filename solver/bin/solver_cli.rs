//! Host-side carrier for the native VIO solver.
//!
//! Default mode: JSON problem on stdin → §7.5 OutputMap JSON on stdout.
//! Progress goes to stderr as one JSON object per line (solve_status-shaped,
//! throttled to ~4 Hz) so the server can pass snapshots straight through to
//! the phone's get_solve_status poll.
//!
//! `--benchmark`: run the canned placement-benchmark solve and print
//! `{"ms": <elapsed>, "rms": <fingerprint>}` — the same solve the phone
//! times in wasm, so the two numbers are directly comparable.
//!
//! `--diag`: print `{"map", "diag"}` (stage trace, degeneracy assessment,
//! final solver state) instead of the bare map.
//!
//! `--replay <bundle.splanc-capture.json> [--final-only] [--cold] [--json]`:
//! re-run a capture reproduction bundle's interim + final solves and report
//! each one's degeneracy verdict, stage trace and whether it reproduced the
//! recorded map (src/replay.rs). `--cold` re-runs the final without its warm
//! start.
//!
//! `--synth '<ScenarioSpec JSON>'`: print a synthetic capture problem with a
//! known ground truth (`truth`: LED positions) — src/scenario.rs.

use std::io::{Read, Write};
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--benchmark") {
        let start = Instant::now();
        let rms = ledmapper_solver::run_benchmark();
        let ms = start.elapsed().as_secs_f64() * 1000.0;
        println!("{{\"ms\": {ms:.1}, \"rms\": {rms:.4}}}");
        return;
    }
    if let Some(i) = args.iter().position(|a| a == "--synth") {
        let spec: ledmapper_solver::scenario::ScenarioSpec =
            match serde_json::from_str(args.get(i + 1).map(String::as_str).unwrap_or("{}")) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("solver_cli: bad --synth spec: {e}");
                    std::process::exit(2);
                }
            };
        let sc = ledmapper_solver::scenario::generate(&spec);
        let mut out = sc.problem;
        out["truth"] = serde_json::json!(sc.truth);
        println!("{out}");
        return;
    }
    if let Some(i) = args.iter().position(|a| a == "--replay") {
        let path = match args.get(i + 1) {
            Some(p) => p,
            None => {
                eprintln!("solver_cli: --replay needs a bundle path");
                std::process::exit(2);
            }
        };
        let text = match std::fs::read_to_string(path) {
            Ok(t) => t,
            Err(e) => {
                eprintln!("solver_cli: cannot read bundle {path}: {e}");
                std::process::exit(2);
            }
        };
        let opts = ledmapper_solver::replay::ReplayOptions {
            interims: !args.iter().any(|a| a == "--final-only"),
            drop_warm_start: args.iter().any(|a| a == "--cold"),
        };
        match ledmapper_solver::replay::replay_bundle_text(&text, &opts) {
            Ok(report) => {
                if args.iter().any(|a| a == "--json") {
                    println!("{}", serde_json::to_string(&report).unwrap_or_default());
                } else {
                    print!("{}", ledmapper_solver::replay::format_report(&report));
                }
            }
            Err(e) => {
                eprintln!("solver_cli: {e}");
                std::process::exit(1);
            }
        }
        return;
    }
    if args.iter().any(|a| a == "--version") {
        println!("{}", ledmapper_solver::version());
        return;
    }

    let mut input = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut input) {
        eprintln!("solver_cli: failed to read stdin: {e}");
        std::process::exit(2);
    }

    let mut last_report = Instant::now() - std::time::Duration::from_secs(1);
    let stderr = std::io::stderr();
    let mut progress = |snap: &ledmapper_solver::types::ProgressSnapshot| {
        if last_report.elapsed().as_millis() < 250 {
            return;
        }
        last_report = Instant::now();
        if let Ok(line) = serde_json::to_string(snap) {
            let mut h = stderr.lock();
            let _ = writeln!(h, "{line}");
        }
    };

    let diag = args.iter().any(|a| a == "--diag");
    let solved = if diag {
        ledmapper_solver::solve_json_diag(&input, Some(&mut progress))
    } else {
        ledmapper_solver::solve_json(&input, Some(&mut progress))
    };
    match solved {
        Ok(out) => println!("{out}"),
        Err(e) => {
            eprintln!("solver_cli: {e}");
            std::process::exit(1);
        }
    }
}
