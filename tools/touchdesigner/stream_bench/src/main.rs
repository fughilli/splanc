//! CLI wrapper around [`ledmapper_stream_bench`]: stream a scrolling-bars test
//! pattern into a player's texture port using the TouchDesigner plugin's encoder
//! and report the sustained applied-frame rate + jitter.
//!
//! Single run — prints one machine-readable `RESULT …` line to stdout for the
//! HITL harness to parse, human diagnostics to stderr, and exits 0 when the rate
//! clears `--min-fps`, 1 when it falls short, and >=2 on a setup/usage error:
//!
//!   stream_bench --addr 127.0.0.1:8123 --width 24 --height 24 \
//!       --effect __vidbench --seconds 3 --min-fps 10 --keyframe-interval 30
//!
//! Sweep — with `--sweep`, run a curated matrix of (format, RLE, keyframe
//! interval) over ONE connection and print a `SWEEP …` line per config plus
//! `BEST_FPS`/`BEST_JITTER` picks, to hill-climb the encoder against real
//! hardware in a single reservation.

use std::process::exit;

use ledmapper_stream_bench::{acceptable, run_bench, run_sweep, BenchConfig, BenchResult, SweepPoint};
use td_ledmapper::texture::Format;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let val = |k: &str| -> Option<String> {
        args.iter().position(|a| a == k).and_then(|i| args.get(i + 1)).cloned()
    };
    let flag = |k: &str| args.iter().any(|a| a == k);
    let num = |k: &str, d: f64| val(k).and_then(|v| v.parse().ok()).unwrap_or(d);
    let int = |k: &str, d: u64| val(k).and_then(|v| v.parse().ok()).unwrap_or(d);

    let addr = match val("--addr") {
        Some(a) => a,
        None => {
            eprintln!("error: --addr host:port is required");
            exit(2);
        }
    };
    let host_header = val("--host-header").unwrap_or_else(|| {
        addr.rsplit_once(':').map(|(h, _)| h.to_string()).unwrap_or_else(|| addr.clone())
    });
    let min_fps = num("--min-fps", 10.0);
    let cfg = BenchConfig {
        addr,
        host_header,
        effect_id: val("--effect").unwrap_or_else(|| "__vidbench".into()),
        tex_index: int("--tex-index", 0) as u32,
        width: int("--width", 24) as usize,
        height: int("--height", 24) as usize,
        bar_w: int("--bar-width", 3) as usize,
        format: Format::from_name(&val("--format").unwrap_or_else(|| "rgb565".into())),
        rle: !flag("--no-rle"),
        keyframe_interval: int("--keyframe-interval", 0) as u32,
        seconds: num("--seconds", 3.0),
        // Larger window amortizes the per-barrier round-trip so the measured rate
        // tracks true device throughput (a small window is RTT-bound: window=10
        // measured ~39 FPS where window=30 measured ~74 FPS for the same config).
        sync_every: int("--sync-every", 30) as u32,
    };

    if flag("--sweep") {
        run_sweep_cli(&cfg);
        return;
    }

    match run_bench(&cfg) {
        Ok(r) => {
            let pass = acceptable(r.fps, min_fps);
            eprintln!(
                "[video-stream] {}x{} {:?} rle={} kf={} -> {} frames in {:.2}s = {:.1} FPS \
                 (jitter σ={:.2}ms p99={:.2}ms max={:.2}ms, {:.0} B/frame, device_tex={}x{}); \
                 min {:.1} -> {}",
                cfg.width,
                cfg.height,
                cfg.format,
                cfg.rle,
                cfg.keyframe_interval,
                r.frames,
                r.elapsed_s,
                r.fps,
                r.jitter.stddev_ms,
                r.jitter.p99_ms,
                r.jitter.max_ms,
                r.bytes_per_frame,
                r.device_tex.0,
                r.device_tex.1,
                min_fps,
                if pass { "PASS" } else { "FAIL" }
            );
            println!(
                "RESULT fps={:.2} frames={} seconds={:.3} jitter_ms={:.3} p99_ms={:.3} \
                 max_ms={:.3} bytes={} bytes_per_frame={:.1} device_tex={}x{} min_fps={:.2} \
                 verdict={}",
                r.fps,
                r.frames,
                r.elapsed_s,
                r.jitter.stddev_ms,
                r.jitter.p99_ms,
                r.jitter.max_ms,
                r.bytes_sent,
                r.bytes_per_frame,
                r.device_tex.0,
                r.device_tex.1,
                min_fps,
                if pass { "PASS" } else { "FAIL" }
            );
            exit(if pass { 0 } else { 1 });
        }
        Err(e) => {
            eprintln!("[video-stream] ERROR: {e}");
            println!("RESULT verdict=ERROR");
            exit(3);
        }
    }
}

/// The curated hill-climb matrix. First the format/RLE axis (at no periodic
/// keyframe), then a keyframe-interval sweep on the strongest small format, to
/// price the drop-robustness/jitter trade.
fn sweep_points() -> Vec<SweepPoint> {
    use Format::*;
    let p = |label, format, rle, kf| SweepPoint { label, format, rle, keyframe_interval: kf };
    vec![
        p("rgb565+rle", Rgb565, true, 0), // TD default (color, 2 B/texel)
        p("rgb565+rle kf=1", Rgb565, true, 1), // color, every frame self-contained
        p("rgb565+rle kf=30", Rgb565, true, 30),
        p("rgb888+rle", Rgb888, true, 0), // full color, 3 B/texel
        p("rgb332+rle", Rgb332, true, 0), // low-color, 1 B/texel
        p("rgb332+rle kf=1", Rgb332, true, 1), // 1 B color, every frame keyframe
        p("gray8", Gray8, false, 0),   // fastest (mono, 1 B/texel)
        p("gray8 kf=1", Gray8, false, 1), // fastest + fully drop-resilient
        p("gray8+rle", Gray8, true, 0),
    ]
}

fn run_sweep_cli(base: &BenchConfig) {
    let points = sweep_points();
    eprintln!(
        "[sweep] {}x{} bars, {:.1}s each, window={} — {} configs over one connection",
        base.width,
        base.height,
        base.seconds,
        base.sync_every,
        points.len()
    );
    eprintln!(
        "{:<20} {:>8} {:>10} {:>10} {:>10} {:>10}",
        "config", "fps", "jitterσ", "p99", "max", "B/frame"
    );
    let results = run_sweep(base, &points, |p, r| {
        eprintln!(
            "{:<20} {:>8.1} {:>9.2}m {:>9.2}m {:>9.2}m {:>10.0}",
            p.label, r.fps, r.jitter.stddev_ms, r.jitter.p99_ms, r.jitter.max_ms, r.bytes_per_frame
        );
        println!(
            "SWEEP label=\"{}\" format={:?} rle={} kf={} fps={:.2} jitter_ms={:.3} p99_ms={:.3} \
             max_ms={:.3} bytes_per_frame={:.1}",
            p.label,
            p.format,
            p.rle,
            p.keyframe_interval,
            r.fps,
            r.jitter.stddev_ms,
            r.jitter.p99_ms,
            r.jitter.max_ms,
            r.bytes_per_frame
        );
    });

    let results = match results {
        Ok(r) => r,
        Err(e) => {
            eprintln!("[sweep] ERROR: {e}");
            println!("RESULT verdict=ERROR");
            exit(3);
        }
    };

    let best_fps = pick(&results, |a, b| a.fps.partial_cmp(&b.fps).unwrap());
    let best_jitter =
        pick(&results, |a, b| b.jitter.stddev_ms.partial_cmp(&a.jitter.stddev_ms).unwrap());
    if let (Some((pf, rf)), Some((pj, rj))) = (best_fps, best_jitter) {
        eprintln!(
            "[sweep] BEST fps: {} ({:.1} FPS, σ={:.2}ms) | lowest jitter: {} (σ={:.2}ms, {:.1} FPS)",
            pf.label, rf.fps, rf.jitter.stddev_ms, pj.label, rj.jitter.stddev_ms, rj.fps
        );
        println!("BEST_FPS label=\"{}\" fps={:.2} jitter_ms={:.3}", pf.label, rf.fps, rf.jitter.stddev_ms);
        println!(
            "BEST_JITTER label=\"{}\" jitter_ms={:.3} fps={:.2}",
            pj.label, rj.jitter.stddev_ms, rj.fps
        );
    }
}

/// The `(point, result)` that maximizes `cmp` (`cmp(a, b) = Greater` means a wins).
fn pick<'a>(
    results: &'a [(SweepPoint, BenchResult)],
    cmp: impl Fn(&BenchResult, &BenchResult) -> std::cmp::Ordering,
) -> Option<(&'a SweepPoint, &'a BenchResult)> {
    results
        .iter()
        .max_by(|(_, a), (_, b)| cmp(a, b))
        .map(|(p, r)| (p, r))
}
