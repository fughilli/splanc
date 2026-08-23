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

/// MAC datapath bring-up, reconstructed from the vendor `libpp` decompilation
/// (see esp32-reverse `docs/re/07-lower-mac-registers.md`): `hal_mac_init` (clear
/// the power-retention bits) then `mac_txrx_init` (configure the TX/RX datapath),
/// leaving RX disabled for the caller to arm after installing the descriptor ring.
pub mod datapath {
    use super::mmio;

    // MAC datapath registers (verbatim addresses from the RE'd accessors).
    const MAC_INIT_RETENTION: usize = 0x600A_4CA8; // hal_mac_init clears bits here
    const RX_CTRL: usize = 0x600A_4080; // bit31 = RX enable

    /// `hal_mac_init`: take the MAC core out of power retention. `retention_mask`
    /// is `pm_get_tx_blocks_retention_mask()` on real hardware.
    ///
    /// # Safety: MMIO; the MAC must be powered + clocked.
    pub unsafe fn mac_init(retention_mask: u32) {
        let clr = (retention_mask & 0x00ff_0000) | 0x1000;
        let v = mmio::read32(MAC_INIT_RETENTION) & !clr;
        mmio::write32(MAC_INIT_RETENTION, v);
    }

    /// `mac_txrx_init`: configure the TX/RX datapath (EDCA queue params, HE timing
    /// fields, thresholds) and leave RX disabled (bit31 of `RX_CTRL` cleared).
    ///
    /// # Safety: MMIO; call after [`mac_init`].
    pub unsafe fn txrx_init() {
        // (addr, and-mask, or-value): reg = (reg & and) | or.
        const SEQ: &[(usize, u32, u32)] = &[
            (0x600A_4C98, !0x8, 0x0),
            (0x600A_4100, 0xffff, 0x0),
            (0x600A_4104, 0xffff, 0x0),
            (0x600A_40F8, 0xffff, 0x0500_0000),
            (0x600A_40FC, 0xffff, 0x0500_0000),
            (0x600A_4C8C, !0, 0x9080_B200),
            (0x600A_4110, !0, 0x11),
            (0x600A_4114, 0xf00f_ffff, 0x81B0_0000),
            (0x600A_4C9C, !0, 0x3),
            // (HE timing: hal_he_set_mac_delay/ack_rate/bbrxhung — vendor PHY, skipped)
            (0x600A_4C1C, !0, 0xC000_0000),
            (0x600A_4C20, 0xffff_f000, 0xF0),
            (0x600A_4C24, 0xffff_f000, 0xF0),
            (0x600A_4CA4, 0xffff_ff0f, 0x40),
            (0x600A_4C60, !0, 0xffff_0000),
            (0x600A_4308, !0, 0x2),
        ];
        for &(addr, and, or) in SEQ {
            let v = (mmio::read32(addr) & and) | or;
            mmio::write32(addr, v);
        }
        // Leave RX disabled (clear bit31); the caller arms it after ring install.
        let v = mmio::read32(RX_CTRL) & 0x7fff_ffff;
        mmio::write32(RX_CTRL, v);
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn mac_init_clears_retention_and_1000() {
            mmio::test_reset();
            mmio::test_seed(MAC_INIT_RETENTION, 0xffff_ffff);
            unsafe { mac_init(0x00AB_0000) };
            let v = mmio::test_get(MAC_INIT_RETENTION).unwrap();
            assert_eq!(v & 0x00ff_0000, 0x0054_0000); // 0xff & ~0xAB = 0x54
            assert_eq!(v & 0x1000, 0);
        }

        #[test]
        fn txrx_init_matches_re_sequence_and_disables_rx() {
            mmio::test_reset();
            mmio::test_seed(RX_CTRL, 0x8000_0000); // RX enabled -> must be cleared
            unsafe { txrx_init() };
            assert_eq!(mmio::test_get(0x600A_40F8).unwrap(), 0x0500_0000);
            assert_eq!(mmio::test_get(0x600A_4C8C).unwrap(), 0x9080_B200);
            assert_eq!(mmio::test_get(0x600A_4110).unwrap(), 0x11);
            assert_eq!(mmio::test_get(0x600A_4114).unwrap(), 0x81B0_0000);
            assert_eq!(mmio::test_get(0x600A_4C20).unwrap(), 0xF0);
            assert_eq!(mmio::test_get(RX_CTRL).unwrap() & 0x8000_0000, 0);
        }
    }
}

/// MAC controller bring-up: clear power retention, then configure the datapath.
///
/// # Safety: MMIO; the MAC must be powered + clocked.
pub unsafe fn init(retention_mask: u32) {
    datapath::mac_init(retention_mask);
    datapath::txrx_init();
}

/// Read the TSF timer (`0x600A_D014` latch control + `0x600A_D020` counter).
///
/// # Safety: MMIO; the MAC must be initialized.
pub unsafe fn tsf_now() -> u32 {
    const TSF_CTRL: usize = 0x600A_D014;
    const TSF_COUNT: usize = 0x600A_D020;
    let c = mmio::read32(TSF_CTRL); // hal_mac_tsf_get_time toggles latch bits
    mmio::write32(TSF_CTRL, c & !0x2);
    mmio::write32(TSF_CTRL, c & !0x4);
    mmio::read32(TSF_COUNT)
}
