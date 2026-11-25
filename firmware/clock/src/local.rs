//! The local-time seam.
//!
//! The wall clock itself is always UTC; local time is only ever derived at the
//! edge with [`to_local`]. The zone is a [`LocalOffset`]: [`Utc`],
//! [`FixedOffset`], or (D-562) a stored POSIX TZ rule, [`crate::PosixTz`],
//! which the app derives from the phone's IANA zone so DST stays right while
//! the lamp is offline.
//!
//! Local -> UTC ([`LocalOffset::resolve_local`]) is generic over any zone and
//! applies the schedule rules: a local time in a spring-forward gap maps to the
//! first instant after the gap; one in a fall-back overlap maps to its first
//! occurrence.

use crate::civil::{DateTime, US_PER_SEC};

/// Maps a UTC instant to the local zone's offset from UTC at that instant.
///
/// An implementation answers for an *instant* (not a local wall time), so it is
/// always unambiguous: DST gaps and overlaps only matter for the reverse
/// (local -> UTC) direction, which a schedule engine will add alongside the
/// real zone implementation.
pub trait LocalOffset {
    /// Seconds to add to UTC to get local time at `utc_us` (east positive:
    /// UTC+1 is 3600). Must be within ±24 h.
    fn utc_offset_s(&self, utc_us: i64) -> i32;

    /// The UTC instant(s) a local wall time (µs "since the epoch" on the local
    /// clock) names. Assumes at most one offset change within ±24 h of it,
    /// which holds for every real zone.
    fn resolve_local(&self, local_us: i64) -> LocalResult {
        const DAY_US: i64 = 86_400 * US_PER_SEC;
        let before = self.utc_offset_s(local_us.saturating_sub(DAY_US)) as i64 * US_PER_SEC;
        let after = self.utc_offset_s(local_us.saturating_add(DAY_US)) as i64 * US_PER_SEC;
        let fits = |off: i64| {
            let utc = local_us.saturating_sub(off);
            (self.utc_offset_s(utc) as i64 * US_PER_SEC == off).then_some(utc)
        };
        match (fits(before), fits(after)) {
            (Some(a), Some(b)) if a != b => LocalResult::Ambiguous {
                earlier: a.min(b),
                later: a.max(b),
            },
            (Some(a), _) | (None, Some(a)) => LocalResult::Unique(a),
            (None, None) => {
                // A spring-forward gap: the change lies between the two
                // candidates; find its first instant (µs) by bisection.
                let mut lo = local_us.saturating_sub(before.max(after));
                let mut hi = local_us.saturating_sub(before.min(after));
                let lo_off = self.utc_offset_s(lo);
                while hi - lo > 1 {
                    let mid = lo + (hi - lo) / 2;
                    if self.utc_offset_s(mid) == lo_off {
                        lo = mid;
                    } else {
                        hi = mid;
                    }
                }
                LocalResult::Gap { after_us: hi }
            }
        }
    }

    /// The UTC instant for a local wall time under the schedule rules: a gap
    /// maps to the first instant after it, an overlap to the first occurrence.
    fn local_to_utc_us(&self, local_us: i64) -> i64 {
        match self.resolve_local(local_us) {
            LocalResult::Unique(u) => u,
            LocalResult::Ambiguous { earlier, .. } => earlier,
            LocalResult::Gap { after_us } => after_us,
        }
    }
}

/// What a local wall time maps to in UTC.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalResult {
    /// Exactly one instant.
    Unique(i64),
    /// Twice (a fall-back overlap): both instants, UTC µs.
    Ambiguous { earlier: i64, later: i64 },
    /// Never (a spring-forward gap): the first instant after the gap, UTC µs.
    Gap { after_us: i64 },
}

/// UTC itself (offset 0). The default until a zone is configured.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Utc;

impl LocalOffset for Utc {
    fn utc_offset_s(&self, _utc_us: i64) -> i32 {
        0
    }
}

/// A constant offset from UTC with no DST (e.g. UTC+05:30 all year).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct FixedOffset {
    secs: i32,
}

impl FixedOffset {
    /// Largest accepted magnitude, exclusive: 24 h.
    pub const MAX_ABS_S: i32 = 24 * 3600;

    /// `secs` east of UTC; `None` unless |secs| < 24 h.
    pub const fn new(secs: i32) -> Option<Self> {
        if secs > -Self::MAX_ABS_S && secs < Self::MAX_ABS_S {
            Some(FixedOffset { secs })
        } else {
            None
        }
    }

    /// The offset in seconds east of UTC.
    pub const fn secs(&self) -> i32 {
        self.secs
    }
}

impl LocalOffset for FixedOffset {
    fn utc_offset_s(&self, _utc_us: i64) -> i32 {
        self.secs
    }
}

/// Local µs "since the epoch" (UTC µs plus the zone's offset at that instant),
/// saturating at the `i64` range.
pub fn local_us<Z: LocalOffset + ?Sized>(utc_us: i64, zone: &Z) -> i64 {
    let off = zone.utc_offset_s(utc_us) as i64;
    utc_us.saturating_add(off * US_PER_SEC)
}

/// The broken-down local time of a UTC instant.
pub fn to_local<Z: LocalOffset + ?Sized>(utc_us: i64, zone: &Z) -> DateTime {
    DateTime::from_unix_us(local_us(utc_us, zone))
}
