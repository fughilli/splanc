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
    /// Length the DMA wrote into `word0[27:14]`. Test-only accessor (the RX path
    /// reads the field inline in [`RxRing::reap`]).
    #[cfg(test)]
    fn dma_len(&self) -> usize {
        ((self.word0 >> DESC_LEN_SHIFT) & DESC_SIZE_MASK) as usize
    }
}

/// One RX slot: a fixed frame buffer + how many bytes the DMA delivered, plus a
/// `ready` flag: the inverse of the descriptor's OWN bit (set = a delivered frame
/// the driver holds until [`RxRing::recycle`]; clear = handed to the hardware).
/// Kept inverted (rather than an `owned_by_hw` that starts `true`) so a fresh ring
/// is all-zero bytes: the ~27 KB `static mut RX` is then `.bss`, not `.data`
/// (which the image would also carry in flash).
struct Slot {
    buf: [u8; MAX_FRAME],
    len: usize,
    ready: bool,
}

impl Slot {
    const fn new() -> Self {
        Slot { buf: [0u8; MAX_FRAME], len: 0, ready: false }
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
    /// # Safety
    /// `self` must be at a stable (`'static`) address — the descriptors
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
    /// # Safety
    /// Caller must ensure the MAC is initialized and the ring outlives
    /// the hardware's use of it (here it's `'static`).
    pub unsafe fn install(&mut self) {
        self.link();
        mmio::write32(mac::RX_DSCR_BASE, self.descs.as_ptr() as u32);
        mmio::write32(mac::INT_CLEAR, 0xffff_ffff);
    }

    /// Diagnostic: volatile-read descriptor `i`'s word0 (OWN bit + filled length).
    ///
    /// # Safety
    /// Reads descriptor memory the MAC may DMA into concurrently.
    pub unsafe fn peek_word0(&self, i: usize) -> u32 {
        if i < N {
            core::ptr::read_volatile(&self.descs[i].word0)
        } else {
            0
        }
    }

    /// Read and acknowledge the MAC RX interrupt status.
    ///
    /// # Safety
    /// MMIO; MAC must be initialized.
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
    /// # Safety
    /// Reads descriptor memory the MAC DMAs into concurrently (volatile).
    pub unsafe fn reap(&mut self) -> usize {
        let mut n = 0;
        for i in 0..N {
            if self.slots[i].ready {
                continue;
            }
            let word0 = core::ptr::read_volatile(&self.descs[i].word0);
            if word0 & DESC_EOF != 0 {
                let len = ((word0 >> DESC_LEN_SHIFT) & DESC_SIZE_MASK) as usize;
                self.slots[i].len = len.min(MAX_FRAME);
                self.slots[i].ready = true;
                n += 1;
            }
        }
        n
    }

    /// Frames reaped but not yet consumed (driver-owned slots). Diagnostics: a value
    /// that reaches `N` means the ring filled between polls and the MAC had nowhere to
    /// put the next frame (it was dropped after the hardware already ACKed it).
    pub fn ready_count(&self) -> usize {
        self.slots.iter().filter(|s| s.ready).count()
    }

    // --- host-testable ring logic (no MMIO) ---------------------------------

    /// Called (from the ISR/poll) when the DMA has filled slot `idx` with `len`
    /// bytes. Bounded: `len` is clamped to the slot; the frame is marked ready.
    pub fn on_dma_complete(&mut self, idx: usize, len: usize) {
        if idx >= N {
            return;
        }
        self.slots[idx].len = len.min(MAX_FRAME);
        self.slots[idx].ready = true;
        self.descs[idx].word0 &= !DESC_OWN; // driver owns it until recycled
    }

    /// Take the next ready frame (driver-owned), or `None`. The caller must
    /// [`recycle`](Self::recycle) the slot when done to return it to the ring.
    pub fn next_frame(&mut self) -> Option<(usize, &[u8])> {
        for _ in 0..N {
            let i = self.head;
            self.head = (self.head + 1) % N;
            if self.slots[i].ready {
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
            self.slots[idx].ready = false;
            // Re-arm the descriptor: OWN set, length cleared, size restored.
            self.descs[idx].word0 = DESC_OWN | (MAX_FRAME as u32 & DESC_SIZE_MASK);
        }
    }

    /// Recycle the run of ready frames at the head of the ring for which `junk` holds,
    /// oldest first, exactly as [`next_frame`](Self::next_frame) + [`recycle`](Self::recycle)
    /// would consume them; stop at the first frame `junk` keeps or the first slot not yet
    /// filled. `junk` sees the whole reaped buffer (RX vector included). Returns how many
    /// were recycled. Never recycles out of order, so the MAC's walk of the ring sees the
    /// same sequence of freed descriptors as normal consumption.
    pub fn shed_head<F: FnMut(&[u8]) -> bool>(&mut self, mut junk: F) -> usize {
        let mut n = 0;
        for _ in 0..N {
            let i = self.head;
            if !self.slots[i].ready {
                break;
            }
            let len = self.slots[i].len;
            if !junk(&self.slots[i].buf[..len]) {
                break;
            }
            self.recycle(i);
            self.head = (i + 1) % N;
            n += 1;
        }
        n
    }

    /// The ready frame at the head of the ring (the next one [`shed_head`](Self::shed_head)
    /// would look at), if any. Whole reaped buffer, RX vector included.
    pub fn head_frame(&self) -> Option<&[u8]> {
        let i = self.head;
        if self.slots[i].ready {
            Some(&self.slots[i].buf[..self.slots[i].len])
        } else {
            None
        }
    }

    /// Recycle the head frame (if ready) and advance, as consuming it would. Returns
    /// whether a frame was dropped.
    pub fn drop_head(&mut self) -> bool {
        let i = self.head;
        if !self.slots[i].ready {
            return false;
        }
        self.recycle(i);
        self.head = (i + 1) % N;
        true
    }

    /// Test/inject helper: copy a frame into a free HW-owned slot as if the DMA
    /// delivered it. Returns the slot idx, or `None` if the ring is full
    /// (bounded back-pressure — a flood drops frames, it never allocates).
    pub fn inject(&mut self, frame: &[u8]) -> Option<usize> {
        for i in 0..N {
            if !self.slots[i].ready && self.slots[i].len == 0 {
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

/// A FIFO of whole frames in `CAP` bytes (each record: 2-byte little-endian length + the
/// bytes; a record never wraps — a length of 0xFFFF marks "skip to the start"). It holds the
/// frames the RX ring's head would otherwise pin while the consumer is stalled, so the ring
/// can keep draining in arrival order. No allocation; full means `push` refuses.
pub struct SideQueue<const CAP: usize> {
    buf: [u8; CAP],
    head: usize, // next record to pop
    tail: usize, // where the next record goes
    used: usize, // bytes in use, including skipped tails and length prefixes
    count: usize,
}

impl<const CAP: usize> SideQueue<CAP> {
    pub const fn new() -> Self {
        SideQueue { buf: [0; CAP], head: 0, tail: 0, used: 0, count: 0 }
    }

    pub fn len(&self) -> usize {
        self.count
    }

    pub fn is_empty(&self) -> bool {
        self.count == 0
    }

    /// Append `frame`; false (nothing changed) if it doesn't fit.
    pub fn push(&mut self, frame: &[u8]) -> bool {
        let need = 2 + frame.len();
        if frame.len() >= 0xFFFF || need > CAP {
            return false;
        }
        let mut tail = self.tail;
        let mut extra = 0;
        if tail + need > CAP {
            // Not enough room before the end: skip the rest of the buffer.
            extra = CAP - tail;
            tail = 0;
        }
        if self.used + extra + need > CAP {
            return false;
        }
        if extra > 0 {
            if extra >= 2 {
                self.buf[self.tail] = 0xFF;
                self.buf[self.tail + 1] = 0xFF;
            }
            self.used += extra;
        }
        self.buf[tail] = frame.len() as u8;
        self.buf[tail + 1] = (frame.len() >> 8) as u8;
        self.buf[tail + 2..tail + need].copy_from_slice(frame);
        self.tail = (tail + need) % CAP;
        self.used += need;
        self.count += 1;
        true
    }

    /// Hand the oldest frame to `f` and remove it. None if empty.
    pub fn pop<R>(&mut self, f: impl FnOnce(&[u8]) -> R) -> Option<R> {
        if self.count == 0 {
            return None;
        }
        // A skip marker (or a tail too short to hold a length) sends us to the start.
        if self.head + 2 > CAP || (self.buf[self.head] == 0xFF && self.buf[self.head + 1] == 0xFF) {
            self.used -= CAP - self.head;
            self.head = 0;
        }
        let len = self.buf[self.head] as usize | (self.buf[self.head + 1] as usize) << 8;
        let start = self.head + 2;
        let r = f(&self.buf[start..start + len]);
        self.head = (start + len) % CAP;
        self.used -= 2 + len;
        self.count -= 1;
        if self.count == 0 {
            self.head = 0;
            self.tail = 0;
            self.used = 0;
        }
        Some(r)
    }
}

impl<const CAP: usize> Default for SideQueue<CAP> {
    fn default() -> Self {
        Self::new()
    }
}

/// Whether a received 802.11 `frame` (RX vector stripped) is of no use to a station that is
/// associated to `bssid` as `own`, so its ring slot can be freed before the RX path gets to
/// it. The MAC runs in all-frames (promiscuous) mode, so the 16-slot ring also collects the
/// whole channel: every network's beacons, other stations' unicast, other networks' group
/// traffic. During a ~270 ms TLS handshake stall on the loop that is enough to fill it, and
/// the frames that then find no slot include our own TCP segments.
///
/// Junk: control and extension frames; truncated management/data headers; beacons and probe
/// responses (our AP's too unless `keep_ap_beacons`: only the mesh's time reference and the
/// scan sweeps use them, and a sweep turns shedding off); probe requests; management frames unicast to someone else;
/// data unicast to someone else; group data not relayed by our AP (FromDS from `bssid`).
/// Kept: everything addressed to `own`, our AP's group traffic,
/// other group management (e.g. a broadcast deauth), and every Action frame (the mesh's
/// Public Action frames, any source).
pub fn is_junk(frame: &[u8], own: &[u8; 6], bssid: &[u8; 6], keep_ap_beacons: bool) -> bool {
    if frame.len() < 2 {
        return true;
    }
    let fc0 = frame[0];
    let fc1 = frame[1];
    let ftype = (fc0 >> 2) & 3;
    let subtype = fc0 >> 4;
    if ftype == 1 || ftype == 3 {
        return true; // control / extension: the MAC handles ACKs itself
    }
    if frame.len() < 24 {
        return true; // a management/data frame with no full header
    }
    let a1 = &frame[4..10];
    let a2 = &frame[10..16];
    let a3 = &frame[16..22];
    let group = a1[0] & 1 != 0;
    if a1 == own {
        return false;
    }
    if ftype == 0 {
        return match subtype {
            13 | 14 => false,         // Action / Action No Ack (mesh)
            8 | 5 => !(keep_ap_beacons && a3 == bssid), // beacons / probe responses
            4 => true,                // probe request: we are not an AP
            _ => !group,              // other management: keep group, drop others' unicast
        };
    }
    // Data.
    if !group {
        return true; // unicast to another station
    }
    let from_ds = fc1 & 0x03 == 0x02;
    !(from_ds && a2 == bssid)
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

    const OWN: [u8; 6] = [0x98, 0x88, 0xe0, 0x71, 0x5f, 0xc8];
    const AP: [u8; 6] = [0x50, 0x91, 0xe3, 0x41, 0x1b, 0xda];
    const OTHER_AP: [u8; 6] = [0x50, 0x91, 0xe3, 0x41, 0x1b, 0xe2];
    const STA2: [u8; 6] = [0x9c, 0x76, 0x13, 0x00, 0x00, 0x01];
    const BCAST: [u8; 6] = [0xff; 6];
    const MCAST: [u8; 6] = [0x01, 0x00, 0x5e, 0x00, 0x00, 0xfb];

    fn hdr(fc0: u8, fc1: u8, a1: [u8; 6], a2: [u8; 6], a3: [u8; 6]) -> [u8; 40] {
        let mut f = [0u8; 40];
        f[0] = fc0;
        f[1] = fc1;
        f[4..10].copy_from_slice(&a1);
        f[10..16].copy_from_slice(&a2);
        f[16..22].copy_from_slice(&a3);
        f
    }

    #[test]
    fn junk_keeps_what_the_station_uses() {
        // Protected QoS data from our AP to us (FromDS).
        assert!(!is_junk(&hdr(0x88, 0x42, OWN, AP, STA2), &OWN, &AP, true));
        // Group data relayed by our AP: ARP, DHCP, mDNS.
        assert!(!is_junk(&hdr(0x08, 0x42, BCAST, AP, STA2), &OWN, &AP, true));
        assert!(!is_junk(&hdr(0x88, 0x62, MCAST, AP, STA2), &OWN, &AP, true));
        // Our AP's beacon, management to us (auth/assoc/deauth), broadcast deauth from it.
        assert!(!is_junk(&hdr(0x80, 0, BCAST, AP, AP), &OWN, &AP, true));
        assert!(is_junk(&hdr(0x80, 0, BCAST, AP, AP), &OWN, &AP, false)); // mesh off: shed
        assert!(!is_junk(&hdr(0xc0, 0, OWN, AP, AP), &OWN, &AP, true));
        assert!(!is_junk(&hdr(0xc0, 0, BCAST, AP, AP), &OWN, &AP, true));
        // Action frames from anyone (the mesh), group or unicast.
        assert!(!is_junk(&hdr(0xd0, 0, BCAST, STA2, BCAST), &OWN, &AP, true));
        assert!(!is_junk(&hdr(0xd0, 0, OWN, STA2, BCAST), &OWN, &AP, true));
    }

    #[test]
    fn junk_drops_the_rest_of_the_channel() {
        assert!(is_junk(&hdr(0x80, 0, BCAST, OTHER_AP, OTHER_AP), &OWN, &AP, true)); // other beacon
        assert!(is_junk(&hdr(0x50, 0, STA2, OTHER_AP, OTHER_AP), &OWN, &AP, true)); // probe resp
        assert!(is_junk(&hdr(0x40, 0, BCAST, STA2, BCAST), &OWN, &AP, true)); // probe request
        assert!(is_junk(&hdr(0x88, 0x42, STA2, AP, AP), &OWN, &AP, true)); // data to another STA
        assert!(is_junk(&hdr(0x88, 0x41, AP, STA2, BCAST), &OWN, &AP, true)); // another STA's uplink
        assert!(is_junk(&hdr(0x08, 0x42, BCAST, OTHER_AP, STA2), &OWN, &AP, true)); // other BSS group
        assert!(is_junk(&[0xd4, 0, 0, 0, 0xaa, 0, 0, 0, 0, 0], &OWN, &AP, true)); // a control ACK
        assert!(is_junk(&[0x88, 0x42, 0, 0], &OWN, &AP, true)); // truncated
    }

    #[test]
    fn side_queue_is_fifo_and_wraps() {
        let mut q: SideQueue<64> = SideQueue::new();
        assert!(q.push(&[1; 20]) && q.push(&[2; 20])); // 22 + 22 = 44 bytes used
        assert!(!q.push(&[3; 20])); // 44 + 22 > 64: refused, nothing changed
        assert_eq!(q.len(), 2);
        assert_eq!(q.pop(|f| (f.len(), f[0])), Some((20, 1)));
        // 22 bytes free at the front, 20 at the end: a 20-byte frame (22 with its length)
        // doesn't fit before the end, so it wraps behind a skip marker.
        assert!(q.push(&[3; 20]));
        assert_eq!(q.pop(|f| f[0]), Some(2));
        assert_eq!(q.pop(|f| (f.len(), f[0])), Some((20, 3)));
        assert_eq!(q.pop(|f| f[0]), None);
        assert!(q.is_empty());
        // Empty resets to the start: a frame filling the whole buffer fits.
        assert!(q.push(&[4; 62]));
        assert!(!q.push(&[5; 1]));
        assert_eq!(q.pop(|f| f.len()), Some(62));
    }

    #[test]
    fn side_queue_many_small_frames_keep_order() {
        let mut q: SideQueue<256> = SideQueue::new();
        let mut next_in = 0u8;
        let mut next_out = 0u8;
        for round in 0..200 {
            while q.push(&[next_in; 13]) {
                next_in = next_in.wrapping_add(1);
            }
            for _ in 0..(1 + round % 7) {
                if let Some(v) = q.pop(|f| f[0]) {
                    assert_eq!(v, next_out);
                    next_out = next_out.wrapping_add(1);
                }
            }
        }
    }

    #[test]
    fn shed_head_stops_at_the_first_kept_frame() {
        let mut ring: RxRing<4> = RxRing::new();
        unsafe { ring.link() };
        // Fill slots 0..3 in arrival order: junk, junk, keep, junk.
        for (i, keep) in [false, false, true, false].iter().enumerate() {
            ring.slots[i].buf[0] = if *keep { 1 } else { 0 };
            ring.descs[i].word0 = (ring.descs[i].word0 & !(DESC_SIZE_MASK << DESC_LEN_SHIFT))
                | DESC_EOF
                | (8 << DESC_LEN_SHIFT);
        }
        assert_eq!(unsafe { ring.reap() }, 4);
        assert_eq!(ring.shed_head(|b| b[0] == 0), 2); // the two leading junk frames only
        assert_eq!(ring.ready_count(), 2);
        let (idx, _) = ring.next_frame().unwrap();
        assert_eq!(idx, 2); // the kept frame is next, in order; the junk behind it waits
        ring.recycle(idx);
        assert_eq!(ring.shed_head(|b| b[0] == 0), 1);
        assert_eq!(ring.ready_count(), 0);
        // Recycled slots are re-armed for the MAC (OWN set, length cleared).
        for i in 0..4 {
            assert_eq!(ring.descs[i].word0, DESC_OWN | MAX_FRAME as u32);
        }
    }

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
