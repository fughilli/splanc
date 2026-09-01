//! Render loop — pulls per-LED colours from the reused `ledmapper_player` core
//! and frames them for an output sink.
//!
//! The player core owns ALL pattern logic (mapping gray-code, counting probe,
//! per-capture brightness); this module only decides which source is active,
//! derives the frame index from the pattern clock, encodes via the FPGA codec,
//! and emits. It is the aarch64/std analogue of `firmware/player_app`'s C++
//! render loop and the Python driver `_run`, running the SAME core.

use crate::wire::{FpgaCodec, Rgb};
use ledmapper_player::Player;

/// Anything the render loop can push framed bytes to — the injection seam.
/// `SpidevSink` drives the real bus; `RecordingSink` captures for tests.
pub trait Sink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<()>;
}

/// Test/dry-run sink: keeps every buffer written.
#[derive(Default)]
pub struct RecordingSink {
    pub writes: Vec<Vec<u8>>,
}

impl Sink for RecordingSink {
    fn write(&mut self, data: &[u8]) -> std::io::Result<()> {
        self.writes.push(data.to_vec());
        Ok(())
    }
}

fn arr(c: (u8, u8, u8)) -> Rgb {
    [c.0, c.1, c.2]
}

/// What the player wants driven right now, in priority order.
#[derive(Clone, Debug, PartialEq)]
pub enum Source {
    /// The LED-counting probe handshake (an explicit operator action; wins).
    Counting { n: u32, order: [u8; 3] },
    /// The mapping gray-code pattern, phase-locked to the pattern clock.
    Mapping {
        n: u32,
        epoch_us: i64,
        bit_period_us: u32,
        cycle_frames: u32,
    },
    /// Nothing active — hold the strip dark.
    Idle,
}

/// Decide the active render source from the player's current state.
pub fn pick_source(player: &Player) -> Source {
    let n = player.counting_len();
    if n > 0 {
        return Source::Counting {
            n,
            order: player.counting_color_order(),
        };
    }
    if let Some((epoch_ms, bit_period_us, cycle_frames, led_count)) = player.pattern_timing() {
        return Source::Mapping {
            n: led_count,
            epoch_us: epoch_ms.saturating_mul(1000),
            bit_period_us,
            cycle_frames,
        };
    }
    Source::Idle
}

/// The absolute mapping frame index at `now_us` for a pattern that started at
/// `epoch_us` with `bit_period_us` per frame. Absolute (pre-modulo) so it can be
/// fed back to the phone via `record_frame_shown`.
pub fn mapping_seq(now_us: i64, epoch_us: i64, bit_period_us: u32) -> u32 {
    let elapsed = now_us.saturating_sub(epoch_us).max(0) as u64;
    (elapsed / u64::from(bit_period_us.max(1))) as u32
}

/// One rendered FPGA frame: the per-flush CSR write plus the STREAM payload, and
/// the absolute mapping seq shown (for `record_frame_shown`), if a mapping
/// pattern is driving. For `Idle` the payload is an all-dark STREAM of `dark_n`
/// LEDs so the strip is explicitly cleared rather than left latched.
pub struct FpgaFrame {
    /// The WRITE_CSR transaction (re-sent every frame: num_ports reverts on any
    /// FPGA reconfig, so the driver can never assume it stuck).
    pub config: Vec<u8>,
    /// The STREAM transaction.
    pub stream: Vec<u8>,
    /// Absolute mapping frame index shown, when driving the mapping pattern.
    pub seq: Option<u32>,
}

/// Render the FPGA frame the player wants at `now_us`. `dark_n` is the LED count
/// to clear when idle (typically the configured strip length).
pub fn render_fpga(player: &Player, now_us: i64, codec: &FpgaCodec, dark_n: usize) -> FpgaFrame {
    match pick_source(player) {
        Source::Counting { n, order } => {
            let colors: Vec<Rgb> = (0..n)
                .map(|i| arr(player.counting_color(i).unwrap_or((0, 0, 0))))
                .collect();
            let probe = FpgaCodec {
                order,
                ..codec.clone()
            };
            FpgaFrame {
                config: codec.configure(),
                stream: probe.frame(&colors),
                seq: None,
            }
        }
        Source::Mapping {
            n,
            epoch_us,
            bit_period_us,
            cycle_frames,
        } => {
            let seq = mapping_seq(now_us, epoch_us, bit_period_us);
            let frame = if cycle_frames > 0 {
                seq % cycle_frames
            } else {
                0
            };
            let colors: Vec<Rgb> = (0..n)
                .map(|i| arr(player.pattern_color(i, frame).unwrap_or((0, 0, 0))))
                .collect();
            FpgaFrame {
                config: codec.configure(),
                stream: codec.frame(&colors),
                seq: Some(seq),
            }
        }
        Source::Idle => FpgaFrame {
            config: codec.configure(),
            stream: codec.dark(dark_n),
            seq: None,
        },
    }
}

/// Drive one FPGA tick to `sink`: the CSR write then the STREAM payload (each a
/// separate transfer so CS frames it), recording the shown seq back into the
/// player for the phone's frame-timing feedback.
pub fn tick_fpga<S: Sink>(
    player: &mut Player,
    now_us: i64,
    codec: &FpgaCodec,
    dark_n: usize,
    sink: &mut S,
) -> std::io::Result<()> {
    let frame = render_fpga(player, now_us, codec, dark_n);
    sink.write(&frame.config)?;
    sink.write(&frame.stream)?;
    if let Some(seq) = frame.seq {
        player.record_frame_shown(seq, now_us as u32);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{GRB, OP_STREAM, OP_WRITE_CSR};
    use ledmapper_pb::ledmapper_::v1_ as pb;
    use pb::ClientMessage_::Msg as CMsg;
    use pb::ServerMessage_::Msg as SMsg;

    fn send(player: &mut Player, msg: CMsg, now: i64) -> Option<SMsg> {
        let req = pb::ClientMessage { r#msg: Some(msg) };
        player.handle(req, now, now).and_then(|r| r.r#msg)
    }

    fn start_mapping(player: &mut Player, led_count: u32, epoch_ms: i64) {
        let mut opts = pb::StartMappingOptions::default();
        opts.r#led_count = led_count as i32;
        let mut start = pb::StartMapping::default();
        start.set_options(opts);
        let reply = send(player, CMsg::StartMapping(start), epoch_ms);
        assert!(
            matches!(reply, Some(SMsg::MappingStarted(_))),
            "start_mapping must produce mapping_started, got {reply:?}"
        );
    }

    #[test]
    fn idle_source_when_no_pattern() {
        let player = Player::new("pi-0001", 64);
        assert_eq!(pick_source(&player), Source::Idle);
    }

    #[test]
    fn mapping_source_after_start() {
        let mut player = Player::new("pi-0001", 64);
        start_mapping(&mut player, 16, 1000);
        match pick_source(&player) {
            Source::Mapping {
                n,
                epoch_us,
                cycle_frames,
                ..
            } => {
                assert_eq!(n, 16);
                assert_eq!(epoch_us, 1_000_000); // 1000 ms -> us
                assert!(cycle_frames >= 2, "gray-code has >=2 frames");
            }
            other => panic!("expected Mapping, got {other:?}"),
        }
    }

    #[test]
    fn mapping_seq_advances_with_clock() {
        // epoch 1000ms, bit period 100ms: at t=1000ms seq 0, at 1350ms seq 3.
        assert_eq!(mapping_seq(1_000_000, 1_000_000, 100_000), 0);
        assert_eq!(mapping_seq(1_350_000, 1_000_000, 100_000), 3);
        // before epoch clamps to 0
        assert_eq!(mapping_seq(500_000, 1_000_000, 100_000), 0);
    }

    #[test]
    fn render_mapping_frame_matches_core_colors() {
        let mut player = Player::new("pi-0001", 64);
        start_mapping(&mut player, 8, 1000);
        let codec = FpgaCodec::new(2, GRB, None).unwrap();

        // frame 0 is the ALL_ON (white) sync frame -> every LED white.
        let now_us = 1_000_000; // == epoch, seq 0
        let f = render_fpga(&player, now_us, &codec, 8);
        assert_eq!(f.config, vec![OP_WRITE_CSR, 0x00, 2]);
        assert_eq!(f.stream[0], OP_STREAM);
        assert_eq!(f.seq, Some(0));

        // Cross-check the payload against the core's own pattern_color: 8 LEDs
        // split [4,4] across 2 ports, interleaved GRB byte-by-byte.
        let colors: Vec<Rgb> = (0..8)
            .map(|i| {
                let c = player.pattern_color(i, 0).unwrap();
                [c.0, c.1, c.2]
            })
            .collect();
        assert_eq!(f.stream, codec.frame(&colors));
        // white (255,255,255) -> GRB (255,255,255); all payload bytes 0xFF.
        assert!(f.stream[1..].iter().all(|&b| b == 0xFF));
    }

    #[test]
    fn tick_writes_config_then_stream_and_records() {
        let mut player = Player::new("pi-0001", 64);
        start_mapping(&mut player, 8, 1000);
        let codec = FpgaCodec::new(2, GRB, None).unwrap();
        let mut sink = RecordingSink::default();
        tick_fpga(&mut player, 1_250_000, &codec, 8, &mut sink).unwrap();
        assert_eq!(sink.writes.len(), 2);
        assert_eq!(sink.writes[0][0], OP_WRITE_CSR);
        assert_eq!(sink.writes[1][0], OP_STREAM);
    }

    #[test]
    fn idle_tick_clears_strip() {
        let player = Player::new("pi-0001", 64);
        let codec = FpgaCodec::new(4, GRB, None).unwrap();
        let f = render_fpga(&player, 0, &codec, 40);
        assert_eq!(f.stream[0], OP_STREAM);
        assert!(f.stream[1..].iter().all(|&b| b == 0), "idle must be all dark");
        assert_eq!(f.seq, None);
    }
}
