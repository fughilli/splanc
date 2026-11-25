//! The local-time seam.
//!
//! TODO(D-562): time zones and DST are deliberately NOT implemented here yet.
//! Desk item D-562 settled the approach: the device stores a POSIX TZ rule
//! that the app derives from the phone's IANA zone, so DST stays right while
//! the lamp is offline. That lands as a follow-up `PosixTz` implementation of
//! [`LocalOffset`] (the parser, gap/overlap rules for local -> UTC, and tzdata
//! vector tests). Nothing else in this crate needs to change: the wall clock
//! itself is always UTC, and local time is only ever derived at the edge with
//! [`to_local`].

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
