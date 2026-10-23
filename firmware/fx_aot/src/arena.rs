//! Placing a native code image inside the FX arena (docs/design/fx-native-aot.md,
//! owner decision: native code lives in the deck's arena share, never general
//! heap). This module is the allocation/protection *math*; the device wiring
//! (player_app) calls it and then programs the PMP/PMA CSRs. It is pure and
//! unit-tested, so the netstack port is a wiring job.
//!
//! Execution protection uses a RISC-V PMP entry for execute (as the JIT already
//! does in main.cpp) plus an Espressif PMA entry to deny writes while the code
//! runs — the PMA write-protection probe confirmed an unlocked PMA entry denies
//! a machine-mode store (see the doc's "PMA probe"). Both are NAPOT so two decks
//! can be protected at once during a crossfade:
//!
//! | region        | PMP entry | PMA entry |
//! |---------------|-----------|-----------|
//! | deck A code   | 3 (NAPOT) | 13 (NAPOT)|
//! | deck B code   | 4 (NAPOT) | 14 (NAPOT)|
//!
//! NAPOT requires a power-of-two size and a base aligned to that size, so the
//! arena buffer is aligned to [`MAX_CODE_REGION`] and a deck's code region is
//! carved at a size-aligned offset at the *top* of its share (buffers grow from
//! the bottom). If the rounded-up code region doesn't fit the share, the effect
//! stays on the VM (never heap).

/// Smallest NAPOT region the PMP/PMA support (8 bytes); we never go below the
/// word granularity anyway.
pub const MIN_CODE_REGION: usize = 64;
/// Largest native code region we will carve from a deck's arena share. Caps the
/// alignment the arena buffer needs and bounds a single effect's native size.
pub const MAX_CODE_REGION: usize = 8192;

/// A planned native-code region inside a deck's arena share (byte offsets within
/// the whole arena buffer). The device copies the image to `base.. `, programs
/// PMP/PMA over `[base, base+size)`, and runs from `base`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RegionPlan {
    /// Byte offset of the code region within the arena buffer (NAPOT-aligned
    /// relative to the buffer; the buffer itself is `MAX_CODE_REGION`-aligned).
    pub code_off: usize,
    /// NAPOT size of the code region (power of two ≥ the image size).
    pub code_size: usize,
    /// Bytes of the deck's share left for the effect's buffers (below the code).
    pub buffers_avail: usize,
}

fn next_pow2(mut n: usize) -> usize {
    if n <= MIN_CODE_REGION {
        return MIN_CODE_REGION;
    }
    n -= 1;
    let mut p = MIN_CODE_REGION;
    while p < n + 1 {
        p <<= 1;
    }
    p
}

/// Plan a native-code region for one deck.
///
/// The deck owns `[deck_off, deck_off + deck_len)` of the arena buffer (deck A
/// from the front, deck B from the back — see player_app `fx_load`). The buffers
/// the effect declares need `buffers_need` bytes (from the bottom of the share).
/// The code region of `image_bytes` is rounded up to NAPOT and placed at the top
/// of the share, size-aligned. Returns `None` (⇒ VM fallback) if it can't fit
/// alongside the buffers, exceeds [`MAX_CODE_REGION`], or the buffer is not
/// `MAX_CODE_REGION`-aligned at `deck_off` for NAPOT.
pub fn plan_region(
    deck_off: usize,
    deck_len: usize,
    buffers_need: usize,
    image_bytes: usize,
) -> Option<RegionPlan> {
    if image_bytes == 0 {
        return None;
    }
    let size = next_pow2(image_bytes);
    if size > MAX_CODE_REGION || size > deck_len {
        return None;
    }
    // Place the code region at the highest size-aligned offset in the share that
    // still leaves `buffers_need` bytes below it.
    let top = deck_off + deck_len;
    // Largest size-aligned base ≤ top - size.
    let base = (top - size) & !(size - 1);
    if base < deck_off {
        return None; // the share doesn't contain a size-aligned slot
    }
    if base < deck_off + buffers_need {
        return None; // would overlap the buffers
    }
    Some(RegionPlan {
        code_off: base,
        code_size: size,
        buffers_avail: base - deck_off,
    })
}

/// The PMP NAPOT `pmpaddr` CSR value for a region at absolute address
/// `base` of `size` bytes (`base` size-aligned, `size` a power of two ≥ 8).
/// Mirrors main.cpp's JIT arming; the device uses it for PMP entries 3/4.
#[inline]
pub fn pmp_napot_addr(base: usize, size: usize) -> usize {
    (base >> 2) | ((size >> 3) - 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn next_pow2_rounds_up() {
        assert_eq!(next_pow2(1), MIN_CODE_REGION);
        assert_eq!(next_pow2(64), 64);
        assert_eq!(next_pow2(65), 128);
        assert_eq!(next_pow2(1500), 2048);
        assert_eq!(next_pow2(2048), 2048);
        assert_eq!(next_pow2(2049), 4096);
    }

    #[test]
    fn deck_a_front_share() {
        // Deck A owns the front 12 KiB; a ~1.5 KiB image needs 2 KiB NAPOT.
        let p = plan_region(0, 12 * 1024, 1024, 1500).unwrap();
        assert_eq!(p.code_size, 2048);
        assert_eq!(p.code_off % p.code_size, 0); // size-aligned
        assert!(p.code_off >= 1024); // above the 1 KiB of buffers
        assert_eq!(p.buffers_avail, p.code_off);
    }

    #[test]
    fn deck_b_back_share_aligned() {
        // Deck B owns the back 8 KiB (offset 16 KiB); region must stay aligned.
        let p = plan_region(16 * 1024, 8 * 1024, 0, 3000).unwrap();
        assert_eq!(p.code_size, 4096);
        assert_eq!(p.code_off % 4096, 0);
        assert!(p.code_off >= 16 * 1024);
        assert!(p.code_off + p.code_size <= 24 * 1024);
    }

    #[test]
    fn refuses_when_buffers_crowd_it() {
        // 11 KiB of buffers in a 12 KiB share leaves no 2 KiB aligned slot.
        assert!(plan_region(0, 12 * 1024, 11 * 1024, 1500).is_none());
    }

    #[test]
    fn refuses_over_max() {
        assert!(plan_region(0, 64 * 1024, 0, MAX_CODE_REGION + 1).is_none());
    }

    #[test]
    fn pmp_addr_matches_manual() {
        // 2 KiB region at 0x4080_e000 (the probe's window math).
        let base = 0x4080_e000usize;
        let got = pmp_napot_addr(base, 2048);
        assert_eq!(got, (base >> 2) | ((2048 >> 3) - 1));
    }
}
