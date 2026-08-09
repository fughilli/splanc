//! CLI wrapper around [`ledmapper_stream_bench`]: stream a scrolling-bars test
//! pattern into a player's texture port using the TouchDesigner plugin's encoder
//! and report the sustained applied-frame rate.
//!
//! Prints one machine-readable `RESULT …` line to stdout for the HITL harness to
//! parse, human diagnostics to stderr, and exits 0 when the rate clears
//! `--min-fps`, 1 when it falls short, and >=2 on a setup/usage error.
//!
//!   stream_bench --addr 127.0.0.1:8123 --width 24 --height 24 \
//!       --effect __vidbench --seconds 3 --min-fps 10

use std::process::exit;

use ledmapper_stream_bench::{acceptable, run_bench, BenchConfig};
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
        seconds: num("--seconds", 3.0),
        sync_every: int("--sync-every", 8) as u32,
    };

    match run_bench(&cfg) {
        Ok(r) => {
            let pass = acceptable(r.fps, min_fps);
            eprintln!(
                "[video-stream] {}x{} {:?} rle={} -> {} frames in {:.2}s = {:.1} FPS \
                 ({} B sent, device_tex={}x{}); min {:.1} -> {}",
                cfg.width,
                cfg.height,
                cfg.format,
                cfg.rle,
                r.frames,
                r.elapsed_s,
                r.fps,
                r.bytes_sent,
                r.device_tex.0,
                r.device_tex.1,
                min_fps,
                if pass { "PASS" } else { "FAIL" }
            );
            println!(
                "RESULT fps={:.2} frames={} seconds={:.3} bytes={} device_tex={}x{} \
                 min_fps={:.2} verdict={}",
                r.fps,
                r.frames,
                r.elapsed_s,
                r.bytes_sent,
                r.device_tex.0,
                r.device_tex.1,
                min_fps,
                if pass { "PASS" } else { "FAIL" }
            );
            exit(if pass { 0 } else { 1 });
        }
        Err(e) => {
            eprintln!("[video-stream] ERROR: {e}");
            // No spaces/newlines in the value so the RESULT line stays one token
            // per field for the harness parser; the full message is on stderr.
            println!("RESULT verdict=ERROR");
            exit(3);
        }
    }
}
