//! Heapless lower-MAC — a fixed RX descriptor ring over the MAC register map
//! (`regs::mac`), using static memory rather than a per-frame allocator.
//!
//! The ring is `N` static [`MAX_FRAME`] slots: a full ring drops frames
//! (bounded back-pressure); it never allocates or corrupts. The hardware
//! pointer registers (`mac::RX_DSCR_BASE/NEXT/LAST`) and interrupt registers
//! (`mac::INT_STATUS/CLEAR`) drive the DMA descriptor ring.
//!
//! The ring *logic* (ownership, dispatch, back-pressure) is host-testable; the
//! MMIO glue is a thin, clearly-separated layer.

use core::ptr::addr_of;

use crate::ble::{AclPacket, L2capReassembler};
use crate::ieee80211::{reconstruct_mbssid, Beacon};
use crate::regs::{mac, mmio};
use crate::rx::{Buf, MAX_FRAME};

/// C6 MAC RX descriptor — the ESP `lldesc` 3-word DMA format (reconstructed in
/// esp32-reverse `docs/re/07-lower-mac-registers.md` from `wDev_AppendRxBlocks`):
/// `word0` packs `size[13:0] | length[27:14] | flags[31:28]` (bit31 = OWN),
/// `word1` is the DMA buffer pointer, `word2` is the next descriptor (a closed
/// ring). This 14/14 split is CONFIRMED on silicon (M0a `wifi_rx_probe`): the live
/// vendor ring reads `word0 = 0x822908a4`, which is exactly `size | (size<<14) |
/// OWN` for `size = 0x8a4` — the `<<14` proves the length field starts at bit 14,
/// not bit 12. The driver hands buffers to hardware via the OWN bit and reads back
/// the filled `length`.
#[repr(C)]
struct Lldesc {
    word0: u32,
    buf: u32,
    next: u32,
}

const DESC_OWN: u32 = 1 << 31; // word0 bit31: hand-off-to-HW flag (set on arm/recycle)
const DESC_EOF: u32 = 1 << 30; // word0 bit30: HW sets it on a delivered (end-of-)frame
const DESC_SIZE_MASK: u32 = 0x3fff; // size[13:0] — buffer capacity
const DESC_LEN_SHIFT: u32 = 14; // length[27:14] — bytes the DMA delivered

impl Lldesc {
    const fn zero() -> Self {
        Lldesc { word0: 0, buf: 0, next: 0 }
    }
    /// Length the DMA wrote into `word0[27:14]`.
    fn dma_len(&self) -> usize {
        ((self.word0 >> DESC_LEN_SHIFT) & DESC_SIZE_MASK) as usize
    }
}

/// One RX slot: a fixed frame buffer + how many bytes the DMA delivered, plus an
/// `owned_by_hw` flag mirroring the descriptor's OWN bit.
struct Slot {
    buf: [u8; MAX_FRAME],
    len: usize,
    owned_by_hw: bool,
}

impl Slot {
    const fn new() -> Self {
        Slot { buf: [0u8; MAX_FRAME], len: 0, owned_by_hw: true }
    }
}

/// Fixed-capacity RX descriptor ring. `N` = number of in-flight frames; total
/// static RAM = `N * (MAX_FRAME + sizeof(Lldesc))` (compile-time constant, no
/// fragmentation). `descs` is the hardware-visible lldesc ring; `slots` holds the
/// frame buffers each descriptor points at.
pub struct RxRing<const N: usize> {
    descs: [Lldesc; N],
    slots: [Slot; N],
    head: usize, // next slot the driver will consume
}

impl<const N: usize> RxRing<N> {
    pub const fn new() -> Self {
        RxRing {
            descs: [const { Lldesc::zero() }; N],
            slots: [const { Slot::new() }; N],
            head: 0,
        }
    }

    /// Build the lldesc ring: point each descriptor at its slot's buffer, chain
    /// `next` into a closed ring, and hand every descriptor to hardware (OWN set,
    /// `size` = buffer capacity). Grounded in the C6 RX descriptor format.
    ///
    /// # Safety: `self` must be at a stable (`'static`) address — the descriptors
    /// store raw pointers into `self`.
    pub unsafe fn link(&mut self) {
        for i in 0..N {
            let buf_ptr = addr_of!(self.slots[i].buf) as u32;
            let next_ptr = addr_of!(self.descs[(i + 1) % N]) as u32;
            self.descs[i].buf = buf_ptr;
            self.descs[i].next = next_ptr;
            self.descs[i].word0 = DESC_OWN | (MAX_FRAME as u32 & DESC_SIZE_MASK);
        }
    }

    /// Link the ring, program its base into the MAC, and clear any pending RX
    /// interrupt.
    ///
    /// # Safety: caller must ensure the MAC is initialized and the ring outlives
    /// the hardware's use of it (here it's `'static`).
    pub unsafe fn install(&mut self) {
        self.link();
        mmio::write32(mac::RX_DSCR_BASE, self.descs.as_ptr() as u32);
        mmio::write32(mac::INT_CLEAR, 0xffff_ffff);
    }

    /// Diagnostic: volatile-read descriptor `i`'s word0 (OWN bit + filled length).
    ///
    /// # Safety: reads descriptor memory the MAC may DMA into concurrently.
    pub unsafe fn peek_word0(&self, i: usize) -> u32 {
        if i < N {
            core::ptr::read_volatile(&self.descs[i].word0)
        } else {
            0
        }
    }

    /// Read and acknowledge the MAC RX interrupt status.
    ///
    /// # Safety: MMIO; MAC must be initialized.
    pub unsafe fn take_irq(&self) -> u32 {
        let s = mmio::read32(mac::INT_STATUS);
        if s != 0 {
            mmio::write32(mac::INT_CLEAR, s);
        }
        s
    }

    /// Poll the descriptor ring for frames the hardware has completed. Confirmed on
    /// silicon (M0b `wifi_rx_driver`): unlike a classic lldesc DMA, the C6 MAC does
    /// NOT clear the OWN bit on completion — it leaves bit31 set, sets bit30 (EOF),
    /// and writes the delivered length into `word0[27:14]` (the vendor ISR then
    /// consumes via the NEXT/LAST pointers and re-arms with `|= 0x80000000`). So a
    /// descriptor still marked HW-owned by us whose EOF bit is now set was just
    /// filled — mark it ready with its DMA length. Returns the number reaped.
    ///
    /// # Safety: reads descriptor memory the MAC DMAs into concurrently (volatile).
    pub unsafe fn reap(&mut self) -> usize {
        let mut n = 0;
        for i in 0..N {
            if !self.slots[i].owned_by_hw {
                continue;
            }
            let word0 = core::ptr::read_volatile(&self.descs[i].word0);
            if word0 & DESC_EOF != 0 {
                let len = ((word0 >> DESC_LEN_SHIFT) & DESC_SIZE_MASK) as usize;
                self.slots[i].len = len.min(MAX_FRAME);
                self.slots[i].owned_by_hw = false;
                n += 1;
            }
        }
        n
    }

    // --- host-testable ring logic (no MMIO) ---------------------------------

    /// Called (from the ISR/poll) when the DMA has filled slot `idx` with `len`
    /// bytes. Bounded: `len` is clamped to the slot; the frame is marked ready.
    pub fn on_dma_complete(&mut self, idx: usize, len: usize) {
        if idx >= N {
            return;
        }
        self.slots[idx].len = len.min(MAX_FRAME);
        self.slots[idx].owned_by_hw = false;
        self.descs[idx].word0 &= !DESC_OWN; // driver owns it until recycled
    }

    /// Take the next ready frame (driver-owned), or `None`. The caller must
    /// [`recycle`](Self::recycle) the slot when done to return it to the ring.
    pub fn next_frame(&mut self) -> Option<(usize, &[u8])> {
        for _ in 0..N {
            let i = self.head;
            self.head = (self.head + 1) % N;
            if !self.slots[i].owned_by_hw {
                let len = self.slots[i].len;
                return Some((i, &self.slots[i].buf[..len]));
            }
        }
        None
    }

    /// Return a consumed slot to the hardware (re-arm the descriptor).
    pub fn recycle(&mut self, idx: usize) {
        if idx < N {
            self.slots[idx].len = 0;
            self.slots[idx].owned_by_hw = true;
            // Re-arm the descriptor: OWN set, length cleared, size restored.
            self.descs[idx].word0 = DESC_OWN | (MAX_FRAME as u32 & DESC_SIZE_MASK);
        }
    }

    /// Test/inject helper: copy a frame into a free HW-owned slot as if the DMA
    /// delivered it. Returns the slot idx, or `None` if the ring is full
    /// (bounded back-pressure — a flood drops frames, it never allocates).
    pub fn inject(&mut self, frame: &[u8]) -> Option<usize> {
        for i in 0..N {
            if self.slots[i].owned_by_hw && self.slots[i].len == 0 {
                let n = frame.len().min(MAX_FRAME);
                self.slots[i].buf[..n].copy_from_slice(&frame[..n]);
                self.on_dma_complete(i, n);
                return Some(i);
            }
        }
        None
    }
}

impl<const N: usize> Default for RxRing<N> {
    fn default() -> Self {
        Self::new()
    }
}

/// Bytes of hardware RX-vector header the C6 MAC prepends to each received frame
/// buffer before the 802.11 MAC frame. Measured on silicon (M0b `wifi_rx_driver`):
/// beacons parse cleanly starting at offset 92 of the reaped buffer (`beacon_off`
/// was a stable 92 across samples; the vendor `wDev_IndicateFrame` copies the frame
/// from `buf + variable_offset`). Strip this before handing a reaped buffer to the
/// 802.11 parsers.
pub const RX_VECTOR_HDR: usize = 92;

/// The 802.11 MAC frame inside a reaped RX buffer (skips [`RX_VECTOR_HDR`]).
/// Returns an empty slice if the buffer is shorter than the header.
pub fn rx_frame(buf: &[u8]) -> &[u8] {
    buf.get(RX_VECTOR_HDR..).unwrap_or(&[])
}

/// Minimal 802.11 frame-control classification for dispatch.
fn is_beacon(frame: &[u8]) -> bool {
    // FC byte 0: type(2 bits)=mgmt(0), subtype(4 bits)=beacon(8) -> 0x80.
    !frame.is_empty() && frame[0] == 0x80
}

/// Dispatch a received 802.11 frame into the bounded parsers. Beacons carrying
/// an MBSSID element run [`reconstruct_mbssid`]; everything is bounded, so a
/// malformed frame yields `Err`/drop rather than an out-of-bounds write.
pub fn dispatch_wifi<const M: usize>(frame: &[u8], reconstructed: &mut Buf<M>) -> bool {
    if !is_beacon(frame) || frame.len() < 24 {
        return false;
    }
    let body = &frame[24..]; // after the 24-byte MAC header
    let Some(beacon) = Beacon::parse(body) else {
        return false;
    };
    // If it has an MBSSID element, reconstruct (bounded); else just accept.
    reconstruct_mbssid(beacon.ies, reconstructed).is_ok()
}

/// Dispatch a received BLE HCI-ACL packet through the bounded L2CAP reassembler.
pub fn dispatch_ble<'a>(
    reasm: &'a mut L2capReassembler,
    acl_bytes: &[u8],
) -> Option<&'a [u8]> {
    let pkt = AclPacket::parse(acl_bytes)?;
    reasm.push(&pkt).ok().flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reap_detects_hw_completion_and_extracts_length() {
        let mut ring: RxRing<3> = RxRing::new();
        unsafe { ring.link() }; // all descriptors armed (OWN=1, EOF=0)
        // Simulate the MAC filling slot 1: set EOF (bit30) + write length 250 into
        // [27:14], leaving OWN set — the C6 completion signal (M0b-measured).
        ring.descs[1].word0 = (ring.descs[1].word0 & !(DESC_SIZE_MASK << DESC_LEN_SHIFT))
            | DESC_EOF
            | (250 << DESC_LEN_SHIFT);
        assert_eq!(unsafe { ring.reap() }, 1); // one frame reaped
        assert_eq!(unsafe { ring.reap() }, 0); // idempotent — not re-reaped
        let (idx, f) = ring.next_frame().unwrap();
        assert_eq!(idx, 1);
        assert_eq!(f.len(), 250);
    }

    #[test]
    fn install_programs_descriptor_base_and_clears_irq() {
        use crate::regs::mmio;
        mmio::test_reset();
        let mut ring: RxRing<3> = RxRing::new();
        unsafe { ring.install() };
        // The descriptor ring base register holds our lldesc array pointer...
        assert_eq!(mmio::test_get(mac::RX_DSCR_BASE).unwrap(), ring.descs.as_ptr() as u32);
        // ...and pending RX interrupts were cleared.
        assert_eq!(mmio::test_get(mac::INT_CLEAR).unwrap(), 0xffff_ffff);
    }

    #[test]
    fn lldesc_ring_matches_hw_format() {
        // The linked ring must match the C6 RX descriptor format: each descriptor
        // owned by HW, size = MAX_FRAME, buf pointing at its slot, next forming a
        // closed ring. (Ring is stack-local here => stable address for the test.)
        let mut ring: RxRing<3> = RxRing::new();
        unsafe { ring.link() };
        for i in 0..3 {
            assert_eq!(ring.descs[i].word0 & DESC_SIZE_MASK, MAX_FRAME as u32);
            assert_eq!(ring.descs[i].word0 & DESC_OWN, DESC_OWN);
            assert_eq!(ring.descs[i].buf, addr_of!(ring.slots[i].buf) as u32);
            let expect_next = addr_of!(ring.descs[(i + 1) % 3]) as u32;
            assert_eq!(ring.descs[i].next, expect_next);
        }
        // HW fills length[27:14]; the driver reads it back.
        ring.descs[1].word0 =
            (ring.descs[1].word0 & !(DESC_SIZE_MASK << DESC_LEN_SHIFT)) | (200 << DESC_LEN_SHIFT);
        assert_eq!(ring.descs[1].dma_len(), 200);
        // Completion clears OWN; recycle re-arms it.
        ring.on_dma_complete(0, 100);
        assert_eq!(ring.descs[0].word0 & DESC_OWN, 0);
        ring.recycle(0);
        assert_eq!(ring.descs[0].word0 & DESC_OWN, DESC_OWN);
    }

    #[test]
    fn ring_backpressure_never_overflows() {
        let mut ring: RxRing<2> = RxRing::new();
        assert!(ring.inject(&[0x80; 100]).is_some());
        assert!(ring.inject(&[0x80; 100]).is_some());
        assert!(ring.inject(&[0x80; 100]).is_none()); // full -> dropped, not alloc
        // consume one, recycle, then a new frame fits.
        let (idx, f) = ring.next_frame().unwrap();
        assert_eq!(f.len(), 100);
        ring.recycle(idx);
        assert!(ring.inject(&[0x80; 100]).is_some());
    }

    #[test]
    fn ring_clamps_oversize_dma() {
        let mut ring: RxRing<1> = RxRing::new();
        ring.inject(&[0u8; 100]);
        ring.on_dma_complete(0, MAX_FRAME + 500); // lying DMA length
        let (_i, f) = ring.next_frame().unwrap();
        assert!(f.len() <= MAX_FRAME); // clamped, never reads past the slot
    }

    #[test]
    fn dispatch_wifi_reconstructs_bounded() {
        // A beacon with a huge IE set -> reconstruction into a small buffer must
        // fail cleanly (returns false), never writing out of bounds.
        let mut frame: Buf<MAX_FRAME> = Buf::new();
        frame.extend(&[0x80]).unwrap(); // FC: beacon
        frame.extend(&[0u8; 23]).unwrap(); // rest of MAC header
        frame.extend(&[0u8; 12]).unwrap(); // fixed params
        while frame.remaining() > 260 {
            frame.push_ie(0xdd, &[0x5a; 253]).unwrap();
        }
        let mut small: Buf<512> = Buf::new();
        assert!(!dispatch_wifi(frame.as_slice(), &mut small)); // bounded fail
    }
}
