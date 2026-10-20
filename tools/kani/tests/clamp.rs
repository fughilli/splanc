//! A dependency for the Kani harnesses in uses_clamp.rs.
#![no_std]

/// Saturate to a byte.
pub fn clamp8(x: u32) -> u8 {
    if x > 255 {
        255
    } else {
        x as u8
    }
}
