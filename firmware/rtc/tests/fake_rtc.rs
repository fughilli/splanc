//! Register-file fakes of the three RTC chips on a shared fake I2C bus, next to
//! the sensor core's fake MPU. Only what the drivers depend on: auto-increment
//! with each chip's wrap, read-only bits, write-0-to-clear flags, NACK when
//! absent, the RV-3028's EEPROM busy flag and ID register.

#[path = "../../sensor/tests/fake_mpu.rs"]
pub mod fake_mpu;

use fake_mpu::{FakeBus as MpuBus, FakeMpu};
use ledmapper_sensor::{BusError, I2cBus};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Ds3231,
    Pcf8563,
    Rv3028,
}

pub struct FakeRtc {
    pub kind: Kind,
    pub addr: u8,
    pub regs: [u8; 64],
    /// Registers 0..len exist; the pointer wraps to 0 after len - 1 (reads of a
    /// start beyond return 0, writes beyond are dropped).
    pub len: usize,
    /// Per register: bits that are flags (write 0 clears, write 1 keeps).
    pub flags: [u8; 64],
    /// Per register: read-only bits (a write leaves them).
    pub ro: [u8; 64],
    pub present: bool,
    /// Every register write, in order.
    pub writes: Vec<(u8, u8)>,
    /// RV-3028: reads left until EEBUSY clears; the backup byte the EEPROM holds.
    pub ee_busy: u32,
    pub eeprom_backup: u8,
    pub ee_updates: u32,
}

impl FakeRtc {
    pub fn new(kind: Kind) -> Self {
        let mut f = FakeRtc {
            kind,
            addr: 0,
            regs: [0; 64],
            len: 0,
            flags: [0; 64],
            ro: [0; 64],
            present: true,
            writes: Vec::new(),
            ee_busy: 0,
            eeprom_backup: 0x10,
            ee_updates: 0,
        };
        match kind {
            Kind::Ds3231 => {
                f.addr = 0x68;
                f.len = 0x13;
                // Power-on: 2000-01-01 00:00:00, day 1, control 0x1C, OSF set,
                // 25.25 °C.
                f.regs[..0x13].copy_from_slice(&[
                    0x00, 0x00, 0x00, 0x01, 0x01, 0x01, 0x00, // time
                    0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, // alarms
                    0x1C, 0x88, 0x00, 0x19, 0x40,
                ]);
                f.flags[0x0F] = 0x83; // OSF, A2F, A1F
                f.ro[0x0F] = 0x74; // bits 6:4 zero, BSY
                f.ro[0x11] = 0xFF;
                f.ro[0x12] = 0xFF;
            }
            Kind::Pcf8563 => {
                f.addr = 0x51;
                f.len = 0x10;
                // Power-on: TESTC, VL set, the time registers undefined.
                f.regs[..0x10].copy_from_slice(&[
                    0x08, 0x00, 0xD7, 0x5A, 0x3F, 0x2F, 0x07, 0x9F,
                    0xAB, // ctrl, time (garbage)
                    0x80, 0x80, 0x80, 0x80, 0x80, 0x03, 0x00,
                ]);
                f.flags[0x01] = 0x0C; // AF, TF
                f.ro[0x00] = 0x57;
                f.ro[0x01] = 0xE0;
                f.ro[0x0D] = 0x7C;
                f.ro[0x0E] = 0x7C;
            }
            Kind::Rv3028 => {
                f.addr = 0x52;
                f.len = 0x40;
                // Power-on: 00:00:00 2000-01-01, PORF set, 24-hour mode.
                f.regs[0x03] = 0x06;
                f.regs[0x04] = 0x01;
                f.regs[0x05] = 0x01;
                f.regs[0x07] = 0x80;
                f.regs[0x08] = 0x80;
                f.regs[0x09] = 0x80;
                f.regs[0x0E] = 0x01; // PORF
                f.regs[0x28] = 0x31; // HID 3, VID 1
                f.regs[0x37] = 0x10; // FEDE, BSM = 00 (switch-over off)
                f.flags[0x0E] = 0x7F;
                f.ro[0x0E] = 0x80; // EEBUSY
                f.ro[0x0F] = 0x40;
                f.ro[0x28] = 0xFF;
            }
        }
        f
    }

    fn read(&mut self, start: u8, out: &mut [u8]) {
        let mut p = start as usize;
        if p >= self.len {
            out.fill(0);
            return;
        }
        for o in out.iter_mut() {
            *o = self.regs[p];
            if self.kind == Kind::Rv3028 && p == 0x0E && self.ee_busy > 0 {
                self.ee_busy -= 1;
                if self.ee_busy == 0 {
                    self.regs[0x0E] &= !0x80;
                }
            }
            p = (p + 1) % self.len;
        }
    }

    fn write_reg(&mut self, r: usize, v: u8) {
        if r >= self.len {
            return;
        }
        self.writes.push((r as u8, v));
        let keep = self.ro[r] | self.flags[r];
        let mut nv = (self.regs[r] & keep) | (v & !keep);
        // Flags: write 0 clears.
        nv &= !(self.flags[r] & !v);
        self.regs[r] = nv;
        if self.kind == Kind::Rv3028 && r == 0x27 && v == 0x11 {
            assert!(self.regs[0x0F] & 0x08 != 0, "EEPROM update without EERD");
            self.eeprom_backup = self.regs[0x37];
            self.ee_updates += 1;
            self.regs[0x0E] |= 0x80;
            self.ee_busy = 2;
        }
    }

    /// Set raw time registers starting at `reg`.
    pub fn poke(&mut self, reg: u8, bytes: &[u8]) {
        self.regs[reg as usize..reg as usize + bytes.len()].copy_from_slice(bytes);
    }

    pub fn written(&self, reg: u8) -> bool {
        self.writes.iter().any(|&(r, _)| r == reg)
    }
}

/// RTC fakes plus (optionally) the sensor core's fake MPUs on one bus.
#[derive(Default)]
pub struct Bus {
    pub rtcs: Vec<FakeRtc>,
    pub mpu: MpuBus,
    /// (addr, register, is_write) for every transaction.
    pub log: Vec<(u8, u8, bool)>,
}

impl Bus {
    pub fn with(r: FakeRtc) -> Self {
        Bus {
            rtcs: vec![r],
            ..Default::default()
        }
    }
    pub fn add_mpu(&mut self, m: FakeMpu) {
        self.mpu.devs.push(m);
    }
    pub fn rtc(&mut self) -> &mut FakeRtc {
        &mut self.rtcs[0]
    }
    pub fn writes_to(&self, addr: u8) -> usize {
        self.log.iter().filter(|&&(a, _, w)| a == addr && w).count()
    }
}

impl I2cBus for Bus {
    fn write_read(&mut self, addr: u8, wr: &[u8], rd: &mut [u8]) -> Result<(), BusError> {
        self.log.push((addr, wr[0], false));
        if let Some(r) = self.rtcs.iter_mut().find(|r| r.addr == addr && r.present) {
            r.read(wr[0], rd);
            return Ok(());
        }
        self.mpu.write_read(addr, wr, rd)
    }
    fn write(&mut self, addr: u8, wr: &[u8]) -> Result<(), BusError> {
        self.log.push((addr, wr[0], true));
        if let Some(r) = self.rtcs.iter_mut().find(|r| r.addr == addr && r.present) {
            let mut p = wr[0] as usize;
            for &v in &wr[1..] {
                r.write_reg(p, v);
                p = (p + 1) % r.len;
            }
            return Ok(());
        }
        self.mpu.write(addr, wr)
    }
}
