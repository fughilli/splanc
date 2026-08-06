//! C ABI surface consumed by the C++ TouchDesigner plugin shim
//! (`tools/touchdesigner/plugin`). All networking lives behind a [`Session`];
//! these entry points only marshal data across the boundary and never block on
//! the network (except [`tdlm_discover_json`], which is meant to be driven off
//! a pulse parameter, not per-cook).
//!
//! Ownership: [`tdlm_create`] returns an opaque handle the caller must release
//! with [`tdlm_destroy`]. Buffer-returning calls follow one convention: they
//! copy up to `cap` bytes into `out` and return the FULL byte length of the
//! payload (so a caller can detect truncation and retry with a bigger buffer).

use crate::client::{Config, Session};
use crate::discovery::{self, DEFAULT_WS_PORT};
use crate::manifest::UniformKind;
use crate::proto::UniformValue;
use crate::texture::{ChannelOrder, Format};
use std::ffi::CStr;
use std::os::raw::c_char;
use std::time::Duration;

/// Opaque handle shared with the C++ side.
pub struct Handle {
    session: Session,
    /// Uniform values staged for the current cook (committed atomically).
    staging: Vec<UniformValue>,
}

unsafe fn cstr<'a>(p: *const c_char) -> &'a str {
    if p.is_null() {
        ""
    } else {
        CStr::from_ptr(p).to_str().unwrap_or("")
    }
}

unsafe fn write_out(s: &[u8], out: *mut u8, cap: usize) -> i32 {
    if !out.is_null() && cap > 0 {
        let n = s.len().min(cap);
        std::ptr::copy_nonoverlapping(s.as_ptr(), out, n);
    }
    s.len() as i32
}

fn order_from(v: u32) -> ChannelOrder {
    if v == 0 {
        ChannelOrder::Rgba
    } else {
        ChannelOrder::Bgra
    }
}

/// Create a session handle (starts idle until configured).
#[no_mangle]
pub extern "C" fn tdlm_create() -> *mut Handle {
    let session = Session::start(Config { ..Config::default() });
    Box::into_raw(Box::new(Handle { session, staging: Vec::new() }))
}

/// Destroy a handle (joins the worker thread).
///
/// # Safety
/// `h` must have come from [`tdlm_create`] and not be used afterwards.
#[no_mangle]
pub unsafe extern "C" fn tdlm_destroy(h: *mut Handle) {
    if !h.is_null() {
        drop(Box::from_raw(h));
    }
}

/// (Re)configure the target. `format` is one of "rgb888"/"rgb565"/"rgb332"/
/// "gray8"; `order` is 0=RGBA, 1=BGRA; `effect_id` may be empty.
///
/// # Safety
/// `h` must be valid; the `*const c_char` args must be NUL-terminated or null.
#[no_mangle]
pub unsafe extern "C" fn tdlm_configure(
    h: *mut Handle,
    addr: *const c_char,
    tex_index: u32,
    format: *const c_char,
    order: u32,
    rle: bool,
    effect_id: *const c_char,
) {
    let Some(h) = h.as_mut() else { return };
    let effect = cstr(effect_id);
    let cfg = Config {
        addr: cstr(addr).to_string(),
        tex_index,
        format: Format::from_name(cstr(format)),
        order: order_from(order),
        rle,
        effect_id: if effect.is_empty() { None } else { Some(effect.to_string()) },
    };
    h.session.reconfigure(cfg);
}

/// Push the latest frame. `pixels` is `w*h*4` bytes (channel order per config).
///
/// # Safety
/// `pixels` must point to at least `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn tdlm_push_texture(
    h: *mut Handle,
    pixels: *const u8,
    len: usize,
    w: u32,
    height: u32,
) {
    let Some(h) = h.as_mut() else { return };
    if pixels.is_null() || len < (w as usize * height as usize * 4) {
        return;
    }
    let slice = std::slice::from_raw_parts(pixels, len);
    h.session.push_texture(slice, w as usize, height as usize);
}

/// Clear the per-cook uniform staging set.
///
/// # Safety
/// `h` must be valid.
#[no_mangle]
pub unsafe extern "C" fn tdlm_begin_uniforms(h: *mut Handle) {
    if let Some(h) = h.as_mut() {
        h.staging.clear();
    }
}

/// Stage one uniform: `slot` with `n` float values (1..4).
///
/// # Safety
/// `values` must point to at least `n` readable floats.
#[no_mangle]
pub unsafe extern "C" fn tdlm_stage_uniform(h: *mut Handle, slot: u32, values: *const f32, n: u32) {
    let Some(h) = h.as_mut() else { return };
    if values.is_null() || n == 0 || n > 4 {
        return;
    }
    let vals = std::slice::from_raw_parts(values, n as usize).to_vec();
    h.staging.push(UniformValue { slot, values: vals });
}

/// Commit the staged uniforms to the session (change-detected before sending).
///
/// # Safety
/// `h` must be valid.
#[no_mangle]
pub unsafe extern "C" fn tdlm_commit_uniforms(h: *mut Handle) {
    if let Some(h) = h.as_mut() {
        let set = std::mem::take(&mut h.staging);
        h.session.push_uniforms(set);
    }
}

/// Drive uniforms from named channel values in one call: `names[i]` is a
/// channel name and `values[i]` its current value. The Rust core maps them onto
/// uniform slots via the fixture manifest (or `slotN` fallback) and pushes the
/// result (change-detected). This keeps all mapping logic testable in Rust.
///
/// # Safety
/// `names` must point to `count` NUL-terminated C strings and `values` to
/// `count` readable floats.
#[no_mangle]
pub unsafe extern "C" fn tdlm_drive_uniforms(
    h: *mut Handle,
    names: *const *const c_char,
    values: *const f32,
    count: u32,
) {
    let Some(h) = h.as_mut() else { return };
    if names.is_null() || values.is_null() {
        return;
    }
    let mut map = std::collections::HashMap::new();
    for i in 0..count as usize {
        let name_ptr = *names.add(i);
        let name = cstr(name_ptr);
        if !name.is_empty() {
            map.insert(name.to_string(), *values.add(i));
        }
    }
    h.session.drive_uniforms(&map);
}

/// Write a JSON status snapshot into `out`. Returns the full payload length.
///
/// # Safety
/// `out` must point to at least `cap` writable bytes (or be null with cap 0).
#[no_mangle]
pub unsafe extern "C" fn tdlm_status_json(h: *mut Handle, out: *mut u8, cap: usize) -> i32 {
    let Some(h) = h.as_mut() else { return 0 };
    let s = h.session.status();
    let json = serde_json::json!({
        "connected": s.connected,
        "name": s.name,
        "mac": s.mac,
        "error": s.error,
        "framesSent": s.frames_sent,
    })
    .to_string();
    write_out(json.as_bytes(), out, cap)
}

/// Write the connected fixture's uniform ports as JSON into `out`:
/// `[{"name","slot","width","kind":"float|bool|vec","channels":[...]}]`.
/// Empty (`[]`) when the device embeds no manifest. Returns the full length.
///
/// # Safety
/// `out` must point to at least `cap` writable bytes (or be null with cap 0).
#[no_mangle]
pub unsafe extern "C" fn tdlm_ports_json(h: *mut Handle, out: *mut u8, cap: usize) -> i32 {
    let Some(h) = h.as_mut() else { return 0 };
    let ports = h.session.ports();
    let arr: Vec<serde_json::Value> = ports
        .iter()
        .map(|p| {
            let kind = match p.kind {
                UniformKind::Float => "float",
                UniformKind::Bool => "bool",
                UniformKind::Vec(_) => "vec",
            };
            serde_json::json!({
                "name": p.name,
                "slot": p.slot,
                "width": p.width,
                "kind": kind,
                "channels": p.channel_names(),
                "default": p.default,
            })
        })
        .collect();
    write_out(serde_json::Value::Array(arr).to_string().as_bytes(), out, cap)
}

/// Blocking LAN discovery. `hosts` is a comma-separated list of extra hosts to
/// probe; `sweep` also probes the local /24. Writes a JSON array of
/// `{"addr","mac","name"}` into `out` and returns the full payload length.
///
/// # Safety
/// `hosts` must be NUL-terminated or null; `out` must have `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn tdlm_discover_json(
    hosts: *const c_char,
    sweep: bool,
    port: u16,
    timeout_ms: u32,
    out: *mut u8,
    cap: usize,
) -> i32 {
    let host_list: Vec<String> = cstr(hosts)
        .split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    let port = if port == 0 { DEFAULT_WS_PORT } else { port };
    let timeout = Duration::from_millis(timeout_ms.max(50) as u64);
    let fixtures = discovery::discover(&host_list, sweep, port, timeout);
    let arr: Vec<serde_json::Value> = fixtures
        .iter()
        .map(|f| serde_json::json!({"addr": f.addr, "mac": f.mac, "name": f.name}))
        .collect();
    write_out(serde_json::Value::Array(arr).to_string().as_bytes(), out, cap)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_configure_destroy() {
        let h = tdlm_create();
        assert!(!h.is_null());
        unsafe {
            let addr = std::ffi::CString::new("192.0.2.1:81").unwrap();
            let fmt = std::ffi::CString::new("rgb565").unwrap();
            let eff = std::ffi::CString::new("").unwrap();
            tdlm_configure(h, addr.as_ptr(), 0, fmt.as_ptr(), 1, true, eff.as_ptr());
            let mut buf = [0u8; 256];
            let n = tdlm_status_json(h, buf.as_mut_ptr(), buf.len());
            assert!(n > 0);
            let s = std::str::from_utf8(&buf[..n as usize]).unwrap();
            assert!(s.contains("connected"));
            tdlm_destroy(h);
        }
    }

    #[test]
    fn staging_uniforms_no_crash() {
        let h = tdlm_create();
        unsafe {
            tdlm_begin_uniforms(h);
            let vals = [0.5f32, 1.0, 0.0];
            tdlm_stage_uniform(h, 0, vals.as_ptr(), 3);
            tdlm_commit_uniforms(h);
            tdlm_destroy(h);
        }
    }
}
