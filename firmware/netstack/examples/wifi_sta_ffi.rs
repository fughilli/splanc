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

/// CCMP-encrypt an outbound data frame: `hdr` is the 24-byte 802.11 header (Protected
/// bit set), `payload` is the LLC/SNAP + L3 bytes. Writes the full protected MPDU
/// (header + CCMP header + ciphertext + MIC) to `out`; returns its length (0 if no keys).
#[no_mangle]
pub extern "C" fn ns_sta_encrypt(hdr: *const u8, hdr_len: u32, payload: *const u8, payload_len: u32,
                                 out: *mut u8, cap: u32) -> u32 {
    unsafe {
        let Some(sup) = SUP.as_mut() else { return 0 };
        let h = core::slice::from_raw_parts(hdr, hdr_len as usize);
        let p = core::slice::from_raw_parts(payload, payload_len as usize);
        let o = core::slice::from_raw_parts_mut(out, cap as usize);
        sup.encrypt_data(h, p, o) as u32
    }
}

/// CCMP-verify + decrypt an inbound protected data frame. Writes the plaintext
/// payload (LLC/SNAP + L3) to `out`; returns its length, or 0 on auth/parse failure.
#[no_mangle]
pub extern "C" fn ns_sta_decrypt(frame: *const u8, frame_len: u32, out: *mut u8, cap: u32) -> u32 {
    unsafe {
        let Some(sup) = SUP.as_ref() else { return 0 };
        let f = core::slice::from_raw_parts(frame, frame_len as usize);
        let o = core::slice::from_raw_parts_mut(out, cap as usize);
        sup.decrypt_data(f, o).unwrap_or(0) as u32
    }
}

// --- TCP client -------------------------------------------------------------
use ledmapper_netstack::tcp::{State, TcpConn};

static mut TCP: Option<TcpConn> = None;

/// Open a TCP connection (src/dst are 4-byte IPv4). Builds the SYN into `out`.
#[no_mangle]
pub extern "C" fn ns_tcp_connect(src: *const u8, dst: *const u8, sport: u16, dport: u16,
                                 iss: u32, out: *mut u8, cap: u32) -> u32 {
    unsafe {
        let s = core::slice::from_raw_parts(src, 4);
        let d = core::slice::from_raw_parts(dst, 4);
        let mut conn = TcpConn::new([s[0], s[1], s[2], s[3]], [d[0], d[1], d[2], d[3]], sport, dport, iss);
        let o = core::slice::from_raw_parts_mut(out, cap as usize);
        let n = conn.connect(o);
        TCP = Some(conn);
        n as u32
    }
}

/// Feed an inbound IPv4 datagram to the connection. Writes any reply to `out`.
#[no_mangle]
pub extern "C" fn ns_tcp_on_ip(ip: *const u8, len: u32, out: *mut u8, cap: u32) -> u32 {
    unsafe {
        let Some(c) = TCP.as_mut() else { return 0 };
        let i = core::slice::from_raw_parts(ip, len as usize);
        let o = core::slice::from_raw_parts_mut(out, cap as usize);
        c.on_ip(i, o) as u32
    }
}

/// Queue application data to send; builds the segment into `out`.
#[no_mangle]
pub extern "C" fn ns_tcp_send(data: *const u8, len: u32, out: *mut u8, cap: u32) -> u32 {
    unsafe {
        let Some(c) = TCP.as_mut() else { return 0 };
        let d = core::slice::from_raw_parts(data, len as usize);
        let o = core::slice::from_raw_parts_mut(out, cap as usize);
        c.send(d, o) as u32
    }
}

/// Copy any received application bytes into `out` and clear the buffer.
#[no_mangle]
pub extern "C" fn ns_tcp_recv(out: *mut u8, cap: u32) -> u32 {
    unsafe {
        let Some(c) = TCP.as_mut() else { return 0 };
        let d = c.rx_data();
        let n = d.len().min(cap as usize);
        core::ptr::copy_nonoverlapping(d.as_ptr(), out, n);
        c.take_rx();
        n as u32
    }
}

/// Connection state: 0=Closed 1=SynSent 2=Established 3=FinWait 4=Done.
#[no_mangle]
pub extern "C" fn ns_tcp_state() -> u32 {
    unsafe {
        match TCP.as_ref().map(|c| c.state) {
            Some(State::Closed) => 0,
            Some(State::SynSent) => 1,
            Some(State::Established) => 2,
            Some(State::FinWait) => 3,
            Some(State::Done) => 4,
            None => 0,
        }
    }
}

/// Copy the installed pairwise TK (16 bytes) into `out` for programming the hardware
/// crypto key slot. Returns 1 if keys are installed, 0 otherwise.
#[no_mangle]
pub extern "C" fn ns_sta_get_tk(out: *mut u8) -> u32 {
    unsafe {
        let Some(sup) = SUP.as_ref() else { return 0 };
        let tk = sup.tk();
        core::ptr::copy_nonoverlapping(tk.as_ptr(), out, 16);
        1
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

/// Transmit `frame` requesting HARDWARE CCMP encryption (descriptor word0 bit 29). The
/// frame must be [802.11 hdr | 8B CCMP-header space | plaintext | 8B MIC space] with the
/// Protected bit set; the MAC fills the PN + MIC and encrypts, keying off the dest addr.
#[no_mangle]
pub extern "C" fn ns_mac_send_sec(frame: *const u8, len: u32, queue: u32) -> u32 {
    unsafe {
        let f = core::slice::from_raw_parts(frame, len as usize);
        match TX.load_frame(f, queue as usize) {
            Ok(idx) => {
                TX.mark_secure(idx);
                TX.set_rate(idx);
                TX.arm(idx);
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
