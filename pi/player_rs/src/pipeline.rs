//! Pipelined output: a render thread produces frames into a triple buffer
//! (triple.rs) while the output thread sends the newest completed one, so
//! frame N+1 renders while frame N is on the SPI bus.
//!
//! Before (#370, `--pipeline off`) the output thread rendered and then sent,
//! serially: at 20 x 260 LEDs that is ~4.6 ms + ~5.7 ms = 10.3 ms, so 120 fps
//! (8.33 ms) ran at ~96 fps. Pipelined, the output thread only gates and
//! sends; rendering happens on another CPU during the previous frame's send.
//!
//! Timing: the output thread keeps the clock (absolute deadlines + the
//! frame-done gate, pacing.rs). The render thread follows that grid one frame
//! ahead: it starts rendering the frame for deadline D one period before D
//! (`RenderClock`), samples the player for time D, and publishes. The output
//! thread takes the newest published frame right before its SPI write. So the
//! frame's content is stamped with the time it actually goes out; inputs (WS
//! changes) reach the light up to one period later than before.
//!
//! Lag beats cut-out: if a render overruns, the output thread re-sends its
//! current (last) frame on the frame-done clock instead of waiting or sending
//! black, and the render thread re-aims at the next deadline it can make.

use crate::render::{pick_source, mapping_seq, Source};
use crate::wire::{FpgaCodec, Rgb};
use ledmapper_player::Player;
use std::sync::atomic::{AtomicU64, Ordering};

/// One frame in a triple-buffer slot. The vectors are reused frame to frame
/// (cleared and refilled in place), so steady state allocates nothing.
#[derive(Default)]
pub struct FrameSlot {
    pub config: Vec<u8>,
    pub stream: Vec<u8>,
    /// Absolute mapping seq shown, when the mapping pattern is driving.
    pub seq: Option<u32>,
    /// The output deadline this frame was rendered for (CLOCK_MONOTONIC ns).
    pub target_ns: u64,
    /// When the render started (the player was sampled), ns.
    pub started_ns: u64,
    /// When the render finished (published), ns.
    pub done_ns: u64,
    /// Time holding the player lock, ns.
    pub lock_ns: u64,
    /// Render thread timer wake-up lateness past its start time, ns.
    pub wake_late_ns: u64,
    /// Time waiting for the output to take the previous frame, ns.
    pub wait_ns: u64,
    /// Monotonic render number (1 = first).
    pub n: u64,
}

impl FrameSlot {
    /// A slot pre-sized for `max_leds` and holding the idle (dark) frame, so
    /// the output always has a valid frame to send, even before the first
    /// render.
    pub fn dark(codec: &FpgaCodec, max_leds: usize, dark_n: usize) -> Self {
        let mut s = Self {
            config: Vec::with_capacity(8),
            stream: Vec::with_capacity(codec.stream_len(max_leds.max(dark_n))),
            ..Default::default()
        };
        codec.configure_into(&mut s.config);
        codec.dark_into(dark_n, &mut s.stream);
        s
    }
}

/// What `sample` read from the player (under its lock).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sampled {
    pub order: [u8; 3],
    pub seq: Option<u32>,
    pub idle: bool,
}

/// Read the colours the player wants at `now_us` into `colors` (cleared and
/// refilled; reused across frames). This is the part that needs the player
/// lock; encoding (`encode`) happens after it is released.
pub fn sample(player: &Player, now_us: i64, codec: &FpgaCodec, colors: &mut Vec<Rgb>) -> Sampled {
    colors.clear();
    let c = |o: Option<(u8, u8, u8)>| -> Rgb {
        let (r, g, b) = o.unwrap_or((0, 0, 0));
        [r, g, b]
    };
    match pick_source(player) {
        Source::Counting { n, order } => {
            colors.extend((0..n).map(|i| c(player.counting_color(i))));
            Sampled { order, seq: None, idle: false }
        }
        Source::Mapping { n, epoch_us, bit_period_us, cycle_frames } => {
            let seq = mapping_seq(now_us, epoch_us, bit_period_us);
            let frame = if cycle_frames > 0 { seq % cycle_frames } else { 0 };
            colors.extend((0..n).map(|i| c(player.pattern_color(i, frame))));
            Sampled { order: codec.order, seq: Some(seq), idle: false }
        }
        Source::Idle => Sampled { order: codec.order, seq: None, idle: true },
    }
}

/// Encode a sampled frame into `slot` (no player lock needed). Byte-identical
/// to `render::render_fpga` for the same player state and time.
pub fn encode(codec: &FpgaCodec, s: &Sampled, colors: &[Rgb], dark_n: usize, slot: &mut FrameSlot) {
    codec.configure_into(&mut slot.config);
    if s.idle {
        codec.dark_into(dark_n, &mut slot.stream);
    } else {
        codec.frame_into(colors, s.order, &mut slot.stream);
    }
    slot.seq = s.seq;
}

/// The render thread's schedule: which output deadline to render for next, and
/// when to start.
pub struct RenderClock {
    pub period_ns: u64,
    /// How far ahead of its deadline a frame starts rendering.
    pub lead_ns: u64,
    last_target: Option<u64>,
}

impl RenderClock {
    pub fn new(period_ns: u64) -> Self {
        Self { period_ns, lead_ns: period_ns, last_target: None }
    }

    /// The next frame's target deadline. `out_next` is the deadline the output
    /// thread is heading for (it publishes it after each send), so targets stay
    /// on its grid even after it re-bases on a late frame. The target is:
    ///   * at least one period after the last target (one render per slot);
    ///   * at least half a period from `now` (after an overrun, aim at a
    ///     deadline the render can still make rather than one already gone);
    ///   * on the output's grid (`out_next + k * period`, k >= 0).
    pub fn next_target(&mut self, now: u64, out_next: u64) -> u64 {
        let p = self.period_ns.max(1);
        let floor = self
            .last_target
            .map(|t| t + p)
            .unwrap_or(0)
            .max(now + p / 2);
        let t = if out_next >= floor {
            out_next
        } else {
            out_next + (floor - out_next).div_ceil(p) * p
        };
        self.last_target = Some(t);
        t
    }

    /// When to start rendering for `target`.
    pub fn start_at(&self, target: u64) -> u64 {
        target.saturating_sub(self.lead_ns)
    }
}

/// The output thread's "frame shown" report for the render thread, which owns
/// the player lock and calls `Player::record_frame_shown` (so the RT output
/// thread never takes the player lock). Packs (seq, t_us) into one atomic: a
/// lossy latest-value mailbox, like the frame log's own overflow policy.
#[derive(Default)]
pub struct ShownMailbox(AtomicU64);

impl ShownMailbox {
    /// Report that mapping frame `seq` went out at player time `t_us`.
    pub fn post(&self, seq: u32, t_us: u32) {
        // seq in the high word, t_us in the low word, bit 63 = valid (so a
        // (0, 0) report differs from "empty"). The reader compares against the
        // last value it recorded, so each distinct report is recorded once.
        self.0
            .store(((seq as u64) << 32) | t_us as u64 | VALID, Ordering::Release);
    }

    /// The latest report if it differs from `last` (updated in place).
    pub fn take_new(&self, last: &mut u64) -> Option<(u32, u32)> {
        let v = self.0.load(Ordering::Acquire);
        if v & VALID == 0 || v == *last {
            return None;
        }
        *last = v;
        Some((((v & !VALID) >> 32) as u32, v as u32))
    }
}

/// Bit 63 can't belong to a real report only if seq < 2^31; mapping seqs are
/// frame counts since the pattern epoch (2^31 frames is > 200 days at 120 fps).
const VALID: u64 = 1 << 63;

/// Per-thread CPU time (CLOCK_THREAD_CPUTIME_ID), ns.
pub fn thread_cpu_ns() -> u64 {
    cpu_clock(libc::CLOCK_THREAD_CPUTIME_ID)
}

/// Whole-process CPU time (CLOCK_PROCESS_CPUTIME_ID), ns.
pub fn process_cpu_ns() -> u64 {
    cpu_clock(libc::CLOCK_PROCESS_CPUTIME_ID)
}

fn cpu_clock(id: libc::clockid_t) -> u64 {
    let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
    // SAFETY: valid out-pointer; both CPU-time clocks exist on Linux.
    unsafe { libc::clock_gettime(id, &mut ts) };
    ts.tv_sec as u64 * 1_000_000_000 + ts.tv_nsec as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::render_fpga;
    use crate::wire::GRB;

    const P: u64 = 8_333_333;

    #[test]
    fn steady_state_renders_one_frame_ahead_on_the_output_grid() {
        let mut c = RenderClock::new(P);
        // Start: output heading for D0 = 1 s; now just before it.
        let d0 = 1_000_000_000;
        let t = c.next_target(d0 - 100, d0);
        assert_eq!(t, d0 + P, "can't make D0 in half a period: aim at D1");
        assert_eq!(c.start_at(t), d0);
        // Rendered by d0 + 4.6 ms; the output has sent D0 and heads for D1.
        let t = c.next_target(d0 + 4_600_000, d0 + P);
        assert_eq!(t, d0 + 2 * P);
        assert_eq!(c.start_at(t), d0 + P, "next render starts at D1, for D2");
    }

    #[test]
    fn overrun_skips_to_a_reachable_deadline_on_the_grid() {
        let mut c = RenderClock::new(P);
        let d0 = 1_000_000_000;
        assert_eq!(c.next_target(d0, d0 + P), d0 + P);
        // That render overran by 2.2 periods.
        let now = d0 + P + 2 * P + P / 5;
        let t = c.next_target(now, d0 + 3 * P);
        assert_eq!(t, d0 + 4 * P, "first grid deadline >= now + P/2");
        assert!(t >= now + P / 2);
    }

    #[test]
    fn follows_an_output_rebase() {
        let mut c = RenderClock::new(P);
        let d0 = 1_000_000_000;
        assert_eq!(c.next_target(d0 - P, d0), d0);
        // The output sent late and re-based its grid by +3 ms.
        let out_next = d0 + P + 3_000_000;
        let t = c.next_target(d0 + 1_000_000, out_next);
        assert_eq!(t, out_next);
        assert_eq!(c.next_target(d0 + P + 4_000_000, out_next), out_next + P);
    }

    #[test]
    fn mailbox_reports_each_new_value_once() {
        let m = ShownMailbox::default();
        let mut last = 0;
        assert_eq!(m.take_new(&mut last), None);
        m.post(0, 0);
        assert_eq!(m.take_new(&mut last), Some((0, 0)));
        assert_eq!(m.take_new(&mut last), None);
        m.post(7, 123_456);
        m.post(8, u32::MAX);
        assert_eq!(m.take_new(&mut last), Some((8, u32::MAX)), "latest wins");
        assert_eq!(m.take_new(&mut last), None);
    }

    #[test]
    fn sample_plus_encode_matches_render_fpga() {
        use ledmapper_pb::ledmapper_::v1_ as pb;
        use micropb::{MessageEncode, PbEncoder};
        let codec = FpgaCodec::new(3, GRB, None).unwrap();
        let mut colors = Vec::new();
        let mut slot = FrameSlot::dark(&codec, 64, 10);

        // Idle.
        let player = Player::new("pi-0001", 64);
        let s = sample(&player, 0, &codec, &mut colors);
        encode(&codec, &s, &colors, 10, &mut slot);
        let f = render_fpga(&player, 0, &codec, 10);
        assert_eq!((&slot.config, &slot.stream, slot.seq), (&f.config, &f.stream, f.seq));

        // Mapping, a few frames in.
        let mut player = Player::new("pi-0001", 64);
        let opts = pb::StartMappingOptions { r#led_count: 23, ..Default::default() };
        let mut start = pb::StartMapping::default();
        start.set_options(opts);
        let req = pb::ClientMessage { r#msg: Some(pb::ClientMessage_::Msg::StartMapping(start)) };
        let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 4096>::new());
        req.encode(&mut enc).unwrap();
        player.handle_frame(&enc.into_writer(), 1000, 1000).unwrap();
        for now_us in [1_000_000i64, 1_250_000, 1_900_000, 9_000_000] {
            let s = sample(&player, now_us, &codec, &mut colors);
            encode(&codec, &s, &colors, 10, &mut slot);
            let f = render_fpga(&player, now_us, &codec, 10);
            assert_eq!(slot.stream, f.stream, "t={now_us}");
            assert_eq!(slot.config, f.config);
            assert_eq!(slot.seq, f.seq);
        }
    }
}
