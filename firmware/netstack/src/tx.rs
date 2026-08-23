//! Heapless lower-MAC TX — a fixed pool of transmit buffers over the per-queue
//! TXQ registers (see `regs::mac::TXQ_*`).
//!
//! The pool is `N` static [`MAX_FRAME`] slots: an enqueue on a full pool is
//! refused (bounded back-pressure) and every transmit reuses a fixed buffer —
//! no allocation, no growth.
//!
//! As on RX, the ring *logic* (slot ownership, back-pressure, completion) is
//! host-testable; the MMIO that arms a hardware queue is a thin, isolated layer.

use crate::regs::{mac, mmio};
use crate::rx::{Buf, Overflow, MAX_FRAME};

/// The C6 lower-MAC exposes several EDCA transmit queues; management/assoc
/// traffic and the four access categories map onto these. The per-queue
/// register math is `base - queue*stride`.
pub const HW_TXQ_COUNT: usize = 5;

/// One TX slot: a fixed frame buffer, the valid length, which hardware queue it
/// was handed to, and whether the hardware still owns it (mirrors the TXQ enable
/// bit the completion path clears).
struct TxSlot {
    buf: [u8; MAX_FRAME],
    len: usize,
    queue: usize,
    owned_by_hw: bool,
}

impl TxSlot {
    const fn new() -> Self {
        TxSlot { buf: [0u8; MAX_FRAME], len: 0, queue: 0, owned_by_hw: false }
    }
}

/// Fixed-capacity TX ring. `N` in-flight frames; total static RAM =
/// `N * MAX_FRAME`, a compile-time constant with no fragmentation.
pub struct TxRing<const N: usize> {
    slots: [TxSlot; N],
}

impl<const N: usize> TxRing<N> {
    pub fn new() -> Self {
        TxRing { slots: core::array::from_fn(|_| TxSlot::new()) }
    }

    // --- host-testable ring logic (no MMIO) ---------------------------------

    /// Copy `frame` into a free slot bound to hardware queue `ac` (an access
    /// category, `0..HW_TXQ_COUNT`). Returns the slot index, or
    /// `Err(Overflow)` if the pool is full — a TX flood is refused, never
    /// allocated. Frames longer than [`MAX_FRAME`] are also refused.
    pub fn enqueue(&mut self, frame: &[u8], ac: usize) -> Result<usize, Overflow> {
        if frame.len() > MAX_FRAME || ac >= HW_TXQ_COUNT {
            return Err(Overflow);
        }
        for i in 0..N {
            if !self.slots[i].owned_by_hw {
                self.slots[i].buf[..frame.len()].copy_from_slice(frame);
                self.slots[i].len = frame.len();
                self.slots[i].queue = ac;
                self.slots[i].owned_by_hw = true;
                return Ok(i);
            }
        }
        Err(Overflow) // pool full -> back-pressure
    }

    /// Mark slot `idx` transmitted (hardware raised completion); the slot returns
    /// to the free pool. Idempotent and bounds-checked.
    pub fn on_complete(&mut self, idx: usize) {
        if idx < N {
            self.slots[idx].owned_by_hw = false;
            self.slots[idx].len = 0;
        }
    }

    /// Number of slots currently owned by hardware (in flight).
    pub fn in_flight(&self) -> usize {
        self.slots.iter().filter(|s| s.owned_by_hw).count()
    }

    /// Copy the next queued frame into `out`, free its slot, and return its
    /// length (0 if the ring is empty or `out` is too small). The driver calls
    /// this to hand a built frame to the transmit path.
    pub fn pop_into(&mut self, out: &mut [u8]) -> usize {
        for i in 0..N {
            if self.slots[i].owned_by_hw {
                let len = self.slots[i].len;
                if len == 0 || len > out.len() {
                    self.on_complete(i);
                    return 0;
                }
                out[..len].copy_from_slice(&self.slots[i].buf[..len]);
                self.on_complete(i);
                return len;
            }
        }
        0
    }

    // --- MMIO glue (per-queue TXQ registers) --------------------------------

    /// Global TX bring-up: set the TX rate/duration config words and assert the
    /// global TXQ enable.
    ///
    /// # Safety: MMIO; the MAC must be initialized and clocked.
    pub unsafe fn init_tx() {
        // TX config words: keep the low 16 bits, set the rate/duration field.
        mmio::write32(mac::TX_CONF0, mmio::read32(mac::TX_CONF0) & 0xffff | 0x0500_0000);
        mmio::write32(mac::TX_CONF1, mmio::read32(mac::TX_CONF1) & 0xffff | 0x0500_0000);
        // Assert the global TXQ enable bits.
        mmio::write32(mac::TXQ_ENABLE, mmio::read32(mac::TXQ_ENABLE) | 0x11);
    }

    /// Arm hardware queue `queue` to transmit slot `idx`: publish the buffer
    /// pointer and the PLCP0 length/rate word, then set the enable bits.
    ///
    /// `plcp0` is the rate/length control word the caller composed for this
    /// frame; it is taken as an argument rather than derived from a rate table.
    ///
    /// # Safety: MMIO; `idx` slot must stay resident (it is `'static` here) for
    /// the hardware's use, and the MAC must be initialized.
    pub unsafe fn arm(&self, idx: usize, plcp0: u32) {
        if idx >= N {
            return;
        }
        let queue = self.slots[idx].queue;
        // Buffer pointer + length live in the per-queue PLCP control block; the
        // PLCP0 word carries rate/length and the enable bits.
        let ctrl = mac::txq_reg(mac::TXQ_PLCP_CTRL_BASE, queue, mac::TXQ_STRIDE);
        mmio::write32(ctrl, self.slots[idx].buf.as_ptr() as u32);
        let plcp = mac::txq_reg(mac::TXQ_PLCP0_BASE, queue, mac::TXQ_STRIDE);
        // Set the queue VALID bit (bit30). Per the vendor libpp RE (see esp32-reverse
        // docs/re/07): mac_tx_set_plcp0 writes the length/rate word with no top bits,
        // and hal_mac_set_txq_invalid clears bit30 to invalidate — so bit30 is the
        // valid/arm bit. (Bit31 has no attested TX-enable role.)
        mmio::write32(plcp, plcp0 | 0x4000_0000);
    }

    /// Poll each hardware queue for completion and, if done, clear the state and
    /// free the slot (read the per-queue status block, then write `1<<queue` to
    /// the completion-clear register). Returns `true` if a completion was
    /// serviced.
    ///
    /// # Safety: MMIO; MAC must be initialized.
    pub unsafe fn service_completions(&mut self) -> bool {
        let mut serviced = false;
        for queue in 0..HW_TXQ_COUNT {
            let status = mac::txq_reg(mac::TXQ_STATUS_BASE, queue, mac::TXQ_STATUS_STRIDE);
            // Bit[20] (0x100000) is the "transmitted" flag in the status word.
            if mmio::read32(status) & 0x0010_0000 != 0 {
                // Clear the completion for this queue: write `1<<queue`.
                mmio::write32(mac::TXQ_COMPLETE_CLR, 1 << queue);
                for i in 0..N {
                    if self.slots[i].owned_by_hw && self.slots[i].queue == queue {
                        self.on_complete(i);
                    }
                }
                serviced = true;
            }
        }
        serviced
    }
}

impl<const N: usize> Default for TxRing<N> {
    fn default() -> Self {
        Self::new()
    }
}

/// Compose the transmit frame for a management PDU into a bounded buffer: the
/// MLME builders already emit into a `Buf`; this just re-exports the pattern so
/// a caller can hand the bytes to [`TxRing::enqueue`] with zero allocation.
pub fn frame_bytes<const M: usize>(pdu: &Buf<M>) -> &[u8] {
    pdu.as_slice()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enqueue_is_bounded_backpressure() {
        let mut ring: TxRing<2> = TxRing::new();
        assert_eq!(ring.enqueue(&[0xaa; 64], 0).unwrap(), 0);
        assert_eq!(ring.enqueue(&[0xbb; 64], 1).unwrap(), 1);
        // pool full (N=2): a third enqueue is refused, not allocated.
        assert!(ring.enqueue(&[0xcc; 64], 2).is_err());
        assert_eq!(ring.in_flight(), 2);
        // hardware completes slot 0 -> it returns to the pool and a new frame fits.
        ring.on_complete(0);
        assert_eq!(ring.in_flight(), 1);
        assert!(ring.enqueue(&[0xdd; 64], 0).is_ok());
    }

    #[test]
    fn enqueue_refuses_oversize_and_bad_queue() {
        let mut ring: TxRing<1> = TxRing::new();
        assert!(ring.enqueue(&[0u8; MAX_FRAME + 1], 0).is_err()); // too long
        assert!(ring.enqueue(&[0u8; 32], HW_TXQ_COUNT).is_err()); // bad AC
        assert_eq!(ring.in_flight(), 0);
    }

    #[test]
    fn completion_frees_only_matching_queue() {
        let mut ring: TxRing<3> = TxRing::new();
        ring.enqueue(&[1; 10], 0).unwrap();
        ring.enqueue(&[2; 10], 1).unwrap();
        ring.enqueue(&[3; 10], 0).unwrap();
        assert_eq!(ring.in_flight(), 3);
        // simulate: hardware queue 0 completed both its frames.
        for i in 0..3 {
            if ring.slots[i].owned_by_hw && ring.slots[i].queue == 0 {
                ring.on_complete(i);
            }
        }
        assert_eq!(ring.in_flight(), 1); // only the queue-1 frame remains
    }

    #[test]
    fn init_tx_sets_conf_and_enable_registers() {
        use crate::regs::mmio;
        mmio::test_reset();
        unsafe { TxRing::<2>::init_tx() };
        // TX rate/duration config: low 16 bits kept, rate field set.
        assert_eq!(mmio::test_get(mac::TX_CONF0).unwrap(), 0x0500_0000);
        assert_eq!(mmio::test_get(mac::TX_CONF1).unwrap(), 0x0500_0000);
        // Global TXQ enable bits asserted.
        assert_eq!(mmio::test_get(mac::TXQ_ENABLE).unwrap() & 0x11, 0x11);
    }

    #[test]
    fn per_queue_register_addresses_stride_down() {
        // TX per-queue blocks stride *down* by the stride as the queue index
        // rises.
        assert_eq!(mac::txq_reg(mac::TXQ_PLCP0_BASE, 0, mac::TXQ_STRIDE), 0x600A_4D6C);
        assert_eq!(mac::txq_reg(mac::TXQ_PLCP0_BASE, 1, mac::TXQ_STRIDE), 0x600A_4D5C);
        assert_eq!(mac::txq_reg(mac::TXQ_STATUS_BASE, 1, mac::TXQ_STATUS_STRIDE), 0x600A_546C);
    }
}
