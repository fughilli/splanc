#![no_std]
//! Example applications built on the `ledmapper_netstack` heapless stack.
//! Linked as a static library into the tiny Arduino shims in this directory;
//! each `extern "C"` runner exercises one role through the stack and returns a
//! C-ABI [`DemoResult`] the shim prints. No dynamic allocation, no radio access
//! — the roles run on representative frames fed through the ingest seam.

use ledmapper_netstack::gap::{Attribute, GapState};
use ledmapper_netstack::http;
use ledmapper_netstack::mlme::{subtype, Mac};
use ledmapper_netstack::rx::Buf;
use ledmapper_netstack::stack::{Ingest, Role, Stack};

/// Uniform result for an example role. Fields are role-documented (see each fn).
#[repr(C)]
pub struct DemoResult {
    /// 1 = the role reached its expected end state.
    pub ok: u32,
    /// How many steps completed (diagnostic if `ok == 0`).
    pub step: u32,
    /// Role-specific detail (STA final state / AP station count / HTTP status …).
    pub detail: u32,
}

const AP_MAC: Mac = [0x02, 0x00, 0x53, 0x45, 0x43, 0xa0];
const STA_MAC: Mac = [0x02, 0x00, 0x53, 0x45, 0x43, 0x01];

// --- frame builders (fixed buffers) -----------------------------------------

/// Build an 802.11 management frame into `buf`: FC subtype byte at [0], addr2
/// (transmitter) at [10], then `body` after the 24-byte header. Returns length.
fn build_mgmt(buf: &mut [u8; 128], fc: u8, src: Mac, body: &[u8]) -> usize {
    for b in buf.iter_mut() {
        *b = 0;
    }
    buf[0] = fc;
    buf[10..16].copy_from_slice(&src); // addr2 = src
    let n = 24;
    buf[n..n + body.len()].copy_from_slice(body);
    n + body.len()
}

/// Build a single-fragment HCI-ACL packet carrying an ATT PDU on CID 0x0004.
fn build_acl(buf: &mut [u8; 64], att: &[u8]) -> usize {
    let l2len = att.len() as u16;
    let total = 4 + att.len(); // l2cap header(4) + payload
    buf[0] = 0x40; // handle 0x40
    buf[1] = 0x00;
    buf[2] = total as u8;
    buf[3] = (total >> 8) as u8;
    buf[4] = l2len as u8;
    buf[5] = (l2len >> 8) as u8;
    buf[6] = 0x04; // CID 0x0004 = ATT
    buf[7] = 0x00;
    buf[8..8 + att.len()].copy_from_slice(att);
    8 + att.len()
}

// --- BLE peripheral ---------------------------------------------------------

/// BLE peripheral: set advertising, then handle an ATT write to a writable
/// characteristic and confirm the stored value. `detail` = stored first byte.
#[no_mangle]
pub extern "C" fn ble_peripheral_demo() -> DemoResult {
    let mut s: Stack<1, 2, 2, 4> = Stack::new(Role::Sta, STA_MAC, AP_MAC);
    let mut step = 0;

    // 1) register a writable characteristic (handle 0x0003).
    if s.gatt_mut()
        .add(Attribute::new(0x0003, 0x2a00, b"?", true))
        .is_err()
    {
        return DemoResult { ok: 0, step, detail: 0 };
    }
    step += 1;

    // 2) start advertising.
    s.peripheral_mut().set_adv(b"heapless-c6").ok();
    s.peripheral_mut().start_advertising();
    if s.peripheral_mut().state != GapState::Advertising {
        return DemoResult { ok: 0, step, detail: 0 };
    }
    step += 1;

    // 3) a central connects and writes "hi" to handle 3 (ATT WRITE_REQ 0x12).
    let mut acl = [0u8; 64];
    let n = build_acl(&mut acl, &[0x12, 0x03, 0x00, b'h', b'i']);
    if !matches!(s.ingest_ble(&acl[..n]), Ingest::Replied(_)) {
        return DemoResult { ok: 0, step, detail: 0 };
    }
    step += 1;

    // 4) confirm the GATT server actually stored the written value.
    let stored = s.gatt_mut().value_of(0x0003).unwrap_or(&[]);
    let ok = stored == b"hi";
    let detail = *stored.first().unwrap_or(&0) as u32;
    DemoResult { ok: ok as u32, step: step + ok as u32, detail }
}

// --- STA client -------------------------------------------------------------

/// STA client: connect -> receive AUTH -> receive ASSOC_RESP -> Associated.
/// `detail` = final state code (4 = Associated).
#[no_mangle]
pub extern "C" fn sta_client_demo() -> DemoResult {
    let mut s: Stack<1, 2, 4, 4> = Stack::new(Role::Sta, STA_MAC, AP_MAC);
    let mut step = 0;
    let mut buf = [0u8; 128];

    // 1) kick off the join (queues the auth request).
    if !matches!(s.sta_connect(AP_MAC), Ingest::Replied(_)) {
        return DemoResult { ok: 0, step, detail: 0 };
    }
    step += 1;

    // 2) AP replies AUTH (open, status 0): algo(2)+seq(2)+status(2).
    let n = build_mgmt(&mut buf, subtype::AUTH, AP_MAC, &[0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
    if !matches!(s.ingest_wifi(&buf[..n]), Ingest::Replied(_)) {
        return DemoResult { ok: 0, step, detail: 0 };
    }
    step += 1;

    // 3) AP replies ASSOC_RESP: cap(2)+status(2)+aid(2)...
    let n = build_mgmt(&mut buf, subtype::ASSOC_RESP, AP_MAC, &[0x21, 0x04, 0x00, 0x00]);
    let _ = s.ingest_wifi(&buf[..n]);
    step += 1;

    let ok = s.sta_associated();
    // final state: 4 = Associated (mirrors StaState ordering).
    let detail = if ok { 4 } else { 0 };
    DemoResult { ok: ok as u32, step: step + ok as u32, detail }
}

// --- AP webserver -----------------------------------------------------------

/// AP webserver: accept a station (AUTH -> ASSOC_REQ) and serve `GET /` with a
/// bounded HTTP 200. `detail` = HTTP status code served (200).
#[no_mangle]
pub extern "C" fn ap_webserver_demo() -> DemoResult {
    let mut s: Stack<1, 2, 8, 4> = Stack::new(Role::Ap, AP_MAC, AP_MAC);
    let mut step = 0;
    let mut buf = [0u8; 128];

    // 1) station authenticates.
    let n = build_mgmt(&mut buf, subtype::AUTH, STA_MAC, &[0x00, 0x00, 0x01, 0x00, 0x00, 0x00]);
    if !matches!(s.ingest_wifi(&buf[..n]), Ingest::Replied(_)) {
        return DemoResult { ok: 0, step, detail: 0 };
    }
    step += 1;

    // 2) station associates.
    let n = build_mgmt(&mut buf, subtype::ASSOC_REQ, STA_MAC, &[0x21, 0x04, 0x0a, 0x00]);
    if !matches!(s.ingest_wifi(&buf[..n]), Ingest::Replied(_)) {
        return DemoResult { ok: 0, step, detail: 0 };
    }
    if s.ap_station_count() != 1 {
        return DemoResult { ok: 0, step, detail: 0 };
    }
    step += 1;

    // 3) the associated station issues an HTTP GET; serve a bounded 200.
    let mut resp: Buf<256> = Buf::new();
    if http::serve(b"GET / HTTP/1.1\r\nHost: c6\r\n\r\n", &mut resp).is_err() {
        return DemoResult { ok: 0, step, detail: 0 };
    }
    let served_200 = resp.as_slice().starts_with(b"HTTP/1.1 200");
    step += served_200 as u32;

    let ok = s.ap_station_count() == 1 && served_200;
    DemoResult { ok: ok as u32, step, detail: if served_200 { 200 } else { 0 } }
}

#[cfg(not(test))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    loop {}
}
