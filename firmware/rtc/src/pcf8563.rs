//! NXP PCF8563 (and the pin-compatible BM8563 on M5Stack boards) at 0x51.
//!
//! Registers 0x00 Control_status_1 (TEST1, STOP, TESTC; bits 6, 4, 2:0 read 0),
//! 0x01 Control_status_2 (TI_TP, AF, TF, AIE, TIE; bits 7:5 read 0), 0x02-0x08
//! time (BCD; 0x02 bit 7 = VL "integrity not guaranteed", 0x07 bit 7 = century),
//! 0x09-0x0C minute/hour/day/weekday alarm (bit 7 = AE, 1 = field disabled),
//! 0x0D CLKOUT control, 0x0E timer control (bits 6:2 read 0), 0x0F timer.
//!
//! - **Century:** the chip's C bit flips when the year wraps 99 -> 00 and its
//!   polarity differs between parts, so it is written 0 and ignored on read: the
//!   year is always 2000 + yy.
//! - **Setting:** STOP holds the divider at 0 while the time is written; the
//!   first tick comes 0.507813–0.507935 s after STOP is released (datasheet), so
//!   [`Pcf8563::SET_PHASE_US`] is 492 ms into the second.
//! - Alarms have minute resolution.

use crate::{
    decode_fields, from_bcd, round_up, to_bcd, ChipKind, Fields, I2cBus, RtcCaps, RtcChip,
    RtcError, RtcTime,
};

pub const ADDR: u8 = 0x51;

pub mod reg {
    pub const CTRL1: u8 = 0x00;
    pub const CTRL2: u8 = 0x01;
    pub const VL_SECONDS: u8 = 0x02;
    pub const MINUTE_ALARM: u8 = 0x09;
    pub const CLKOUT: u8 = 0x0D;
    pub const TIMER_CTRL: u8 = 0x0E;
}

pub mod bits {
    pub const CTRL1_TEST1: u8 = 0x80;
    pub const CTRL1_STOP: u8 = 0x20;
    pub const CTRL2_AF: u8 = 0x08;
    pub const CTRL2_AIE: u8 = 0x02;
    pub const VL: u8 = 0x80;
    pub const CENTURY: u8 = 0x80;
    pub const AE: u8 = 0x80;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Pcf8563 {
    addr: u8,
}

/// The signature over registers 0x00..=0x0F: the fixed-zero control bits. The
/// time may be garbage (VL set after a power loss), so it is not checked.
pub fn looks_like_pcf8563(r: &[u8; 16]) -> bool {
    r[reg::CTRL1 as usize] & (bits::CTRL1_TEST1 | 0x57) == 0
        && r[reg::CTRL2 as usize] & 0xE0 == 0
        && r[reg::CLKOUT as usize] & 0x7C == 0
        && r[reg::TIMER_CTRL as usize] & 0x7C == 0
}

impl RtcChip for Pcf8563 {
    const NAME: &'static str = "PCF8563";
    const ADDRS: &'static [u8] = &[ADDR];
    const KIND: ChipKind = ChipKind::Pcf8563;
    const SET_PHASE_US: i64 = 492_000;

    fn probe(bus: &mut dyn I2cBus, addr: u8) -> Option<Self> {
        let mut r = [0u8; 16];
        bus.write_read(addr, &[reg::CTRL1], &mut r).ok()?;
        looks_like_pcf8563(&r).then_some(Pcf8563 { addr })
    }

    fn attach(bus: &mut dyn I2cBus, addr: u8) -> Option<Self> {
        bus.read_reg(addr, reg::CTRL1).ok()?;
        Some(Pcf8563 { addr })
    }

    fn addr(&self) -> u8 {
        self.addr
    }

    fn caps(&self) -> RtcCaps {
        // ±20 ppm is the crystal's tolerance at 25 °C; cheap modules add load-
        // capacitance error on top.
        RtcCaps {
            temperature: false,
            alarm: true,
            drift_ppb: 25_000,
            trim: false,
            alarm_step_s: 60,
        }
    }

    fn read(&mut self, bus: &mut dyn I2cBus) -> Result<RtcTime, RtcError> {
        let mut r = [0u8; 9];
        bus.write_read(self.addr, &[reg::CTRL1], &mut r)?;
        let valid = r[2] & bits::VL == 0 && r[0] & bits::CTRL1_STOP == 0;
        let decoded = from_bcd(r[4] & 0x3F)
            .and_then(|h| {
                decode_fields(r[2] & 0x7F, r[3] & 0x7F, h, r[5] & 0x3F, r[7] & 0x1F, r[8])
            })
            .and_then(|f| f.to_unix());
        match decoded {
            Some(unix_s) => Ok(RtcTime { unix_s, valid }),
            None if valid => Err(RtcError::BadData),
            None => Ok(RtcTime {
                unix_s: 0,
                valid: false,
            }),
        }
    }

    fn set(&mut self, bus: &mut dyn I2cBus, unix_s: i64) -> Result<(), RtcError> {
        let f = Fields::from_unix(unix_s)?;
        bus.write_reg(self.addr, reg::CTRL1, bits::CTRL1_STOP)?;
        bus.write(
            self.addr,
            &[
                reg::VL_SECONDS,
                to_bcd(f.second), // VL = 0
                to_bcd(f.minute),
                to_bcd(f.hour),
                to_bcd(f.day),
                f.wday,          // 0 = Sunday
                to_bcd(f.month), // C = 0
                to_bcd(f.yy),
            ],
        )?;
        // Release STOP (and TESTC: normal operation).
        bus.write_reg(self.addr, reg::CTRL1, 0)?;
        Ok(())
    }

    /// Minute + hour + day match (weekday disabled), rounded up to the minute.
    fn set_alarm(&mut self, bus: &mut dyn I2cBus, unix_s: Option<i64>) -> Result<(), RtcError> {
        let ctrl2 = bus.read_reg(self.addr, reg::CTRL2)? & 0x1F;
        match unix_s {
            Some(t) => {
                let f = Fields::from_unix(round_up(t, 60))?;
                bus.write(
                    self.addr,
                    &[
                        reg::MINUTE_ALARM,
                        to_bcd(f.minute),
                        to_bcd(f.hour),
                        to_bcd(f.day),
                        bits::AE,
                    ],
                )?;
                bus.write_reg(
                    self.addr,
                    reg::CTRL2,
                    (ctrl2 | bits::CTRL2_AIE) & !bits::CTRL2_AF,
                )?;
            }
            None => {
                bus.write(
                    self.addr,
                    &[reg::MINUTE_ALARM, bits::AE, bits::AE, bits::AE, bits::AE],
                )?;
                bus.write_reg(
                    self.addr,
                    reg::CTRL2,
                    ctrl2 & !(bits::CTRL2_AIE | bits::CTRL2_AF),
                )?;
            }
        }
        Ok(())
    }

    fn alarm_fired(&mut self, bus: &mut dyn I2cBus) -> Result<bool, RtcError> {
        Ok(bus.read_reg(self.addr, reg::CTRL2)? & bits::CTRL2_AF != 0)
    }
}
