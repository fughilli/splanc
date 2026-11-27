//! The wall clock on the player (docs/design/wall-clock.md): the software RTC
//! from `//firmware/clock` on `esp_timer` µs, its time zone (a POSIX TZ rule,
//! D-562), the set_wall_clock / get_clock arms and the C ABI main.cpp drives.
//!
//! - **Base:** `esp_timer_get_time()` (i64 µs, never the wrapping `millis()`),
//!   through a [`StepGuard`]: when esp_timer steps back (whole multiples of 2^24
//!   systimer ticks on the C6) the discipline's anchors move with it, so the wall
//!   clock stays continuous. The guard is fed on every clock read and by
//!   [`lm_clock_tick`] on the loop task, which also runs while the lamp is off.
//! - **Soft resets (D-568):** [`lm_clock_tick`] keeps a CRC-guarded
//!   [`CarryRecord`] in a buffer main.cpp places in RTC no-init RAM;
//!   [`lm_clock_boot`] restores it after a SW / panic / watchdog reset. A power
//!   loss leaves the clock invalid until a source returns.
//! - **Who may set it (D-569):** owners, the bridge and (later) SNTP and a
//!   hardware RTC always; a LOCKED kiosk session only while the clock is unset
//!   (and its tz only while none is set). The gate passes both arms as Read
//!   (kiosk_ffi.rs); this handler enforces the rest.
//! - **Hardware RTC** (rtc_ffi.rs, feature "rtc"): a chip on the sensor bus is
//!   a source (read at boot and hourly) and is written back when a better source
//!   sets the time; [`lm_clock_tick`] runs the exchange. set_clock_config (C 113,
//!   owner only) picks the chip; clock_state.rtc reports it.
//! - **Module time sources** ([`lm_clock_offer`] / [`lm_clock_now`],
//!   player_module.h): any LmPlayerModule (GNSS, DCF77, a P4-side RTC) offers
//!   time through a lock-free mailbox and reads the clock from any task.
//! - **Render never touches any of this.** Every entry point here runs on the
//!   loop task (the message handlers and the 20 Hz tick), so plain statics, like
//!   wifi_ffi.rs. Effects keep their own `time` / `dt` on the show epoch.

use core::ptr::{addr_of, addr_of_mut};
use core::sync::atomic::{fence, AtomicU32, AtomicU8, Ordering};

use ledmapper_clock::civil::US_PER_SEC;
use ledmapper_clock::{
    CarryRecord, Config, LocalOffset, Offer, PosixTz, Reject, Source, StepGuard, WallClock,
};
use ledmapper_rtc::{ChipKind, RtcConfig};

use super::rtc_ffi;

use super::{client_arm, write_arm, CArm, PbOut};

/// ClientMessage arms (ledmapper.proto "Wall clock").
pub const ARM_SET_WALL_CLOCK: u32 = 111;
pub const ARM_GET_CLOCK: u32 = 112;
pub const ARM_SET_CLOCK_CONFIG: u32 = 113;
/// ServerMessage.clock_state.
const SRV_CLOCK_STATE: u32 = 61;

/// WallClockPusher (wire values).
pub const PUSHER_NONE: u8 = 0;
pub const PUSHER_APP: u8 = 1;
pub const PUSHER_BRIDGE: u8 = 2;
pub const PUSHER_MANUAL: u8 = 3;
pub const PUSHER_FRONTEND: u8 = 4;

/// ClockSetResult (wire values).
pub const SET_NONE: u8 = 0;
pub const SET_ACCEPTED: u8 = 1;
pub const SET_NOT_BETTER: u8 = 2;
pub const SET_DISAGREES: u8 = 3;
pub const SET_IMPLAUSIBLE: u8 = 4;
pub const SET_LOCKED: u8 = 5;
pub const SET_BAD_TZ: u8 = 6;
pub const SET_BAD_SERVER: u8 = 7;

/// An `err_ms` of 0 means "unknown": taken as this, µs.
const UNKNOWN_ERR_US: i64 = 1_000_000;
/// The reboot gap a carried time doesn't know about (written every 50 ms; the
/// panic handler / bootloader time on top), µs.
const CARRY_GAP_ERR_US: i64 = 1_000_000;
/// How often the carry record is rewritten, µs.
const CARRY_EVERY_US: i64 = 50_000;
/// A periodic `[clock]` status line, µs (plus one on every accepted change).
const STATUS_EVERY_US: i64 = 600 * US_PER_SEC;
/// `at_device_ms` further than this from receipt is not a sync result, ms.
const MAX_AT_SKEW_MS: i64 = 60_000;
/// The persisted zone record: [tz_len][tz][name_len][name].
pub const TZ_RECORD_MAX: usize = 2 + 2 * 64;
const STR_CAP: usize = 64;

static mut CLOCK: WallClock = WallClock::new(Config::DEFAULT);
static mut GUARD: StepGuard = StepGuard::new(50_000);
static mut JUMPS: u32 = 0;
static mut TZ: PosixTz = PosixTz::UTC;
static mut TZ_STR: [u8; STR_CAP] = [0; STR_CAP];
static mut TZ_LEN: u8 = 0;
static mut TZ_NAME: [u8; STR_CAP] = [0; STR_CAP];
static mut TZ_NAME_LEN: u8 = 0;
/// Who pushed the current sample (when its source is App).
static mut PUSHED_BY: u8 = PUSHER_NONE;
/// Bumped on every zone change: main.cpp persists the record when it moves.
static mut TZ_GEN: u32 = 0;
/// Bumped on every accepted time: main.cpp logs a status line when it moves.
static mut EVENT_GEN: u32 = 0;
static mut LAST_CARRY_US: i64 = i64::MIN;
static mut LAST_STATUS_US: i64 = i64::MIN;
/// set_wall_clock.write_rtc was accepted: write the chip at the next tick.
static mut FORCE_WB: bool = false;
/// A set_clock_config RTC change for the next tick (rtc_ffi is loop-task state).
static mut RTC_CFG_REQ: Option<RtcConfig> = None;
/// The loop task's RTC info, copied under the mutex for clock_state.
static mut RTC_SHOWN: rtc_ffi::Info = rtc_ffi::Info::INIT;

// -- the monotonic base ---------------------------------------------------------

#[cfg(target_os = "none")]
extern "C" {
    /// ESP-IDF: µs since boot (systimer), present in every ESP image.
    fn esp_timer_get_time() -> i64;
}

/// Host builds: a settable fake esp_timer ([`lm_clock_test_set_mono_us`]).
#[cfg(not(target_os = "none"))]
static mut FAKE_MONO_US: i64 = 0;

#[cfg(target_os = "none")]
unsafe fn raw_mono_us() -> i64 {
    esp_timer_get_time()
}
#[cfg(not(target_os = "none"))]
unsafe fn raw_mono_us() -> i64 {
    FAKE_MONO_US
}

/// Host tests: set the fake esp_timer reading.
///
/// # Safety
/// Test thread only.
#[cfg(not(target_os = "none"))]
#[no_mangle]
pub unsafe extern "C" fn lm_clock_test_set_mono_us(us: i64) {
    FAKE_MONO_US = us;
}

/// Host tests: back to the power-on state (a chip reset clears these statics;
/// RTC no-init RAM, the caller's carry buffer, survives).
///
/// # Safety
/// Test thread only.
#[cfg(not(target_os = "none"))]
#[no_mangle]
pub unsafe extern "C" fn lm_clock_test_reset() {
    CLOCK = WallClock::new(Config::DEFAULT);
    GUARD = StepGuard::new(50_000);
    JUMPS = 0;
    TZ = PosixTz::UTC;
    TZ_LEN = 0;
    TZ_NAME_LEN = 0;
    PUSHED_BY = PUSHER_NONE;
    LAST_CARRY_US = i64::MIN;
    LAST_STATUS_US = i64::MIN;
    POOL_AT = i64::MIN;
    (*addr_of_mut!(POOL)).valid = false;
    FORCE_WB = false;
    RTC_CFG_REQ = None;
    RTC_SHOWN = rtc_ffi::Info::INIT;
    SNAP_SEQ.store(0, Ordering::Relaxed);
    SNAP = Snap::INVALID;
    MODULE_SLOT_STATE.store(0, Ordering::Relaxed);
}

/// Reads esp_timer through the step guard: a step back moves the clock's anchors
/// by the same amount, so `now_us` stays continuous.
unsafe fn mono_now() -> i64 {
    let now = raw_mono_us();
    let shift = (*addr_of_mut!(GUARD)).observe(now);
    if shift != 0 {
        clock().shift_mono(shift);
        JUMPS = JUMPS.wrapping_add(1);
        // The carry and status timers live on the raw clock too.
        LAST_CARRY_US = LAST_CARRY_US.saturating_add(shift);
        LAST_STATUS_US = LAST_STATUS_US.saturating_add(shift);
    }
    now
}

/// esp_timer step-backs the guard has absorbed since boot (an SNTP sample measured
/// across one is dropped: sntp_ffi.rs).
pub(crate) unsafe fn jumps() -> u32 {
    JUMPS
}

unsafe fn clock() -> &'static mut WallClock {
    &mut *addr_of_mut!(CLOCK)
}

unsafe fn tz_str() -> &'static [u8] {
    &(*addr_of!(TZ_STR))[..TZ_LEN as usize]
}

unsafe fn tz_name() -> &'static [u8] {
    &(*addr_of!(TZ_NAME))[..TZ_NAME_LEN as usize]
}

/// Adopt a zone (already validated). `""` is UTC.
unsafe fn set_zone(rule: &str, name: &[u8]) -> bool {
    let z = if rule.is_empty() {
        PosixTz::UTC
    } else {
        match PosixTz::parse(rule) {
            Ok(z) => z,
            Err(_) => return false,
        }
    };
    let name = &name[..name.len().min(STR_CAP)];
    if tz_str() == rule.as_bytes() && tz_name() == name {
        return true;
    }
    TZ = z;
    (*addr_of_mut!(TZ_STR))[..rule.len()].copy_from_slice(rule.as_bytes());
    TZ_LEN = rule.len() as u8;
    (*addr_of_mut!(TZ_NAME))[..name.len()].copy_from_slice(name);
    TZ_NAME_LEN = name.len() as u8;
    TZ_GEN = TZ_GEN.wrapping_add(1);
    true
}

// -- clock_state ------------------------------------------------------------------

fn zigzag(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

unsafe fn write_state(w: &mut PbOut, now_us: i64, device_ms: i64, last_set: u8) {
    let st = (*addr_of!(CLOCK)).status(now_us);
    let nz = |w: &mut PbOut, f: u32, v: u64| {
        if v != 0 {
            w.uint(f, v)
        }
    };
    if let Some(unix_us) = st.unix_us {
        w.uint(1, 1);
        w.uint(2, unix_us.div_euclid(1000) as u64);
        w.uint(3, device_ms as u64);
        let src = match st.source {
            Some(Source::Sntp) => 1,
            Some(Source::Mesh) => 2,
            Some(Source::App) => 3,
            Some(Source::HwRtc) => 4,
            Some(Source::Carry) => 5,
            None => 0,
        };
        nz(w, 4, src);
        if st.source == Some(Source::App) {
            nz(w, 5, PUSHED_BY as u64);
        }
        nz(
            w,
            6,
            (st.uncertainty_us / 1000).clamp(0, u32::MAX as i64) as u64,
        );
        nz(
            w,
            7,
            (st.age_us / US_PER_SEC).clamp(0, u32::MAX as i64) as u64,
        );
        let off = (*addr_of!(TZ)).utc_offset_s(unix_us);
        nz(w, 11, zigzag(off as i64));
        let abbrev = (*addr_of!(TZ)).name_at(unix_us);
        if !abbrev.is_empty() {
            w.bytes(12, abbrev.as_bytes());
        }
    }
    nz(w, 8, zigzag(st.rate_ppb));
    if TZ_LEN > 0 {
        w.bytes(9, tz_str());
    }
    if TZ_NAME_LEN > 0 {
        w.bytes(10, tz_name());
    }
    nz(w, 13, st.gen as u64);
    nz(w, 14, st.steps as u64);
    nz(w, 15, JUMPS as u64);
    nz(w, 16, last_set as u64);
    super::sntp_ffi::write_ntp(w, now_us);
    // The hardware RTC, as a nested RtcState (length counted first).
    let i = *addr_of!(RTC_SHOWN);
    let rtc = |w: &mut PbOut| write_rtc_state(w, &i, now_us, st.unix_us);
    let mut count = PbOut {
        buf: None,
        n: 0,
        ok: true,
    };
    rtc(&mut count);
    w.key(20, 2);
    w.varint(count.n as u64);
    rtc(w);
}

fn chip_code(c: RtcConfig) -> (u64, u64) {
    match c {
        RtcConfig::Auto => (0, 0),
        RtcConfig::Off => (15, 0),
        RtcConfig::Chip(k, a) => (k as u64, a as u64),
    }
}

fn write_rtc_state(w: &mut PbOut, i: &rtc_ffi::Info, now_us: i64, clock_unix_us: Option<i64>) {
    let nz = |w: &mut PbOut, f: u32, v: u64| {
        if v != 0 {
            w.uint(f, v)
        }
    };
    let (cfg, cfg_addr) = chip_code(i.configured);
    nz(w, 1, cfg);
    nz(w, 2, cfg_addr);
    if let Some((k, a)) = i.chip {
        w.uint(3, k as u64);
        w.uint(4, a as u64);
        w.uint(5, 1);
        nz(w, 6, i.time_valid as u64);
        nz(w, 7, i.battery_low as u64);
        if let Some(t) = i.temp_cc {
            w.uint(8, 1);
            nz(w, 9, zigzag(t as i64));
        }
        if let Some(ms) = i.offset_ms {
            nz(w, 10, zigzag(ms));
        }
        if let Some((_, at)) = i.read {
            nz(
                w,
                11,
                (now_us.saturating_sub(at) / US_PER_SEC).clamp(0, u32::MAX as i64) as u64,
            );
        }
        if let (Some(u), wb) = (clock_unix_us, i.last_wb_unix_s) {
            if wb > 0 {
                nz(
                    w,
                    12,
                    (u.div_euclid(US_PER_SEC) - wb).clamp(1, u32::MAX as i64) as u64,
                );
            }
        }
        nz(w, 13, i.reads as u64);
        nz(w, 14, i.writes as u64);
        nz(w, 15, i.errors as u64);
    }
}

unsafe fn reply_state(out: *mut u8, cap: usize, now_us: i64, device_ms: i64, last_set: u8) -> i32 {
    write_arm(out, cap, SRV_CLOCK_STATE, |w| {
        write_state(w, now_us, device_ms, last_set)
    })
}

pub(crate) unsafe fn handle_get_clock(recv_ms: i64, out: *mut u8, cap: usize) -> i32 {
    let now = mono_now();
    reply_state(out, cap, now, recv_ms, SET_NONE)
}

/// set_clock_config (owner only: the kiosk gate refuses it on a locked session): the
/// network-time settings and the RTC chip; applies what is set, replies clock_state.
/// An invalid server name changes nothing (BAD_SERVER).
pub(crate) unsafe fn handle_set_clock_config(
    frame: &[u8],
    recv_ms: i64,
    out: *mut u8,
    cap: usize,
) -> i32 {
    use ledmapper_sntp::client::Name;
    let now = mono_now();
    let mut result = SET_IMPLAUSIBLE;
    if let Some(CArm::SetClockConfig(m)) = client_arm(frame) {
        let mut cfg = super::sntp_ffi::config();
        result = SET_ACCEPTED;
        if let Some(on) = m.ntp_enabled() {
            cfg.enabled = on;
        }
        if let Some(on) = m.use_dhcp_ntp() {
            cfg.use_dhcp = on;
        }
        if m.replace_ntp_servers() {
            let mut servers = [Name::EMPTY; 2];
            let mut k = 0;
            for s in m.ntp_servers() {
                let s = s.trim();
                if s.is_empty() {
                    continue;
                }
                match (k < 2).then(|| Name::new(s.as_bytes())).flatten() {
                    Some(n) => {
                        servers[k] = n;
                        k += 1;
                    }
                    None => result = SET_BAD_SERVER,
                }
            }
            cfg.servers = servers;
        }
        if result == SET_ACCEPTED {
            super::sntp_ffi::set_config(cfg, now);
            if m.sync_now() {
                super::sntp_ffi::sync_now(now);
            }
            // `rtc_chip` / `rtc_addr`: the RTC chip, re-detected at the next tick.
            let cur = RTC_CFG_REQ.unwrap_or((*addr_of!(RTC_SHOWN)).configured);
            let chip = m.rtc_chip().map(|c| c as i32);
            let addr = m.rtc_addr().filter(|&a| a < 0x80).map(|a| a as u8);
            let next = match (chip, addr) {
                (Some(0), _) => Some(RtcConfig::Auto),
                (Some(15), _) => Some(RtcConfig::Off),
                (Some(c), a) => {
                    ChipKind::from_u8(c.clamp(0, 255) as u8).map(|k| RtcConfig::Chip(k, a.unwrap_or(0)))
                }
                (None, Some(a)) => match cur {
                    RtcConfig::Chip(k, _) => Some(RtcConfig::Chip(k, a)),
                    other => Some(other),
                },
                (None, None) => None,
            };
            if let Some(c) = next {
                RTC_CFG_REQ = Some(c);
                // Shown at once; the chip follows at the next tick.
                (*addr_of_mut!(RTC_SHOWN)).configured = c;
            }
        }
    }
    reply_state(out, cap, now, recv_ms, result)
}

/// Offers a network-time sample (`Source::Sntp`); returns the ClockSetResult. The
/// netstack's samples arrive through [`lm_clock_tick`]; the P4's esp_sntp through
/// [`lm_clock_offer_sntp`].
unsafe fn offer_sntp(unix_us: i64, at_mono_us: i64, err_us: i64, now: i64) -> u8 {
    let offer = Offer::new(Source::Sntp, unix_us, at_mono_us, err_us.max(1000));
    let r = match clock().offer(offer, now) {
        Ok(_) => {
            PUSHED_BY = PUSHER_NONE;
            EVENT_GEN = EVENT_GEN.wrapping_add(1);
            SET_ACCEPTED
        }
        Err(Reject::NotBetter { .. }) => SET_NOT_BETTER,
        Err(Reject::Disagrees { .. }) => SET_DISAGREES,
        Err(Reject::BeforeFloor | Reject::Malformed) => SET_IMPLAUSIBLE,
    };
    super::sntp_ffi::note_offer(r);
    r
}

/// The P4's esp_sntp (IDF lwIP, Ethernet): "UTC was `unix_us` at esp_timer
/// `at_mono_us`, ± `err_us`". Returns the ClockSetResult.
///
/// # Safety
/// Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_clock_offer_sntp(unix_us: i64, at_mono_us: i64, err_us: i64) -> u8 {
    let now = mono_now();
    offer_sntp(unix_us, at_mono_us, err_us, now)
}

/// What a set_wall_clock asks for, decoded (testable without the wire).
#[derive(Clone, Copy, Debug)]
pub struct SetRequest<'a> {
    pub unix_ms: i64,
    pub at_device_ms: Option<i64>,
    pub err_ms: u32,
    pub pushed_by: u8,
    pub tz: Option<&'a str>,
    pub tz_name: Option<&'a str>,
    /// Write the hardware RTC once accepted (owners only).
    pub write_rtc: bool,
}

/// Applies a set_wall_clock at monotonic `now_us` (received at device ms
/// `recv_ms`) from a session that is `locked` (a kiosk visitor). Returns the
/// ClockSetResult.
pub(crate) unsafe fn apply_set(req: &SetRequest, now_us: i64, recv_ms: i64, locked: bool) -> u8 {
    let mut result = SET_NONE;
    if let Some(rule) = req.tz {
        // A visitor may only fill in a zone the owner never set.
        if !locked || TZ_LEN == 0 {
            let name = req.tz_name.unwrap_or("").as_bytes();
            if !set_zone(rule, name) {
                result = SET_BAD_TZ;
            }
        }
    }
    if req.unix_ms == 0 {
        return result;
    }
    if locked && clock().is_valid() {
        return SET_LOCKED;
    }
    let age_ms = match req.at_device_ms {
        Some(at) => (recv_ms.saturating_sub(at)).clamp(-MAX_AT_SKEW_MS, MAX_AT_SKEW_MS),
        None => 0,
    };
    let at_mono = now_us.saturating_sub(age_ms.saturating_mul(1000));
    let err_us = if req.err_ms == 0 {
        UNKNOWN_ERR_US
    } else {
        req.err_ms as i64 * 1000
    };
    let unix_us = req.unix_ms.saturating_mul(1000);
    if unix_us < clock().config().min_unix_us {
        return SET_IMPLAUSIBLE;
    }
    let offer = Offer::new(Source::App, unix_us, at_mono, err_us);
    if req.pushed_by == PUSHER_MANUAL && !locked {
        // An explicit set replaces the time even when it is less certain.
        clock().invalidate();
    }
    let r = match clock().offer(offer, now_us) {
        Ok(_) => {
            PUSHED_BY = req.pushed_by;
            EVENT_GEN = EVENT_GEN.wrapping_add(1);
            if req.write_rtc && !locked {
                FORCE_WB = true;
            }
            SET_ACCEPTED
        }
        Err(Reject::NotBetter { .. }) => SET_NOT_BETTER,
        Err(Reject::Disagrees { .. }) => SET_DISAGREES,
        Err(Reject::BeforeFloor | Reject::Malformed) => SET_IMPLAUSIBLE,
    };
    if result == SET_BAD_TZ {
        result
    } else {
        r
    }
}

pub(crate) unsafe fn handle_set_wall_clock(
    frame: &[u8],
    recv_ms: i64,
    out: *mut u8,
    cap: usize,
) -> i32 {
    let now = mono_now();
    let locked = super::kiosk_ffi::msg_locked();
    let mut result = SET_IMPLAUSIBLE;
    if let Some(CArm::SetWallClock(m)) = client_arm(frame) {
        let req = SetRequest {
            unix_ms: m.unix_ms(),
            at_device_ms: m.at_device_ms(),
            err_ms: m.err_ms(),
            pushed_by: (m.pushed_by() as i32).clamp(0, 255) as u8,
            tz: m.tz(),
            tz_name: m.tz_name(),
            write_rtc: m.write_rtc(),
        };
        result = apply_set(&req, now, recv_ms, locked);
    }
    reply_state(out, cap, now, recv_ms, result)
}

// -- the effect clock uniforms (uniform_pool.rs) -------------------------------------
//
// Render never reads the clock statics above. The loop task (this module, under the
// player mutex) keeps a small cache: the local time of day at a raw esp_timer anchor
// plus the local date. Render extrapolates from the anchor with one esp_timer read,
// only while an effect binds a `clock*` uniform (docs/design/wall-clock.md).

/// The cached local time for the pool, refreshed by the loop task.
#[derive(Clone, Copy)]
struct PoolClock {
    valid: bool,
    /// Raw esp_timer µs of the reading (the step guard's input, not its output).
    anchor_raw_us: i64,
    /// Local µs since local midnight at the anchor.
    tod_us: i64,
    /// 0 = Sunday.
    weekday: u8,
    year: i32,
    month: u8,
    day: u8,
}

static mut POOL: PoolClock = PoolClock {
    valid: false,
    anchor_raw_us: 0,
    tod_us: 0,
    weekday: 0,
    year: 0,
    month: 0,
    day: 0,
};
static mut POOL_AT: i64 = i64::MIN;
static mut POOL_SEEN: (u32, u32) = (0, 0);
/// How often the loop task re-reads the wall clock for the pool, µs.
const POOL_REFRESH_US: i64 = 250_000;
/// Render extrapolates at most this far past the last refresh (a loop task busy
/// for longer, e.g. an OTA write, freezes the uniforms rather than guessing), µs.
const POOL_MAX_EXTRAP_US: i64 = 60 * US_PER_SEC;

/// Re-read the wall clock into the pool cache now (loop task, under the mutex).
pub(crate) unsafe fn pool_refresh() {
    let now = mono_now();
    let p = &mut *addr_of_mut!(POOL);
    POOL_AT = now;
    POOL_SEEN = (EVENT_GEN, TZ_GEN);
    let Some(utc) = clock().now_us(now) else {
        p.valid = false;
        return;
    };
    let lt = ledmapper_clock::local::to_local(utc, &*addr_of!(TZ));
    *p = PoolClock {
        valid: true,
        anchor_raw_us: now,
        tod_us: lt.seconds_of_day() as i64 * US_PER_SEC + lt.micros as i64,
        weekday: lt.weekday().days_from_sunday(),
        year: lt.year as i32,
        month: lt.month,
        day: lt.day,
    };
}

/// Refresh the pool cache when it is due: every 250 ms, on any accepted time or
/// zone change, and after an esp_timer step back.
unsafe fn pool_tick(now: i64) {
    if !super::uniform_pool::clock_bound() {
        return;
    }
    let stale = POOL_AT == i64::MIN
        || now.saturating_sub(POOL_AT) >= POOL_REFRESH_US
        || POOL_AT > now
        || POOL_SEEN != (EVENT_GEN, TZ_GEN);
    if stale {
        pool_refresh();
    }
}

/// This frame's clock uniform values (render task, under the player mutex):
/// `clock` (hour, minute, second, weekday), `clock_day` (0..1), `clock_date`
/// (year, month, day). None while the clock is invalid.
pub(crate) unsafe fn pool_frame() -> Option<([f32; 4], f32, [f32; 3])> {
    let p = *addr_of!(POOL);
    if !p.valid {
        return None;
    }
    let dt = raw_mono_us()
        .saturating_sub(p.anchor_raw_us)
        .clamp(0, POOL_MAX_EXTRAP_US);
    let mut tod = p.tod_us + dt;
    let mut wd = p.weekday;
    let day_us = ledmapper_clock::civil::US_PER_DAY;
    if tod >= day_us {
        // Midnight passed since the refresh (the date catches up at the next one).
        tod -= day_us;
        wd = (wd + 1) % 7;
    }
    let secs = tod / US_PER_SEC;
    let clock = [
        (secs / 3600) as f32,
        ((secs / 60) % 60) as f32,
        (secs % 60) as f32 + (tod % US_PER_SEC) as f32 * 1e-6,
        wd as f32,
    ];
    let day = (tod as f64 / day_us as f64) as f32;
    Some((clock, day, [p.year as f32, p.month as f32, p.day as f32]))
}

// -- module time sources and readers (player_module.h) ---------------------------------

/// The clock as last published by the loop task: `unix_us` (± `err_us`, growing
/// at `ppm`) at monotonic `mono_us`. Lock-free for any task (a seqlock).
#[derive(Clone, Copy)]
struct Snap {
    valid: bool,
    mono_us: i64,
    unix_us: i64,
    err_us: i64,
    ppm: u32,
}

impl Snap {
    const INVALID: Snap = Snap {
        valid: false,
        mono_us: 0,
        unix_us: 0,
        err_us: 0,
        ppm: 0,
    };
}

static SNAP_SEQ: AtomicU32 = AtomicU32::new(0);
static mut SNAP: Snap = Snap::INVALID;

unsafe fn publish_snapshot(now_us: i64) {
    let st = (*addr_of!(CLOCK)).status(now_us);
    let s = match st.unix_us {
        Some(u) => Snap {
            valid: true,
            mono_us: now_us,
            unix_us: u,
            err_us: st.uncertainty_us,
            ppm: st.source.map(|s| s.default_drift_ppm()).unwrap_or(40),
        },
        None => Snap::INVALID,
    };
    let seq = SNAP_SEQ.load(Ordering::Relaxed);
    SNAP_SEQ.store(seq.wrapping_add(1), Ordering::Relaxed);
    fence(Ordering::Release);
    core::ptr::write_volatile(addr_of_mut!(SNAP), s);
    fence(Ordering::Release);
    SNAP_SEQ.store(seq.wrapping_add(2), Ordering::Release);
}

unsafe fn read_snapshot() -> Option<Snap> {
    // Bounded: a reader that preempted the writer mid-publish must not spin.
    for _ in 0..4 {
        let s1 = SNAP_SEQ.load(Ordering::Acquire);
        if s1 & 1 == 0 {
            let s = core::ptr::read_volatile(addr_of!(SNAP));
            fence(Ordering::Acquire);
            if SNAP_SEQ.load(Ordering::Relaxed) == s1 {
                return Some(s);
            }
        }
    }
    None
}

/// The wall clock at raw monotonic `mono_us` from the published snapshot:
/// `(unix_us, err_us)`, or `None` while invalid. Any task.
pub(crate) unsafe fn snapshot_now(mono_us: i64) -> Option<(i64, i64)> {
    let s = read_snapshot()?;
    if !s.valid {
        return None;
    }
    let age = mono_us.saturating_sub(s.mono_us).max(0);
    let grow = (age as i128 * s.ppm as i128 / 1_000_000) as i64;
    Some((s.unix_us.saturating_add(age), s.err_us.saturating_add(grow)))
}

/// lm_clock_offer source codes (player_module.h LM_CLOCK_SRC_*).
pub const MODULE_SRC_REFERENCE: u8 = 1;
pub const MODULE_SRC_PUSH: u8 = 3;
pub const MODULE_SRC_RTC: u8 = 4;

/// The module-offer mailbox: 0 empty, 1 being written, 2 full.
static MODULE_SLOT_STATE: AtomicU8 = AtomicU8::new(0);
static mut MODULE_SLOT: Offer = Offer::new(Source::App, 0, 0, 0);

/// A player module offers the time: `unix_ms` (UTC) was true at esp_timer µs
/// `at_us`, ± `err_ms`, from `source` (LM_CLOCK_SRC_*). The discipline takes it
/// at the next loop pass if it is more certain than the current time (the same
/// ranking, sanity window and build-date floor as every source). Any task; never
/// blocks. Returns 0 queued, 1 busy (an earlier offer is not taken yet: retry),
/// -1 refused (bad source, time or error).
///
/// # Safety
/// None beyond the C ABI.
#[no_mangle]
pub unsafe extern "C" fn lm_clock_offer(unix_ms: i64, at_us: i64, err_ms: u32, source: u8) -> i32 {
    let src = match source {
        MODULE_SRC_REFERENCE => Source::Sntp,
        MODULE_SRC_PUSH => Source::App,
        MODULE_SRC_RTC => Source::HwRtc,
        _ => return -1,
    };
    if unix_ms <= 0 || err_ms == 0 {
        return -1;
    }
    if MODULE_SLOT_STATE
        .compare_exchange(0, 1, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return 1;
    }
    core::ptr::write_volatile(
        addr_of_mut!(MODULE_SLOT),
        Offer::new(
            src,
            unix_ms.saturating_mul(1000),
            at_us,
            err_ms as i64 * 1000,
        ),
    );
    MODULE_SLOT_STATE.store(2, Ordering::Release);
    0
}

/// The wall clock now: UTC ms into `*unix_ms` and its error bound into
/// `*err_ms` (either may be null). False (outputs untouched) while the clock is
/// not set. Any task, including render (frame hook): a few integer ops on the
/// snapshot the loop task publishes every pass.
///
/// # Safety
/// The pointers, when not null, are writable.
#[no_mangle]
pub unsafe extern "C" fn lm_clock_now(unix_ms: *mut i64, err_ms: *mut u32) -> bool {
    let Some((u, e)) = snapshot_now(raw_mono_us()) else {
        return false;
    };
    if !unix_ms.is_null() {
        *unix_ms = u.div_euclid(1000);
    }
    if !err_ms.is_null() {
        *err_ms = (e / 1000).clamp(0, u32::MAX as i64) as u32;
    }
    true
}

/// The tick's share: a module offer, the RTC exchange, the published snapshot.
unsafe fn tick_sources(now: i64) {
    if MODULE_SLOT_STATE.load(Ordering::Acquire) == 2 {
        let o = core::ptr::read_volatile(addr_of!(MODULE_SLOT));
        MODULE_SLOT_STATE.store(0, Ordering::Release);
        if clock().offer(o, now).is_ok() {
            PUSHED_BY = PUSHER_NONE;
            EVENT_GEN = EVENT_GEN.wrapping_add(1);
        }
    }
    if let Some(c) = (*addr_of_mut!(RTC_CFG_REQ)).take() {
        rtc_ffi::set_config(c);
    }
    let force = core::mem::take(&mut *addr_of_mut!(FORCE_WB));
    if let Some(Ok(_)) = rtc_ffi::exchange(clock(), now, force) {
        PUSHED_BY = PUSHER_NONE;
        EVENT_GEN = EVENT_GEN.wrapping_add(1);
    }
    RTC_SHOWN = rtc_ffi::snapshot();
    publish_snapshot(now);
}

// -- C ABI for main.cpp -------------------------------------------------------------

/// Boot: restore the zone record (`tz_rec`, from NVS; may be null) and, after a
/// SOFT reset (`soft`: SW, panic, watchdog), the carried time in `carry` (the
/// RTC no-init buffer, [`CARRY_BYTES`](ledmapper_clock::carry::CARRY_BYTES)).
/// Returns true when the time was restored.
///
/// # Safety
/// `carry` readable for 28 bytes (or null); `tz_rec` readable for `tz_len`.
/// Loop task (setup), before any message.
#[no_mangle]
pub unsafe extern "C" fn lm_clock_boot(
    carry: *const u8,
    soft: bool,
    tz_rec: *const u8,
    tz_len: usize,
) -> bool {
    if !tz_rec.is_null() && tz_len >= 2 {
        let r = core::slice::from_raw_parts(tz_rec, tz_len);
        let n = r[0] as usize;
        if n <= STR_CAP && r.len() > 1 + n {
            let m = r[1 + n] as usize;
            if m <= STR_CAP && r.len() >= 2 + n + m {
                if let Ok(rule) = core::str::from_utf8(&r[1..1 + n]) {
                    set_zone(rule, &r[2 + n..2 + n + m]);
                    // Restored, not changed: nothing to persist.
                    TZ_GEN = 0;
                }
            }
        }
    }
    let now = mono_now();
    if !soft || carry.is_null() {
        return false;
    }
    let mut b = [0u8; ledmapper_clock::carry::CARRY_BYTES];
    b.copy_from_slice(core::slice::from_raw_parts(
        carry,
        ledmapper_clock::carry::CARRY_BYTES,
    ));
    let Some(rec) = CarryRecord::decode(&b) else {
        return false;
    };
    // esp_timer restarts at the reset, so the carried instant sits at about mono 0;
    // the unknown part of the gap is in the error.
    let offer = rec.to_offer(0, CARRY_GAP_ERR_US);
    let ok = clock().offer(offer, now).is_ok();
    if ok {
        PUSHED_BY = PUSHER_NONE;
        EVENT_GEN = EVENT_GEN.wrapping_add(1);
    }
    ok
}

/// The loop task, every pass (cheap: a timer read and a compare between the
/// 20 Hz carry writes). Keeps the step guard fed while the lamp is off, rewrites
/// the carry record in `carry` (28 bytes of RTC no-init RAM; zeroed while the
/// clock is invalid). Returns bit 1 when the zone changed since the last
/// [`lm_clock_tz_record`], bit 2 when a `[clock]` status line is due
/// ([`lm_clock_status_line`]), bit 4 when the network-time config changed
/// (persist `lm_sntp_config_record`). Offers a finished SNTP round to the clock.
///
/// # Safety
/// `carry` writable for 28 bytes (or null). Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_clock_tick(carry: *mut u8) -> u32 {
    static mut SEEN_TZ_GEN: u32 = 0;
    static mut SEEN_EVENT_GEN: u32 = 0;
    static mut SEEN_NTP_GEN: u32 = 0;
    let now = mono_now();
    tick_sources(now);
    let mut bits = 0;
    // A network-time round finished: offer it, unless esp_timer stepped since.
    if let Some((s, at_jumps)) = super::sntp_ffi::take_pending() {
        if at_jumps == JUMPS {
            offer_sntp(s.unix_us, s.at_mono_us, s.err_us, now);
        }
    }
    if super::sntp_ffi::cfg_gen() != SEEN_NTP_GEN {
        SEEN_NTP_GEN = super::sntp_ffi::cfg_gen();
        bits |= 4;
    }
    if LAST_CARRY_US == i64::MIN
        || now.saturating_sub(LAST_CARRY_US) >= CARRY_EVERY_US
        || LAST_CARRY_US > now
    {
        LAST_CARRY_US = now;
        if !carry.is_null() {
            let out = core::slice::from_raw_parts_mut(carry, ledmapper_clock::carry::CARRY_BYTES);
            match (*addr_of!(CLOCK)).carry_record(now) {
                Some(rec) => out.copy_from_slice(&rec.encode()),
                None => out.fill(0),
            }
        }
    }
    pool_tick(now);
    if TZ_GEN != SEEN_TZ_GEN {
        bits |= 1;
    }
    let due = clock().is_valid()
        && (LAST_STATUS_US == i64::MIN || now.saturating_sub(LAST_STATUS_US) >= STATUS_EVERY_US);
    if EVENT_GEN != SEEN_EVENT_GEN || due {
        SEEN_EVENT_GEN = EVENT_GEN;
        LAST_STATUS_US = now;
        bits |= 2;
    }
    if bits & 1 != 0 {
        SEEN_TZ_GEN = TZ_GEN;
    }
    bits
}

/// Rewrites the carry record now (before a deliberate restart), as
/// [`lm_clock_tick`] does every 50 ms.
///
/// # Safety
/// `carry` writable for 28 bytes. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_clock_save(carry: *mut u8) {
    LAST_CARRY_US = i64::MIN;
    lm_clock_tick(carry);
}

/// The zone record to persist (NVS "clk_tz"): `[len][rule][len][name]`. Returns
/// its length.
///
/// # Safety
/// `out` writable for [`TZ_RECORD_MAX`] bytes. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_clock_tz_record(out: *mut u8) -> usize {
    let o = core::slice::from_raw_parts_mut(out, TZ_RECORD_MAX);
    let (r, n) = (tz_str(), tz_name());
    o[0] = r.len() as u8;
    o[1..1 + r.len()].copy_from_slice(r);
    o[1 + r.len()] = n.len() as u8;
    o[2 + r.len()..2 + r.len() + n.len()].copy_from_slice(n);
    2 + r.len() + n.len()
}

/// Small no_std formatter into a byte buffer.
pub(crate) struct Line<'a> {
    pub(crate) buf: &'a mut [u8],
    pub(crate) n: usize,
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

/// The `[clock]` status line (NUL-terminated) into `out`; returns its length.
/// `[clock] valid=1 src=push/app unix_ms=… local=2026-11-25T09:30:00 CET off=3600
/// err_ms=4 age_s=12 drift_ppb=0 gen=1 steps=1 jumps=0 tz="CET-1CEST,…"`.
///
/// # Safety
/// `out` writable for `cap` bytes. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_clock_status_line(out: *mut u8, cap: usize) -> usize {
    use core::fmt::Write;
    if out.is_null() || cap == 0 {
        return 0;
    }
    let now = mono_now();
    let mut l = Line {
        buf: core::slice::from_raw_parts_mut(out, cap),
        n: 0,
    };
    let st = (*addr_of!(CLOCK)).status(now);
    let src = match (st.source, PUSHED_BY) {
        (Some(Source::Sntp), _) => "sntp",
        (Some(Source::Mesh), _) => "mesh",
        (Some(Source::App), PUSHER_APP) => "push/app",
        (Some(Source::App), PUSHER_BRIDGE) => "push/bridge",
        (Some(Source::App), PUSHER_MANUAL) => "push/manual",
        (Some(Source::App), PUSHER_FRONTEND) => "push/frontend",
        (Some(Source::App), _) => "push",
        (Some(Source::HwRtc), _) => "rtc",
        (Some(Source::Carry), _) => "carry",
        (None, _) => "none",
    };
    let _ = write!(
        l,
        "[clock] valid={} src={}",
        st.unix_us.is_some() as u8,
        src
    );
    if let Some(u) = st.unix_us {
        let tz = &*addr_of!(TZ);
        let lt = ledmapper_clock::local::to_local(u, tz);
        let _ = write!(
            l,
            " unix_ms={} local={:04}-{:02}-{:02}T{:02}:{:02}:{:02} {} off={} err_ms={} age_s={}",
            u.div_euclid(1000),
            lt.year,
            lt.month,
            lt.day,
            lt.hour,
            lt.minute,
            lt.second,
            tz.name_at(u),
            tz.utc_offset_s(u),
            st.uncertainty_us / 1000,
            st.age_us / US_PER_SEC,
        );
    }
    if let Some((k, _)) = (*addr_of!(RTC_SHOWN)).chip {
        let _ = write!(l, " rtc={}", k.name());
    }
    let _ = write!(
        l,
        " drift_ppb={} gen={} steps={} jumps={} tz=\"{}\"",
        st.rate_ppb,
        st.gen,
        st.steps,
        JUMPS,
        core::str::from_utf8(tz_str()).unwrap_or("")
    );
    let n = l.n;
    l.buf[n] = 0;
    n
}

/// The console `CLOCK STATUS` (the same line).
///
/// # Safety
/// As [`lm_clock_status_line`].
#[no_mangle]
pub unsafe extern "C" fn lm_clock_console(out: *mut u8, cap: usize) -> usize {
    lm_clock_status_line(out, cap)
}
