//! Maxim/ADI DS3231 (and DS3231M/SN): TCXO RTC at 0x68.
//!
//! Registers 0x00-0x06 time (BCD; hours bit 6 = 12-hour mode; month bit 7 =
//! century), 0x07-0x0A alarm 1, 0x0B-0x0D alarm 2, 0x0E control (EOSC, INTCN,
//! A1IE, ...), 0x0F status (OSF, EN32kHz, BSY, A2F, A1F; bits 6:4 read 0), 0x10
//! aging, 0x11/0x12 temperature (°C, ¼-degree steps in bits 7:6 of 0x12; bits
//! 5:0 read 0). One 19-byte burst covers them all.
//!
//! **0x68 is also the MPU-6050's address** (GY-521 with AD0 low). The probe
//! accepts a device only when all 19 registers look like a DS3231 (BCD-valid
//! time, weekday 1..=7, status/temperature zero bits, a plausible temperature)
//! **and** its WHO_AM_I (0x75) is not an MPU's. The sensor core refuses the
//! DS3231 from its side (an unknown WHO_AM_I), so each identifies only itself.

use crate::{
    decode_fields, decode_hours, round_up, to_bcd, ChipKind, Fields, I2cBus, RtcCaps, RtcChip,
    RtcError, RtcTime,
};

pub const ADDR: u8 = 0x68;

pub mod reg {
    pub const SECONDS: u8 = 0x00;
    pub const DAY: u8 = 0x03;
    pub const MONTH: u8 = 0x05;
    pub const ALARM1: u8 = 0x07;
    pub const CONTROL: u8 = 0x0E;
    pub const STATUS: u8 = 0x0F;
    pub const AGING: u8 = 0x10;
    pub const TEMP_MSB: u8 = 0x11;
    pub const TEMP_LSB: u8 = 0x12;
    /// The MPU-6050's WHO_AM_I, read to rule an IMU out.
    pub const MPU_WHO_AM_I: u8 = 0x75;
}

pub mod bits {
    pub const HOUR_12: u8 = 0x40;
    pub const CENTURY: u8 = 0x80;
    pub const CTRL_EOSC: u8 = 0x80;
    pub const CTRL_INTCN: u8 = 0x04;
    pub const CTRL_A1IE: u8 = 0x01;
    pub const STATUS_OSF: u8 = 0x80;
    pub const STATUS_A1F: u8 = 0x01;
    /// A1Mx: "don't care" for that alarm field.
    pub const ALARM_MASK: u8 = 0x80;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Ds3231 {
    addr: u8,
}

/// The whole register file, 0x00..=0x12.
fn read_all(bus: &mut dyn I2cBus, addr: u8) -> Result<[u8; 19], RtcError> {
    let mut r = [0u8; 19];
    bus.write_read(addr, &[reg::SECONDS], &mut r)?;
    Ok(r)
}

/// The signature over a full register dump (see the module doc).
pub fn looks_like_ds3231(r: &[u8; 19]) -> bool {
    let twelve = r[2] & bits::HOUR_12 != 0;
    let time_ok = r[0] & 0x80 == 0
        && r[1] & 0x80 == 0
        && r[2] & 0x80 == 0
        && decode_hours(r[2], twelve).is_some()
        && (1..=7).contains(&r[3])
        && r[4] & 0xC0 == 0
        && r[5] & 0x60 == 0
        && decode_fields(r[0], r[1], 0, r[4], r[5] & 0x1F, r[6]).is_some();
    let status_ok = r[reg::STATUS as usize] & 0x70 == 0;
    let temp = r[reg::TEMP_MSB as usize] as i8;
    let temp_ok = r[reg::TEMP_LSB as usize] & 0x3F == 0 && (-40..=85).contains(&temp);
    time_ok && status_ok && temp_ok
}

impl RtcChip for Ds3231 {
    const NAME: &'static str = "DS3231";
    const ADDRS: &'static [u8] = &[ADDR];
    const KIND: ChipKind = ChipKind::Ds3231;

    fn probe(bus: &mut dyn I2cBus, addr: u8) -> Option<Self> {
        let r = read_all(bus, addr).ok()?;
        if !looks_like_ds3231(&r) {
            return None;
        }
        // An IMU at the same address must not be taken for an RTC.
        if let Ok(who) = bus.read_reg(addr, reg::MPU_WHO_AM_I) {
            if ledmapper_sensor::mpu6050::identify(who).is_some() {
                return None;
            }
        }
        Some(Ds3231 { addr })
    }

    fn attach(bus: &mut dyn I2cBus, addr: u8) -> Option<Self> {
        bus.read_reg(addr, reg::STATUS).ok()?;
        Some(Ds3231 { addr })
    }

    fn addr(&self) -> u8 {
        self.addr
    }

    fn caps(&self) -> RtcCaps {
        RtcCaps {
            temperature: true,
            alarm: true,
            drift_ppb: 2_000,
            trim: true,
            alarm_step_s: 1,
        }
    }

    fn read(&mut self, bus: &mut dyn I2cBus) -> Result<RtcTime, RtcError> {
        let mut r = [0u8; 7];
        bus.write_read(self.addr, &[reg::SECONDS], &mut r)?;
        let status = bus.read_reg(self.addr, reg::STATUS)?;
        let valid = status & bits::STATUS_OSF == 0;
        let decoded = decode_hours(r[2], r[2] & bits::HOUR_12 != 0)
            .and_then(|h| {
                decode_fields(r[0] & 0x7F, r[1] & 0x7F, h, r[4] & 0x3F, r[5] & 0x1F, r[6])
            })
            .and_then(|f| f.to_unix());
        match decoded {
            // Century set: 2100 or later, which this firmware never writes.
            Some(_) if valid && r[5] & bits::CENTURY != 0 => Err(RtcError::OutOfRange),
            Some(unix_s) => Ok(RtcTime {
                unix_s,
                valid: valid && r[5] & bits::CENTURY == 0,
            }),
            None if valid => Err(RtcError::BadData),
            None => Ok(RtcTime {
                unix_s: 0,
                valid: false,
            }),
        }
    }

    fn set(&mut self, bus: &mut dyn I2cBus, unix_s: i64) -> Result<(), RtcError> {
        let f = Fields::from_unix(unix_s)?;
        // Writing the seconds restarts the chip's countdown chain: the next tick
        // is a whole second after this write.
        bus.write(
            self.addr,
            &[
                reg::SECONDS,
                to_bcd(f.second),
                to_bcd(f.minute),
                to_bcd(f.hour), // 24-hour mode
                f.wday + 1,     // 1 = Sunday
                to_bcd(f.day),
                to_bcd(f.month), // century 0: 20xx
                to_bcd(f.yy),
            ],
        )?;
        // Keep the oscillator running on the battery (EOSC = 0).
        let ctrl = bus.read_reg(self.addr, reg::CONTROL)?;
        if ctrl & bits::CTRL_EOSC != 0 {
            bus.write_reg(self.addr, reg::CONTROL, ctrl & !bits::CTRL_EOSC)?;
        }
        // Clear OSF; the alarm flags are written back as read (a 1 leaves them).
        let st = bus.read_reg(self.addr, reg::STATUS)?;
        if st & bits::STATUS_OSF != 0 {
            bus.write_reg(self.addr, reg::STATUS, st & !bits::STATUS_OSF)?;
        }
        Ok(())
    }

    fn temperature_cc(&mut self, bus: &mut dyn I2cBus) -> Option<i16> {
        let mut t = [0u8; 2];
        bus.write_read(self.addr, &[reg::TEMP_MSB], &mut t).ok()?;
        Some(t[0] as i8 as i16 * 100 + (t[1] >> 6) as i16 * 25)
    }

    /// Alarm 1, matched on date + h:m:s (A1M4..1 = 0), INTCN set so it drives
    /// INT/SQW rather than the square wave.
    fn set_alarm(&mut self, bus: &mut dyn I2cBus, unix_s: Option<i64>) -> Result<(), RtcError> {
        let ctrl = bus.read_reg(self.addr, reg::CONTROL)?;
        match unix_s {
            Some(t) => {
                let f = Fields::from_unix(round_up(t, 1))?;
                bus.write(
                    self.addr,
                    &[
                        reg::ALARM1,
                        to_bcd(f.second),
                        to_bcd(f.minute),
                        to_bcd(f.hour),
                        to_bcd(f.day),
                    ],
                )?;
                bus.write_reg(
                    self.addr,
                    reg::CONTROL,
                    ctrl | bits::CTRL_INTCN | bits::CTRL_A1IE,
                )?;
            }
            None => {
                let m = bits::ALARM_MASK;
                bus.write(self.addr, &[reg::ALARM1, m, m, m, m])?;
                bus.write_reg(self.addr, reg::CONTROL, ctrl & !bits::CTRL_A1IE)?;
            }
        }
        let st = bus.read_reg(self.addr, reg::STATUS)?;
        bus.write_reg(self.addr, reg::STATUS, st & !bits::STATUS_A1F)?;
        Ok(())
    }

    fn alarm_fired(&mut self, bus: &mut dyn I2cBus) -> Result<bool, RtcError> {
        Ok(bus.read_reg(self.addr, reg::STATUS)? & bits::STATUS_A1F != 0)
    }
}

impl Ds3231 {
    /// The register-file signature as a pure check (tests, `scan` labels).
    pub fn signature(bus: &mut dyn I2cBus, addr: u8) -> bool {
        read_all(bus, addr)
            .map(|r| looks_like_ds3231(&r))
            .unwrap_or(false)
    }
}
