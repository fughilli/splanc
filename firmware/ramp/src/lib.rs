//! Canned interpolation profiles (docs/design/ramps.md).
//!
//! When a client knows a uniform's (or the crossfade's) endpoint, the duration
//! and the ease, it sends ONE `ramp_uniforms` / `ramp_crossfade` and the device
//! interpolates per frame, instead of the agent/relay streaming dozens of
//! `set_uniforms` steps (which flooded the C6's wss queue and burned relay
//! traffic). Live control stays the direct path: a `set_uniforms` / OSC write on
//! a uniform cancels that uniform's ramp, a `set_crossfade` cancels the
//! crossfade ramp — last writer wins, nothing queues.
//!
//! `no_std`, zero-dependency, never allocates. Ramps are TIME based (device
//! clock ms, the `millis()` domain `set_time_base` uses), so the framerate
//! autoscaler (FUG-82) changing the frame rate never changes a ramp's duration,
//! and several fixtures given the same `start_at` (each in its own clock, from
//! the hub's clock sync) move in step. The ease is evaluated in Q16 fixed point
//! once per frame per RAMP (one request), then one lerp per ramped float — never
//! per LED.

#![no_std]

/// Concurrent ramped uniforms (lanes) across both decks. One request ramping
/// three uniforms takes three lanes; past the cap a request is refused
/// (`too_many_ramps`) rather than silently dropping a running ramp.
pub const MAX_LANES: usize = 16;
/// Floats per uniform (scalar .. vec4).
pub const MAX_WIDTH: usize = 4;
/// Longest ramp (1 h).
pub const MAX_DURATION_MS: u32 = 3_600_000;
/// Furthest a `start_at` may lie ahead of the device clock (10 min) — a guard
/// against a client passing a hub-clock time instead of the device's.
pub const MAX_LEAD_MS: i64 = 600_000;
/// Pending completion events (ramp_state pushes) held for the firmware loop.
pub const MAX_EVENTS: usize = 24;
/// 1.0 in Q16.
pub const Q16_ONE: u32 = 1 << 16;

/// The shape of a ramp over time. Wire values (`ease` fields) in brackets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Ease {
    /// [0] constant speed.
    Linear = 0,
    /// [1] "ease": cubic ease-in-out (slow start, fast middle, slow end).
    InOutCubic = 1,
    /// [2] cubic ease-in (slow start).
    InCubic = 2,
    /// [3] cubic ease-out (slow end).
    OutCubic = 3,
    /// [4] smoothstep 3t² − 2t³ (a gentler in-out; the keypoint morph's legacy
    /// curve).
    Smoothstep = 4,
}

impl Ease {
    /// The wire value → an ease; None for an unknown value.
    pub fn from_wire(v: u32) -> Option<Ease> {
        Some(match v {
            0 => Ease::Linear,
            1 => Ease::InOutCubic,
            2 => Ease::InCubic,
            3 => Ease::OutCubic,
            4 => Ease::Smoothstep,
            _ => return None,
        })
    }

    /// Reference (f64) curve, for tests and the host tools.
    pub fn eval_f64(self, t: f64) -> f64 {
        let t = t.clamp(0.0, 1.0);
        match self {
            Ease::Linear => t,
            Ease::InCubic => t * t * t,
            Ease::OutCubic => {
                let u = 1.0 - t;
                1.0 - u * u * u
            }
            Ease::InOutCubic => {
                if t < 0.5 {
                    4.0 * t * t * t
                } else {
                    let u = 2.0 - 2.0 * t;
                    1.0 - u * u * u / 2.0
                }
            }
            Ease::Smoothstep => t * t * (3.0 - 2.0 * t),
        }
    }
}

#[inline]
fn cube_q16(x: u32) -> u32 {
    // x ≤ 2^16 → x³ ≤ 2^48: fits u64; round to nearest on the way back to Q16.
    let x = x as u64;
    ((x * x * x + (1u64 << 31)) >> 32) as u32
}

/// The eased progress for `t` (Q16, clamped to 0..=1.0) — integer only (the C6
/// has no FPU). Exact at both ends; within 2/65536 of [`Ease::eval_f64`].
pub fn ease_q16(e: Ease, t: u32) -> u32 {
    let t = t.min(Q16_ONE);
    match e {
        Ease::Linear => t,
        Ease::InCubic => cube_q16(t),
        Ease::OutCubic => Q16_ONE - cube_q16(Q16_ONE - t),
        Ease::InOutCubic => {
            if t < Q16_ONE / 2 {
                4 * cube_q16(t)
            } else {
                // 1 − (2 − 2t)³ / 2, with u = 2 − 2t ≤ 1.0.
                let u = 2 * (Q16_ONE - t);
                Q16_ONE - (cube_q16(u) + 1) / 2
            }
        }
        Ease::Smoothstep => {
            // t²(3 − 2t) in one product (≤ 3·2^48), rounded once: monotonic.
            let t64 = t as u64;
            ((t64 * t64 * (3 * Q16_ONE as u64 - 2 * t64) + (1u64 << 31)) >> 32) as u32
        }
    }
}

/// Linear progress through a ramp (Q16): 0 before / at the start, 1.0 at or past
/// the end (a zero-length ramp is a jump: 1.0 from its start on).
pub fn progress_q16(elapsed_ms: i64, dur_ms: u32) -> u32 {
    if elapsed_ms >= dur_ms as i64 {
        Q16_ONE
    } else if elapsed_ms <= 0 {
        0
    } else {
        (((elapsed_ms as u64) << 16) / dur_ms as u64) as u32
    }
}

/// When a ramp runs, in the device clock.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Schedule {
    pub start_ms: i64,
    pub dur_ms: u32,
    pub ease: Ease,
}

impl Schedule {
    /// Resolve a request's timing against the device clock `now_ms`: a
    /// `start_at_ms` ≤ 0 means "on receipt"; one in the past is honoured (the
    /// ramp joins mid-way — a fixture that got the request late still lands in
    /// step with the others).
    pub fn resolve(now_ms: i64, start_at_ms: i64, dur_ms: u32, ease: u32) -> Result<Schedule, RampError> {
        let ease = Ease::from_wire(ease).ok_or(RampError::BadEase)?;
        if dur_ms > MAX_DURATION_MS {
            return Err(RampError::TooLong);
        }
        let start_ms = if start_at_ms <= 0 { now_ms } else { start_at_ms };
        if start_ms - now_ms > MAX_LEAD_MS {
            return Err(RampError::TooFarAhead);
        }
        Ok(Schedule { start_ms, dur_ms, ease })
    }

    pub fn end_ms(&self) -> i64 {
        self.start_ms + self.dur_ms as i64
    }

    /// Eased progress at `now_ms` (Q16), or None while the ramp hasn't started.
    /// Exactly 1.0 only once the duration has elapsed (an ease that rounds to
    /// 1.0 a frame early doesn't end the ramp early).
    pub fn at(&self, now_ms: i64) -> Option<u32> {
        let el = now_ms - self.start_ms;
        if el < 0 {
            return None;
        }
        let p = progress_q16(el, self.dur_ms);
        let e = ease_q16(self.ease, p);
        Some(if p < Q16_ONE { e.min(Q16_ONE - 1) } else { Q16_ONE })
    }
}

/// Why a ramp request was refused (the wire error `code` in brackets).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RampError {
    /// [bad_ramp] unknown `ease` value.
    BadEase,
    /// [bad_ramp] `duration_ms` past [`MAX_DURATION_MS`].
    TooLong,
    /// [bad_ramp] `start_at_ms` more than [`MAX_LEAD_MS`] ahead.
    TooFarAhead,
    /// [bad_ramp] no targets.
    NoTargets,
    /// [bad_ramp] a target with width 0 / > 4, or the same slot twice.
    BadTarget,
    /// [too_many_ramps] not enough free lanes (see [`MAX_LANES`]).
    TooMany,
}

impl RampError {
    pub fn code(self) -> &'static str {
        match self {
            RampError::TooMany => "too_many_ramps",
            _ => "bad_ramp",
        }
    }

    pub fn message(self) -> &'static str {
        match self {
            RampError::BadEase => "unknown ease (0 linear, 1 ease, 2 ease_in, 3 ease_out, 4 smoothstep)",
            RampError::TooLong => "duration_ms is longer than 1 hour",
            RampError::TooFarAhead => "start_at_ms is more than 10 minutes ahead of the device clock",
            RampError::NoTargets => "no targets",
            RampError::BadTarget => "a target has 0 or more than 4 values, an unknown slot, or repeats a slot",
            RampError::TooMany => "too many concurrent ramps (16 ramped uniforms max)",
        }
    }
}

/// What a ramp moves (RampState.kind on the wire).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Kind {
    Uniforms = 0,
    Crossfade = 1,
    Keypoints = 2,
}

/// How a ramp ended (RampState.state on the wire; 0 = started is the ack).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum End {
    /// Reached its target.
    Done = 1,
    /// Overridden before it got there (a live set, a newer ramp on the same
    /// uniform, cancel_ramp, an effect change on the deck).
    Cancelled = 2,
}

/// A completion event for the client (`ramp_state` push). Only ramps with a
/// non-zero id report.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Event {
    pub id: u32,
    pub kind: Kind,
    pub end: End,
}

/// One requested uniform: slot, its current value (`from`) and target, `width`
/// floats each. `discrete` (a toggle / dropdown): no in-between values — it
/// holds until the ramp lands, then takes the target.
#[derive(Clone, Copy, Debug)]
pub struct Target {
    pub slot: u16,
    pub width: u8,
    pub discrete: bool,
    pub from: [f32; MAX_WIDTH],
    pub to: [f32; MAX_WIDTH],
}

#[derive(Clone, Copy)]
struct Lane {
    live: bool,
    discrete: bool,
    group: u8,
    deck: u8,
    width: u8,
    slot: u16,
    from: [f32; MAX_WIDTH],
    to: [f32; MAX_WIDTH],
}

const LANE0: Lane = Lane {
    live: false,
    discrete: false,
    group: 0,
    deck: 0,
    width: 0,
    slot: 0,
    from: [0.0; 4],
    to: [0.0; 4],
};

/// One request's shared timing + bookkeeping (its lanes point at it).
#[derive(Clone, Copy)]
struct Group {
    live: bool,
    id: u32,
    deck: u8,
    lanes: u8,
    cancelled: bool,
    commit: bool,
    sched: Schedule,
}

const SCHED0: Schedule = Schedule {
    start_ms: 0,
    dur_ms: 0,
    ease: Ease::Linear,
};
const GROUP0: Group = Group {
    live: false,
    id: 0,
    deck: 0,
    lanes: 0,
    cancelled: false,
    commit: false,
    sched: SCHED0,
};

#[derive(Clone, Copy)]
struct Xf {
    live: bool,
    id: u32,
    from: f32,
    to: f32,
    mode: u32,
    sched: Schedule,
}

/// Every running ramp on the device: up to [`MAX_LANES`] ramped uniforms over
/// both decks, plus one crossfade ramp. ~1.3 KB, all-zero-initialisable.
pub struct Engine {
    lanes: [Lane; MAX_LANES],
    groups: [Group; MAX_LANES],
    xf: Xf,
    events: [Event; MAX_EVENTS],
    ev_head: u8,
    ev_len: u8,
    /// Events lost to a full queue (a client that never drains them).
    pub events_dropped: u32,
    /// A committed deck-A uniform ramp landed: persist the deck's uniforms.
    commit_pending: bool,
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}

impl Engine {
    pub const fn new() -> Self {
        Engine {
            lanes: [LANE0; MAX_LANES],
            groups: [GROUP0; MAX_LANES],
            xf: Xf {
                live: false,
                id: 0,
                from: 0.0,
                to: 0.0,
                mode: 0,
                sched: SCHED0,
            },
            events: [Event {
                id: 0,
                kind: Kind::Uniforms,
                end: End::Done,
            }; MAX_EVENTS],
            ev_head: 0,
            ev_len: 0,
            events_dropped: 0,
            commit_pending: false,
        }
    }

    /// Ramped uniforms in flight (lanes in use).
    pub fn active_lanes(&self) -> usize {
        self.lanes.iter().filter(|l| l.live).count()
    }

    /// Whether a crossfade ramp is in flight.
    pub fn crossfade_active(&self) -> bool {
        self.xf.live
    }

    /// Whether anything at all is ramping (so the render loop can skip the tick).
    pub fn idle(&self) -> bool {
        !self.xf.live && !self.groups.iter().any(|g| g.live)
    }

    /// Whether `(deck, slot)` is being ramped.
    pub fn ramping(&self, deck: u8, slot: u16) -> bool {
        self.lanes.iter().any(|l| l.live && l.deck == deck && l.slot == slot)
    }

    /// Queue a completion event (id 0 never reports). Also used by the keypoint
    /// morph, which keeps its own state but shares this queue.
    pub fn push_event(&mut self, id: u32, kind: Kind, end: End) {
        if id == 0 {
            return;
        }
        if self.ev_len as usize == MAX_EVENTS {
            // Drop the oldest: the newest outcome is the one a client acts on.
            self.ev_head = ((self.ev_head as usize + 1) % MAX_EVENTS) as u8;
            self.ev_len -= 1;
            self.events_dropped = self.events_dropped.wrapping_add(1);
        }
        let at = (self.ev_head as usize + self.ev_len as usize) % MAX_EVENTS;
        self.events[at] = Event { id, kind, end };
        self.ev_len += 1;
    }

    /// The oldest pending completion event.
    pub fn take_event(&mut self) -> Option<Event> {
        if self.ev_len == 0 {
            return None;
        }
        let e = self.events[self.ev_head as usize];
        self.ev_head = ((self.ev_head as usize + 1) % MAX_EVENTS) as u8;
        self.ev_len -= 1;
        Some(e)
    }

    /// Whether a committed deck-A uniform ramp has landed since the last call
    /// (the firmware then persists the deck's uniforms, like a set_uniforms).
    pub fn take_commit(&mut self) -> bool {
        core::mem::replace(&mut self.commit_pending, false)
    }

    fn close_group(&mut self, g: usize) {
        let grp = &mut self.groups[g];
        grp.live = false;
        let (id, end) = (grp.id, if grp.cancelled { End::Cancelled } else { End::Done });
        if !grp.cancelled && grp.commit && grp.deck == 0 {
            self.commit_pending = true;
        }
        self.push_event(id, Kind::Uniforms, end);
    }

    fn cancel_lane(&mut self, i: usize) {
        let l = &mut self.lanes[i];
        if !l.live {
            return;
        }
        l.live = false;
        let g = l.group as usize;
        self.groups[g].cancelled = true;
        self.groups[g].lanes -= 1;
        if self.groups[g].lanes == 0 {
            self.close_group(g);
        }
    }

    /// Start ramping `targets` on `deck`. A uniform already ramping is taken over
    /// (its old ramp reports cancelled). All-or-nothing: on error nothing changed.
    /// `commit`: persist deck A's uniforms when it lands (like set_uniforms'
    /// commit; deck B is never persisted).
    pub fn start_uniforms(
        &mut self,
        id: u32,
        deck: u8,
        targets: &[Target],
        sched: Schedule,
        commit: bool,
    ) -> Result<(), RampError> {
        if targets.is_empty() {
            return Err(RampError::NoTargets);
        }
        if targets.len() > MAX_LANES {
            return Err(RampError::TooMany);
        }
        for (i, t) in targets.iter().enumerate() {
            if t.width == 0 || t.width as usize > MAX_WIDTH || targets[..i].iter().any(|u| u.slot == t.slot) {
                return Err(RampError::BadTarget);
            }
        }
        let taken_over = self
            .lanes
            .iter()
            .filter(|l| l.live && l.deck == deck && targets.iter().any(|t| t.slot == l.slot))
            .count();
        let free = MAX_LANES - self.active_lanes() + taken_over;
        if free < targets.len() {
            return Err(RampError::TooMany);
        }
        // Take over: the old ramps on these uniforms stop (last writer wins).
        for i in 0..MAX_LANES {
            let l = self.lanes[i];
            if l.live && l.deck == deck && targets.iter().any(|t| t.slot == l.slot) {
                self.cancel_lane(i);
            }
        }
        // A live group always holds ≥ 1 lane, so with a lane free a group is too.
        let g = self.groups.iter().position(|g| !g.live).ok_or(RampError::TooMany)?;
        self.groups[g] = Group {
            live: true,
            id,
            deck,
            lanes: targets.len() as u8,
            cancelled: false,
            commit,
            sched,
        };
        let mut lanes = self.lanes.iter_mut().filter(|l| !l.live);
        for t in targets {
            let l = lanes.next().ok_or(RampError::TooMany)?; // counted above
            *l = Lane {
                live: true,
                discrete: t.discrete,
                group: g as u8,
                deck,
                width: t.width,
                slot: t.slot,
                from: t.from,
                to: t.to,
            };
        }
        Ok(())
    }

    /// Start the crossfade ramp from `from` to `to` (0..1) in colour `mode`. A
    /// running one is taken over (reports cancelled).
    pub fn start_crossfade(&mut self, id: u32, from: f32, to: f32, mode: u32, sched: Schedule) {
        self.cancel_crossfade();
        self.xf = Xf {
            live: true,
            id,
            from,
            to,
            mode,
            sched,
        };
    }

    /// A live write on `(deck, slot)` (set_uniforms, OSC): its ramp stops where
    /// it is. True when one was running.
    pub fn cancel_slot(&mut self, deck: u8, slot: u16) -> bool {
        let mut hit = false;
        for i in 0..MAX_LANES {
            let l = self.lanes[i];
            if l.live && l.deck == deck && l.slot == slot {
                self.cancel_lane(i);
                hit = true;
            }
        }
        hit
    }

    /// The deck's effect changed (load / clear) or a keypoint blend took the
    /// whole deck over: every uniform ramp on it stops.
    pub fn cancel_deck(&mut self, deck: u8) {
        for i in 0..MAX_LANES {
            if self.lanes[i].live && self.lanes[i].deck == deck {
                self.cancel_lane(i);
            }
        }
    }

    /// A live set_crossfade: the crossfade ramp stops where it is.
    pub fn cancel_crossfade(&mut self) -> bool {
        if !self.xf.live {
            return false;
        }
        self.xf.live = false;
        self.push_event(self.xf.id, Kind::Crossfade, End::Cancelled);
        true
    }

    /// cancel_ramp: stop the ramp(s) with `id` (0 = every ramp). Returns how many
    /// requests stopped.
    pub fn cancel_id(&mut self, id: u32) -> usize {
        let mut n = 0;
        for g in 0..MAX_LANES {
            if self.groups[g].live && (id == 0 || self.groups[g].id == id) {
                n += 1;
                for i in 0..MAX_LANES {
                    if self.lanes[i].live && self.lanes[i].group as usize == g {
                        self.cancel_lane(i);
                    }
                }
            }
        }
        if self.xf.live && (id == 0 || self.xf.id == id) {
            self.cancel_crossfade();
            n += 1;
        }
        n
    }

    /// Advance every ramp to `now_ms`: hand each ramped uniform's value for this
    /// frame to `write(deck, slot, values)` and the crossfade's to
    /// `crossfade(position, mode)`. The last frame of a ramp writes its target
    /// exactly. Ramps not yet at their `start_at` hold (write nothing). Returns
    /// the number of writes (uniforms + the crossfade; the per-frame cost driver).
    pub fn tick(
        &mut self,
        now_ms: i64,
        mut write: impl FnMut(u8, u16, &[f32]),
        mut crossfade: impl FnMut(f32, u32),
    ) -> u32 {
        let mut written = 0;
        if self.xf.live {
            if let Some(e) = self.xf.sched.at(now_ms) {
                written += 1;
                if e >= Q16_ONE {
                    crossfade(self.xf.to, self.xf.mode);
                    self.xf.live = false;
                    self.push_event(self.xf.id, Kind::Crossfade, End::Done);
                } else {
                    let f = e as f32 * (1.0 / Q16_ONE as f32);
                    crossfade(self.xf.from + (self.xf.to - self.xf.from) * f, self.xf.mode);
                }
            }
        }
        // Eased progress once per request (group), then one lerp per float.
        let mut eased = [u32::MAX; MAX_LANES]; // MAX = not started / not live
        let mut any = false;
        for (g, grp) in self.groups.iter().enumerate() {
            if grp.live {
                if let Some(e) = grp.sched.at(now_ms) {
                    eased[g] = e;
                    any = true;
                }
            }
        }
        if !any {
            return 0;
        }
        for i in 0..MAX_LANES {
            let l = self.lanes[i];
            if !l.live {
                continue;
            }
            let g = l.group as usize;
            let e = eased[g];
            if e == u32::MAX {
                continue;
            }
            let w = l.width as usize;
            if e >= Q16_ONE {
                write(l.deck, l.slot, &l.to[..w]);
                self.lanes[i].live = false;
                self.groups[g].lanes -= 1;
                if self.groups[g].lanes == 0 {
                    self.close_group(g);
                }
            } else if l.discrete {
                continue; // a toggle / dropdown holds until the ramp lands
            } else {
                let f = e as f32 * (1.0 / Q16_ONE as f32);
                let mut v = [0.0f32; MAX_WIDTH];
                for ((x, a), b) in v.iter_mut().zip(&l.from).zip(&l.to).take(w) {
                    *x = a + (b - a) * f;
                }
                write(l.deck, l.slot, &v[..w]);
            }
            written += 1;
        }
        written
    }
}
