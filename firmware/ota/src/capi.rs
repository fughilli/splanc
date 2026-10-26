//! C ABI over the OTA core for the firmware's C++ (the loader's main and the
//! app's update hooks). Declared in firmware/ota/ota_ffi.h. Strings returned
//! are static and NUL-terminated; a null return means "ok".
//!
//! The loader runs one update session at a time on its loop task, so the
//! session lives in a static here.

use core::ffi::{c_char, CStr};

use crate::boot::{self, AppState, Handoff, Health, LoaderAction, LoaderInputs, Reset, Verdict};
use crate::manifest::{Manifest, ENCODED_LEN, SIGNATURE_LEN, SIGNED_LEN};
use crate::session::{self, Plan, Refusal, Resume, Session, Target, RESUME_LEN};
use crate::wire::{self, ClientArm, LoaderWelcome, Status};

/// A static C string for a machine code (every code the core can produce).
fn c(code: &str) -> *const c_char {
    let s: &'static CStr = match code {
        "bad_manifest" => c"bad_manifest",
        "bad_signature" => c"bad_signature",
        "loader_image" => c"loader_image",
        "wrong_board" => c"wrong_board",
        "too_large" => c"too_large",
        "downgrade" => c"downgrade",
        "no_session" => c"no_session",
        "out_of_order" => c"out_of_order",
        "bad_chunk" => c"bad_chunk",
        "overflow" => c"overflow",
        "bad_image" => c"bad_image",
        "wrong_chip" => c"wrong_chip",
        "incomplete" => c"incomplete",
        "verify_failed" => c"verify_failed",
        "flash_error" => c"flash_error",
        "update" => c"update",
        "requested" => c"requested",
        "no_app" => c"no_app",
        "rolled_back" => c"rolled_back",
        "crash_loop" => c"crash_loop",
        "render" => c"render",
        "tls" => c"tls",
        "network" => c"network",
        "unknown_key" => c"unknown_key",
        "revoked_key" => c"revoked_key",
        "security_floor" => c"security_floor",
        "bad_epoch" => c"bad_epoch",
        "stale_epoch" => c"stale_epoch",
        "bad_revocation" => c"bad_revocation",
        _ => c"error",
    };
    s.as_ptr()
}

fn refusal(r: Refusal) -> *const c_char {
    c(r.code())
}

unsafe fn bytes<'a>(p: *const u8, len: usize) -> &'a [u8] {
    if p.is_null() || len == 0 {
        &[]
    } else {
        core::slice::from_raw_parts(p, len)
    }
}

unsafe fn str_or_empty<'a>(p: *const c_char) -> &'a str {
    if p.is_null() {
        return "";
    }
    CStr::from_ptr(p).to_str().unwrap_or("")
}

// -- manifest ------------------------------------------------------------------------

#[repr(C)]
pub struct OtaManifestC {
    pub version: u32,
    pub size: u32,
    pub sha256: [u8; 32],
    pub flags: u32,
    /// The 44 signed bytes (SHA-256 them, then ECDSA-verify `signature`).
    pub signed_bytes: [u8; SIGNED_LEN],
    /// r || s, 32 bytes each, big-endian.
    pub signature: [u8; SIGNATURE_LEN],
}

/// Parse a 108-byte manifest. False when `len` isn't the manifest length.
///
/// # Safety
/// `p` points to `len` readable bytes; `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn ota_manifest_parse(p: *const u8, len: usize, out: *mut OtaManifestC) -> bool {
    let Some(m) = Manifest::decode(bytes(p, len)) else { return false };
    if out.is_null() {
        return false;
    }
    *out = OtaManifestC {
        version: m.version,
        size: m.size,
        sha256: m.sha256,
        flags: m.flags,
        signed_bytes: m.signed_bytes(),
        signature: m.signature,
    };
    true
}

/// "X.Y.Z[-...]" -> the manifest's version number (0 if it doesn't parse).
///
/// # Safety
/// `s` is null or a NUL-terminated string.
#[no_mangle]
pub unsafe extern "C" fn ota_parse_version(s: *const c_char) -> u32 {
    crate::manifest::parse_version(str_or_empty(s)).unwrap_or(0)
}

/// The app's pre-check of an offer (before it reboots into the loader).
///
/// # Safety
/// `p` points to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn ota_check_offer(
    p: *const u8,
    len: usize,
    signature_ok: bool,
    slot_size: u32,
    installed_version: u32,
    allow_downgrade: bool,
) -> *const c_char {
    let Some(m) = Manifest::decode(bytes(p, len)) else { return c("bad_manifest") };
    let t = Target { slot_size, chip: 0, installed_version };
    match session::check_offer(&m, signature_ok, &t, allow_downgrade) {
        Ok(()) => core::ptr::null(),
        Err(r) => refusal(r),
    }
}

// -- client messages -----------------------------------------------------------------

/// A decoded ClientMessage. `arm` is the oneof field number (0 = none); for the
/// OTA arms the fields below are filled, byte fields as offsets into the frame.
#[repr(C)]
pub struct OtaClientMsg {
    pub arm: u32,
    pub manifest_off: u32,
    pub manifest_len: u32,
    pub allow_downgrade: bool,
    pub offset: u32,
    pub data_off: u32,
    pub data_len: u32,
    /// ota_reboot target: 0 = app, 1 = loader.
    pub target: u8,
    /// time_sync_ping.t0.
    pub t0: f64,
    /// ota_begin.key_epoch (offset into the frame; len 0 = absent).
    pub epoch_off: u32,
    pub epoch_len: u32,
}

/// 0 = parsed (`out` filled); -1 bad args; -2 malformed frame.
///
/// # Safety
/// `frame` points to `len` readable bytes; `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn ota_parse_client(frame: *const u8, len: usize, out: *mut OtaClientMsg) -> i32 {
    if frame.is_null() || out.is_null() {
        return -1;
    }
    let f = bytes(frame, len);
    let base = f.as_ptr() as usize;
    let off = |s: &[u8]| (s.as_ptr() as usize).wrapping_sub(base) as u32;
    let mut m = OtaClientMsg {
        arm: 0,
        manifest_off: 0,
        manifest_len: 0,
        allow_downgrade: false,
        offset: 0,
        data_off: 0,
        data_len: 0,
        target: 0,
        t0: 0.0,
        epoch_off: 0,
        epoch_len: 0,
    };
    match wire::decode_client(f) {
        Err(_) => return -2,
        Ok(a) => match a {
            ClientArm::Hello => m.arm = wire::CM_HELLO,
            ClientArm::TimeSyncPing { t0 } => {
                m.arm = wire::CM_TIME_SYNC_PING;
                m.t0 = t0;
            }
            ClientArm::GetTlsInfo => m.arm = wire::CM_GET_TLS_INFO,
            ClientArm::OtaBegin { manifest, allow_downgrade, key_epoch, .. } => {
                m.arm = wire::CM_OTA_BEGIN;
                m.epoch_off = if key_epoch.is_empty() { 0 } else { off(key_epoch) };
                m.epoch_len = key_epoch.len() as u32;
                m.manifest_off = if manifest.is_empty() { 0 } else { off(manifest) };
                m.manifest_len = manifest.len() as u32;
                m.allow_downgrade = allow_downgrade;
            }
            ClientArm::OtaChunk { offset, data } => {
                m.arm = wire::CM_OTA_CHUNK;
                m.offset = offset;
                m.data_off = if data.is_empty() { 0 } else { off(data) };
                m.data_len = data.len() as u32;
            }
            ClientArm::OtaFinish => m.arm = wire::CM_OTA_FINISH,
            ClientArm::OtaAbort => m.arm = wire::CM_OTA_ABORT,
            ClientArm::GetOtaStatus => m.arm = wire::CM_GET_OTA_STATUS,
            ClientArm::OtaReboot { target } => {
                m.arm = wire::CM_OTA_REBOOT;
                m.target = target as u8;
            }
            ClientArm::Other(n) => m.arm = n,
            ClientArm::Empty => m.arm = 0,
        },
    }
    *out = m;
    0
}

// -- server messages -----------------------------------------------------------------

#[repr(C)]
pub struct OtaStatusC {
    pub mode: u8,
    pub state: u8,
    pub version: u32,
    pub size: u32,
    pub offset: u32,
    pub error: *const c_char,
    pub app_version: u32,
    pub app_fw_version: *const c_char,
    pub loader_reason: *const c_char,
    pub last_result: *const c_char,
    pub loader_version: u32,
    pub max_chunk: u32,
    pub slot_size: u32,
    pub key_epoch: u32,
    pub revoked_keys: u32,
    pub security_floor: u32,
}

unsafe fn status<'a>(s: &'a OtaStatusC) -> Status<'a> {
    Status {
        mode: s.mode,
        state: s.state,
        version: s.version,
        size: s.size,
        offset: s.offset,
        error: str_or_empty(s.error),
        app_version: s.app_version,
        app_fw_version: str_or_empty(s.app_fw_version),
        loader_reason: str_or_empty(s.loader_reason),
        last_result: str_or_empty(s.last_result),
        loader_version: s.loader_version,
        max_chunk: s.max_chunk,
        slot_size: s.slot_size,
        key_epoch: s.key_epoch,
        revoked_keys: s.revoked_keys,
        security_floor: s.security_floor,
        board: "",
    }
}

fn len_or(n: Option<usize>) -> i32 {
    n.map_or(-2, |n| n as i32)
}

/// `ServerMessage{ota_status}` into `out`; its length, or -2 if it doesn't fit.
///
/// # Safety
/// `s` is valid; `out` points to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn ota_encode_status(s: *const OtaStatusC, out: *mut u8, cap: usize) -> i32 {
    if s.is_null() || out.is_null() {
        return -1;
    }
    len_or(wire::encode_status(&status(&*s), core::slice::from_raw_parts_mut(out, cap)))
}

/// `ServerMessage{error{code, message}}`.
///
/// # Safety
/// Strings are null or NUL-terminated; `out` points to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn ota_encode_error(code: *const c_char, msg: *const c_char, out: *mut u8, cap: usize) -> i32 {
    if out.is_null() {
        return -1;
    }
    len_or(wire::encode_error(str_or_empty(code), str_or_empty(msg), core::slice::from_raw_parts_mut(out, cap)))
}

/// `ServerMessage{time_sync_pong}`.
///
/// # Safety
/// `out` points to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn ota_encode_time_sync_pong(t0: f64, t1: f64, t2: f64, out: *mut u8, cap: usize) -> i32 {
    if out.is_null() {
        return -1;
    }
    len_or(wire::encode_time_sync_pong(t0, t1, t2, core::slice::from_raw_parts_mut(out, cap)))
}

/// `ServerMessage{tls_info}`.
///
/// # Safety
/// Strings are null or NUL-terminated; `out` points to `cap` writable bytes.
#[no_mangle]
pub unsafe extern "C" fn ota_encode_tls_info(
    state: *const c_char,
    cert_sha256: *const c_char,
    persisted: bool,
    out: *mut u8,
    cap: usize,
) -> i32 {
    if out.is_null() {
        return -1;
    }
    len_or(wire::encode_tls_info(
        str_or_empty(state),
        str_or_empty(cert_sha256),
        persisted,
        core::slice::from_raw_parts_mut(out, cap),
    ))
}

/// The loader's `ServerMessage{welcome}`.
///
/// # Safety
/// Strings are null or NUL-terminated; `s` is valid; `out` points to `cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn ota_encode_loader_welcome(
    mac: *const c_char,
    device_name: *const c_char,
    fw_git_commit: *const c_char,
    fw_git_dirty: bool,
    fw_version: *const c_char,
    s: *const OtaStatusC,
    out: *mut u8,
    cap: usize,
) -> i32 {
    if s.is_null() || out.is_null() {
        return -1;
    }
    let wl = LoaderWelcome {
        mac: str_or_empty(mac),
        device_name: str_or_empty(device_name),
        fw_git_commit: str_or_empty(fw_git_commit),
        fw_git_dirty,
        fw_version: str_or_empty(fw_version),
        status: status(&*s),
    };
    len_or(wire::encode_loader_welcome(&wl, core::slice::from_raw_parts_mut(out, cap)))
}

// -- the loader's receive session ----------------------------------------------------

static mut SESSION: Option<Session> = None;

fn session_mut() -> &'static mut Option<Session> {
    // SAFETY: the loader drives the session from its loop task only.
    unsafe { &mut *core::ptr::addr_of_mut!(SESSION) }
}

/// Start or resume a session. `resume` is the persisted record (or null).
/// Null on success; otherwise the refusal code (and any previous session is
/// kept).
///
/// # Safety
/// Pointers are null or point to the stated lengths.
#[no_mangle]
pub unsafe extern "C" fn ota_session_begin(
    manifest: *const u8,
    manifest_len: usize,
    signature_ok: bool,
    slot_size: u32,
    chip: u16,
    installed_version: u32,
    allow_downgrade: bool,
    resume: *const u8,
    resume_len: usize,
) -> *const c_char {
    let Some(m) = Manifest::decode(bytes(manifest, manifest_len)) else { return c("bad_manifest") };
    let r = Resume::decode(bytes(resume, resume_len));
    let t = Target { slot_size, chip, installed_version };
    match Session::begin(m, signature_ok, &t, allow_downgrade, r.as_ref()) {
        Ok(s) => {
            *session_mut() = Some(s);
            core::ptr::null()
        }
        Err(e) => refusal(e),
    }
}

#[no_mangle]
pub extern "C" fn ota_session_active() -> bool {
    session_mut().is_some()
}

#[no_mangle]
pub extern "C" fn ota_session_offset() -> u32 {
    session_mut().as_ref().map_or(0, |s| s.offset())
}

#[no_mangle]
pub extern "C" fn ota_session_size() -> u32 {
    session_mut().as_ref().map_or(0, |s| s.size())
}

#[no_mangle]
pub extern "C" fn ota_session_version() -> u32 {
    session_mut().as_ref().map_or(0, |s| s.manifest.version)
}

/// The session's SHA-256 (from its signed manifest) into `out[32]`.
///
/// # Safety
/// `out` points to 32 writable bytes.
#[no_mangle]
pub unsafe extern "C" fn ota_session_sha256(out: *mut u8) -> bool {
    match session_mut().as_ref() {
        Some(s) if !out.is_null() => {
            core::ptr::copy_nonoverlapping(s.manifest.sha256.as_ptr(), out, 32);
            true
        }
        _ => false,
    }
}

#[no_mangle]
pub extern "C" fn ota_session_reset() {
    *session_mut() = None;
}

/// The resume record for the session's persisted progress into `out`
/// (OTA_RESUME_LEN bytes).
///
/// # Safety
/// `out` points to OTA_RESUME_LEN writable bytes.
#[no_mangle]
pub unsafe extern "C" fn ota_session_resume_record(out: *mut u8) -> bool {
    match session_mut().as_ref() {
        Some(s) if !out.is_null() => {
            core::ptr::copy_nonoverlapping(s.resume().encode().as_ptr(), out, RESUME_LEN);
            true
        }
        _ => false,
    }
}

#[repr(C)]
pub struct OtaPlanC {
    pub erase_off: u32,
    /// 0 = nothing to erase.
    pub erase_len: u32,
    pub write_at: u32,
    pub len: u32,
}

/// Plan the flash work for a chunk. Null on success (`out` filled).
///
/// # Safety
/// `data` points to `len` readable bytes; `out` is writable.
#[no_mangle]
pub unsafe extern "C" fn ota_session_plan(
    offset: u32,
    data: *const u8,
    len: usize,
    chip: u16,
    out: *mut OtaPlanC,
) -> *const c_char {
    let Some(s) = session_mut().as_ref() else { return c("no_session") };
    if out.is_null() {
        return c("error");
    }
    match s.plan(offset, bytes(data, len), chip) {
        Ok(p) => {
            let (eo, el) = p.erase.unwrap_or((0, 0));
            *out = OtaPlanC { erase_off: eo, erase_len: el, write_at: p.write_at, len: p.len };
            core::ptr::null()
        }
        Err(e) => refusal(e),
    }
}

/// The flash work for `p` succeeded. True when the progress must be persisted
/// now (`ota_session_resume_record`).
///
/// # Safety
/// `p` is valid.
#[no_mangle]
pub unsafe extern "C" fn ota_session_commit(p: *const OtaPlanC) -> bool {
    let (Some(s), false) = (session_mut().as_mut(), p.is_null()) else { return false };
    let p = &*p;
    let plan = Plan {
        erase: (p.erase_len > 0).then_some((p.erase_off, p.erase_len)),
        write_at: p.write_at,
        len: p.len,
    };
    s.commit(&plan).is_some()
}

/// Null when every byte has arrived (verify next), else the refusal.
#[no_mangle]
pub extern "C" fn ota_session_finish_ready() -> *const c_char {
    match session_mut().as_ref() {
        None => c("no_session"),
        Some(s) => match s.finish() {
            Ok(()) => core::ptr::null(),
            Err(e) => refusal(e),
        },
    }
}

/// Decode a persisted resume record: its manifest version/size and offset.
///
/// # Safety
/// `p` points to `len` readable bytes; outputs are writable or null.
#[no_mangle]
pub unsafe extern "C" fn ota_resume_info(p: *const u8, len: usize, version: *mut u32, size: *mut u32, offset: *mut u32) -> bool {
    let Some(r) = Resume::decode(bytes(p, len)) else { return false };
    if !version.is_null() {
        *version = r.manifest.version;
    }
    if !size.is_null() {
        *size = r.manifest.size;
    }
    if !offset.is_null() {
        *offset = r.offset;
    }
    true
}

// -- boot decisions ------------------------------------------------------------------

/// `app`: 0 missing, 1 bootable, 2 aborted, 3 invalid. `reset`: 0 power-on,
/// 1 brownout, 2 software, 3 panic, 4 watchdog, 5 other. `handoff`: 0 none,
/// 1 update, 2 stay, 3 crash loop.
#[repr(C)]
pub struct OtaLoaderInputsC {
    pub app: u8,
    pub update_incomplete: bool,
    pub handoff: u8,
    pub reset: u8,
    pub retry_spent: bool,
}

fn reset_of(v: u8) -> Reset {
    match v {
        0 => Reset::PowerOn,
        1 => Reset::Brownout,
        2 => Reset::Software,
        3 => Reset::Panic,
        4 => Reset::Watchdog,
        _ => Reset::Other,
    }
}

/// 0 = boot the app, 1 = retry the aborted app once, 2 = recovery (`reason`
/// and `idle_timeout_ms`, 0 = none, filled).
///
/// # Safety
/// `i` is valid; outputs are writable or null.
#[no_mangle]
pub unsafe extern "C" fn ota_loader_decide(
    i: *const OtaLoaderInputsC,
    reason: *mut *const c_char,
    idle_timeout_ms: *mut u32,
) -> u8 {
    if i.is_null() {
        return 2;
    }
    let i = &*i;
    let app = match i.app {
        1 => AppState::Bootable,
        2 => AppState::Aborted,
        3 => AppState::Invalid,
        _ => AppState::Missing,
    };
    let inputs = LoaderInputs {
        app,
        update_incomplete: i.update_incomplete,
        handoff: Handoff::from_u8(i.handoff),
        reset: reset_of(i.reset),
        retry_spent: i.retry_spent,
    };
    match boot::loader_decide(&inputs) {
        LoaderAction::BootApp => 0,
        LoaderAction::RetryApp => 1,
        LoaderAction::Recover(r) => {
            if !reason.is_null() {
                *reason = c(r.code());
            }
            if !idle_timeout_ms.is_null() {
                *idle_timeout_ms = r.idle_timeout_ms().unwrap_or(0);
            }
            2
        }
    }
}

/// This boot's crash counter (see boot::crash_count); `loop_tripped` set when
/// it reached the limit.
///
/// # Safety
/// `loop_tripped` is writable or null.
#[no_mangle]
pub unsafe extern "C" fn ota_crash_count(prev: u32, magic_ok: bool, reset: u8, loop_tripped: *mut bool) -> u32 {
    let n = boot::crash_count(prev, magic_ok, reset_of(reset));
    if !loop_tripped.is_null() {
        *loop_tripped = boot::crash_loop(n);
    }
    n
}

#[repr(C)]
pub struct OtaHealthC {
    pub uptime_ms: u32,
    pub render_alive: bool,
    pub tls_ready: bool,
    pub network_required: bool,
    pub leased: bool,
}

/// 0 = wait, 1 = healthy, 2 = failed (`why` names the unmet check).
///
/// # Safety
/// `h` is valid; `why` is writable or null.
#[no_mangle]
pub unsafe extern "C" fn ota_health(h: *const OtaHealthC, why: *mut *const c_char) -> u8 {
    if h.is_null() {
        return 0;
    }
    let h = &*h;
    let v = boot::health(&Health {
        uptime_ms: h.uptime_ms,
        render_alive: h.render_alive,
        tls_ready: h.tls_ready,
        network_required: h.network_required,
        leased: h.leased,
    });
    match v {
        Verdict::Wait => 0,
        Verdict::Healthy => 1,
        Verdict::Failed(w) => {
            if !why.is_null() {
                *why = c(w);
            }
            2
        }
    }
}

const _: () = assert!(ENCODED_LEN == 108 && RESUME_LEN == 112);

// -- keyring, key epochs, security floor (keyring.rs) ---------------------------------

use crate::keyring::{self, EpochRecord, KeyState, EPOCH_LEN, EPOCH_SIGNED_LEN};

#[repr(C)]
pub struct OtaKeyStateC {
    pub epoch: u32,
    pub revoked: u32,
    pub security_floor: u8,
}

fn ks(s: &OtaKeyStateC) -> KeyState {
    KeyState { epoch: s.epoch, revoked: s.revoked, security_floor: s.security_floor }
}

fn ring(mask: u32) -> impl Fn(u8) -> bool {
    move |id| id < 32 && mask & (1 << id) != 0
}

/// The ring key id that must verify this manifest (`out_id`); null when allowed.
/// `ring_mask`: bit n = the loader has key id n.
///
/// # Safety
/// Pointers valid for the stated sizes.
#[no_mangle]
pub unsafe extern "C" fn ota_key_select(
    manifest: *const u8,
    len: usize,
    ring_mask: u32,
    st: *const OtaKeyStateC,
    out_id: *mut u8,
) -> *const c_char {
    let Some(m) = Manifest::decode(bytes(manifest, len)) else { return c("bad_manifest") };
    if st.is_null() || out_id.is_null() {
        return c("error");
    }
    match keyring::select_key(&m, ring(ring_mask), &ks(&*st)) {
        Ok(id) => {
            *out_id = id;
            core::ptr::null()
        }
        Err(e) => c(e.code()),
    }
}

/// The security-version floor after installing this manifest.
///
/// # Safety
/// Pointers valid for the stated sizes.
#[no_mangle]
pub unsafe extern "C" fn ota_floor_after(st: *const OtaKeyStateC, manifest: *const u8, len: usize) -> u8 {
    let Some(m) = Manifest::decode(bytes(manifest, len)) else { return if st.is_null() { 0 } else { (*st).security_floor } };
    if st.is_null() {
        return keyring::security_version(&m);
    }
    keyring::raise_floor(&ks(&*st), &m).security_floor
}

#[repr(C)]
pub struct OtaEpochC {
    pub epoch: u32,
    pub revoked: u32,
    pub signer: u8,
    pub signed_bytes: [u8; EPOCH_SIGNED_LEN],
    pub signature: [u8; 64],
}

/// Parse a key-epoch record (80 bytes).
///
/// # Safety
/// Pointers valid for the stated sizes.
#[no_mangle]
pub unsafe extern "C" fn ota_epoch_parse(p: *const u8, len: usize, out: *mut OtaEpochC) -> bool {
    let Some(r) = EpochRecord::decode(bytes(p, len)) else { return false };
    if out.is_null() {
        return false;
    }
    *out = OtaEpochC { epoch: r.epoch, revoked: r.revoked, signer: r.signer, signed_bytes: r.signed_bytes(), signature: r.signature };
    true
}

/// Apply a parsed record whose signature by key `signer` the caller checked.
/// Null on success (`out` = the state to persist); else the refusal code.
///
/// # Safety
/// Pointers valid for the stated sizes.
#[no_mangle]
pub unsafe extern "C" fn ota_epoch_apply(
    st: *const OtaKeyStateC,
    p: *const u8,
    len: usize,
    signature_ok: bool,
    ring_mask: u32,
    out: *mut OtaKeyStateC,
) -> *const c_char {
    let Some(r) = EpochRecord::decode(bytes(p, len)) else { return c("bad_epoch") };
    if st.is_null() || out.is_null() {
        return c("error");
    }
    match keyring::apply_epoch(&ks(&*st), &r, signature_ok, ring(ring_mask)) {
        Ok(n) => {
            *out = OtaKeyStateC { epoch: n.epoch, revoked: n.revoked, security_floor: n.security_floor };
            core::ptr::null()
        }
        Err(e) => c(e.code()),
    }
}

const _: () = assert!(EPOCH_LEN == 80);
