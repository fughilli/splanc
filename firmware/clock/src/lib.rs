//! The device wall clock: UTC civil time, the software RTC and its source
//! discipline.
//!
//! - [`civil`]: UTC µs since the Unix epoch ↔ Y/M/D h:m:s and weekday (`i64`,
//!   proleptic Gregorian, exact far past 2100).
//! - [`discipline`]: the [`WallClock`]. Sources (SNTP, mesh, app/bridge,
//!   hardware RTC, soft-reset carry-over) make [`Offer`]s with an error bound
//!   that grows with age at a per-source drift rate; the clock keeps the lowest
//!   current error, steps corrections over 1 s and slews smaller ones, refuses
//!   implausible offers and fits the crystal's rate.
//! - [`guard`]: the monotonic-clock step-back guard (the C6's `esp_timer`
//!   jumps back by multiples of 2^24 systimer ticks).
//! - [`carry`]: the CRC-guarded record that carries the time over a soft reset.
//! - [`local`]: the local-time seam ([`LocalOffset`]), with local -> UTC
//!   under the schedule's gap/overlap rules.
//! - [`tz`]: POSIX TZ rules (D-562: the zone the lamp stores), e.g.
//!   `CET-1CEST,M3.5.0,M10.5.0/3`, as a [`LocalOffset`].
//!
//! `no_std`, zero-dependency, never allocates. Nothing here touches hardware:
//! the firmware wiring (esp_timer base, the `lm_clock_observe` shift, the
//! protocol arms) lands separately.

#![no_std]

pub mod carry;
pub mod civil;
pub mod discipline;
pub mod guard;
pub mod local;
pub mod tz;

pub use carry::CarryRecord;
pub use civil::{DateTime, Weekday};
pub use discipline::{Applied, Config, Offer, Reject, Source, Status, WallClock};
pub use guard::{MonoClock, StepGuard};
pub use local::{FixedOffset, LocalOffset, LocalResult, Utc};
pub use tz::{Phase, PosixTz, TzError};
