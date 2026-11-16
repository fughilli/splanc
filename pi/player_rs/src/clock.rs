//! Shared effect time (multi-fixture sync) — the player_rs side of the C6's
//! `set_time_base` (firmware/player_app/main.cpp, the fx frame).
//!
//! One clock, one domain: the WS task stamps `TimeSyncPong.t1/t2` with
//! [`crate::server::now_ms`] (whole ms since the process `epoch` Instant), the
//! bridge (agent/src/timesync.ts) maps its clock onto that and sends
//! `SetTimeBase.epoch_ms` in it, and the render loop reads its frame time from
//! the SAME `epoch` Instant. So with a time base set, every player computes
//! effect time = (now - epoch_ms) / 1000 on a clock the bridge has aligned,
//! and fixtures animate in step. update()'s dt follows the C6's rule exactly
//! ([`time_base_frame`]), so integrating effects stay in step through the
//! bridge's drift-slewing epoch nudges too.
//!
//! On top of that a host player can render AHEAD by a fixed output latency
//! (`--output-latency-ms`): DDP / Art-Net into a WLED board lights the LEDs
//! some milliseconds after the frame leaves this process, while a C6 lights
//! them right after it renders. Rendering at shared time + latency makes the
//! photons line up. See docs/host-player.md ("Output latency").

/// The welcome feature that says this player honours `set_time_base` (the
/// bridge's alignTime gates on it, agent/src/session.ts setTimeBase).
pub const FEATURE_TIME_BASE: &str = "time_base";

/// One frame's notion of time, sampled once per frame by the render loop.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FrameTime {
    /// The player's monotonic clock, seconds since the process epoch. Drives
    /// effect time when no time base is set (free-running, as before), and gives
    /// the wall frame period the shared-time rule falls back on.
    pub local_s: f64,
    /// Present while a shared time base is set.
    pub shared: Option<Shared>,
}

/// This frame's position on the shared time base.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shared {
    /// now + latency - epoch, whole ms on the player clock (may be negative:
    /// before the epoch). Whole ms, as the C6's millis(), so [`time_base_frame`]
    /// is the C6's rule bit for bit.
    pub since_ms: i64,
}

impl Shared {
    /// Effect time, seconds: since / 1000, held at 0 before the epoch.
    pub fn time_s(&self) -> f64 {
        self.since_ms.max(0) as f64 / 1000.0
    }
}

impl FrameTime {
    /// Sample a frame's time. `now_us` is the player clock in µs (the same
    /// `epoch` Instant [`crate::server::now_ms`] reads), `time_base_ms` the
    /// core's `Player::time_base_ms()`, `latency_ms` the render-ahead offset
    /// (applied only to shared time: a free-running clock has no peer to be
    /// late against).
    pub fn sample(now_us: i64, time_base_ms: Option<i64>, latency_ms: i64) -> Self {
        let shared = time_base_ms.map(|epoch_ms| Shared { since_ms: now_us.div_euclid(1000) + latency_ms - epoch_ms });
        Self { local_s: now_us as f64 / 1_000_000.0, shared }
    }
}

/// A shared-time-base frame whose `now - epoch` moved further than its wall
/// frame period plus this (ms) is a re-align, not elapsed time: update() gets
/// the wall period instead of fast-forwarding its integrators by the jump.
/// Same value as the C6 (firmware/player_app/ffi.rs `TB_JUMP_SLACK_MS`).
pub const TB_JUMP_SLACK_MS: i64 = 250;

/// The wall period of a frame with no previous frame (main.cpp's fresh-entry 33 ms).
const FRESH_WALL_MS: i64 = 33;

/// Effect `time` and update()'s `dt` (seconds) for one frame on the shared time
/// base — a port of the C6's `time_base_frame` (firmware/player_app/ffi.rs;
/// docs/design/synced-show.md, "Stateful effects"), same rule, same thresholds:
///
/// - before the epoch (`since <= 0`): time 0, dt 0;
/// - first frame on the base: dt = the wall period (capped at `since`);
/// - otherwise dt = the change in shared time since the last frame, so the
///   bridge's 1-2 ms drift-slewing epoch nudges flow into integrated phases
///   exactly as they move `time`;
/// - a step back (the epoch moved later than the frame advanced): dt = 0
///   (integrators hold, never run backwards);
/// - a jump forward by more than the wall period + [`TB_JUMP_SLACK_MS`] (a
///   re-align): dt = the wall period.
///
/// dt is a whole number of Q16.16 ticks (2^-16 s), the difference of the shared
/// time's tick counts. HostFx runs the SAME fx_vm, whose Frame carries the
/// fixed-point `dt_fix` mirror (`q16(dt)` in fx.rs), so the quantisation is
/// mirrored too: dt is exact in f32 and in `dt_fix`, and its sum telescopes to
/// the elapsed shared time on every player.
pub fn time_base_frame(prev_since_ms: Option<i64>, since_ms: i64, wall_dt_ms: i64) -> (f64, f64) {
    if since_ms <= 0 {
        return (0.0, 0.0);
    }
    // Q16.16 ticks of `ms` milliseconds, floored.
    let ticks = |ms: i64| (ms << 16).div_euclid(1000);
    let time = since_ms as f64 / 1000.0;
    let wall = wall_dt_ms.max(0);
    let dt_ticks = match prev_since_ms {
        None => ticks(since_ms) - ticks(since_ms - wall.min(since_ms)),
        Some(p) => {
            let p = p.max(0);
            let d = since_ms - p;
            if d < 0 {
                0
            } else if d > wall + TB_JUMP_SLACK_MS {
                ticks(wall)
            } else {
                ticks(since_ms) - ticks(p)
            }
        }
    };
    (time, dt_ticks as f64 / 65536.0)
}

/// Per-effect frame clock: turns successive [`FrameTime`]s into the
/// (`time`, `dt`) pair update()/shade() see.
#[derive(Clone, Debug, Default)]
pub struct EffectClock {
    last_local_s: Option<f64>,
    /// The previous shared frame's `now - epoch` (ms, >= 0); None off the time
    /// base (the C6's `FX_TB_PREV_SINCE`). Kept across epoch changes: a slew is
    /// a change in shared time, not a restart.
    prev_since_ms: Option<i64>,
    /// Effect time at the last frame, seconds.
    pub time: f64,
}

/// Largest dt a free-running frame takes (a stalled host doesn't fast-forward
/// integrated phases). Off the time base only; the shared rule is the C6's.
const MAX_LOCAL_DT_S: f64 = 0.25;

impl EffectClock {
    /// Advance to `t`; returns (time, dt) for this frame. With a time base set
    /// it is [`time_base_frame`]; without one, time accumulates the local frame
    /// interval (clamped to [`MAX_LOCAL_DT_S`]), continuing from the last value.
    pub fn advance(&mut self, t: FrameTime) -> (f64, f64) {
        let wall_s = self.last_local_s.map(|l| (t.local_s - l).max(0.0));
        self.last_local_s = Some(t.local_s);
        match t.shared {
            Some(s) => {
                let wall_ms = wall_s.map_or(FRESH_WALL_MS, |w| (w * 1000.0).round() as i64);
                let (time, dt) = time_base_frame(self.prev_since_ms, s.since_ms, wall_ms);
                self.prev_since_ms = Some(s.since_ms.max(0));
                self.time = time;
                (time, dt)
            }
            None => {
                self.prev_since_ms = None;
                let dt = wall_s.map_or(0.0, |w| w.min(MAX_LOCAL_DT_S));
                self.time += dt;
                (self.time, dt)
            }
        }
    }
}

/// The welcome feature reporting a host player's output latency offset, e.g.
/// `output_latency_ms=35` (the Welcome message has no field for it and the proto
/// stays unchanged; the bridge's feature gates match whole names, so it is inert
/// to them). Leaked once at startup: `Player::set_features` keeps `'static` strs.
pub fn latency_feature(latency_ms: i64) -> &'static str {
    Box::leak(format!("output_latency_ms={latency_ms}").into_boxed_str())
}

#[cfg(test)]
mod tests {
    use super::*;

    const TICK: f64 = 1.0 / 65536.0;

    #[test]
    fn free_running_without_a_time_base() {
        let t = FrameTime::sample(2_500_000, None, 40);
        assert_eq!(t.local_s, 2.5);
        assert_eq!(t.shared, None, "latency applies to shared time only");
    }

    #[test]
    fn time_base_pins_effect_time_to_the_epoch() {
        // now = 5000 ms on the player clock, epoch 3000 ms -> 2 s.
        let t = FrameTime::sample(5_000_000, Some(3000), 0);
        assert_eq!(t.shared, Some(Shared { since_ms: 2000 }));
        assert_eq!(t.shared.unwrap().time_s(), 2.0);
        // Before the epoch: held at 0 (as on the C6).
        assert_eq!(FrameTime::sample(1_000_000, Some(3000), 0).shared.unwrap().time_s(), 0.0);
        // Whole ms, as millis() on the C6.
        assert_eq!(FrameTime::sample(3_000_999, Some(3000), 0).shared.unwrap().since_ms, 0);
    }

    #[test]
    fn latency_offset_renders_ahead() {
        let t = FrameTime::sample(5_000_000, Some(3000), 35);
        assert_eq!(t.shared.unwrap().time_s(), 2.035);
        // Negative offsets (a controller that is EARLY relative to the others) work too.
        assert_eq!(FrameTime::sample(5_000_000, Some(3000), -500).shared.unwrap().time_s(), 1.5);
        assert_eq!(latency_feature(35), "output_latency_ms=35");
    }

    #[test]
    fn time_base_frame_matches_the_c6_rule() {
        let q = |ms: i64| ((ms << 16).div_euclid(1000)) as f64 * TICK;
        // Before the epoch: 0, 0.
        assert_eq!(time_base_frame(None, -5, 33), (0.0, 0.0));
        assert_eq!(time_base_frame(Some(0), 0, 33), (0.0, 0.0));
        // First frame: the wall period, capped at since.
        assert_eq!(time_base_frame(None, 2000, 25), (2.0, q(2000) - q(1975)));
        assert_eq!(time_base_frame(None, 10, 25), (0.01, q(10)));
        // Normal frame: the shared-time change, in whole ticks.
        assert_eq!(time_base_frame(Some(2000), 2027, 25).1, q(2027) - q(2000));
        // Step back (epoch moved later): hold.
        assert_eq!(time_base_frame(Some(2000), 1990, 25).1, 0.0);
        // Forward by up to wall + 250 ms: still elapsed time; beyond: a re-align.
        assert_eq!(time_base_frame(Some(2000), 2275, 25).1, q(2275) - q(2000));
        assert_eq!(time_base_frame(Some(2000), 2276, 25).1, q(25));
    }

    #[test]
    fn dt_sums_follow_a_slewing_epoch() {
        // The bridge slews drift with +-2 ms SetTimeBase nudges every few seconds.
        // Every correction must reach dt: the dt sum equals the shared time
        // elapsed (and is whole ticks, so dt_fix sums the same).
        let mut c = EffectClock::default();
        let mut epoch = 1_000i64;
        let start_us = 1_234_567i64;
        let (t0, _) = c.advance(FrameTime::sample(start_us, Some(epoch), 0));
        let mut sum = 0.0;
        let mut ticks_sum = 0i64;
        let mut now_us = start_us;
        let mut last_t = t0;
        for k in 1..=20_000 {
            now_us += 25_000 + (k % 7) * 113; // ~40 fps with jitter
            if k % 150 == 0 {
                epoch += if (k / 150) % 3 == 0 { -2 } else { 2 }; // a slew step
            }
            let (t, dt) = c.advance(FrameTime::sample(now_us, Some(epoch), 0));
            assert!(dt >= 0.0 && dt < 0.05, "frame {k}: dt {dt}");
            assert_eq!((dt * 65536.0).fract(), 0.0, "dt is whole Q16.16 ticks");
            sum += dt;
            ticks_sum += (dt * 65536.0) as i64;
            last_t = t;
        }
        let q = |s: f64| ((((s * 1000.0).round() as i64) << 16).div_euclid(1000)) as f64 * TICK;
        assert_eq!(ticks_sum as f64 * TICK, q(last_t) - q(t0), "dt telescopes to the shared time elapsed");
        assert!((sum - (last_t - t0)).abs() < 1e-4, "dt sum {sum} vs elapsed {}", last_t - t0);
        // And the corrections are in it: the elapsed shared time differs from the
        // local elapsed time by the net slew.
        let local = (now_us - start_us) as f64 / 1e6;
        let net_slew_s = (epoch - 1_000) as f64 / 1000.0;
        assert!(((last_t - t0) - (local - net_slew_s)).abs() < 0.002);
    }

    #[test]
    fn jumps_and_transitions() {
        let mut c = EffectClock::default();
        // Free-running: dt = local interval, clamped.
        assert_eq!(c.advance(FrameTime::sample(1_000_000, None, 0)), (0.0, 0.0));
        let (t, dt) = c.advance(FrameTime::sample(1_100_000, None, 0));
        assert!((t - 0.1).abs() < 1e-9 && (dt - 0.1).abs() < 1e-9);
        let (_, dt) = c.advance(FrameTime::sample(9_000_000, None, 0));
        assert_eq!(dt, MAX_LOCAL_DT_S, "a stalled free-running frame is clamped");

        // Time base set (epoch 8000): the first frame takes the wall period.
        let (t, dt) = c.advance(FrameTime::sample(9_025_000, Some(8000), 0));
        assert_eq!(t, 1.025);
        assert!((dt - 0.025).abs() < 2.0 * TICK);
        // A re-align 10 s forward: the wall period, not the jump.
        let (t, dt) = c.advance(FrameTime::sample(9_050_000, Some(-2000), 0));
        assert_eq!(t, 11.05);
        assert!((dt - 0.025).abs() < 2.0 * TICK);
        // Epoch moved later than the frame advanced: hold.
        let (t, dt) = c.advance(FrameTime::sample(9_075_000, Some(-1900), 0));
        assert_eq!((t, dt), (10.975, 0.0));
        // Cleared: free-running again, continuing from the last shared time.
        let (t, dt) = c.advance(FrameTime::sample(9_100_000, None, 0));
        assert!((t - 11.0).abs() < 1e-9 && (dt - 0.025).abs() < 1e-9);
        // Before the epoch: held at 0, dt 0.
        let mut c = EffectClock::default();
        c.advance(FrameTime::sample(1_000_000, Some(5000), 0));
        assert_eq!(c.advance(FrameTime::sample(1_040_000, Some(5000), 0)), (0.0, 0.0));
    }
}
