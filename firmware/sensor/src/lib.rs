//! Splanc sensor core (docs/design/sensor-core.md): the I2C bus seam, the
//! MPU-6050-family driver, attitude fusion, gestures and calibration records.
//!
//! `no_std`, zero-dependency, never allocates — linked into the player app
//! (//firmware/player_app ffi.rs owns the static [`hub::Hub`], the C++ side
//! owns the ESP-IDF `i2c_master` bus and the sensor task) and host-tested
//! against a register-file fake bus in `tests/`.
//!
//! Fusion follows indoor_localization's `swarm/core` conventions (SI units,
//! scalar-first body->world quaternion, z-up world) so its estimator can be
//! slotted in behind [`fusion::AttitudeFilter`] without touching the driver or
//! the consumers.

#![no_std]

pub mod bus;
pub mod calib;
pub mod fusion;
pub mod gesture;
pub mod hub;
pub mod math;
pub mod mpu6050;

pub use bus::{BusError, I2cBus};
pub use hub::{CalAction, CalError, Hub, Snapshot, State};
