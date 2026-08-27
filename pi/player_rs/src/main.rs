//! `player_rs` — the Rust Raspberry Pi player binary (M1 render path).
//!
//! Phase 2 capstone: drives the spi_ws281x FPGA (or SK9822) from the reused
//! `ledmapper_player` core. `--start N` synthesises a mapping capture and
//! free-runs the gray-code cycle so the SPI/WS wire is active for the HITL
//! logic-analyzer probe — the Rust analogue of the Python
//! `led_driver --output fpga --start N`. WS control + effects land in Phase 3.

mod sink;

use ledmapper_player::Player;
use ledmapper_player_rs::render::{tick_fpga, RecordingSink};
use ledmapper_player_rs::session;
use ledmapper_player_rs::wire::{matched_speed_hz, FpgaCodec, GRB};
use sink::SpidevSink;
use std::time::{Duration, Instant};

fn main() -> std::io::Result<()> {
    let argv: Vec<String> = std::env::args().collect();
    let get = |name: &str, def: &str| -> String {
        argv.windows(2)
            .find(|w| w[0] == name)
            .map(|w| w[1].clone())
            .unwrap_or_else(|| def.to_string())
    };
    let has = |name: &str| argv.iter().any(|a| a == name);

    let ports: usize = get("--fpga-ports", "8").parse().expect("--fpga-ports");
    let start_leds: usize = get("--start", "16").parse().expect("--start");
    let fps: f64 = get("--fps", "10").parse().expect("--fps");
    let bus: u8 = get("--bus", "0").parse().expect("--bus");
    let device: u8 = get("--device", "0").parse().expect("--device");
    let dry = has("--dry-run");
    let speed_arg: u32 = get("--speed-hz", "0").parse().expect("--speed-hz");
    // FPGA default: 2x the rate-matched clock, capped at 24 MHz (the FPGA has a
    // per-port FIFO, so faster-than-matched is safe up to the SPI ceiling).
    let speed = if speed_arg > 0 {
        speed_arg
    } else {
        (matched_speed_hz(ports as u32) * 2).min(24_000_000)
    };

    let bit_period_ms = 1000.0 / fps;
    let codec = FpgaCodec::new(ports, GRB, None).expect("--fpga-ports must be >= 1");

    // Monotonic clock: epoch 0 stamped just before start_mapping, now_us relative.
    let t0 = Instant::now();
    let mut player = Player::new("pi-player-0001", start_leds as u32);
    session::start_mapping(&mut player, start_leds as u32, bit_period_ms, 1.0, 0)
        .expect("core rejected start_mapping");

    let period = Duration::from_secs_f64(bit_period_ms / 1000.0);

    if dry {
        let mut s = RecordingSink::default();
        tick_fpga(&mut player, 0, &codec, start_leds, &mut s)?;
        let stream = s.writes.get(1).map(Vec::len).unwrap_or(0);
        println!("dry-run: {} buffers, {stream} B STREAM for {start_leds} LEDs / {ports} ports", s.writes.len());
        return Ok(());
    }

    let mut sink = SpidevSink::open(bus, device, speed)?;
    eprintln!(
        "player_rs: FPGA {ports} ports, {start_leds} LEDs @ {fps} fps, spidev{bus}.{device} @ {speed} Hz"
    );
    loop {
        let now_us = t0.elapsed().as_micros() as i64;
        tick_fpga(&mut player, now_us, &codec, start_leds, &mut sink)?;
        std::thread::sleep(period);
    }
}
