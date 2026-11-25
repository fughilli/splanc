//! When a rule fires: the instants (UTC seconds) of a [`When`] in the lamp's
//! zone, across DST changes.
//!
//! - A LOCAL_TIME rule names a local wall time. In a spring-forward gap it fires
//!   at the first instant after the gap (02:30 on the change day -> 03:00); in a
//!   fall-back overlap it fires once, at the first occurrence.
//! - SUNRISE / SUNSET rules fire at the event of each LOCAL date (plus the
//!   offset); a date without the event (polar night, midnight sun) is skipped.
//! - `days_mask` selects the LOCAL date's weekday.

use ledmapper_clock::civil::{days_from_civil, DateTime, Weekday, SECS_PER_DAY, US_PER_SEC};
use ledmapper_clock::local::{local_us, LocalOffset};

use crate::rule::{When, WhenKind};
use crate::sun::{event_s, Event, Location};

/// Dates searched past (and before) an instant: a weekday mask repeats within a week.
const SEARCH_DAYS: i64 = 8;

/// The fire instant (UTC seconds) of `when` on the local date `days` (days
/// since 1970-01-01, local), or None when it doesn't fire that date.
pub fn fire_on<Z: LocalOffset + ?Sized>(
    when: &When,
    days: i64,
    zone: &Z,
    loc: Option<Location>,
) -> Option<i64> {
    if !when.on_weekday(Weekday::from_days(days).days_from_sunday()) {
        return None;
    }
    match when.kind {
        WhenKind::LocalTime => {
            let local = (days * SECS_PER_DAY + when.minute_of_day as i64 * 60) * US_PER_SEC;
            Some(zone.local_to_utc_us(local).div_euclid(US_PER_SEC))
        }
        WhenKind::Sunrise | WhenKind::Sunset => {
            let ev = if when.kind == WhenKind::Sunrise {
                Event::Sunrise
            } else {
                Event::Sunset
            };
            let d = DateTime::from_unix_us(days * SECS_PER_DAY * US_PER_SEC);
            let s = event_s(d.year, d.month, d.day, loc?, ev)?;
            Some(
                days_from_civil(d.year, d.month, d.day) * SECS_PER_DAY
                    + s
                    + when.offset_min as i64 * 60,
            )
        }
    }
}

/// The local date (days since the epoch) at UTC second `utc_s`.
fn local_days<Z: LocalOffset + ?Sized>(utc_s: i64, zone: &Z) -> i64 {
    local_us(utc_s.saturating_mul(US_PER_SEC), zone).div_euclid(SECS_PER_DAY * US_PER_SEC)
}

/// The first fire strictly after `after_s` (UTC seconds), within about a week.
pub fn next_fire<Z: LocalOffset + ?Sized>(
    when: &When,
    after_s: i64,
    zone: &Z,
    loc: Option<Location>,
) -> Option<i64> {
    let d0 = local_days(after_s, zone);
    // From the day before: an offset sunset rule (or a far-west zone's sun
    // event) of the previous local date can still be ahead.
    (d0 - 1..=d0 + SEARCH_DAYS)
        .filter_map(|d| fire_on(when, d, zone, loc))
        .filter(|&t| t > after_s)
        .min()
}

/// The latest fire at or before `at_s`, within about a week (the state in
/// force, D-566).
pub fn prev_fire<Z: LocalOffset + ?Sized>(
    when: &When,
    at_s: i64,
    zone: &Z,
    loc: Option<Location>,
) -> Option<i64> {
    let d0 = local_days(at_s, zone);
    (d0 - SEARCH_DAYS..=d0 + 1)
        .filter_map(|d| fire_on(when, d, zone, loc))
        .filter(|&t| t <= at_s)
        .max()
}
