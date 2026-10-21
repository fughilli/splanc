//! A register-file fake of the MPU-6050 family on a fake I2C bus: enough
//! behaviour (auto-increment, DEVICE_RESET, FIFO with per-family overflow,
//! WHO_AM_I, NACK when absent) to drive the real driver + hub.

use ledmapper_sensor::mpu6050::{bits, reg};
use ledmapper_sensor::{BusError, I2cBus};
use std::collections::VecDeque;

pub struct FakeMpu {
    pub addr: u8,
    pub who: u8,
    pub regs: [u8; 128],
    pub fifo: VecDeque<u8>,
    pub fifo_cap: usize,
    /// 6050 behaviour: overwrite the oldest bytes when full (6500 with
    /// FIFO_MODE set: drop new samples).
    pub present: bool,
    /// Registers whose writes are silently ignored (flaky clone emulation).
    pub ignore_writes: Vec<u8>,
    /// Pretend the FIFO never fills (dead-FIFO clone).
    pub dead_fifo: bool,
    pub writes: Vec<(u8, u8)>,
}

impl FakeMpu {
    pub fn new(addr: u8, who: u8) -> FakeMpu {
        let mut m = FakeMpu {
            addr,
            who,
            regs: [0; 128],
            fifo: VecDeque::new(),
            fifo_cap: if who == 0x68 { 1024 } else { 512 },
            present: true,
            ignore_writes: Vec::new(),
            dead_fifo: false,
            writes: Vec::new(),
        };
        m.power_on();
        m
    }

    fn power_on(&mut self) {
        self.regs = [0; 128];
        self.regs[reg::PWR_MGMT_1 as usize] = 0x40; // SLEEP after reset
        self.regs[reg::WHO_AM_I as usize] = self.who;
        self.fifo.clear();
    }

    fn write_reg(&mut self, r: u8, v: u8) {
        self.writes.push((r, v));
        if self.ignore_writes.contains(&r) {
            return;
        }
        match r {
            reg::PWR_MGMT_1 if v & bits::PWR_DEVICE_RESET != 0 => self.power_on(),
            reg::USER_CTRL => {
                if v & bits::USER_FIFO_RESET != 0 {
                    self.fifo.clear();
                }
                self.regs[r as usize] = v & !bits::USER_FIFO_RESET;
            }
            reg::WHO_AM_I => {}
            _ => self.regs[r as usize] = v,
        }
    }

    fn fifo_on(&self) -> bool {
        self.regs[reg::USER_CTRL as usize] & bits::USER_FIFO_EN != 0
            && self.regs[reg::FIFO_EN as usize] == bits::FIFO_GYRO_ACCEL
    }

    /// The chip produces one sample: data registers + (if enabled) FIFO.
    pub fn produce(&mut self, accel: [i16; 3], gyro: [i16; 3], temp: i16) {
        let mut d = Vec::with_capacity(14);
        for v in accel {
            d.extend_from_slice(&v.to_be_bytes());
        }
        d.extend_from_slice(&temp.to_be_bytes());
        for v in gyro {
            d.extend_from_slice(&v.to_be_bytes());
        }
        self.regs[reg::ACCEL_XOUT_H as usize..reg::ACCEL_XOUT_H as usize + 14].copy_from_slice(&d);
        if self.fifo_on() && !self.dead_fifo {
            let frame: Vec<u8> = d[0..6].iter().chain(d[8..14].iter()).copied().collect();
            let stop_when_full = self.regs[reg::CONFIG as usize] & bits::CONFIG_FIFO_MODE_STOP != 0;
            for b in frame {
                if self.fifo.len() >= self.fifo_cap {
                    if stop_when_full {
                        return;
                    }
                    self.fifo.pop_front(); // overwrite oldest (byte-wise: misaligns)
                }
                self.fifo.push_back(b);
            }
        }
    }

    fn read(&mut self, start: u8, out: &mut [u8]) {
        match start {
            reg::FIFO_R_W => {
                for o in out.iter_mut() {
                    *o = self.fifo.pop_front().unwrap_or(0);
                }
            }
            reg::FIFO_COUNTH => {
                let c = (self.fifo.len() as u16).to_be_bytes();
                out[0] = c[0];
                if out.len() > 1 {
                    out[1] = c[1];
                }
            }
            _ => {
                for (i, o) in out.iter_mut().enumerate() {
                    *o = self.regs[(start as usize + i) & 0x7F];
                }
            }
        }
    }
}

#[derive(Default)]
pub struct FakeBus {
    pub devs: Vec<FakeMpu>,
    pub transactions: usize,
}

impl FakeBus {
    pub fn with(dev: FakeMpu) -> FakeBus {
        FakeBus { devs: vec![dev], transactions: 0 }
    }
    pub fn dev(&mut self) -> &mut FakeMpu {
        &mut self.devs[0]
    }
    fn find(&mut self, addr: u8) -> Result<&mut FakeMpu, BusError> {
        self.transactions += 1;
        self.devs.iter_mut().find(|d| d.addr == addr && d.present).ok_or(BusError::Nack)
    }
}

impl I2cBus for FakeBus {
    fn write_read(&mut self, addr: u8, wr: &[u8], rd: &mut [u8]) -> Result<(), BusError> {
        let d = self.find(addr)?;
        d.read(wr[0], rd);
        Ok(())
    }
    fn write(&mut self, addr: u8, wr: &[u8]) -> Result<(), BusError> {
        let d = self.find(addr)?;
        for (i, &v) in wr[1..].iter().enumerate() {
            d.write_reg(wr[0] + i as u8, v);
        }
        Ok(())
    }
}
