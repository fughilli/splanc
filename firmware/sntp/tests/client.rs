//! The SNTP client against a simulated LAN: server choice (override, DHCP option 42,
//! the pool through DNS), the two-server cross-check, backoff, kiss-o'-death, stray
//! and spoofed replies, and the RX-stamp correction.

use ledmapper_sntp::client::{Name, DEFAULT_SERVER};
use ledmapper_sntp::ntp;
use ledmapper_sntp::{Client, Config, Fail, Network, Outcome, Phase, Tx};

const S: i64 = 1_000_000;
/// UTC = mono + THETA for the honest servers.
const THETA: i64 = 1_795_608_000 * S;

const ROUTER: [u8; 4] = [10, 42, 0, 1];
const POOL_A: [u8; 4] = [162, 159, 200, 1];
const POOL_B: [u8; 4] = [129, 6, 15, 28];
const LAN_NTP: [u8; 4] = [10, 42, 0, 5];

fn net(ntp: &[[u8; 4]]) -> Network {
    Network {
        ip: [10, 42, 0, 77],
        mask: [255, 255, 255, 0],
        router: Some(ROUTER),
        dns: [Some(ROUTER), None],
        ntp: [ntp.first().copied(), ntp.get(1).copied()],
    }
}

/// One simulated server: its clock error and one-way delay; or a canned failure.
#[derive(Clone, Copy)]
enum Srv {
    Good { err_us: i64, owd_us: i64 },
    Kod(&'static [u8; 4]),
    Silent,
}

/// A datagram due at a time: (at, src, sport, dport, payload).
type Datagram = (i64, [u8; 4], u16, u16, Vec<u8>);

struct World {
    now: i64,
    servers: Vec<([u8; 4], Srv)>,
    /// DNS: name -> A records (None = silent resolver).
    dns: Option<Vec<[u8; 4]>>,
    sent: Vec<Tx>,
    inbox: Vec<Datagram>,
}

impl World {
    fn new(servers: Vec<([u8; 4], Srv)>, dns: Option<Vec<[u8; 4]>>) -> World {
        World {
            now: 10 * S,
            servers,
            dns,
            sent: vec![],
            inbox: vec![],
        }
    }

    /// Poll until idle, answering every datagram; advance time in 10 ms steps until
    /// the round's outcome (or `max_s`).
    fn run_round(&mut self, c: &mut Client, max_s: i64) -> Option<Outcome> {
        let end = self.now + max_s * S;
        while self.now < end {
            let mut buf = [0u8; 128];
            while let Some(tx) = c.poll(self.now, &mut buf) {
                self.sent.push(tx);
                self.answer(&tx, &buf[..tx.len]);
            }
            let due: Vec<_> = {
                let now = self.now;
                let (d, keep): (Vec<_>, Vec<_>) = self.inbox.drain(..).partition(|m| m.0 <= now);
                self.inbox = keep;
                d
            };
            for (at, src, sport, dport, data) in due {
                c.on_udp(at, None, src, sport, dport, &data);
            }
            if let Some(o) = c.take_outcome() {
                return Some(o);
            }
            self.now += 10_000;
        }
        None
    }

    fn answer(&mut self, tx: &Tx, data: &[u8]) {
        if tx.dport == 53 {
            let Some(ips) = self.dns.clone() else { return };
            let id = u16::from_be_bytes([data[0], data[1]]);
            let qlen = tx.len - 12;
            let mut r = vec![
                data[0],
                data[1],
                0x81,
                0x80,
                0,
                1,
                0,
                ips.len() as u8,
                0,
                0,
                0,
                0,
            ];
            r.extend_from_slice(&data[12..12 + qlen]);
            for ip in &ips {
                r.extend_from_slice(&[0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]);
                r.extend_from_slice(ip);
            }
            let _ = id;
            self.inbox.push((self.now + 5_000, tx.dst, 53, tx.sport, r));
            return;
        }
        assert_eq!(tx.dport, 123);
        let Some(&(_, srv)) = self.servers.iter().find(|s| s.0 == tx.dst) else {
            return;
        };
        let cookie = &data[40..48];
        let mut p = [0u8; 48];
        match srv {
            Srv::Silent => return,
            Srv::Kod(code) => {
                p[0] = 0xe4;
                p[12..16].copy_from_slice(code);
            }
            Srv::Good { err_us, owd_us } => {
                p[0] = 0x24;
                p[1] = 2;
                let t2 = self.now + owd_us + THETA + err_us;
                let t3 = t2 + 100;
                let w = |b: &mut [u8], us: i64| {
                    let (s, f) = ntp::unix_us_to_ntp(us);
                    b[..4].copy_from_slice(&s.to_be_bytes());
                    b[4..8].copy_from_slice(&f.to_be_bytes());
                };
                w(&mut p[32..40], t2);
                w(&mut p[40..48], t3);
            }
        }
        p[24..32].copy_from_slice(cookie);
        let owd = match srv {
            Srv::Good { owd_us, .. } => owd_us,
            _ => 2_000,
        };
        self.inbox
            .push((self.now + 2 * owd + 100, tx.dst, 123, tx.sport, p.to_vec()));
    }
}

fn good(owd_us: i64) -> Srv {
    Srv::Good { err_us: 0, owd_us }
}

fn synced(o: Option<Outcome>) -> ledmapper_sntp::Sample {
    match o {
        Some(Outcome::Synced(s)) => s,
        o => panic!("not synced: {o:?}"),
    }
}

#[test]
fn nothing_without_a_network_or_when_disabled() {
    let mut c = Client::new(1);
    let mut b = [0u8; 128];
    assert_eq!(c.phase(), Phase::NoNetwork);
    assert_eq!(c.poll(100 * S, &mut b), None);
    let mut cfg = Config::DEFAULT;
    cfg.enabled = false;
    c.set_config(cfg, 0);
    c.set_network(net(&[]), 0);
    assert_eq!(c.phase(), Phase::Off);
    assert_eq!(c.poll(100 * S, &mut b), None);
}

#[test]
fn dhcp_offered_servers_are_asked_and_must_agree() {
    // Option 42 with two LAN servers: no DNS at all.
    let mut w = World::new(vec![(LAN_NTP, good(500)), (ROUTER, good(300))], None);
    let mut c = Client::new(7);
    c.set_network(net(&[LAN_NTP, ROUTER]), w.now);
    let s = synced(w.run_round(&mut c, 5));
    assert!(s.confirmed);
    assert!(
        w.sent.iter().all(|t| t.dport == 123),
        "no DNS: {:?}",
        w.sent
    );
    assert_eq!(w.sent.len(), 2);
    // The time: UTC at T4 within the error bound; the faster server's sample.
    assert_eq!(s.server, ROUTER);
    assert!((s.unix_us - (s.at_mono_us + THETA)).abs() <= s.err_us);
    assert!(s.err_us >= s.delay_us / 2);
    assert_eq!(c.interval_s(), 64);
}

#[test]
fn the_pool_is_resolved_when_dhcp_offers_none() {
    let mut w = World::new(
        vec![(POOL_A, good(15_000)), (POOL_B, good(20_000))],
        Some(vec![POOL_A, POOL_B, [1, 1, 1, 1]]),
    );
    let mut c = Client::new(9);
    c.set_network(net(&[]), w.now);
    let s = synced(w.run_round(&mut c, 10));
    assert!(s.confirmed);
    assert_eq!(w.sent[0].dport, 53);
    assert_eq!(w.sent[0].dst, ROUTER);
    let ntp_dsts: Vec<_> = w
        .sent
        .iter()
        .filter(|t| t.dport == 123)
        .map(|t| t.dst)
        .collect();
    assert_eq!(
        ntp_dsts,
        vec![POOL_A, POOL_B],
        "two pool addresses from one name"
    );
    assert!(w
        .sent
        .iter()
        .all(|t| t.sport >= 49152 && t.sport == w.sent[0].sport));
}

#[test]
fn one_dhcp_server_is_paired_with_the_pool() {
    let mut w = World::new(
        vec![(LAN_NTP, good(400)), (POOL_A, good(15_000))],
        Some(vec![POOL_A]),
    );
    let mut c = Client::new(3);
    c.set_network(net(&[LAN_NTP]), w.now);
    let s = synced(w.run_round(&mut c, 10));
    assert!(s.confirmed);
    assert_eq!(s.server, LAN_NTP, "the more certain one");
}

#[test]
fn a_spoofer_who_disagrees_blocks_the_round() {
    // The LAN server is 30 s off (a spoofer); the pool is honest.
    let mut w = World::new(
        vec![
            (
                LAN_NTP,
                Srv::Good {
                    err_us: 30 * S,
                    owd_us: 300,
                },
            ),
            (POOL_A, good(15_000)),
        ],
        Some(vec![POOL_A]),
    );
    let mut c = Client::new(5);
    c.set_network(net(&[LAN_NTP]), w.now);
    assert_eq!(
        w.run_round(&mut c, 10),
        Some(Outcome::Failed(Fail::Disagree))
    );
    assert_eq!(c.stats.disagree, 1);
    // Retry in 15 s (+ up to 1/8 jitter), not the synced interval.
    let n = c.next_in_s(w.now).unwrap();
    assert!((14..=16).contains(&n), "{n}");
}

#[test]
fn a_lone_answer_needs_a_single_server_or_a_consistent_history() {
    // Two servers, one silent, no history: unconfirmed.
    let mut w = World::new(
        vec![(POOL_A, good(10_000)), (POOL_B, Srv::Silent)],
        Some(vec![POOL_A, POOL_B]),
    );
    let mut c = Client::new(11);
    c.set_network(net(&[]), w.now);
    assert_eq!(
        w.run_round(&mut c, 10),
        Some(Outcome::Failed(Fail::Unconfirmed))
    );
    // Both answer: synced. Then B goes silent again: A alone is consistent with it.
    w.servers[1].1 = good(12_000);
    w.now += 20 * S;
    synced(w.run_round(&mut c, 10));
    w.servers[1].1 = Srv::Silent;
    w.now += 80 * S;
    let s = synced(w.run_round(&mut c, 10));
    assert!(!s.confirmed);
    // An override with a single server: taken alone.
    let mut w = World::new(vec![(LAN_NTP, good(300))], None);
    let mut c = Client::new(13);
    let mut cfg = Config::DEFAULT;
    cfg.servers[0] = Name::new(b"10.42.0.5").unwrap();
    c.set_config(cfg, w.now);
    c.set_network(net(&[ROUTER]), w.now);
    let s = synced(w.run_round(&mut c, 10));
    assert_eq!(s.server, LAN_NTP, "the override wins over option 42");
    assert!(!s.confirmed);
}

#[test]
fn backoff_doubles_to_an_hour_when_synced_and_to_five_minutes_when_failing() {
    let mut w = World::new(vec![(LAN_NTP, good(300)), (ROUTER, good(300))], None);
    let mut c = Client::new(17);
    c.set_network(net(&[LAN_NTP, ROUTER]), w.now);
    let mut seen = vec![];
    for _ in 0..8 {
        synced(w.run_round(&mut c, 4000));
        seen.push(c.interval_s());
    }
    assert_eq!(seen, vec![64, 128, 256, 512, 1024, 2048, 3600, 3600]);
    // The next poll lands in [interval, interval * 9/8].
    let n = c.next_in_s(w.now).unwrap();
    assert!((3599..=4050).contains(&n), "{n}");
    // Now both go silent: 15, 30, 60, 120, 240, 300, 300 s.
    w.servers.iter_mut().for_each(|s| s.1 = Srv::Silent);
    let mut waits = vec![];
    for _ in 0..7 {
        assert_eq!(
            w.run_round(&mut c, 4000),
            Some(Outcome::Failed(Fail::Timeout))
        );
        waits.push(c.next_in_s(w.now).unwrap());
    }
    let lo = [15, 30, 60, 120, 240, 300, 300];
    for (got, lo) in waits.iter().zip(lo) {
        assert!(*got >= lo - 1 && *got <= lo + lo / 8 + 1, "{waits:?}");
    }
    // A good round again: the synced interval carries on from where it was.
    w.servers.iter_mut().for_each(|s| s.1 = good(300));
    synced(w.run_round(&mut c, 400));
    assert_eq!(c.interval_s(), 3600);
    assert_eq!(c.stats.fails_in_row, 0);
}

#[test]
fn kiss_of_death_waits_five_minutes() {
    let mut w = World::new(
        vec![(LAN_NTP, Srv::Kod(b"RATE")), (ROUTER, Srv::Silent)],
        None,
    );
    let mut c = Client::new(19);
    c.set_network(net(&[LAN_NTP, ROUTER]), w.now);
    assert_eq!(
        w.run_round(&mut c, 10),
        Some(Outcome::Failed(Fail::Kod(*b"RATE")))
    );
    assert!(c.next_in_s(w.now).unwrap() >= 299);
    assert_eq!(c.stats.kod, 1);
}

#[test]
fn dns_failures_and_no_servers() {
    // A silent resolver: three tries, then the round fails.
    let mut w = World::new(vec![], None);
    let mut c = Client::new(23);
    c.set_network(net(&[]), w.now);
    assert_eq!(
        w.run_round(&mut c, 10),
        Some(Outcome::Failed(Fail::DnsTimeout))
    );
    assert_eq!(w.sent.iter().filter(|t| t.dport == 53).count(), 3);
    // No resolver and no router: nothing to ask.
    let mut c = Client::new(29);
    let mut n = net(&[]);
    n.dns = [None, None];
    n.router = None;
    c.set_network(n, w.now);
    assert_eq!(
        w.run_round(&mut c, 10),
        Some(Outcome::Failed(Fail::NoServers))
    );
    // A resolver that says NXDOMAIN.
    let mut c = Client::new(31);
    c.set_network(net(&[]), w.now);
    let mut b = [0u8; 128];
    w.now += 3 * S;
    let tx = c.poll(w.now, &mut b).unwrap();
    let q = b[..tx.len].to_vec();
    let mut r = vec![q[0], q[1], 0x81, 0x83, 0, 1, 0, 0, 0, 0, 0, 0];
    r.extend_from_slice(&q[12..]);
    assert!(c.on_udp(w.now, None, ROUTER, 53, tx.sport, &r));
    assert_eq!(c.poll(w.now, &mut b), None);
    assert_eq!(c.take_outcome(), Some(Outcome::Failed(Fail::Dns(3))));
}

#[test]
fn strays_and_spoofs_are_ignored() {
    let mut c = Client::new(37);
    c.set_network(net(&[LAN_NTP]), 0);
    let mut cfg = Config::DEFAULT;
    cfg.servers[0] = Name::new(b"10.42.0.5").unwrap();
    c.set_config(cfg, 0);
    let mut b = [0u8; 128];
    let tx = c.poll(2 * S, &mut b).unwrap();
    assert_eq!(tx.dst, LAN_NTP);
    let cookie: [u8; 8] = b[40..48].try_into().unwrap();
    let mut p = [0u8; 48];
    p[0] = 0x24;
    p[1] = 2;
    let (s, f) = ntp::unix_us_to_ntp(THETA + 2 * S);
    for o in [32, 40] {
        p[o..o + 4].copy_from_slice(&s.to_be_bytes());
        p[o + 4..o + 8].copy_from_slice(&f.to_be_bytes());
    }
    // Wrong port, wrong origin, wrong source: not taken.
    assert!(!c.on_udp(2 * S + 1000, None, LAN_NTP, 123, tx.sport ^ 1, &p));
    p[24..32].copy_from_slice(&[0; 8]);
    assert!(c.on_udp(2 * S + 1000, None, LAN_NTP, 123, tx.sport, &p));
    p[24..32].copy_from_slice(&cookie);
    assert!(c.on_udp(2 * S + 1000, None, [6, 6, 6, 6], 123, tx.sport, &p));
    assert_eq!(c.take_outcome(), None);
    assert_eq!(c.stats.stray, 2);
    // The real one.
    assert!(c.on_udp(2 * S + 1000, None, LAN_NTP, 123, tx.sport, &p));
    let s = synced(c.take_outcome());
    assert!((s.unix_us - (s.at_mono_us + THETA)).abs() <= 1000);
    // Once the round is over the port is closed.
    assert_eq!(c.local_port(), 0);
    assert!(!c.on_udp(2 * S + 2000, None, LAN_NTP, 123, tx.sport, &p));
}

#[test]
fn rx_stamps_take_the_loop_latency_out() {
    let mut c = Client::new(41);
    let mut cfg = Config::DEFAULT;
    cfg.servers[0] = Name::new(b"10.42.0.5").unwrap();
    c.set_config(cfg, 0);
    c.set_network(net(&[]), 0);
    let mut b = [0u8; 128];
    let t1 = 2 * S;
    let tx = c.poll(t1, &mut b).unwrap();
    assert!(c.wants_stamps());
    let off = 700_000i64;
    // Beacons reaped 40 µs after they arrived.
    for k in 0..5 {
        let arr = t1 + k * 100_000;
        c.note_frame(arr + 40, (arr - off) as u32);
    }
    // The reply left the server 1 ms after T1 + 1 ms, arrived at T1 + 2 ms, but was
    // reaped 30 ms late.
    let arrival = t1 + 2_000;
    let mut p = [0u8; 48];
    p[0] = 0x24;
    p[1] = 2;
    let (s, f) = ntp::unix_us_to_ntp(THETA + t1 + 1_000);
    for o in [32, 40] {
        p[o..o + 4].copy_from_slice(&s.to_be_bytes());
        p[o + 4..o + 8].copy_from_slice(&f.to_be_bytes());
    }
    p[24..32].copy_from_slice(&b[40..48]);
    assert!(c.on_udp(
        arrival + 30_000,
        Some((arrival - off) as u32),
        LAN_NTP,
        123,
        tx.sport,
        &p
    ));
    let s = synced(c.take_outcome());
    assert_eq!(s.delay_us, 2_040, "the radio's arrival, not the reap");
    assert!((s.unix_us - (s.at_mono_us + THETA)).abs() <= 40);
    assert!(!c.wants_stamps());
}

#[test]
fn a_renewal_with_the_same_lease_keeps_the_schedule() {
    let mut w = World::new(vec![(LAN_NTP, good(300)), (ROUTER, good(300))], None);
    let mut c = Client::new(43);
    c.set_network(net(&[LAN_NTP, ROUTER]), w.now);
    synced(w.run_round(&mut c, 5));
    let next = c.next_in_s(w.now);
    c.set_network(net(&[LAN_NTP, ROUTER]), w.now);
    assert_eq!(c.next_in_s(w.now), next);
    // A new lease (other servers) starts over, 2 s out.
    c.set_network(net(&[LAN_NTP]), w.now);
    assert_eq!(c.next_in_s(w.now), Some(2));
    assert_eq!(c.interval_s(), 0);
    c.clear_network();
    assert_eq!(c.phase(), Phase::NoNetwork);
    assert_eq!(c.next_in_s(w.now), None);
}

#[test]
fn names() {
    assert!(Name::new(b"time.cloudflare.com").is_some());
    assert!(Name::new(b"192.168.1.10").unwrap().ipv4().is_some());
    assert!(Name::new(b"not a name").is_none());
    assert!(Name::new(&[b'a'; 65]).is_none());
    assert!(Name::new(b"").unwrap().is_empty());
    assert_eq!(DEFAULT_SERVER, b"pool.ntp.org");
}
