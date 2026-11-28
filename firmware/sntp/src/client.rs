//! The SNTP client state machine (D-561).
//!
//! **Servers.** The owner's override (up to two names or addresses) when set;
//! otherwise the NTP servers the DHCP lease offered (option 42, when
//! `use_dhcp`), topped up with `pool.ntp.org` (resolved through the lease's DNS
//! servers, option 6, else the router). A round asks up to **two** servers.
//!
//! **Cross-check.** With two answers the time is taken only when they agree
//! (their offsets within the sum of their error bounds plus
//! [`AGREE_SLACK_US`]); the more certain one is offered. A lone answer is taken
//! when the round only had one server, or when it is consistent with the last
//! accepted sample; otherwise the round fails as unconfirmed (one LAN spoofer
//! can't move the clock on its own).
//!
//! **Backoff.** After a good round: 64 s, then doubling up to 1 h. After a
//! failed round: 15 s, doubling up to 5 min (a kiss-o'-death waits 5 min). A
//! random 0..1/8 of the interval is added so a room of lamps doesn't poll in
//! lockstep.
//!
//! The caller drives it on one task: [`Client::poll`] until it returns `None`
//! (each `Some` is a datagram to send), [`Client::on_udp`] for every datagram
//! to [`Client::local_port`], [`Client::take_outcome`] after both.

use crate::dns;
use crate::ntp::{self, Exchange, ReplyError};
use crate::stamp::RxFloor;
use crate::Ip;

/// Longest stored server name, bytes.
pub const NAME_CAP: usize = dns::NAME_MAX;
/// The public pool, when no override is set and the lease offers fewer than
/// two NTP servers.
pub const DEFAULT_SERVER: &[u8] = b"pool.ntp.org";

const SEC: i64 = 1_000_000;
/// The first round after a lease (or a config change) waits this long, µs.
pub const FIRST_DELAY_US: i64 = 2 * SEC;
/// A DNS query is retried (on the next resolver) after this, µs.
pub const DNS_TIMEOUT_US: i64 = 1_500_000;
/// DNS attempts per name.
pub const DNS_TRIES: u8 = 3;
/// NTP replies are waited for this long after the last request, µs.
pub const NTP_TIMEOUT_US: i64 = 2 * SEC;
/// A reply whose round trip exceeds this is refused, µs.
pub const MAX_DELAY_US: i64 = 1_500_000;
/// Two servers agree when their offsets differ by at most their error bounds
/// plus this, µs.
pub const AGREE_SLACK_US: i64 = 50_000;
/// A lone answer is consistent with the last sample within this plus
/// [`CONSISTENT_PPM`] of the time since, µs.
pub const CONSISTENT_US: i64 = SEC;
pub const CONSISTENT_PPM: i64 = 500;
/// Backoff while synced: the first interval and the cap, s.
pub const SYNCED_FIRST_S: u32 = 64;
pub const SYNCED_MAX_S: u32 = 3600;
/// Backoff while failing: the first retry and the cap, s.
pub const FAIL_FIRST_S: u32 = 15;
pub const FAIL_MAX_S: u32 = 300;
/// The wait after a kiss-o'-death, s.
pub const KOD_WAIT_S: u32 = 300;

/// A server name (host name or dotted quad), ≤ [`NAME_CAP`] bytes.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Name {
    buf: [u8; NAME_CAP],
    len: u8,
}

impl core::fmt::Debug for Name {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        write!(
            f,
            "{:?}",
            core::str::from_utf8(self.as_bytes()).unwrap_or("?")
        )
    }
}

impl Name {
    pub const EMPTY: Name = Name {
        buf: [0; NAME_CAP],
        len: 0,
    };

    /// A valid host name or IPv4 literal; `None` otherwise. Empty is
    /// [`Name::EMPTY`].
    pub fn new(s: &[u8]) -> Option<Name> {
        if s.is_empty() {
            return Some(Name::EMPTY);
        }
        if s.len() > NAME_CAP || (dns::parse_ipv4(s).is_none() && !dns::valid_name(s)) {
            return None;
        }
        let mut n = Name::EMPTY;
        n.buf[..s.len()].copy_from_slice(s);
        n.len = s.len() as u8;
        Some(n)
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.buf[..self.len as usize]
    }

    pub fn is_empty(&self) -> bool {
        self.len == 0
    }

    /// The address, when the name is a dotted quad.
    pub fn ipv4(&self) -> Option<Ip> {
        dns::parse_ipv4(self.as_bytes())
    }
}

/// What the owner set (set_clock_config.ntp_*).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Config {
    /// SNTP runs at all.
    pub enabled: bool,
    /// Use the lease's NTP servers (option 42) when there is no override.
    pub use_dhcp: bool,
    /// The override: empty = none (DHCP, then the pool).
    pub servers: [Name; 2],
}

impl Config {
    pub const DEFAULT: Config = Config {
        enabled: true,
        use_dhcp: true,
        servers: [Name::EMPTY; 2],
    };

    pub fn has_override(&self) -> bool {
        self.servers.iter().any(|s| !s.is_empty())
    }
}

impl Default for Config {
    fn default() -> Self {
        Config::DEFAULT
    }
}

/// The lease (DHCP options 1, 3, 6, 42).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Network {
    pub ip: Ip,
    pub mask: Ip,
    pub router: Option<Ip>,
    pub dns: [Option<Ip>; 2],
    pub ntp: [Option<Ip>; 2],
}

/// Where the client is.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Phase {
    /// Disabled by the owner.
    Off = 0,
    /// No lease (or a mesh-only member: nothing to ask).
    NoNetwork = 1,
    /// Waiting for the next round.
    Idle = 2,
    /// Resolving server names.
    Resolving = 3,
    /// Requests out, waiting for replies.
    Querying = 4,
}

/// Why a round failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fail {
    /// No server to ask (no override, nothing from DHCP, no resolver).
    NoServers,
    /// No resolver answered.
    DnsTimeout,
    /// The resolver answered with this RCODE, or with no A record (0).
    Dns(u8),
    /// No server replied in time.
    Timeout,
    /// Kiss-o'-death with this code (`RATE`, `DENY`, `RSTR`, …).
    Kod([u8; 4]),
    /// The server says its clock is not synchronised (LI 3, stratum ≥ 16).
    Unsynchronised,
    /// A malformed reply or an implausible round trip.
    Bad,
    /// Two servers disagreed.
    Disagree,
    /// One of two servers answered and nothing confirms it.
    Unconfirmed,
}

impl Fail {
    /// A short tag for logs and the wire.
    pub fn tag(&self) -> &'static str {
        match self {
            Fail::NoServers => "no_servers",
            Fail::DnsTimeout => "dns_timeout",
            Fail::Dns(_) => "dns_error",
            Fail::Timeout => "timeout",
            Fail::Kod(_) => "kod",
            Fail::Unsynchronised => "unsynchronised",
            Fail::Bad => "bad_reply",
            Fail::Disagree => "disagree",
            Fail::Unconfirmed => "unconfirmed",
        }
    }

    /// The wire value (ClockNtpResult).
    pub fn code(&self) -> u8 {
        match self {
            Fail::NoServers => 2,
            Fail::DnsTimeout => 3,
            Fail::Dns(_) => 4,
            Fail::Timeout => 5,
            Fail::Kod(_) => 6,
            Fail::Unsynchronised => 7,
            Fail::Bad => 8,
            Fail::Disagree => 9,
            Fail::Unconfirmed => 10,
        }
    }
}

/// A good round: "UTC was `unix_us` (± `err_us`) at mono `at_mono_us`".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Sample {
    pub unix_us: i64,
    pub at_mono_us: i64,
    pub err_us: i64,
    /// The network round trip, µs.
    pub delay_us: i64,
    pub server: Ip,
    pub stratum: u8,
    /// Two servers agreed.
    pub confirmed: bool,
}

/// A round's result.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Outcome {
    Synced(Sample),
    Failed(Fail),
}

/// A datagram to send: `len` bytes written to the poll buffer, from our port
/// `sport` to `dst:dport`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Tx {
    pub dst: Ip,
    pub dport: u16,
    pub sport: u16,
    pub len: usize,
}

/// Counters since boot.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub rounds: u32,
    pub synced: u32,
    pub failed: u32,
    pub dns_queries: u32,
    pub ntp_requests: u32,
    pub kod: u32,
    pub disagree: u32,
    /// Failed rounds in a row.
    pub fails_in_row: u32,
    pub last_fail: Option<Fail>,
    /// The last good round: its server, round trip and when (mono µs).
    pub last_server: Ip,
    pub last_delay_us: i64,
    pub last_sync_mono_us: Option<i64>,
    /// Replies refused before the round ended (wrong origin, malformed).
    pub stray: u32,
}

const MAX_TARGETS: usize = 2;

#[derive(Clone, Copy, Debug)]
struct Target {
    ip: Ip,
    cookie: u64,
    t1: i64,
    sent: bool,
    result: Option<Result<(Exchange, u8, i64), Fail>>,
}

#[derive(Clone, Copy, Debug)]
struct Pending {
    name: Name,
    want: u8,
}

/// The client. ~400 bytes, all static.
pub struct Client {
    cfg: Config,
    net: Option<Network>,
    phase: Phase,
    next_at: i64,
    names: [Option<Pending>; MAX_TARGETS],
    name_i: usize,
    dns_id: u16,
    dns_sent_at: i64,
    dns_tries: u8,
    dns_out: bool,
    dns_fail: Option<Fail>,
    targets: [Option<Target>; MAX_TARGETS],
    deadline: i64,
    sport: u16,
    floor: RxFloor,
    /// The synced backoff interval, s (0: no good round on this network yet).
    interval_s: u32,
    /// The last accepted sample: (UTC − mono, at mono).
    last_offset: Option<(i64, i64)>,
    outcome: Option<Outcome>,
    rng: u32,
    pub stats: Stats,
}

impl Client {
    /// A client with the default config and no network. `seed`: any nonzero
    /// random word (cookies, DNS ids, ports, jitter).
    pub const fn new(seed: u32) -> Client {
        Client {
            cfg: Config::DEFAULT,
            net: None,
            phase: Phase::NoNetwork,
            next_at: 0,
            names: [None; MAX_TARGETS],
            name_i: 0,
            dns_id: 0,
            dns_sent_at: 0,
            dns_tries: 0,
            dns_out: false,
            dns_fail: None,
            targets: [None; MAX_TARGETS],
            deadline: 0,
            sport: 0,
            floor: RxFloor::new(),
            interval_s: 0,
            last_offset: None,
            outcome: None,
            rng: if seed == 0 { 0x9e37_79b9 } else { seed },
            stats: Stats {
                rounds: 0,
                synced: 0,
                failed: 0,
                dns_queries: 0,
                ntp_requests: 0,
                kod: 0,
                disagree: 0,
                fails_in_row: 0,
                last_fail: None,
                last_server: [0; 4],
                last_delay_us: 0,
                last_sync_mono_us: None,
                stray: 0,
            },
        }
    }

    /// Mixes fresh entropy into the generator.
    pub fn reseed(&mut self, seed: u32) {
        self.rng ^= seed;
        if self.rng == 0 {
            self.rng = 0x9e37_79b9;
        }
    }

    fn rand(&mut self) -> u32 {
        let mut x = self.rng;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.rng = x;
        x
    }

    pub fn config(&self) -> &Config {
        &self.cfg
    }

    pub fn network(&self) -> Option<&Network> {
        self.net.as_ref()
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    /// Our UDP port for the current round (0 when none is running).
    pub fn local_port(&self) -> u16 {
        match self.phase {
            Phase::Resolving | Phase::Querying => self.sport,
            _ => 0,
        }
    }

    /// Whether a request is out: feed [`Client::note_frame`] every reaped
    /// frame's RX stamp until it isn't.
    pub fn wants_stamps(&self) -> bool {
        self.phase == Phase::Querying
    }

    /// The current synced interval, s (0 before the first good round).
    pub fn interval_s(&self) -> u32 {
        self.interval_s
    }

    /// Seconds until the next round (0 when one is running or due; `None` when
    /// off or without a network).
    pub fn next_in_s(&self, now: i64) -> Option<u32> {
        match self.phase {
            Phase::Off | Phase::NoNetwork => None,
            Phase::Idle => Some(((self.next_at - now).max(0) / SEC) as u32),
            _ => Some(0),
        }
    }

    fn idle_phase(&self) -> Phase {
        if !self.cfg.enabled {
            Phase::Off
        } else if self.net.is_none() {
            Phase::NoNetwork
        } else {
            Phase::Idle
        }
    }

    fn abort_round(&mut self) {
        self.names = [None; MAX_TARGETS];
        self.targets = [None; MAX_TARGETS];
        self.dns_out = false;
        self.floor.reset();
    }

    /// The owner's config. A change restarts the schedule (first round in 1 s).
    pub fn set_config(&mut self, cfg: Config, now: i64) {
        if cfg == self.cfg {
            return;
        }
        self.cfg = cfg;
        self.abort_round();
        self.interval_s = 0;
        self.stats.fails_in_row = 0;
        self.phase = self.idle_phase();
        self.next_at = now + SEC;
    }

    /// A lease (new, renewed with other options, or after a link loss). The
    /// first round runs [`FIRST_DELAY_US`] later. A renewal with the same
    /// options changes nothing.
    pub fn set_network(&mut self, net: Network, now: i64) {
        if self.net == Some(net) {
            return;
        }
        self.net = Some(net);
        self.abort_round();
        self.interval_s = 0;
        self.stats.fails_in_row = 0;
        self.phase = self.idle_phase();
        self.next_at = now + FIRST_DELAY_US;
    }

    /// The link (or the lease) is gone.
    pub fn clear_network(&mut self) {
        self.net = None;
        self.abort_round();
        self.phase = self.idle_phase();
    }

    /// Run a round now (the console's `CLOCK SNTP NOW`).
    pub fn poll_now(&mut self, now: i64) {
        if self.phase == Phase::Idle {
            self.next_at = now;
        }
    }

    /// The finished round's result, once.
    pub fn take_outcome(&mut self) -> Option<Outcome> {
        self.outcome.take()
    }

    /// The next datagram to send, written into `out` (≥ 96 bytes). Call until
    /// it returns `None`.
    pub fn poll(&mut self, now: i64, out: &mut [u8]) -> Option<Tx> {
        if self.phase == Phase::Idle {
            if now < self.next_at {
                return None;
            }
            self.start_round(now);
        }
        if self.phase == Phase::Resolving {
            if let Some(tx) = self.service_dns(now, out) {
                return Some(tx);
            }
        }
        if self.phase == Phase::Querying {
            return self.service_ntp(now, out);
        }
        None
    }

    fn add_target(&mut self, ip: Ip) -> bool {
        if ip == [0; 4] || self.targets.iter().flatten().any(|t| t.ip == ip) {
            return false;
        }
        if let Some(slot) = self.targets.iter_mut().find(|t| t.is_none()) {
            *slot = Some(Target {
                ip,
                cookie: 0,
                t1: 0,
                sent: false,
                result: None,
            });
            return true;
        }
        false
    }

    fn n_targets(&self) -> usize {
        self.targets.iter().flatten().count()
    }

    fn start_round(&mut self, now: i64) {
        self.abort_round();
        self.stats.rounds += 1;
        self.name_i = 0;
        self.dns_tries = 0;
        self.dns_fail = None;
        self.sport = 49152 + (self.rand() % 16384) as u16;
        // The candidates, in order: the override, else the lease's NTP servers then the pool.
        let mut cand: [Option<Name>; 3] = [None; 3];
        if self.cfg.has_override() {
            for (c, s) in cand.iter_mut().zip(self.cfg.servers.iter()) {
                if !s.is_empty() {
                    *c = Some(*s);
                }
            }
        } else {
            let mut k = 0;
            if self.cfg.use_dhcp {
                if let Some(net) = self.net {
                    for ip in net.ntp.iter().flatten() {
                        let mut n = Name::EMPTY;
                        let mut b = [0u8; 15];
                        let len = fmt_ip(&mut b, *ip);
                        n.buf[..len].copy_from_slice(&b[..len]);
                        n.len = len as u8;
                        cand[k] = Some(n);
                        k += 1;
                    }
                }
            }
            cand[k] = Name::new(DEFAULT_SERVER);
        }
        let mut slots = MAX_TARGETS;
        let mut last_name: Option<usize> = None;
        let mut ni = 0;
        for c in cand.iter().flatten() {
            if slots == 0 {
                break;
            }
            if let Some(ip) = c.ipv4() {
                if self.add_target(ip) {
                    slots -= 1;
                }
            } else if ni < MAX_TARGETS {
                self.names[ni] = Some(Pending { name: *c, want: 1 });
                last_name = Some(ni);
                ni += 1;
                slots -= 1;
            }
        }
        if let (Some(i), true) = (last_name, slots > 0) {
            if let Some(p) = self.names[i].as_mut() {
                p.want += slots as u8;
            }
        }
        self.phase = if ni > 0 {
            Phase::Resolving
        } else {
            Phase::Querying
        };
        if ni == 0 && self.n_targets() == 0 {
            self.finish_round(now);
        }
    }

    /// The resolvers to try, in order: the lease's DNS servers, else the router.
    fn resolvers(&self) -> ([Ip; 3], usize) {
        let mut r = [[0u8; 4]; 3];
        let mut n = 0;
        if let Some(net) = self.net {
            for ip in net.dns.iter().flatten().chain(net.router.iter()) {
                if *ip != [0; 4] && !r[..n].contains(ip) {
                    r[n] = *ip;
                    n += 1;
                }
            }
        }
        (r, n)
    }

    fn next_name(&mut self, fail: Option<Fail>) {
        if fail.is_some() {
            self.dns_fail = fail;
        }
        self.name_i += 1;
        self.dns_out = false;
        self.dns_tries = 0;
    }

    fn service_dns(&mut self, now: i64, out: &mut [u8]) -> Option<Tx> {
        loop {
            let Some(p) = self.names.get(self.name_i).copied().flatten() else {
                self.phase = Phase::Querying;
                if self.n_targets() == 0 {
                    self.finish_round(now);
                }
                return None;
            };
            if self.dns_out {
                if now - self.dns_sent_at < DNS_TIMEOUT_US {
                    return None;
                }
                self.dns_out = false;
            }
            let (res, nres) = self.resolvers();
            if nres == 0 {
                self.next_name(Some(Fail::NoServers));
                continue;
            }
            if self.dns_tries >= DNS_TRIES {
                self.next_name(Some(Fail::DnsTimeout));
                continue;
            }
            let dst = res[self.dns_tries as usize % nres];
            self.dns_id = self.rand() as u16;
            let len = dns::build_query(out, self.dns_id, p.name.as_bytes());
            if len == 0 {
                self.next_name(Some(Fail::NoServers));
                continue;
            }
            self.dns_tries += 1;
            self.dns_out = true;
            self.dns_sent_at = now;
            self.stats.dns_queries += 1;
            return Some(Tx {
                dst,
                dport: dns::PORT,
                sport: self.sport,
                len,
            });
        }
    }

    fn service_ntp(&mut self, now: i64, out: &mut [u8]) -> Option<Tx> {
        let first = !self.targets.iter().flatten().any(|t| t.sent);
        let cookie = ((self.rand() as u64) << 32) | self.rand() as u64;
        if let Some(t) = self.targets.iter_mut().flatten().find(|t| !t.sent) {
            let len = ntp::build_request(out, cookie);
            if len == 0 {
                return None;
            }
            if first {
                self.floor.reset();
            }
            t.cookie = cookie;
            t.t1 = now;
            t.sent = true;
            let dst = t.ip;
            self.deadline = now + NTP_TIMEOUT_US;
            self.stats.ntp_requests += 1;
            return Some(Tx {
                dst,
                dport: ntp::PORT,
                sport: self.sport,
                len,
            });
        }
        let done = self.targets.iter().flatten().all(|t| t.result.is_some());
        if done || now >= self.deadline {
            self.finish_round(now);
        }
        None
    }

    /// A reaped frame's RX-vector stamp (while [`Client::wants_stamps`]).
    pub fn note_frame(&mut self, reap_us: i64, hw_us: u32) {
        if self.phase == Phase::Querying {
            self.floor.note(reap_us, hw_us);
        }
    }

    /// A datagram from `src:sport` to our `dport`, reaped at mono `reap_us`
    /// with RX stamp `hw_us` (if the reap kept it). Returns whether it was
    /// ours (the caller drops it either way).
    pub fn on_udp(
        &mut self,
        reap_us: i64,
        hw_us: Option<u32>,
        src: Ip,
        sport: u16,
        dport: u16,
        data: &[u8],
    ) -> bool {
        if dport == 0 || dport != self.local_port() {
            return false;
        }
        match (self.phase, sport) {
            (Phase::Resolving, dns::PORT) if self.dns_out => {
                let Some(p) = self.names.get(self.name_i).copied().flatten() else {
                    return true;
                };
                let mut ips = [[0u8; 4]; MAX_TARGETS];
                let want = (p.want as usize).min(MAX_TARGETS);
                match dns::parse_response(data, self.dns_id, p.name.as_bytes(), &mut ips[..want]) {
                    Ok((n, _ttl)) => {
                        for ip in &ips[..n] {
                            self.add_target(*ip);
                        }
                        self.next_name(None);
                    }
                    Err(dns::DnsError::Rcode(r)) => self.next_name(Some(Fail::Dns(r))),
                    Err(dns::DnsError::NoAddress) => self.next_name(Some(Fail::Dns(0))),
                    Err(_) => self.stats.stray += 1,
                }
                // Resolving moves on at the next poll (more names, or the requests).
            }
            (Phase::Querying, ntp::PORT) => {
                if let Some(hw) = hw_us {
                    self.floor.note(reap_us, hw);
                }
                let t4 = hw_us.map_or(reap_us, |hw| self.floor.arrival(reap_us, hw));
                let Some(t) = self
                    .targets
                    .iter_mut()
                    .flatten()
                    .find(|t| t.ip == src && t.sent && t.result.is_none())
                else {
                    self.stats.stray += 1;
                    return true;
                };
                let r = match ntp::parse_reply(data, t.cookie) {
                    Ok(r) => {
                        let x = Exchange::compute(t.t1, t4, &r);
                        if x.delay_us > MAX_DELAY_US || t4 < t.t1 {
                            Err(Fail::Bad)
                        } else {
                            Ok((x, r.stratum, t4))
                        }
                    }
                    Err(ReplyError::KissOfDeath(code)) => Err(Fail::Kod(code)),
                    Err(ReplyError::Unsynchronised) => Err(Fail::Unsynchronised),
                    Err(ReplyError::BadTimestamps) => Err(Fail::Bad),
                    // Not an answer to our request (stale, duplicated, spoofed): keep waiting.
                    Err(_) => {
                        self.stats.stray += 1;
                        return true;
                    }
                };
                t.result = Some(r);
                if self.targets.iter().flatten().all(|t| t.result.is_some()) {
                    self.finish_round(reap_us);
                }
            }
            _ => self.stats.stray += 1,
        }
        true
    }

    fn jitter_us(&mut self, interval_s: u32) -> i64 {
        let span = (interval_s / 8).max(1);
        (self.rand() % span) as i64 * SEC + (self.rand() % 1000) as i64 * 1000
    }

    fn finish_round(&mut self, now: i64) {
        let mut goods: [Option<(Exchange, u8, Ip, i64)>; MAX_TARGETS] = [None; MAX_TARGETS];
        let mut ng = 0;
        let mut worst: Option<Fail> = None;
        let n_targets = self.n_targets();
        for t in self.targets.iter().flatten() {
            match t.result {
                Some(Ok((x, stratum, t4))) => {
                    goods[ng] = Some((x, stratum, t.ip, t4));
                    ng += 1;
                }
                Some(Err(f)) => worst = Some(pick_fail(worst, f)),
                None => worst = Some(pick_fail(worst, Fail::Timeout)),
            }
        }
        let outcome = match (ng, goods) {
            (0, _) => Outcome::Failed(worst.or(self.dns_fail).unwrap_or(Fail::NoServers)),
            (2, [Some(a), Some(b)]) => {
                let d = (a.0.offset_us - b.0.offset_us).abs();
                if d <= a.0.err_us + b.0.err_us + AGREE_SLACK_US {
                    let best = if b.0.err_us < a.0.err_us { b } else { a };
                    Outcome::Synced(sample(best, true))
                } else {
                    self.stats.disagree += 1;
                    Outcome::Failed(Fail::Disagree)
                }
            }
            (_, [Some(a), _]) | (_, [None, Some(a)]) => {
                let consistent = self.last_offset.is_some_and(|(off, at)| {
                    let since = (a.3 - at).max(0);
                    (a.0.offset_us - off).abs()
                        <= CONSISTENT_US + since / 1_000_000 * CONSISTENT_PPM
                });
                if n_targets == 1 || consistent {
                    Outcome::Synced(sample(a, false))
                } else {
                    Outcome::Failed(Fail::Unconfirmed)
                }
            }
            _ => Outcome::Failed(Fail::Bad),
        };
        match outcome {
            Outcome::Synced(s) => {
                self.last_offset = Some((s.unix_us - s.at_mono_us, s.at_mono_us));
                self.interval_s = if self.interval_s == 0 {
                    SYNCED_FIRST_S
                } else {
                    (self.interval_s.saturating_mul(2)).min(SYNCED_MAX_S)
                };
                self.stats.synced += 1;
                self.stats.fails_in_row = 0;
                self.stats.last_server = s.server;
                self.stats.last_delay_us = s.delay_us;
                self.stats.last_sync_mono_us = Some(now);
                let iv = self.interval_s;
                self.next_at = now + iv as i64 * SEC + self.jitter_us(iv);
            }
            Outcome::Failed(f) => {
                self.stats.failed += 1;
                self.stats.fails_in_row = self.stats.fails_in_row.saturating_add(1);
                self.stats.last_fail = Some(f);
                let shift = (self.stats.fails_in_row - 1).min(8);
                let mut wait = (FAIL_FIRST_S << shift).min(FAIL_MAX_S);
                if let Fail::Kod(_) = f {
                    self.stats.kod += 1;
                    wait = wait.max(KOD_WAIT_S);
                }
                self.next_at = now + wait as i64 * SEC + self.jitter_us(wait);
            }
        }
        self.outcome = Some(outcome);
        self.abort_round();
        self.phase = self.idle_phase();
    }
}

/// The most telling failure of a round: a server's verdict over silence.
fn pick_fail(a: Option<Fail>, b: Fail) -> Fail {
    let w = |f: &Fail| match f {
        Fail::Kod(_) => 5,
        Fail::Unsynchronised => 4,
        Fail::Bad => 3,
        Fail::Timeout => 2,
        _ => 1,
    };
    match a {
        Some(a) if w(&a) >= w(&b) => a,
        _ => b,
    }
}

fn sample(g: (Exchange, u8, Ip, i64), confirmed: bool) -> Sample {
    let (x, stratum, server, t4) = g;
    Sample {
        unix_us: t4 + x.offset_us,
        at_mono_us: t4,
        err_us: x.err_us,
        delay_us: x.delay_us,
        server,
        stratum,
        confirmed,
    }
}

/// Writes `ip` as a dotted quad into `out` (≥ 15 bytes); returns its length.
pub fn fmt_ip(out: &mut [u8], ip: Ip) -> usize {
    let mut n = 0;
    for (k, o) in ip.iter().enumerate() {
        if k > 0 {
            out[n] = b'.';
            n += 1;
        }
        let mut d = [0u8; 3];
        let mut v = *o;
        let mut m = 0;
        loop {
            d[m] = b'0' + v % 10;
            m += 1;
            v /= 10;
            if v == 0 {
                break;
            }
        }
        for i in (0..m).rev() {
            out[n] = d[i];
            n += 1;
        }
    }
    n
}
