//! `player_rs` — the Rust Raspberry Pi player binary.
//!
//! The unified player (the ESP32 firmware's aarch64/std sibling): one process
//! that both SERVES the protocol over WS+TLS (the network face the phone + HITL
//! harness talk to) and DRIVES the LEDs from the reused `ledmapper_player` core.
//! The `Player` is shared behind a Mutex (the firmware's `player_mutex`): the WS
//! task mutates it per client frame, a dedicated realtime thread reads it each
//! render tick and pushes frames to the spi_ws281x FPGA over spidev.
//!
//! Modes:
//!   * default: render thread + WSS server (the real player).
//!   * `--start N`: also self-drive a mapping pattern at boot, so the wire is
//!     active for the HITL probe without a client (Rust `led_driver --start`).
//!   * `--no-serve`: render only (no WSS). `--dry-run`: one in-memory tick.

//!
//! Output pacing / real-time (pacing.rs, rt.rs, README "Frame-done pacing"):
//!   * `--frame-done-gpio N|none` (default 22 = header pin 15): wait for the
//!     FPGA's frame-done rising edge before each frame; falls back to timed
//!     pacing on its own when the line never rises. `--frame-done-chip
//!     auto|/dev/gpiochipN` (auto = the header's pin controller).
//!   * `--rt on|off` (default on): SCHED_FIFO `--rt-prio` (45) for the output
//!     thread, pinned to `--rt-cpu auto|none|N` (auto = last CPU), mlockall.
//!   * `--spi-split`: CSR and STREAM as two write()s (default: one 2-transfer
//!     SPI message, one syscall, CS toggled between them).
//!   * `--pace-stats S`: log a timing summary every S seconds; `--frames N`:
//!     run N frames, print the summary and exit (bench).

mod sink;

use ledmapper_player::Player;
use ledmapper_player_rs::gpio_cdev::{self, EdgeLine};
use ledmapper_player_rs::pacing::{
    mono_ns, sleep_until_ns, FrameDone, Gate, PaceStats, Pacer, PacerConfig, RateLimit, Schedule,
};
use ledmapper_player_rs::render::{render_fpga, tick_fpga, RecordingSink, Sink};
use ledmapper_player_rs::rt;
use ledmapper_player_rs::server::{self, SharedPlayer};
use ledmapper_player_rs::session;
use ledmapper_player_rs::wire::{check_frame_rate, leds_per_port, matched_speed_hz, FpgaCodec, GRB};
use sink::SpidevSink;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Output-thread pacing + real-time options (see the module doc).
#[derive(Clone)]
struct PaceOpts {
    frame_done_gpio: Option<u32>,
    frame_done_chip: String,
    rt: bool,
    rt_prio: i32,
    rt_cpu: Option<usize>,
    spi_split: bool,
    stats_every: Option<Duration>,
    frames: Option<u64>,
}

fn log(msg: &str) {
    eprintln!("player_rs: {msg}");
}

/// Apply the per-thread RT settings to the calling (output) thread.
fn apply_thread_rt(o: &PaceOpts) {
    if !o.rt {
        log("output thread: real-time settings off (--rt off)");
        return;
    }
    let fifo = match rt::set_thread_fifo(o.rt_prio) {
        Ok(()) => format!("SCHED_FIFO {}", o.rt_prio),
        Err(e) => format!("SCHED_FIFO failed ({e}; needs CAP_SYS_NICE)"),
    };
    let cpu = match o.rt_cpu {
        None => "not pinned".to_string(),
        Some(c) => match rt::pin_thread_to_cpu(c) {
            Ok(()) => format!("pinned to CPU {c}"),
            Err(e) => format!("pinning to CPU {c} failed ({e})"),
        },
    };
    log(&format!("output thread: {fifo}, {cpu}"));
}

/// The output loop: render → absolute deadline → frame-done gate → SPI.
fn output_loop(
    player: &SharedPlayer,
    codec: &FpgaCodec,
    dark_n: usize,
    epoch_mono: u64,
    period: Duration,
    sink: &mut SpidevSink,
    o: &PaceOpts,
) {
    apply_thread_rt(o);
    let mut line: Option<EdgeLine> = o.frame_done_gpio.and_then(|off| {
        let chip = gpio_cdev::resolve_chip(&o.frame_done_chip);
        match EdgeLine::request(&chip, off, "splanc-frame-done") {
            Ok(l) => {
                log(&format!("frame-done: pacing on {chip} line {off} (rising edge)"));
                Some(l)
            }
            Err(e) => {
                log(&format!("frame-done: can't request {chip} line {off} ({e}); timed pacing"));
                None
            }
        }
    });
    if o.frame_done_gpio.is_none() {
        log("frame-done: disabled (--frame-done-gpio none); timed pacing");
    }
    let line_name = line
        .as_ref()
        .map(|l| format!("{} line {}", l.chip, l.offset))
        .unwrap_or_default();
    let mut pacer = Pacer::new(PacerConfig::for_period(period), line_name);
    let mut sched = Schedule::new(mono_ns(), period);
    let mut stats = PaceStats::default();
    let mut last_spi: Option<u64> = None;
    let mut last_report = mono_ns();
    let mut frames: u64 = 0;
    let mut out = |m: &str| log(m);
    // SPI write errors were silently dropped before; log them, rate-limited.
    let mut spi_err_log = RateLimit::new(Duration::from_secs(60));
    // Bench mode: drop the start-up frames (first-touch faults, the fallback's
    // timeouts) from the summary.
    let warmup = o.frames.map(|n| (n / 10).min(120)).unwrap_or(0);

    loop {
        let deadline = sched.deadline();
        // Render for the time the frame goes out, ahead of the wait.
        let t_render = mono_ns();
        let now_us = (deadline.saturating_sub(epoch_mono) / 1000) as i64;
        let (config, stream) = {
            let mut p = player.lock().unwrap();
            let f = render_fpga(&p, now_us, codec, dark_n);
            if let Some(seq) = f.seq {
                p.record_frame_shown(seq, now_us as u32);
            }
            (f.config, f.stream)
        };
        stats.render.push(mono_ns() - t_render);

        sleep_until_ns(deadline);
        let t_wake = mono_ns();
        let gate = match line.as_mut() {
            Some(l) => pacer.gate(l as &mut dyn FrameDone, t_wake, &mut out),
            None => Gate::Timed,
        };
        let t_gate = mono_ns();

        let t_spi = mono_ns();
        let r = if o.spi_split {
            let r = sink.write(&config);
            stats.csr_ioctl.push(mono_ns() - t_spi);
            r.and_then(|_| sink.write(&stream))
        } else {
            sink.write_frame(&config, &stream)
        };
        let t_end = mono_ns();
        if let Err(e) = r {
            if let Some(m) = spi_err_log.check(t_end, &format!("spidev write failed: {e}")) {
                log(&m);
            }
        }

        stats.timer_late.push(t_wake.saturating_sub(deadline));
        stats.gate.push(t_gate - t_wake);
        if let Gate::Edge { edge_ns } = gate {
            stats.edge_to_wake.push(t_gate.saturating_sub(edge_ns));
        }
        stats.to_ioctl.push(t_spi - t_gate);
        stats.spi.push(t_end - t_spi);
        if let Some(prev) = last_spi {
            stats.period.push(t_spi - prev);
        }
        last_spi = Some(t_spi);
        sched.advance(t_spi);
        frames += 1;
        if frames == warmup {
            stats.clear();
        }

        if let Some(n) = o.frames {
            if frames >= n {
                println!(
                    "pace-bench frames={frames} warmup={warmup} rt={} split={} high={} edge={} timeout={} timed={} {}",
                    o.rt,
                    o.spi_split,
                    pacer.n_high,
                    pacer.n_edge,
                    pacer.n_timeout,
                    pacer.n_timed,
                    stats.report()
                );
                std::process::exit(0);
            }
        } else if let Some(every) = o.stats_every {
            if t_end - last_report >= every.as_nanos() as u64 {
                last_report = t_end;
                log(&format!(
                    "pace: frames={frames} mode={:?} high={} edge={} timeout={} timed={} (us min/p50/p99/max) {}",
                    pacer.mode,
                    pacer.n_high,
                    pacer.n_edge,
                    pacer.n_timeout,
                    pacer.n_timed,
                    stats.report()
                ));
                stats.clear();
            }
        }
        // Without --pace-stats the samples would grow forever: keep one window.
        if o.stats_every.is_none() && o.frames.is_none() && stats.period.len() >= 4096 {
            stats.clear();
        }
    }
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let argv: Vec<String> = std::env::args().collect();
    let get = |name: &str, def: &str| -> String {
        argv.windows(2)
            .find(|w| w[0] == name)
            .map(|w| w[1].clone())
            .unwrap_or_else(|| def.to_string())
    };
    let has = |name: &str| argv.iter().any(|a| a == name);

    let ports: usize = get("--fpga-ports", "8").parse().expect("--fpga-ports");
    let start_leds: usize = get("--start", "0").parse().expect("--start");
    let fps: f64 = get("--fps", "10").parse().expect("--fps");
    let bus: u8 = get("--bus", "0").parse().expect("--bus");
    let device: u8 = get("--device", "0").parse().expect("--device");
    let serve_port: u16 = get("--serve-port", "8443").parse().expect("--serve-port");
    let dry = has("--dry-run");
    let no_serve = has("--no-serve");
    let speed_arg: u32 = get("--speed-hz", "0").parse().expect("--speed-hz");
    let ncpu = rt::online_cpus();
    let pace_opts = PaceOpts {
        frame_done_gpio: match get("--frame-done-gpio", "22").as_str() {
            "none" | "off" | "-1" => None,
            n => Some(n.parse().expect("--frame-done-gpio: a line number or none")),
        },
        frame_done_chip: get("--frame-done-chip", "auto"),
        rt: match get("--rt", "on").as_str() {
            "on" => true,
            "off" => false,
            v => panic!("--rt {v}: expected on or off"),
        },
        rt_prio: get("--rt-prio", &rt::DEFAULT_OUTPUT_PRIO.to_string())
            .parse()
            .expect("--rt-prio"),
        rt_cpu: rt::parse_cpu(&get("--rt-cpu", "auto"), ncpu).unwrap_or_else(|e| {
            eprintln!("player_rs: {e}");
            std::process::exit(2);
        }),
        spi_split: has("--spi-split"),
        stats_every: match get("--pace-stats", "0").parse::<f64>().expect("--pace-stats") {
            s if s > 0.0 => Some(Duration::from_secs_f64(s)),
            _ => None,
        },
        frames: match get("--frames", "0").parse::<u64>().expect("--frames") {
            0 => None,
            n => Some(n),
        },
    };
    // FPGA default: 2x the rate-matched clock, capped at 24 MHz (the per-port FIFO
    // makes faster-than-matched safe up to the SPI ceiling).
    let speed = if speed_arg > 0 {
        speed_arg
    } else {
        (matched_speed_hz(ports as u32) * 2).min(24_000_000)
    };

    let bit_period_ms = 1000.0 / fps;
    let period = Duration::from_secs_f64(bit_period_ms / 1000.0);
    let codec = FpgaCodec::new(ports, GRB, None).expect("--fpga-ports must be >= 1");
    // How many LEDs to clear when idle: the self-drive length, else the strip
    // implied by the ports (a small nonzero so an idle strip is explicitly dark).
    let dark_n = if start_leds > 0 { start_leds } else { ports };
    // Frame-rate ladder: the 120 fps mode caps the strip at 260 LEDs/port
    // (wire::MAX_LEDS_PER_PORT_120FPS). Checked against the strip known at start.
    if let Err(e) = check_frame_rate(fps, leds_per_port(dark_n, ports)) {
        eprintln!("player_rs: {e}");
        std::process::exit(2);
    }

    let epoch = Instant::now();
    // The same instant on CLOCK_MONOTONIC (Instant's clock on Linux), for the
    // output thread's absolute deadlines.
    let epoch_mono = mono_ns();
    let player: SharedPlayer = Arc::new(Mutex::new(Player::new(
        "pi-player-0001",
        std::cmp::max(start_leds as u32, 1),
    )));
    if start_leds > 0 {
        session::start_mapping(
            &mut player.lock().unwrap(),
            start_leds as u32,
            bit_period_ms,
            1.0,
            0,
        )
        .expect("core rejected start_mapping");
    }

    // Lock all memory (process-wide, before the threads exist) so the output
    // path never page-faults. Needs CAP_IPC_LOCK for more than RLIMIT_MEMLOCK.
    if pace_opts.rt && !dry {
        if let Err(e) = rt::lock_all_memory() {
            log(&format!("mlockall failed ({e}; needs CAP_IPC_LOCK); continuing unlocked"));
        }
    }

    if dry {
        let mut p = player.lock().unwrap();
        let mut s = RecordingSink::default();
        tick_fpga(&mut p, 0, &codec, dark_n, &mut s)?;
        let stream = s.writes.get(1).map(Vec::len).unwrap_or(0);
        println!("dry-run: {} buffers, {stream} B STREAM / {ports} ports", s.writes.len());
        return Ok(());
    }

    // Output thread: its OWN OS thread (not a tokio task), SCHED_FIFO and pinned
    // to a CPU (rt.rs), so the WS server can't jitter the frame clock. Per frame
    // it renders first (holding the player lock only for the render + the
    // shown-seq record), then sleeps to the frame's absolute deadline, waits for
    // the FPGA's frame-done edge (pacing.rs), and hands the frame to SPI.
    {
        let player = player.clone();
        let pace = pace_opts;
        std::thread::Builder::new()
            .name("render".into())
            // musl defaults spawned-thread stacks to 128 KiB (vs glibc's 8 MiB);
            // the per-frame render over 2200 LEDs needs more headroom. See the
            // tokio runtime below for the same reason on the WS workers.
            .stack_size(4 * 1024 * 1024)
            .spawn(move || {
                let mut sink = match SpidevSink::open(bus, device, speed) {
                    Ok(s) => s,
                    Err(e) => {
                        eprintln!("player_rs: spidev open failed ({e}) — render loop disabled");
                        return;
                    }
                };
                eprintln!(
                    "player_rs: render {ports} ports @ {fps} fps, spidev{bus}.{device} @ {speed} Hz"
                );
                output_loop(&player, &codec, dark_n, epoch_mono, period, &mut sink, &pace);
            })?;
    }

    if no_serve {
        // Render-only: park the main thread so the render thread keeps running.
        loop {
            std::thread::sleep(Duration::from_secs(3600));
        }
    }

    // WS+TLS server on a tokio runtime (blocks). Self-signed cert: the phone
    // bypasses validation, so the SANs are cosmetic.
    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], serve_port));
    let config = server::self_signed_config()?;
    // musl defaults spawned-thread stacks to 128 KiB, and tokio does NOT impose a
    // worker-thread stack size — so on the static-musl build the rustls TLS +
    // tokio-tungstenite + protobuf task overflows 128 KiB and aborts the whole
    // process (glibc's 8 MiB default hid this pre-musl). Pin a generous stack.
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_stack_size(8 * 1024 * 1024)
        .build()?;
    rt.block_on(server::serve(player, addr, config, epoch))?;
    Ok(())
}
