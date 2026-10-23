//! Wi-Fi rejoin policy (docs/design/wifi-rejoin-policy.md): the protocol side.
//!
//! The policy says how the board (re)joins its stored network when it isn't on it:
//! `auto` (background rescans on a capped exponential backoff, decaying to a sparse
//! period after long absence), `fixed` (every N s), `manual` (only when told), or
//! `offline` (a forward-deployed unit: the radio stays off, the show plays, BLE and
//! the console stay up for reconfiguration; credentials are kept).
//!
//! This module owns the CONFIG: it validates and holds the policy, answers
//! set_wifi_policy / get_wifi_policy (wss and the BLE player transport) and the
//! console's "WIFI MODE …" lines, and refuses manual/offline while a freshly
//! installed firmware update is still unconfirmed (it would have no network to
//! prove itself on). The C++ firmware owns the RADIO: it polls [`lm_wifi_policy_gen`]
//! to apply + persist a change (netstack_transport executes it), reports the live
//! link state back through [`lm_wifi_report`], and flags a pending update through
//! [`lm_wifi_set_ota_pending`]. Everything runs on the loop task (the message
//! handler under the player mutex, the pollers right after), so plain statics.

use core::ptr::addr_of;

use super::{client_arm, write_arm, CArm, PbOut};

/// ServerMessage arm of the reply (wifi_policy_state = 51).
const ARM_WIFI_POLICY_STATE: u32 = 51;

pub const MODE_AUTO: u8 = 0;
pub const MODE_FIXED: u8 = 1;
pub const MODE_MANUAL: u8 = 2;
pub const MODE_OFFLINE: u8 = 3;

/// The policy as the C++ side applies it (and the NVS record encodes it).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LmWifiPolicy {
    pub mode: u8,
    /// auto: the backoff cap, s.
    pub scan_cap_s: u32,
    /// fixed: the rescan period, s.
    pub interval_s: u32,
    /// auto: hours without seeing the network before the sparse period (0 = never).
    pub decay_after_h: u32,
    /// The decayed rescan period, s.
    pub sparse_interval_s: u32,
}

/// The defaults: today's behaviour (5 s -> 60 s backoff), decaying after a day of
/// absence to one sweep every 15 min — a unit whose AP is gone for good stops
/// sweeping every minute, but still rejoins on its own when it comes back.
pub const DEFAULT_POLICY: LmWifiPolicy = LmWifiPolicy {
    mode: MODE_AUTO,
    scan_cap_s: 60,
    interval_s: 300,
    decay_after_h: 24,
    sparse_interval_s: 900,
};

/// The live link facts the C++ transport reports every loop.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct LmWifiStatus {
    /// WifiLinkState.
    pub state: u8,
    pub radio_on: bool,
    pub decayed: bool,
    pub next_scan_s: u32,
    pub scans: u32,
    pub unseen_s: u32,
    /// NUL-terminated.
    pub ssid: [u8; 33],
}

const EMPTY_STATUS: LmWifiStatus =
    LmWifiStatus { state: 0, radio_on: false, decayed: false, next_scan_s: 0, scans: 0, unseen_s: 0, ssid: [0; 33] };

static mut POLICY: LmWifiPolicy = DEFAULT_POLICY;
static mut POLICY_GEN: u32 = 0;
static mut REJOIN: bool = false;
static mut STATUS: LmWifiStatus = EMPTY_STATUS;
static mut OTA_PENDING: bool = false;
static mut REFUSED: &str = "";

/// Clamp every field into its documented range (a wild value never reaches the radio).
pub fn sanitize(p: LmWifiPolicy) -> LmWifiPolicy {
    LmWifiPolicy {
        mode: if p.mode <= MODE_OFFLINE { p.mode } else { MODE_AUTO },
        scan_cap_s: p.scan_cap_s.clamp(10, 86_400),
        interval_s: p.interval_s.clamp(10, 86_400),
        decay_after_h: p.decay_after_h.min(8_760),
        sparse_interval_s: p.sparse_interval_s.clamp(60, 86_400),
    }
}

/// A requested change: `None` keeps the current value.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Request {
    pub mode: Option<u8>,
    pub scan_cap_s: Option<u32>,
    pub interval_s: Option<u32>,
    pub decay_after_h: Option<u32>,
    pub sparse_interval_s: Option<u32>,
    pub force: bool,
}

/// Apply `req` to `cur`. Going to manual / offline while an update awaits
/// confirmation is refused (`"ota_pending"`) unless forced: the unconfirmed image
/// must reach the network to be marked valid, so the user should confirm it first.
pub fn apply(cur: LmWifiPolicy, req: &Request, ota_pending: bool) -> Result<LmWifiPolicy, &'static str> {
    let next = sanitize(LmWifiPolicy {
        mode: req.mode.unwrap_or(cur.mode),
        scan_cap_s: req.scan_cap_s.unwrap_or(cur.scan_cap_s),
        interval_s: req.interval_s.unwrap_or(cur.interval_s),
        decay_after_h: req.decay_after_h.unwrap_or(cur.decay_after_h),
        sparse_interval_s: req.sparse_interval_s.unwrap_or(cur.sparse_interval_s),
    });
    let leaving_network = matches!(next.mode, MODE_MANUAL | MODE_OFFLINE) && next.mode != cur.mode;
    if leaving_network && ota_pending && !req.force {
        return Err("ota_pending");
    }
    Ok(next)
}

/// The NVS record: version, mode, then the four u32s little-endian (18 bytes).
pub const RECORD_LEN: usize = 18;
pub fn encode(p: &LmWifiPolicy) -> [u8; RECORD_LEN] {
    let mut r = [0u8; RECORD_LEN];
    r[0] = 1;
    r[1] = p.mode;
    for (i, v) in [p.scan_cap_s, p.interval_s, p.decay_after_h, p.sparse_interval_s].iter().enumerate() {
        r[2 + 4 * i..6 + 4 * i].copy_from_slice(&v.to_le_bytes());
    }
    r
}
pub fn decode(r: &[u8]) -> Option<LmWifiPolicy> {
    if r.len() != RECORD_LEN || r[0] != 1 {
        return None;
    }
    let u = |i: usize| u32::from_le_bytes([r[2 + 4 * i], r[3 + 4 * i], r[4 + 4 * i], r[5 + 4 * i]]);
    Some(sanitize(LmWifiPolicy {
        mode: r[1],
        scan_cap_s: u(0),
        interval_s: u(1),
        decay_after_h: u(2),
        sparse_interval_s: u(3),
    }))
}

/// A parsed console command (the text after "WIFI ").
#[derive(Debug, PartialEq, Eq)]
pub enum Console {
    /// MODE <auto|fixed|manual|offline> [cap=S] [every=S] [decay=H] [sparse=S] [force]
    Set(Request),
    /// REJOIN: try now (manual: open a join window).
    Rejoin,
    /// STATUS
    Status,
    Unknown,
}

fn mode_name(m: u8) -> &'static str {
    match m {
        MODE_FIXED => "fixed",
        MODE_MANUAL => "manual",
        MODE_OFFLINE => "offline",
        _ => "auto",
    }
}

fn parse_u32(s: &[u8]) -> Option<u32> {
    if s.is_empty() || s.len() > 9 {
        return None;
    }
    let mut v: u32 = 0;
    for &c in s {
        if !c.is_ascii_digit() {
            return None;
        }
        v = v * 10 + u32::from(c - b'0');
    }
    Some(v)
}

/// Parse the text after "WIFI " (case-insensitive keywords).
pub fn parse_console(line: &[u8]) -> Console {
    let mut words = line.split(|&c| c == b' ').filter(|w| !w.is_empty());
    let Some(cmd) = words.next() else { return Console::Unknown };
    if cmd.eq_ignore_ascii_case(b"REJOIN") {
        return Console::Rejoin;
    }
    if cmd.eq_ignore_ascii_case(b"STATUS") {
        return Console::Status;
    }
    if !cmd.eq_ignore_ascii_case(b"MODE") {
        return Console::Unknown;
    }
    let mut req = Request::default();
    let Some(m) = words.next() else { return Console::Unknown };
    req.mode = [b"auto" as &[u8], b"fixed", b"manual", b"offline"]
        .iter()
        .position(|n| m.eq_ignore_ascii_case(n))
        .map(|i| i as u8);
    if req.mode.is_none() {
        return Console::Unknown;
    }
    for w in words {
        if w.eq_ignore_ascii_case(b"force") {
            req.force = true;
            continue;
        }
        let Some(eq) = w.iter().position(|&c| c == b'=') else { return Console::Unknown };
        let (k, v) = (&w[..eq], parse_u32(&w[eq + 1..]));
        let Some(v) = v else { return Console::Unknown };
        if k.eq_ignore_ascii_case(b"cap") {
            req.scan_cap_s = Some(v);
        } else if k.eq_ignore_ascii_case(b"every") {
            req.interval_s = Some(v);
        } else if k.eq_ignore_ascii_case(b"decay") {
            req.decay_after_h = Some(v);
        } else if k.eq_ignore_ascii_case(b"sparse") {
            req.sparse_interval_s = Some(v);
        } else {
            return Console::Unknown;
        }
    }
    Console::Set(req)
}

/// Commit a request to the live policy (bumping the generation the C++ side polls).
unsafe fn request(req: &Request) {
    match apply(*addr_of!(POLICY), req, OTA_PENDING) {
        Ok(p) => {
            REFUSED = "";
            if p != *addr_of!(POLICY) {
                POLICY = p;
                POLICY_GEN = POLICY_GEN.wrapping_add(1);
            }
        }
        Err(why) => REFUSED = why,
    }
}

fn write_state(w: &mut PbOut, p: &LmWifiPolicy, s: &LmWifiStatus, ota: bool, refused: &str) {
    let nz = |w: &mut PbOut, f: u32, v: u64| {
        if v != 0 {
            w.uint(f, v)
        }
    };
    nz(w, 1, p.mode as u64);
    nz(w, 2, p.scan_cap_s as u64);
    nz(w, 3, p.interval_s as u64);
    nz(w, 4, p.decay_after_h as u64);
    nz(w, 5, p.sparse_interval_s as u64);
    nz(w, 6, s.state as u64);
    nz(w, 7, s.next_scan_s as u64);
    nz(w, 8, s.scans as u64);
    let n = s.ssid.iter().position(|&c| c == 0).unwrap_or(s.ssid.len());
    if n > 0 {
        w.bytes(9, &s.ssid[..n]);
    }
    nz(w, 10, s.unseen_s as u64);
    nz(w, 11, s.decayed as u64);
    nz(w, 12, ota as u64);
    if !refused.is_empty() {
        w.bytes(13, refused.as_bytes());
    }
    nz(w, 14, s.radio_on as u64);
}

pub(crate) unsafe fn handle_get_wifi_policy(out: *mut u8, out_cap: usize) -> i32 {
    let (p, s, ota, refused) = (*addr_of!(POLICY), *addr_of!(STATUS), OTA_PENDING, REFUSED);
    write_arm(out, out_cap, ARM_WIFI_POLICY_STATE, |w| write_state(w, &p, &s, ota, refused))
}

pub(crate) unsafe fn handle_set_wifi_policy(frame: &[u8], out: *mut u8, out_cap: usize) -> i32 {
    if let Some(CArm::SetWifiPolicy(m)) = client_arm(frame) {
        let req = Request {
            mode: m.mode().map(|v| v as u8),
            scan_cap_s: m.scan_cap_s(),
            interval_s: m.interval_s(),
            decay_after_h: m.decay_after_h(),
            sparse_interval_s: m.sparse_interval_s(),
            force: m.force(),
        };
        request(&req);
        if m.rejoin_now() {
            REJOIN = true;
        }
    }
    let n = handle_get_wifi_policy(out, out_cap);
    REFUSED = "";
    n
}

/// Boot: the policy persisted in NVS (`rec`/`len` = the [`encode`] record; anything
/// else keeps the defaults). Writes the applied policy to `out` (may be null).
///
/// # Safety
/// `rec` valid for `len` (or null); `out` writable (or null).
#[no_mangle]
pub unsafe extern "C" fn lm_wifi_policy_seed(rec: *const u8, len: usize, out: *mut LmWifiPolicy) {
    if !rec.is_null() {
        if let Some(p) = decode(core::slice::from_raw_parts(rec, len)) {
            POLICY = p;
        }
    }
    if !out.is_null() {
        *out = *addr_of!(POLICY);
    }
}

/// The policy generation: bumped by every applied change. The firmware re-applies +
/// persists when it differs from the last one it saw.
///
/// # Safety
/// Loop task (single-threaded with the message handler).
#[no_mangle]
pub unsafe extern "C" fn lm_wifi_policy_gen() -> u32 {
    POLICY_GEN
}

/// The live policy, and its NVS record into `rec` (RECORD_LEN bytes; may be null).
///
/// # Safety
/// `out` writable; `rec` writable for RECORD_LEN bytes or null.
#[no_mangle]
pub unsafe extern "C" fn lm_wifi_policy_get(out: *mut LmWifiPolicy, rec: *mut u8) -> usize {
    if !out.is_null() {
        *out = *addr_of!(POLICY);
    }
    if !rec.is_null() {
        core::ptr::copy_nonoverlapping(encode(&*addr_of!(POLICY)).as_ptr(), rec, RECORD_LEN);
    }
    RECORD_LEN
}

/// The transport changed the mode itself (a new provision while offline/manual:
/// provisioning is the intent to join) — adopt it without a refusal check.
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_wifi_policy_adopt(p: *const LmWifiPolicy) {
    if p.is_null() {
        return;
    }
    let p = sanitize(*p);
    if p != *addr_of!(POLICY) {
        POLICY = p;
        POLICY_GEN = POLICY_GEN.wrapping_add(1);
    }
}

/// Read + clear a rejoin request (rejoin_now / console WIFI REJOIN).
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_wifi_take_rejoin() -> bool {
    let r = REJOIN;
    REJOIN = false;
    r
}

/// The transport's live link state (every loop).
///
/// # Safety
/// `s` readable.
#[no_mangle]
pub unsafe extern "C" fn lm_wifi_report(s: *const LmWifiStatus) {
    if !s.is_null() {
        STATUS = *s;
        STATUS.ssid[32] = 0;
    }
}

/// Whether a freshly installed firmware update awaits confirmation (ota_app).
///
/// # Safety
/// Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_wifi_set_ota_pending(pending: bool) {
    OTA_PENDING = pending;
}

/// One console line after "WIFI " (MODE / REJOIN / STATUS). Writes a one-line human
/// reply into `out` (NUL-terminated, truncated to `cap`) and returns its length, or
/// -1 for an unrecognised line.
///
/// # Safety
/// `line` readable for `len`; `out` writable for `cap` (cap >= 1).
#[no_mangle]
pub unsafe extern "C" fn lm_wifi_console(line: *const u8, len: usize, out: *mut u8, cap: usize) -> i32 {
    if line.is_null() || out.is_null() || cap == 0 {
        return -1;
    }
    let refused;
    match parse_console(core::slice::from_raw_parts(line, len)) {
        Console::Set(req) => {
            request(&req);
            refused = REFUSED;
            REFUSED = "";
        }
        Console::Rejoin => {
            REJOIN = true;
            refused = "";
        }
        Console::Status => refused = "",
        Console::Unknown => return -1,
    }
    let o = core::slice::from_raw_parts_mut(out, cap);
    let mut w = TextOut { buf: o, n: 0 };
    let p = *addr_of!(POLICY);
    let s = *addr_of!(STATUS);
    w.s("[wifi] mode=");
    w.s(mode_name(p.mode));
    w.s(" cap=");
    w.u(p.scan_cap_s);
    w.s("s every=");
    w.u(p.interval_s);
    w.s("s decay=");
    w.u(p.decay_after_h);
    w.s("h sparse=");
    w.u(p.sparse_interval_s);
    w.s("s state=");
    w.u(s.state as u32);
    w.s(" next_scan=");
    w.u(s.next_scan_s);
    w.s("s");
    if OTA_PENDING {
        w.s(" ota_pending");
    }
    if !refused.is_empty() {
        w.s(" REFUSED: an update awaits confirmation (stay online until it is marked valid, or add 'force')");
    }
    let n = w.n.min(cap - 1);
    o[n] = 0;
    n as i32
}

struct TextOut<'a> {
    buf: &'a mut [u8],
    n: usize,
}
impl TextOut<'_> {
    fn s(&mut self, t: &str) {
        for &b in t.as_bytes() {
            if self.n + 1 < self.buf.len() {
                self.buf[self.n] = b;
            }
            self.n += 1;
        }
    }
    fn u(&mut self, mut v: u32) {
        let mut d = [0u8; 10];
        let mut i = d.len();
        loop {
            i -= 1;
            d[i] = b'0' + (v % 10) as u8;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        for &b in &d[i..] {
            if self.n + 1 < self.buf.len() {
                self.buf[self.n] = b;
            }
            self.n += 1;
        }
    }
}
