//! InvenSense MPU-6050 family driver (and the register-compatible MPU-6500 /
//! MPU-9250 / ICM-20689 parts that ship on "MPU6050" breakout boards).
//!
//! Stateless register-level helpers; the sampling state machine lives in
//! [`crate::hub`]. Everything is big-endian i16 on the wire.
//!
//! Variant notes (docs/design/sensor-core.md §MPU-6050 specifics):
//! - WHO_AM_I (0x75) reports bits 6:1 of the *default* address, so a genuine
//!   MPU-6050 reads 0x68 at either AD0 address (0x68 or 0x69).
//! - The 6500 family adds ACCEL_CONFIG2 (separate accel DLPF), a FIFO_MODE bit
//!   (stop-when-full instead of overwrite), a 512-byte FIFO (vs 1024), and a
//!   different temperature transfer function.
//! - Remarked clones exist: boards sold as MPU-6050 that report 0x70/0x72/0x98.
//!   They are register-compatible enough for this driver (6500-family path).

use crate::bus::{BusError, I2cBus};

/// AD0 low (most GY-521 boards: AD0 has a pull-down).
pub const ADDR_AD0_LOW: u8 = 0x68;
/// AD0 high.
pub const ADDR_AD0_HIGH: u8 = 0x69;

/// Register map (MPU-6000/6050 RM rev 4.2; MPU-6500 RM rev 2.1 for the extras).
pub mod reg {
    pub const SMPLRT_DIV: u8 = 0x19;
    pub const CONFIG: u8 = 0x1A;
    pub const GYRO_CONFIG: u8 = 0x1B;
    pub const ACCEL_CONFIG: u8 = 0x1C;
    /// 6500 family only.
    pub const ACCEL_CONFIG2: u8 = 0x1D;
    pub const FIFO_EN: u8 = 0x23;
    pub const INT_PIN_CFG: u8 = 0x37;
    pub const INT_ENABLE: u8 = 0x38;
    pub const INT_STATUS: u8 = 0x3A;
    pub const ACCEL_XOUT_H: u8 = 0x3B;
    pub const TEMP_OUT_H: u8 = 0x41;
    pub const USER_CTRL: u8 = 0x6A;
    pub const PWR_MGMT_1: u8 = 0x6B;
    pub const PWR_MGMT_2: u8 = 0x6C;
    pub const FIFO_COUNTH: u8 = 0x72;
    pub const FIFO_R_W: u8 = 0x74;
    pub const WHO_AM_I: u8 = 0x75;
}

/// Bits used by the driver.
pub mod bits {
    pub const PWR_DEVICE_RESET: u8 = 0x80;
    /// CLKSEL=1: PLL off the X gyro (datasheet-recommended over the 8 MHz RC).
    pub const PWR_CLK_PLL_X: u8 = 0x01;
    pub const USER_FIFO_EN: u8 = 0x40;
    pub const USER_FIFO_RESET: u8 = 0x04;
    /// FIFO_EN: XG | YG | ZG | ACCEL (12 bytes per sample, no temperature).
    pub const FIFO_GYRO_ACCEL: u8 = 0x78;
    /// CONFIG bit 6 on the 6500 family: when the FIFO is full, drop new samples
    /// instead of overwriting the oldest (which misaligns the 12-byte frames).
    pub const CONFIG_FIFO_MODE_STOP: u8 = 0x40;
    pub const INT_FIFO_OFLOW: u8 = 0x10;
    pub const INT_DATA_RDY: u8 = 0x01;
}

/// Bytes per FIFO sample with [`bits::FIFO_GYRO_ACCEL`].
pub const FIFO_SAMPLE_BYTES: usize = 12;
/// Bytes in a direct burst read ACCEL_XOUT_H..GYRO_ZOUT_L.
pub const BURST_BYTES: usize = 14;

/// Register-programming family.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Family {
    /// MPU-6000/6050: 1024-byte FIFO, overwrite-oldest on overflow.
    Mpu6050,
    /// MPU-6500/9250/9255, ICM-20689 and remarked clones: ACCEL_CONFIG2,
    /// FIFO_MODE, 512-byte FIFO.
    Mpu6500,
}

/// A recognized WHO_AM_I. `code()` is the stable wire/FFI value.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Variant {
    Mpu6050,
    Mpu6500,
    Mpu9250,
    Mpu9255,
    Icm20689,
    /// Reported by remarked "MPU6050" boards; treated as 6500 family.
    Clone6500(u8),
}

impl Variant {
    pub fn family(self) -> Family {
        match self {
            Variant::Mpu6050 => Family::Mpu6050,
            _ => Family::Mpu6500,
        }
    }

    /// FIFO capacity in bytes (6500 family default FIFO_SIZE).
    pub fn fifo_bytes(self) -> u16 {
        match self.family() {
            Family::Mpu6050 => 1024,
            Family::Mpu6500 => 512,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            Variant::Mpu6050 => "MPU-6050",
            Variant::Mpu6500 => "MPU-6500",
            Variant::Mpu9250 => "MPU-9250",
            Variant::Mpu9255 => "MPU-9255",
            Variant::Icm20689 => "ICM-20689",
            Variant::Clone6500(_) => "MPU-6050 clone (6500-family)",
        }
    }

    /// Stable small code for FFI / protocol (0 = none/unknown).
    pub fn code(self) -> u8 {
        match self {
            Variant::Mpu6050 => 1,
            Variant::Mpu6500 => 2,
            Variant::Mpu9250 => 3,
            Variant::Mpu9255 => 4,
            Variant::Icm20689 => 5,
            Variant::Clone6500(_) => 6,
        }
    }
}

/// Map a WHO_AM_I value to a supported variant. Unknown values are NOT
/// accepted — other parts live at 0x68 too (DS3231/PCF8523 RTCs, ITG-3200),
/// and reading a non-IMU as an IMU would publish garbage orientation.
pub fn identify(who_am_i: u8) -> Option<Variant> {
    match who_am_i {
        0x68 => Some(Variant::Mpu6050),
        0x70 => Some(Variant::Mpu6500),
        0x71 => Some(Variant::Mpu9250),
        0x73 => Some(Variant::Mpu9255),
        0x98 => Some(Variant::Icm20689),
        0x72 | 0x74 | 0x75 => Some(Variant::Clone6500(who_am_i)),
        _ => None,
    }
}

/// What answered at one address.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Found {
    pub addr: u8,
    pub who_am_i: u8,
    /// `None`: something ACKed and returned an unrecognized WHO_AM_I.
    pub variant: Option<Variant>,
}

/// Probe 0x68 then 0x69. Returns the first recognized IMU; failing that the
/// first responder with an unknown id (so the user can see "something is at
/// 0x68 but it isn't an MPU"); `None` if nothing ACKed. Cost: one or two
/// 1-byte register reads (~0.1 ms each at 400 kHz; a NACK aborts after the
/// address byte).
pub fn probe<B: I2cBus>(bus: &mut B) -> Option<Found> {
    let mut unknown = None;
    for addr in [ADDR_AD0_LOW, ADDR_AD0_HIGH] {
        if let Ok(who) = bus.read_reg(addr, reg::WHO_AM_I) {
            let f = Found { addr, who_am_i: who, variant: identify(who) };
            if f.variant.is_some() {
                return Some(f);
            }
            if unknown.is_none() {
                unknown = Some(f);
            }
        }
    }
    unknown
}

/// Digital low-pass filter setting (CONFIG.DLPF_CFG). Gyro bandwidth shown;
/// the accel's is within a few Hz. Any setting other than `Off` puts the gyro
/// output rate at 1 kHz, which the sample-rate divider then decimates.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Dlpf {
    Off = 0,
    Hz188 = 1,
    Hz98 = 2,
    Hz42 = 3,
    Hz20 = 4,
    Hz10 = 5,
    Hz5 = 6,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum GyroRange {
    Dps250 = 0,
    Dps500 = 1,
    Dps1000 = 2,
    Dps2000 = 3,
}

impl GyroRange {
    /// LSB per degree/second.
    pub fn lsb_per_dps(self) -> f32 {
        131.0 / (1u32 << (self as u32)) as f32
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum AccelRange {
    G2 = 0,
    G4 = 1,
    G8 = 2,
    G16 = 3,
}

impl AccelRange {
    /// LSB per g.
    pub fn lsb_per_g(self) -> f32 {
        (16384u32 >> (self as u32)) as f32
    }
}

/// Sampling configuration.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// Output data rate, Hz (1 kHz / (1 + SMPLRT_DIV); rounded to a divider).
    pub odr_hz: u16,
    pub dlpf: Dlpf,
    pub gyro_range: GyroRange,
    pub accel_range: AccelRange,
    /// Batch through the on-chip FIFO (sample timing from the IMU clock, so
    /// render-task preemption can't jitter dt). `false`: direct burst reads.
    pub fifo: bool,
}

impl Default for Config {
    /// 100 Hz, ~42 Hz DLPF (anti-aliased for 100 Hz, 4.8 ms group delay),
    /// ±1000 °/s (a hand-spun lamp stays well inside), ±8 g (taps/knocks
    /// clip at 2-4 g).
    fn default() -> Config {
        Config {
            odr_hz: 100,
            dlpf: Dlpf::Hz42,
            gyro_range: GyroRange::Dps1000,
            accel_range: AccelRange::G8,
            fifo: true,
        }
    }
}

impl Config {
    /// SMPLRT_DIV for `odr_hz` (DLPF on: 1 kHz base).
    pub fn smplrt_div(&self) -> u8 {
        let base: u32 = if self.dlpf == Dlpf::Off { 8000 } else { 1000 };
        let odr = (self.odr_hz as u32).clamp(4, base);
        (base / odr - 1).min(255) as u8
    }

    /// The rate the chip actually produces with [`Config::smplrt_div`].
    pub fn actual_odr_hz(&self) -> f32 {
        let base: f32 = if self.dlpf == Dlpf::Off { 8000.0 } else { 1000.0 };
        base / (1.0 + self.smplrt_div() as f32)
    }
}

/// Start a device reset. The part needs ~100 ms before it accepts config
/// (the hub waits for it without blocking; see [`crate::hub`]).
pub fn reset<B: I2cBus>(bus: &mut B, addr: u8) -> Result<(), BusError> {
    bus.write_reg(addr, reg::PWR_MGMT_1, bits::PWR_DEVICE_RESET)
}

/// Program a freshly reset part. Verifies the range registers read back (a
/// write that silently didn't land — wrong device, flaky wiring — fails here
/// rather than publishing mis-scaled data).
pub fn configure<B: I2cBus>(bus: &mut B, addr: u8, v: Variant, cfg: &Config) -> Result<(), BusError> {
    bus.write_reg(addr, reg::PWR_MGMT_1, bits::PWR_CLK_PLL_X)?;
    bus.write_reg(addr, reg::PWR_MGMT_2, 0x00)?; // all axes on
    bus.write_reg(addr, reg::SMPLRT_DIV, cfg.smplrt_div())?;
    let mut config = cfg.dlpf as u8;
    if v.family() == Family::Mpu6500 {
        config |= bits::CONFIG_FIFO_MODE_STOP;
        // Accel DLPF: A_DLPF_CFG uses the same index scale (ACCEL_FCHOICE_B=0).
        bus.write_reg(addr, reg::ACCEL_CONFIG2, (cfg.dlpf as u8).max(1))?;
    }
    bus.write_reg(addr, reg::CONFIG, config)?;
    let gyro = (cfg.gyro_range as u8) << 3;
    let accel = (cfg.accel_range as u8) << 3;
    bus.write_reg(addr, reg::GYRO_CONFIG, gyro)?;
    bus.write_reg(addr, reg::ACCEL_CONFIG, accel)?;
    bus.write_reg(addr, reg::INT_ENABLE, 0x00)?; // polled; INT pin is a later option
    if bus.read_reg(addr, reg::GYRO_CONFIG)? & 0x18 != gyro
        || bus.read_reg(addr, reg::ACCEL_CONFIG)? & 0x18 != accel
    {
        return Err(BusError::Other);
    }
    if cfg.fifo {
        fifo_enable(bus, addr)?;
    } else {
        bus.write_reg(addr, reg::FIFO_EN, 0x00)?;
        bus.write_reg(addr, reg::USER_CTRL, 0x00)?;
    }
    Ok(())
}

/// Reset and (re)start the FIFO capturing gyro + accel.
pub fn fifo_enable<B: I2cBus>(bus: &mut B, addr: u8) -> Result<(), BusError> {
    bus.write_reg(addr, reg::FIFO_EN, 0x00)?;
    bus.write_reg(addr, reg::USER_CTRL, bits::USER_FIFO_RESET)?;
    bus.write_reg(addr, reg::USER_CTRL, bits::USER_FIFO_EN)?;
    bus.write_reg(addr, reg::FIFO_EN, bits::FIFO_GYRO_ACCEL)
}

/// Stop the FIFO (poll-mode fallback for clones whose FIFO never fills).
pub fn fifo_disable<B: I2cBus>(bus: &mut B, addr: u8) -> Result<(), BusError> {
    bus.write_reg(addr, reg::FIFO_EN, 0x00)?;
    bus.write_reg(addr, reg::USER_CTRL, 0x00)
}

/// Bytes waiting in the FIFO (13-bit; read high then low in one burst so the
/// pair is coherent).
pub fn fifo_count<B: I2cBus>(bus: &mut B, addr: u8) -> Result<u16, BusError> {
    let mut b = [0u8; 2];
    bus.write_read(addr, &[reg::FIFO_COUNTH], &mut b)?;
    Ok(u16::from_be_bytes([b[0] & 0x1F, b[1]]))
}

/// Pop `buf.len()` bytes from the FIFO.
pub fn fifo_read<B: I2cBus>(bus: &mut B, addr: u8, buf: &mut [u8]) -> Result<(), BusError> {
    bus.write_read(addr, &[reg::FIFO_R_W], buf)
}

/// INT_STATUS (reading clears it).
pub fn int_status<B: I2cBus>(bus: &mut B, addr: u8) -> Result<u8, BusError> {
    bus.read_reg(addr, reg::INT_STATUS)
}

/// One raw sample, sensor axes, chip units.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Raw {
    pub accel: [i16; 3],
    pub gyro: [i16; 3],
    /// Only from burst reads (the FIFO path doesn't capture temperature).
    pub temp: Option<i16>,
}

fn be(b: &[u8], i: usize) -> i16 {
    i16::from_be_bytes([b[i], b[i + 1]])
}

/// Decode a 14-byte ACCEL_XOUT_H.. burst.
pub fn parse_burst(b: &[u8; BURST_BYTES]) -> Raw {
    Raw {
        accel: [be(b, 0), be(b, 2), be(b, 4)],
        temp: Some(be(b, 6)),
        gyro: [be(b, 8), be(b, 10), be(b, 12)],
    }
}

/// Decode one 12-byte FIFO frame (accel xyz, gyro xyz — register order).
pub fn parse_fifo(b: &[u8]) -> Raw {
    Raw {
        accel: [be(b, 0), be(b, 2), be(b, 4)],
        gyro: [be(b, 6), be(b, 8), be(b, 10)],
        temp: None,
    }
}

/// Direct burst read of the latest sample.
pub fn read_burst<B: I2cBus>(bus: &mut B, addr: u8) -> Result<Raw, BusError> {
    let mut b = [0u8; BURST_BYTES];
    bus.write_read(addr, &[reg::ACCEL_XOUT_H], &mut b)?;
    Ok(parse_burst(&b))
}

/// Raw temperature register (TEMP_OUT_H/L).
pub fn read_temp<B: I2cBus>(bus: &mut B, addr: u8) -> Result<i16, BusError> {
    let mut b = [0u8; 2];
    bus.write_read(addr, &[reg::TEMP_OUT_H], &mut b)?;
    Ok(i16::from_be_bytes(b))
}

/// Die temperature, °C.
pub fn temp_c(family: Family, raw: i16) -> f32 {
    match family {
        Family::Mpu6050 => raw as f32 / 340.0 + 36.53,
        Family::Mpu6500 => raw as f32 / 333.87 + 21.0,
    }
}
