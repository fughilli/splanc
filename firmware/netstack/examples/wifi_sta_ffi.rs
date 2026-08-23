//! Combined heapless MAC RX+TX FFI (Milestone 2). Exposes frame-level send/recv
//! over our reverse-engineered descriptor rings so the C driver can run the STA
//! association exchange (auth -> assoc) with real frames on silicon:
//!   * `ns_mac_rx_install` — install our RX ring + arm RX (M0b).
//!   * `ns_mac_recv` — reap + return the next 802.11 frame, RX-header stripped.
//!   * `ns_mac_send` — transmit an 802.11 frame via our TX recipe (M1b).

#![no_std]
#![allow(static_mut_refs)]

use ledmapper_netstack::lmac;
use ledmapper_netstack::mac::{rx_frame, RxRing};
use ledmapper_netstack::tx::TxRing;

static mut RX: RxRing<8> = RxRing::new();
static mut TX: TxRing<4> = TxRing::new();

/// Install our RX descriptor ring and arm RX (the C shim has already brought the
/// PHY/clock/channel up via the vendor blob and put the MAC in promiscuous filter).
#[no_mangle]
pub extern "C" fn ns_mac_rx_install() {
    unsafe {
        lmac::datapath::disable_rx();
        RX.install();
        lmac::datapath::enable_rx();
    }
}

/// Reap the RX ring and copy the next completed 802.11 frame (past the 92-byte
/// hardware RX vector header) into `out`. Returns its length, or 0 if none ready.
#[no_mangle]
pub extern "C" fn ns_mac_recv(out: *mut u8, cap: u32) -> u32 {
    unsafe {
        RX.reap();
        if let Some((idx, buf)) = RX.next_frame() {
            let frame = rx_frame(buf);
            let n = frame.len().min(cap as usize);
            core::ptr::copy_nonoverlapping(frame.as_ptr(), out, n);
            RX.recycle(idx);
            n as u32
        } else {
            0
        }
    }
}

/// Transmit an 802.11 `frame` on access category `queue` via our TX recipe
/// (load_frame -> set_rate -> arm). Returns 1 on submit, 0 if the pool is full.
#[no_mangle]
pub extern "C" fn ns_mac_send(frame: *const u8, len: u32, queue: u32) -> u32 {
    unsafe {
        let f = core::slice::from_raw_parts(frame, len as usize);
        match TX.load_frame(f, queue as usize) {
            Ok(idx) => {
                TX.set_rate(idx);
                TX.arm(idx);
                // A single-frame pool churns fast; free the slot for reuse next call.
                TX.on_complete(idx);
                1
            }
            Err(_) => 0,
        }
    }
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
