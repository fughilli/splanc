//! POSIX TZ rules (D-562): the zone the lamp stores, e.g.
//! `"CET-1CEST,M3.5.0,M10.5.0/3"`.
//!
//! A POSIX rule is what the last line (the "footer") of a TZif v2+ file holds,
//! and what tzdata itself uses for every instant past its explicit transition
//! table. Stored on the device it keeps DST right for years with no network.
//!
//! Grammar (POSIX.1-2017 §8.3, plus the RFC 8536 §3.3.1 extensions tzdata
//! emits: hours up to 167 and negative rule times):
//!
//! ```text
//! std offset [dst [offset] [,start[/time],end[/time]]]
//! name   = 3+ letters | "<" 3+ of [A-Za-z0-9+-] ">"
//! offset = [+-]hh[:mm[:ss]]        hours WEST of UTC (CET-1 is UTC+1)
//! rule   = Jn (1..365, Feb 29 never counted) | n (0..365) | Mm.w.d
//!          (month 1..12, week 1..5 with 5 = last, weekday 0..6, 0 = Sunday)
//! time   = [+-]hh[:mm[:ss]]        local time of the change, default 02:00
//! ```
//!
//! A `dst` name without rules gets the US rule `M3.2.0,M11.1.0` (glibc and
//! musl do the same). The dst offset defaults to one hour ahead of std.
//!
//! Limits (as for any POSIX rule): one DST pair per year at most, so zones
//! whose changes don't follow a rule (Morocco's Ramadan suspension) carry only
//! the base offset, exactly as tzdata's own footer does.
//!
//! [`PosixTz`] implements [`LocalOffset`]. Local -> UTC (with the gap and
//! overlap rules a schedule needs) is [`LocalOffset::resolve_local`].

use crate::civil::{civil_from_days, days_from_civil, Weekday, SECS_PER_DAY, US_PER_SEC};
use crate::local::LocalOffset;

/// Longest zone abbreviation kept, bytes (tzdata's longest is 6; POSIX
/// guarantees at least 6, glibc allows more).
pub const MAX_NAME: usize = 15;
/// Longest TZ string accepted, bytes: the protocol's default string cap.
pub const MAX_TZ_LEN: usize = 64;
/// Largest offset magnitude accepted, seconds (24 h exclusive, as
/// [`crate::FixedOffset`]).
const MAX_OFFSET_S: i32 = 24 * 3600;
/// Largest rule-time magnitude accepted, seconds (RFC 8536: -167..167 h).
const MAX_RULE_TIME_S: i32 = 167 * 3600 + 59 * 60 + 59;
/// Default rule time: 02:00 local.
const DEFAULT_RULE_TIME_S: i32 = 2 * 3600;

/// Why a TZ string was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TzError {
    /// Empty, or longer than [`MAX_TZ_LEN`], or not ASCII.
    Length,
    /// A zone name is shorter than 3, longer than [`MAX_NAME`], unterminated
    /// `<`, or has a forbidden character.
    Name,
    /// A missing or out-of-range offset (|offset| must be < 24 h).
    Offset,
    /// A malformed or out-of-range start/end rule or rule time.
    Rule,
    /// Unparsed characters after a complete rule.
    Trailing,
}

/// A zone abbreviation, stored inline.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct TzName {
    bytes: [u8; MAX_NAME],
    len: u8,
}

impl TzName {
    const EMPTY: TzName = TzName {
        bytes: [0; MAX_NAME],
        len: 0,
    };

    /// The abbreviation, e.g. `"CEST"` or `"+0530"` (the `<>` are dropped).
    pub fn as_str(&self) -> &str {
        // Only ASCII from [A-Za-z0-9+-] is ever stored.
        core::str::from_utf8(&self.bytes[..self.len as usize]).unwrap_or("")
    }
}

impl core::fmt::Debug for TzName {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        core::fmt::Debug::fmt(self.as_str(), f)
    }
}

/// The day a DST change happens, as written in the rule.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RuleDay {
    /// `Jn`: day 1..=365 of the year, February 29 never counted (J60 is
    /// always March 1).
    Julian1(u16),
    /// `n`: day 0..=365 of the year, February 29 counted.
    Julian0(u16),
    /// `Mm.w.d`: weekday `d` (0 = Sunday) of week `w` (1..=5, 5 = the last)
    /// of month `m` (1..=12).
    MonthWeekDay { month: u8, week: u8, weekday: u8 },
}

impl RuleDay {
    /// Days since 1970-01-01 of this rule's day in `year`.
    pub const fn day_in_year(self, year: i64) -> i64 {
        let jan1 = days_from_civil(year, 1, 1);
        match self {
            RuleDay::Julian1(n) => {
                let n = n as i64;
                // Feb 29 is never counted: from March on, skip it in leap years.
                let leap = if crate::civil::is_leap_year(year) && n >= 60 {
                    1
                } else {
                    0
                };
                jan1 + n - 1 + leap
            }
            RuleDay::Julian0(n) => jan1 + n as i64,
            RuleDay::MonthWeekDay {
                month,
                week,
                weekday,
            } => {
                let first = days_from_civil(year, month, 1);
                let first_wd = Weekday::from_days(first).days_from_sunday() as i64;
                let mut day = first + (weekday as i64 - first_wd + 7) % 7 + (week as i64 - 1) * 7;
                let len = crate::civil::days_in_month(year, month) as i64;
                // Week 5 means "the last": step back into the month.
                while day >= first + len {
                    day -= 7;
                }
                day
            }
        }
    }
}

/// One DST change: the day and the local time it happens at (seconds after
/// local midnight of that day, in the time in force BEFORE the change; may be
/// negative or past 24 h).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rule {
    pub day: RuleDay,
    pub time_s: i32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct Dst {
    name: TzName,
    /// Seconds EAST of UTC (the opposite sign of the POSIX text).
    offset_s: i32,
    start: Rule,
    end: Rule,
}

/// A parsed POSIX TZ rule. About 60 bytes, `Copy`, no allocation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PosixTz {
    std_name: TzName,
    /// Seconds EAST of UTC.
    std_offset_s: i32,
    dst: Option<Dst>,
}

/// Is this instant in standard or daylight time?
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Standard,
    Daylight,
}

struct Cursor<'a> {
    s: &'a [u8],
    i: usize,
}

impl Cursor<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }

    fn eat(&mut self, c: u8) -> bool {
        if self.peek() == Some(c) {
            self.i += 1;
            true
        } else {
            false
        }
    }

    fn done(&self) -> bool {
        self.i >= self.s.len()
    }

    /// Up to `max_digits` decimal digits; `None` if there are none.
    fn number(&mut self, max_digits: usize) -> Option<i32> {
        let start = self.i;
        let mut v: i32 = 0;
        while let Some(c @ b'0'..=b'9') = self.peek() {
            if self.i - start >= max_digits {
                return None;
            }
            v = v * 10 + (c - b'0') as i32;
            self.i += 1;
        }
        if self.i == start {
            None
        } else {
            Some(v)
        }
    }

    fn name(&mut self) -> Result<TzName, TzError> {
        let mut out = TzName::EMPTY;
        let quoted = self.eat(b'<');
        loop {
            let Some(c) = self.peek() else { break };
            let ok = if quoted {
                c.is_ascii_alphanumeric() || c == b'+' || c == b'-'
            } else {
                c.is_ascii_alphabetic()
            };
            if !ok {
                break;
            }
            if out.len as usize >= MAX_NAME {
                return Err(TzError::Name);
            }
            out.bytes[out.len as usize] = c;
            out.len += 1;
            self.i += 1;
        }
        if quoted && !self.eat(b'>') {
            return Err(TzError::Name);
        }
        if out.len < 3 {
            return Err(TzError::Name);
        }
        Ok(out)
    }

    /// `[+-]hh[:mm[:ss]]` in seconds (sign applied), hours ≤ `max_h`.
    fn hms(&mut self, max_h: i32) -> Option<i32> {
        let neg = if self.eat(b'-') {
            true
        } else {
            self.eat(b'+');
            false
        };
        let h = self.number(3)?;
        if h > max_h {
            return None;
        }
        let mut secs = h * 3600;
        if self.eat(b':') {
            let m = self.number(2)?;
            if m > 59 {
                return None;
            }
            secs += m * 60;
            if self.eat(b':') {
                let s = self.number(2)?;
                if s > 59 {
                    return None;
                }
                secs += s;
            }
        }
        Some(if neg { -secs } else { secs })
    }

    /// A POSIX offset (hours WEST) as seconds EAST.
    fn offset(&mut self) -> Result<i32, TzError> {
        let west = self.hms(24).ok_or(TzError::Offset)?;
        if west.abs() >= MAX_OFFSET_S {
            return Err(TzError::Offset);
        }
        Ok(-west)
    }

    fn rule(&mut self) -> Result<Rule, TzError> {
        let day = if self.eat(b'J') {
            let n = self.number(3).ok_or(TzError::Rule)?;
            if !(1..=365).contains(&n) {
                return Err(TzError::Rule);
            }
            RuleDay::Julian1(n as u16)
        } else if self.eat(b'M') {
            let m = self.number(2).ok_or(TzError::Rule)?;
            if !self.eat(b'.') {
                return Err(TzError::Rule);
            }
            let w = self.number(1).ok_or(TzError::Rule)?;
            if !self.eat(b'.') {
                return Err(TzError::Rule);
            }
            let d = self.number(1).ok_or(TzError::Rule)?;
            if !(1..=12).contains(&m) || !(1..=5).contains(&w) || d > 6 {
                return Err(TzError::Rule);
            }
            RuleDay::MonthWeekDay {
                month: m as u8,
                week: w as u8,
                weekday: d as u8,
            }
        } else {
            let n = self.number(3).ok_or(TzError::Rule)?;
            if n > 365 {
                return Err(TzError::Rule);
            }
            RuleDay::Julian0(n as u16)
        };
        let time_s = if self.eat(b'/') {
            let t = self.hms(167).ok_or(TzError::Rule)?;
            if t.abs() > MAX_RULE_TIME_S {
                return Err(TzError::Rule);
            }
            t
        } else {
            DEFAULT_RULE_TIME_S
        };
        Ok(Rule { day, time_s })
    }
}

/// The US rule a bare `std off dst` string gets (as glibc and musl).
const DEFAULT_START: Rule = Rule {
    day: RuleDay::MonthWeekDay {
        month: 3,
        week: 2,
        weekday: 0,
    },
    time_s: DEFAULT_RULE_TIME_S,
};
const DEFAULT_END: Rule = Rule {
    day: RuleDay::MonthWeekDay {
        month: 11,
        week: 1,
        weekday: 0,
    },
    time_s: DEFAULT_RULE_TIME_S,
};

impl PosixTz {
    /// UTC, `"UTC0"`.
    pub const UTC: PosixTz = PosixTz {
        std_name: TzName {
            bytes: [b'U', b'T', b'C', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
            len: 3,
        },
        std_offset_s: 0,
        dst: None,
    };

    /// Parses a POSIX TZ rule (a leading `:` is not accepted: that names a
    /// file, which a lamp doesn't have).
    pub fn parse(s: &str) -> Result<PosixTz, TzError> {
        if s.is_empty() || s.len() > MAX_TZ_LEN || !s.is_ascii() {
            return Err(TzError::Length);
        }
        let mut c = Cursor {
            s: s.as_bytes(),
            i: 0,
        };
        let std_name = c.name()?;
        let std_offset_s = c.offset()?;
        if c.done() {
            return Ok(PosixTz {
                std_name,
                std_offset_s,
                dst: None,
            });
        }
        let dst_name = c.name()?;
        let dst_offset_s = match c.peek() {
            Some(b'+' | b'-' | b'0'..=b'9') => c.offset()?,
            _ => std_offset_s + 3600,
        };
        if dst_offset_s.abs() >= MAX_OFFSET_S {
            return Err(TzError::Offset);
        }
        let (start, end) = if c.eat(b',') {
            let start = c.rule()?;
            if !c.eat(b',') {
                return Err(TzError::Rule);
            }
            (start, c.rule()?)
        } else {
            (DEFAULT_START, DEFAULT_END)
        };
        if !c.done() {
            return Err(TzError::Trailing);
        }
        Ok(PosixTz {
            std_name,
            std_offset_s,
            dst: Some(Dst {
                name: dst_name,
                offset_s: dst_offset_s,
                start,
                end,
            }),
        })
    }

    /// Standard-time offset, seconds east of UTC.
    pub const fn std_offset_s(&self) -> i32 {
        self.std_offset_s
    }

    /// Daylight-time offset, seconds east of UTC (`None` for a zone without
    /// DST).
    pub fn dst_offset_s(&self) -> Option<i32> {
        self.dst.map(|d| d.offset_s)
    }

    /// True when the rule has a daylight-saving period.
    pub const fn has_dst(&self) -> bool {
        self.dst.is_some()
    }

    /// The standard-time abbreviation.
    pub fn std_name(&self) -> &str {
        self.std_name.as_str()
    }

    /// The daylight-time abbreviation, if any.
    pub fn dst_name(&self) -> Option<&str> {
        self.dst.as_ref().map(|d| d.name.as_str())
    }

    /// The DST start and end instants in `year` (UTC seconds), `None` without
    /// DST. In the southern hemisphere start is later in the year than end.
    pub fn transitions_s(&self, year: i64) -> Option<(i64, i64)> {
        let d = self.dst?;
        // The start happens on standard time, the end on daylight time.
        let start = d.start.day.day_in_year(year) * SECS_PER_DAY + d.start.time_s as i64
            - self.std_offset_s as i64;
        let end =
            d.end.day.day_in_year(year) * SECS_PER_DAY + d.end.time_s as i64 - d.offset_s as i64;
        Some((start, end))
    }

    /// Standard or daylight time at a UTC instant (seconds).
    pub fn phase_at_s(&self, utc_s: i64) -> Phase {
        if self.dst.is_none() {
            return Phase::Standard;
        }
        // The year of the instant on standard time; each year's pair of
        // changes is evaluated within that year, as musl and glibc do.
        let local_days = (utc_s + self.std_offset_s as i64).div_euclid(SECS_PER_DAY);
        let (year, _, _) = civil_from_days(local_days);
        let Some((start, end)) = self.transitions_s(year) else {
            return Phase::Standard;
        };
        let dst = if start < end {
            utc_s >= start && utc_s < end
        } else {
            // Southern hemisphere: DST spans the new year.
            !(utc_s >= end && utc_s < start)
        };
        if dst {
            Phase::Daylight
        } else {
            Phase::Standard
        }
    }

    /// The zone abbreviation in force at a UTC instant (µs).
    pub fn name_at(&self, utc_us: i64) -> &str {
        match (self.phase_at_s(utc_us.div_euclid(US_PER_SEC)), &self.dst) {
            (Phase::Daylight, Some(d)) => d.name.as_str(),
            _ => self.std_name.as_str(),
        }
    }

    /// The first offset change strictly after `utc_us`, as (UTC µs, the new
    /// offset in seconds east). `None` for a zone without DST, or one whose
    /// "DST" covers the whole year (no visible change).
    pub fn next_change_us(&self, utc_us: i64) -> Option<(i64, i32)> {
        let utc_s = utc_us.div_euclid(US_PER_SEC);
        let (year, _, _) = civil_from_days(utc_s.div_euclid(SECS_PER_DAY));
        let mut best: Option<(i64, i32)> = None;
        // Changes this year and the next two cover every rule ordering.
        for y in year - 1..=year + 2 {
            let (start, end) = self.transitions_s(y)?;
            for t in [start, end] {
                let t_us = t.saturating_mul(US_PER_SEC);
                if t_us <= utc_us {
                    continue;
                }
                let before = self.utc_offset_s((t - 1).saturating_mul(US_PER_SEC));
                let after = self.utc_offset_s(t_us);
                if before != after && best.is_none_or(|(b, _)| t_us < b) {
                    best = Some((t_us, after));
                }
            }
        }
        best
    }
}

impl LocalOffset for PosixTz {
    fn utc_offset_s(&self, utc_us: i64) -> i32 {
        match (self.phase_at_s(utc_us.div_euclid(US_PER_SEC)), &self.dst) {
            (Phase::Daylight, Some(d)) => d.offset_s,
            _ => self.std_offset_s,
        }
    }
}

impl core::str::FromStr for PosixTz {
    type Err = TzError;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        PosixTz::parse(s)
    }
}
