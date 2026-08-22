//! WiFi lower-MAC — the hardware-abstraction core (`hal_*` + `lmac`).
//!
//! Bring-up order:
//!
//! 1. **MAC core control** — reset, enable, and the MAC register block base.
//!    Direct MMIO via [`crate::regs::mmio`].
//! 2. **TSF timers** — small and self-contained; a good first target.
//! 3. **RX path** — the RX DMA descriptor ring and filter config.
//! 4. **TX path** — the TX DMA descriptors and rate/duration config.
//! 5. **Crypto engine** — CCMP/GCMP/TKIP key slots.
//! 6. **A-MPDU / HE** — aggregation and high-efficiency support.
//! 7. **lmac core** — the state machine tying the HAL to the upper MAC (out of
//!    scope until the HAL is complete).

use crate::regs::{mac, mmio};

/// MAC interrupt controller: each accessor is a single MMIO operation.
pub mod interrupt {
    use super::{mac, mmio};

    /// Read the MAC interrupt status register.
    #[inline]
    pub fn status() -> u32 {
        unsafe { mmio::read32(mac::INT_STATUS) }
    }

    /// Clear the given interrupt bits (write-1-to-clear).
    #[inline]
    pub fn clear(mask: u32) {
        unsafe { mmio::write32(mac::INT_CLEAR, mask) }
    }
}

/// MAC RX descriptor ring: each accessor is a single MMIO operation.
pub mod rx {
    use super::{mac, mmio};

    /// Program the RX descriptor ring base pointer.
    #[inline]
    pub fn set_dscr_base(dscr: *const ()) {
        unsafe { mmio::write32(mac::RX_DSCR_BASE, dscr as u32) }
    }

    /// Read the next RX descriptor pointer.
    #[inline]
    pub fn next_dscr() -> u32 {
        unsafe { mmio::read32(mac::RX_DSCR_NEXT) }
    }
}

/// MAC controller reset/enable. Not yet implemented: it requires the full core
/// initialization sequence.
pub fn init() {
    unimplemented!("MAC init: core initialization sequence not yet implemented")
}

/// Read the TSF timer. Not yet implemented.
pub fn tsf_now() -> u64 {
    unimplemented!("tsf_now: TSF timer read not yet implemented")
}
