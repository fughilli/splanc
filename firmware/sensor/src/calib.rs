//! Persisted per-device sensor calibration.
//!
//! One small versioned, CRC'd record. The firmware stores it as a single NVS
//! blob (`Preferences::putBytes("sens_cal")`): an NVS entry write is atomic —
//! after a power cut the key reads either the old or the new value, never a
//! torn one — and the CRC here additionally rejects a record from a different
//! layout or a bit-rotted page, falling back to defaults (the filter re-learns
//! the gyro bias at rest within a second, so a lost record is benign).

use crate::math::{Quat, Vec3};

pub const MAGIC: [u8; 4] = *b"SCAL";
pub const VERSION: u8 = 1;
/// magic 4 + version 1 + flags 1 + reserved 2 + 16 f32 + crc 4.
pub const RECORD_LEN: usize = 8 + 16 * 4 + 4;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Calibration {
    /// Gyro zero-rate offset, rad/s, SENSOR frame.
    pub gyro_bias: Vec3,
    /// Accel offset, m/s², sensor frame (subtracted before scale).
    pub accel_offset: Vec3,
    /// Accel per-axis gain correction (multiplied after offset).
    pub accel_scale: Vec3,
    /// Sensor -> fixture rotation (how the board is mounted in the lamp;
    /// identity = sensor axes are the fixture axes). Same role as
    /// widget.v1 `SensorExtrinsic.rotation`.
    pub mount: Quat,
    /// Bit 0: gyro_bias was measured (not a default).
    pub flags: u8,
}

pub const FLAG_GYRO_BIAS: u8 = 0x01;
pub const FLAG_ACCEL: u8 = 0x02;
pub const FLAG_MOUNT: u8 = 0x04;

impl Default for Calibration {
    fn default() -> Calibration {
        Calibration {
            gyro_bias: Vec3::ZERO,
            accel_offset: Vec3::ZERO,
            accel_scale: Vec3::new(1.0, 1.0, 1.0),
            mount: Quat::IDENTITY,
            flags: 0,
        }
    }
}

/// CRC-32 (IEEE, reflected), bitwise — 76 bytes once per boot/save, no table.
pub fn crc32(data: &[u8]) -> u32 {
    let mut c = 0xFFFF_FFFFu32;
    for &b in data {
        c ^= b as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 { (c >> 1) ^ 0xEDB8_8320 } else { c >> 1 };
        }
    }
    !c
}

impl Calibration {
    fn floats(&self) -> [f32; 16] {
        let g = self.gyro_bias;
        let o = self.accel_offset;
        let s = self.accel_scale;
        let m = self.mount;
        [g.x, g.y, g.z, o.x, o.y, o.z, s.x, s.y, s.z, m.w, m.x, m.y, m.z, 0.0, 0.0, 0.0]
    }

    pub fn encode(&self) -> [u8; RECORD_LEN] {
        let mut out = [0u8; RECORD_LEN];
        out[..4].copy_from_slice(&MAGIC);
        out[4] = VERSION;
        out[5] = self.flags;
        for (i, f) in self.floats().iter().enumerate() {
            out[8 + 4 * i..12 + 4 * i].copy_from_slice(&f.to_le_bytes());
        }
        let crc = crc32(&out[..RECORD_LEN - 4]);
        out[RECORD_LEN - 4..].copy_from_slice(&crc.to_le_bytes());
        out
    }

    /// `None` for a wrong length/magic/version/CRC or non-finite values.
    pub fn decode(b: &[u8]) -> Option<Calibration> {
        if b.len() != RECORD_LEN || b[..4] != MAGIC || b[4] != VERSION {
            return None;
        }
        let crc = u32::from_le_bytes([b[RECORD_LEN - 4], b[RECORD_LEN - 3], b[RECORD_LEN - 2], b[RECORD_LEN - 1]]);
        if crc32(&b[..RECORD_LEN - 4]) != crc {
            return None;
        }
        let mut f = [0f32; 16];
        for (i, v) in f.iter_mut().enumerate() {
            *v = f32::from_le_bytes([b[8 + 4 * i], b[9 + 4 * i], b[10 + 4 * i], b[11 + 4 * i]]);
            if !v.is_finite() {
                return None;
            }
        }
        Some(Calibration {
            gyro_bias: Vec3::new(f[0], f[1], f[2]),
            accel_offset: Vec3::new(f[3], f[4], f[5]),
            accel_scale: Vec3::new(f[6], f[7], f[8]),
            mount: Quat::new(f[9], f[10], f[11], f[12]).normalized(),
            flags: b[5],
        })
    }

    /// Sensor-frame raw (SI) -> corrected fixture-frame accel.
    pub fn apply_accel(&self, a: Vec3) -> Vec3 {
        self.mount.rotate(a.sub(self.accel_offset).mul(self.accel_scale))
    }

    /// Sensor-frame gyro -> fixture frame (bias is the filter's job).
    pub fn apply_gyro(&self, w: Vec3) -> Vec3 {
        self.mount.rotate(w)
    }
}
