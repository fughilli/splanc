//! Civil (proleptic Gregorian) calendar arithmetic on UTC microseconds since the
//! Unix epoch.
//!
//! Every function is total over `i64` days / microseconds: the day-count
//! algorithms are Howard Hinnant's `days_from_civil` / `civil_from_days`
//! (<http://howardhinnant.github.io/date_algorithms.html>), which are exact for
//! the whole proleptic Gregorian calendar, so 2038, 2100, 2400 and negative
//! (pre-1970) times all work. Leap seconds are not represented (Unix time).

/// Microseconds per second.
pub const US_PER_SEC: i64 = 1_000_000;
/// Seconds per civil day (Unix time has no leap seconds).
pub const SECS_PER_DAY: i64 = 86_400;
/// Microseconds per civil day.
pub const US_PER_DAY: i64 = SECS_PER_DAY * US_PER_SEC;

/// Day of the week. The discriminant is the ISO 8601 number (Monday = 1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[repr(u8)]
pub enum Weekday {
    Monday = 1,
    Tuesday = 2,
    Wednesday = 3,
    Thursday = 4,
    Friday = 5,
    Saturday = 6,
    Sunday = 7,
}

impl Weekday {
    /// The weekday of a day number (days since 1970-01-01, a Thursday).
    pub const fn from_days(days: i64) -> Self {
        // 1970-01-01 is Thursday (ISO 4): shift so day 0 lands on index 3.
        match (days + 3).rem_euclid(7) {
            0 => Weekday::Monday,
            1 => Weekday::Tuesday,
            2 => Weekday::Wednesday,
            3 => Weekday::Thursday,
            4 => Weekday::Friday,
            5 => Weekday::Saturday,
            _ => Weekday::Sunday,
        }
    }

    /// ISO 8601 number: Monday = 1 .. Sunday = 7.
    pub const fn iso(self) -> u8 {
        self as u8
    }

    /// Days since Sunday: Sunday = 0 .. Saturday = 6 (C `tm_wday`, and the bit
    /// index a schedule weekday mask will use).
    pub const fn days_from_sunday(self) -> u8 {
        (self as u8) % 7
    }
}

/// True for Gregorian leap years (divisible by 4, except centuries not
/// divisible by 400: 2000 and 2400 are leap years, 2100 is not).
pub const fn is_leap_year(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

/// Days in `month` (1..=12) of `year`; 0 for an out-of-range month.
pub const fn days_in_month(year: i64, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if is_leap_year(year) => 29,
        2 => 28,
        _ => 0,
    }
}

/// Days since 1970-01-01 of the civil date `year-month-day`. The inputs are not
/// range-checked (use [`DateTime::to_unix_us`] for a validating conversion);
/// `month` must be 1..=12.
pub const fn days_from_civil(year: i64, month: u8, day: u8) -> i64 {
    let m = month as i64;
    let y = if m <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 }; // March = 0
    let doy = (153 * mp + 2) / 5 + day as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// The civil date `(year, month, day)` of a day number (days since 1970-01-01).
pub const fn civil_from_days(days: i64) -> (i64, u8, u8) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let day = (doy - (153 * mp + 2) / 5 + 1) as u8; // [1, 31]
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u8; // [1, 12]
    let year = yoe + era * 400 + if month <= 2 { 1 } else { 0 };
    (year, month, day)
}

/// A broken-down civil time. As produced by [`DateTime::from_unix_us`] it is
/// always valid; hand-built values are checked by [`DateTime::to_unix_us`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct DateTime {
    pub year: i64,
    /// 1..=12
    pub month: u8,
    /// 1..=31
    pub day: u8,
    /// 0..=23
    pub hour: u8,
    /// 0..=59
    pub minute: u8,
    /// 0..=59 (Unix time: no leap second 60)
    pub second: u8,
    /// 0..=999_999
    pub micros: u32,
}

impl DateTime {
    /// Breaks down `unix_us` (µs since 1970-01-01T00:00:00Z). Total over `i64`.
    pub const fn from_unix_us(unix_us: i64) -> Self {
        let days = unix_us.div_euclid(US_PER_DAY);
        let tod = unix_us.rem_euclid(US_PER_DAY); // [0, US_PER_DAY)
        let (year, month, day) = civil_from_days(days);
        let secs = tod / US_PER_SEC;
        DateTime {
            year,
            month,
            day,
            hour: (secs / 3600) as u8,
            minute: ((secs / 60) % 60) as u8,
            second: (secs % 60) as u8,
            micros: (tod % US_PER_SEC) as u32,
        }
    }

    /// Midnight UTC at the start of `year-month-day`, if the date is valid.
    pub const fn from_ymd(year: i64, month: u8, day: u8) -> Option<Self> {
        let dt = DateTime {
            year,
            month,
            day,
            hour: 0,
            minute: 0,
            second: 0,
            micros: 0,
        };
        if dt.is_valid() {
            Some(dt)
        } else {
            None
        }
    }

    /// True when every field is in range for the calendar.
    pub const fn is_valid(&self) -> bool {
        self.month >= 1
            && self.month <= 12
            && self.day >= 1
            && self.day <= days_in_month(self.year, self.month)
            && self.hour < 24
            && self.minute < 60
            && self.second < 60
            && self.micros < 1_000_000
    }

    /// µs since the Unix epoch; `None` for an invalid date or one outside the
    /// `i64` µs range (about ±292 000 years).
    pub const fn to_unix_us(&self) -> Option<i64> {
        if !self.is_valid() {
            return None;
        }
        // |year| beyond ~300 000 overflows the µs product; bail before the
        // day arithmetic can overflow either.
        if self.year > 300_000 || self.year < -300_000 {
            return None;
        }
        let days = days_from_civil(self.year, self.month, self.day);
        let secs = self.hour as i64 * 3600 + self.minute as i64 * 60 + self.second as i64;
        let Some(day_us) = days.checked_mul(US_PER_DAY) else {
            return None;
        };
        day_us.checked_add(secs * US_PER_SEC + self.micros as i64)
    }

    /// Days since 1970-01-01 of this date.
    pub const fn days(&self) -> i64 {
        days_from_civil(self.year, self.month, self.day)
    }

    /// The day of the week.
    pub const fn weekday(&self) -> Weekday {
        Weekday::from_days(self.days())
    }

    /// Ordinal day of the year, 1-based (1..=366).
    pub const fn day_of_year(&self) -> u16 {
        (self.days() - days_from_civil(self.year, 1, 1) + 1) as u16
    }

    /// Seconds since local midnight of this broken-down time (0..86_400).
    pub const fn seconds_of_day(&self) -> u32 {
        self.hour as u32 * 3600 + self.minute as u32 * 60 + self.second as u32
    }
}
