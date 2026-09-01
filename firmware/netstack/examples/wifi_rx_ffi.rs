//! Heapless MAC RX driver FFI (Milestone 0b). Drives OUR reverse-engineered RX
//! descriptor ring on real silicon: install a static [`RxRing`] into the WiFi-MAC
//! (`RX_DSCR_BASE`), arm RX (`RX_CTRL` bits 31+27, measured in M0a), then poll the
//! descriptor OWN bits for frames the hardware DMAs in. The C shim brings the PHY
//! up via the vendor blob + programs a channel, then hands the ring to us.
//!
//! This is the make-or-break proof: if real beacons land in OUR ring, the RE'd
//! MAC RX path (descriptor format, ring install, RX-enable) is correct on silicon.

#![no_std]
#![allow(static_mut_refs)]

use ledmapper_netstack::lmac;
use ledmapper_netstack::mac::{dispatch_wifi, RxRing};
use ledmapper_netstack::regs::mac as macregs;
use ledmapper_netstack::regs::mmio;
use ledmapper_netstack::rx::Buf;

// 8 in-flight frames of static RAM; must be at a stable ('static) address because
// the descriptors store raw pointers into it and hardware DMAs against it.
static mut RING: RxRing<8> = RxRing::new();

/// Install our ring into the MAC and arm RX. The vendor (via the C shim) has
/// already brought up the PHY/clock/channel and put the MAC in a receive filter;
/// we take over the descriptor ring only.
#[no_mangle]
pub extern "C" fn ns_rx_install() {
    unsafe {
        // Stop the (vendor) DMA first so re-enabling is a real 0->1 edge that
        // forces the engine to reload our descriptor base — mid-flight the engine
        // tracks its own NEXT pointer and ignores a base overwrite.
        lmac::datapath::disable_rx();
        RING.install(); // writes RX_DSCR_BASE = &descs, clears INT
        lmac::datapath::enable_rx(); // RX_CTRL |= 0x8800_0000 (M0a-measured)
    }
}

/// Snapshot of one poll cycle for the C shim to print.
#[repr(C)]
pub struct RxReport {
    /// Descriptors the hardware completed this cycle (OWN bit cleared).
    pub reaped: u32,
    /// Of the reaped frames, how many were 802.11 beacons (FC 0x80).
    pub beacons: u32,
    /// Length + first FC byte of the first frame seen (diagnostic).
    pub first_len: u32,
    pub first_fc: u32,
    /// How many beacons our heapless parser (`dispatch_wifi`) accepted — proves
    /// the upper stack handles REAL over-the-air frames, not injected ones.
    pub parsed: u32,
    /// Live RX_DSCR_BASE (to detect the vendor re-arming its own ring) + RX_CTRL +
    /// RX_DSCR_NEXT (advances if hardware is walking our ring) + descs[0].word0.
    pub dscr_base: u32,
    pub rx_ctrl: u32,
    pub dscr_next: u32,
    pub desc0_w0: u32,
    /// Offset within the reaped buffer where an 802.11 beacon MAC header was found
    /// (FC 0x80 + broadcast DA), or 0xffff if none — locates the RX vector header
    /// size prepended before the frame.
    pub beacon_off: u32,
    /// First 96 bytes of the first reaped buffer (the RX vector header + frame).
    pub first96: [u8; 96],
}

/// Scan a reaped buffer for the start of an 802.11 beacon: FC byte `0x80` followed
/// (24-byte MAC header: FC, dur, addr1=broadcast) by a broadcast DA. Returns the
/// offset, or `0xffff` if not found. This pins the RX vector header size.
fn find_beacon_off(buf: &[u8]) -> u32 {
    let mut i = 0usize;
    while i + 10 <= buf.len() {
        if buf[i] == 0x80 && buf[i + 1] == 0x00 && buf[i + 4..i + 10] == [0xff; 6] {
            return i as u32;
        }
        i += 1;
    }
    0xffff
}

/// Reap completed descriptors and drain ready frames, classifying + recycling
/// each. Returns a report; bounded and allocation-free.
#[no_mangle]
pub extern "C" fn ns_rx_poll() -> RxReport {
    unsafe {
        let reaped = RING.reap() as u32;
        let mut beacons = 0u32;
        let mut parsed = 0u32;
        let mut first_len = 0u32;
        let mut first_fc = 0xffffu32;
        let mut first96 = [0u8; 96];
        let mut beacon_off = 0xffffu32;
        while let Some((idx, frame)) = RING.next_frame() {
            if !frame.is_empty() {
                if first_fc == 0xffff {
                    first_fc = frame[0] as u32;
                    first_len = frame.len() as u32;
                    let n = frame.len().min(96);
                    first96[..n].copy_from_slice(&frame[..n]);
                    beacon_off = find_beacon_off(frame);
                }
                // Look for a beacon at the RX-vector offset (whole-buffer scan).
                let off = find_beacon_off(frame);
                if off != 0xffff {
                    beacons += 1;
                    let mut recon: Buf<512> = Buf::new();
                    if dispatch_wifi(&frame[off as usize..], &mut recon) {
                        parsed += 1;
                    }
                }
            }
            RING.recycle(idx);
        }
        let dscr_base = mmio::read32(macregs::RX_DSCR_BASE);
        let rx_ctrl = mmio::read32(0x600A_4080);
        let dscr_next = mmio::read32(macregs::RX_DSCR_NEXT);
        let desc0_w0 = RING.peek_word0(0);
        RxReport {
            reaped,
            beacons,
            first_len,
            first_fc,
            parsed,
            dscr_base,
            rx_ctrl,
            dscr_next,
            desc0_w0,
            beacon_off,
            first96,
        }
    }
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
