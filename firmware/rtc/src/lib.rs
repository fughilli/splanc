//! Hardware real-time-clock chips on the sensor I2C bus (docs/design/wall-clock.md
//! "Hardware RTC"): the [`RtcChip`] trait, three native drivers and the registry
//! that finds one.
//!
//! - [`ds3231`]: Maxim/ADI DS3231 (0x68): TCXO, ±2 ppm, temperature, two alarms,
//!   aging trim. Shares 0x68 with the MPU-6050, so it is identified by register
//!   signature, never by address alone.
//! - [`pcf8563`]: NXP PCF8563 / BM8563 (0x51): VL flag, one minute alarm.
//! - [`rv3028`]: Micro Crystal RV-3028-C7 (0x52): ±1–3 ppm, 45 nA, ID register,
//!   alarm, EEPROM-backed config (the backup switch-over this driver turns on).
//!
//! The chip always holds **UTC** (never local time), 2000–2099. A chip that lost
//! time (oscillator stop, VL, power-on reset flag) reads as `valid = false`; a
//! [`RtcChip::set`] clears the flag. Probes are read-only: nothing is written to
//! a device until it identified itself (or the owner forced the chip in config).
//!
//! Adding a chip: one file implementing [`RtcChip`], one [`AnyRtc`] arm, one line
//! in [`detect`]'s order.
//!
//! `no_std`, no allocation, the sensor core's [`I2cBus`] seam (host tests drive
//! register-file fakes). The player app (`firmware/player_app/rtc_ffi.rs`) runs it
//! on the loop task; the render path never touches it.

#![no_std]

pub mod ds3231;
pub mod pcf8563;
pub mod policy;
pub mod rv3028;

pub use ds3231::Ds3231;
pub use ledmapper_sensor::{BusError, I2cBus};
pub use pcf8563::Pcf8563;
pub use rv3028::Rv3028;

use ledmapper_clock::civil::{DateTime, US_PER_SEC};

/// A chip reading: whole UTC seconds. `valid = false`: the chip lost time since
/// it was last set (oscillator stopped, battery missing or flat); `unix_s` is
/// then whatever the registers hold (0 when they don't decode) and must not be
/// trusted.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RtcTime {
    pub unix_s: i64,
    pub valid: bool,
}

/// What a chip can do.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RtcCaps {
    /// [`RtcChip::temperature_cc`] answers.
    pub temperature: bool,
    /// [`RtcChip::set_alarm`] / [`RtcChip::alarm_fired`] work.
    pub alarm: bool,
    /// Rate error spec, ppb (a sample's error grows at this once read).
    pub drift_ppb: u32,
    /// The chip has a rate trim (DS3231 aging register, RV-3028 EEPROM offset).
    pub trim: bool,
    /// The alarm's resolution, s (60: minute alarms; a set is rounded up).
    pub alarm_step_s: u32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RtcError {
    /// The bus transaction failed (the chip went away, a stuck bus).
    Bus(BusError),
    /// The chip claims its time is good but the registers don't decode.
    BadData,
    /// Outside 2000-01-01 .. 2099-12-31 (or the century bit is set).
    OutOfRange,
    /// This chip has no such feature.
    Unsupported,
}

impl From<BusError> for RtcError {
    fn from(e: BusError) -> Self {
        RtcError::Bus(e)
    }
}

/// First and last second the chips' two-digit years can hold (UTC).
pub const MIN_UNIX_S: i64 = 946_684_800; // 2000-01-01T00:00:00Z
pub const MAX_UNIX_S: i64 = 4_102_444_799; // 2099-12-31T23:59:59Z

/// One RTC chip type. Implementations are small value types holding the address
/// (and any per-chip state); every bus access goes through the caller's bus.
pub trait RtcChip: Sized {
    /// Display name ("DS3231").
    const NAME: &'static str;
    /// The addresses it can answer at, default first.
    const ADDRS: &'static [u8];
    /// The wire value (proto `RtcChip`).
    const KIND: ChipKind;
    /// Where in the UTC second [`RtcChip::set`] should be called (µs after the
    /// second starts) so the chip's next tick lands on the next whole second.
    /// 0 for chips whose divider restarts when the seconds register is written.
    const SET_PHASE_US: i64 = 0;

    /// Identify the chip at `addr` from its registers. Read-only: no writes to a
    /// device that hasn't identified itself.
    fn probe(bus: &mut dyn I2cBus, addr: u8) -> Option<Self>;
    /// Take the chip at `addr` without the signature check (the owner said what
    /// is there). It must still ACK.
    fn attach(bus: &mut dyn I2cBus, addr: u8) -> Option<Self>;
    fn addr(&self) -> u8;
    fn caps(&self) -> RtcCaps;
    fn read(&mut self, bus: &mut dyn I2cBus) -> Result<RtcTime, RtcError>;
    /// Set the time (UTC whole seconds) and clear the lost-time flag.
    fn set(&mut self, bus: &mut dyn I2cBus, unix_s: i64) -> Result<(), RtcError>;
    /// The die temperature, centi-°C.
    fn temperature_cc(&mut self, _bus: &mut dyn I2cBus) -> Option<i16> {
        None
    }
    /// Arm the alarm for `unix_s` (UTC; rounded up to [`RtcCaps::alarm_step_s`];
    /// matched on day-of-month + time, so within the next month), or disarm it
    /// (`None`). Clears a pending alarm flag either way.
    fn set_alarm(&mut self, _bus: &mut dyn I2cBus, _unix_s: Option<i64>) -> Result<(), RtcError> {
        Err(RtcError::Unsupported)
    }
    /// The alarm has fired since it was armed.
    fn alarm_fired(&mut self, _bus: &mut dyn I2cBus) -> Result<bool, RtcError> {
        Err(RtcError::Unsupported)
    }
}

/// The supported chips (proto `RtcChip` wire values).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum ChipKind {
    Ds3231 = 1,
    Pcf8563 = 2,
    Rv3028 = 3,
}

impl ChipKind {
    pub const fn from_u8(v: u8) -> Option<Self> {
        match v {
            1 => Some(ChipKind::Ds3231),
            2 => Some(ChipKind::Pcf8563),
            3 => Some(ChipKind::Rv3028),
            _ => None,
        }
    }
    pub const fn name(self) -> &'static str {
        match self {
            ChipKind::Ds3231 => Ds3231::NAME,
            ChipKind::Pcf8563 => Pcf8563::NAME,
            ChipKind::Rv3028 => Rv3028::NAME,
        }
    }
    pub const fn default_addr(self) -> u8 {
        match self {
            ChipKind::Ds3231 => Ds3231::ADDRS[0],
            ChipKind::Pcf8563 => Pcf8563::ADDRS[0],
            ChipKind::Rv3028 => Rv3028::ADDRS[0],
        }
    }
}

/// Which chip to use. The default is autodetect.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum RtcConfig {
    /// Probe every supported chip at its addresses (signature checked).
    #[default]
    Auto,
    /// No hardware RTC: never probe.
    Off,
    /// This chip at this address (0 = its default), no signature check.
    Chip(ChipKind, u8),
}

impl RtcConfig {
    /// The persisted / wire form: `chip | addr << 8` (chip 0 = auto, 15 = off).
    pub const fn encode(self) -> u16 {
        match self {
            RtcConfig::Auto => 0,
            RtcConfig::Off => 15,
            RtcConfig::Chip(k, a) => k as u16 | (a as u16) << 8,
        }
    }
    pub const fn decode(v: u16) -> Self {
        let chip = (v & 0xFF) as u8;
        let addr = (v >> 8) as u8;
        match chip {
            15 => RtcConfig::Off,
            _ => match ChipKind::from_u8(chip) {
                Some(k) => RtcConfig::Chip(k, addr),
                None => RtcConfig::Auto,
            },
        }
    }
}

/// The detected chip.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AnyRtc {
    Ds3231(Ds3231),
    Pcf8563(Pcf8563),
    Rv3028(Rv3028),
}

macro_rules! each {
    ($self:expr, $c:ident => $e:expr) => {
        match $self {
            AnyRtc::Ds3231($c) => $e,
            AnyRtc::Pcf8563($c) => $e,
            AnyRtc::Rv3028($c) => $e,
        }
    };
}

impl AnyRtc {
    pub fn kind(&self) -> ChipKind {
        match self {
            AnyRtc::Ds3231(_) => ChipKind::Ds3231,
            AnyRtc::Pcf8563(_) => ChipKind::Pcf8563,
            AnyRtc::Rv3028(_) => ChipKind::Rv3028,
        }
    }
    pub fn name(&self) -> &'static str {
        self.kind().name()
    }
    pub fn addr(&self) -> u8 {
        each!(self, c => c.addr())
    }
    pub fn caps(&self) -> RtcCaps {
        each!(self, c => c.caps())
    }
    pub fn set_phase_us(&self) -> i64 {
        match self {
            AnyRtc::Ds3231(_) => Ds3231::SET_PHASE_US,
            AnyRtc::Pcf8563(_) => Pcf8563::SET_PHASE_US,
            AnyRtc::Rv3028(_) => Rv3028::SET_PHASE_US,
        }
    }
    pub fn read(&mut self, bus: &mut dyn I2cBus) -> Result<RtcTime, RtcError> {
        each!(self, c => c.read(bus))
    }
    pub fn set(&mut self, bus: &mut dyn I2cBus, unix_s: i64) -> Result<(), RtcError> {
        each!(self, c => c.set(bus, unix_s))
    }
    pub fn temperature_cc(&mut self, bus: &mut dyn I2cBus) -> Option<i16> {
        each!(self, c => c.temperature_cc(bus))
    }
    pub fn set_alarm(&mut self, bus: &mut dyn I2cBus, unix_s: Option<i64>) -> Result<(), RtcError> {
        each!(self, c => c.set_alarm(bus, unix_s))
    }
    pub fn alarm_fired(&mut self, bus: &mut dyn I2cBus) -> Result<bool, RtcError> {
        each!(self, c => c.alarm_fired(bus))
    }
}

fn probe_any<C: RtcChip>(bus: &mut dyn I2cBus, addr: u8, wrap: fn(C) -> AnyRtc) -> Option<AnyRtc> {
    let addrs: &[u8] = if addr == 0 {
        C::ADDRS
    } else {
        core::slice::from_ref(&addr)
    };
    addrs.iter().find_map(|&a| C::probe(bus, a).map(wrap))
}

fn attach_any<C: RtcChip>(bus: &mut dyn I2cBus, addr: u8, wrap: fn(C) -> AnyRtc) -> Option<AnyRtc> {
    let a = if addr == 0 { C::ADDRS[0] } else { addr };
    C::attach(bus, a).map(wrap)
}

/// Find the RTC. Auto: RV-3028 (0x52, an ID register), PCF8563 (0x51), DS3231
/// (0x68, after ruling out an MPU there): each must pass its signature check,
/// and nothing is written. An explicit chip is taken at its address if it ACKs.
/// Cost when nothing is there: three address NACKs (~0.1 ms each).
pub fn detect(bus: &mut dyn I2cBus, cfg: RtcConfig) -> Option<AnyRtc> {
    match cfg {
        RtcConfig::Off => None,
        RtcConfig::Auto => probe_any(bus, 0, AnyRtc::Rv3028)
            .or_else(|| probe_any(bus, 0, AnyRtc::Pcf8563))
            .or_else(|| probe_any(bus, 0, AnyRtc::Ds3231)),
        RtcConfig::Chip(ChipKind::Ds3231, a) => attach_any(bus, a, AnyRtc::Ds3231),
        RtcConfig::Chip(ChipKind::Pcf8563, a) => attach_any(bus, a, AnyRtc::Pcf8563),
        RtcConfig::Chip(ChipKind::Rv3028, a) => attach_any(bus, a, AnyRtc::Rv3028),
    }
}

// -- shared helpers -------------------------------------------------------------

/// Packed BCD -> binary; `None` for a nibble above 9.
pub const fn from_bcd(v: u8) -> Option<u8> {
    let (h, l) = (v >> 4, v & 0x0F);
    if h > 9 || l > 9 {
        None
    } else {
        Some(h * 10 + l)
    }
}

/// Binary 0..=99 -> packed BCD.
pub const fn to_bcd(v: u8) -> u8 {
    ((v / 10) << 4) | (v % 10)
}

/// The calendar fields a chip stores (two-digit year, 2000-based).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fields {
    /// 0..=99 (2000 + yy).
    pub yy: u8,
    pub month: u8,
    pub day: u8,
    pub hour: u8,
    pub minute: u8,
    pub second: u8,
    /// Days since Sunday, 0..=6.
    pub wday: u8,
}

impl Fields {
    /// UTC seconds -> fields, or `OutOfRange` outside 2000..=2099.
    pub fn from_unix(unix_s: i64) -> Result<Self, RtcError> {
        if !(MIN_UNIX_S..=MAX_UNIX_S).contains(&unix_s) {
            return Err(RtcError::OutOfRange);
        }
        let dt = DateTime::from_unix_us(unix_s * US_PER_SEC);
        Ok(Fields {
            yy: (dt.year - 2000) as u8,
            month: dt.month,
            day: dt.day,
            hour: dt.hour,
            minute: dt.minute,
            second: dt.second,
            wday: dt.weekday().days_from_sunday(),
        })
    }

    /// Fields -> UTC seconds (the weekday is not checked: chips let it drift).
    pub fn to_unix(&self) -> Option<i64> {
        let dt = DateTime {
            year: 2000 + self.yy as i64,
            month: self.month,
            day: self.day,
            hour: self.hour,
            minute: self.minute,
            second: self.second,
            micros: 0,
        };
        dt.to_unix_us().map(|us| us / US_PER_SEC)
    }
}

/// Decode BCD registers (already masked) into fields; `None` if any is not BCD
/// or out of its range.
pub(crate) fn decode_fields(
    sec: u8,
    min: u8,
    hour: u8,
    day: u8,
    month: u8,
    yy: u8,
) -> Option<Fields> {
    let f = Fields {
        second: from_bcd(sec)?,
        minute: from_bcd(min)?,
        hour,
        day: from_bcd(day)?,
        month: from_bcd(month)?,
        yy: from_bcd(yy)?,
        wday: 0,
    };
    if f.second > 59
        || f.minute > 59
        || f.hour > 23
        || !(1..=31).contains(&f.day)
        || !(1..=12).contains(&f.month)
    {
        return None;
    }
    Some(f)
}

/// A 24-hour or 12-hour (bit 6 set) hours register, DS3231 / RV-3028 layout:
/// 12-hour mode keeps PM in bit 5 and 1..=12 in bits 4:0.
pub(crate) fn decode_hours(v: u8, twelve: bool) -> Option<u8> {
    if twelve {
        let h = from_bcd(v & 0x1F)?;
        if !(1..=12).contains(&h) {
            return None;
        }
        Some(h % 12 + if v & 0x20 != 0 { 12 } else { 0 })
    } else {
        let h = from_bcd(v & 0x3F)?;
        (h <= 23).then_some(h)
    }
}

/// Round `unix_s` up to a multiple of `step_s`.
pub(crate) fn round_up(unix_s: i64, step_s: i64) -> i64 {
    let r = unix_s.rem_euclid(step_s);
    if r == 0 {
        unix_s
    } else {
        unix_s + (step_s - r)
    }
}
