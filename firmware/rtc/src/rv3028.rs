//! Micro Crystal RV-3028-C7 at 0x52: ±1 ppm at 25 °C (±3 ppm over temperature),
//! 45 nA backup current.
//!
//! Registers 0x00-0x06 time (BCD; the 12/24-hour mode is Control 2 bit 1),
//! 0x07-0x09 minute/hour/weekday-or-date alarm (bit 7 = AE, 1 = field disabled;
//! Control 1 WADA picks date), 0x0E status (EEBUSY, CLKF, BSF, UF, TF, AF, EVF,
//! PORF), 0x0F control 1 (TRPT, bit 6 = 0, WADA, USEL, EERD, TE, TD), 0x10
//! control 2 (TSE, CLKIE, UIE, TIE, AIE, EIE, 12_24, RESET), 0x25-0x27 the
//! EEPROM interface, 0x28 ID (hardware id 3 in bits 7:4), 0x37 the RAM mirror
//! of the EEPROM backup register (BSM bits 3:2).
//!
//! **Backup switch-over:** the factory EEPROM leaves it *off* (BSM = 00), so a
//! module with a coin cell still loses time at power-off. [`RtcChip::set`] turns
//! on level switching (BSM = 11) once: EERD (no auto-refresh) set, the mirror
//! written, an EEPROM update (0x00 then 0x11 into 0x27) started. The EEPROM
//! write takes ~10–60 ms; nothing waits for it: the next [`RtcChip::read`] that
//! sees EEBUSY clear drops EERD again.

use crate::{
    decode_fields, decode_hours, round_up, to_bcd, ChipKind, Fields, I2cBus, RtcCaps, RtcChip,
    RtcError, RtcTime,
};

pub const ADDR: u8 = 0x52;

pub mod reg {
    pub const SECONDS: u8 = 0x00;
    pub const MINUTE_ALARM: u8 = 0x07;
    pub const STATUS: u8 = 0x0E;
    pub const CTRL1: u8 = 0x0F;
    pub const CTRL2: u8 = 0x10;
    pub const EE_CMD: u8 = 0x27;
    pub const ID: u8 = 0x28;
    pub const EE_BACKUP: u8 = 0x37;
}

pub mod bits {
    pub const STATUS_EEBUSY: u8 = 0x80;
    pub const STATUS_AF: u8 = 0x04;
    pub const STATUS_PORF: u8 = 0x01;
    pub const CTRL1_WADA: u8 = 0x20;
    pub const CTRL1_EERD: u8 = 0x08;
    pub const CTRL2_AIE: u8 = 0x08;
    pub const CTRL2_12_24: u8 = 0x02;
    pub const AE: u8 = 0x80;
    pub const BSM_MASK: u8 = 0x0C;
    /// Level switching mode: switch to VBACKUP when VDD < VBACKUP and < 2 V.
    pub const BSM_LSM: u8 = 0x0C;
    pub const EE_CMD_UPDATE: u8 = 0x11;
    pub const ID_HID: u8 = 0x30;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rv3028 {
    addr: u8,
    /// An EEPROM update was started with EERD set; clear EERD once it is done.
    ee_pending: bool,
}

impl Rv3028 {
    /// An EEPROM update this driver started is still running.
    pub fn eeprom_pending(&self) -> bool {
        self.ee_pending
    }

    /// Turn on the backup switch-over (LSM) if it is off, persisting it to the
    /// EEPROM without waiting (see the module doc). Skipped while the EEPROM is
    /// busy; the next set retries.
    fn ensure_backup(&mut self, bus: &mut dyn I2cBus, status: u8) -> Result<(), RtcError> {
        let backup = bus.read_reg(self.addr, reg::EE_BACKUP)?;
        if backup & bits::BSM_MASK == bits::BSM_LSM || status & bits::STATUS_EEBUSY != 0 {
            return Ok(());
        }
        let ctrl1 = bus.read_reg(self.addr, reg::CTRL1)?;
        bus.write_reg(self.addr, reg::CTRL1, ctrl1 | bits::CTRL1_EERD)?;
        bus.write_reg(
            self.addr,
            reg::EE_BACKUP,
            (backup & !bits::BSM_MASK) | bits::BSM_LSM,
        )?;
        bus.write_reg(self.addr, reg::EE_CMD, 0x00)?;
        bus.write_reg(self.addr, reg::EE_CMD, bits::EE_CMD_UPDATE)?;
        self.ee_pending = true;
        Ok(())
    }
}

impl RtcChip for Rv3028 {
    const NAME: &'static str = "RV-3028";
    const ADDRS: &'static [u8] = &[ADDR];
    const KIND: ChipKind = ChipKind::Rv3028;

    fn probe(bus: &mut dyn I2cBus, addr: u8) -> Option<Self> {
        let id = bus.read_reg(addr, reg::ID).ok()?;
        let ctrl1 = bus.read_reg(addr, reg::CTRL1).ok()?;
        (id & 0xF0 == bits::ID_HID && ctrl1 & 0x40 == 0).then_some(Rv3028 {
            addr,
            ee_pending: false,
        })
    }

    fn attach(bus: &mut dyn I2cBus, addr: u8) -> Option<Self> {
        bus.read_reg(addr, reg::STATUS).ok()?;
        Some(Rv3028 {
            addr,
            ee_pending: false,
        })
    }

    fn addr(&self) -> u8 {
        self.addr
    }

    fn caps(&self) -> RtcCaps {
        RtcCaps {
            temperature: false,
            alarm: true,
            drift_ppb: 3_000,
            trim: true,
            alarm_step_s: 60,
        }
    }

    fn read(&mut self, bus: &mut dyn I2cBus) -> Result<RtcTime, RtcError> {
        let mut r = [0u8; 17];
        bus.write_read(self.addr, &[reg::SECONDS], &mut r)?;
        let status = r[reg::STATUS as usize];
        let ctrl1 = r[reg::CTRL1 as usize];
        if self.ee_pending && status & bits::STATUS_EEBUSY == 0 {
            bus.write_reg(self.addr, reg::CTRL1, ctrl1 & !bits::CTRL1_EERD)?;
            self.ee_pending = false;
        }
        let valid = status & bits::STATUS_PORF == 0;
        let twelve = r[reg::CTRL2 as usize] & bits::CTRL2_12_24 != 0;
        let decoded = decode_hours(r[2], twelve)
            .and_then(|h| {
                decode_fields(r[0] & 0x7F, r[1] & 0x7F, h, r[4] & 0x3F, r[5] & 0x1F, r[6])
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
        let ctrl2 = bus.read_reg(self.addr, reg::CTRL2)?;
        if ctrl2 & bits::CTRL2_12_24 != 0 {
            bus.write_reg(self.addr, reg::CTRL2, ctrl2 & !bits::CTRL2_12_24)?;
        }
        // Writing the seconds resets the prescaler: the next tick is 1 s later.
        bus.write(
            self.addr,
            &[
                reg::SECONDS,
                to_bcd(f.second),
                to_bcd(f.minute),
                to_bcd(f.hour),
                f.wday, // 0 = Sunday
                to_bcd(f.day),
                to_bcd(f.month),
                to_bcd(f.yy),
            ],
        )?;
        let status = bus.read_reg(self.addr, reg::STATUS)?;
        if status & bits::STATUS_PORF != 0 {
            bus.write_reg(self.addr, reg::STATUS, status & !bits::STATUS_PORF)?;
        }
        self.ensure_backup(bus, status)
    }

    /// Minute + hour + date match (WADA = date), rounded up to the minute.
    fn set_alarm(&mut self, bus: &mut dyn I2cBus, unix_s: Option<i64>) -> Result<(), RtcError> {
        let ctrl1 = bus.read_reg(self.addr, reg::CTRL1)?;
        let ctrl2 = bus.read_reg(self.addr, reg::CTRL2)?;
        // Disable first so a half-written alarm can't match.
        bus.write_reg(self.addr, reg::CTRL2, ctrl2 & !bits::CTRL2_AIE)?;
        match unix_s {
            Some(t) => {
                let f = Fields::from_unix(round_up(t, 60))?;
                bus.write_reg(self.addr, reg::CTRL1, ctrl1 | bits::CTRL1_WADA)?;
                bus.write(
                    self.addr,
                    &[
                        reg::MINUTE_ALARM,
                        to_bcd(f.minute),
                        to_bcd(f.hour),
                        to_bcd(f.day),
                    ],
                )?;
            }
            None => {
                bus.write(
                    self.addr,
                    &[reg::MINUTE_ALARM, bits::AE, bits::AE, bits::AE],
                )?;
            }
        }
        let status = bus.read_reg(self.addr, reg::STATUS)?;
        bus.write_reg(self.addr, reg::STATUS, status & !bits::STATUS_AF)?;
        if unix_s.is_some() {
            bus.write_reg(self.addr, reg::CTRL2, ctrl2 | bits::CTRL2_AIE)?;
        }
        Ok(())
    }

    fn alarm_fired(&mut self, bus: &mut dyn I2cBus) -> Result<bool, RtcError> {
        Ok(bus.read_reg(self.addr, reg::STATUS)? & bits::STATUS_AF != 0)
    }
}
