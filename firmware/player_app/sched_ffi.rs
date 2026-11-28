//! Wall-clock schedules on the player (docs/design/schedule.md): the rule table,
//! the set_schedule / delete_schedule / get_schedule arms, the lamp's location
//! for sunrise / sunset rules, and the on-device actions they fire.
//!
//! - **Where the rules live.** `/lfs/sched.pb` (a `repeated ScheduleRule rules =
//!   1` file, the `//firmware/schedule` wire form), written by main.cpp with the
//!   atomic temp + fsync + rename path, only on edit. RAM holds the compact
//!   [`Engine`] table (no labels or names, ~28 B a rule). main.cpp reads the
//!   file and hands it in; every function here is a pure transformation under
//!   the player mutex, so flash I/O never happens with the mutex held.
//! - **Firing (loop task).** [`lm_sched_tick`] polls the engine with a 2 s
//!   horizon; each rule it hands out is converted to a device due time
//!   (`millis()` domain: now + (fire − wall now)) and queued in the scheduled
//!   apply queue as an internal frame (first byte [`INTERNAL`]), which the
//!   render task applies at that frame boundary (`sched_apply_frame`). Rules
//!   that need flash (a stored effect, a trigger's name) are staged first:
//!   main.cpp reads the file / the stored effect record on the loop task and
//!   the effect loads onto the hidden deck before its due time.
//! - **Actions.** Power through the power machine (`SOURCE_SCHEDULE`); a
//!   brightness ramp and a timed crossfade advanced per frame by render
//!   ([`ramps_frame`], a few float ops); a stored effect loaded onto the deck
//!   that is NOT showing, then crossfaded to (effects keep running: a switch
//!   never blanks); a trigger bumps a uniform-pool counter.
//! - **Live shows (D-567).** A rule is skipped (and counted) while a live show
//!   holds the lamp: live-control traffic (seq'd set_uniforms / set_crossfade,
//!   OSC) in the last [`LIVE_HOLD_US`], or a `set_schedule{hold_s}` lease (the
//!   bridge's Show Mode lock).
//! - **Boot (D-566).** The first poll with a valid clock reconciles: the
//!   latest power / brightness / effect rule in force is applied now.
//!
//! Render never touches the engine or the clock: its share is the queued
//! frames and the two ramps.

use core::ptr::{addr_of, addr_of_mut};

use ledmapper_schedule::{rule_bodies, ActionKind, Engine, Fire, Location, Rule, Writer, CAPACITY};

use super::{
    client_arm, clock_ffi, deck, effect_store, note_xf_toward, player, power_ffi,
    sched_apply_frame, submit_effect_view, uniform_pool, write_arm, CArm, PbOut, DECK_A_IDX,
    DECK_B_IDX, SCHED,
};

/// ClientMessage arms.
pub const ARM_SET_SCHEDULE: u32 = 114;
pub const ARM_DELETE_SCHEDULE: u32 = 115;
pub const ARM_GET_SCHEDULE: u32 = 116;
/// ServerMessage.schedule_state.
const SRV_SCHEDULE_STATE: u32 = 62;

/// The first byte of an internal scheduled frame (never a ClientMessage: field
/// 31 with wire type 7 is invalid protobuf).
pub const INTERNAL: u8 = 0xff;
const K_POWER: u8 = 1;
const K_BRIGHT: u8 = 2;
const K_XFADE: u8 = 3;
const K_TRIGGER: u8 = 4;

/// The largest rules file: 24 rules of at most ~120 bytes.
pub const FILE_CAP: usize = 3072;
/// Rules per get_schedule page.
const PAGE: usize = 4;
/// Rules are handed out this far ahead of their instant, s.
const HORIZON_S: i64 = 2;
/// The engine is polled this often, ms.
const POLL_MS: i64 = 250;
/// Live-control traffic holds the schedule this long after the last of it, µs.
pub const LIVE_HOLD_US: i64 = 30_000_000;
/// The longest lease a set_schedule{hold_s} may take, s.
const MAX_HOLD_S: u32 = 3600;
/// The location record (NVS clk_loc): lat_e4, lon_e4 (i32 LE each).
pub const LOC_RECORD: usize = 8;

/// ScheduleResult.
pub const RES_OK: u8 = 0;
pub const RES_FULL: u8 = 1;
pub const RES_BAD_RULE: u8 = 2;
pub const RES_STORAGE: u8 = 3;
pub const RES_NOT_FOUND: u8 = 4;
/// ScheduleSkip.
pub const SKIP_LIVE: u8 = 1;
pub const SKIP_NO_EFFECT: u8 = 2;
pub const SKIP_BUSY: u8 = 3;

/// lm_sched_tick bits.
pub const TICK_NEED_FILE: u32 = 1;
pub const TICK_LOG: u32 = 2;
pub const TICK_LOC_CHANGED: u32 = 4;

static mut ENGINE: Engine = Engine::new();
static mut LOC: Option<Location> = None;
static mut LOC_GEN: u32 = 0;
static mut SEEN_LOC_GEN: u32 = 0;
static mut SEEN_TIMES: (u32, u32) = (0, 0);
static mut CLOCK_WAS_VALID: bool = false;
static mut LAST_POLL_MS: i64 = i64::MIN;
/// Raw esp_timer µs: the last live-control frame, and the end of a hold lease.
static mut LIVE_LAST_US: i64 = i64::MIN;
static mut HOLD_UNTIL_US: i64 = i64::MIN;
static mut FIRED: u32 = 0;
static mut SKIPPED: u32 = 0;
static mut LAST_FIRED_ID: u8 = 0;
static mut LAST_FIRED_UNIX_MS: i64 = 0;
static mut LAST_SKIPPED_ID: u8 = 0;
static mut LAST_SKIP: u8 = 0;

/// A rule waiting for main.cpp's file read (effect / trigger): id, device due ms,
/// a catch-up.
#[derive(Clone, Copy)]
struct Pending {
    id: u8,
    due_ms: i64,
    crossfade_ms: u32,
}
const PEND_N: usize = 4;
static mut PEND: [Option<Pending>; PEND_N] = [None; PEND_N];
/// The effect being staged: its due, crossfade and target deck (main.cpp loads it).
static mut STAGE: Option<(Pending, u8)> = None;

/// What render applied (rule id, device ms of the frame, its due) for the loop's log.
const APPLIED_N: usize = 4;
static mut APPLIED: [Option<(u8, i64, i64)>; APPLIED_N] = [None; APPLIED_N];
/// Loop-side log lines waiting ([`lm_sched_status_line`]): (id, what, value).
const NOTE_N: usize = 6;
static mut NOTES: [Option<(u8, u8, i64)>; NOTE_N] = [None; NOTE_N];
const NOTE_FIRE: u8 = 1;
const NOTE_SKIP: u8 = 2;

/// Render-side ramps: (from, to, start device ms, duration ms).
#[derive(Clone, Copy)]
struct Ramp {
    from: f32,
    to: f32,
    start: i64,
    ms: u32,
    /// The value this ramp last wrote (someone else moving it cancels the ramp).
    last: f32,
}
static mut RAMP_BRIGHT: Option<Ramp> = None;
static mut RAMP_XF: Option<Ramp> = None;

unsafe fn engine() -> &'static mut Engine {
    &mut *addr_of_mut!(ENGINE)
}

// -- location -------------------------------------------------------------------

pub(crate) unsafe fn location() -> Option<Location> {
    *addr_of!(LOC)
}

pub(crate) unsafe fn set_location(l: Option<Location>) {
    if *addr_of!(LOC) != l {
        LOC = l;
        LOC_GEN = LOC_GEN.wrapping_add(1);
    }
}

/// The location record to persist (NVS clk_loc); 0 bytes = none.
///
/// # Safety
/// `out` writable for [`LOC_RECORD`] bytes. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_sched_loc_record(out: *mut u8) -> usize {
    let Some(l) = location() else { return 0 };
    let o = core::slice::from_raw_parts_mut(out, LOC_RECORD);
    o[..4].copy_from_slice(&l.lat_e4.to_le_bytes());
    o[4..].copy_from_slice(&l.lon_e4.to_le_bytes());
    LOC_RECORD
}

// -- live shows (D-567) ------------------------------------------------------------

/// A live-control frame or OSC datagram arrived (loop task).
pub(crate) unsafe fn note_live() {
    LIVE_LAST_US = clock_ffi::raw_mono_us();
}

unsafe fn live_now() -> bool {
    let now = clock_ffi::raw_mono_us();
    let recent =
        LIVE_LAST_US != i64::MIN && (0..LIVE_HOLD_US).contains(&now.saturating_sub(LIVE_LAST_US));
    recent || (HOLD_UNTIL_US != i64::MIN && now < HOLD_UNTIL_US)
}

unsafe fn hold_left_s() -> u32 {
    if HOLD_UNTIL_US == i64::MIN {
        return 0;
    }
    let left = HOLD_UNTIL_US.saturating_sub(clock_ffi::raw_mono_us());
    if left <= 0 {
        0
    } else {
        (left / 1_000_000 + 1) as u32
    }
}

// -- the rules file ----------------------------------------------------------------

/// Boot: build the table from the rules file and restore the location record.
/// Returns the rules loaded.
///
/// # Safety
/// The pointers readable for their lengths (or null). Loop task (setup).
#[no_mangle]
pub unsafe extern "C" fn lm_sched_boot(
    file: *const u8,
    len: usize,
    loc: *const u8,
    loc_len: usize,
) -> u32 {
    if !loc.is_null() && loc_len == LOC_RECORD {
        let r = core::slice::from_raw_parts(loc, LOC_RECORD);
        let lat = i32::from_le_bytes([r[0], r[1], r[2], r[3]]);
        let lon = i32::from_le_bytes([r[4], r[5], r[6], r[7]]);
        LOC = Location::new(lat, lon);
        SEEN_LOC_GEN = LOC_GEN;
    }
    engine().clear();
    if file.is_null() || len == 0 {
        return 0;
    }
    for body in rule_bodies(core::slice::from_raw_parts(file, len)) {
        if let Ok(r) = Rule::decode(body) {
            let _ = engine().upsert(&r);
        }
    }
    engine().len() as u32
}

/// Writes a `rules = 1` entry with `body`.
fn put_rule(w: &mut Writer, body: &[u8]) {
    w.bytes(1, body);
}

/// The id of a rule body (0 when unreadable).
fn body_id(b: &[u8]) -> u8 {
    Rule::decode(b).map_or(0, |r| r.id)
}

/// Applies a set_schedule to the rules `file` (into `new_file`) and the table.
/// Returns (result, new file length or None when unchanged).
unsafe fn apply_set(frame: &[u8], file: &[u8], new_file: &mut [u8]) -> (u8, Option<usize>) {
    let Some(CArm::SetSchedule(m)) = client_arm(frame) else {
        return (RES_BAD_RULE, None);
    };
    if m.release_hold() {
        HOLD_UNTIL_US = i64::MIN;
    }
    if m.hold_s() > 0 {
        let s = m.hold_s().min(MAX_HOLD_S) as i64;
        HOLD_UNTIL_US = clock_ffi::raw_mono_us().saturating_add(s * 1_000_000);
    }
    let replace = m.replace_all();
    // All or nothing: decode every rule first.
    let mut new: [Option<Rule>; 4] = [None; 4];
    let mut k = 0;
    for v in m.rules() {
        if k == new.len() {
            return (RES_BAD_RULE, None);
        }
        match Rule::decode(v.as_bytes()) {
            Ok(r) => new[k] = Some(r),
            Err(_) => return (RES_BAD_RULE, None),
        }
        k += 1;
    }
    let new = &new[..k];
    if k == 0 && !replace {
        return (RES_OK, None);
    }
    let ids = |id: u8| new.iter().flatten().any(|r| r.id == id);
    // Count the result.
    let kept = if replace {
        0
    } else {
        rule_bodies(file).filter(|b| !ids(body_id(b))).count()
    };
    if kept + k > CAPACITY {
        return (RES_FULL, None);
    }
    let mut w = Writer::new(new_file);
    if !replace {
        for b in rule_bodies(file) {
            let id = body_id(b);
            if id == 0 || ids(id) {
                continue;
            }
            put_rule(&mut w, b);
        }
    }
    let mut body = [0u8; 160];
    for r in new.iter().flatten() {
        let n = {
            let mut bw = Writer::new(&mut body);
            r.encode(&mut bw);
            bw.written()
        };
        put_rule(&mut w, &body[..n]);
    }
    if w.full {
        return (RES_STORAGE, None);
    }
    if replace {
        engine().clear();
    }
    for r in new.iter().flatten() {
        let _ = engine().upsert(r);
    }
    (RES_OK, Some(w.written()))
}

unsafe fn apply_delete(frame: &[u8], file: &[u8], new_file: &mut [u8]) -> (u8, Option<usize>) {
    let Some(CArm::DeleteSchedule(m)) = client_arm(frame) else {
        return (RES_BAD_RULE, None);
    };
    if m.all() {
        engine().clear();
        return (RES_OK, Some(0));
    }
    let id = m.id();
    if id == 0 || id > 255 || !engine().remove(id as u8) {
        return (RES_NOT_FOUND, None);
    }
    let mut w = Writer::new(new_file);
    for b in rule_bodies(file).filter(|b| body_id(b) as u32 != id) {
        put_rule(&mut w, b);
    }
    (RES_OK, Some(w.written()))
}

unsafe fn write_state(w: &mut PbOut, file: &[u8], page: usize, result: u8) {
    let n = engine().len();
    let pages = n.div_ceil(PAGE).max(1);
    for b in rule_bodies(file).skip(page * PAGE).take(PAGE) {
        w.bytes(1, b);
    }
    let nz = |w: &mut PbOut, f: u32, v: u64| {
        if v != 0 {
            w.uint(f, v)
        }
    };
    nz(w, 2, page as u64);
    nz(w, 3, pages as u64);
    nz(w, 4, n as u64);
    nz(w, 5, CAPACITY as u64);
    nz(w, 6, clock_ffi::wall_now().is_some() as u64);
    nz(w, 7, location().is_some() as u64);
    if let Some((t, id)) = engine().next_fire() {
        nz(w, 8, (t * 1000) as u64);
        nz(w, 9, id as u64);
    }
    nz(w, 10, FIRED as u64);
    nz(w, 11, SKIPPED as u64);
    nz(w, 12, LAST_FIRED_ID as u64);
    nz(w, 13, LAST_FIRED_UNIX_MS as u64);
    nz(w, 14, LAST_SKIPPED_ID as u64);
    nz(w, 15, LAST_SKIP as u64);
    nz(w, 16, hold_left_s() as u64);
    nz(w, 17, result as u64);
}

/// set_schedule / delete_schedule / get_schedule with the current rules `file`
/// (read by main.cpp): the reply (schedule_state) goes to `out`; a changed rule
/// set is written to `new_file` and `*new_len` set (usize::MAX = unchanged,
/// nothing to write). Returns the reply length.
///
/// # Safety
/// The pointers valid for their lengths. Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_sched_handle(
    frame: *const u8,
    len: usize,
    file: *const u8,
    file_len: usize,
    new_file: *mut u8,
    new_cap: usize,
    new_len: *mut usize,
    out: *mut u8,
    cap: usize,
) -> i32 {
    *new_len = usize::MAX;
    let frame = core::slice::from_raw_parts(frame, len);
    let file: &[u8] = if file.is_null() {
        &[]
    } else {
        core::slice::from_raw_parts(file, file_len)
    };
    let nf = core::slice::from_raw_parts_mut(new_file, new_cap);
    let (result, changed, page) = match client_arm(frame) {
        Some(CArm::SetSchedule(_)) => {
            let (r, c) = apply_set(frame, file, nf);
            (r, c, 0)
        }
        Some(CArm::DeleteSchedule(_)) => {
            let (r, c) = apply_delete(frame, file, nf);
            (r, c, 0)
        }
        Some(CArm::GetSchedule(m)) => (RES_OK, None, m.page() as usize),
        _ => (RES_BAD_RULE, None, 0),
    };
    let shown: &[u8] = match changed {
        Some(n) => {
            *new_len = n;
            &nf[..n]
        }
        None => file,
    };
    write_arm(out, cap, SRV_SCHEDULE_STATE, |w| {
        write_state(w, shown, page, result)
    })
}

/// The schedule arms without main.cpp's file (host builds, no filesystem):
/// reads answer from the table, changes are refused (STORAGE).
pub(crate) unsafe fn handle_unstaged(frame: &[u8], out: *mut u8, cap: usize) -> i32 {
    let result = match client_arm(frame) {
        Some(CArm::GetSchedule(_)) => RES_OK,
        _ => RES_STORAGE,
    };
    write_arm(out, cap, SRV_SCHEDULE_STATE, |w| {
        write_state(w, &[], 0, result)
    })
}

// -- firing (loop task) ------------------------------------------------------------

/// An internal frame's header: [INTERNAL, kind, rule id, due ms (i64 LE)].
const HDR: usize = 11;

fn header(kind: u8, id: u8, due_ms: i64) -> [u8; HDR] {
    let mut h = [0u8; HDR];
    h[0] = INTERNAL;
    h[1] = kind;
    h[2] = id;
    h[3..11].copy_from_slice(&due_ms.to_le_bytes());
    h
}

unsafe fn push_internal(due_ms: i64, frame: &[u8]) {
    let q = &mut *addr_of_mut!(SCHED);
    q.push(due_ms, frame, |f| {
        sched_apply_frame(f);
    });
}

unsafe fn skip(id: u8, why: u8) {
    SKIPPED = SKIPPED.wrapping_add(1);
    LAST_SKIPPED_ID = id;
    LAST_SKIP = why;
    note(id, NOTE_SKIP, why as i64);
}

unsafe fn note(id: u8, what: u8, v: i64) {
    if let Some(slot) = (*addr_of_mut!(NOTES)).iter_mut().find(|n| n.is_none()) {
        *slot = Some((id, what, v));
    }
}

unsafe fn pend(p: Pending) -> bool {
    for slot in (*addr_of_mut!(PEND)).iter_mut() {
        if slot.is_none() {
            *slot = Some(p);
            return true;
        }
    }
    false
}

/// One rule handed out by the engine, at device ms `now_ms` with the wall
/// clock at `utc_ms`.
unsafe fn on_fire(f: Fire, now_ms: i64, utc_ms: i64) -> u32 {
    let s = f.slot;
    let due = if f.catch_up {
        now_ms
    } else {
        now_ms + (f.at_s * 1000 - utc_ms).max(0)
    };
    if live_now() {
        skip(s.id, SKIP_LIVE);
        return TICK_LOG;
    }
    note(s.id, NOTE_FIRE, due - now_ms);
    let mut b = [0u8; HDR + 8];
    match s.kind {
        ActionKind::Power => {
            b[..HDR].copy_from_slice(&header(K_POWER, s.id, due));
            b[HDR] = s.on as u8;
            b[HDR + 1..HDR + 5].copy_from_slice(&s.ms.to_le_bytes());
            push_internal(due, &b[..HDR + 5]);
        }
        ActionKind::Brightness => {
            b[..HDR].copy_from_slice(&header(K_BRIGHT, s.id, due));
            b[HDR..HDR + 4].copy_from_slice(&s.level.to_le_bytes());
            // A catch-up lands at once: the ramp was meant to have finished.
            let ms = if f.catch_up { 0 } else { s.ms };
            b[HDR + 4..HDR + 8].copy_from_slice(&ms.to_le_bytes());
            push_internal(due, &b[..HDR + 8]);
        }
        ActionKind::Effect | ActionKind::Trigger => {
            if !pend(Pending {
                id: s.id,
                due_ms: due,
                crossfade_ms: s.ms,
            }) {
                skip(s.id, SKIP_BUSY);
            }
            return TICK_NEED_FILE | TICK_LOG;
        }
        ActionKind::None => return 0,
    }
    TICK_LOG
}

/// The loop task, every pass (cheap between the 4 Hz polls). Returns TICK_*:
/// NEED_FILE: call [`lm_sched_resolve`] with the rules file; LOG: a
/// `[sched]` line is waiting ([`lm_sched_status_line`]); LOC_CHANGED: persist
/// [`lm_sched_loc_record`].
///
/// # Safety
/// Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_sched_tick(now_ms: i64) -> u32 {
    let mut bits = 0;
    if LOC_GEN != SEEN_LOC_GEN {
        SEEN_LOC_GEN = LOC_GEN;
        bits |= TICK_LOC_CHANGED;
    }
    if (*addr_of!(APPLIED)).iter().any(|a| a.is_some())
        || (*addr_of!(NOTES)).iter().any(|n| n.is_some())
    {
        bits |= TICK_LOG;
    }
    // Polled even with no rules: the first valid poll is the boot reconcile (D-566), and
    // rules added later must not count as "missed" (no surprise catch-up on an edit).
    if LAST_POLL_MS != i64::MIN && (0..POLL_MS).contains(&(now_ms - LAST_POLL_MS)) {
        return bits;
    }
    LAST_POLL_MS = now_ms;
    let Some((utc_us, _)) = clock_ffi::wall_now() else {
        if CLOCK_WAS_VALID {
            CLOCK_WAS_VALID = false;
            engine().clock_lost();
        }
        return bits;
    };
    CLOCK_WAS_VALID = true;
    let (zone, zgen) = clock_ffi::zone();
    if SEEN_TIMES != (zgen, LOC_GEN) {
        SEEN_TIMES = (zgen, LOC_GEN);
        engine().times_changed();
    }
    let utc_ms = utc_us.div_euclid(1000);
    let loc = location();
    engine().poll(utc_us.div_euclid(1_000_000), HORIZON_S, zone, loc, |f| {
        bits |= on_fire(f, now_ms, utc_ms)
    });
    if (*addr_of!(PEND)).iter().any(|p| p.is_some()) {
        bits |= TICK_NEED_FILE;
    }
    bits
}

/// Resolve the staged rules against the rules `file` (main.cpp read it): a
/// trigger is queued now (its pool entry created here, off render); an effect
/// rule returns its stored-effect id in `id_out` (the length; 0 = nothing to
/// load) for main.cpp to read the record and call [`lm_sched_load`]. Call it
/// until it returns 0.
///
/// # Safety
/// The pointers valid for their lengths. Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_sched_resolve(
    file: *const u8,
    len: usize,
    id_out: *mut u8,
    id_cap: usize,
) -> i32 {
    let file: &[u8] = if file.is_null() {
        &[]
    } else {
        core::slice::from_raw_parts(file, len)
    };
    while let Some(i) = (*addr_of!(PEND)).iter().position(|p| p.is_some()) {
        let p = (*addr_of_mut!(PEND))[i].take().unwrap();
        let rule = rule_bodies(file)
            .filter_map(|b| Rule::decode(b).ok())
            .find(|r| r.id == p.id);
        match rule.map(|r| r.action) {
            Some(ledmapper_schedule::Action::Trigger { name }) => {
                let nm = name.as_bytes();
                if uniform_pool::dynamic_value(nm).is_none() {
                    uniform_pool::publish(nm, &[0.0]);
                }
                let mut b = [0u8; HDR + 64];
                b[..HDR].copy_from_slice(&header(K_TRIGGER, p.id, p.due_ms));
                b[HDR..HDR + nm.len()].copy_from_slice(nm);
                push_internal(p.due_ms, &b[..HDR + nm.len()]);
            }
            Some(ledmapper_schedule::Action::Effect { effect_id, .. }) => {
                // Load onto the deck that is not showing, then crossfade to it.
                let target = if player().crossfade() >= 0.5 {
                    DECK_A_IDX
                } else {
                    DECK_B_IDX
                };
                let showing = if target == DECK_A_IDX {
                    DECK_B_IDX
                } else {
                    DECK_A_IDX
                };
                let same = deck(showing).is_some_and(|d| {
                    (*d).renders() && (*d).effect_id().as_bytes() == effect_id.as_bytes()
                });
                if same {
                    continue; // already showing it (a reconcile after a soft reset)
                }
                if target == DECK_B_IDX && power_ffi::owns_deck_b() {
                    skip(p.id, SKIP_BUSY);
                    continue;
                }
                let id = effect_id.as_bytes();
                if id.len() > id_cap || effect_store::find(id).is_none() {
                    skip(p.id, SKIP_NO_EFFECT);
                    continue;
                }
                core::slice::from_raw_parts_mut(id_out, id.len()).copy_from_slice(id);
                STAGE = Some((p, target as u8));
                return id.len() as i32;
            }
            _ => skip(p.id, SKIP_NO_EFFECT),
        }
    }
    0
}

/// The effect store slot of the effect [`lm_sched_resolve`] asked for, or -1.
///
/// # Safety
/// Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_sched_effect_slot(id: *const u8, len: usize) -> i32 {
    effect_store::find(core::slice::from_raw_parts(id, len)).map_or(-1, |n| n as i32)
}

/// Load the staged effect's record `rec` (the whole `fxs.<n>` file) onto the
/// hidden deck, active (it renders under a 0 crossfade weight), and queue the
/// crossfade to it at its due time. On deck A, `*persist_off` / `*persist_len`
/// locate the submit_effect frame main.cpp persists as the boot effect (else
/// `*persist_len` = 0). Returns false (skipped) when the record is unusable.
///
/// # Safety
/// The pointers valid for their lengths (or `rec` null: the read failed).
/// Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_sched_load(
    rec: *const u8,
    len: usize,
    persist_off: *mut usize,
    persist_len: *mut usize,
) -> bool {
    *persist_len = 0;
    let Some((p, target)) = (*addr_of_mut!(STAGE)).take() else {
        return false;
    };
    if rec.is_null() {
        skip(p.id, SKIP_NO_EFFECT);
        return false;
    }
    let rec = core::slice::from_raw_parts(rec, len);
    let loaded = effect_store::parse_header(rec).and_then(|h| {
        let inner = rec.get(h.frame_off..)?;
        match client_arm(inner) {
            Some(CArm::SubmitEffect(s)) => Some((s, h.frame_off, inner.len())),
            _ => None,
        }
    });
    let Some((s, off, flen)) = loaded else {
        skip(p.id, SKIP_NO_EFFECT);
        return false;
    };
    let d = target as usize;
    let reply = submit_effect_view(&s, d, true);
    if !matches!(
        reply.r#msg,
        Some(ledmapper_pb::ledmapper_::v1_::ServerMessage_::Msg::ResultReady(_))
    ) {
        skip(p.id, SKIP_NO_EFFECT);
        return false;
    }
    if d == DECK_A_IDX {
        *persist_off = off;
        *persist_len = flen;
    }
    let mut b = [0u8; HDR + 5];
    b[..HDR].copy_from_slice(&header(K_XFADE, p.id, p.due_ms));
    b[HDR] = (d == DECK_B_IDX) as u8;
    b[HDR + 1..].copy_from_slice(&p.crossfade_ms.to_le_bytes());
    push_internal(p.due_ms, &b);
    true
}

// -- applying (render task) -------------------------------------------------------

/// The device ms of the frame being applied (lm_sched_apply sets it first).
static mut FRAME_MS: i64 = 0;

pub(crate) unsafe fn set_frame_ms(now_ms: i64) {
    FRAME_MS = now_ms;
}

/// Apply one internal frame at the frame boundary. Returns SCHED_* bits.
pub(crate) unsafe fn apply_internal(f: &[u8]) -> u32 {
    if f.len() < HDR {
        return 0;
    }
    let id = f[2];
    let due_ms = i64::from_le_bytes([f[3], f[4], f[5], f[6], f[7], f[8], f[9], f[10]]);
    let now = FRAME_MS;
    let u32_at = |i: usize| {
        f.get(HDR + i..HDR + i + 4)
            .map_or(0, |b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    };
    let p0 = f.get(HDR).copied();
    let mut bits = super::SCHED_APPLIED;
    match f[1] {
        K_POWER => power_ffi::scheduled(p0 == Some(1), u32_at(1), now as u32),
        K_BRIGHT => {
            let to = f32::from_bits(u32_at(0)).clamp(0.0, 1.0);
            let ms = u32_at(4);
            let from = player().output_brightness();
            if ms == 0 {
                RAMP_BRIGHT = None;
                player().set_output_brightness(to as f64);
                bits |= super::SCHED_BRIGHTNESS;
            } else {
                RAMP_BRIGHT = Some(Ramp {
                    from,
                    to,
                    start: now,
                    ms,
                    last: from,
                });
            }
        }
        K_XFADE => {
            let to = if p0 == Some(1) { 1.0 } else { 0.0 };
            let ms = u32_at(1);
            let from = player().crossfade();
            note_xf_toward(to as f64);
            if ms == 0 {
                RAMP_XF = None;
                player().set_crossfade(to as f64, player().crossfade_mode());
            } else {
                RAMP_XF = Some(Ramp {
                    from,
                    to,
                    start: now,
                    ms,
                    last: from,
                });
            }
        }
        K_TRIGGER => {
            let name = &f[HDR..];
            let v = uniform_pool::dynamic_value(name).unwrap_or(0.0);
            uniform_pool::publish(name, &[v + 1.0]);
        }
        _ => return 0,
    }
    for slot in (*addr_of_mut!(APPLIED)).iter_mut() {
        if slot.is_none() {
            *slot = Some((id, now, due_ms));
            break;
        }
    }
    bits
}

/// Advance the brightness ramp and the timed crossfade (render, each frame
/// start; a few float ops while one runs). Returns SCHED_BRIGHTNESS when the
/// output brightness moved.
pub(crate) unsafe fn ramps_frame(now_ms: i64) -> u32 {
    let mut bits = 0;
    if let Some(mut r) = *addr_of!(RAMP_BRIGHT) {
        if player().output_brightness() != r.last {
            RAMP_BRIGHT = None; // a client set it: theirs wins
        } else {
            let (v, done) = ramp_value(&r, now_ms);
            // Quantized to the output's 1/255 steps: no gen bump per frame otherwise.
            if (v * 255.0) as i32 != (r.last * 255.0) as i32 || done {
                player().set_output_brightness(v as f64);
                r.last = player().output_brightness();
                bits |= super::SCHED_BRIGHTNESS;
            }
            RAMP_BRIGHT = if done { None } else { Some(r) };
        }
    }
    if let Some(mut r) = *addr_of!(RAMP_XF) {
        if player().crossfade() != r.last {
            RAMP_XF = None;
        } else {
            let (v, done) = ramp_value(&r, now_ms);
            player().set_crossfade(v as f64, player().crossfade_mode());
            r.last = player().crossfade();
            RAMP_XF = if done { None } else { Some(r) };
        }
    }
    bits
}

fn ramp_value(r: &Ramp, now_ms: i64) -> (f32, bool) {
    let t = (now_ms - r.start).max(0) as f32 / r.ms.max(1) as f32;
    if t >= 1.0 {
        (r.to, true)
    } else {
        (r.from + (r.to - r.from) * t, false)
    }
}

/// A brightness ramp is running (main.cpp keeps quiet about each step: no log
/// line, no power_state push per frame).
#[no_mangle]
pub extern "C" fn lm_sched_ramping() -> bool {
    // SAFETY: a single-word read; a stale answer only affects logging.
    unsafe { (*addr_of!(RAMP_BRIGHT)).is_some() }
}

// -- status (loop task) ------------------------------------------------------------

struct Line<'a> {
    buf: &'a mut [u8],
    n: usize,
}

impl core::fmt::Write for Line<'_> {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        for &b in s.as_bytes() {
            if self.n + 1 < self.buf.len() {
                self.buf[self.n] = b;
                self.n += 1;
            }
        }
        Ok(())
    }
}

/// One waiting `[sched]` line (NUL-terminated) into `out`; 0 when none.
/// `[sched] applied id=3 at_ms=… due_ms=… late_ms=0 unix_ms=…`,
/// `[sched] fire id=3 in_ms=1987`, `[sched] skip id=3 why=1`.
///
/// # Safety
/// `out` writable for `cap` bytes. Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_sched_status_line(now_ms: i64, out: *mut u8, cap: usize) -> usize {
    use core::fmt::Write;
    if out.is_null() || cap == 0 {
        return 0;
    }
    let mut l = Line {
        buf: core::slice::from_raw_parts_mut(out, cap),
        n: 0,
    };
    if let Some(i) = (*addr_of!(APPLIED)).iter().position(|a| a.is_some()) {
        let (id, at, due) = (*addr_of_mut!(APPLIED))[i].take().unwrap();
        // The wall time of that frame (the loop's clock reading, mapped back).
        let unix_ms = clock_ffi::wall_now().map_or(0, |(u, _)| u.div_euclid(1000) - (now_ms - at));
        FIRED = FIRED.wrapping_add(1);
        LAST_FIRED_ID = id;
        LAST_FIRED_UNIX_MS = unix_ms;
        let _ = write!(
            l,
            "[sched] applied id={id} at_ms={at} due_ms={due} late_ms={} unix_ms={unix_ms}",
            at - due
        );
    } else if let Some((id, what, v)) = (*addr_of_mut!(NOTES)).iter_mut().find_map(|n| n.take()) {
        match what {
            NOTE_FIRE => {
                let _ = write!(l, "[sched] fire id={id} in_ms={v}");
            }
            _ => {
                let _ = write!(l, "[sched] skip id={id} why={v}");
            }
        }
    } else {
        return 0;
    }
    let n = l.n;
    l.buf[n] = 0;
    n
}

/// Test hook: forget everything (a fresh boot).
///
/// # Safety
/// Test thread only.
#[cfg(not(target_os = "none"))]
#[no_mangle]
pub unsafe extern "C" fn lm_sched_test_reset() {
    ENGINE = Engine::new();
    LOC = None;
    CLOCK_WAS_VALID = false;
    LAST_POLL_MS = i64::MIN;
    LIVE_LAST_US = i64::MIN;
    HOLD_UNTIL_US = i64::MIN;
    PEND = [None; PEND_N];
    STAGE = None;
    APPLIED = [None; APPLIED_N];
    NOTES = [None; NOTE_N];
    RAMP_BRIGHT = None;
    RAMP_XF = None;
    FIRED = 0;
    SKIPPED = 0;
}
