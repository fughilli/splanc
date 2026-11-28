//! The firing engine: a compact table of the rules (no names: the firmware
//! keeps those on flash), the next fire of each, and the rules for boot,
//! catch-up and clock steps.
//!
//! - **Firing.** [`Engine::poll`] runs on the loop task. A rule whose next fire
//!   is at or before `now + horizon` is handed out ONCE as a [`Fire`] (its due
//!   instant may still be ahead: the firmware stages the action and queues it
//!   for that instant, so every lamp changes on the same frame).
//! - **Boot and late clocks (D-566).** The first poll with a valid clock, and a
//!   forward clock step of [`STEP_RECONCILE_S`] or more, *reconcile*: the state
//!   in force now is applied (the latest past power, brightness and effect rule
//!   within a week, like a thermostat), and momentary trigger rules are not
//!   replayed.
//! - **Clock steps.** A forward step shorter than that fires what it stepped
//!   over (late, at once). A backward step never fires a rule twice: each rule
//!   remembers the instant it last fired.
//! - Edits keep a rule's last fire (by id), so re-sending a rule doesn't fire it again.

use ledmapper_clock::local::LocalOffset;

use crate::next::{next_fire, prev_fire};
use crate::rule::{Action, ActionKind, Rule, When};
use crate::sun::Location;

/// Rules per lamp.
pub const CAPACITY: usize = 24;
/// A forward clock step at least this long reconciles instead of firing what it skipped, s.
pub const STEP_RECONCILE_S: i64 = 600;

/// The compact per-rule state (~28 bytes): everything but the label and names.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Slot {
    pub id: u8,
    pub enabled: bool,
    pub when: When,
    pub kind: ActionKind,
    /// Power: on. Unused otherwise.
    pub on: bool,
    /// Brightness: the level (0..1).
    pub level: f32,
    /// Power: duration; brightness: ramp; effect: crossfade (ms).
    pub ms: u32,
    /// The instant it last fired (UTC s), 0 = never.
    pub last_fired_s: u32,
    /// The next fire (UTC s): 0 = not computed yet, u32::MAX = none within a week.
    pub next_s: u32,
}

const NONE_YET: u32 = 0;
const NEVER: u32 = u32::MAX;

impl Slot {
    pub fn of(rule: &Rule) -> Slot {
        let (on, level, ms) = match rule.action {
            Action::Power { on, duration_ms } => (on, 0.0, duration_ms),
            Action::Brightness { level, ramp_ms } => (false, level, ramp_ms),
            Action::Effect { crossfade_ms, .. } => (false, 0.0, crossfade_ms),
            Action::Trigger { .. } | Action::None => (false, 0.0, 0),
        };
        Slot {
            id: rule.id,
            enabled: rule.enabled,
            when: rule.when,
            kind: rule.action.kind(),
            on,
            level,
            ms,
            last_fired_s: 0,
            next_s: NONE_YET,
        }
    }

    fn live(&self) -> bool {
        self.enabled && self.kind != ActionKind::None
    }

    /// The next fire, None when there is none within a week (or not computed).
    pub fn next(&self) -> Option<i64> {
        match self.next_s {
            NONE_YET | NEVER => None,
            s => Some(s as i64),
        }
    }
}

/// One rule handed out by [`Engine::poll`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fire {
    pub slot: Slot,
    /// The instant it is due (UTC s): ahead (stage it), or past (apply it now).
    pub at_s: i64,
    /// A reconciliation (the state in force), not a scheduled fire.
    pub catch_up: bool,
}

/// The table is full (or the id is 0).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Full;

fn to_u32(s: i64) -> u32 {
    s.clamp(1, NEVER as i64 - 1) as u32
}

/// The rule table and its clock.
pub struct Engine {
    slots: [Slot; CAPACITY],
    n: usize,
    last_poll_s: Option<i64>,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub const fn new() -> Self {
        const EMPTY: Slot = Slot {
            id: 0,
            enabled: false,
            when: When::local(0, 0),
            kind: ActionKind::None,
            on: false,
            level: 0.0,
            ms: 0,
            last_fired_s: 0,
            next_s: NONE_YET,
        };
        Engine {
            slots: [EMPTY; CAPACITY],
            n: 0,
            last_poll_s: None,
        }
    }

    pub fn slots(&self) -> &[Slot] {
        &self.slots[..self.n]
    }

    pub fn len(&self) -> usize {
        self.n
    }

    pub fn is_empty(&self) -> bool {
        self.n == 0
    }

    pub fn find(&self, id: u8) -> Option<&Slot> {
        self.slots().iter().find(|s| s.id == id)
    }

    /// Adds or replaces (by id) a rule. A replaced rule keeps its last fire.
    pub fn upsert(&mut self, rule: &Rule) -> Result<(), Full> {
        if rule.id == 0 {
            return Err(Full);
        }
        let mut s = Slot::of(rule);
        match self.slots[..self.n].iter().position(|x| x.id == rule.id) {
            Some(i) => {
                s.last_fired_s = self.slots[i].last_fired_s;
                self.slots[i] = s;
            }
            None if self.n < CAPACITY => {
                self.slots[self.n] = s;
                self.n += 1;
            }
            None => return Err(Full),
        }
        Ok(())
    }

    /// Removes rule `id`; false when there is none.
    pub fn remove(&mut self, id: u8) -> bool {
        let Some(i) = self.slots[..self.n].iter().position(|x| x.id == id) else {
            return false;
        };
        self.slots.copy_within(i + 1..self.n, i);
        self.n -= 1;
        true
    }

    pub fn clear(&mut self) {
        self.n = 0;
    }

    /// The zone or the location changed: every next fire is recomputed at the
    /// next poll (last fires are kept, so nothing fires twice).
    pub fn times_changed(&mut self) {
        for s in &mut self.slots[..self.n] {
            s.next_s = NONE_YET;
        }
    }

    /// The clock became invalid: the next valid poll reconciles (as at boot).
    pub fn clock_lost(&mut self) {
        self.last_poll_s = None;
        self.times_changed();
    }

    /// The earliest next fire (UTC s) and its rule id.
    pub fn next_fire(&self) -> Option<(i64, u8)> {
        self.slots()
            .iter()
            .filter(|s| s.live())
            .filter_map(|s| s.next().map(|t| (t, s.id)))
            .min()
    }

    /// Advance to `now_s` (UTC s, a valid clock) and hand every rule due by
    /// `now_s + horizon_s` to `fire`, in due order. Reconciles first when this is
    /// the first valid poll or the clock stepped forward by [`STEP_RECONCILE_S`].
    pub fn poll<Z: LocalOffset + ?Sized>(
        &mut self,
        now_s: i64,
        horizon_s: i64,
        zone: &Z,
        loc: Option<Location>,
        mut fire: impl FnMut(Fire),
    ) {
        let mut out = [None::<Fire>; CAPACITY + 3];
        let mut k = 0usize;
        match self.last_poll_s {
            None => k = self.reconcile(now_s, zone, loc, &mut out),
            Some(p) if now_s - p >= STEP_RECONCILE_S => {
                k = self.reconcile(now_s, zone, loc, &mut out)
            }
            Some(p) if now_s < p => {
                // Backward: nothing fires twice; recompute from now (or the last fire).
                for s in &mut self.slots[..self.n] {
                    s.next_s = NONE_YET;
                }
            }
            _ => {}
        }
        self.last_poll_s = Some(now_s);
        for s in &mut self.slots[..self.n] {
            if !s.live() {
                continue;
            }
            if s.next_s == NONE_YET {
                let after = (now_s - 1).max(s.last_fired_s as i64);
                s.next_s = next_fire(&s.when, after, zone, loc).map_or(NEVER, to_u32);
            }
            // At most twice per rule per poll (bounded even for a bad zone).
            for _ in 0..2 {
                let Some(t) = s.next() else { break };
                if t > now_s + horizon_s || k >= out.len() {
                    break;
                }
                out[k] = Some(Fire {
                    slot: *s,
                    at_s: t,
                    catch_up: false,
                });
                k += 1;
                s.last_fired_s = to_u32(t);
                s.next_s = next_fire(&s.when, t.max(now_s - 1), zone, loc).map_or(NEVER, to_u32);
            }
        }
        // Due order (ties: catch-ups first, then by id). An insertion sort: at most 27
        // entries, and no recursion (core's sort recurses; the firmware bounds its stacks).
        let fires = &mut out[..k];
        let key = |f: &Option<Fire>| f.map(|f| (f.at_s, !f.catch_up, f.slot.id));
        for i in 1..fires.len() {
            let mut j = i;
            while j > 0 && key(&fires[j - 1]) > key(&fires[j]) {
                fires.swap(j - 1, j);
                j -= 1;
            }
        }
        for f in fires.iter().flatten() {
            fire(*f);
        }
    }

    /// The state in force at `now_s`: per state kind the latest past fire of
    /// an enabled rule, when it is newer than what that rule last fired (after
    /// a boot every rule's last fire is unknown). Every rule's last fire moves up
    /// to its latest past fire and its next fire is recomputed after now.
    fn reconcile<Z: LocalOffset + ?Sized>(
        &mut self,
        now_s: i64,
        zone: &Z,
        loc: Option<Location>,
        out: &mut [Option<Fire>],
    ) -> usize {
        let mut best: [Option<(i64, usize)>; 3] = [None; 3];
        for (i, s) in self.slots[..self.n].iter_mut().enumerate() {
            s.next_s = NONE_YET;
            if !s.live() {
                continue;
            }
            let Some(t) = prev_fire(&s.when, now_s, zone, loc) else {
                continue;
            };
            // Already applied (a forward step that missed nothing): no re-apply.
            if to_u32(t) <= s.last_fired_s {
                continue;
            }
            s.last_fired_s = to_u32(t);
            let cat = match s.kind {
                ActionKind::Power => 0,
                ActionKind::Brightness => 1,
                ActionKind::Effect => 2,
                _ => continue,
            };
            if best[cat].is_none_or(|(bt, _)| t > bt) {
                best[cat] = Some((t, i));
            }
        }
        let mut k = 0;
        for (t, i) in best.into_iter().flatten() {
            out[k] = Some(Fire {
                slot: self.slots[i],
                at_s: t,
                catch_up: true,
            });
            k += 1;
        }
        k
    }
}
