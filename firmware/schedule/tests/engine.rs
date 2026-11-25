//! The firing engine: ahead-of-time fires, boot reconcile (D-566), outages,
//! clock steps, edits, capacity.

use ledmapper_clock::civil::DateTime;
use ledmapper_clock::PosixTz;
use ledmapper_schedule::{Action, ActionKind, Engine, Fire, Rule, Str, When, CAPACITY};

fn utc(y: i64, mo: u8, d: u8, h: u8, mi: u8, s: u8) -> i64 {
    let dt = DateTime {
        year: y,
        month: mo,
        day: d,
        hour: h,
        minute: mi,
        second: s,
        micros: 0,
    };
    dt.to_unix_us().unwrap() / 1_000_000
}

fn rule(id: u8, minute: u16, action: Action) -> Rule {
    Rule {
        id,
        enabled: true,
        label: Str::EMPTY,
        when: When::local(minute, 0),
        action,
    }
}

fn power(on: bool) -> Action {
    Action::Power {
        on,
        duration_ms: 1000,
    }
}

fn poll(e: &mut Engine, now: i64) -> Vec<Fire> {
    let mut v = Vec::new();
    e.poll(now, 2, &PosixTz::UTC, None, |f| v.push(f));
    v
}

/// Polls every 10 s over (from, to], as the loop task does (much more often).
fn run(e: &mut Engine, from: i64, to: i64) -> Vec<Fire> {
    let mut v = Vec::new();
    let mut t = from;
    while t < to {
        t = (t + 10).min(to);
        v.extend(poll(e, t));
    }
    v
}

fn ids(v: &[Fire]) -> Vec<(u8, bool)> {
    v.iter().map(|f| (f.slot.id, f.catch_up)).collect()
}

/// A lamp with: 07:00 on, 08:00 brightness, 09:00 effect, 12:00 trigger, 23:00 off.
fn lamp() -> Engine {
    let mut e = Engine::new();
    e.upsert(&rule(1, 7 * 60, power(true))).unwrap();
    e.upsert(&rule(
        2,
        8 * 60,
        Action::Brightness {
            level: 0.5,
            ramp_ms: 0,
        },
    ))
    .unwrap();
    e.upsert(&rule(
        3,
        9 * 60,
        Action::Effect {
            effect_id: Str::new("day").unwrap(),
            crossfade_ms: 3000,
        },
    ))
    .unwrap();
    e.upsert(&rule(
        4,
        12 * 60,
        Action::Trigger {
            name: Str::new("noon").unwrap(),
        },
    ))
    .unwrap();
    e.upsert(&rule(5, 23 * 60, power(false))).unwrap();
    e
}

#[test]
fn boot_applies_the_state_in_force() {
    let mut e = lamp();
    // Boot at 13:00: power on (07:00), brightness (08:00), effect (09:00); not the trigger.
    let v = poll(&mut e, utc(2026, 11, 25, 13, 0, 0));
    assert_eq!(ids(&v), [(1, true), (2, true), (3, true)]);
    assert_eq!(v[0].at_s, utc(2026, 11, 25, 7, 0, 0));
    // Nothing fires again on the next polls.
    assert!(poll(&mut e, utc(2026, 11, 25, 13, 0, 1)).is_empty());
    // Boot at 01:00: the latest power rule is yesterday's 23:00 off.
    let mut e = lamp();
    let v = poll(&mut e, utc(2026, 11, 25, 1, 0, 0));
    assert_eq!(ids(&v), [(2, true), (3, true), (5, true)]);
    assert_eq!(v[2].at_s, utc(2026, 11, 24, 23, 0, 0));
    assert_eq!(v[2].slot.kind, ActionKind::Power);
    assert!(!v[2].slot.on);
}

#[test]
fn fires_ahead_once_in_order() {
    let mut e = lamp();
    assert_eq!(poll(&mut e, utc(2026, 11, 25, 6, 0, 0)).len(), 3); // boot reconcile (yesterday's)
    assert!(poll(&mut e, utc(2026, 11, 25, 6, 59, 57)).is_empty());
    // Within the 2 s horizon: handed out ahead, with its due instant.
    let v = poll(&mut e, utc(2026, 11, 25, 6, 59, 58));
    assert_eq!(ids(&v), [(1, false)]);
    assert_eq!(v[0].at_s, utc(2026, 11, 25, 7, 0, 0));
    assert!(poll(&mut e, utc(2026, 11, 25, 6, 59, 59)).is_empty());
    assert!(poll(&mut e, utc(2026, 11, 25, 7, 0, 0)).is_empty());
    assert_eq!(e.find(1).unwrap().next(), Some(utc(2026, 11, 26, 7, 0, 0)));
    assert_eq!(e.next_fire(), Some((utc(2026, 11, 25, 8, 0, 0), 2)));
    // A day of polling: each rule once, ahead of time; the momentary trigger too.
    let v = run(
        &mut e,
        utc(2026, 11, 25, 7, 0, 0),
        utc(2026, 11, 26, 6, 0, 0),
    );
    assert_eq!(ids(&v), [(2, false), (3, false), (4, false), (5, false)]);
    assert!(v.iter().all(|f| f.at_s % 60 == 0));
}

#[test]
fn outages_reconcile_short_steps_fire_late() {
    // A 3 h outage (06:00 -> 09:30, a forward step): reconcile, the trigger isn't replayed.
    let mut e = lamp();
    poll(&mut e, utc(2026, 11, 25, 6, 0, 0));
    let v = poll(&mut e, utc(2026, 11, 25, 9, 30, 0));
    assert_eq!(ids(&v), [(1, true), (2, true), (3, true)]);
    // 30 h (to the next day 12:30): the latest of each kind, the noon trigger skipped.
    let v = poll(&mut e, utc(2026, 11, 26, 12, 30, 0));
    assert_eq!(ids(&v), [(1, true), (2, true), (3, true)]);
    assert!(v.iter().all(|f| f.at_s >= utc(2026, 11, 26, 0, 0, 0)));
    assert!(poll(&mut e, utc(2026, 11, 26, 12, 30, 1)).is_empty());
    // Another long step that missed nothing: no re-apply.
    let v = poll(&mut e, utc(2026, 11, 26, 22, 58, 0));
    assert!(v.is_empty());
    // A 5 min forward step over 23:00 fires it (late, not a catch-up).
    let v = poll(&mut e, utc(2026, 11, 26, 23, 3, 0));
    assert_eq!(ids(&v), [(5, false)]);
    assert_eq!(v[0].at_s, utc(2026, 11, 26, 23, 0, 0));
}

#[test]
fn a_backward_step_never_fires_twice() {
    let mut e = lamp();
    poll(&mut e, utc(2026, 11, 25, 6, 0, 0));
    assert_eq!(
        ids(&run(
            &mut e,
            utc(2026, 11, 25, 6, 0, 0),
            utc(2026, 11, 25, 7, 0, 0)
        )),
        [(1, false)]
    );
    // The clock steps back 5 min (a correction) and runs through 07:00 again.
    assert!(poll(&mut e, utc(2026, 11, 25, 6, 55, 0)).is_empty());
    assert!(run(
        &mut e,
        utc(2026, 11, 25, 6, 55, 0),
        utc(2026, 11, 25, 7, 1, 0)
    )
    .is_empty());
    assert_eq!(e.find(1).unwrap().next(), Some(utc(2026, 11, 26, 7, 0, 0)));
}

#[test]
fn edits_keep_the_last_fire_and_capacity_holds() {
    let mut e = lamp();
    poll(&mut e, utc(2026, 11, 25, 6, 0, 0));
    assert_eq!(
        ids(&run(
            &mut e,
            utc(2026, 11, 25, 6, 0, 0),
            utc(2026, 11, 25, 7, 0, 0)
        )),
        [(1, false)]
    );
    // Re-sending rule 1 unchanged doesn't fire it again today.
    e.upsert(&rule(1, 7 * 60, power(true))).unwrap();
    assert!(poll(&mut e, utc(2026, 11, 25, 7, 0, 1)).is_empty());
    // Moving it later today fires it at the new time.
    e.upsert(&rule(1, 7 * 60 + 5, power(true))).unwrap();
    assert_eq!(
        ids(&run(
            &mut e,
            utc(2026, 11, 25, 7, 0, 1),
            utc(2026, 11, 25, 7, 5, 0)
        )),
        [(1, false)]
    );
    // A disabled rule never fires (nor reconciles).
    let mut off = rule(1, 7 * 60 + 10, power(true));
    off.enabled = false;
    e.upsert(&off).unwrap();
    assert!(run(
        &mut e,
        utc(2026, 11, 25, 7, 5, 0),
        utc(2026, 11, 25, 7, 11, 0)
    )
    .is_empty());
    assert!(e.remove(1));
    assert!(!e.remove(1));
    assert_eq!(e.len(), 4);
    // Capacity.
    let mut f = Engine::new();
    for id in 1..=CAPACITY as u8 {
        f.upsert(&rule(id, id as u16, power(true))).unwrap();
    }
    assert!(f.upsert(&rule(200, 0, power(true))).is_err());
    assert!(
        f.upsert(&rule(3, 0, power(false))).is_ok(),
        "replacing works when full"
    );
    // Same-instant rules come out in id order; all 24 at once.
    let mut g = Engine::new();
    for id in (1..=CAPACITY as u8).rev() {
        g.upsert(&rule(
            id,
            600,
            Action::Trigger {
                name: Str::new("t").unwrap(),
            },
        ))
        .unwrap();
    }
    poll(&mut g, utc(2026, 11, 25, 9, 55, 0));
    let v = poll(&mut g, utc(2026, 11, 25, 10, 0, 0));
    assert_eq!(v.len(), CAPACITY);
    assert!(v.windows(2).all(|w| w[0].slot.id < w[1].slot.id));
}

#[test]
fn clock_lost_reconciles_again() {
    let mut e = lamp();
    poll(&mut e, utc(2026, 11, 25, 13, 0, 0));
    e.clock_lost();
    // Valid again a minute later: nothing was missed.
    assert!(poll(&mut e, utc(2026, 11, 25, 13, 1, 0)).is_empty());
    // Lost again, back at 23:30: the 23:00 off is the state in force.
    e.clock_lost();
    let v = poll(&mut e, utc(2026, 11, 25, 23, 30, 0));
    assert_eq!(ids(&v), [(5, true)]);
}
