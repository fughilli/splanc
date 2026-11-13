//! How far the tracker's pose can be trusted right now, from the kernel's events and the
//! device clock: what the player shows as `tracker_ok` / `tracker_state` and sends out in
//! /lh/pose (#446).
//!
//! When the light is lost (an occlusion, fast motion) the kernel dead reckons the tracker on
//! its IMU and keeps publishing that pose, flagged speculative, until light confirms the
//! dead-reckoned state again (fused into the same track) or its covariance passes the
//! kernel's `lost_sigma_pos` (or the `lost_after_dark` backstop): then it declares tracking
//! lost, and the next lock is a fresh pose solve. So:
//!
//! - **Lost** (0): not tracking (no tracker, never locked, or lost). The pose holds its last
//!   value and is not to be followed.
//! - **Uncertain** (1): tracking with light, but the position uncertainty is past
//!   [`POS_SIGMA_LIMIT_M`] (a genuinely poor fix: e.g. one station far off, seen by few
//!   sensors, under fast motion), or the light has been gone longer than [`COAST_MAX_S`]
//!   without the kernel giving up. Not usable. One station alone is a full 6-DoF fix: the
//!   tracker's sensor constellation is known, so the angles between its sensors give the
//!   range. Replayed recordings (one station, ~1 m): turntable radial RMS 5-8 mm with σ
//!   under the limit 97-99% of the time. Simulated: Locked at 1-2 m still or carried; at
//!   3 m carried briskly σ passes the limit part of the time (tests/reacquire.rs,
//!   single_station_sigma_follows_the_error).
//! - **Acquiring** (2): a fresh solve, being confirmed by light. Not usable yet.
//! - **Coasting** (3): dead reckoning on the IMU, no light confirming it (speculative), its
//!   uncertainty still under [`POS_SIGMA_LIMIT_M`]. Usable: `tracker_ok`, and the render
//!   side predicts it forward; effects that want only optical locks check `tracker_state`.
//! - **Locked** (4): light confirms the pose, uncertainty under the limit.
//!
//! Device time throughout (48 MHz ticks, unwrapped here from the raw u32 the inputs carry),
//! so a full occlusion is noticed from the IMU stream alone. No platform dependencies: the
//! P4 (lh_p4.rs) and the host tests (tests/reacquire.rs) run the same code.
#![no_std]

/// Device ticks per second (the tracker's 48 MHz clock).
pub const TPS: i64 = 48_000_000;

/// Position uncertainty (m, sqrt of the covariance trace) up to which a pose is usable,
/// locked or coasting. The kernel's `lost_sigma_pos` default is the same: past it, dead
/// reckoning ends in Lost (Drifted). Simulated (tests/reacquire.rs): two stations hold
/// ~1 mm (errors under 1 mm); one station alone ~1 mm still and 6/15/27 mm rms carried at
/// 1/2/3 m (errors 1/3/6 mm: the kernel's noise model is tuned on the recorded sessions,
/// whose hits are noisier than the simulation's). Dead reckoning mid-carry (~0.5 m/s)
/// crosses 2 cm ~0.24 s into the dark, whatever the true accelerometer bias; the actual
/// drift by then is 7-9 mm for biases up to 0.02 g, 11 mm at 0.05 g.
pub const POS_SIGMA_LIMIT_M: f32 = 0.02;

/// Position uncertainty (m) at which dead reckoning gives up (the kernel's `lost_sigma_pos`
/// on the P4; its default is POS_SIGMA_LIMIT_M). Between the two the pose is Uncertain: not
/// usable, but the track goes on, so light back after a short occlusion is fused into it
/// instead of a fresh solve (~1 s on the P4). With one station ~3 m off a carried tracker
/// sits near POS_SIGMA_LIMIT_M with light (PixieLamp2, 2026-11-12), so giving up there
/// turned every 50 ms occlusion into a lost track.
pub const COAST_GIVE_UP_M: f32 = 0.05;

/// The backstop on dead reckoning (s): the kernel's `lost_after_dark` default. Moving, the
/// covariance rule ends coasting long before it (~0.24 s). Still, zero-velocity updates
/// hold the covariance and the simulated drift stays under 1 mm over the whole second, so
/// this is what ends it: a bound for a still detector fooled by slow handling (a 1 cm/s
/// creep it misses costs at most ~1 cm).
pub const COAST_MAX_S: f32 = 1.0;

/// Without a used hit for this long, a pose is coasting even before the kernel flags it
/// (the kernel's `coast_after` is 50 ms; two stations sweep every 8.3 ms between them).
pub const FRESH_S: f32 = 0.1;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Health {
    Lost = 0,
    Uncertain = 1,
    Acquiring = 2,
    Coasting = 3,
    Locked = 4,
}

impl Health {
    /// A pose to follow (locked or coasting).
    pub fn usable(self) -> bool {
        self >= Health::Coasting
    }
}

#[derive(Clone, Copy, Debug)]
pub struct HealthConfig {
    pub fresh_ticks: i64,
    pub max_sigma_m: f32,
    pub coast_max_ticks: i64,
    /// A fresh solve is confirmed after this many poses with light used, spanning at least
    /// `settle_ticks`, with the uncertainty under `max_sigma_m`; until then it's Acquiring.
    pub settle_poses: u32,
    pub settle_ticks: i64,
}

impl Default for HealthConfig {
    fn default() -> HealthConfig {
        HealthConfig {
            fresh_ticks: (FRESH_S * TPS as f32) as i64,
            max_sigma_m: POS_SIGMA_LIMIT_M,
            coast_max_ticks: (COAST_MAX_S * TPS as f32) as i64,
            settle_poses: 4,
            settle_ticks: TPS / 20,
        }
    }
}

#[derive(Clone, Debug)]
pub struct TrackHealth {
    pub cfg: HealthConfig,
    last_raw: Option<u32>,
    now: i64,
    tracking: bool,
    started: i64,
    lit_poses: u32,
    last_lit: Option<i64>,
    sigma: f32,
    speculative: bool,
    /// The solve was confirmed (see HealthConfig::settle_poses).
    confirmed: bool,
    /// Counters for the status line: locks gained (fresh solves) and lost, and coasts
    /// (dark stretches the track survived or ended in).
    pub starts: u32,
    pub losses: u32,
    pub coasts: u32,
}

impl Default for TrackHealth {
    fn default() -> TrackHealth {
        TrackHealth::new(HealthConfig::default())
    }
}

impl TrackHealth {
    pub fn new(cfg: HealthConfig) -> TrackHealth {
        TrackHealth {
            cfg,
            last_raw: None,
            now: 0,
            tracking: false,
            started: 0,
            lit_poses: 0,
            last_lit: None,
            sigma: 0.0,
            speculative: false,
            confirmed: false,
            starts: 0,
            losses: 0,
            coasts: 0,
        }
    }

    /// The device clock reached `raw` (ticks, wrapping): any input's time (IMU samples keep
    /// coming while the light is blocked).
    pub fn clock(&mut self, raw: u32) {
        match self.last_raw {
            None => {
                self.last_raw = Some(raw);
            }
            Some(l) => {
                let d = raw.wrapping_sub(l) as i32 as i64;
                if d > 0 {
                    self.now += d;
                    self.last_raw = Some(raw);
                }
            }
        }
    }

    /// Device time now (ticks since the first `clock`).
    pub fn now(&self) -> i64 {
        self.now
    }

    /// The kernel started tracking: a fresh pose solve.
    pub fn started(&mut self) {
        self.tracking = true;
        self.started = self.now;
        self.lit_poses = 0;
        self.last_lit = None;
        self.sigma = 0.0;
        self.speculative = false;
        self.confirmed = false;
        self.starts += 1;
    }

    /// The kernel lost tracking (or the device went away).
    pub fn lost(&mut self) {
        if self.tracking {
            self.losses += 1;
        }
        self.tracking = false;
        self.lit_poses = 0;
        self.last_lit = None;
        self.speculative = false;
    }

    /// A pose from the kernel: `used` hits went into it since the previous one, `sigma_m`
    /// its position uncertainty (sqrt of the covariance trace), `speculative` the kernel's
    /// flag (dead reckoning, no light confirming it).
    pub fn pose(&mut self, used: u32, sigma_m: f32, speculative: bool) {
        if !self.tracking {
            return;
        }
        if speculative && !self.speculative {
            self.coasts += 1;
        }
        self.sigma = sigma_m;
        self.speculative = speculative && used == 0;
        if used > 0 {
            self.lit_poses = self.lit_poses.saturating_add(1);
            self.last_lit = Some(self.now);
        }
        self.confirmed |= self.lit_poses >= self.cfg.settle_poses
            && self.now - self.started >= self.cfg.settle_ticks
            && self.sigma <= self.cfg.max_sigma_m;
    }

    /// Time since light last confirmed the pose (ticks), if it ever did since the solve.
    pub fn dark_ticks(&self) -> Option<i64> {
        self.last_lit.map(|t| self.now - t)
    }

    /// The pose's position uncertainty (m) as of the newest pose.
    pub fn sigma(&self) -> f32 {
        self.sigma
    }

    pub fn state(&self) -> Health {
        if !self.tracking {
            return Health::Lost;
        }
        if !self.confirmed {
            return Health::Acquiring;
        }
        let dark = self.now - self.last_lit.unwrap_or(self.started);
        if !(self.sigma <= self.cfg.max_sigma_m) || dark > self.cfg.coast_max_ticks {
            return Health::Uncertain;
        }
        if self.speculative || dark > self.cfg.fresh_ticks {
            return Health::Coasting;
        }
        Health::Locked
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MS: u32 = 48_000;

    #[test]
    fn settles_coasts_in_the_dark_and_relocks() {
        let mut h = TrackHealth::default();
        h.clock(4_294_000_000); // wraps below
        assert_eq!(h.state(), Health::Lost);
        h.started();
        assert_eq!(h.state(), Health::Acquiring);
        let mut t = 4_294_000_000u32;
        let mut tick = |h: &mut TrackHealth, ms: u32| {
            t = t.wrapping_add(ms * MS);
            h.clock(t);
        };
        for _ in 0..6 {
            tick(&mut h, 10);
            h.pose(5, 0.002, false);
        }
        assert_eq!(h.state(), Health::Locked);
        // Light gone: the kernel's speculative poses.
        tick(&mut h, 60);
        h.pose(0, 0.004, true);
        assert_eq!(h.state(), Health::Coasting);
        assert!(h.state().usable());
        tick(&mut h, 100);
        h.pose(0, 0.012, true);
        assert_eq!(h.state(), Health::Coasting);
        // Light back, fused: locked again, no fresh solve.
        h.pose(4, 0.006, false);
        assert_eq!(h.state(), Health::Locked);
        assert_eq!((h.starts, h.coasts), (1, 1));
        // Even without a speculative flag, a pose with no light for FRESH_S is coasting.
        tick(&mut h, 150);
        assert_eq!(h.state(), Health::Coasting);
        // Uncertain with light (one station, moving): not usable.
        h.pose(3, 0.05, false);
        assert_eq!(h.state(), Health::Uncertain);
        assert!(!h.state().usable());
        h.pose(3, 0.005, false);
        assert_eq!(h.state(), Health::Locked);
        // Past the backstop with no light: not usable even if the kernel kept going.
        tick(&mut h, 1100);
        h.pose(0, 0.01, true);
        assert_eq!(h.state(), Health::Uncertain);
        h.lost();
        assert_eq!(h.state(), Health::Lost);
        // A fresh solve is Acquiring while it settles, however uncertain.
        h.started();
        for _ in 0..6 {
            tick(&mut h, 10);
            h.pose(5, 0.05, false);
        }
        assert_eq!(h.state(), Health::Acquiring, "not confirmed while uncertain");
        h.pose(5, 0.005, false);
        assert_eq!(h.state(), Health::Locked);
        assert_eq!((h.starts, h.losses), (2, 1));
    }
}
