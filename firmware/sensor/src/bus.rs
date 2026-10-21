//! The bus seam: everything a sensor driver needs from I2C, nothing more.
//!
//! On the device the implementation is `ffi.rs`'s `FfiBus`, which calls the
//! C++ ESP-IDF `i2c_master` glue (`firmware/player_app/sensor_bus.cpp`) through
//! function pointers registered at boot — so host builds never see an undefined
//! `lm_i2c_*` symbol. Host tests implement it with a register-file fake.

/// Why a bus transaction failed. Drivers only distinguish "nobody answered"
/// (probe miss, unplugged sensor) from everything else.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BusError {
    /// Address NACK: no device there (or it is mid-reset).
    Nack,
    /// Arbitration loss, SCL stretch timeout, stuck bus, driver error.
    Other,
}

/// A 7-bit-addressed I2C master. All register-oriented: drivers write a
/// register pointer then read with a repeated start (`write_read`), or write
/// `[reg, value...]` (`write`).
pub trait I2cBus {
    /// Write `wr` then (repeated start) read `rd.len()` bytes.
    fn write_read(&mut self, addr: u8, wr: &[u8], rd: &mut [u8]) -> Result<(), BusError>;
    /// Plain write transaction.
    fn write(&mut self, addr: u8, wr: &[u8]) -> Result<(), BusError>;

    /// Read one register.
    fn read_reg(&mut self, addr: u8, reg: u8) -> Result<u8, BusError> {
        let mut b = [0u8; 1];
        self.write_read(addr, &[reg], &mut b)?;
        Ok(b[0])
    }

    /// Write one register.
    fn write_reg(&mut self, addr: u8, reg: u8, val: u8) -> Result<(), BusError> {
        self.write(addr, &[reg, val])
    }
}
