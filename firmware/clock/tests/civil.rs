//! Civil-time conversions: fixed vectors (cross-checked against Python's
//! `datetime`), leap-year rules, the 2038 and 2106 32-bit boundaries, and
//! property-style round trips.

use ledmapper_clock::civil::{
    civil_from_days, days_from_civil, days_in_month, is_leap_year, US_PER_DAY, US_PER_SEC,
};
use ledmapper_clock::local::{local_us, to_local};
use ledmapper_clock::{DateTime, FixedOffset, Utc, Weekday};

fn dt(year: i64, month: u8, day: u8, hour: u8, minute: u8, second: u8) -> DateTime {
    DateTime {
        year,
        month,
        day,
        hour,
        minute,
        second,
        micros: 0,
    }
}

/// (Y, M, D, h, m, s).
type Ymdhms = (i64, u8, u8, u8, u8, u8);

/// (Y, M, D, h, m, s) -> Unix seconds and ISO weekday, from Python `datetime`.
const VECTORS: &[(Ymdhms, i64, u8)] = &[
    ((1970, 1, 1, 0, 0, 0), 0, 4),
    ((2038, 1, 19, 3, 14, 8), 2_147_483_648, 2), // first second past i32 time_t
    ((2100, 3, 1, 0, 0, 0), 4_107_542_400, 1),
    ((2400, 2, 29, 12, 0, 0), 13_574_606_400, 2),
    ((2026, 11, 25, 0, 0, 0), 1_795_564_800, 3),
    ((2026, 1, 1, 0, 0, 0), 1_767_225_600, 4),
    ((9999, 12, 31, 23, 59, 59), 253_402_300_799, 5),
    ((1600, 3, 1, 0, 0, 0), -11_670_912_000, 3),
    ((2106, 2, 7, 6, 28, 16), 4_294_967_296, 7), // first second past u32 seconds
];

#[test]
fn fixed_vectors_both_ways() {
    for &((y, mo, d, h, mi, s), secs, iso) in VECTORS {
        let want = dt(y, mo, d, h, mi, s);
        let us = secs * US_PER_SEC;
        assert_eq!(DateTime::from_unix_us(us), want, "{secs}");
        assert_eq!(want.to_unix_us(), Some(us), "{want:?}");
        assert_eq!(want.weekday().iso(), iso, "{want:?}");
    }
}

#[test]
fn year_2038_boundary() {
    let max32 = i32::MAX as i64 * US_PER_SEC;
    assert_eq!(DateTime::from_unix_us(max32), dt(2038, 1, 19, 3, 14, 7));
    assert_eq!(
        DateTime::from_unix_us(max32 + US_PER_SEC),
        dt(2038, 1, 19, 3, 14, 8)
    );
    assert_eq!(
        DateTime::from_unix_us(max32 + US_PER_SEC).weekday(),
        Weekday::Tuesday
    );
    // i32::MIN seconds: 1901-12-13T20:45:52Z, a Friday.
    let min32 = i32::MIN as i64 * US_PER_SEC;
    assert_eq!(DateTime::from_unix_us(min32), dt(1901, 12, 13, 20, 45, 52));
    assert_eq!(DateTime::from_unix_us(min32).weekday(), Weekday::Friday);
}

#[test]
fn leap_year_rules() {
    for y in [1996, 2000, 2004, 2024, 2028, 2400, 1600, -4, 0] {
        assert!(is_leap_year(y), "{y}");
    }
    for y in [1900, 2100, 2200, 2300, 2023, 2025, 1, -1, -100] {
        assert!(!is_leap_year(y), "{y}");
    }
    assert!(DateTime::from_ymd(2024, 2, 29).is_some());
    assert!(DateTime::from_ymd(2000, 2, 29).is_some());
    assert!(DateTime::from_ymd(2400, 2, 29).is_some());
    assert!(DateTime::from_ymd(2100, 2, 29).is_none());
    assert!(DateTime::from_ymd(1900, 2, 29).is_none());
    assert!(DateTime::from_ymd(2025, 2, 29).is_none());
    // 2100-02-28 is followed directly by 2100-03-01.
    let feb28 = DateTime::from_ymd(2100, 2, 28)
        .unwrap()
        .to_unix_us()
        .unwrap();
    assert_eq!(
        DateTime::from_unix_us(feb28 + US_PER_DAY),
        dt(2100, 3, 1, 0, 0, 0)
    );
    // ...but 2400-02-28 by 02-29.
    let feb28 = DateTime::from_ymd(2400, 2, 28)
        .unwrap()
        .to_unix_us()
        .unwrap();
    assert_eq!(
        DateTime::from_unix_us(feb28 + US_PER_DAY),
        dt(2400, 2, 29, 0, 0, 0)
    );
}

#[test]
fn year_lengths_match_the_day_count() {
    for y in 1500..2600 {
        let len = days_from_civil(y + 1, 1, 1) - days_from_civil(y, 1, 1);
        assert_eq!(len, if is_leap_year(y) { 366 } else { 365 }, "{y}");
        let months: i64 = (1..=12).map(|m| days_in_month(y, m) as i64).sum();
        assert_eq!(months, len, "{y}");
        let dec31 = DateTime::from_ymd(y, 12, 31).unwrap();
        assert_eq!(dec31.day_of_year() as i64, len, "{y}");
    }
    // 400-year Gregorian cycle = 146 097 days.
    assert_eq!(
        days_from_civil(2400, 1, 1) - days_from_civil(2000, 1, 1),
        146_097
    );
}

#[test]
fn every_day_round_trips_and_advances() {
    // Every day from 1600 to ~2500: civil_from_days is the exact inverse, each
    // day is the calendar successor of the one before, and the weekday cycles.
    let start = days_from_civil(1600, 1, 1);
    let end = days_from_civil(2500, 1, 1);
    let mut prev = civil_from_days(start - 1);
    let mut prev_wd = Weekday::from_days(start - 1).iso();
    for days in start..end {
        let (y, m, d) = civil_from_days(days);
        assert_eq!(days_from_civil(y, m, d), days);
        assert!(d >= 1 && d <= days_in_month(y, m), "{y}-{m}-{d}");
        let (py, pm, pd) = prev;
        let successor = if pd < days_in_month(py, pm) {
            (py, pm, pd + 1)
        } else if pm < 12 {
            (py, pm + 1, 1)
        } else {
            (py + 1, 1, 1)
        };
        assert_eq!((y, m, d), successor, "after {prev:?}");
        let wd = Weekday::from_days(days).iso();
        assert_eq!(wd, prev_wd % 7 + 1);
        prev = (y, m, d);
        prev_wd = wd;
    }
}

/// A small deterministic PRNG (SplitMix64) for property-style tests.
struct Rng(u64);
impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }
}

#[test]
fn random_instants_round_trip() {
    let mut rng = Rng(0x5eed);
    for i in 0..200_000 {
        // Mix the full i64 range with the interesting 1900..2200 window.
        let us = if i % 2 == 0 {
            rng.next() as i64
        } else {
            let span = days_from_civil(2200, 1, 1) - days_from_civil(1900, 1, 1);
            let base = days_from_civil(1900, 1, 1) * US_PER_DAY;
            base + (rng.next() % (span as u64 * US_PER_DAY as u64)) as i64
        };
        let b = DateTime::from_unix_us(us);
        assert!(b.is_valid(), "{us} -> {b:?}");
        if b.year.abs() <= 290_000 {
            assert_eq!(b.to_unix_us(), Some(us), "{us} -> {b:?}");
        }
        // Weekday from the date agrees with weekday from the instant.
        assert_eq!(b.weekday(), Weekday::from_days(us.div_euclid(US_PER_DAY)));
    }
}

#[test]
fn negative_and_extreme_instants() {
    let b = DateTime::from_unix_us(-1);
    assert_eq!(
        (b.year, b.month, b.day, b.hour, b.minute, b.second),
        (1969, 12, 31, 23, 59, 59)
    );
    assert_eq!(b.micros, 999_999);
    assert_eq!(b.to_unix_us(), Some(-1));
    // Total over i64 (no panic), and the extremes are valid dates.
    for us in [i64::MIN, i64::MIN + 1, i64::MAX, i64::MAX - 1] {
        assert!(DateTime::from_unix_us(us).is_valid());
    }
    // Out of the µs range: refused, not wrapped.
    assert_eq!(
        DateTime::from_ymd(400_000, 1, 1).unwrap().to_unix_us(),
        None
    );
    assert_eq!(
        DateTime::from_ymd(-400_000, 1, 1).unwrap().to_unix_us(),
        None
    );
}

#[test]
fn invalid_fields_are_refused() {
    let ok = dt(2026, 6, 15, 12, 30, 45);
    assert!(ok.to_unix_us().is_some());
    for bad in [
        DateTime { month: 0, ..ok },
        DateTime { month: 13, ..ok },
        DateTime { day: 0, ..ok },
        DateTime { day: 31, ..ok }, // June has 30
        DateTime { hour: 24, ..ok },
        DateTime { minute: 60, ..ok },
        DateTime { second: 60, ..ok }, // no leap seconds in Unix time
        DateTime {
            micros: 1_000_000,
            ..ok
        },
    ] {
        assert!(!bad.is_valid(), "{bad:?}");
        assert_eq!(bad.to_unix_us(), None, "{bad:?}");
    }
}

#[test]
fn fields_and_helpers() {
    let t = DateTime {
        micros: 123_456,
        ..dt(2024, 12, 31, 23, 59, 58)
    };
    assert_eq!(t.day_of_year(), 366);
    assert_eq!(t.seconds_of_day(), 86_398);
    assert_eq!(DateTime::from_ymd(2026, 1, 1).unwrap().day_of_year(), 1);
    assert_eq!(Weekday::Sunday.days_from_sunday(), 0);
    assert_eq!(Weekday::Saturday.days_from_sunday(), 6);
    assert_eq!(Weekday::Monday.days_from_sunday(), 1);
    assert_eq!(DateTime::from_unix_us(t.to_unix_us().unwrap()), t);
}

#[test]
fn local_offset_seam() {
    let noon = dt(2026, 11, 25, 12, 0, 0).to_unix_us().unwrap();
    assert_eq!(to_local(noon, &Utc), dt(2026, 11, 25, 12, 0, 0));
    let ist = FixedOffset::new(5 * 3600 + 1800).unwrap();
    assert_eq!(to_local(noon, &ist), dt(2026, 11, 25, 17, 30, 0));
    // West of UTC across midnight and a year boundary.
    let new_year = dt(2027, 1, 1, 3, 0, 0).to_unix_us().unwrap();
    let pst = FixedOffset::new(-8 * 3600).unwrap();
    assert_eq!(to_local(new_year, &pst), dt(2026, 12, 31, 19, 0, 0));
    assert_eq!(FixedOffset::new(24 * 3600), None);
    assert_eq!(FixedOffset::new(-24 * 3600), None);
    assert!(FixedOffset::new(14 * 3600).is_some()); // UTC+14 exists
                                                    // Saturates instead of overflowing.
    assert_eq!(local_us(i64::MAX, &ist), i64::MAX);
    // Usable as a trait object (the firmware will hold a `&dyn LocalOffset`).
    let zone: &dyn ledmapper_clock::LocalOffset = &pst;
    assert_eq!(to_local(new_year, zone).hour, 19);
}
