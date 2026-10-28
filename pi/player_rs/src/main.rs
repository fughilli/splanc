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
//!
//! Pipelining (pipeline.rs, triple.rs, README "Pipelined render"):
//!   * `--pipeline on|off` (default on): a separate render thread renders frame
//!     N+1 while the output thread sends frame N; the output thread takes the
//!     newest completed frame from a lock-free triple buffer right before each
//!     SPI write, and re-sends the last frame if a render overran. `off` is
//!     #370's serial loop (render, then send, on the output thread).
//!   * `--render-prio P` (default 40, below the output thread; 0 = SCHED_OTHER)
//!     and `--render-cpu auto|none|N` (auto = the CPU below the output's).

mod sink;

use ledmapper_player::Player;
use ledmapper_player_rs::gpio_cdev::{self, EdgeLine};
use ledmapper_player_rs::pacing::{
    mono_ns, sleep_until_ns, FrameDone, Gate, PaceStats, Pacer, PacerConfig, RateLimit, Schedule,
};
use ledmapper_player_rs::pipeline::{
    self, process_cpu_ns, thread_cpu_ns, FrameSlot, RenderClock, ShownMailbox,
};
use ledmapper_player_rs::render::{render_fpga, tick_fpga, RecordingSink, Sink};
use ledmapper_player_rs::rt;
use ledmapper_player_rs::server::{self, SharedPlayer};
use ledmapper_player_rs::session;
use ledmapper_player_rs::triple::{self, Reader, Writer};
use ledmapper_player_rs::wire::{check_frame_rate, leds_per_port, matched_speed_hz, FpgaCodec, GRB};
use sink::SpidevSink;
use std::sync::atomic::{AtomicU64, Ordering};
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
    pipeline: bool,
    render_prio: i32,
    render_cpu: Option<usize>,
}

/// State the render and output threads share besides the triple buffer.
struct PipeShared {
    /// The output's next deadline (CLOCK_MONOTONIC ns), for the render clock.
    out_next: AtomicU64,
    /// Output -> render: mapping frame shown (render records it in the player).
    shown: ShownMailbox,
    /// Renders published over a frame the output never took.
    skipped: AtomicU64,
    /// The render thread's cumulative CPU time, ns.
    render_cpu: AtomicU64,
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

/// Request the frame-done line (None: timed pacing) and build the pacer.
fn open_frame_done(o: &PaceOpts, period: Duration) -> (Option<EdgeLine>, Pacer) {
    let line: Option<EdgeLine> = o.frame_done_gpio.and_then(|off| {
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
    (line, Pacer::new(PacerConfig::for_period(period), line_name))
}

/// CPU use over a bench window: output thread, render thread (pipelined) and
/// the whole process, each as % of one core.
struct CpuWindow {
    wall: u64,
    out: u64,
    render: u64,
    proc_: u64,
}

impl CpuWindow {
    fn now(render_cpu: u64) -> Self {
        Self { wall: mono_ns(), out: thread_cpu_ns(), render: render_cpu, proc_: process_cpu_ns() }
    }

    fn report(&self, render_cpu: u64) -> String {
        let wall = (mono_ns() - self.wall).max(1) as f64;
        let pct = |d: u64| 100.0 * d as f64 / wall;
        format!(
            "cpu%: output={:.1} render={:.1} process={:.1}",
            pct(thread_cpu_ns() - self.out),
            pct(render_cpu.saturating_sub(self.render)),
            pct(process_cpu_ns() - self.proc_)
        )
    }
}

/// The serial output loop (`--pipeline off`, #370): render → absolute deadline
/// → frame-done gate → SPI, all on the output thread.
fn serial_output_loop(
    player: &SharedPlayer,
    codec: &FpgaCodec,
    dark_n: usize,
    epoch_mono: u64,
    period: Duration,
    sink: &mut SpidevSink,
    o: &PaceOpts,
) {
    apply_thread_rt(o);
    let (mut line, mut pacer) = open_frame_done(o, period);
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
    let mut cpu = CpuWindow::now(0);

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
            cpu = CpuWindow::now(0);
        }

        if let Some(n) = o.frames {
            if frames >= n {
                println!(
                    "pace-bench pipeline=off frames={frames} warmup={warmup} rt={} split={} high={} edge={} timeout={} timed={} {} {}",
                    o.rt,
                    o.spi_split,
                    pacer.n_high,
                    pacer.n_edge,
                    pacer.n_timeout,
                    pacer.n_timed,
                    stats.report(),
                    cpu.report(0)
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

/// The pipelined output loop: absolute deadline → frame-done gate → take the
/// newest rendered frame → SPI. Never renders and never takes the player lock;
/// when no new frame is ready it re-sends the current one (lag, not cut-out).
#[allow(clippy::too_many_arguments)]
fn pipelined_output_loop(
    mut frames_in: Reader<FrameSlot>,
    shared: &PipeShared,
    epoch_mono: u64,
    start_ns: u64,
    period: Duration,
    sink: &mut SpidevSink,
    o: &PaceOpts,
) {
    apply_thread_rt(o);
    let (mut line, mut pacer) = open_frame_done(o, period);
    let mut sched = Schedule::new(start_ns, period);
    let mut stats = PaceStats::default();
    let mut last_spi: Option<u64> = None;
    let mut last_report = mono_ns();
    let mut frames: u64 = 0;
    let (mut n_fresh, mut n_repeat) = (0u64, 0u64);
    let mut skipped0 = 0u64;
    let mut out = |m: &str| log(m);
    let mut spi_err_log = RateLimit::new(Duration::from_secs(60));
    let mut repeat_log = RateLimit::new(Duration::from_secs(60));
    let warmup = o.frames.map(|n| (n / 10).min(120)).unwrap_or(0);
    let mut cpu = CpuWindow::now(shared.render_cpu.load(Ordering::Relaxed));

    loop {
        let deadline = sched.deadline();
        sleep_until_ns(deadline);
        let t_wake = mono_ns();
        let gate = match line.as_mut() {
            Some(l) => pacer.gate(l as &mut dyn FrameDone, t_wake, &mut out),
            None => Gate::Timed,
        };
        let t_gate = mono_ns();

        // The newest completed frame; the render thread never touches it now.
        let fresh = frames_in.update();
        let f = frames_in.front();
        let t_spi = mono_ns();
        let r = if o.spi_split {
            let r = sink.write(&f.config);
            stats.csr_ioctl.push(mono_ns() - t_spi);
            r.and_then(|_| sink.write(&f.stream))
        } else {
            sink.write_frame(&f.config, &f.stream)
        };
        let t_end = mono_ns();
        if let Err(e) = r {
            if let Some(m) = spi_err_log.check(t_end, &format!("spidev write failed: {e}")) {
                log(&m);
            }
        }
        if let Some(seq) = f.seq {
            shared.shown.post(seq, (t_spi.saturating_sub(epoch_mono) / 1000) as u32);
        }

        if fresh {
            n_fresh += 1;
            if f.n > 0 {
                stats.render.push(f.done_ns - f.started_ns);
                stats.lock.push(f.lock_ns);
            }
        } else {
            n_repeat += 1;
            if f.n > 0 {
                if let Some(m) = repeat_log.check(t_end, "render late: re-sent the previous frame") {
                    log(&m);
                }
            }
        }
        if f.n > 0 {
            stats.age.push(t_spi.saturating_sub(f.done_ns));
            stats.sample_to_spi.push(t_spi.saturating_sub(f.started_ns));
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
        shared.out_next.store(sched.deadline(), Ordering::Release);
        frames += 1;
        if frames == warmup {
            stats.clear();
            (n_fresh, n_repeat) = (0, 0);
            skipped0 = shared.skipped.load(Ordering::Relaxed);
            cpu = CpuWindow::now(shared.render_cpu.load(Ordering::Relaxed));
        }

        let skipped = shared.skipped.load(Ordering::Relaxed) - skipped0;
        if let Some(n) = o.frames {
            if frames >= n {
                println!(
                    "pace-bench pipeline=on frames={frames} warmup={warmup} rt={} split={} high={} edge={} timeout={} timed={} fresh={n_fresh} repeat={n_repeat} skipped={skipped} {} {}",
                    o.rt,
                    o.spi_split,
                    pacer.n_high,
                    pacer.n_edge,
                    pacer.n_timeout,
                    pacer.n_timed,
                    stats.report(),
                    cpu.report(shared.render_cpu.load(Ordering::Relaxed))
                );
                std::process::exit(0);
            }
        } else if let Some(every) = o.stats_every {
            if t_end - last_report >= every.as_nanos() as u64 {
                last_report = t_end;
                log(&format!(
                    "pace: frames={frames} mode={:?} high={} edge={} timeout={} timed={} fresh={n_fresh} repeat={n_repeat} skipped={skipped} (us min/p50/p99/max) {} {}",
                    pacer.mode,
                    pacer.n_high,
                    pacer.n_edge,
                    pacer.n_timeout,
                    pacer.n_timed,
                    stats.report(),
                    cpu.report(shared.render_cpu.load(Ordering::Relaxed))
                ));
                stats.clear();
                (n_fresh, n_repeat) = (0, 0);
                skipped0 = shared.skipped.load(Ordering::Relaxed);
                cpu = CpuWindow::now(shared.render_cpu.load(Ordering::Relaxed));
            }
        }
        if o.stats_every.is_none() && o.frames.is_none() && stats.period.len() >= 4096 {
            stats.clear();
        }
    }
}

/// The render thread: one frame ahead of the output on its deadline grid
/// (pipeline::RenderClock). Samples the player for the frame's deadline under
/// the lock, encodes outside it into the triple buffer's back slot, publishes.
/// Also records the output's "frame shown" reports into the player (the output
/// thread never takes the player lock).
#[allow(clippy::too_many_arguments)]
fn render_loop(
    player: &SharedPlayer,
    codec: &FpgaCodec,
    dark_n: usize,
    epoch_mono: u64,
    period: Duration,
    mut frames_out: Writer<FrameSlot>,
    shared: &PipeShared,
    o: &PaceOpts,
) {
    let prio = if o.rt && o.render_prio > 0 {
        match rt::set_thread_fifo(o.render_prio) {
            Ok(()) => format!("SCHED_FIFO {}", o.render_prio),
            Err(e) => format!("SCHED_FIFO failed ({e}; needs CAP_SYS_NICE)"),
        }
    } else {
        "SCHED_OTHER".to_string()
    };
    let cpu = match o.render_cpu.filter(|_| o.rt) {
        None => "not pinned".to_string(),
        Some(c) => match rt::pin_thread_to_cpu(c) {
            Ok(()) => format!("pinned to CPU {c}"),
            Err(e) => format!("pinning to CPU {c} failed ({e})"),
        },
    };
    log(&format!("render thread: {prio}, {cpu}"));
    let mut clock = RenderClock::new(period.as_nanos() as u64);
    let mut colors = Vec::with_capacity(dark_n);
    let mut last_shown = 0u64;
    let mut n = 0u64;
    loop {
        let target = clock.next_target(mono_ns(), shared.out_next.load(Ordering::Acquire));
        sleep_until_ns(clock.start_at(target));
        let started = mono_ns();
        let now_us = (target.saturating_sub(epoch_mono) / 1000) as i64;
        let (sampled, lock_ns) = {
            let mut p = player.lock().unwrap();
            let t_locked = mono_ns();
            if let Some((seq, t_us)) = shared.shown.take_new(&mut last_shown) {
                p.record_frame_shown(seq, t_us);
            }
            let s = pipeline::sample(&p, now_us, codec, &mut colors);
            (s, mono_ns() - t_locked)
        };
        let slot = frames_out.back();
        pipeline::encode(codec, &sampled, &colors, dark_n, slot);
        n += 1;
        slot.n = n;
        slot.target_ns = target;
        slot.started_ns = started;
        slot.lock_ns = lock_ns;
        slot.done_ns = mono_ns();
        if frames_out.publish() {
            shared.skipped.fetch_add(1, Ordering::Relaxed);
        }
        shared.render_cpu.store(thread_cpu_ns(), Ordering::Relaxed);
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
    let rt_cpu = rt::parse_cpu(&get("--rt-cpu", "auto"), ncpu).unwrap_or_else(|e| {
        eprintln!("player_rs: {e}");
        std::process::exit(2);
    });
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
        rt_cpu,
        spi_split: has("--spi-split"),
        stats_every: match get("--pace-stats", "0").parse::<f64>().expect("--pace-stats") {
            s if s > 0.0 => Some(Duration::from_secs_f64(s)),
            _ => None,
        },
        frames: match get("--frames", "0").parse::<u64>().expect("--frames") {
            0 => None,
            n => Some(n),
        },
        pipeline: match get("--pipeline", "on").as_str() {
            "on" => true,
            "off" => false,
            v => panic!("--pipeline {v}: expected on or off"),
        },
        render_prio: get("--render-prio", &rt::DEFAULT_RENDER_PRIO.to_string())
            .parse()
            .expect("--render-prio"),
        render_cpu: rt::parse_render_cpu(&get("--render-cpu", "auto"), rt_cpu, ncpu).unwrap_or_else(
            |e| {
                eprintln!("player_rs: {e}");
                std::process::exit(2);
            },
        ),
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
    // to a CPU (rt.rs), so the WS server can't jitter the frame clock. It sleeps
    // to each frame's absolute deadline, waits for the FPGA's frame-done edge
    // (pacing.rs), and hands the frame to SPI.
    //
    // Pipelined (default): a render thread (SCHED_FIFO below the output, on the
    // CPU below it) renders frame N+1 into a triple buffer while the output
    // thread sends frame N (pipeline.rs). `--pipeline off`: the output thread
    // renders each frame itself before the wait (#370's serial loop).
    //
    // musl defaults spawned-thread stacks to 128 KiB (vs glibc's 8 MiB); the
    // per-frame render over thousands of LEDs needs more headroom, so every
    // thread here gets an explicit stack size (see the tokio runtime below for
    // the same reason on the WS workers).
    const THREAD_STACK: usize = 4 * 1024 * 1024;
    let sink = match SpidevSink::open(bus, device, speed) {
        Ok(s) => Some(s),
        Err(e) => {
            eprintln!("player_rs: spidev open failed ({e}) — render loop disabled");
            None
        }
    };
    if let Some(mut sink) = sink {
        eprintln!(
            "player_rs: render {ports} ports @ {fps} fps, spidev{bus}.{device} @ {speed} Hz, pipeline {}",
            if pace_opts.pipeline { "on" } else { "off" }
        );
        if pace_opts.pipeline {
            let start_ns = mono_ns();
            let shared = Arc::new(PipeShared {
                out_next: AtomicU64::new(start_ns),
                shown: ShownMailbox::default(),
                skipped: AtomicU64::new(0),
                render_cpu: AtomicU64::new(0),
            });
            // Slots sized for the largest frame known at start (they grow, once,
            // if a client maps a longer strip) and pre-filled with the idle frame.
            let slot = || FrameSlot::dark(&codec, dark_n, dark_n);
            let (writer, reader) = triple::triple([slot(), slot(), slot()]);
            {
                let (player, codec, shared, pace) =
                    (player.clone(), codec.clone(), shared.clone(), pace_opts.clone());
                std::thread::Builder::new()
                    .name("render".into())
                    .stack_size(THREAD_STACK)
                    .spawn(move || {
                        render_loop(&player, &codec, dark_n, epoch_mono, period, writer, &shared, &pace)
                    })?;
            }
            let pace = pace_opts;
            std::thread::Builder::new()
                .name("output".into())
                .stack_size(THREAD_STACK)
                .spawn(move || {
                    pipelined_output_loop(reader, &shared, epoch_mono, start_ns, period, &mut sink, &pace)
                })?;
        } else {
            let player = player.clone();
            let pace = pace_opts;
            std::thread::Builder::new()
                .name("render".into())
                .stack_size(THREAD_STACK)
                .spawn(move || {
                    serial_output_loop(&player, &codec, dark_n, epoch_mono, period, &mut sink, &pace)
                })?;
        }
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
