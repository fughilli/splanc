//! The soft-reset carry-over record (kept in `RTC_NOINIT` RAM by the firmware,
//! written about once a second, restored at boot after a SW/panic/WDT/OTA
//! reset). Fixed layout, little-endian, CRC-32 guarded so a power-on's random
//! RAM never decodes.

use crate::discipline::{Offer, Source};

/// "CLK1", little-endian.
pub const CARRY_MAGIC: u32 = u32::from_le_bytes(*b"CLK1");
/// Encoded size: magic(4) unix(8) err(8) source(1) pad(3) crc(4).
pub const CARRY_BYTES: usize = 28;

/// The time worth carrying over a reboot.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CarryRecord {
    /// Displayed UTC µs when written.
    pub unix_us: i64,
    /// The clock's error bound when written, µs.
    pub err_us: i64,
    /// The source the clock had when written (for the status line; the
    /// restored offer is always [`Source::Carry`]).
    pub source: Source,
}

/// CRC-32 (IEEE 802.3, reflected, as zlib), bitwise: no table in flash.
pub fn crc32(data: &[u8]) -> u32 {
    let mut crc = 0xFFFF_FFFFu32;
    for &b in data {
        crc ^= b as u32;
        for _ in 0..8 {
            let mask = (crc & 1).wrapping_neg();
            crc = (crc >> 1) ^ (0xEDB8_8320 & mask);
        }
    }
    !crc
}

impl CarryRecord {
    pub fn encode(&self) -> [u8; CARRY_BYTES] {
        let mut b = [0u8; CARRY_BYTES];
        b[0..4].copy_from_slice(&CARRY_MAGIC.to_le_bytes());
        b[4..12].copy_from_slice(&self.unix_us.to_le_bytes());
        b[12..20].copy_from_slice(&self.err_us.to_le_bytes());
        b[20] = self.source.to_u8();
        let crc = crc32(&b[..24]);
        b[24..28].copy_from_slice(&crc.to_le_bytes());
        b
    }

    /// `None` for a bad magic, CRC, source or error bound.
    pub fn decode(b: &[u8; CARRY_BYTES]) -> Option<Self> {
        let word = |r: core::ops::Range<usize>| {
            let mut w = [0u8; 4];
            w.copy_from_slice(&b[r]);
            u32::from_le_bytes(w)
        };
        let long = |r: core::ops::Range<usize>| {
            let mut w = [0u8; 8];
            w.copy_from_slice(&b[r]);
            i64::from_le_bytes(w)
        };
        if word(0..4) != CARRY_MAGIC || word(24..28) != crc32(&b[..24]) {
            return None;
        }
        if b[21..24] != [0, 0, 0] {
            return None;
        }
        let err_us = long(12..20);
        if err_us < 0 {
            return None;
        }
        Some(CarryRecord {
            unix_us: long(4..12),
            err_us,
            source: Source::from_u8(b[20])?,
        })
    }

    /// The offer to make at boot: the record's time, taken as true at
    /// `boot_mono_us`, with `gap_err_us` (the unknown reboot gap, e.g. 1 s)
    /// added to its error.
    pub fn to_offer(&self, boot_mono_us: i64, gap_err_us: i64) -> Offer {
        Offer::new(
            Source::Carry,
            self.unix_us,
            boot_mono_us,
            self.err_us.saturating_add(gap_err_us.max(0)),
        )
    }
}
