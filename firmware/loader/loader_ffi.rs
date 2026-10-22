//! The loader's Rust staticlib: the OTA core's C ABI (splanc_ota::capi, linked
//! through the dependency), the mDNS responder (so a device in recovery is still
//! discoverable as `_splanc._tcp`, TXT `mode=loader`), and the bare-metal panic
//! handler.
#![no_std]

pub use splanc_ota::capi;

use core::ffi::{c_char, CStr};

#[cfg(all(not(test), target_os = "none"))]
#[panic_handler]
fn panic(_: &core::panic::PanicInfo) -> ! {
    // The OTA core is bounded-error code; a panic is a loader bug. Halt where a
    // debugger can see it (the RTC watchdog isn't armed in the loader, but the
    // task watchdog resets a wedged loop, and the loader boots again).
    loop {}
}

static mut MAC: [u8; 18] = [0; 18];
static mut NAME: [u8; 33] = [0; 33];
static mut VERSION: [u8; 32] = [0; 32];

unsafe fn copy_c(dst: *mut u8, cap: usize, src: *const c_char) {
    let mut n = 0;
    if !src.is_null() {
        let b = CStr::from_ptr(src).to_bytes();
        n = core::cmp::min(b.len(), cap - 1);
        core::ptr::copy_nonoverlapping(b.as_ptr(), dst, n);
    }
    *dst.add(n) = 0;
}

unsafe fn get(buf: *const u8, cap: usize) -> &'static str {
    let s = core::slice::from_raw_parts(buf, cap);
    let n = s.iter().position(|&c| c == 0).unwrap_or(cap);
    core::str::from_utf8(&s[..n]).unwrap_or("")
}

/// The identity mDNS answers with: the factory MAC ("AA:BB:.."), the display
/// name, and the loader's version string.
///
/// # Safety
/// Strings are null or NUL-terminated.
#[no_mangle]
pub unsafe extern "C" fn loader_set_identity(mac: *const c_char, name: *const c_char, version: *const c_char) {
    copy_c(core::ptr::addr_of_mut!(MAC) as *mut u8, 18, mac);
    copy_c(core::ptr::addr_of_mut!(NAME) as *mut u8, 33, name);
    copy_c(core::ptr::addr_of_mut!(VERSION) as *mut u8, 32, version);
}

unsafe fn with_service<R>(ip: [u8; 4], f: impl FnOnce(&ledmapper_mdns::Service) -> R) -> R {
    let mac = get(core::ptr::addr_of!(MAC) as *const u8, 18);
    let name = get(core::ptr::addr_of!(NAME) as *const u8, 33);
    let fw = get(core::ptr::addr_of!(VERSION) as *const u8, 32);
    let mut hb = [0u8; 13];
    let host = ledmapper_mdns::host_label(mac, &mut hb);
    let txt = [
        ("id", mac),
        ("name", name),
        ("fw", fw),
        ("path", "/.well-known/splanc.json"),
        ("mode", "loader"),
    ];
    let svc = ledmapper_mdns::Service { host, instance: name, port: 443, ip, txt: &txt };
    f(&svc)
}

/// lm_mdns_reply's two halves (netstack_transport.h), for the loader.
///
/// # Safety
/// Pointers are valid for the stated sizes.
#[no_mangle]
pub unsafe extern "C" fn loader_mdns_respond(
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

/// # Safety
/// `ip` points to 4 bytes, `out` to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn loader_mdns_announce(ip: *const u8, out: *mut u8, cap: usize) -> i32 {
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
