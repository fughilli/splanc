//! How much the tracker's pose can be trusted right now, from the kernel's events and the
//! device clock: what the player shows as `tracker_ok` / `tracker_state` and sends out in
//! /lh/pose (#446).
//!
//! The kernel publishes a pose only when light comes in (a sweep), and it declares tracking
//! lost only after `lost_after_dark` without a usable hit. In between, the newest pose is an
//! IMU prediction at best, and after fast motion or an occlusion it may be a stale one. So a
//! pose counts as a healthy lock only while light keeps confirming it:
//!
//! - **Lost** (0): the kernel isn't tracking (no tracker, never locked, or lost); the next
//!   lock is a fresh pose solve (the kernel's bootstrap), never the last pose.
//! - **Coasting** (1): tracking, but no hit was used for `fresh_ticks`, or the position
//!   uncertainty grew past `max_sigma_m`: the pose is the IMU's dead reckoning, not a lock.
//! - **Acquiring** (2): a fresh solve, being confirmed by light (`settle_poses` lit poses
//!   over at least `settle_ticks`).
//! - **Locked** (3): tracking, light used within `fresh_ticks`, uncertainty small.
//!
//! Device time throughout (48 MHz ticks, unwrapped here from the raw u32 the inputs carry),
//! so a full occlusion is noticed from the IMU stream alone. No platform dependencies: the
//! P4 (lh_p4.rs) and the host tests (tests/reacquire.rs) run the same code.
#![no_std]

/// Device ticks per second (the tracker's 48 MHz clock).
pub const TPS: i64 = 48_000_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
#[repr(u8)]
pub enum Health {
    Lost = 0,
    Coasting = 1,
    Acquiring = 2,
    Locked = 3,
}

#[derive(Clone, Copy, Debug)]
pub struct HealthConfig {
    /// Without a used hit for this long (ticks), a tracked pose is coasting. Two stations
    /// sweep the tracker every 8.3 ms between them, one station every 16.7 ms: 100 ms is
    /// several sweeps missed in a row, not one grazing angle.
    pub fresh_ticks: i64,
    /// Position uncertainty (m, sqrt of the covariance trace) past which a tracked pose is
    /// coasting: the filter itself no longer knows where it is to a centimetre or two. Two
    /// stations at ~3 m hold ~6 mm (conservative: the errors are a tenth of that); one alone
    /// loses depth within a second, past 5 cm, and its error follows.
    pub max_sigma_m: f32,
    /// A fresh solve is confirmed after this many poses with light used, spanning at least
    /// `settle_ticks`, with the uncertainty under `max_sigma_m`; until then it's Acquiring.
    pub settle_poses: u32,
    pub settle_ticks: i64,
}

impl Default for HealthConfig {
    fn default() -> HealthConfig {
        HealthConfig { fresh_ticks: TPS / 10, max_sigma_m: 0.02, settle_poses: 4, settle_ticks: TPS / 20 }
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
    /// The solve was confirmed (see HealthConfig::settle_poses).
    confirmed: bool,
    /// Counters for the status line: locks gained (fresh solves) and lost.
    pub starts: u32,
    pub losses: u32,
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
            confirmed: false,
            starts: 0,
            losses: 0,
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
    }

    /// A pose from the kernel: `used` hits went into it since the previous one, `sigma_m`
    /// its position uncertainty (sqrt of the covariance trace).
    pub fn pose(&mut self, used: u32, sigma_m: f32) {
        if !self.tracking {
            return;
        }
        self.sigma = sigma_m;
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

    pub fn state(&self) -> Health {
        if !self.tracking {
            return Health::Lost;
        }
        let dark = self.now - self.last_lit.unwrap_or(self.started);
        if dark > self.cfg.fresh_ticks {
            return Health::Coasting;
        }
        if !self.confirmed {
            return Health::Acquiring;
        }
        if !(self.sigma <= self.cfg.max_sigma_m) {
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
    fn a_fresh_solve_settles_then_coasts_in_the_dark() {
        let mut h = TrackHealth::default();
        h.clock(4_294_000_000); // wraps below
        assert_eq!(h.state(), Health::Lost);
        h.started();
        assert_eq!(h.state(), Health::Acquiring);
        let mut t = 4_294_000_000u32;
        for _ in 0..6 {
            t = t.wrapping_add(10 * MS);
            h.clock(t);
            h.pose(5, 0.002);
        }
        assert_eq!(h.state(), Health::Locked);
        // Light gone; the IMU clock goes on.
        for _ in 0..9 {
            t = t.wrapping_add(10 * MS);
            h.clock(t);
        }
        assert_eq!(h.state(), Health::Locked, "90 ms dark is still a lock");
        t = t.wrapping_add(20 * MS);
        h.clock(t);
        assert_eq!(h.state(), Health::Coasting);
        // A pose with only gated hits doesn't confirm anything.
        h.pose(0, 0.002);
        assert_eq!(h.state(), Health::Coasting);
        h.pose(3, 0.002);
        assert_eq!(h.state(), Health::Locked);
        h.pose(3, 0.05);
        assert_eq!(h.state(), Health::Coasting, "uncertain");
        // A fresh solve is Acquiring, not Coasting, while it settles, however uncertain.
        h.lost();
        h.started();
        h.pose(3, 0.05);
        assert_eq!(h.state(), Health::Acquiring);
        for _ in 0..6 {
            t = t.wrapping_add(10 * MS);
            h.clock(t);
            h.pose(5, 0.05);
        }
        assert_eq!(h.state(), Health::Acquiring, "not confirmed while uncertain");
        h.pose(5, 0.005);
        assert_eq!(h.state(), Health::Locked);
        h.lost();
        assert_eq!(h.state(), Health::Lost);
        assert_eq!((h.starts, h.losses), (2, 2));
    }
}
