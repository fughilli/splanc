//! How a hardware RTC feeds the wall clock and when the wall clock writes back
//! to it (docs/design/wall-clock.md "Hardware RTC"; plan §4.1). Pure functions,
//! so the rules are host-tested without a chip.

use ledmapper_clock::{Offer, Source};

use crate::{RtcCaps, RtcTime};

/// The age assumed for a chip this lamp never wrote (its error is unknown), s.
pub const UNKNOWN_SINCE_WRITE_S: i64 = 30 * 86_400;
/// Refresh the chip at least this often while a better source holds the clock, s.
pub const WRITE_EVERY_S: i64 = 86_400;
/// Write back when the chip is off by more than this, µs.
pub const RESYNC_DIFF_US: i64 = 1_000_000;
/// Only a clock at least this certain is written to the chip, µs.
pub const MAX_WRITE_ERR_US: i64 = 250_000;
/// A chip reading is whole seconds with an unknown phase: it is taken at the
/// middle of its second, ± half a second.
pub const READ_ERR_US: i64 = 500_000;

/// The chip's drift spec, whole ppm (rounded up).
pub const fn drift_ppm(caps: RtcCaps) -> u32 {
    caps.drift_ppb.div_ceil(1_000)
}

/// The wall-clock offer for a reading taken at monotonic `at_mono_us`, or
/// `None` when the chip lost time. The error is the half-second quantisation
/// plus the chip's drift spec over the time since it was last written
/// (`since_write_s`; unknown = [`UNKNOWN_SINCE_WRITE_S`]).
pub fn read_offer(
    t: RtcTime,
    at_mono_us: i64,
    caps: RtcCaps,
    since_write_s: Option<i64>,
) -> Option<Offer> {
    if !t.valid {
        return None;
    }
    let ppm = drift_ppm(caps);
    let age_s = since_write_s.unwrap_or(UNKNOWN_SINCE_WRITE_S).max(0);
    // age_s × ppm µs = age × ppm / 1e6 s.
    let err_us = READ_ERR_US.saturating_add(age_s.saturating_mul(ppm as i64));
    Some(
        Offer::new(
            Source::HwRtc,
            t.unix_s * 1_000_000 + READ_ERR_US,
            at_mono_us,
            err_us,
        )
        .with_drift_ppm(ppm),
    )
}

/// Why the chip is (re)written.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Writeback {
    No,
    /// An explicit `set_wall_clock{write_rtc}` or a config change.
    Forced,
    /// The chip lost time (oscillator stop / VL / power-on reset flag).
    ChipInvalid,
    /// It is off by more than [`RESYNC_DIFF_US`].
    Drifted,
    /// This lamp has no record of writing it.
    NeverWritten,
    /// The daily refresh.
    Daily,
}

/// What the write-back decision looks at.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WritebackInput {
    /// The wall clock's current source (`None`: invalid).
    pub clock_source: Option<Source>,
    /// Its current error bound, µs.
    pub clock_err_us: i64,
    /// The chip's last reading was valid.
    pub rtc_valid: bool,
    /// Chip − wall clock at the last reading, µs (`None`: no reading since the
    /// last write).
    pub rtc_diff_us: Option<i64>,
    /// Wall-clock seconds since this lamp last wrote the chip (`None`: never).
    pub since_write_s: Option<i64>,
    pub force: bool,
}

/// The plan's rule: write back when the clock is set from SNTP, the mesh or a
/// push and the chip differs by more than 1 s, or once a day otherwise; also
/// fill a chip that lost time from any source but itself. Never from a clock
/// worse than [`MAX_WRITE_ERR_US`] (the chip would only get worse), never from
/// the chip's own reading (a loop), and never from the soft-reset carry-over
/// alone onto a chip that still keeps time (the chip is the better clock then).
pub fn writeback_due(i: &WritebackInput) -> Writeback {
    let Some(src) = i.clock_source else {
        return Writeback::No;
    };
    if src == Source::HwRtc {
        return Writeback::No;
    }
    if i.force {
        return Writeback::Forced;
    }
    if i.clock_err_us > MAX_WRITE_ERR_US {
        return Writeback::No;
    }
    if !i.rtc_valid {
        return Writeback::ChipInvalid;
    }
    if src == Source::Carry {
        return Writeback::No;
    }
    let Some(diff) = i.rtc_diff_us else {
        // Wait for the verify read after the last write.
        return Writeback::No;
    };
    if diff.unsigned_abs() > RESYNC_DIFF_US as u64 {
        return Writeback::Drifted;
    }
    match i.since_write_s {
        None => Writeback::NeverWritten,
        Some(s) if s >= WRITE_EVERY_S => Writeback::Daily,
        Some(_) => Writeback::No,
    }
}
