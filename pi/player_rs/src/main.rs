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
use ledmapper_player_rs::render::{render_fpga, tick_fpga, RecordingSink, Sink};
use ledmapper_player_rs::server::{self, SharedPlayer};
use ledmapper_player_rs::session;
use ledmapper_player_rs::wire::{matched_speed_hz, FpgaCodec, GRB};
use sink::SpidevSink;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

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
                loop {
                    let now_us = epoch.elapsed().as_micros() as i64;
                    let (config, stream) = {
                        let mut p = player.lock().unwrap();
                        let f = render_fpga(&p, now_us, &codec, dark_n);
                        if let Some(seq) = f.seq {
                            p.record_frame_shown(seq, now_us as u32);
                        }
                        (f.config, f.stream)
                    };
                    let _ = sink.write(&config);
                    let _ = sink.write(&stream);
                    std::thread::sleep(period);
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
    let rt = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    rt.block_on(server::serve(player, addr, config, epoch))?;
    Ok(())
}
