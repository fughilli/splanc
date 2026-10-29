//! Kiosk mode (docs/design/kiosk-mode.md): a public, locked-down mode for
//! unattended installs.
//!
//! While the kiosk is ENABLED and the connection a message came in on is not
//! owner-unlocked, a visitor may only play: deploy / switch effects, set
//! uniforms (live too), crossfade, blend keypoints, stream textures, set the
//! brightness, and read-only queries. Everything else is refused with
//! `Error{code: "kiosk_locked"}` ([`lm_kiosk_gate`], called by main.cpp for
//! EVERY network message — wss, BLE, ws:81 — before any handler, OTA included).
//! Nothing a locked message does is persisted (main.cpp's persist_if_upload asks
//! [`lm_kiosk_msg_locked`]), and Improv Wi-Fi provisioning is refused while the
//! kiosk is enabled ([`lm_kiosk_enabled`]).
//!
//! Every allowed visitor op that changes the show counts as ACTIVITY: after
//! `idle_timeout_s` without any, [`lm_kiosk_tick`] asks the firmware to revert
//! to the ATTRACT snapshot — the owner's deck-A effect + its uniforms + a
//! default brightness, captured by `set_kiosk_config{capture_attract_from_current}`
//! and persisted to littlefs (the firmware writes the frames this module encodes:
//! [`lm_kiosk_encode_attract`]). The device boots into the attract snapshot too.
//!
//! The owner unlocks ONE connection (`kiosk_unlock{secret}`): the BLE link or the
//! wss session, until it drops ([`lm_kiosk_tick`] sees the edge). The USB serial
//! console's `kiosk off` is the recovery path ([`lm_kiosk_console`]).
//!
//! Everything runs on the loop task (the gate + handler under the player mutex,
//! the pollers right after), so plain statics, like wifi_ffi.rs.

use core::ptr::{addr_of, addr_of_mut};

use ledmapper_store::parse_upload_chunk;

use super::{
    client_arm, deck_renders, envelope_arm, fx_set_active, player, write_arm, CArm, PbOut, DECK_A,
    DECK_B_IDX, FX_JIT_N, FX_JIT_ORIG,
};

/// ClientMessage arms of the kiosk messages.
pub(crate) const ARM_GET_KIOSK_STATUS: u32 = 92;
pub(crate) const ARM_SET_KIOSK_CONFIG: u32 = 93;
pub(crate) const ARM_KIOSK_UNLOCK: u32 = 94;
/// ServerMessage.kiosk_status / ServerMessage.error.
const SRV_KIOSK_STATUS: u32 = 52;
const SRV_ERROR: u32 = 9;

/// KioskEvent.
pub const EVENT_NONE: u8 = 0;
pub const EVENT_REVERTED: u8 = 1;
pub const EVENT_ACTIVITY: u8 = 2;
pub const EVENT_CONFIG: u8 = 3;

/// Message sources (which connection a frame came in on): unlock is per source.
pub const SRC_INTERNAL: u8 = 0;
pub const SRC_WSS: u8 = 1;
pub const SRC_BLE: u8 = 2;
const N_SRC: usize = 3;

pub const DEFAULT_TIMEOUT_S: u32 = 120;
pub const MIN_TIMEOUT_S: u32 = 10;
pub const MAX_TIMEOUT_S: u32 = 86_400;
pub const MAX_SECRET: usize = 32;
pub const MAX_NAME: usize = 64;
/// A wrong unlock secret locks unlocking out for this long (brute-force brake).
pub const UNLOCK_LOCKOUT_MS: u32 = 2_000;

/// What the gate does with an arm while the connection is locked.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Class {
    /// A read-only query: passes, not activity.
    Read,
    /// A visitor op that changes the show: passes, restarts the idle timer.
    Play,
    /// Refused with kiosk_locked.
    Refuse,
}

/// The UploadChunk.Kind of a sharded effect upload (the only kind a visitor may send).
const UPLOAD_KIND_EFFECT: u32 = 2;

/// Classify ClientMessage arm `arm` (the frame is consulted only for upload_chunk,
/// whose kind decides). Unknown / future arms are refused: a new arm must be
/// classified here to be usable on a locked kiosk.
pub fn classify(arm: u32, frame: &[u8]) -> Class {
    match arm {
        // hello, time_sync_ping, the Pi status/pattern/live-map/solve queries,
        // get_playback, get_frame_timing, get_stored_map (the map download),
        // get_effect_uniforms, set_perf / get_perf_report (perf readout),
        // get_hardware_config, get_color_correction, list_effects, set_time_base
        // (a shared clock, runtime only), list/get_keypoint, get_tls_info,
        // get_sensors, get_driver_state, get_capture_profile, get_ota_status,
        // get_wifi_policy, get_kiosk_status, kiosk_unlock.
        1 | 2 | 9 | 10 | 11 | 12 | 18 | 19 | 20 | 24 | 25 | 26 | 34 | 35 | 36 | 38 | 42 | 43 | 45 | 48 | 53
        | 56 | 74 | 91 | ARM_GET_KIOSK_STATUS | ARM_KIOSK_UNLOCK => Class::Read,
        // set_playback, submit_effect, set_effect, set_uniforms (live too),
        // set_texture, set_brightness (no cap), set_crossfade, blend_keypoints.
        17 | 21 | 22 | 23 | 28 | 31 | 39 | 44 => Class::Play,
        // upload_chunk: only a sharded effect upload (the BLE path for a big .fxb).
        29 => match parse_upload_chunk(frame) {
            Ok(Some(c)) if c.kind == UPLOAD_KIND_EFFECT => Class::Play,
            _ => Class::Refuse,
        },
        // Everything else: mapping, map / topology / pose uploads, led count,
        // rename, hardware / colour config, set_jit, set_fps, keypoint writes,
        // sensors / drivers, OTA, the FX debugger, Wi-Fi policy, kiosk config.
        _ => Class::Refuse,
    }
}

/// The persisted configuration (/lfs/kiosk.cfg, [`encode`]).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Config {
    pub enabled: bool,
    pub timeout_s: u32,
    /// An attract snapshot is stored (/lfs/kiosk_fx.pb + kiosk_un.pb).
    pub has_attract: bool,
    pub brightness: f32,
    pub secret: [u8; MAX_SECRET],
    pub secret_len: u8,
    pub name: [u8; MAX_NAME],
    pub name_len: u8,
}

pub const DEFAULT_CONFIG: Config = Config {
    enabled: false,
    timeout_s: DEFAULT_TIMEOUT_S,
    has_attract: false,
    brightness: 1.0,
    secret: [0; MAX_SECRET],
    secret_len: 0,
    name: [0; MAX_NAME],
    name_len: 0,
};

impl Config {
    pub fn secret(&self) -> &[u8] {
        &self.secret[..self.secret_len as usize]
    }
    pub fn name(&self) -> &[u8] {
        &self.name[..self.name_len as usize]
    }
}

/// The record: "KIOS", version, flags (bit0 enabled, bit1 has_attract), timeout
/// u32 LE, brightness f32 LE, secret_len + 32 B, name_len + 64 B.
pub const RECORD_LEN: usize = 4 + 1 + 1 + 4 + 4 + 1 + MAX_SECRET + 1 + MAX_NAME;
pub const RECORD_VERSION: u8 = 1;
const MAGIC: &[u8; 4] = b"KIOS";

pub fn encode(c: &Config) -> [u8; RECORD_LEN] {
    let mut r = [0u8; RECORD_LEN];
    r[..4].copy_from_slice(MAGIC);
    r[4] = RECORD_VERSION;
    r[5] = c.enabled as u8 | (c.has_attract as u8) << 1;
    r[6..10].copy_from_slice(&c.timeout_s.to_le_bytes());
    r[10..14].copy_from_slice(&c.brightness.to_le_bytes());
    r[14] = c.secret_len;
    r[15..15 + MAX_SECRET].copy_from_slice(&c.secret);
    r[15 + MAX_SECRET] = c.name_len;
    r[16 + MAX_SECRET..].copy_from_slice(&c.name);
    r
}

pub fn decode(r: &[u8]) -> Option<Config> {
    if r.len() != RECORD_LEN || &r[..4] != MAGIC || r[4] != RECORD_VERSION {
        return None;
    }
    let mut c = DEFAULT_CONFIG;
    c.enabled = r[5] & 1 != 0;
    c.has_attract = r[5] & 2 != 0;
    c.timeout_s = u32::from_le_bytes([r[6], r[7], r[8], r[9]]).clamp(MIN_TIMEOUT_S, MAX_TIMEOUT_S);
    let b = f32::from_le_bytes([r[10], r[11], r[12], r[13]]);
    c.brightness = if b.is_finite() { b.clamp(0.0, 1.0) } else { 1.0 };
    c.secret_len = r[14].min(MAX_SECRET as u8);
    c.secret.copy_from_slice(&r[15..15 + MAX_SECRET]);
    c.name_len = r[15 + MAX_SECRET].min(MAX_NAME as u8);
    c.name.copy_from_slice(&r[16 + MAX_SECRET..]);
    // An enabled kiosk without a secret could never be unlocked over the air; the
    // console still could, but keep the invariant the setter enforces.
    if c.secret_len == 0 {
        c.enabled = false;
    }
    Some(c)
}

/// Constant-time secret compare (no early exit on the first differing byte).
pub fn secret_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Seconds until the revert, for a kiosk whose last visitor activity was at
/// `last_ms` (`dirty`: visitor changes since the attract show). 0 while the
/// attract show runs; the full timeout while the owner holds it unlocked.
pub fn remaining_s(c: &Config, dirty: bool, held: bool, last_ms: u32, now_ms: u32) -> u32 {
    if !c.enabled || !dirty {
        return 0;
    }
    if held {
        return c.timeout_s;
    }
    let elapsed = now_ms.wrapping_sub(last_ms);
    let total = c.timeout_s.saturating_mul(1000);
    total.saturating_sub(elapsed).div_ceil(1000)
}

// -- live state --------------------------------------------------------------

static mut CFG: Config = DEFAULT_CONFIG;
/// Bumped by every config change: the firmware persists the record when it moves.
static mut CFG_GEN: u32 = 0;
/// The firmware owes a capture of the attract frames (written before the record).
static mut CAPTURE_PENDING: bool = false;
static mut UNLOCKED: [bool; N_SRC] = [false; N_SRC];
static mut CONNECTED: [bool; N_SRC] = [false; N_SRC];
/// Visitor changes since the attract show (boot / revert / capture).
static mut DIRTY: bool = false;
static mut LAST_ACTIVITY_MS: u32 = 0;
/// A status push owed to every connection (the event), 0 = none.
static mut PUSH_EVENT: u8 = EVENT_NONE;
/// The source of the message being handled (set by the gate).
static mut CUR_SRC: u8 = SRC_INTERNAL;
/// The message being handled came in on a LOCKED connection (no persistence).
static mut MSG_LOCKED: bool = false;
static mut LOCKOUT_UNTIL_MS: Option<u32> = None;

unsafe fn any_unlocked() -> bool {
    (*addr_of!(UNLOCKED)).iter().any(|&u| u)
}

unsafe fn cfg_changed() {
    CFG_GEN = CFG_GEN.wrapping_add(1);
}

unsafe fn note_activity(now_ms: u32) {
    LAST_ACTIVITY_MS = now_ms;
    if !DIRTY {
        DIRTY = true;
        PUSH_EVENT = EVENT_ACTIVITY;
    }
}

fn write_error(out: *mut u8, cap: usize, code: &str, message: &str) -> i32 {
    unsafe {
        write_arm(out, cap, SRV_ERROR, |w| {
            w.bytes(1, code.as_bytes());
            w.bytes(2, message.as_bytes());
        })
    }
}

/// KioskStatus for source `src` into `out` (ServerMessage.kiosk_status).
unsafe fn write_status(src: u8, now_ms: u32, event: u8, out: *mut u8, cap: usize) -> i32 {
    let c = *addr_of!(CFG);
    let unlocked = (*addr_of!(UNLOCKED)).get(src as usize).copied().unwrap_or(false);
    let rem = remaining_s(&c, DIRTY, any_unlocked(), LAST_ACTIVITY_MS, now_ms);
    let attract_active = c.enabled && !DIRTY;
    write_arm(out, cap, SRV_KIOSK_STATUS, |w: &mut PbOut| {
        let b = |w: &mut PbOut, f: u32, v: bool| {
            if v {
                w.uint(f, 1)
            }
        };
        b(w, 1, c.enabled);
        w.uint(2, c.timeout_s as u64);
        if rem != 0 {
            w.uint(3, rem as u64);
        }
        b(w, 4, attract_active);
        b(w, 5, c.has_attract);
        if c.name_len > 0 {
            w.bytes(6, c.name());
        }
        if c.has_attract {
            w.fixed32(7, c.brightness.to_bits());
        }
        b(w, 8, unlocked);
        b(w, 9, c.secret_len > 0);
        if event != EVENT_NONE {
            w.uint(10, event as u64);
        }
    })
}

/// The gate: every network message, before ANY handler (OTA and sharded uploads
/// included). `src` is the connection it came in on (SRC_WSS / SRC_BLE). Returns
/// 0 to let it through, or the length of the `kiosk_locked` error reply written
/// to `out` (the transport sends it instead of handling the message).
///
/// # Safety
/// `data` readable for `len`; `out` writable for `cap`. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_gate(
    src: u8,
    data: *const u8,
    len: usize,
    now_ms: u32,
    out: *mut u8,
    cap: usize,
) -> i32 {
    CUR_SRC = src;
    MSG_LOCKED = false;
    let c = *addr_of!(CFG);
    if !c.enabled || data.is_null() || len == 0 {
        return 0;
    }
    let frame = core::slice::from_raw_parts(data, len);
    let Some(arm) = envelope_arm(frame) else {
        // Malformed: the handlers answer it (nothing to protect); never persisted.
        MSG_LOCKED = true;
        return 0;
    };
    let class = classify(arm, frame);
    if class == Class::Play {
        // The owner's changes too: what shows is no longer the captured snapshot.
        note_activity(now_ms);
    }
    if (*addr_of!(UNLOCKED)).get(src as usize).copied().unwrap_or(false) {
        return 0;
    }
    MSG_LOCKED = true;
    match class {
        Class::Read | Class::Play => 0,
        Class::Refuse => {
            if out.is_null() {
                return -1;
            }
            write_error(out, cap, "kiosk_locked", "not available while the kiosk is locked (owner: kiosk_unlock)")
        }
    }
}

/// Whether the message just gated came in on a locked connection: the firmware
/// persists nothing for it (RAM-only visitor effects / uniforms).
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_msg_locked() -> bool {
    MSG_LOCKED
}

/// The kiosk is enabled (Improv provisioning is refused while it is).
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_enabled() -> bool {
    (*addr_of!(CFG)).enabled
}

pub(crate) unsafe fn handle_get(now_ms: u32, out: *mut u8, cap: usize) -> i32 {
    write_status(CUR_SRC, now_ms, EVENT_NONE, out, cap)
}

pub(crate) unsafe fn handle_unlock(frame: &[u8], now_ms: u32, out: *mut u8, cap: usize) -> i32 {
    let Some(CArm::KioskUnlock(m)) = client_arm(frame) else {
        return write_error(out, cap, "kiosk_bad_secret", "kiosk_unlock is malformed");
    };
    if let Some(until) = LOCKOUT_UNTIL_MS {
        if (until.wrapping_sub(now_ms) as i32) > 0 {
            return write_error(out, cap, "kiosk_bad_secret", "too many attempts; try again in a moment");
        }
        LOCKOUT_UNTIL_MS = None;
    }
    let c = *addr_of!(CFG);
    if c.secret_len == 0 || !secret_eq(m.secret().as_bytes(), c.secret()) {
        LOCKOUT_UNTIL_MS = Some(now_ms.wrapping_add(UNLOCK_LOCKOUT_MS));
        return write_error(out, cap, "kiosk_bad_secret", "wrong owner secret");
    }
    if let Some(u) = (*addr_of_mut!(UNLOCKED)).get_mut(CUR_SRC as usize) {
        *u = true;
    }
    write_status(CUR_SRC, now_ms, EVENT_NONE, out, cap)
}

/// A requested config change: `None` keeps the current value.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Request<'a> {
    pub enabled: Option<bool>,
    pub timeout_s: Option<u32>,
    pub capture: bool,
    pub secret: Option<&'a [u8]>,
}

/// Apply `req` to `cur` (pure). `effect_loaded`: deck A holds an effect to capture.
/// Returns the new config and whether to capture the attract snapshot now, or the
/// error code.
pub fn apply(cur: &Config, req: &Request, effect_loaded: bool) -> Result<(Config, bool), &'static str> {
    let mut c = *cur;
    if let Some(s) = req.secret {
        if s.is_empty() || s.len() > MAX_SECRET {
            return Err("kiosk_bad_config");
        }
        c.secret = [0; MAX_SECRET];
        c.secret[..s.len()].copy_from_slice(s);
        c.secret_len = s.len() as u8;
    }
    if let Some(t) = req.timeout_s {
        c.timeout_s = t.clamp(MIN_TIMEOUT_S, MAX_TIMEOUT_S);
    }
    if let Some(e) = req.enabled {
        c.enabled = e;
    }
    if c.enabled && c.secret_len == 0 {
        return Err("kiosk_secret_required");
    }
    let capture = req.capture || (c.enabled && !c.has_attract);
    if capture && !effect_loaded {
        return Err("kiosk_no_effect");
    }
    Ok((c, capture))
}

pub(crate) unsafe fn handle_set_config(frame: &[u8], now_ms: u32, out: *mut u8, cap: usize) -> i32 {
    let c = *addr_of!(CFG);
    // The gate refuses this on a locked connection; internal callers too.
    if c.enabled && !(*addr_of!(UNLOCKED)).get(CUR_SRC as usize).copied().unwrap_or(false) {
        return write_error(out, cap, "kiosk_locked", "unlock the kiosk first (kiosk_unlock)");
    }
    let Some(CArm::SetKioskConfig(m)) = client_arm(frame) else {
        return write_error(out, cap, "kiosk_bad_config", "set_kiosk_config is malformed");
    };
    let req = Request {
        enabled: m.enabled(),
        timeout_s: m.idle_timeout_s(),
        capture: m.capture_attract_from_current(),
        secret: m.owner_secret().map(|s| s.as_bytes()),
    };
    let effect_loaded = (*addr_of!(DECK_A)).loaded();
    let (mut next, capture) = match apply(&c, &req, effect_loaded) {
        Ok(v) => v,
        Err(code) => {
            let msg = match code {
                "kiosk_secret_required" => "set an owner_secret before enabling the kiosk",
                "kiosk_no_effect" => "load an effect on deck A to capture as the attract show",
                _ => "owner_secret must be 1..32 bytes",
            };
            return write_error(out, cap, code, msg);
        }
    };
    if capture {
        let a = &*addr_of!(DECK_A);
        let n = a.id_len.min(MAX_NAME);
        next.name = [0; MAX_NAME];
        next.name[..n].copy_from_slice(&a.id[..n]);
        next.name_len = n as u8;
        next.brightness = player().output_brightness();
        next.has_attract = true;
        CAPTURE_PENDING = true;
        // What shows now IS the attract show.
        DIRTY = false;
    } else if next.enabled && !c.enabled {
        // Enabled over an older snapshot: the current show reverts after a timeout.
        DIRTY = true;
    }
    LAST_ACTIVITY_MS = now_ms;
    if next != c || capture {
        CFG = next;
        cfg_changed();
        PUSH_EVENT = EVENT_CONFIG;
    }
    write_status(CUR_SRC, now_ms, EVENT_NONE, out, cap)
}

/// Boot: the record persisted in /lfs/kiosk.cfg (`rec`/`len`, anything else keeps
/// the defaults). Returns whether the device should boot into the attract show.
///
/// # Safety
/// `rec` valid for `len` (or null). Before the loop starts.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_seed(rec: *const u8, len: usize) -> bool {
    if !rec.is_null() {
        if let Some(c) = decode(core::slice::from_raw_parts(rec, len)) {
            CFG = c;
        }
    }
    DIRTY = false;
    let c = *addr_of!(CFG);
    c.enabled && c.has_attract
}

/// The config generation: bumped by every change; the firmware persists the
/// record ([`lm_kiosk_record`]) when it moves.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_gen() -> u32 {
    CFG_GEN
}

/// The config record into `rec` (RECORD_LEN bytes); returns RECORD_LEN.
///
/// # Safety
/// `rec` writable for RECORD_LEN bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_record(rec: *mut u8) -> usize {
    if !rec.is_null() {
        core::ptr::copy_nonoverlapping(encode(&*addr_of!(CFG)).as_ptr(), rec, RECORD_LEN);
    }
    RECORD_LEN
}

/// Read + clear the capture request: the firmware then writes the attract frames
/// ([`lm_kiosk_encode_attract`]) BEFORE the record, so a power cut never leaves a
/// record pointing at a missing snapshot.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_take_capture() -> bool {
    let c = CAPTURE_PENDING;
    CAPTURE_PENDING = false;
    c
}

/// Encode an attract frame from deck A's CURRENT state into `out`: `which` 0 =
/// the effect as a ClientMessage{submit_effect{effect_id, fxb, activate}} (the
/// .fxb as uploaded, JIT patches undone), 1 = its live uniforms as a
/// ClientMessage{set_uniforms{values}}. Returns the length, -1 with no effect on
/// deck A, -2 when it doesn't fit.
///
/// # Safety
/// `out` writable for `cap`; under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_encode_attract(which: u32, out: *mut u8, cap: usize) -> i32 {
    let a = &*addr_of!(DECK_A);
    if !a.loaded() || out.is_null() {
        return -1;
    }
    match which {
        0 => write_arm(out, cap, 21, |w| {
            if a.id_len > 0 {
                w.bytes(1, &a.id[..a.id_len]);
            }
            w.key(2, 2);
            w.varint(a.len as u64);
            let orig = &*addr_of!(FX_JIT_ORIG);
            for i in 0..a.len {
                let mut b = a.bytes[i];
                for &(at, o) in orig.iter().take(FX_JIT_N) {
                    let at = at as usize;
                    if (at..at + 3).contains(&i) {
                        b = o[i - at];
                    }
                }
                w.byte(b);
            }
            w.uint(3, 1);
        }),
        1 => {
            let Some(vm) = a.vm.as_ref() else { return -1 };
            let rules = &a.morph.rules;
            let vals = rules.pack(&vm.uniforms);
            write_arm(out, cap, 23, |w| {
                rules.unpack(&vals, |slot, v| w.value_msgs(1, slot as u32, v));
            })
        }
        _ => -1,
    }
}

/// The idle revert's runtime half (after the firmware replayed the attract
/// frames under the player mutex): deck B parked, the crossfade back on deck A,
/// the snapshot's brightness. Also used at boot.
///
/// # Safety
/// Under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_apply_runtime() {
    if deck_renders(DECK_B_IDX) {
        fx_set_active(DECK_B_IDX, false);
    }
    player().kiosk_restore((*addr_of!(CFG)).brightness);
}

/// Tick bits.
pub const TICK_REVERT: u32 = 1;
pub const TICK_PUSH: u32 = 2;

/// Every loop pass: track the connections (an unlock ends when its connection
/// drops), hold the timer while the owner is unlocked, and say whether a revert
/// is due (TICK_REVERT: replay the attract frames, then [`lm_kiosk_reverted`]) or
/// a status push is owed (TICK_PUSH: send [`lm_kiosk_build_push`] to each open
/// connection, then [`lm_kiosk_push_done`]).
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_tick(now_ms: u32, wss_open: bool, ble_connected: bool) -> u32 {
    let conn = &mut *addr_of_mut!(CONNECTED);
    let unl = &mut *addr_of_mut!(UNLOCKED);
    for (src, up) in [(SRC_WSS, wss_open), (SRC_BLE, ble_connected)] {
        let i = src as usize;
        if conn[i] != up {
            conn[i] = up;
            unl[i] = false; // a new or dropped connection is never unlocked
        }
    }
    let c = *addr_of!(CFG);
    let mut bits = 0;
    if c.enabled {
        if any_unlocked() {
            LAST_ACTIVITY_MS = now_ms;
        } else if DIRTY && c.has_attract && now_ms.wrapping_sub(LAST_ACTIVITY_MS) >= c.timeout_s.saturating_mul(1000) {
            bits |= TICK_REVERT;
        }
    }
    if PUSH_EVENT != EVENT_NONE {
        bits |= TICK_PUSH;
    }
    bits
}

/// The attract show is back (the firmware replayed it): reset the timer, push.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_reverted(now_ms: u32) {
    DIRTY = false;
    LAST_ACTIVITY_MS = now_ms;
    PUSH_EVENT = EVENT_REVERTED;
}

/// The owed status push for connection `src` (SRC_WSS / SRC_BLE) into `out`.
///
/// # Safety
/// `out` writable for `cap`. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_build_push(src: u8, now_ms: u32, out: *mut u8, cap: usize) -> i32 {
    if out.is_null() {
        return -1;
    }
    write_status(src, now_ms, PUSH_EVENT, out, cap)
}

/// The owed push went out.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_push_done() {
    PUSH_EVENT = EVENT_NONE;
}

/// One console line after "kiosk" ("off" / "status"; empty = status). Writes a one-line human
/// reply into `out` (NUL-terminated) and returns its length, or -1 for an
/// unrecognised line. `off` disables the kiosk (persisted via the gen) and drops
/// every unlock — the recovery path when the owner secret is lost.
///
/// # Safety
/// `line` readable for `len`; `out` writable for `cap` (cap >= 1). Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_kiosk_console(line: *const u8, len: usize, out: *mut u8, cap: usize) -> i32 {
    if line.is_null() || out.is_null() || cap == 0 {
        return -1;
    }
    let l = core::slice::from_raw_parts(line, len);
    let word = l.split(|&b| b == b' ' || b == b'\r' || b == b'\n').find(|w| !w.is_empty()).unwrap_or(b"");
    if word.eq_ignore_ascii_case(b"off") {
        if (*addr_of!(CFG)).enabled {
            CFG.enabled = false;
            cfg_changed();
            PUSH_EVENT = EVENT_CONFIG;
        }
        *addr_of_mut!(UNLOCKED) = [false; N_SRC];
    } else if !word.is_empty() && !word.eq_ignore_ascii_case(b"status") {
        return -1;
    }
    let c = *addr_of!(CFG);
    let o = core::slice::from_raw_parts_mut(out, cap);
    let mut n = 0;
    let mut put = |s: &[u8]| {
        for &b in s {
            if n + 1 < o.len() {
                o[n] = b;
                n += 1;
            }
        }
    };
    put(b"[kiosk] ");
    put(if c.enabled { b"enabled" } else { b"disabled" });
    put(b" timeout=");
    let mut d = [0u8; 10];
    let mut i = d.len();
    let mut v = c.timeout_s;
    loop {
        i -= 1;
        d[i] = b'0' + (v % 10) as u8;
        v /= 10;
        if v == 0 {
            break;
        }
    }
    put(&d[i..]);
    put(b"s attract=");
    put(if c.has_attract { c.name() } else { b"(none)" });
    put(if c.secret_len > 0 { b" secret=set" } else { b" secret=unset" });
    put(if DIRTY { b" showing=visitor" } else { b" showing=attract" });
    o[n] = 0;
    n as i32
}
