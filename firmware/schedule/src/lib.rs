//! Wall-clock schedules for lamps (docs/design/schedule.md): "at 07:00 on
//! weekdays fade up", "at sunset crossfade to the evening effect".
//!
//! - [`rule`]: the rule model and its wire form (the `ScheduleRule` message of
//!   ledmapper.proto, hand-coded so the crate stays dependency-free and the
//!   firmware stores rules zero-copy in `/lfs/sched.pb`).
//! - [`next`]: when a rule fires in the lamp's zone (POSIX TZ via
//!   `ledmapper_clock`), across DST gaps and overlaps.
//! - [`sun`]: NOAA sunrise / sunset for the lamp's stored location (D-565).
//! - [`engine`]: the compact rule table, firing ahead of time, boot /
//!   late-clock reconciliation (D-566) and clock-step handling.
//!
//! no_std, never allocates; shared by the C6 firmware and `player_rs`.
#![no_std]

pub mod engine;
pub mod next;
pub mod rule;
pub mod sun;

pub use engine::{Engine, Fire, Full, Slot, CAPACITY, STEP_RECONCILE_S};
pub use next::{fire_on, next_fire, prev_fire};
pub use rule::{rule_bodies, Action, ActionKind, Rule, RuleError, Str, When, WhenKind, Writer};
pub use sun::{Event, Location};
