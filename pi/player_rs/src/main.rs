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

mod sink;

use ledmapper_player::Player;
use ledmapper_player_rs::render::{render_fpga, tick_fpga, RecordingSink};
use ledmapper_player_rs::server::{self, SharedPlayer};
use ledmapper_player_rs::{health, ota};
use ledmapper_player_rs::spi_retry::{Backoff, Event, Output, OUTPUT_PENDING};
use ledmapper_player_rs::session;
use ledmapper_player_rs::wire::{matched_speed_hz, FpgaCodec, GRB};
use sink::SpidevSink;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// Stack for every thread that runs `Player::handle` (main + the WS workers). The
/// host-profile core's `Player::handle` frame alone is ~8.2 MiB (by-value protobuf
/// envelopes in every arm), more than the 8 MiB main-thread rlimit and the old
/// 8 MiB tokio worker stacks: `--start N` (start_mapping at boot) and any client
/// frame overflowed and SEGV'd the static-musl player. Pages are only touched when
/// used, so a generous reservation costs address space, not RAM.
const HANDLER_STACK: usize = 32 * 1024 * 1024;

/// Welcome features: the protocol features this player serves, plus
/// [`OUTPUT_PENDING`] while the render loop has no working output (spidev missing
/// or failing) — so a client can tell "connected, but nothing reaches the LEDs".
const FEATURES_READY: &[&str] = &["ota", "ota_pull"];
const FEATURES_PENDING: &[&str] = &["ota", "ota_pull", OUTPUT_PENDING];

/// Advertise the output state in the welcome, on change only; true if it changed.
fn set_output_ready(player: &SharedPlayer, ready: bool) -> bool {
    static READY: AtomicBool = AtomicBool::new(false);
    let changed = READY.swap(ready, Ordering::Relaxed) != ready;
    if changed {
        let feats = if ready { FEATURES_READY } else { FEATURES_PENDING };
        player.lock().unwrap().set_features(feats, 0);
    }
    changed
}

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    std::thread::Builder::new()
        .name("main".into())
        .stack_size(HANDLER_STACK)
        .spawn(real_main)?
        .join()
        .map_err(|_| "player main thread panicked")?
}

fn real_main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
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

    let epoch = Instant::now();
    let player: SharedPlayer = Arc::new(Mutex::new(Player::new(
        "pi-player-0001",
        std::cmp::max(start_leds as u32, 1),
    )));
    // Over-the-air updates (docs/design/max-ota.md): this player answers the OTA arms
    // from the MAX updater's state and pulls its image; the welcome says so. The
    // .fxb format stays 0 (unchanged: the Pi's VM path predates the field).
    // Until the render loop first opens spidev, the welcome also carries
    // `output_pending` (see set_output_ready).
    player.lock().unwrap().set_features(FEATURES_PENDING, 0);
    let _ = server::OTA.set(ota::Ota::on_this_pi());
    // The health file the updater's trial check reads (--health-file "" disables it).
    let health_file = get("--health-file", "/run/ledmapper/health");
    if !health_file.is_empty() && !dry {
        health::spawn_writer(health_file.into(), epoch);
    }
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

    if dry {
        let mut p = player.lock().unwrap();
        let mut s = RecordingSink::default();
        tick_fpga(&mut p, 0, &codec, dark_n, &mut s)?;
        let stream = s.writes.get(1).map(Vec::len).unwrap_or(0);
        println!("dry-run: {} buffers, {stream} B STREAM / {ports} ports", s.writes.len());
        return Ok(());
    }

    // Realtime render loop on its OWN OS thread (not a tokio task) so the WS
    // server's scheduling can't jitter the frame clock. It holds the player lock
    // only to compute the frame + record the shown seq, then writes SPI unlocked.
    {
        let player = player.clone();
        std::thread::Builder::new()
            .name("render".into())
            // musl defaults spawned-thread stacks to 128 KiB (vs glibc's 8 MiB);
            // the per-frame render over 2200 LEDs needs more headroom. See the
            // tokio runtime below for the same reason on the WS workers.
            .stack_size(4 * 1024 * 1024)
            .spawn(move || {
                // Never give up on output (effects keep running): a missing
                // /dev/spidev (cold boot, Tang not enumerated yet) or a failed
                // write parks the output in Pending and retries with backoff while
                // the WSS server keeps serving; rendering starts once it opens.
                let mut out = Output::new(
                    move || SpidevSink::open(bus, device, speed),
                    Backoff::player_default(),
                );
                let spi = format!("spidev{bus}.{device}");
                let mut retried = 0u32;
                loop {
                    let delay = match out.ensure_open() {
                        Event::Wait { delay, log } => Some((delay, log)),
                        ev => {
                            if let Event::Opened { retries } = ev {
                                retried += retries;
                            }
                            let now_us = epoch.elapsed().as_micros() as i64;
                            let (config, stream) = {
                                let mut p = player.lock().unwrap();
                                let f = render_fpga(&p, now_us, &codec, dark_n);
                                if let Some(seq) = f.seq {
                                    p.record_frame_shown(seq, now_us as u32);
                                }
                                (f.config, f.stream)
                            };
                            match out.write_frame(&[&config, &stream]) {
                                // The OTA trial's health proof counts frames that reached SPI.
                                Event::Ready => {
                                    health::TICKS.fetch_add(1, Ordering::Relaxed);
                                    // Ready = a frame actually landed (not just an
                                    // open), so a sink that opens but rejects every
                                    // write stays "pending" and logs nothing new.
                                    if set_output_ready(&player, true) {
                                        let note = if retried > 0 {
                                            format!(" (output ready after {retried} retries)")
                                        } else {
                                            String::new()
                                        };
                                        eprintln!(
                                            "player_rs: render {ports} ports @ {fps} fps, \
                                             {spi} @ {speed} Hz{note}"
                                        );
                                        retried = 0;
                                    }
                                    None
                                }
                                Event::Wait { delay, log } => Some((delay, log)),
                                Event::Opened { .. } => None,
                            }
                        }
                    };
                    match delay {
                        None => std::thread::sleep(period),
                        Some((delay, log)) => {
                            if let Some(e) = log {
                                eprintln!(
                                    "player_rs: output not ready: {spi} {e} — WSS stays up, \
                                     retrying with backoff (<= 5 s); is the device present / \
                                     spidev.bufsiz large enough? (logged once per change)"
                                );
                            }
                            set_output_ready(&player, false);
                            std::thread::sleep(delay);
                        }
                    }
                }
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
        .thread_stack_size(HANDLER_STACK)
        .build()?;
    rt.block_on(server::serve(player, addr, config, epoch))?;
    Ok(())
}
