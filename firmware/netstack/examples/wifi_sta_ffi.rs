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
use ledmapper_netstack::sta::{Out, Sta};
use ledmapper_netstack::tx::TxRing;

static mut RX: RxRing<8> = RxRing::new();
static mut TX: TxRing<4> = TxRing::new();
static mut SUP: Option<Sta> = None;

/// Initialise the WPA2-PSK supplicant for the 4-way handshake: derive the PMK from
/// `ssid`/`pass` and set the peer/self MACs + this station's SNonce.
#[no_mangle]
pub extern "C" fn ns_wpa_init(
    ssid: *const u8,
    ssid_len: u32,
    pass: *const u8,
    pass_len: u32,
    ap: *const u8,
    self_mac: *const u8,
    snonce: *const u8,
) {
    unsafe {
        let ssid = core::slice::from_raw_parts(ssid, ssid_len as usize);
        let pass = core::slice::from_raw_parts(pass, pass_len as usize);
        let mut apm = [0u8; 6];
        let mut sm = [0u8; 6];
        let mut sn = [0u8; 32];
        core::ptr::copy_nonoverlapping(ap, apm.as_mut_ptr(), 6);
        core::ptr::copy_nonoverlapping(self_mac, sm.as_mut_ptr(), 6);
        core::ptr::copy_nonoverlapping(snonce, sn.as_mut_ptr(), 32);
        SUP = Some(Sta::new(ssid, pass, apm, sm, sn));
    }
}

/// Feed a received EAPOL-Key frame (the raw 802.1X frame, starting `02 03 ..`, i.e.
/// after the 802.11 + LLC/SNAP headers) to the supplicant. Any reply (M2, then M4)
/// is written to `out`. Returns `(code << 16) | reply_len` where code is 0=nothing,
/// 1=send the reply, 2=send the reply (M4) and the 4-way is COMPLETE (keys installed).
#[no_mangle]
pub extern "C" fn ns_wpa_on_eapol(eapol: *const u8, len: u32, out: *mut u8, cap: u32) -> u32 {
    unsafe {
        let Some(sup) = SUP.as_mut() else { return 0 };
        let frame = core::slice::from_raw_parts(eapol, len as usize);
        let code: u32 = match sup.on_eapol(frame) {
            Out::Send(_) => 1,
            Out::Connected => 2,
            Out::None => return 0,
        };
        let reply = sup.last_tx();
        let n = reply.len().min(cap as usize);
        core::ptr::copy_nonoverlapping(reply.as_ptr(), out, n);
        (code << 16) | (n as u32)
    }
}

/// Diagnostic: report how the supplicant parses/verifies an EAPOL frame under the
/// current PTK, without mutating state. See `Supplicant::diag` for the bit layout.
#[no_mangle]
pub extern "C" fn ns_wpa_diag(eapol: *const u8, len: u32) -> u32 {
    unsafe {
        let Some(sup) = SUP.as_ref() else { return 0 };
        let frame = core::slice::from_raw_parts(eapol, len as usize);
        sup.diag_eapol(frame)
    }
}

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
