//! Lamp power (docs/design/lamp-power.md): the protocol + render side of the
//! on/off state, its ON/OFF transitions and the touch sensor.
//!
//! The pure logic lives in `//firmware/power` (state machine, envelopes,
//! debounce, config record). This module owns the live instances, answers
//! set_power / get_power / set_power_config (zero-copy power_state replies), the
//! submit_effect `power_slot` store, and the C ABI main.cpp drives:
//!
//! - the render task calls [`lm_power_frame`] at each frame start (under the
//!   player mutex): it says whether to render, the output level, and drives the
//!   transition effect's deck-B crossfade + `power`/`transition` uniforms;
//! - the loop task watches the toggle trigger ([`lm_power_poll_trigger`]: a
//!   driver's `export trigger`, e.g. the TTP223 touch driver's `touch_tap`), loads a
//!   transition effect when asked ([`lm_power_take_load`] + a replay of its
//!   stored frame with [`lm_power_set_loading`] + [`lm_power_effect_loaded`]),
//!   persists ([`lm_power_cfg_gen`] / [`lm_power_state_gen`]) and pushes
//!   power_state to the sessions that asked for it ([`lm_power_build_push`]).
//!
//! Everything runs under the player mutex (handler, render frame, loop calls).

use core::ptr::{addr_of, addr_of_mut};

use ledmapper_bss::BssOption;
use ledmapper_osc as osc;
use ledmapper_power::{self as pw, Config, Machine, Request, Start};

use super::{client_arm, deck, fx_clear, fx_set_uniform, player, uniform_pool, write_arm, CArm, PbOut, DECK_A, DECK_B_IDX};

/// ServerMessage arm of the reply / push (power_state = 70).
const ARM_POWER_STATE: u32 = 70;
/// ClientMessage arms (ledmapper.proto "Lamp power").
pub const ARM_SET_POWER: u32 = 130;
pub const ARM_GET_POWER: u32 = 131;
pub const ARM_SET_POWER_CONFIG: u32 = 132;

static mut MACHINE: Machine = Machine::new(true);
// BssOption (not `Config::DEFAULT`): the default has a few non-zero bytes, which would put
// the whole ~0.5 KB record in .data (flash). Empty = the default, filled on first use.
static mut CONFIG: BssOption<Config> = BssOption::NONE;
/// The toggle trigger's last-seen count (None = not seen since bind / boot) and
/// how often it toggled the lamp since boot.
static mut TRIGGER_LAST: Option<f32> = None;
static mut TRIGGER_COUNT: u32 = 0;
/// Config changes (persist /lfs/power.cfg).
static mut CFG_GEN: u32 = 0;
/// A transition effect is stored for ON / OFF (its frame file exists).
static mut STORED: [bool; 2] = [false, false];
/// Owed to the loop task: load the ON (1) / OFF (2) effect; persist a just-stored
/// effect frame (slot); remove stored frames (bits 1 = ON, 2 = OFF); the GPIO
/// pull simulation (pin, pull; pull 0 = none pending).
static mut LOAD_REQ: u8 = 0;
static mut STORE_REQ: u8 = 0;
static mut CLEAR_REQ: u8 = 0;
static mut SIM_REQ: Option<(i32, u8)> = None;
/// The replay of a stored transition frame is running (submit_effect loads it
/// onto deck B instead of storing it) and what it did.
static mut LOADING: bool = false;
static mut LOAD_OK: bool = false;
/// Deck-B uniform slots of the running transition effect (u16::MAX = absent).
static mut SLOT_POWER: u16 = u16::MAX;
static mut SLOT_TRANSITION: u16 = u16::MAX;
/// The crossfade override for this frame's blend (EFFECT transitions).
static mut XF_OVERRIDE: Option<f32> = None;
/// Push owed to the subscribed sessions; which sessions asked (WSS, BLE) and the
/// connection state last seen (a subscription ends with its connection).
static mut PUSH_DUE: bool = false;
static mut SUBSCRIBED: [bool; 3] = [false; 3];
static mut CONNECTED: [bool; 3] = [false; 3];

/// The frame's crossfade override (fx_latch_crossfade).
pub(crate) unsafe fn xf_override() -> Option<f32> {
    *addr_of!(XF_OVERRIDE)
}

/// A schedule rule turns the lamp on / off (sched_ffi.rs; render, at its frame).
pub(crate) unsafe fn scheduled(on: bool, duration_ms: u32, now: u32) {
    request(on, false, duration_ms, pw::SOURCE_SCHEDULE, now);
}

/// A power transition is playing its effect on deck B.
pub(crate) unsafe fn owns_deck_b() -> bool {
    machine().owns_deck_b()
}

/// The lamp is settled off (nothing renders).
pub(crate) unsafe fn dark() -> bool {
    (*addr_of!(MACHINE)).phase() == pw::PHASE_OFF
}

unsafe fn machine() -> &'static mut Machine {
    &mut *addr_of_mut!(MACHINE)
}
unsafe fn config() -> &'static mut Config {
    (*addr_of_mut!(CONFIG)).get_or_insert_with(|| Config::DEFAULT)
}

/// Deck B is free for a transition effect: not showing in a crossfade.
unsafe fn deck_b_free() -> bool {
    match deck(DECK_B_IDX) {
        Some(p) => !((*p).renders() && player().crossfade() > 0.0),
        None => true,
    }
}

unsafe fn note_change() {
    PUSH_DUE = true;
}

/// Ask the machine for a change and arrange what it needs.
unsafe fn request(on: bool, instant: bool, duration_ms: u32, source: u8, now: u32) {
    let slot = if on { 0 } else { 1 };
    let effect_ok = (*addr_of!(STORED))[slot] && config().transition(on).has_effect() && deck_b_free();
    let r = Request { on, instant, duration_ms, source };
    let cfg = *config();
    match machine().request(r, &cfg, effect_ok, now) {
        Start::Unchanged => {}
        Start::Started => {
            // A cut / instant change that dropped an effect transition mid-way.
            if !machine().owns_deck_b() {
                release_deck_b_if_ours();
            }
            note_change();
        }
        Start::LoadEffect(on) => {
            LOAD_REQ = if on { 1 } else { 2 };
            note_change();
        }
    }
}

/// Deck B held a transition effect the machine no longer owns: clear it.
static mut DECK_B_OURS: bool = false;
unsafe fn release_deck_b_if_ours() {
    if DECK_B_OURS && !machine().owns_deck_b() {
        DECK_B_OURS = false;
        XF_OVERRIDE = None;
        SLOT_POWER = u16::MAX;
        SLOT_TRANSITION = u16::MAX;
        fx_clear(DECK_B_IDX);
    }
}

// -- power_state ---------------------------------------------------------------

/// A length-delimited submessage at `field`: measured first, then written.
fn sub(w: &mut PbOut, field: u32, body: impl Fn(&mut PbOut)) {
    let mut m = PbOut { buf: None, n: 0, ok: true };
    body(&mut m);
    w.key(field, 2);
    w.varint(m.n as u64);
    body(w);
}

fn write_transition(w: &mut PbOut, t: &pw::Transition, on: bool) {
    if t.style != 0 {
        w.uint(1, t.style as u64);
    }
    w.uint(2, pw::effective_ms(t.duration_ms, on) as u64);
    if t.has_effect() {
        w.bytes(3, t.effect_id());
    }
    if t.label_len > 0 {
        w.bytes(5, t.label());
    }
    if t.n_uniforms > 0 {
        w.uint(6, t.n_uniforms as u64);
    }
}

unsafe fn write_state(w: &mut PbOut, now: u32) {
    let m = &*addr_of!(MACHINE);
    let c = &*config();
    let nz = |w: &mut PbOut, f: u32, v: u64| {
        if v != 0 {
            w.uint(f, v)
        }
    };
    nz(w, 1, m.target() as u64);
    nz(w, 2, m.phase() as u64);
    let b = player().output_brightness() as f64;
    if b != 0.0 {
        w.key(3, 1);
        for x in b.to_le_bytes() {
            w.byte(x);
        }
    }
    let id = &(*addr_of!(DECK_A)).id[..(*addr_of!(DECK_A)).id_len];
    if !id.is_empty() {
        w.bytes(4, id);
    }
    nz(w, 5, m.source as u64);
    nz(w, 6, c.boot as u64);
    sub(w, 7, |w| write_transition(w, &c.on, true));
    sub(w, 8, |w| write_transition(w, &c.off, false));
    if c.trigger_len > 0 {
        w.bytes(9, c.trigger());
    }
    nz(w, 10, TRIGGER_COUNT as u64);
    nz(w, 12, m.seq as u64);
    nz(w, 13, m.left_ms(now) as u64);
}

unsafe fn reply_state(out: *mut u8, cap: usize, now: u32) -> i32 {
    write_arm(out, cap, ARM_POWER_STATE, |w| write_state(w, now))
}

/// The connection the message being handled came in on subscribes to pushes.
unsafe fn subscribe() {
    let mut src = super::kiosk_ffi::current_src() as usize;
    // The P4's further link sessions (kiosk_ffi SRC_LINK2/3) get the wss session's pushes.
    if src >= 3 {
        src = super::kiosk_ffi::SRC_WSS as usize;
    }
    if src < 3 {
        (*addr_of_mut!(SUBSCRIBED))[src] = true;
    }
}

pub(crate) unsafe fn handle_get_power(now: u32, out: *mut u8, cap: usize) -> i32 {
    subscribe();
    reply_state(out, cap, now)
}

pub(crate) unsafe fn handle_set_power(frame: &[u8], now: u32, out: *mut u8, cap: usize) -> i32 {
    subscribe();
    if let Some(CArm::SetPower(m)) = client_arm(frame) {
        let on = if m.toggle() { !machine().target() } else { m.on() };
        request(on, m.instant(), m.duration_ms(), pw::SOURCE_CLIENT, now);
    }
    reply_state(out, cap, now)
}

pub(crate) unsafe fn handle_set_power_config(frame: &[u8], now: u32, out: *mut u8, cap: usize) -> i32 {
    subscribe();
    let Some(CArm::SetPowerConfig(m)) = client_arm(frame) else {
        return reply_state(out, cap, now);
    };
    let before = *config();
    let c = config();
    if let Some(b) = m.boot() {
        c.boot = pw::sanitize_boot(b);
    }
    for (on, v) in [(true, m.on_transition()), (false, m.off_transition())] {
        let Some(v) = v else { continue };
        let t = c.transition_mut(on);
        t.style = pw::sanitize_style(v.style());
        t.duration_ms = v.duration_ms().min(pw::MAX_MS);
        t.set_label(v.label().as_bytes());
        t.clear_uniforms();
        for u in v.uniforms() {
            let mut a = [0.0f32; 4];
            let mut n = 0;
            for x in u.value() {
                if n < 4 && x.is_finite() {
                    a[n] = x;
                }
                n += 1;
            }
            if (1..=4).contains(&n) {
                let _ = t.push_uniform(u.slot(), &a[..n]);
            }
        }
    }
    let clear = (m.clear_effects() & 3) as u8;
    if clear != 0 {
        for (bit, on) in [(1u8, true), (2u8, false)] {
            if clear & bit != 0 {
                c.transition_mut(on).set_effect_id(b"");
                (*addr_of_mut!(STORED))[if on { 0 } else { 1 }] = false;
            }
        }
        CLEAR_REQ |= clear;
    }
    if let Some(name) = m.toggle_trigger() {
        if c.set_trigger(name.as_bytes()) {
            TRIGGER_LAST = None;
        }
    }
    if let Some(pin) = m.sim_gpio() {
        SIM_REQ = Some((pin, m.sim_pull().min(2) as u8));
    }
    if *config() != before {
        CFG_GEN = CFG_GEN.wrapping_add(1);
        machine().seq = machine().seq.wrapping_add(1);
        note_change();
    }
    reply_state(out, cap, now)
}

/// submit_effect with a power_slot: store (validate, keep the frame) — or, while
/// a stored frame replays for a transition, report that the deck-B load should
/// go ahead. Returns Some(store reply) when it consumed the message.
pub(crate) unsafe fn intercept_submit(slot: u32, id: &str, fxb: Option<&[u8]>) -> Option<Result<(), &'static str>> {
    if slot == 0 || slot > 2 || LOADING {
        return None;
    }
    let Some(fxb) = fxb else { return Some(Err("submit_effect without fxb")) };
    if fxb.is_empty() || fxb.len() > super::FX_MAX_BYTES {
        return Some(Err("effect_too_large"));
    }
    match ledmapper_fx_vm::Program::parse(fxb) {
        Ok(p) if p.flags & ledmapper_fx_vm::FLAG_DRIVER == 0 => {}
        _ => return Some(Err("bad_fxb")),
    }
    let on = slot == 1;
    config().transition_mut(on).set_effect_id(if id.is_empty() { b"transition" } else { id.as_bytes() });
    (*addr_of_mut!(STORED))[if on { 0 } else { 1 }] = true;
    STORE_REQ = slot as u8;
    CFG_GEN = CFG_GEN.wrapping_add(1);
    machine().seq = machine().seq.wrapping_add(1);
    note_change();
    Some(Ok(()))
}

/// The replay of a stored transition frame is running: the effect goes onto deck
/// B, active.
pub(crate) unsafe fn loading() -> bool {
    LOADING
}
pub(crate) unsafe fn note_load(ok: bool) {
    LOAD_OK = ok;
}

// -- C ABI ---------------------------------------------------------------------

/// Boot: the persisted config record (`rec`/`len`, else defaults), the last
/// saved state (`last_on` -1 = never saved, 0 / 1) and which transition frames
/// exist. Returns whether the lamp boots on (it then fades in on the first
/// frame).
///
/// # Safety
/// `rec` readable for `len` or null. Setup, before the render task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_seed(rec: *const u8, len: usize, last_on: i32, on_stored: bool, off_stored: bool) -> bool {
    if !rec.is_null() {
        if let Some(c) = pw::decode_config(core::slice::from_raw_parts(rec, len)) {
            (*addr_of_mut!(CONFIG)).set(c);
        }
    }
    let c = config();
    STORED = [on_stored && c.on.has_effect(), off_stored && c.off.has_effect()];
    let last = match last_on {
        0 => Some(false),
        1 => Some(true),
        _ => None,
    };
    let on = pw::boot_state(c.boot, last);
    MACHINE = Machine::new(false);
    if on {
        machine().boot_fade_in(c.on.duration_ms);
    }
    on
}

/// One render frame (render task, under the player mutex, before lm_fx_update):
/// returns bit 1 = render, bit 2 = a transition settled this frame; `level_q8`
/// gets the output scale (256 = full). Drives the transition effect's deck-B
/// crossfade and uniforms.
///
/// # Safety
/// `level_q8` writable. Render task under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_power_frame(now: u32, level_q8: *mut u16) -> u32 {
    let f = machine().frame(now);
    if !level_q8.is_null() {
        *level_q8 = f.level_q8;
    }
    XF_OVERRIDE = f.crossfade;
    if machine().owns_deck_b() {
        if SLOT_POWER < u16::MAX - 1 {
            fx_set_uniform(DECK_B_IDX, SLOT_POWER as u32, &[f.power]);
        }
        if SLOT_TRANSITION < u16::MAX - 1 {
            fx_set_uniform(DECK_B_IDX, SLOT_TRANSITION as u32, &[f.progress]);
        }
    }
    if f.release_deck_b {
        release_deck_b_if_ours();
    }
    if f.settled {
        note_change();
    }
    (f.render as u32) | ((f.settled as u32) << 1)
}

/// Every loop pass (after the driver poll): a change of the bound toggle
/// trigger's count toggles the lamp. Returns true when it did.
///
/// # Safety
/// Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_power_poll_trigger(now: u32) -> bool {
    let c = &*config();
    if c.trigger_len == 0 {
        return false;
    }
    let Some(v) = uniform_pool::dynamic_value(c.trigger()) else {
        // Not published (no driver, or it was removed): forget the count so a
        // reloaded driver's restart from 0 is adopted, not taken for a fire.
        TRIGGER_LAST = None;
        return false;
    };
    match pw::trigger_step(TRIGGER_LAST, v) {
        None => false,
        Some(fired) => {
            TRIGGER_LAST = Some(v);
            if fired {
                TRIGGER_COUNT = TRIGGER_COUNT.wrapping_add(1);
                let on = !machine().target();
                request(on, false, 0, pw::SOURCE_TRIGGER, now);
                note_change();
            }
            fired
        }
    }
}

/// The transition effect the loop task must load now: 0 none, 1 ON, 2 OFF.
/// Then: lm_power_set_loading(true), replay its stored frame (submit_effect),
/// lm_power_set_loading(false), lm_power_effect_loaded(now). All under the
/// player mutex.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_take_load() -> u32 {
    let r = LOAD_REQ;
    LOAD_REQ = 0;
    r as u32
}

/// # Safety
/// Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_power_set_loading(on: bool) {
    LOADING = on;
    if on {
        LOAD_OK = false;
    }
}

/// The stored frame replayed (or failed to): start the transition. Applies the
/// uniform preset and finds the `power` / `transition` uniforms.
///
/// # Safety
/// Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_power_effect_loaded(now: u32) {
    let ok = LOAD_OK && deck(DECK_B_IDX).is_some_and(|p| (*p).renders());
    LOAD_OK = false;
    let turning_on = machine().phase() == pw::PHASE_TURNING_ON;
    let kept = machine().effect_loaded(ok, now);
    if ok {
        DECK_B_OURS = true;
    }
    if !kept {
        release_deck_b_if_ours();
        return;
    }
    let Some(p) = deck(DECK_B_IDX) else { return };
    SLOT_POWER = u16::MAX;
    SLOT_TRANSITION = u16::MAX;
    if let Some(prog) = (*p).prog.as_ref() {
        let table = osc::parse_manifest(prog.manifest);
        if let Some(port) = table.resolve("power") {
            SLOT_POWER = port.slot;
        }
        if let Some(port) = table.resolve("transition") {
            SLOT_TRANSITION = port.slot;
        }
    }
    let t = *config().transition(turning_on);
    for u in t.uniforms() {
        fx_set_uniform(DECK_B_IDX, u.slot as u32, u.values());
    }
}

/// The just-stored transition slot whose submit_effect frame the loop task
/// persists (/lfs/pw_on.pb = 1, /lfs/pw_off.pb = 2); 0 = none.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_take_store() -> u32 {
    let r = STORE_REQ;
    STORE_REQ = 0;
    r as u32
}

/// Stored frames to remove: bit 1 = ON, bit 2 = OFF.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_take_clear() -> u32 {
    let r = CLEAR_REQ;
    CLEAR_REQ = 0;
    r as u32
}

/// A pending GPIO pull simulation (SetPowerConfig.sim_gpio / sim_pull): true and
/// `pin` / `pull` (1 up, 2 down, 0 off) when one is owed.
///
/// # Safety
/// `pin` / `pull` writable. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_take_sim(pin: *mut i32, pull: *mut u32) -> bool {
    let Some((p, u)) = SIM_REQ.take() else { return false };
    if !pin.is_null() {
        *pin = p;
    }
    if !pull.is_null() {
        *pull = u as u32;
    }
    true
}

/// Config generation: bumped by every change to persist.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_cfg_gen() -> u32 {
    CFG_GEN
}

/// The config record into `out` (RECORD_LEN bytes); returns its length or -1.
///
/// # Safety
/// `out` writable for `cap`.
#[no_mangle]
pub unsafe extern "C" fn lm_power_cfg_record(out: *mut u8, cap: usize) -> i32 {
    if out.is_null() || cap < pw::RECORD_LEN {
        return -1;
    }
    let mut r = [0u8; pw::RECORD_LEN];
    pw::encode_config(&*config(), &mut r);
    core::ptr::copy_nonoverlapping(r.as_ptr(), out, pw::RECORD_LEN);
    pw::RECORD_LEN as i32
}

/// The target state (persist it once settled) and whether it is settled.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_target(settled: *mut bool) -> bool {
    if !settled.is_null() {
        *settled = !machine().transitioning();
    }
    machine().target()
}

/// The output brightness changed: report it.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_note_brightness() {
    note_change();
}

/// Every loop pass: a subscription ends when its connection drops.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_tick(wss_open: bool, ble_connected: bool) {
    let conn = &mut *addr_of_mut!(CONNECTED);
    let sub = &mut *addr_of_mut!(SUBSCRIBED);
    for (i, up) in [(1usize, wss_open), (2usize, ble_connected)] {
        if conn[i] && !up {
            sub[i] = false;
        }
        conn[i] = up;
    }
}

/// A power_state push is owed to session `src` (1 = wss, 2 = BLE): build it into
/// `out` (its length), or 0 when nothing is owed there. Call for each open
/// session, then [`lm_power_push_done`].
///
/// # Safety
/// `out` writable for `cap`. Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_power_build_push(src: u32, now: u32, out: *mut u8, cap: usize) -> i32 {
    if !PUSH_DUE || src as usize >= 3 || !(*addr_of!(SUBSCRIBED))[src as usize] {
        return 0;
    }
    let n = reply_state(out, cap, now);
    if n < 0 {
        0
    } else {
        n
    }
}

/// Session `src` (1 = wss, 2 = BLE) asked for power_state pushes.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_subscribed(src: u32) -> bool {
    (src as usize) < 3 && (*addr_of!(SUBSCRIBED))[src as usize]
}

/// Whether a push is owed at all (cheap check before taking the mutex).
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_push_due() -> bool {
    PUSH_DUE && (*addr_of!(SUBSCRIBED)).iter().any(|&s| s)
}

/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_power_push_done() {
    PUSH_DUE = false;
}

/// One console line after "POWER " (ON / OFF / TOGGLE / STATUS, + INSTANT).
/// Writes a one-line reply into `out`; -1 for an unknown line.
///
/// # Safety
/// `line` readable for `len`; `out` writable for `cap` (cap >= 1). Loop task,
/// under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_power_console(line: *const u8, len: usize, now: u32, out: *mut u8, cap: usize) -> i32 {
    if line.is_null() || out.is_null() || cap == 0 {
        return -1;
    }
    let l = core::slice::from_raw_parts(line, len);
    let mut words = l.split(|&c| c == b' ').filter(|w| !w.is_empty());
    let cmd = words.next().unwrap_or(b"");
    let instant = words.any(|w| w.eq_ignore_ascii_case(b"INSTANT"));
    if cmd.eq_ignore_ascii_case(b"ON") {
        request(true, instant, 0, pw::SOURCE_CLIENT, now);
    } else if cmd.eq_ignore_ascii_case(b"OFF") {
        request(false, instant, 0, pw::SOURCE_CLIENT, now);
    } else if cmd.eq_ignore_ascii_case(b"TOGGLE") {
        let on = !machine().target();
        request(on, instant, 0, pw::SOURCE_CLIENT, now);
    } else if !cmd.eq_ignore_ascii_case(b"STATUS") {
        return -1;
    }
    let m = &*addr_of!(MACHINE);
    let o = core::slice::from_raw_parts_mut(out, cap);
    let phase: &[u8] = match m.phase() {
        pw::PHASE_ON => b"on",
        pw::PHASE_TURNING_ON => b"turning_on",
        pw::PHASE_TURNING_OFF => b"turning_off",
        _ => b"off",
    };
    let mut n = 0;
    for &b in b"[power] ".iter().chain(phase.iter()) {
        if n + 1 < cap {
            o[n] = b;
            n += 1;
        }
    }
    o[n] = 0;
    n as i32
}
