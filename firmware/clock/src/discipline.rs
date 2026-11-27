//! The wall-clock discipline: source offers, age-grown uncertainty, selection,
//! step vs slew, sanity bounds, a drift fit, and the step-guard shift.
//!
//! The clock is `unix = reference(mono) + residual(mono)` on a monotonic µs
//! clock (`esp_timer` on the C6, never the wrapping `millis()`):
//!
//! - `reference` is the accepted offer, extrapolated along the monotonic clock
//!   and corrected by the fitted crystal rate;
//! - `residual` is what is still left to slew after a small correction: it
//!   starts at (displayed − new reference) and decays to 0 at `max_slew_ppm`,
//!   so the displayed time is continuous and never runs backwards.
//!
//! Each [`Offer`] carries an error bound at the time it was measured; it grows
//! with age at the source's drift rate:
//!
//! ```text
//! uncertainty(now) = max(err_at_set + drift_ppm × (now − at), floor) (+ |residual|)
//! ```
//!
//! An offer is taken when its current uncertainty is lower than that of the
//! clock's sample (rank breaks ties), or when the clock's sample has gone stale. A taken offer
//! steps the clock when the correction is over `step_threshold_us` (or the clock
//! was invalid) and slews it otherwise.

use crate::carry::CarryRecord;
use crate::civil::DateTime;
use crate::local::{to_local, LocalOffset};

/// Where a time sample came from. The discriminant is the tie-break rank
/// (lower = preferred) and the wire value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Source {
    /// SNTP answered on the device.
    Sntp = 1,
    /// A wall-clock record relayed over the mesh from a member that has time.
    Mesh = 2,
    /// Pushed by the phone app or the bridge (`set_wall_clock`).
    App = 3,
    /// Read from a hardware RTC chip.
    HwRtc = 4,
    /// Restored from RTC no-init RAM across a soft reset.
    Carry = 5,
}

impl Source {
    /// Every source, best rank first.
    pub const ALL: [Source; 5] = [
        Source::Sntp,
        Source::Mesh,
        Source::App,
        Source::HwRtc,
        Source::Carry,
    ];

    /// Tie-break rank: lower is preferred.
    pub const fn rank(self) -> u8 {
        self as u8
    }

    /// The wire value, inverse of [`Source::from_u8`].
    pub const fn to_u8(self) -> u8 {
        self as u8
    }

    pub const fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(Source::Sntp),
            2 => Some(Source::Mesh),
            3 => Some(Source::App),
            4 => Some(Source::HwRtc),
            5 => Some(Source::Carry),
            _ => None,
        }
    }

    /// How fast a sample's error grows once it is set, ppm. For every source
    /// but a hardware RTC this is the C6's own 40 MHz crystal (±10–40 ppm)
    /// carrying the time forward; an RTC driver overrides it with the chip's
    /// spec via [`Offer::with_drift_ppm`] (DS3231 2, RV-3028 1–3, PCF8563 ~20
    /// plus its crystal).
    pub const fn default_drift_ppm(self) -> u32 {
        match self {
            Source::Sntp | Source::Mesh | Source::App | Source::Carry => 40,
            Source::HwRtc => 20,
        }
    }

    /// Age after which a sample from this source no longer guards the clock:
    /// any sane offer replaces it, and it no longer vetoes worse-ranked offers
    /// in the sanity check. Roughly a few missed refreshes of that source.
    pub const fn stale_us(self) -> i64 {
        const MIN: i64 = 60 * 1_000_000;
        const HOUR: i64 = 60 * MIN;
        match self {
            Source::Sntp => 6 * HOUR,     // polls every ≤ 1 h once synced
            Source::Mesh => 10 * MIN,     // beacons every few seconds
            Source::App => 7 * 24 * HOUR, // a weekly visitor
            Source::HwRtc => 24 * HOUR,   // re-read daily
            Source::Carry => HOUR,        // only bridges a reboot
        }
    }

    /// Whether this source measures the device crystal's rate well enough to
    /// feed the drift fit (an RTC ticks in whole seconds, a carry-over is our
    /// own clock).
    pub const fn feeds_drift_fit(self) -> bool {
        matches!(self, Source::Sntp | Source::Mesh | Source::App)
    }
}

/// A time sample: "it was `unix_us` (±`err_us`) when the monotonic clock read
/// `at_mono_us`".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Offer {
    pub source: Source,
    /// UTC µs since the Unix epoch.
    pub unix_us: i64,
    /// The monotonic clock (µs) at the instant `unix_us` was true.
    pub at_mono_us: i64,
    /// Error bound at that instant, µs (SNTP: rtt/2 + dispersion; app:
    /// min-RTT/2; RTC: 1 s).
    pub err_us: i64,
    /// Error growth after the sample, ppm.
    pub drift_ppm: u32,
}

/// `age × ppm / 1e6`, saturating, 0 for a negative age.
fn growth_us(ppm: u32, age_us: i64) -> i64 {
    let g = (age_us.max(0) as i128) * (ppm as i128) / 1_000_000;
    g.min(i64::MAX as i128) as i64
}

impl Offer {
    /// An offer with the source's default drift rate.
    pub const fn new(source: Source, unix_us: i64, at_mono_us: i64, err_us: i64) -> Self {
        Offer {
            source,
            unix_us,
            at_mono_us,
            err_us,
            drift_ppm: source.default_drift_ppm(),
        }
    }

    /// The same offer with an explicit error growth rate (e.g. an RTC chip's
    /// spec).
    pub const fn with_drift_ppm(mut self, drift_ppm: u32) -> Self {
        self.drift_ppm = drift_ppm;
        self
    }

    /// The error bound at `now_mono_us`: the error at set plus drift × age.
    pub fn uncertainty_us(&self, now_mono_us: i64) -> i64 {
        self.err_us.saturating_add(growth_us(
            self.drift_ppm,
            now_mono_us.saturating_sub(self.at_mono_us),
        ))
    }
}

/// Discipline tuning. [`Config::DEFAULT`] is the plan's values.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// Corrections larger than this step the clock; smaller ones slew, µs.
    pub step_threshold_us: i64,
    /// Fastest slew, ppm (500 ppm: 1 s takes ~33 min).
    pub max_slew_ppm: u32,
    /// An offer that disagrees with a fresh, better-ranked source by more than
    /// this is refused, µs.
    pub sanity_window_us: i64,
    /// Offers before this instant are refused (the firmware passes its build
    /// date), UTC µs.
    pub min_unix_us: i64,
    /// No uncertainty is reported below this, µs.
    pub floor_err_us: i64,
    /// The fitted crystal rate is clamped to ±this, ppm.
    pub max_rate_ppm: u32,
    /// Two samples closer than this don't make a rate observation, µs.
    pub min_fit_span_us: i64,
    /// A rate observation whose sample errors alone could explain more than
    /// this is skipped (the older fit point is kept so the span grows), ppm.
    pub max_fit_noise_ppm: u32,
    /// Weight memory of the rate fit: older observations count for at most
    /// this much span, so the fit follows temperature drift, µs.
    pub fit_memory_us: i64,
}

impl Config {
    pub const DEFAULT: Config = Config {
        step_threshold_us: 1_000_000,
        max_slew_ppm: 500,
        sanity_window_us: 60_000_000,
        // 2026-01-01T00:00:00Z: nothing earlier is plausible for this firmware.
        min_unix_us: 1_767_225_600_000_000,
        floor_err_us: 1_000,
        max_rate_ppm: 200,
        min_fit_span_us: 60_000_000,
        max_fit_noise_ppm: 20,
        fit_memory_us: 24 * 3600 * 1_000_000,
    };
}

impl Default for Config {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// How an accepted offer changed the clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Applied {
    /// The clock was invalid and is now set.
    Initial,
    /// Jumped by `delta_us` (new − old displayed time).
    Step { delta_us: i64 },
    /// Will converge by `delta_us` at ≤ `max_slew_ppm`; the displayed time did
    /// not jump.
    Slew { delta_us: i64 },
}

/// Why an offer was refused. The clock is unchanged.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reject {
    /// Negative error bound.
    Malformed,
    /// Earlier than `Config::min_unix_us`.
    BeforeFloor,
    /// Off by more than the sanity window from a fresh, better-ranked source.
    Disagrees { delta_us: i64 },
    /// Not more certain than the current sample, which is still fresh.
    NotBetter {
        offer_err_us: i64,
        current_err_us: i64,
    },
}

/// A snapshot for status lines and `clock_state`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Status {
    /// The displayed UTC time, `None` while invalid.
    pub unix_us: Option<i64>,
    pub source: Option<Source>,
    /// Current error bound, µs (0 while invalid).
    pub uncertainty_us: i64,
    /// Age of the current sample, µs.
    pub age_us: i64,
    /// Correction still being slewed, µs (displayed − reference).
    pub slewing_us: i64,
    /// Fitted crystal rate, parts per billion (positive: the monotonic clock
    /// runs slow).
    pub rate_ppb: i64,
    /// Accepted offers so far (wrapping).
    pub gen: u32,
    /// Steps (including the initial set) so far (wrapping).
    pub steps: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct FitPoint {
    at_mono_us: i64,
    offset_us: i64, // unix − mono
    err_us: i64,
}

/// The software RTC: an epoch offset on a monotonic µs clock, disciplined by
/// source offers. About 100 bytes; every read is a few integer ops.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WallClock {
    cfg: Config,
    anchor: Option<Offer>,
    slew_r0_us: i64,
    slew_start_us: i64,
    rate_ppb: i64,
    rate_weight_us: i64,
    fit: Option<FitPoint>,
    gen: u32,
    steps: u32,
}

impl Default for WallClock {
    fn default() -> Self {
        Self::new(Config::DEFAULT)
    }
}

impl WallClock {
    /// An invalid clock.
    pub const fn new(cfg: Config) -> Self {
        WallClock {
            cfg,
            anchor: None,
            slew_r0_us: 0,
            slew_start_us: 0,
            rate_ppb: 0,
            rate_weight_us: 0,
            fit: None,
            gen: 0,
            steps: 0,
        }
    }

    pub const fn config(&self) -> &Config {
        &self.cfg
    }

    /// True once any offer has been accepted (until [`WallClock::invalidate`]).
    pub const fn is_valid(&self) -> bool {
        self.anchor.is_some()
    }

    /// The source of the current sample.
    pub fn source(&self) -> Option<Source> {
        self.anchor.map(|a| a.source)
    }

    /// Fitted crystal rate, ppb.
    pub const fn rate_ppb(&self) -> i64 {
        self.rate_ppb
    }

    /// `unix_us` of `a` carried to `now_mono_us`, rate-corrected.
    fn reference_at(&self, a: &Offer, now_mono_us: i64) -> i64 {
        let age = now_mono_us.saturating_sub(a.at_mono_us);
        let rate = (age as i128) * (self.rate_ppb as i128) / 1_000_000_000;
        a.unix_us.saturating_add(age).saturating_add(rate as i64)
    }

    /// Correction left to slew at `now_mono_us` (displayed − reference).
    fn residual(&self, now_mono_us: i64) -> i64 {
        let r0 = self.slew_r0_us;
        if r0 == 0 {
            return 0;
        }
        let budget = growth_us(
            self.cfg.max_slew_ppm,
            now_mono_us.saturating_sub(self.slew_start_us),
        );
        if r0 > 0 {
            (r0 - budget).max(0)
        } else {
            (r0.saturating_add(budget)).min(0)
        }
    }

    /// The displayed UTC µs at `now_mono_us`, `None` while invalid.
    pub fn now_us(&self, now_mono_us: i64) -> Option<i64> {
        let a = self.anchor.as_ref()?;
        Some(
            self.reference_at(a, now_mono_us)
                .saturating_add(self.residual(now_mono_us)),
        )
    }

    /// The displayed UTC time, broken down.
    pub fn now_datetime(&self, now_mono_us: i64) -> Option<DateTime> {
        self.now_us(now_mono_us).map(DateTime::from_unix_us)
    }

    /// The displayed time in a local zone (see [`crate::local`]).
    pub fn now_local<Z: LocalOffset + ?Sized>(
        &self,
        now_mono_us: i64,
        zone: &Z,
    ) -> Option<DateTime> {
        self.now_us(now_mono_us).map(|u| to_local(u, zone))
    }

    /// The current error bound (age-grown, floored, plus any correction still
    /// being slewed), `None` while invalid.
    pub fn uncertainty_us(&self, now_mono_us: i64) -> Option<i64> {
        let a = self.anchor.as_ref()?;
        let base = a.uncertainty_us(now_mono_us).max(self.cfg.floor_err_us);
        Some(base.saturating_add(self.residual(now_mono_us).saturating_abs()))
    }

    /// Considers `offer` at `now_mono_us` and, if it wins, applies it.
    pub fn offer(&mut self, offer: Offer, now_mono_us: i64) -> Result<Applied, Reject> {
        if offer.err_us < 0 {
            return Err(Reject::Malformed);
        }
        if offer.unix_us < self.cfg.min_unix_us {
            return Err(Reject::BeforeFloor);
        }
        let offered_now = self.reference_at(&offer, now_mono_us);
        let applied = match (self.anchor, self.now_us(now_mono_us)) {
            (Some(cur), Some(displayed)) => {
                let delta = offered_now.saturating_sub(displayed);
                let fresh = now_mono_us.saturating_sub(cur.at_mono_us) <= cur.source.stale_us();
                if fresh
                    && cur.source.rank() < offer.source.rank()
                    && delta.saturating_abs() > self.cfg.sanity_window_us
                {
                    return Err(Reject::Disagrees { delta_us: delta });
                }
                // Selection compares the samples' quality; a correction still
                // being slewed is the clock's display lag, not the source's error.
                let cur_unc = cur.uncertainty_us(now_mono_us).max(self.cfg.floor_err_us);
                let new_unc = offer.uncertainty_us(now_mono_us).max(self.cfg.floor_err_us);
                let better = new_unc < cur_unc
                    || (new_unc == cur_unc && offer.source.rank() < cur.source.rank());
                if fresh && !better {
                    return Err(Reject::NotBetter {
                        offer_err_us: new_unc,
                        current_err_us: cur_unc,
                    });
                }
                if delta.saturating_abs() > self.cfg.step_threshold_us {
                    self.slew_r0_us = 0;
                    Applied::Step { delta_us: delta }
                } else {
                    // Keep the displayed time continuous: whatever separates it
                    // from the new reference is slewed out.
                    self.slew_r0_us = -delta;
                    self.slew_start_us = now_mono_us;
                    Applied::Slew { delta_us: delta }
                }
            }
            _ => {
                self.slew_r0_us = 0;
                Applied::Initial
            }
        };
        self.fit_rate(&offer);
        self.anchor = Some(offer);
        self.gen = self.gen.wrapping_add(1);
        if !matches!(applied, Applied::Slew { .. }) {
            self.steps = self.steps.wrapping_add(1);
        }
        Ok(applied)
    }

    /// Updates the crystal-rate estimate from an accepted offer.
    fn fit_rate(&mut self, offer: &Offer) {
        if !offer.source.feeds_drift_fit() {
            return;
        }
        let point = FitPoint {
            at_mono_us: offer.at_mono_us,
            offset_us: offer.unix_us.saturating_sub(offer.at_mono_us),
            err_us: offer.err_us,
        };
        let Some(prev) = self.fit else {
            self.fit = Some(point);
            return;
        };
        let span = point.at_mono_us.saturating_sub(prev.at_mono_us);
        if span < self.cfg.min_fit_span_us {
            return; // keep the older point: the span grows
        }
        let span128 = span as i128;
        let noise_ppb = (prev.err_us as i128 + point.err_us as i128) * 1_000_000_000 / span128;
        if noise_ppb > self.cfg.max_fit_noise_ppm as i128 * 1000 {
            return; // too noisy over this span: wait for a longer one
        }
        let obs_ppb = (point.offset_us as i128 - prev.offset_us as i128) * 1_000_000_000 / span128;
        let max_ppb = self.cfg.max_rate_ppm as i128 * 1000;
        if obs_ppb.abs() > 2 * max_ppb {
            // Not a crystal: a source switch or a bad sample. Restart the fit.
            self.fit = Some(point);
            return;
        }
        let w = self.rate_weight_us.min(self.cfg.fit_memory_us) as i128;
        let rate = (self.rate_ppb as i128 * w + obs_ppb * span128) / (w + span128);
        self.rate_ppb = rate.clamp(-max_ppb, max_ppb) as i64;
        self.rate_weight_us = (w + span128).min(i64::MAX as i128) as i64;
        self.fit = Some(point);
    }

    /// The monotonic clock stepped: the same physical instant now reads
    /// `shift_us` different (negative for a step back, as returned by
    /// [`crate::StepGuard::observe`] or the player's `lm_clock_observe`).
    /// Moves every stored monotonic time so the wall clock stays continuous.
    pub fn shift_mono(&mut self, shift_us: i64) {
        if shift_us == 0 {
            return;
        }
        if let Some(a) = self.anchor.as_mut() {
            a.at_mono_us = a.at_mono_us.saturating_add(shift_us);
        }
        self.slew_start_us = self.slew_start_us.saturating_add(shift_us);
        if let Some(p) = self.fit.as_mut() {
            p.at_mono_us = p.at_mono_us.saturating_add(shift_us);
            p.offset_us = p.offset_us.saturating_sub(shift_us);
        }
    }

    /// Forgets the time (the rate fit is kept: it describes this crystal).
    pub fn invalidate(&mut self) {
        self.anchor = None;
        self.slew_r0_us = 0;
        self.fit = None;
    }

    /// A status snapshot at `now_mono_us`.
    pub fn status(&self, now_mono_us: i64) -> Status {
        Status {
            unix_us: self.now_us(now_mono_us),
            source: self.source(),
            uncertainty_us: self.uncertainty_us(now_mono_us).unwrap_or(0),
            age_us: self
                .anchor
                .map_or(0, |a| now_mono_us.saturating_sub(a.at_mono_us)),
            slewing_us: if self.anchor.is_some() {
                self.residual(now_mono_us)
            } else {
                0
            },
            rate_ppb: self.rate_ppb,
            gen: self.gen,
            steps: self.steps,
        }
    }

    /// The record to keep in RTC no-init RAM across a soft reset, `None` while
    /// invalid.
    pub fn carry_record(&self, now_mono_us: i64) -> Option<CarryRecord> {
        Some(CarryRecord {
            unix_us: self.now_us(now_mono_us)?,
            err_us: self.uncertainty_us(now_mono_us)?,
            source: self.source()?,
        })
    }
}
