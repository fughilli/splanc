//! Heapless lower-MAC TX — a fixed pool of transmit buffers over the per-queue
//! TXQ registers (see `regs::mac::TXQ_*`).
//!
//! The pool is `N` static [`MAX_FRAME`] slots: an enqueue on a full pool is
//! refused (bounded back-pressure) and every transmit reuses a fixed buffer —
//! no allocation, no growth.
//!
//! As on RX, the ring *logic* (slot ownership, back-pressure, completion) is
//! host-testable; the MMIO that arms a hardware queue is a thin, isolated layer.
//!
//! ## TX submission mechanism (measured on silicon, M1a `wifi_tx_probe`)
//!
//! Unlike RX, there is NO per-queue buffer-pointer register. Each TX frame is
//! submitted through a 3-word **lldesc descriptor** (same format as the RX ring:
//! `word0 = size[13:0] | length[27:14] | flags[31:28]`, `word1` = frame buffer,
//! `word2` = next/0). The frame buffer holds the raw 802.11 frame from offset 0
//! (no TX vector header, unlike RX's 92-byte prefix). The descriptor's ADDRESS is
//! encoded into PLCP0:
//!
//! ```text
//! PLCP0(0x600A_4D6C - q*0x10) = (desc_addr - 0x4080_0000) | 0x0060_0000 | 0xC000_0000
//!                                \____ offset into HP-SRAM ____/  \marker/  \enable+valid/
//! ```
//!
//! Rate/format live in the 0x54xx-q*0x74 block: PLCP1 (`0x5488`), signal
//! (`0x54ac`), len (`0x54b8`). Arm = the 0xC000_0000 bits (bit31 enable + bit30
//! valid, from `hal_mac_txq_enable`); `hal_mac_set_txq_invalid` clears bit30.
//!
//! The frame buffer the descriptor points at is `[8-byte TX header][802.11
//! frame]` — an 8-byte hardware TX prefix precedes the MAC frame (byte 0 mirrors
//! the PLCP1 rate/format nibble; the 802.11 frame starts at offset 8).
//!
//! VALIDATED on silicon (M1b `wifi_tx_driver`): arming our own descriptor via
//! this mechanism transmitted a valid probe request over the air — real APs
//! answered with probe responses addressed to our unique source MAC. The
//! length-dependent PHY SIGNAL/rate encoding for ARBITRARY frames is the
//! remaining piece (M1b); the proof reused a captured rate-register set.

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
    len: usize,           // total buffer length (TX header + 802.11 frame)
    frame_len_802: usize, // 802.11 frame length (the PHY SIGNAL length)
    queue: usize,
    owned_by_hw: bool,
}

impl TxSlot {
    const fn new() -> Self {
        TxSlot { buf: [0u8; MAX_FRAME], len: 0, frame_len_802: 0, queue: 0, owned_by_hw: false }
    }
}

/// Bytes of hardware TX header prepended before the 802.11 frame (M1b-measured on
/// silicon): byte0 holds the 802.11 frame length (the PHY SIGNAL length); the
/// frame proper starts at offset 8.
pub const TX_HDR_LEN: usize = 8;

/// A TX lldesc descriptor (same 3-word format as the RX ring): `word0` packs
/// `size[13:0] | length[27:14] | flags[31:28]` (bit31 OWN, bit30 EOF), `word1` is
/// the frame buffer pointer, `word2` the next descriptor (0 = single-frame).
#[repr(C)]
struct TxDesc {
    word0: u32,
    buf: u32,
    next: u32,
}

impl TxDesc {
    const fn zero() -> Self {
        TxDesc { word0: 0, buf: 0, next: 0 }
    }
}

const TX_OWN: u32 = 1 << 31; // hand-off to hardware
const TX_EOF: u32 = 1 << 30; // end-of-frame (single-descriptor frame)
const TX_LEN_SHIFT: u32 = 14; // length[27:14]
const TX_SIZE_MASK: u32 = 0x3fff; // size[13:0]

/// HP-SRAM base the TX-descriptor offset in PLCP0 is relative to (M1a-measured).
const SRAM_BASE: u32 = 0x4080_0000;
/// PLCP0 fixed marker bits set alongside the descriptor offset.
const PLCP0_MARKER: u32 = 0x0060_0000;
/// PLCP0 arm bits: bit31 enable + bit30 valid (`hal_mac_txq_enable |= 0xC000_0000`).
const PLCP0_ARM: u32 = 0xC000_0000;

/// Encode a TX descriptor's CPU address into the PLCP0 register value that arms
/// its queue (M1a): `(desc_addr - 0x4080_0000) | marker | arm-bits`. Split out so
/// the bit-twiddling is host-testable without MMIO.
pub fn plcp0_for_desc(desc_addr: u32) -> u32 {
    ((desc_addr.wrapping_sub(SRAM_BASE)) & 0x7_ffff) | PLCP0_MARKER | PLCP0_ARM
}

/// Fixed-capacity TX ring. `N` in-flight frames; total static RAM =
/// `N * MAX_FRAME` + the descriptor array, a compile-time constant.
pub struct TxRing<const N: usize> {
    slots: [TxSlot; N],
    descs: [TxDesc; N],
}

impl<const N: usize> TxRing<N> {
    pub const fn new() -> Self {
        TxRing {
            slots: [const { TxSlot::new() }; N],
            descs: [const { TxDesc::zero() }; N],
        }
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
                self.slots[i].frame_len_802 = frame.len();
                self.slots[i].queue = ac;
                self.slots[i].owned_by_hw = true;
                return Ok(i);
            }
        }
        Err(Overflow) // pool full -> back-pressure
    }

    /// Load an 802.11 `frame` for transmit on access category `ac`, building the
    /// slot buffer as `[8-byte TX header | frame]` with the 802.11 length in the
    /// header (byte 0, and its high nibble in byte 1) — the layout the hardware
    /// expects (M1b). Records the 802.11 length for [`set_rate`]. Returns the slot
    /// index, or `Err(Overflow)` if the pool is full or the frame is too long.
    ///
    /// This is the real transmit entry point (vs. [`enqueue`], which stores a raw
    /// buffer for the ring-logic tests). Call [`set_rate`] then [`arm`] next.
    pub fn load_frame(&mut self, frame: &[u8], ac: usize) -> Result<usize, Overflow> {
        if frame.len() + TX_HDR_LEN > MAX_FRAME || ac >= HW_TXQ_COUNT {
            return Err(Overflow);
        }
        for i in 0..N {
            if !self.slots[i].owned_by_hw {
                let s = &mut self.slots[i];
                s.buf[..TX_HDR_LEN].fill(0);
                s.buf[0] = (frame.len() & 0xff) as u8;
                s.buf[1] = ((frame.len() >> 8) & 0x0f) as u8;
                s.buf[TX_HDR_LEN..TX_HDR_LEN + frame.len()].copy_from_slice(frame);
                s.len = TX_HDR_LEN + frame.len();
                s.frame_len_802 = frame.len();
                s.queue = ac;
                s.owned_by_hw = true;
                return Ok(i);
            }
        }
        Err(Overflow)
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

    /// Arm hardware queue `queue` to transmit slot `idx` using the measured C6
    /// submission mechanism (M1a `wifi_tx_probe`): build the slot's TX lldesc
    /// descriptor (OWN+EOF, length = frame length, buf = frame), then write PLCP0
    /// with the descriptor's address encoded in + the arm bits. The frame buffer
    /// holds the raw 802.11 frame from offset 0 (no TX vector header).
    ///
    /// The caller MUST have programmed the per-queue rate/format registers via
    /// [`set_rate`] for `queue` BEFORE calling `arm`, since the PLCP0 write with
    /// `0xC000_0000` arms the DMA immediately.
    ///
    /// # Safety: MMIO; `self` must be `'static` (the descriptor stores a raw
    /// pointer into `self` and the hardware DMAs the frame buffer), and the MAC +
    /// PHY must be initialized.
    pub unsafe fn arm(&mut self, idx: usize) {
        if idx >= N {
            return;
        }
        let queue = self.slots[idx].queue;
        let len = (self.slots[idx].len as u32) & TX_SIZE_MASK;
        // Build the TX descriptor: hand it to hardware (OWN), mark it the last
        // descriptor of the frame (EOF), set size+length to the frame length, and
        // point it at the frame buffer.
        self.descs[idx].buf = self.slots[idx].buf.as_ptr() as u32;
        self.descs[idx].next = 0;
        self.descs[idx].word0 = TX_OWN | TX_EOF | (len << TX_LEN_SHIFT) | len;
        // Encode the descriptor's address into PLCP0 and arm the queue.
        let desc_addr = core::ptr::addr_of!(self.descs[idx]) as u32;
        let plcp = mac::txq_reg(mac::TXQ_PLCP0_BASE, queue, mac::TXQ_STRIDE);
        mmio::write32(plcp, plcp0_for_desc(desc_addr));
    }

    /// Program slot `idx`'s per-queue rate/format registers for a legacy transmit,
    /// using the values measured + validated on silicon (M1b `wifi_tx_driver`
    /// transmitted a from-scratch probe request that real APs answered). The 802.11
    /// frame length goes into PLCP1's low 12 bits (`0x5488`, the PHY SIGNAL length);
    /// the remaining words are the length-independent legacy-OFDM rate template.
    /// Must be called before [`arm`] for the same queue.
    ///
    /// # Safety: MMIO; the MAC + PHY must be initialized.
    pub unsafe fn set_rate(&self, idx: usize) {
        if idx >= N {
            return;
        }
        let queue = self.slots[idx].queue;
        // PLCP1 (the PHY SIGNAL length) is the 802.11 frame length PLUS the 4-byte
        // FCS the hardware appends. Measured on silicon (wifi_auth_replay): setting
        // just `frame_len` makes the SIGNAL 4 bytes short, so the receiver's FCS
        // check fails and the frame is silently dropped — APs still answer probe
        // requests (lenient discovery) but auth/assoc are dropped, which is exactly
        // why our earlier auth got no response. `+ 4` makes the AP answer our auth.
        let flen = (self.slots[idx].frame_len_802 as u32 + 4) & 0xfff;
        // Sequence/duration control word in the 0x4d block (stride 0x10, alongside
        // PLCP0). Captured with an incrementing counter + 0x077; a fixed value
        // suffices for the first frame of an exchange.
        mmio::write32(mac::txq_reg(0x600A_4D68, queue, mac::TXQ_STRIDE), 0x1200_0077);
        let s = mac::TXQ_STATUS_STRIDE;
        mmio::write32(mac::txq_reg(0x600A_5488, queue, s), flen); // PLCP1 = 802.11 length
        mmio::write32(mac::txq_reg(0x600A_548C, queue, s), 0x0002_0000);
        mmio::write32(mac::txq_reg(0x600A_5490, queue, s), 0x0011_1110);
        mmio::write32(mac::txq_reg(0x600A_54AC, queue, s), 0x1414_0014); // rate/format
        mmio::write32(mac::txq_reg(0x600A_54B0, queue, s), 0x0000_4081);
        mmio::write32(mac::txq_reg(0x600A_54B4, queue, s), 0x0040_0000);
        mmio::write32(mac::txq_reg(0x600A_54B8, queue, s), 0x0040_0000);
        mmio::write32(mac::txq_reg(0x600A_54BC, queue, s), 0x0040_0004);
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
    fn load_frame_prepends_tx_header_with_length() {
        let mut ring: TxRing<2> = TxRing::new();
        let frame = [0x40u8, 0x00, 0x00, 0x00]; // a 4-byte "802.11 frame"
        let idx = ring.load_frame(&frame, 0).unwrap();
        // Buffer = 8-byte header + frame; header byte0 = 802.11 length.
        assert_eq!(ring.slots[idx].len, TX_HDR_LEN + 4);
        assert_eq!(ring.slots[idx].frame_len_802, 4);
        assert_eq!(ring.slots[idx].buf[0], 4); // length in header byte0
        assert_eq!(&ring.slots[idx].buf[TX_HDR_LEN..TX_HDR_LEN + 4], &frame);
        // A frame that would overflow the slot with the header is refused.
        assert!(ring.load_frame(&[0u8; MAX_FRAME], 0).is_err());
    }

    #[test]
    fn plcp0_encodes_descriptor_address_like_silicon() {
        // M1a: the vendor armed q0 with PLCP0=0xc06338cc for a descriptor at
        // 0x408338cc. Our encoder must reproduce that exactly.
        assert_eq!(plcp0_for_desc(0x4083_38cc), 0xc063_38cc);
        // Marker + arm bits always present; low 19 bits are the SRAM offset.
        let p = plcp0_for_desc(0x4080_0000);
        assert_eq!(p & 0xC000_0000, 0xC000_0000); // arm bits
        assert_eq!(p & 0x0060_0000, 0x0060_0000); // marker
        assert_eq!(p & 0x7_ffff, 0); // offset 0 for the base address
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
