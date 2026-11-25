//! Golden DNS and SNTP packets, the timestamp arithmetic and the RX floor.

use ledmapper_sntp::dns::{self, DnsError};
use ledmapper_sntp::ntp::{self, Exchange, ReplyError};
use ledmapper_sntp::stamp::RxFloor;

// -- NTP ----------------------------------------------------------------------------

const COOKIE: u64 = 0x0123_4567_89ab_cdef;
/// 2026-11-25T12:00:00Z.
const T_UNIX_S: i64 = 1_795_608_000;

fn ntp_ts(unix_us: i64) -> [u8; 8] {
    let (s, f) = ntp::unix_us_to_ntp(unix_us);
    let mut b = [0u8; 8];
    b[..4].copy_from_slice(&s.to_be_bytes());
    b[4..].copy_from_slice(&f.to_be_bytes());
    b
}

/// A server reply: LI/VN/mode byte, stratum, root delay/dispersion (16.16 s), refid,
/// origin = `origin`, receive = `t2`, transmit = `t3` (UTC µs).
#[allow(clippy::too_many_arguments)]
fn reply(
    b0: u8,
    stratum: u8,
    root_delay: u32,
    root_disp: u32,
    refid: [u8; 4],
    origin: u64,
    t2: i64,
    t3: i64,
) -> [u8; 48] {
    let mut p = [0u8; 48];
    p[0] = b0;
    p[1] = stratum;
    p[2] = 6; // poll
    p[3] = 0xec; // precision
    p[4..8].copy_from_slice(&root_delay.to_be_bytes());
    p[8..12].copy_from_slice(&root_disp.to_be_bytes());
    p[12..16].copy_from_slice(&refid);
    p[16..24].copy_from_slice(&ntp_ts(t2 - 30_000_000));
    p[24..32].copy_from_slice(&origin.to_be_bytes());
    p[32..40].copy_from_slice(&ntp_ts(t2));
    p[40..48].copy_from_slice(&ntp_ts(t3));
    p
}

#[test]
fn request_is_v4_client_with_the_cookie_only() {
    let mut b = [0xffu8; 64];
    assert_eq!(ntp::build_request(&mut b, COOKIE), 48);
    assert_eq!(b[0], 0x23, "LI 0, VN 4, mode 3");
    assert!(b[1..40].iter().all(|&x| x == 0), "no clock reading leaks");
    assert_eq!(&b[40..48], &COOKIE.to_be_bytes());
    assert_eq!(b[48], 0xff, "nothing past 48 bytes");
    assert_eq!(ntp::build_request(&mut [0u8; 47], COOKIE), 0);
}

#[test]
fn ntp_timestamps_round_trip_and_pivot_the_era() {
    for us in [
        T_UNIX_S * 1_000_000,
        T_UNIX_S * 1_000_000 + 123_456,
        // 2036-02-07T06:28:16Z: the NTP era-0 rollover.
        2_085_978_496 * 1_000_000 - 1,
        2_085_978_496 * 1_000_000,
        2_085_978_496 * 1_000_000 + 999_999,
        // 2100.
        4_102_444_800 * 1_000_000 + 7,
    ] {
        let (s, f) = ntp::unix_us_to_ntp(us);
        assert_eq!(ntp::ntp_to_unix_us(s, f), us, "{us}");
    }
    // Era 1 starts at NTP second 0.
    assert_eq!(ntp::ntp_to_unix_us(0, 0), 2_085_978_496 * 1_000_000);
    // Half a second.
    assert_eq!(
        ntp::ntp_to_unix_us(3_976_214_400, 0x8000_0000),
        1_767_225_600_500_000
    );
}

#[test]
fn a_good_reply_parses() {
    let t2 = T_UNIX_S * 1_000_000 + 250_000;
    let p = reply(
        0x24,
        2,
        0x0000_0200,
        0x0000_0100,
        *b"GPS\0",
        COOKIE,
        t2,
        t2 + 40,
    );
    let r = ntp::parse_reply(&p, COOKIE).unwrap();
    assert_eq!(r.leap, 0);
    assert_eq!(r.stratum, 2);
    assert_eq!(r.root_delay_us, 7812, "0x200/65536 s");
    assert_eq!(r.root_dispersion_us, 3906);
    assert_eq!(r.receive_unix_us, t2);
    assert_eq!(r.transmit_unix_us, t2 + 40);
    // NTPv3 servers answer too; a leap-second warning is still a time.
    let p3 = reply(0x5c, 3, 0, 0, [0; 4], COOKIE, t2, t2);
    assert_eq!(ntp::parse_reply(&p3, COOKIE).unwrap().leap, 1);
}

#[test]
fn bad_replies_are_refused() {
    let t2 = T_UNIX_S * 1_000_000;
    let good = reply(0x24, 2, 0, 0, [0; 4], COOKIE, t2, t2);
    assert_eq!(
        ntp::parse_reply(&good[..47], COOKIE),
        Err(ReplyError::Truncated)
    );
    assert_eq!(
        ntp::parse_reply(&good, COOKIE ^ 1),
        Err(ReplyError::WrongOrigin)
    );
    // A client request echoed back, a broadcast, NTPv2.
    for b0 in [0x23, 0x25, 0x14] {
        let p = reply(b0, 2, 0, 0, [0; 4], COOKIE, t2, t2);
        assert_eq!(
            ntp::parse_reply(&p, COOKIE),
            Err(ReplyError::NotAReply),
            "{b0:#x}"
        );
    }
    // LI 3: the server's clock isn't synchronised. Stratum 16 likewise.
    let p = reply(0xe4, 2, 0, 0, [0; 4], COOKIE, t2, t2);
    assert_eq!(
        ntp::parse_reply(&p, COOKIE),
        Err(ReplyError::Unsynchronised)
    );
    let p = reply(0x24, 16, 0, 0, [0; 4], COOKIE, t2, t2);
    assert_eq!(
        ntp::parse_reply(&p, COOKIE),
        Err(ReplyError::Unsynchronised)
    );
    // Kiss-o'-death RATE (stratum 0; LI is 3 in a KoD, the code wins).
    let p = reply(0xe4, 0, 0, 0, *b"RATE", COOKIE, 0, 0);
    assert_eq!(
        ntp::parse_reply(&p, COOKIE),
        Err(ReplyError::KissOfDeath(*b"RATE"))
    );
    // Zero transmit, T3 before T2.
    let mut p = reply(0x24, 2, 0, 0, [0; 4], COOKIE, t2, t2);
    p[40..48].fill(0);
    assert_eq!(ntp::parse_reply(&p, COOKIE), Err(ReplyError::BadTimestamps));
    let p = reply(0x24, 2, 0, 0, [0; 4], COOKIE, t2, t2 - 1000);
    assert_eq!(ntp::parse_reply(&p, COOKIE), Err(ReplyError::BadTimestamps));
}

#[test]
fn offset_delay_and_error_from_the_four_timestamps() {
    // The device's mono clock reads 5 s at UTC T; the path is 10 ms out, 30 ms back
    // (asymmetric), the server holds the request 1 ms.
    let utc0 = T_UNIX_S * 1_000_000;
    let mono0 = 5_000_000;
    let theta = utc0 - mono0;
    let t1 = mono0;
    let t2 = utc0 + 10_000;
    let t3 = t2 + 1_000;
    let t4 = mono0 + 41_000;
    let r = ntp::Reply {
        leap: 0,
        stratum: 2,
        root_delay_us: 4_000,
        root_dispersion_us: 1_500,
        receive_unix_us: t2,
        transmit_unix_us: t3,
    };
    let x = Exchange::compute(t1, t4, &r);
    assert_eq!(x.delay_us, 40_000);
    // The asymmetry (10 vs 30 ms) puts θ 10 ms off, inside δ/2.
    assert_eq!(x.offset_us, theta - 10_000);
    assert!((x.offset_us - theta).abs() <= x.delay_us / 2);
    assert_eq!(x.err_us, 20_000 + 2_000 + 1_500);
}

// -- DNS ----------------------------------------------------------------------------

#[test]
fn names_and_literals() {
    assert!(dns::valid_name(b"pool.ntp.org"));
    assert!(dns::valid_name(b"time.example.com."));
    assert!(dns::valid_name(b"ntp_1.lan"));
    for bad in [&b""[..], b".", b"a..b", b"a b", b"-\x00", &[b'a'; 65]] {
        assert!(!dns::valid_name(bad), "{bad:?}");
    }
    assert!(!dns::valid_name(&[&[b'a'; 64][..], b".x"].concat()));
    assert_eq!(dns::parse_ipv4(b"192.168.60.1"), Some([192, 168, 60, 1]));
    for bad in [
        &b"1.2.3"[..],
        b"1.2.3.4.5",
        b"256.1.1.1",
        b"1..2.3",
        b"a.b.c.d",
        b"1.2.3.0004",
    ] {
        assert_eq!(dns::parse_ipv4(bad), None, "{bad:?}");
    }
}

#[test]
fn query_golden() {
    let mut b = [0u8; dns::QUERY_MAX];
    let n = dns::build_query(&mut b, 0xbeef, b"pool.ntp.org");
    let want: &[u8] = &[
        0xbe, 0xef, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, //
        4, b'p', b'o', b'o', b'l', 3, b'n', b't', b'p', 3, b'o', b'r', b'g', 0, //
        0, 1, 0, 1,
    ];
    assert_eq!(&b[..n], want);
    // A trailing dot is the same name; the longest name fits.
    assert_eq!(dns::build_query(&mut b, 0xbeef, b"pool.ntp.org."), n);
    let long = [&[b'a'; 60][..], b".com"].concat();
    assert_eq!(dns::build_query(&mut b, 1, &long), 12 + 66 + 4);
    assert_eq!(dns::build_query(&mut b, 1, b"bad name"), 0);
}

/// A response to `id` for `pool.ntp.org`: a CNAME, then A records (compressed names).
fn response(id: u16, rcode: u8, answers: &[(u16, [u8; 4])]) -> Vec<u8> {
    let mut b = vec![
        (id >> 8) as u8,
        id as u8,
        0x81,
        0x80 | rcode,
        0,
        1,
        0,
        0,
        0,
        0,
        0,
        0,
    ];
    b.extend_from_slice(&[
        4, b'p', b'o', b'o', b'l', 3, b'n', b't', b'p', 3, b'o', b'r', b'g', 0, 0, 1, 0, 1,
    ]);
    let mut an = 0u16;
    // CNAME pool.ntp.org -> x.ntp.org (rdata: label x + pointer to "ntp.org" at 17).
    b.extend_from_slice(&[0xc0, 12, 0, 5, 0, 1, 0, 0, 0, 60, 0, 4, 1, b'x', 0xc0, 17]);
    an += 1;
    for (ty, ip) in answers {
        b.extend_from_slice(&[0xc0, 12]);
        b.extend_from_slice(&ty.to_be_bytes());
        b.extend_from_slice(&[0, 1, 0, 0, 0, 130, 0, 4]);
        b.extend_from_slice(ip);
        an += 1;
    }
    b[6..8].copy_from_slice(&an.to_be_bytes());
    b
}

#[test]
fn response_parses_a_records_past_a_cname() {
    let r = response(
        7,
        0,
        &[
            (1, [1, 2, 3, 4]),
            (1, [1, 2, 3, 4]),
            (28, [9; 4]),
            (1, [5, 6, 7, 8]),
            (1, [9, 9, 9, 9]),
        ],
    );
    let mut out = [[0u8; 4]; 2];
    assert_eq!(
        dns::parse_response(&r, 7, b"pool.ntp.org", &mut out),
        Ok((2, 130))
    );
    assert_eq!(
        out,
        [[1, 2, 3, 4], [5, 6, 7, 8]],
        "distinct, in order, A only"
    );
    // Case-insensitive question match (0x20 randomisation by resolvers).
    assert!(dns::parse_response(&r, 7, b"POOL.NTP.ORG", &mut out).is_ok());
}

#[test]
fn response_errors() {
    let mut out = [[0u8; 4]; 2];
    let r = response(7, 0, &[(1, [1, 2, 3, 4])]);
    assert_eq!(
        dns::parse_response(&r, 8, b"pool.ntp.org", &mut out),
        Err(DnsError::NotOurs)
    );
    assert_eq!(
        dns::parse_response(&r, 7, b"time.ntp.org", &mut out),
        Err(DnsError::NotOurs)
    );
    let mut q = r.clone();
    q[2] &= 0x7f; // a query, not a response
    assert_eq!(
        dns::parse_response(&q, 7, b"pool.ntp.org", &mut out),
        Err(DnsError::NotOurs)
    );
    let nx = response(7, 3, &[]);
    assert_eq!(
        dns::parse_response(&nx, 7, b"pool.ntp.org", &mut out),
        Err(DnsError::Rcode(3))
    );
    let none = response(7, 0, &[(28, [1; 4])]);
    assert_eq!(
        dns::parse_response(&none, 7, b"pool.ntp.org", &mut out),
        Err(DnsError::NoAddress)
    );
    // Truncated anywhere: never panics, never reads past the end.
    for n in 0..r.len() {
        let res = dns::parse_response(&r[..n], 7, b"pool.ntp.org", &mut out);
        assert!(res.is_err(), "{n}");
    }
    // A label-length byte with the reserved 01/10 top bits.
    let mut bad = r.clone();
    let k = bad.len() - 16; // the last answer's name pointer
    bad[k] = 0x80;
    assert_eq!(
        dns::parse_response(&bad, 7, b"pool.ntp.org", &mut out),
        Err(DnsError::Malformed)
    );
}

// -- RX floor -------------------------------------------------------------------------

#[test]
fn floor_maps_the_radio_arrival() {
    let mut f = RxFloor::new();
    // HW counter runs 700 ms behind esp_timer; beacons reaped 30..800 µs late.
    let off = 700_000i64;
    for (k, lag) in [400, 30, 800, 120].iter().enumerate() {
        let arr = 10_000_000 + k as i64 * 102_400;
        f.note(arr + lag, (arr - off) as u32);
    }
    // The reply arrived at 10.5 s but the loop reaped it 25 ms later (a TLS record).
    let arr = 10_500_000;
    let reap = arr + 25_000;
    let hw = (arr - off) as u32;
    f.note(reap, hw);
    assert_eq!(
        f.arrival(reap, hw),
        arr + 30,
        "within the smallest lag seen"
    );
    // No floor: the reap; an implausible stamp: the reap.
    assert_eq!(RxFloor::new().arrival(reap, hw), reap);
    assert_eq!(f.arrival(reap, hw.wrapping_sub(5_000_000)), reap);
    // Across the counter's 32-bit wrap.
    let mut w = RxFloor::new();
    w.note(5_000_100, u32::MAX - 50);
    let hw2 = 949u32; // 1000 µs later on the hardware clock
    w.note(5_011_100, hw2);
    assert_eq!(w.arrival(5_011_100, hw2), 5_001_100);
}
