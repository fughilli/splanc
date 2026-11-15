//! Shared effect time (multi-fixture sync) — the player_rs side of the C6's
//! `set_time_base` (firmware/player_app/main.cpp, the fx frame).
//!
//! One clock, one domain: the WS task stamps `TimeSyncPong.t1/t2` with
//! [`crate::server::now_ms`] (whole ms since the process `epoch` Instant), the
//! bridge (agent/src/timesync.ts) maps its clock onto that and sends
//! `SetTimeBase.epoch_ms` in it, and the render loop reads its frame time from
//! the SAME `epoch` Instant. So with a time base set, every player computes
//! effect time = (now - epoch_ms) / 1000 on a clock the bridge has aligned,
//! and fixtures animate in step.
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
    /// effect time when no time base is set (free-running, as before).
    pub local_s: f64,
    /// Present while a shared time base is set.
    pub shared: Option<Shared>,
}

/// Effect time pinned to a shared epoch.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Shared {
    /// Effect time, seconds: (now + latency - epoch) / 1000, held at 0 before
    /// the epoch (as on the C6).
    pub time_s: f64,
    /// The epoch this time is relative to (player-clock ms). A change means a
    /// fresh `set_time_base`: effect time jumps, so dt can't be a difference.
    pub epoch_ms: i64,
}

impl FrameTime {
    /// Sample a frame's time. `now_us` is the player clock in µs (the same
    /// `epoch` Instant [`crate::server::now_ms`] reads), `time_base_ms` the
    /// core's `Player::time_base_ms()`, `latency_ms` the render-ahead offset
    /// (applied only to shared time: a free-running clock has no peer to be
    /// late against).
    pub fn sample(now_us: i64, time_base_ms: Option<i64>, latency_ms: i64) -> Self {
        let shared = time_base_ms.map(|epoch_ms| {
            // Fractional ms (the C6 uses whole ms; finer is fine and smoother).
            let since_ms = now_us as f64 / 1000.0 + latency_ms as f64 - epoch_ms as f64;
            Shared { time_s: since_ms.max(0.0) / 1000.0, epoch_ms }
        });
        Self { local_s: now_us as f64 / 1_000_000.0, shared }
    }
}

/// Per-effect frame clock: turns successive [`FrameTime`]s into the
/// (`time`, `dt`) pair update()/shade() see.
#[derive(Clone, Debug, Default)]
pub struct EffectClock {
    last_local_s: Option<f64>,
    /// The time base the previous frame used (None = free-running).
    last_epoch: Option<i64>,
    /// Effect time at the last frame, seconds.
    pub time: f64,
}

/// Largest dt a free-running frame takes (a stalled host doesn't fast-forward
/// integrated phases). Shared time is NOT clamped: every player must integrate
/// the same dt sum to stay in phase.
const MAX_LOCAL_DT_S: f64 = 0.25;

impl EffectClock {
    /// Advance to `t`; returns (time, dt) for this frame.
    ///
    /// - No time base: time accumulates the local frame interval (clamped).
    /// - Time base set: time = shared time and dt = time_now - time_prev (the
    ///   same semantics as the C6), so `phase += dt * speed` in update() sums to
    ///   the same value on every synced player. dt is 0 before the epoch.
    /// - The first frame on a new epoch (time base just set, changed or
    ///   cleared) takes the local frame interval as dt: effect time jumps there,
    ///   and a dt the size of the jump would kick every integrated phase.
    pub fn advance(&mut self, t: FrameTime) -> (f64, f64) {
        let local_dt = self.last_local_s.map_or(0.0, |l| (t.local_s - l).clamp(0.0, MAX_LOCAL_DT_S));
        self.last_local_s = Some(t.local_s);
        let dt = match t.shared {
            Some(s) => {
                let dt = if self.last_epoch == Some(s.epoch_ms) { (s.time_s - self.time).max(0.0) } else { local_dt };
                self.time = s.time_s;
                self.last_epoch = Some(s.epoch_ms);
                dt
            }
            None => {
                self.last_epoch = None;
                self.time += local_dt;
                local_dt
            }
        };
        (self.time, dt)
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
        assert_eq!(t.shared, Some(Shared { time_s: 2.0, epoch_ms: 3000 }));
        // Before the epoch: held at 0 (as on the C6).
        let t = FrameTime::sample(1_000_000, Some(3000), 0);
        assert_eq!(t.shared.unwrap().time_s, 0.0);
        // Sub-ms precision is kept.
        let t = FrameTime::sample(3_000_500, Some(3000), 0);
        assert!((t.shared.unwrap().time_s - 0.0005).abs() < 1e-12);
    }

    #[test]
    fn latency_offset_renders_ahead() {
        let t = FrameTime::sample(5_000_000, Some(3000), 35);
        assert!((t.shared.unwrap().time_s - 2.035).abs() < 1e-12);
        // Negative offsets (a controller that is EARLY relative to the others) work too.
        let t = FrameTime::sample(5_000_000, Some(3000), -500);
        assert!((t.shared.unwrap().time_s - 1.5).abs() < 1e-12);
        assert_eq!(latency_feature(35), "output_latency_ms=35");
    }

    #[test]
    fn dt_is_the_shared_time_difference() {
        let mut c = EffectClock::default();
        // Free-running: dt = local interval, clamped.
        assert_eq!(c.advance(FrameTime::sample(1_000_000, None, 0)), (0.0, 0.0));
        let (t, dt) = c.advance(FrameTime::sample(1_100_000, None, 0));
        assert!((t - 0.1).abs() < 1e-9 && (dt - 0.1).abs() < 1e-9);
        let (_, dt) = c.advance(FrameTime::sample(9_000_000, None, 0));
        assert_eq!(dt, MAX_LOCAL_DT_S, "a stalled free-running frame is clamped");

        // Time base set at epoch 8000: the jump frame takes the local dt, not the jump.
        let (t, dt) = c.advance(FrameTime::sample(10_000_000, Some(8000), 0));
        assert_eq!(t, 2.0);
        assert_eq!(dt, MAX_LOCAL_DT_S);
        // Then dt = time_now - time_prev, unclamped (a 1 s stall is 1 s on every peer).
        let (t, dt) = c.advance(FrameTime::sample(10_025_000, Some(8000), 0));
        assert!((t - 2.025).abs() < 1e-9 && (dt - 0.025).abs() < 1e-9);
        let (_, dt) = c.advance(FrameTime::sample(11_025_000, Some(8000), 0));
        assert!((dt - 1.0).abs() < 1e-9);

        // A new epoch is another jump: local dt again.
        let (t, dt) = c.advance(FrameTime::sample(11_050_000, Some(11_000), 0));
        assert!((t - 0.05).abs() < 1e-9 && (dt - 0.025).abs() < 1e-9);
        // Before the epoch: time held at 0, dt 0.
        let mut c = EffectClock::default();
        c.advance(FrameTime::sample(1_000_000, Some(5000), 0));
        assert_eq!(c.advance(FrameTime::sample(1_040_000, Some(5000), 0)), (0.0, 0.0));
        // Cleared: free-running again, continuing from the last shared time.
        let mut c = EffectClock::default();
        c.advance(FrameTime::sample(5_000_000, Some(3000), 0));
        let (t, dt) = c.advance(FrameTime::sample(5_100_000, None, 0));
        assert!((t - 2.1).abs() < 1e-9 && (dt - 0.1).abs() < 1e-9);
    }
}
