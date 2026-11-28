//! Network time on the player (docs/design/wall-clock.md "Network time", D-561): the
//! `//firmware/sntp` client behind the C ABI the netstack transport drives, its owner
//! config (set_clock_config, persisted in NVS "clk_ntp") and its part of clock_state.
//!
//! - **Who calls what.** netstack_transport.cpp, on the loop task: [`lm_sntp_net`] at
//!   each DHCP ACK (options 1, 3, 6, 42), [`lm_sntp_net_down`] on a link loss,
//!   [`lm_sntp_poll`] every pass (each datagram it returns goes out as UDP),
//!   [`lm_sntp_rx`] for UDP to [`lm_sntp_port`], [`lm_sntp_note_frame`] with every
//!   reaped frame's RX-vector stamp while [`lm_sntp_stamping`]. Nothing here blocks:
//!   a round is two or three small datagrams.
//! - **Into the clock.** A good round leaves one pending sample; `lm_clock_tick`
//!   (main.cpp's poll_clock, under the player mutex) offers it as `Source::Sntp`. A
//!   sample taken across an esp_timer step-back (the guard's jump count moved) is
//!   dropped, not offered.
//! - **Mesh-only members** never get a lease, so the client stays in NoNetwork: they
//!   take wall time from the mesh (PR-8), not from SNTP.
//! - The P4 (Ethernet, IDF lwIP) uses esp_sntp instead (main.cpp); it offers through
//!   [`lm_clock_offer_sntp`] and shares the config.

use core::ptr::addr_of_mut;

use ledmapper_bss::BssOption;

use ledmapper_sntp::client::{fmt_ip, Name};
use ledmapper_sntp::{Client, Config, Fail, Network, Outcome, Phase, Sample};

/// The persisted config record: [version][flags][len][server][len][server].
pub const CONFIG_RECORD_MAX: usize = 2 + 2 * (1 + 64);
const CONFIG_VERSION: u8 = 1;

/// The client, built on first use: its initial state isn't all-zero, so a plain static
/// would sit in .data (flash + RAM, data_bss_test).
static mut CLIENT: BssOption<Client> = BssOption::NONE;
const SEED: u32 = 0x5eed_1e55;
/// A good round not yet offered to the clock, and the guard's jump count when it was
/// measured.
static mut PENDING: Option<(Sample, u32)> = None;
/// The last offer's ClockSetResult (clock_ffi SET_*).
static mut LAST_OFFER: u8 = 0;
static mut LAST_RESULT: u8 = 0;
/// Bumped on every owner change: main.cpp persists the record when it moves.
static mut CFG_GEN: u32 = 0;
/// A round finished since the last [`lm_sntp_take_round`]: log it.
static mut ROUND_DONE: bool = false;

unsafe fn client() -> &'static mut Client {
    let c = &mut *addr_of_mut!(CLIENT);
    if c.is_none() {
        c.set(Client::new(SEED));
    }
    match c.as_mut() {
        Some(c) => c,
        None => unreachable!(),
    }
}

/// The owner's config.
pub(crate) unsafe fn config() -> Config {
    *client().config()
}

/// Applies an owner change (set_clock_config); `now_us` mono.
pub(crate) unsafe fn set_config(cfg: Config, now_us: i64) {
    if cfg != *client().config() {
        client().set_config(cfg, now_us);
        CFG_GEN = CFG_GEN.wrapping_add(1);
    }
}

pub(crate) unsafe fn cfg_gen() -> u32 {
    CFG_GEN
}

/// Run a round now.
pub(crate) unsafe fn sync_now(now_us: i64) {
    client().poll_now(now_us);
}

/// Takes the pending sample (clock_ffi, under the player mutex).
pub(crate) unsafe fn take_pending() -> Option<(Sample, u32)> {
    (*addr_of_mut!(PENDING)).take()
}

/// Records what the clock did with the last sample (clock_ffi SET_*).
pub(crate) unsafe fn note_offer(result: u8) {
    LAST_OFFER = result;
}

fn result_code(o: &Outcome) -> u8 {
    match o {
        Outcome::Synced(_) => 1,
        Outcome::Failed(f) => f.code(),
    }
}

unsafe fn ip_at(p: *const u8) -> [u8; 4] {
    let mut ip = [0u8; 4];
    ip.copy_from_slice(core::slice::from_raw_parts(p, 4));
    ip
}

// -- the netstack side ---------------------------------------------------------------

/// Entropy for cookies, DNS ids, ports and jitter (esp_fill_random at boot).
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_seed(seed: u32) {
    client().reseed(seed);
}

/// A DHCP lease: our address and mask, the router (null = none), up to 2 DNS and 2 NTP
/// servers (4 bytes each, network order). Same options as before: nothing changes.
///
/// # Safety
/// `ip`/`mask` 4 bytes; `router` 4 bytes or null; `dns` `4 * n_dns`, `ntp` `4 * n_ntp`
/// bytes (or null with 0). Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_net(
    ip: *const u8,
    mask: *const u8,
    router: *const u8,
    dns: *const u8,
    n_dns: usize,
    ntp: *const u8,
    n_ntp: usize,
    now_us: i64,
) {
    let mut net = Network {
        ip: ip_at(ip),
        mask: ip_at(mask),
        router: (!router.is_null()).then(|| ip_at(router)),
        ..Network::default()
    };
    for i in 0..n_dns.min(2) {
        net.dns[i] = Some(ip_at(dns.add(4 * i)));
    }
    for i in 0..n_ntp.min(2) {
        net.ntp[i] = Some(ip_at(ntp.add(4 * i)));
    }
    client().set_network(net, now_us);
}

/// The link or the lease is gone.
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_net_down() {
    client().clear_network();
}

/// The next datagram to send (call until it returns 0): its payload in `out`, the
/// destination address in `dst` (4 bytes), the ports in `dport` / `sport`.
///
/// # Safety
/// `out` writable for `cap` (≥ 96) bytes, `dst` for 4, the ports for one u16. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_poll(
    now_us: i64,
    out: *mut u8,
    cap: usize,
    dst: *mut u8,
    dport: *mut u16,
    sport: *mut u16,
) -> usize {
    let buf = core::slice::from_raw_parts_mut(out, cap);
    let r = client().poll(now_us, buf);
    note_round();
    match r {
        Some(tx) => {
            core::ptr::copy_nonoverlapping(tx.dst.as_ptr(), dst, 4);
            *dport = tx.dport;
            *sport = tx.sport;
            tx.len
        }
        None => 0,
    }
}

/// Our UDP port while a round runs (0 = none: drop nothing).
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_port() -> u16 {
    client().local_port()
}

/// Whether to feed [`lm_sntp_note_frame`] (an NTP request is out).
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_stamping() -> bool {
    client().wants_stamps()
}

/// A reaped frame's RX-vector timestamp (`reap_us` mono).
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_note_frame(reap_us: i64, hw_us: u32) {
    client().note_frame(reap_us, hw_us);
}

/// A UDP datagram for [`lm_sntp_port`]: from `src:sport`, reaped at mono `reap_us`
/// with RX stamp `hw_us` when `has_hw`. Returns whether it was ours.
///
/// # Safety
/// `src` 4 bytes, `data` `len` bytes. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_rx(
    reap_us: i64,
    hw_us: u32,
    has_hw: bool,
    src: *const u8,
    sport: u16,
    dport: u16,
    data: *const u8,
    len: usize,
) -> bool {
    let d = core::slice::from_raw_parts(data, len);
    let ours = client().on_udp(
        reap_us,
        has_hw.then_some(hw_us),
        ip_at(src),
        sport,
        dport,
        d,
    );
    note_round();
    ours
}

unsafe fn note_round() {
    if let Some(o) = client().take_outcome() {
        LAST_RESULT = result_code(&o);
        ROUND_DONE = true;
        if let Outcome::Synced(s) = o {
            PENDING = Some((s, super::clock_ffi::jumps()));
        }
    }
}

/// A round finished since the last call (log [`lm_sntp_status_line`]).
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_take_round() -> bool {
    core::mem::replace(&mut *addr_of_mut!(ROUND_DONE), false)
}

/// Small no_std formatter into a byte buffer.
struct Line<'a> {
    buf: &'a mut [u8],
    n: usize,
}

impl core::fmt::Write for Line<'_> {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        for &b in s.as_bytes() {
            if self.n + 1 < self.buf.len() {
                self.buf[self.n] = b;
                self.n += 1;
            }
        }
        Ok(())
    }
}

struct Dotted([u8; 4]);

impl core::fmt::Display for Dotted {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let mut b = [0u8; 15];
        let n = fmt_ip(&mut b, self.0);
        f.write_str(core::str::from_utf8(&b[..n]).unwrap_or("?"))
    }
}

fn phase_tag(p: Phase) -> &'static str {
    match p {
        Phase::Off => "off",
        Phase::NoNetwork => "no_network",
        Phase::Idle => "idle",
        Phase::Resolving => "resolving",
        Phase::Querying => "querying",
    }
}

fn result_tag(code: u8) -> &'static str {
    match code {
        0 => "none",
        1 => "synced",
        2 => Fail::NoServers.tag(),
        3 => Fail::DnsTimeout.tag(),
        4 => Fail::Dns(0).tag(),
        5 => Fail::Timeout.tag(),
        6 => Fail::Kod([0; 4]).tag(),
        7 => Fail::Unsynchronised.tag(),
        8 => Fail::Bad.tag(),
        9 => Fail::Disagree.tag(),
        _ => Fail::Unconfirmed.tag(),
    }
}

/// The `[sntp]` status line (NUL-terminated) into `out`; returns its length.
/// `[sntp] state=idle result=synced server=162.159.200.1 rtt_ms=18 err_ms=12 offer=1
/// rounds=3 ok=2 fails=1 next_s=128 interval_s=128 dhcp_ntp=0 dns=10.42.0.1 kod=0
/// disagree=0`.
///
/// # Safety
/// `out` writable for `cap` bytes. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_status_line(now_us: i64, out: *mut u8, cap: usize) -> usize {
    use core::fmt::Write;
    if out.is_null() || cap == 0 {
        return 0;
    }
    let c = &*client();
    let st = &c.stats;
    let mut l = Line {
        buf: core::slice::from_raw_parts_mut(out, cap),
        n: 0,
    };
    let _ = write!(
        l,
        "[sntp] state={} result={}",
        phase_tag(c.phase()),
        result_tag(LAST_RESULT)
    );
    if let Some(Fail::Kod(code)) = st.last_fail {
        if LAST_RESULT == 6 {
            let _ = write!(l, "/{}", core::str::from_utf8(&code).unwrap_or("?"));
        }
    }
    if let Some(Fail::Dns(rc)) = st.last_fail {
        if LAST_RESULT == 4 {
            let _ = write!(l, "/rcode{}", rc);
        }
    }
    if st.synced > 0 {
        let _ = write!(
            l,
            " server={} rtt_ms={} offer={}",
            Dotted(st.last_server),
            st.last_delay_us / 1000,
            LAST_OFFER
        );
    }
    let _ = write!(
        l,
        " rounds={} ok={} fails={} kod={} disagree={} interval_s={}",
        st.rounds,
        st.synced,
        st.failed,
        st.kod,
        st.disagree,
        c.interval_s()
    );
    if let Some(n) = c.next_in_s(now_us) {
        let _ = write!(l, " next_s={}", n);
    }
    let cfg = c.config();
    let _ = write!(
        l,
        " enabled={} use_dhcp={}",
        cfg.enabled as u8, cfg.use_dhcp as u8
    );
    for s in cfg.servers.iter().filter(|s| !s.is_empty()) {
        let _ = write!(
            l,
            " override={}",
            core::str::from_utf8(s.as_bytes()).unwrap_or("?")
        );
    }
    if let Some(net) = c.network() {
        for ip in net.ntp.iter().flatten() {
            let _ = write!(l, " dhcp_ntp={}", Dotted(*ip));
        }
        for ip in net.dns.iter().flatten() {
            let _ = write!(l, " dns={}", Dotted(*ip));
        }
        if let Some(r) = net.router {
            let _ = write!(l, " router={}", Dotted(r));
        }
    }
    let n = l.n;
    l.buf[n] = 0;
    n
}

/// Console `CLOCK SNTP NOW`: run a round now.
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_poll_now(now_us: i64) {
    client().poll_now(now_us);
}

// -- clock_state.ntp -------------------------------------------------------------------

/// ClockState.ntp (field 17), written into `w` (clock_ffi::write_state).
pub(crate) unsafe fn write_ntp(w: &mut super::PbOut, now_us: i64) {
    let c = &*client();
    let body = |w: &mut super::PbOut| {
        let cfg = c.config();
        let st = &c.stats;
        if cfg.enabled {
            w.uint(1, 1);
        }
        if cfg.use_dhcp {
            w.uint(2, 1);
        }
        for s in cfg.servers.iter().filter(|s| !s.is_empty()) {
            w.bytes(3, s.as_bytes());
        }
        if let Some(net) = c.network() {
            for ip in net.ntp.iter().flatten() {
                let mut b = [0u8; 15];
                let n = fmt_ip(&mut b, *ip);
                w.bytes(4, &b[..n]);
            }
            w.uint(5, 1);
        }
        if st.synced > 0 {
            let mut b = [0u8; 15];
            let n = fmt_ip(&mut b, st.last_server);
            w.bytes(6, &b[..n]);
            w.uint(
                7,
                (st.last_delay_us / 1000).clamp(0, u32::MAX as i64) as u64,
            );
            if let Some(at) = st.last_sync_mono_us {
                w.uint(8, ((now_us - at).max(0) / 1_000_000) as u64);
            }
        }
        if LAST_RESULT != 0 {
            w.uint(9, LAST_RESULT as u64);
        }
        if st.rounds != 0 {
            w.uint(10, st.rounds as u64);
        }
        if st.failed != 0 {
            w.uint(11, st.failed as u64);
        }
        if let Some(n) = c.next_in_s(now_us) {
            w.uint(12, n as u64);
        }
        if c.interval_s() != 0 {
            w.uint(13, c.interval_s() as u64);
        }
        if LAST_OFFER != 0 {
            w.uint(14, LAST_OFFER as u64);
        }
    };
    // A sub-message: count, then write.
    let mut count = super::PbOut {
        buf: None,
        n: 0,
        ok: true,
    };
    body(&mut count);
    w.key(17, 2);
    w.varint(count.n as u64);
    body(w);
}

/// The owner's settings for the P4's esp_sntp: `enabled`, `use_dhcp` and override
/// server `k` (NUL-terminated into `out`, "" = none). Returns the config generation.
///
/// # Safety
/// `enabled`/`use_dhcp` writable; `out` writable for `cap` bytes. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_config_get(
    enabled: *mut bool,
    use_dhcp: *mut bool,
    k: u32,
    out: *mut u8,
    cap: usize,
) -> u32 {
    let cfg = config();
    *enabled = cfg.enabled;
    *use_dhcp = cfg.use_dhcp;
    if !out.is_null() && cap > 0 {
        let s = cfg
            .servers
            .get(k as usize)
            .map_or(&[][..], |n| n.as_bytes());
        let n = s.len().min(cap - 1);
        core::ptr::copy_nonoverlapping(s.as_ptr(), out, n);
        *out.add(n) = 0;
    }
    CFG_GEN
}

// -- persistence -----------------------------------------------------------------------

/// The config record to persist (NVS "clk_ntp"). Returns its length.
///
/// # Safety
/// `out` writable for [`CONFIG_RECORD_MAX`] bytes. Loop task.
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_config_record(out: *mut u8) -> usize {
    let o = core::slice::from_raw_parts_mut(out, CONFIG_RECORD_MAX);
    let cfg = config();
    o[0] = CONFIG_VERSION;
    o[1] = cfg.enabled as u8 | (cfg.use_dhcp as u8) << 1;
    let mut n = 2;
    for s in &cfg.servers {
        let b = s.as_bytes();
        o[n] = b.len() as u8;
        o[n + 1..n + 1 + b.len()].copy_from_slice(b);
        n += 1 + b.len();
    }
    n
}

/// Boot: restore the config record (from NVS; null = none, the defaults). Returns
/// whether it was valid.
///
/// # Safety
/// `rec` readable for `len` bytes (or null). Loop task (setup), before the netstack.
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_boot(rec: *const u8, len: usize) -> bool {
    if rec.is_null() || len < 2 {
        return false;
    }
    let r = core::slice::from_raw_parts(rec, len);
    if r[0] != CONFIG_VERSION {
        return false;
    }
    let mut cfg = Config {
        enabled: r[1] & 1 != 0,
        use_dhcp: r[1] & 2 != 0,
        servers: [Name::EMPTY; 2],
    };
    let mut i = 2;
    for s in cfg.servers.iter_mut() {
        let Some(&l) = r.get(i) else { break };
        let Some(b) = r.get(i + 1..i + 1 + l as usize) else {
            return false;
        };
        let Some(name) = Name::new(b) else {
            return false;
        };
        *s = name;
        i += 1 + l as usize;
    }
    // Restored, not changed: nothing to persist.
    client().set_config(cfg, 0);
    true
}

// -- host tests --------------------------------------------------------------------------

/// Host tests: back to the power-on state.
///
/// # Safety
/// Test thread only.
#[cfg(not(target_os = "none"))]
#[no_mangle]
pub unsafe extern "C" fn lm_sntp_test_reset() {
    (*addr_of_mut!(CLIENT)).set(Client::new(SEED));
    PENDING = None;
    LAST_OFFER = 0;
    LAST_RESULT = 0;
    ROUND_DONE = false;
}
