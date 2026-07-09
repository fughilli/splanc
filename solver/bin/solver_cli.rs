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

    match ledmapper_solver::solve_json(&input, Some(&mut progress)) {
        Ok(out) => println!("{out}"),
        Err(e) => {
            eprintln!("solver_cli: {e}");
            std::process::exit(1);
        }
    }
}
