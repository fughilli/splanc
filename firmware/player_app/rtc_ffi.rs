//! The hardware RTC on the player (docs/design/wall-clock.md "Hardware RTC"): a
//! `//firmware/rtc` chip on the sensor I2C bus as a wall-clock source, written
//! back when a better source sets the time.
//!
//! - **Boot:** sensor_bus.cpp brings the bus up, probes the IMU, then calls
//!   [`lm_rtc_begin`]: detect (config `rtc_cfg`, default autodetect) and a first
//!   read. A valid reading becomes a `HwRtc` offer (± 0.5 s plus the chip's
//!   drift spec since this lamp last wrote it, NVS `rtc_wb`) that the clock takes
//!   at its next tick. The bus stays up when an RTC answered, even with no IMU.
//! - **Running:** [`lm_rtc_poll`] on the loop task, **without** the player mutex
//!   (I2C waits must never hold up a render frame): an hourly read, the
//!   write-back when one is due, a re-detect after a config change. Render never
//!   reaches any of this.
//! - **Write-back** (`ledmapper_rtc::policy`): decided in [`exchange`], which
//!   [`super::clock_ffi::lm_clock_tick`] calls under the mutex; carried out by
//!   the next poll at the chip's set phase (the start of a UTC second; 492 ms in
//!   for a PCF8563), so the chip ends up within ~30 ms of the wall clock, and
//!   checked by a read 2 s later. At most one write per 10 min unless forced.
//!
//! Threading: every static here belongs to the loop task ([`lm_rtc_poll`],
//! [`lm_rtc_begin`] in setup, [`exchange`] from lm_clock_tick, [`lm_rtc_persist`]).
//! Handlers on other tasks never touch them: they post through clock_ffi's
//! mutex-guarded requests and read clock_ffi's copy of [`Info`].

use core::ptr::{addr_of, addr_of_mut};

use ledmapper_clock::civil::US_PER_SEC as S;
use ledmapper_clock::{Applied, Offer, Reject, WallClock};
use ledmapper_rtc::policy::{self, Writeback, WritebackInput};
use ledmapper_rtc::{detect, AnyRtc, ChipKind, RtcConfig};

/// A good chip is read this often (drift, the stop flag), µs.
const READ_EVERY_US: i64 = 3600 * S;
/// After a write, the verify read, µs.
const VERIFY_AFTER_US: i64 = 2 * S;
/// After a failed read, µs.
const RETRY_US: i64 = 60 * S;
/// Write-backs (unforced) at most this often, µs.
const MIN_WRITE_GAP_US: i64 = 600 * S;
/// A write is made within this much after the chip's set phase, µs.
const WRITE_WINDOW_US: i64 = 30_000;
/// After this long without hitting the window (a busy loop), any phase, µs.
const WRITE_WAIT_MAX_US: i64 = 5 * S;
const MAX_WRITE_TRIES: u8 = 3;

/// [`lm_rtc_poll`] bits.
pub const POLL_LOG: u32 = 1;
/// [`lm_rtc_persist`] bits.
pub const PERSIST_CFG: u32 = 1;
pub const PERSIST_WB: u32 = 2;

/// What clock_state / the status line show.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Info {
    pub configured: RtcConfig,
    /// The chip found and its address.
    pub chip: Option<(ChipKind, u8)>,
    pub time_valid: bool,
    pub battery_low: bool,
    pub temp_cc: Option<i16>,
    /// Chip − wall clock at the last reading, ms (`None` until compared).
    pub offset_ms: Option<i64>,
    /// The last good reading: chip seconds at monotonic µs.
    pub read: Option<(i64, i64)>,
    pub reads: u32,
    pub writes: u32,
    pub errors: u32,
    /// UTC seconds this lamp last wrote the chip (0 = never).
    pub last_wb_unix_s: i64,
    /// The last write-back's reason.
    pub last_reason: Writeback,
}

impl Info {
    pub(crate) const INIT: Info = Info {
        configured: RtcConfig::Auto,
        chip: None,
        time_valid: false,
        battery_low: false,
        temp_cc: None,
        offset_ms: None,
        read: None,
        reads: 0,
        writes: 0,
        errors: 0,
        last_wb_unix_s: 0,
        last_reason: Writeback::No,
    };
}

#[derive(Clone, Copy)]
struct WriteReq {
    since_us: i64,
    tries: u8,
    reason: Writeback,
}

static mut CHIP: Option<AnyRtc> = None;
static mut INFO: Info = Info::INIT;
static mut NEXT_READ_US: i64 = i64::MAX;
static mut WRITE: Option<WriteReq> = None;
static mut AWAIT_VERIFY: bool = false;
static mut LAST_WRITE_US: i64 = i64::MIN;
static mut PENDING_OFFER: Option<Offer> = None;
static mut REDETECT: bool = false;
static mut FIRST_READ: bool = true;
static mut PERSIST: u32 = 0;
static mut LOG: bool = false;

unsafe fn info() -> &'static mut Info {
    &mut *addr_of_mut!(INFO)
}

/// The loop task's copy for clock_ffi (taken under the mutex in lm_clock_tick).
pub(crate) unsafe fn snapshot() -> Info {
    *addr_of!(INFO)
}

/// Host tests: back to the power-on state.
///
/// # Safety
/// Test thread only.
#[cfg(not(target_os = "none"))]
#[no_mangle]
pub unsafe extern "C" fn lm_rtc_test_reset() {
    CHIP = None;
    INFO = Info::INIT;
    NEXT_READ_US = i64::MAX;
    WRITE = None;
    AWAIT_VERIFY = false;
    LAST_WRITE_US = i64::MIN;
    PENDING_OFFER = None;
    REDETECT = false;
    FIRST_READ = true;
    PERSIST = 0;
    LOG = false;
}

unsafe fn read_now(now_us: i64) {
    let Some(chip) = (*addr_of_mut!(CHIP)).as_mut() else {
        return;
    };
    let mut bus = super::sensor_ffi::ffi_bus();
    let i = info();
    AWAIT_VERIFY = false;
    match chip.read(&mut bus) {
        Ok(t) => {
            i.reads = i.reads.wrapping_add(1);
            if FIRST_READ {
                // Lost time across the power-off: no (or a flat) battery.
                i.battery_low = !t.valid;
                FIRST_READ = false;
                LOG = true;
            }
            if t.valid != i.time_valid {
                LOG = true;
            }
            i.time_valid = t.valid;
            i.offset_ms = None;
            i.temp_cc = chip.temperature_cc(&mut bus);
            if t.valid {
                i.read = Some((t.unix_s, now_us));
                let since = (i.last_wb_unix_s > 0).then(|| t.unix_s - i.last_wb_unix_s);
                PENDING_OFFER = policy::read_offer(t, now_us, chip.caps(), since);
            }
            NEXT_READ_US = now_us.saturating_add(READ_EVERY_US);
        }
        Err(_) => {
            if i.errors == 0 {
                LOG = true;
            }
            i.errors = i.errors.wrapping_add(1);
            NEXT_READ_US = now_us.saturating_add(RETRY_US);
        }
    }
}

unsafe fn do_detect(now_us: i64) {
    let i = info();
    CHIP = detect(&mut super::sensor_ffi::ffi_bus(), i.configured);
    i.chip = (*addr_of!(CHIP)).map(|c| (c.kind(), c.addr()));
    i.time_valid = false;
    i.offset_ms = None;
    i.read = None;
    i.temp_cc = None;
    FIRST_READ = true;
    WRITE = None;
    LOG = true;
    if i.chip.is_some() {
        read_now(now_us);
    } else {
        NEXT_READ_US = i64::MAX;
    }
}

/// Boot: the persisted config (`cfg`: RtcConfig::encode, NVS "rtc_cfg"; 0 =
/// autodetect) and when this lamp last wrote the chip (`last_wb_unix_s`, NVS
/// "rtc_wb"; 0 = never). Before [`lm_rtc_begin`].
///
/// # Safety
/// Loop task (setup).
#[no_mangle]
pub unsafe extern "C" fn lm_rtc_configure(cfg: u16, last_wb_unix_s: i64) {
    let i = info();
    i.configured = RtcConfig::decode(cfg);
    i.last_wb_unix_s = last_wb_unix_s.max(0);
}

/// Boot, with the sensor bus up and its callbacks installed (after
/// lm_sensor_begin): detect the RTC and read it once. Returns the chip found
/// (`ChipKind` wire value, 0 = none). Nothing is written to the chip here.
/// Cost with no chip: three address NACKs.
///
/// # Safety
/// Loop task (setup), the bus callbacks installed.
#[no_mangle]
pub unsafe extern "C" fn lm_rtc_begin(now_us: i64) -> u8 {
    do_detect(now_us);
    info().chip.map(|(k, _)| k as u8).unwrap_or(0)
}

/// A config change is waiting for the bus: the caller brings it up (if the pins
/// allow) before the next [`lm_rtc_poll`].
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_rtc_wants_bus() -> bool {
    REDETECT && info().configured != RtcConfig::Off
}

/// An RTC chip is detected (sensor_bus.cpp keeps the bus for it).
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_rtc_present() -> bool {
    (*addr_of!(CHIP)).is_some()
}

/// Loop task, every pass, WITHOUT the player mutex: a re-detect after a config
/// change (`bus_up`: the sensor bus exists), a due write-back, an hourly read.
/// Cheap between them (two compares). Returns [`POLL_LOG`] when a `[rtc]` line
/// is due ([`lm_rtc_status_line`]).
///
/// # Safety
/// Loop task, no other caller of the RTC concurrently.
#[no_mangle]
pub unsafe extern "C" fn lm_rtc_poll(now_us: i64, bus_up: bool) -> u32 {
    if REDETECT {
        REDETECT = false;
        if bus_up {
            do_detect(now_us);
        } else {
            CHIP = None;
            info().chip = None;
            LOG = true;
        }
    }
    if (*addr_of!(CHIP)).is_some() {
        if let Some(w) = WRITE {
            write_step(w, now_us);
        }
        if now_us >= NEXT_READ_US {
            read_now(now_us);
        }
    }
    if core::mem::take(&mut *addr_of_mut!(LOG)) {
        POLL_LOG
    } else {
        0
    }
}

unsafe fn write_step(mut w: WriteReq, now_us: i64) {
    let Some(chip) = (*addr_of_mut!(CHIP)).as_mut() else {
        return;
    };
    let Some((unix_us, _)) = super::clock_ffi::snapshot_now(now_us) else {
        WRITE = None; // the clock went invalid
        return;
    };
    let rel = unix_us - chip.set_phase_us();
    if rel.rem_euclid(S) >= WRITE_WINDOW_US && now_us - w.since_us < WRITE_WAIT_MAX_US {
        return;
    }
    let secs = rel.div_euclid(S);
    let i = info();
    match chip.set(&mut super::sensor_ffi::ffi_bus(), secs) {
        Ok(()) => {
            i.writes = i.writes.wrapping_add(1);
            i.last_wb_unix_s = secs;
            i.last_reason = w.reason;
            i.offset_ms = None;
            i.read = None; // compared again after the verify read
            PERSIST |= PERSIST_WB;
            LAST_WRITE_US = now_us;
            AWAIT_VERIFY = true;
            NEXT_READ_US = now_us.saturating_add(VERIFY_AFTER_US);
            WRITE = None;
            LOG = true;
        }
        Err(_) => {
            i.errors = i.errors.wrapping_add(1);
            w.tries += 1;
            if w.tries >= MAX_WRITE_TRIES {
                WRITE = None;
                LAST_WRITE_US = now_us;
                LOG = true;
            } else {
                w.since_us = now_us;
                WRITE = Some(w);
            }
        }
    }
}

/// A config change (set_clock_config), handed over by lm_clock_tick.
pub(crate) unsafe fn set_config(cfg: RtcConfig) {
    info().configured = cfg;
    REDETECT = true;
    PERSIST |= PERSIST_CFG;
}

/// The clock side of a tick (lm_clock_tick, under the mutex, loop task): offer a
/// fresh reading, compare the chip with the clock, decide a write-back
/// (`force`: set_wall_clock.write_rtc). Returns the reading's offer outcome.
pub(crate) unsafe fn exchange(
    clock: &mut WallClock,
    now_us: i64,
    force: bool,
) -> Option<Result<Applied, Reject>> {
    let r = (*addr_of_mut!(PENDING_OFFER))
        .take()
        .map(|o| clock.offer(o, now_us));
    let i = info();
    if i.chip.is_none() {
        return r;
    }
    // Against the clock as it stands now (a step since the reading moves it).
    if let Some((unix_s, at)) = i.read {
        i.offset_ms = clock
            .now_us(at)
            .map(|c| (unix_s * S + policy::READ_ERR_US - c).div_euclid(1000));
    }
    if (*addr_of!(WRITE)).is_some() || AWAIT_VERIFY {
        return r;
    }
    if !force
        && LAST_WRITE_US != i64::MIN
        && now_us.saturating_sub(LAST_WRITE_US) < MIN_WRITE_GAP_US
    {
        return r;
    }
    let st = clock.status(now_us);
    let since_write_s = match (st.unix_us, i.last_wb_unix_s) {
        (Some(u), wb) if wb > 0 => Some(u.div_euclid(S) - wb),
        _ => None,
    };
    let reason = policy::writeback_due(&WritebackInput {
        clock_source: st.source,
        clock_err_us: st.uncertainty_us,
        rtc_valid: i.time_valid,
        rtc_diff_us: i.offset_ms.map(|ms| ms * 1000),
        since_write_s,
        force,
    });
    if reason != Writeback::No {
        WRITE = Some(WriteReq {
            since_us: now_us,
            tries: 0,
            reason,
        });
    }
    r
}

/// What changed for NVS since the last call: [`PERSIST_CFG`] -> `*cfg`
/// (RtcConfig::encode, key "rtc_cfg"), [`PERSIST_WB`] -> `*wb_unix_s` (key
/// "rtc_wb": at most every 10 min, normally daily).
///
/// # Safety
/// Loop task; both pointers writable.
#[no_mangle]
pub unsafe extern "C" fn lm_rtc_persist(cfg: *mut u16, wb_unix_s: *mut i64) -> u32 {
    let bits = core::mem::take(&mut *addr_of_mut!(PERSIST));
    let i = info();
    if !cfg.is_null() {
        *cfg = i.configured.encode();
    }
    if !wb_unix_s.is_null() {
        *wb_unix_s = i.last_wb_unix_s;
    }
    bits
}

pub(crate) fn reason_name(r: Writeback) -> &'static str {
    match r {
        Writeback::No => "-",
        Writeback::Forced => "forced",
        Writeback::ChipInvalid => "chip-lost-time",
        Writeback::Drifted => "drifted",
        Writeback::NeverWritten => "first",
        Writeback::Daily => "daily",
    }
}

/// The `[rtc]` line (NUL-terminated) into `out`; returns its length.
/// `[rtc] RV-3028@0x52 time_valid=1 battery_low=0 off_ms=-120 temp_c=25.25 reads=2
/// writes=1 errors=0 last_write=drifted` or `[rtc] none (auto)`.
///
/// # Safety
/// `out` writable for `cap` bytes. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_rtc_status_line(out: *mut u8, cap: usize) -> usize {
    use core::fmt::Write;
    if out.is_null() || cap == 0 {
        return 0;
    }
    let mut l = super::clock_ffi::Line {
        buf: core::slice::from_raw_parts_mut(out, cap),
        n: 0,
    };
    let i = &*addr_of!(INFO);
    let cfg = match i.configured {
        RtcConfig::Auto => "auto",
        RtcConfig::Off => "off",
        RtcConfig::Chip(..) => "forced",
    };
    match i.chip {
        None => {
            let _ = write!(l, "[rtc] none ({cfg})");
        }
        Some((k, a)) => {
            let _ = write!(
                l,
                "[rtc] {}@0x{:02x} ({cfg}) time_valid={} battery_low={}",
                k.name(),
                a,
                i.time_valid as u8,
                i.battery_low as u8
            );
            if let Some(ms) = i.offset_ms {
                let _ = write!(l, " off_ms={ms}");
            }
            if let Some(t) = i.temp_cc {
                let a = t.unsigned_abs();
                let sign = if t < 0 { "-" } else { "" };
                let _ = write!(l, " temp_c={sign}{}.{:02}", a / 100, a % 100);
            }
            let _ = write!(
                l,
                " reads={} writes={} errors={} last_write={}",
                i.reads,
                i.writes,
                i.errors,
                reason_name(i.last_reason)
            );
        }
    }
    let n = l.n;
    l.buf[n] = 0;
    n
}
