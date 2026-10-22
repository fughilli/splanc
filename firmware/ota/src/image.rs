//! ESP-IDF app image header checks, run on the first chunk before anything is
//! erased past it: a valid signature says WHO built an image, not that it's an
//! app for THIS chip — a C3 image signed with the same key must not reach a C6.
//!
//! `esp_image_header_t` (24 bytes): magic 0xE9, segment_count, spi_mode,
//! spi_speed/size, entry_addr (4), wp_pin, spi_pin_drv[3], chip_id (u16 LE at
//! 12), min_chip_rev, min/max_chip_rev_full (u16 each), reserved[4],
//! hash_appended (at 23). The first segment header (8 bytes) follows, and the
//! app's `esp_app_desc_t` starts at byte 32 with magic 0xABCD5432.

pub const HEADER_LEN: usize = 24;
pub const IMAGE_MAGIC: u8 = 0xE9;
pub const APP_DESC_OFFSET: usize = 32;
pub const APP_DESC_MAGIC: u32 = 0xABCD_5432;

/// `esp_chip_id_t` values.
pub const CHIP_ESP32C3: u16 = 0x0005;
pub const CHIP_ESP32C6: u16 = 0x000D;

/// Bytes of the image the header check needs.
pub const CHECK_LEN: usize = APP_DESC_OFFSET + 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageError {
    /// Fewer than [`CHECK_LEN`] bytes.
    Short,
    BadMagic,
    WrongChip { got: u16 },
    /// No `esp_app_desc_t`: a bootloader or a data blob, not an app.
    NotAnApp,
    /// The bootloader verifies an app by its appended SHA-256; without it a
    /// corrupted slot could still boot.
    NoAppendedHash,
}

impl ImageError {
    pub fn code(&self) -> &'static str {
        match self {
            ImageError::Short | ImageError::BadMagic | ImageError::NotAnApp => "bad_image",
            ImageError::WrongChip { .. } => "wrong_chip",
            ImageError::NoAppendedHash => "bad_image",
        }
    }
}

/// Check the start of an image (at least [`CHECK_LEN`] bytes) is an app for `chip`.
pub fn check_header(b: &[u8], chip: u16) -> Result<(), ImageError> {
    if b.len() < CHECK_LEN {
        return Err(ImageError::Short);
    }
    if b[0] != IMAGE_MAGIC || b[1] == 0 || b[1] > 16 {
        return Err(ImageError::BadMagic);
    }
    let got = u16::from_le_bytes([b[12], b[13]]);
    if got != chip {
        return Err(ImageError::WrongChip { got });
    }
    if b[23] != 1 {
        return Err(ImageError::NoAppendedHash);
    }
    let magic = u32::from_le_bytes([
        b[APP_DESC_OFFSET],
        b[APP_DESC_OFFSET + 1],
        b[APP_DESC_OFFSET + 2],
        b[APP_DESC_OFFSET + 3],
    ]);
    if magic != APP_DESC_MAGIC {
        return Err(ImageError::NotAnApp);
    }
    Ok(())
}
