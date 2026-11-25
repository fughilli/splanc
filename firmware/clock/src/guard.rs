//! The monotonic-clock step-back guard.
//!
//! On the ESP32-C6, `esp_timer` (and `millis()` derived from it) has been seen
//! stepping BACK by whole multiples of 2^24 systimer ticks (1.048576 s; 1 to 82
//! of them in CI, once ~230 s mid-stream; root cause unknown). A wall clock
//! built as `unix = mono + offset` would jump back with it and could fire a
//! schedule twice.
//!
//! This is the same rule as the player's `lm_clock_observe`
//! (`firmware/player_app/ffi.rs`), in µs: the monotonic clock never
//! legitimately runs backwards, so ANY observed step back is a discontinuity.
//! It is absorbed as if the usual inter-observation advance had happened
//! instead: `shift = dt - last_dt`, and every absolute time held on the raw
//! clock is moved by `shift`. Forward jumps are taken as real (a stalled
//! caller, the lamp being off): they cannot be told apart from elapsed time.
//!
//! Two ways to use it:
//! - [`StepGuard::observe`] returns the shift, for a caller that keeps its
//!   anchors on the raw clock and moves them (the firmware's existing guard
//!   path; pair it with [`crate::WallClock::shift_mono`]).
//! - [`MonoClock::read`] returns a corrected clock that never goes backwards,
//!   for a caller that would rather not move anything.

/// Typical spacing between observations assumed before one has been seen
/// (one ~30 fps frame), µs.
pub const DEFAULT_NOMINAL_DT_US: i64 = 33_000;
/// Observation spacings at or above this are not learnt as "the usual advance"
/// (they are gaps, not frames), µs.
pub const MAX_LEARNT_DT_US: i64 = 1_000_000;

/// Detects step-backs of a raw monotonic µs clock and reports the shift.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StepGuard {
    last: i64,
    last_dt: i64,
    primed: bool,
    jumps: u32,
}

impl Default for StepGuard {
    fn default() -> Self {
        Self::new(DEFAULT_NOMINAL_DT_US)
    }
}

impl StepGuard {
    /// A guard that assumes observations about `nominal_dt_us` apart until it
    /// has seen one.
    pub const fn new(nominal_dt_us: i64) -> Self {
        StepGuard {
            last: 0,
            last_dt: if nominal_dt_us > 0 { nominal_dt_us } else { 1 },
            primed: false,
            jumps: 0,
        }
    }

    /// Feeds the raw clock. Returns 0, or the (negative) shift to add to every
    /// absolute time held on the raw clock when it stepped back: the step less
    /// the usual advance, so the corrected timeline still moves forward by one
    /// typical interval across the step.
    pub fn observe(&mut self, raw_us: i64) -> i64 {
        let last = self.last;
        self.last = raw_us;
        if !self.primed {
            self.primed = true;
            return 0;
        }
        let dt = raw_us.saturating_sub(last);
        if dt < 0 {
            self.jumps = self.jumps.wrapping_add(1);
            return dt.saturating_sub(self.last_dt);
        }
        if dt < MAX_LEARNT_DT_US {
            self.last_dt = dt.max(1);
        }
        0
    }

    /// Step-backs absorbed so far (wrapping).
    pub const fn jumps(&self) -> u32 {
        self.jumps
    }

    /// The last raw value observed.
    pub const fn last_raw(&self) -> i64 {
        self.last
    }
}

/// A monotonic µs clock corrected for step-backs: `read(raw)` is
/// `raw + correction`, where each step back adds its magnitude (less the usual
/// advance) to the correction. Its output never decreases for a caller that
/// reads it with every raw sample.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct MonoClock {
    guard: StepGuard,
    correction: i64,
}

impl MonoClock {
    pub const fn new(nominal_dt_us: i64) -> Self {
        MonoClock {
            guard: StepGuard::new(nominal_dt_us),
            correction: 0,
        }
    }

    /// The corrected time for this raw sample.
    pub fn read(&mut self, raw_us: i64) -> i64 {
        let shift = self.guard.observe(raw_us);
        self.correction = self.correction.saturating_sub(shift);
        raw_us.saturating_add(self.correction)
    }

    /// Total correction applied so far (≥ 0), µs.
    pub const fn correction(&self) -> i64 {
        self.correction
    }

    /// Step-backs absorbed so far.
    pub const fn jumps(&self) -> u32 {
        self.guard.jumps()
    }
}
