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

use crate::ble::{AclPacket, L2capReassembler};
use crate::ieee80211::{reconstruct_mbssid, Beacon};
use crate::regs::{mac, mmio};
use crate::rx::{Buf, MAX_FRAME};

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
/// static RAM = `N * MAX_FRAME` (compile-time constant, no fragmentation).
pub struct RxRing<const N: usize> {
    slots: [Slot; N],
    head: usize, // next slot the driver will consume
}

impl<const N: usize> RxRing<N> {
    pub fn new() -> Self {
        RxRing { slots: core::array::from_fn(|_| Slot::new()), head: 0 }
    }

    /// Program the ring base into the MAC and clear any pending RX interrupt.
    ///
    /// # Safety: caller must ensure the MAC is initialized and the ring outlives
    /// the hardware's use of it (here it's `'static`).
    pub unsafe fn install(&self) {
        mmio::write32(mac::RX_DSCR_BASE, self.slots.as_ptr() as u32);
        mmio::write32(mac::INT_CLEAR, 0xffff_ffff);
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

    // --- host-testable ring logic (no MMIO) ---------------------------------

    /// Called (from the ISR/poll) when the DMA has filled slot `idx` with `len`
    /// bytes. Bounded: `len` is clamped to the slot; the frame is marked ready.
    pub fn on_dma_complete(&mut self, idx: usize, len: usize) {
        if idx >= N {
            return;
        }
        self.slots[idx].len = len.min(MAX_FRAME);
        self.slots[idx].owned_by_hw = false;
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
