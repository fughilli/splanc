//! The C6 front end's Rust staticlib (docs/design/p4-c6-split.md §4.3, the pure relay).
//!
//! The front end of a P4 + C6 board runs no player core and no effects engine: the P4
//! does. What stays here is what belongs to the network side:
//! - the OTA core's C ABI (splanc_ota::capi, for ota_app.cpp; linked, not called from Rust);
//! - the Wi-Fi rejoin policy and its protocol arms (wifi_ffi.rs, set/get_wifi_policy);
//! - the mDNS responder (`_splanc._tcp`, TXT id / name / fw / path / tls);
//! - reading a frame's ClientMessage arm and a set_device_name's name, so relay_main.cpp
//!   can route each message (answer here, or forward it to the P4).
#![no_std]

// The OTA core's C ABI (ota_ffi.h) for the app's update hooks (ota_app.cpp), and the
// encoders relay_main.cpp answers with (TLS info, errors).
extern crate splanc_ota;

use core::ffi::{c_char, CStr};
use core::ptr::{addr_of, addr_of_mut};

use ledmapper_view::ledmapper::v1 as pv;
use pv::client_message::Msg as CArm;

// The protobuf reply writer (pb_out.rs), shared with the player's ffi.rs.
mod pb_out;
use pb_out::{write_arm, PbOut};
// The Wi-Fi rejoin policy (auto / fixed / manual / offline): config + protocol arms.
mod wifi_ffi;
pub use wifi_ffi::*;

/// The frame's `ClientMessage` arm, read in place.
fn client_arm(frame: &[u8]) -> Option<CArm<'_>> {
    pv::ClientMessageView::parse(frame).ok()?.msg()
}

const ARM_SET_WIFI_POLICY: u32 = 90;
const ARM_GET_WIFI_POLICY: u32 = 91;

#[cfg(all(not(test), target_os = "none"))]
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    // As the player's (ffi.rs): say where, then abort() so the reset reason is PANIC
    // and the OTA crash-loop guard counts it.
    extern "C" {
        fn esp_rom_printf(fmt: *const u8, ...) -> i32;
        fn abort() -> !;
    }
    unsafe {
        match info.location() {
            Some(l) => {
                let f = l.file();
                esp_rom_printf(b"[rust] panic at %.*s:%u\n\0".as_ptr(), f.len() as i32, f.as_ptr(), l.line());
            }
            None => {
                esp_rom_printf(b"[rust] panic\n\0".as_ptr());
            }
        }
        abort()
    }
}

/// The ClientMessage oneof field number of `data` (its first key), or -1.
///
/// # Safety
/// `data` points to `len` readable bytes (or is null).
#[no_mangle]
pub unsafe extern "C" fn lm_envelope_arm(data: *const u8, len: usize) -> i32 {
    if data.is_null() || len == 0 {
        return -1;
    }
    let mut key: u32 = 0;
    for (i, b) in core::slice::from_raw_parts(data, len).iter().copied().enumerate().take(5) {
        key |= u32::from(b & 0x7f) << (7 * i);
        if b & 0x80 == 0 {
            return (key >> 3) as i32;
        }
    }
    -1
}

/// A set_device_name's name into `out` (NUL-terminated, truncated to `cap - 1`); its
/// length, or -1 when the frame is not a set_device_name.
///
/// # Safety
/// `frame` points to `len` readable bytes, `out` to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_relay_device_name(frame: *const u8, len: usize, out: *mut u8, cap: usize) -> i32 {
    if frame.is_null() || out.is_null() || cap == 0 {
        return -1;
    }
    let Some(CArm::SetDeviceName(m)) = client_arm(core::slice::from_raw_parts(frame, len)) else {
        return -1;
    };
    let name = m.name().as_bytes();
    let n = core::cmp::min(name.len(), cap - 1);
    core::ptr::copy_nonoverlapping(name.as_ptr(), out, n);
    *out.add(n) = 0;
    n as i32
}

/// Whether `frame` is a live move: a set_uniforms with a non-zero seq, `commit: false` and
/// no apply time (what the player's live mailbox takes). The relay forwards those to the P4
/// like everything else, and treats the ControlAck that comes back as best-effort (held,
/// never blocked on: netstack_transport.cpp flush_held_ack).
///
/// # Safety
/// `data` points to `len` readable bytes (or is null).
#[no_mangle]
pub unsafe extern "C" fn lm_is_live_move(data: *const u8, len: usize) -> bool {
    if data.is_null() || len == 0 {
        return false;
    }
    match client_arm(core::slice::from_raw_parts(data, len)) {
        Some(CArm::SetUniforms(m)) => m.seq() != 0 && m.commit() == Some(false) && m.apply_at_ms().is_none(),
        _ => false,
    }
}

/// The arms the front end answers itself, whether or not the P4 is up: the Wi-Fi rejoin
/// policy (the radio is this chip's). The reply into `out`: its length, or -1 when the
/// frame is not one of them (-2: `out` too small).
///
/// # Safety
/// `frame` points to `len` readable bytes, `out` to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_relay_local(frame: *const u8, len: usize, out: *mut u8, cap: usize) -> i32 {
    if frame.is_null() || out.is_null() {
        return -1;
    }
    let f = core::slice::from_raw_parts(frame, len);
    match lm_envelope_arm(frame, len) {
        a if a == ARM_SET_WIFI_POLICY as i32 => wifi_ffi::handle_set_wifi_policy(f, out, cap),
        a if a == ARM_GET_WIFI_POLICY as i32 => wifi_ffi::handle_get_wifi_policy(out, cap),
        _ => -1,
    }
}

// -- mDNS ------------------------------------------------------------------------------

struct Ident {
    mac: [u8; 18],
    name: [u8; 33],
    fw: [u8; 32],
    tls: [u8; 16],
}
static mut IDENT: Ident = Ident { mac: [0; 18], name: [0; 33], fw: [0; 32], tls: [0; 16] };

unsafe fn copy_c(dst: &mut [u8], src: *const c_char) {
    let mut n = 0;
    if !src.is_null() {
        let b = CStr::from_ptr(src).to_bytes();
        n = core::cmp::min(b.len(), dst.len() - 1);
        dst[..n].copy_from_slice(&b[..n]);
    }
    dst[n] = 0;
}

fn get(buf: &[u8]) -> &str {
    let n = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    core::str::from_utf8(&buf[..n]).unwrap_or("")
}

/// What mDNS answers with: the MAC the app knows the device by ("AA:BB:.."), its display
/// name, this build's version, and the TLS identity's state ("" until published).
/// Null leaves a field as it is.
///
/// # Safety
/// Strings are null or NUL-terminated.
#[no_mangle]
pub unsafe extern "C" fn lm_relay_set_identity(
    mac: *const c_char,
    name: *const c_char,
    fw: *const c_char,
    tls_state: *const c_char,
) {
    let id = &mut *addr_of_mut!(IDENT);
    if !mac.is_null() {
        copy_c(&mut id.mac, mac);
    }
    if !name.is_null() {
        copy_c(&mut id.name, name);
    }
    if !fw.is_null() {
        copy_c(&mut id.fw, fw);
    }
    if !tls_state.is_null() {
        copy_c(&mut id.tls, tls_state);
    }
}

unsafe fn with_service<R>(ip: [u8; 4], f: impl FnOnce(&ledmapper_mdns::Service) -> R) -> R {
    let id = &*addr_of!(IDENT);
    let (mac, name, fw, tls) = (get(&id.mac), get(&id.name), get(&id.fw), get(&id.tls));
    let mut hb = [0u8; 13];
    let host = ledmapper_mdns::host_label(mac, &mut hb);
    let mut ab = [0u8; 63];
    let alias = ledmapper_mdns::name_label(name, &mut ab);
    // The player's TXT (ffi.rs with_mdns_service), so discovery can't tell them apart.
    let txt = [("id", mac), ("name", name), ("fw", fw), ("path", "/.well-known/splanc.json"), ("tls", tls)];
    let txt: &[(&str, &str)] = if tls.is_empty() { &txt[..4] } else { &txt };
    let svc = ledmapper_mdns::Service { host, instance: name, alias, port: 443, ip, txt };
    f(&svc)
}

/// Answer one mDNS datagram (as the player's lm_mdns_respond): the reply's length, 0 for
/// nothing to answer, -2 when `out` is too small.
///
/// # Safety
/// Pointers are valid for the stated sizes.
#[no_mangle]
pub unsafe extern "C" fn lm_mdns_respond(
    query: *const u8,
    qlen: usize,
    src_port: u16,
    ip: *const u8,
    out: *mut u8,
    cap: usize,
    unicast: *mut bool,
) -> i32 {
    if query.is_null() || ip.is_null() || out.is_null() || unicast.is_null() {
        return -1;
    }
    let q = core::slice::from_raw_parts(query, qlen);
    let ip = [*ip, *ip.add(1), *ip.add(2), *ip.add(3)];
    let o = core::slice::from_raw_parts_mut(out, cap);
    match with_service(ip, |s| ledmapper_mdns::respond(q, src_port, s, o)) {
        Some(r) => {
            *unicast = r.dest == ledmapper_mdns::Dest::Unicast;
            r.len as i32
        }
        None => 0,
    }
}

/// An unsolicited announcement of every record: its length, or -2 when it doesn't fit.
///
/// # Safety
/// `ip` points to 4 readable bytes, `out` to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_mdns_announce(ip: *const u8, out: *mut u8, cap: usize) -> i32 {
    if ip.is_null() || out.is_null() {
        return -1;
    }
    let ip = [*ip, *ip.add(1), *ip.add(2), *ip.add(3)];
    let o = core::slice::from_raw_parts_mut(out, cap);
    match with_service(ip, |s| ledmapper_mdns::announce(s, o)) {
        Some(n) => n as i32,
        None => -2,
    }
}
