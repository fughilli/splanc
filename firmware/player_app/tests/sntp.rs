//! Network time on the player (sntp_ffi.rs + clock_ffi.rs) through the C ABI the netstack
//! drives: a DHCP lease without option 42 -> a DNS query for pool.ntp.org to the lease's
//! resolver -> two NTP requests -> agreeing replies -> the sample offered to the clock as
//! SNTP on the next tick -> clock_state.ntp; set_clock_config (override, BAD_SERVER,
//! disable, sync_now) and its persisted record; a sample measured across an esp_timer
//! step-back is dropped.
//!
//! One test function: the client and the clock are process-global, like the firmware's.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::clock_ffi::{
    lm_clock_test_reset, lm_clock_test_set_mono_us, lm_clock_tick,
};
use ledmapper_player_ffi::lm_player_handle;
use ledmapper_player_ffi::sntp_ffi::{
    lm_sntp_boot, lm_sntp_config_record, lm_sntp_net, lm_sntp_net_down, lm_sntp_poll, lm_sntp_port,
    lm_sntp_rx, lm_sntp_stamping, lm_sntp_status_line, lm_sntp_take_round, lm_sntp_test_reset,
    CONFIG_RECORD_MAX,
};
use ledmapper_sntp::ntp;
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

const S: i64 = 1_000_000;
/// UTC − mono for the simulated servers (2026-11-25T08:00:00Z at mono 0).
const THETA: i64 = 1_795_593_600 * S;
const ROUTER: [u8; 4] = [10, 42, 0, 1];
const POOL: [[u8; 4]; 2] = [[162, 159, 200, 1], [129, 6, 15, 28]];

fn frame_of(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 1024>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn send(msg: CMsg, now_us: i64) -> pb::ClockState {
    unsafe { lm_clock_test_set_mono_us(now_us) };
    let frame = frame_of(msg);
    let mut out = vec![0u8; 1024];
    let ms = now_us / 1000;
    let n = unsafe {
        lm_player_handle(
            frame.as_ptr(),
            frame.len(),
            ms,
            ms,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(n > 0, "handle returned {n}");
    let mut reply = pb::ServerMessage::default();
    reply
        .decode_from_bytes(&out[..n as usize])
        .expect("reply decodes");
    match reply.r#msg {
        Some(SMsg::ClockState(s)) => s,
        other => panic!("clock_state expected, got {other:?}"),
    }
}

fn get(now_us: i64) -> pb::ClockState {
    send(CMsg::GetClock(pb::GetClock::default()), now_us)
}

fn config(enabled: Option<bool>, servers: Option<&[&str]>, sync_now: bool) -> CMsg {
    let mut m = pb::SetClockConfig::default();
    if let Some(e) = enabled {
        m.set_ntp_enabled(e);
    }
    if let Some(list) = servers {
        m.r#replace_ntp_servers = true;
        for s in list {
            m.r#ntp_servers
                .push(micropb::heapless::String::try_from(*s).unwrap())
                .unwrap();
        }
    }
    m.r#sync_now = sync_now;
    CMsg::SetClockConfig(m)
}

struct Tx {
    dst: [u8; 4],
    dport: u16,
    sport: u16,
    data: Vec<u8>,
}

fn poll(now_us: i64) -> Vec<Tx> {
    let mut v = vec![];
    loop {
        let mut out = [0u8; 256];
        let mut dst = [0u8; 4];
        let (mut dp, mut sp) = (0u16, 0u16);
        let n = unsafe {
            lm_sntp_poll(
                now_us,
                out.as_mut_ptr(),
                out.len(),
                dst.as_mut_ptr(),
                &mut dp,
                &mut sp,
            )
        };
        if n == 0 {
            return v;
        }
        v.push(Tx {
            dst,
            dport: dp,
            sport: sp,
            data: out[..n].to_vec(),
        });
    }
}

fn rx(reap_us: i64, src: [u8; 4], sport: u16, dport: u16, data: &[u8]) -> bool {
    unsafe {
        lm_sntp_rx(
            reap_us,
            0,
            false,
            src.as_ptr(),
            sport,
            dport,
            data.as_ptr(),
            data.len(),
        )
    }
}

fn dns_answer(q: &Tx, ips: &[[u8; 4]]) -> Vec<u8> {
    let d = &q.data;
    let mut r = vec![d[0], d[1], 0x81, 0x80, 0, 1, 0, ips.len() as u8, 0, 0, 0, 0];
    r.extend_from_slice(&d[12..]);
    for ip in ips {
        r.extend_from_slice(&[0xc0, 12, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4]);
        r.extend_from_slice(ip);
    }
    r
}

/// The server's reply to `q`, its clock `theta + skew` at `t_us` (mono).
fn ntp_answer(q: &Tx, t_us: i64, skew_us: i64) -> Vec<u8> {
    let mut p = vec![0u8; 48];
    p[0] = 0x24;
    p[1] = 2;
    p[24..32].copy_from_slice(&q.data[40..48]);
    let (s, f) = ntp::unix_us_to_ntp(THETA + t_us + skew_us);
    for o in [32, 40] {
        p[o..o + 4].copy_from_slice(&s.to_be_bytes());
        p[o + 4..o + 8].copy_from_slice(&f.to_be_bytes());
    }
    p
}

fn lease(now_us: i64, ntp: &[[u8; 4]]) {
    let ip = [10, 42, 0, 77];
    let mask = [255, 255, 255, 0];
    let dns = ROUTER;
    let ntp_flat: Vec<u8> = ntp.iter().flatten().copied().collect();
    unsafe {
        lm_sntp_net(
            ip.as_ptr(),
            mask.as_ptr(),
            ROUTER.as_ptr(),
            dns.as_ptr(),
            1,
            if ntp.is_empty() {
                core::ptr::null()
            } else {
                ntp_flat.as_ptr()
            },
            ntp.len(),
            now_us,
        )
    };
}

fn status(now_us: i64) -> String {
    let mut b = [0u8; 320];
    let n = unsafe { lm_sntp_status_line(now_us, b.as_mut_ptr(), b.len()) };
    String::from_utf8_lossy(&b[..n]).into_owned()
}

/// One full round against the pool through DNS, replies at `t + 4 ms`; returns the round's
/// end time.
fn pool_round(t: i64, skews: [i64; 2]) -> i64 {
    let q = poll(t);
    assert_eq!(q.len(), 1, "one DNS query");
    assert_eq!((q[0].dst, q[0].dport), (ROUTER, 53));
    assert_eq!(unsafe { lm_sntp_port() }, q[0].sport);
    assert!(rx(
        t + 3000,
        ROUTER,
        53,
        q[0].sport,
        &dns_answer(&q[0], &POOL)
    ));
    let t = t + 3000;
    let reqs = poll(t);
    assert_eq!(
        reqs.iter().map(|r| (r.dst, r.dport)).collect::<Vec<_>>(),
        vec![(POOL[0], 123), (POOL[1], 123)]
    );
    assert!(unsafe { lm_sntp_stamping() });
    for (r, skew) in reqs.iter().zip(skews) {
        assert!(rx(
            t + 4000,
            r.dst,
            123,
            r.sport,
            &ntp_answer(r, t + 2000, skew)
        ));
    }
    assert!(!unsafe { lm_sntp_stamping() });
    t + 4000
}

#[test]
fn sntp_end_to_end() {
    use pb::ClockSetResult as R;
    let mut carry = [0u8; 28];
    unsafe {
        lm_clock_test_reset();
        lm_sntp_test_reset();
    }
    let mut t = 10 * S;
    // No lease: nothing goes out, clock_state.ntp says so.
    assert!(poll(t).is_empty());
    let st = get(t);
    let n = st.ntp().expect("clock_state.ntp").clone();
    assert!(n.r#enabled && n.r#use_dhcp && !n.r#network);

    // A lease without option 42: the pool, through the lease's DNS, 2 s later.
    lease(t, &[]);
    assert!(poll(t + S).is_empty(), "first round 2 s after the lease");
    t += 2 * S;
    t = pool_round(t, [0, 3_000]);
    assert!(unsafe { lm_sntp_take_round() });
    assert!(status(t).contains("result=synced"), "{}", status(t));
    // Not offered until the clock's tick (under the player mutex in main.cpp).
    unsafe { lm_clock_test_set_mono_us(t) };
    assert!(!get(t).r#valid);
    let bits = unsafe { lm_clock_tick(carry.as_mut_ptr()) };
    assert_eq!(bits & 2, 2, "a [clock] line after the set");
    let st = get(t);
    assert!(st.r#valid);
    assert_eq!(st.r#source, pb::ClockSource::Sntp);
    let want_ms = (THETA + t) / 1000;
    assert!(
        (st.r#unix_ms - want_ms).abs() <= 2,
        "{} vs {}",
        st.r#unix_ms,
        want_ms
    );
    let n = st.ntp().unwrap().clone();
    assert_eq!(
        n.r#server.as_str(),
        "162.159.200.1",
        "the more certain of the two"
    );
    assert_eq!(n.r#last_result, pb::ClockNtpResult::Synced);
    assert_eq!(n.r#last_offer, R::Accepted);
    assert_eq!(n.r#interval_s, 64);
    assert!(
        n.r#next_poll_s >= 63 && n.r#next_poll_s <= 72,
        "{}",
        n.r#next_poll_s
    );
    assert!(n.r#network);

    // An app push afterwards is less certain than SNTP: not taken.
    let mut m = pb::SetWallClock {
        unix_ms: want_ms + 500,
        err_ms: 20,
        ..Default::default()
    };
    m.r#pushed_by = pb::WallClockPusher::App;
    assert_eq!(send(CMsg::SetWallClock(m), t).r#last_set, R::NotBetter);

    // The owner sets an override: a bad name changes nothing; a good one restarts the
    // schedule (1 s) and is persisted.
    let st = send(config(None, Some(&["not a host"]), false), t);
    assert_eq!(st.r#last_set, R::BadServer);
    assert!(st.ntp().unwrap().clone().r#servers.is_empty());
    let st = send(config(None, Some(&["10.42.0.5", ""]), false), t);
    assert_eq!(st.r#last_set, R::Accepted);
    assert_eq!(
        st.ntp()
            .unwrap()
            .clone()
            .r#servers
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>(),
        vec!["10.42.0.5"]
    );
    assert_eq!(
        unsafe { lm_clock_tick(carry.as_mut_ptr()) } & 4,
        4,
        "persist the config"
    );
    assert_eq!(unsafe { lm_clock_tick(carry.as_mut_ptr()) } & 4, 0);
    let mut rec = [0u8; CONFIG_RECORD_MAX];
    let rn = unsafe { lm_sntp_config_record(rec.as_mut_ptr()) };
    assert_eq!(&rec[..rn], b"\x01\x03\x0910.42.0.5\x00");
    let q = poll(t + S);
    assert_eq!(q.len(), 1);
    assert_eq!(
        (q[0].dst, q[0].dport),
        ([10, 42, 0, 5], 123),
        "the override, no DNS"
    );

    // A reply measured across an esp_timer step-back is dropped: the guard sees the jump
    // at the next tick, before the offer.
    let t2 = t + S + 2000;
    assert!(rx(
        t2,
        [10, 42, 0, 5],
        123,
        q[0].sport,
        &ntp_answer(&q[0], t + S + 1000, 0)
    ));
    let gen = get(t2).r#gen;
    unsafe { lm_clock_test_set_mono_us(t2 - 2 * 1_048_576) }; // 2 x 2^24 systimer ticks back
    unsafe { lm_clock_tick(carry.as_mut_ptr()) };
    let st = get(t2 - 2 * 1_048_576);
    assert_eq!(st.r#mono_jumps, 1);
    assert_eq!(st.r#gen, gen, "the sample was not offered");
    assert!(st.r#valid, "the clock itself carried on through the jump");

    // Disabled: nothing goes out, even on sync_now.
    let t3 = t2 - 2 * 1_048_576 + 100 * S;
    let st = send(config(Some(false), None, true), t3);
    assert!(!st.ntp().unwrap().clone().r#enabled);
    assert!(poll(t3 + 10 * S).is_empty());
    assert!(status(t3).contains("state=off"), "{}", status(t3));

    // The record restores at boot.
    unsafe { lm_sntp_test_reset() };
    assert!(unsafe { lm_sntp_boot(rec.as_ptr(), rn) });
    let n = get(t3).ntp().unwrap().clone();
    assert!(n.r#enabled);
    assert_eq!(n.r#servers.len(), 1);
    assert!(
        !unsafe { lm_sntp_boot(b"\x02\x03".as_ptr(), 2) },
        "an unknown version"
    );
    assert!(
        !unsafe { lm_sntp_boot(b"\x01\x03\x09bad".as_ptr(), 6) },
        "a torn record"
    );

    // The link goes down: the round stops, the port closes.
    unsafe { lm_sntp_net_down() };
    assert_eq!(unsafe { lm_sntp_port() }, 0);
    assert!(poll(t3 + 20 * S).is_empty());
}
