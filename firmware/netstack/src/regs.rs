//! The ESP32-C6 MAC/PHY register map and low-level access primitives.
//!
//! The PHY reaches the radio hardware through two buses, and the lower-MAC
//! through direct MMIO. This module exposes all three access paths:
//!
//! * [`mmio`] — plain volatile 32-bit MMIO (MAC/HAL registers).
//! * [`pbus`] — the baseband/PHY register bus (force-mode + banked readback).
//! * [`i2c_rf`] — the analog I²C master to the RF synthesizer / BBPLL / bias.
//!
//! Register addresses and the PBUS/I²C command encodings are given as typed
//! constants so the higher layers can address the hardware directly.

/// Raw volatile MMIO. Safe wrappers live in the peripheral modules.
pub mod mmio {
    /// # Safety: `addr` must be a valid peripheral register address.
    #[cfg(not(test))]
    #[inline(always)]
    pub unsafe fn read32(addr: usize) -> u32 {
        core::ptr::read_volatile(addr as *const u32)
    }

    /// # Safety: `addr` must be a valid peripheral register address.
    #[cfg(not(test))]
    #[inline(always)]
    pub unsafe fn write32(addr: usize, val: u32) {
        core::ptr::write_volatile(addr as *mut u32, val)
    }

    // On the host test build there is no memory-mapped peripheral, so record
    // reads/writes into a per-thread register file. This lets the MAC MMIO paths
    // (bring-up, RX/TX ring install) be unit-tested against the reconstructed
    // register map instead of touching a real address (which would segfault).
    #[cfg(test)]
    thread_local! {
        static REGS: std::cell::RefCell<std::collections::BTreeMap<usize, u32>> =
            std::cell::RefCell::new(std::collections::BTreeMap::new());
    }

    /// # Safety: test stub — no real hardware access.
    #[cfg(test)]
    pub unsafe fn read32(addr: usize) -> u32 {
        REGS.with(|r| *r.borrow().get(&addr).unwrap_or(&0))
    }

    /// # Safety: test stub — no real hardware access.
    #[cfg(test)]
    pub unsafe fn write32(addr: usize, val: u32) {
        REGS.with(|r| {
            r.borrow_mut().insert(addr, val);
        });
    }

    /// Test helpers: reset the recorded register file, seed a register, or read
    /// back what a driver wrote.
    #[cfg(test)]
    pub fn test_reset() {
        REGS.with(|r| r.borrow_mut().clear());
    }
    #[cfg(test)]
    pub fn test_seed(addr: usize, val: u32) {
        REGS.with(|r| {
            r.borrow_mut().insert(addr, val);
        });
    }
    #[cfg(test)]
    pub fn test_get(addr: usize) -> Option<u32> {
        REGS.with(|r| r.borrow().get(&addr).copied())
    }
}

/// Register banks in the ESP32-C6 MODEM block. Every WiFi PHY/MAC register lives
/// in the `0x600A_xxxx` range.
pub mod banks {
    // PHY RF / analog / gain / power-detect / bias, plus the PBUS-adjacent regs.
    pub const PHY_RF: usize = 0x600A_0000;
    // PHY baseband.
    pub const PHY_BB: usize = 0x600A_7000;
    // WiFi MAC (RX descriptor ring, crypto, interrupts, TX power).
    pub const WIFI_MAC: usize = 0x600A_4000;
}

/// Named WiFi-MAC registers used by the RX/TX descriptor and interrupt paths.
pub mod mac {
    // MAC RX descriptor ring base pointer (W) and next-descriptor pointer (R).
    pub const RX_DSCR_BASE: usize = 0x600A_4084;
    pub const RX_DSCR_NEXT: usize = 0x600A_4088;
    pub const RX_DSCR_LAST: usize = 0x600A_408C;
    // MAC interrupt status (R) and clear (W1C).
    pub const INT_STATUS: usize = 0x600A_4C48;
    pub const INT_CLEAR: usize = 0x600A_4C4C;
    // Hardware crypto engine control words.
    pub const CRYPTO_CTRL0: usize = 0x600A_4800;
    pub const CRYPTO_CTRL1: usize = 0x600A_4804;

    // --- TX path ------------------------------------------------------------
    // The lower-MAC drives TX through per-queue register blocks whose address
    // strides *downward* as the queue index rises. The bases and strides below
    // are the start of each block (queue 0); field bits are annotated inline.

    // Per-queue PLCP0 / config word, addressed as `0x600a4d6c - queue*0x10`.
    // bits[31:30] = queue enable (enable: |0xc000_0000; invalidate: &!0x4000_0000).
    pub const TXQ_PLCP0_BASE: usize = 0x600A_4D6C;
    // Per-queue PLCP control word (buffer pointer / PPDU), `0x600a4d64 - queue*0x10`.
    pub const TXQ_PLCP_CTRL_BASE: usize = 0x600A_4D64;
    pub const TXQ_STRIDE: usize = 0x10; // subtracted per queue index

    // TX completion clear: write `1<<queue` (or `1<<(queue+16)`) here.
    pub const TXQ_COMPLETE_CLR: usize = 0x600A_4CAC;
    // TX error-state register: `1<<queue`.
    pub const TXQ_ERR_STATE: usize = 0x600A_4CB4;

    // Per-queue completion/status block at `0x600a54e0 - queue*0x74`
    // (state/error bits read from offsets +0x0/+0x8/+0x14).
    pub const TXQ_STATUS_BASE: usize = 0x600A_54E0;
    pub const TXQ_STATUS_STRIDE: usize = 0x74; // subtracted per queue index

    // TX duration/rate config words and the global TXQ enable.
    pub const TX_CONF0: usize = 0x600A_40F8; // &0xffff | 0x0500_0000
    pub const TX_CONF1: usize = 0x600A_40FC; // &0xffff | 0x0500_0000
    pub const TXQ_ENABLE: usize = 0x600A_4110; // |0x11

    /// Address of per-queue register `base - queue*stride` (TX blocks stride down).
    #[inline(always)]
    pub const fn txq_reg(base: usize, queue: usize, stride: usize) -> usize {
        base - queue * stride
    }
}

/// Baseband/PHY register bus: force-mode control and banked readback.
pub mod pbus {
    use super::mmio;

    // Control reg (address field = bits [20:11], mask 0x1ff800) and data reg.
    pub const CTRL: usize = 0x600A_08C8;
    pub const DATA: usize = 0x600A_08CC;
    // Force-mode enable/latch registers.
    pub const FORCE_EN: usize = 0x600A_0904; // bit0 = force enable
    pub const FORCE_LATCH: usize = 0x600A_090C; // bit27 = force latch
    const FORCE_GATE: usize = 0x600A_981C; // bit1 gates the analog settle poke
    const SETTLE: usize = 0x600A_702C; // analog settle field (top byte 0x32)

    /// Enable or disable PBUS force-mode.
    ///
    /// `delay_us` provides the microsecond delays needed on the disable path
    /// while the analog blocks settle.
    pub fn force_mode(enable: bool, delay_us: impl Fn(u32)) {
        unsafe {
            if enable {
                // Clear the force latch (bit27), then assert force enable (bit0).
                mmio::write32(FORCE_LATCH, mmio::read32(FORCE_LATCH) & 0xf7ff_ffff);
                mmio::write32(FORCE_EN, mmio::read32(FORCE_EN) | 1);
                return;
            }
            // Deassert force enable (bit0), then set the force latch (bit27).
            mmio::write32(FORCE_EN, mmio::read32(FORCE_EN) & !1);
            mmio::write32(FORCE_LATCH, mmio::read32(FORCE_LATCH) | 0x0800_0000);
            if mmio::read32(FORCE_GATE) & 2 != 0 {
                delay_us(1);
                // Program the settle field (top byte = 0x32), let it settle,
                mmio::write32(SETTLE, mmio::read32(SETTLE) & 0x00ff_ffff | 0x3280_0000);
                delay_us(2);
                // then clear bit 23.
                mmio::write32(SETTLE, mmio::read32(SETTLE) & 0xff7f_ffff);
            }
        }
    }

    /// PBUS readback register address for a given `(bank, sel)`.
    pub const fn rd_addr(bank: u32, sel: u32) -> usize {
        match bank {
            1 => 0x600A_0914,
            2 => if sel == 1 { 0x600A_0918 } else { 0x600A_091C },
            3 => 0x600A_091C,
            4 => if sel != 1 { 0x600A_0924 } else { 0x600A_0920 },
            0 => 0x600A_0920,
            _ => 0x600A_0924,
        }
    }

    /// Field shift within the readback register for a given `(bank, sel)`.
    pub const fn rd_shift(bank: u32, sel: u32) -> u32 {
        match bank {
            0 => if sel == 1 { 0x12 } else { 9 },
            1 | 3 => if sel == 1 { 9 } else { 0 },
            5 => 9,
            2 | 4 => if sel == 1 { 0 } else { 0x12 },
            _ => 0,
        }
    }

    /// Read a PBUS field: `read(rd_addr) >> rd_shift` (caller masks to width).
    #[inline]
    pub fn read_field(bank: u32, sel: u32) -> u32 {
        unsafe { mmio::read32(rd_addr(bank, sel)) >> rd_shift(bank, sel) }
    }
}

/// Analog I²C master to the RF synthesizer / BBPLL / bias blocks.
///
/// Each I²C register block is reached through a per-block command register; a
/// read latches a command word and polls the busy bit until the data appears.
/// The write path is not yet implemented (see [`write`]).
pub mod i2c_rf {
    use super::mmio;

    // Per-block command register base: `0x600A_F800 + block*4`, plus the mask reg.
    pub const CMD_BASE: usize = 0x600A_F800;
    pub const MASK: usize = 0x600A_F81C;
    const READ: u32 = 0x0400_0000; // bit26: read trigger (self-clears)
    const BUSY: u32 = 0x0200_0000; // bit25: busy, poll until clear

    /// Read RF I²C register `reg` in `block` for `host_id`:
    /// command = `reg<<8 | host_id | READ`; data returns in bits [23:16].
    pub fn read(host_id: u8, mask: u32, block: u32, reg: u8) -> u8 {
        unsafe {
            mmio::write32(MASK, !mask);
            let cmd = CMD_BASE + (block as usize) * 4;
            mmio::write32(cmd, (reg as u32) << 8 | host_id as u32 | READ);
            while mmio::read32(cmd) & BUSY != 0 {}
            ((mmio::read32(cmd) >> 16) & 0xff) as u8
        }
    }

    /// RF I²C write. Not yet implemented: the write/data command-bit layout is
    /// still to be determined, so it is left as a stub rather than guessed.
    pub fn write(_host_id: u8, _block: u32, _reg: u8, _val: u8) {
        unimplemented!("RF-I2C write: command-bit layout not yet implemented")
    }
}
