//! The wall clock (clock_ffi.rs, docs/design/wall-clock.md) through the C ABI:
//! set_wall_clock / get_clock -> clock_state, the at_device_ms mapping, the zone
//! (POSIX TZ) and its persisted record, the esp_timer step-back guard, the
//! soft-reset carry-over, and who may set the clock (D-569: a locked kiosk
//! visitor only while it is unset).
//!
//! One test function: the clock is process-global state, like the firmware's.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::clock_ffi::{
    lm_clock_boot, lm_clock_save, lm_clock_status_line, lm_clock_test_reset,
    lm_clock_test_set_mono_us, lm_clock_tick, lm_clock_tz_record, TZ_RECORD_MAX,
};
use ledmapper_player_ffi::lm_player_handle;
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

extern "C" {
    fn lm_kiosk_gate(
        src: u8,
        data: *const u8,
        len: usize,
        now_ms: u32,
        out: *mut u8,
        cap: usize,
    ) -> i32;
    fn lm_kiosk_seed(rec: *const u8, len: usize) -> bool;
}

const S: i64 = 1_000_000;
/// 2026-11-25T08:00:00Z, ms.
const T0_MS: i64 = 1_795_593_600_000;

fn frame_of(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 1024>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

/// Sends at device ms `now_ms` (the fake esp_timer reads the same instant, µs)
/// on connection `src` (1 = wss).
fn send_on(src: u8, msg: CMsg, now_ms: i64) -> pb::ClockState {
    unsafe { lm_clock_test_set_mono_us(now_ms * 1000) };
    let frame = frame_of(msg);
    let mut out = vec![0u8; 1024];
    let g = unsafe {
        lm_kiosk_gate(
            src,
            frame.as_ptr(),
            frame.len(),
            now_ms as u32,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert_eq!(g, 0, "the gate passes clock arms");
    let n = unsafe {
        lm_player_handle(
            frame.as_ptr(),
            frame.len(),
            now_ms,
            now_ms,
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

fn send(msg: CMsg, now_ms: i64) -> pb::ClockState {
    send_on(1, msg, now_ms)
}

fn get(now_ms: i64) -> pb::ClockState {
    send(CMsg::GetClock(pb::GetClock::default()), now_ms)
}

fn set(
    unix_ms: i64,
    at: Option<i64>,
    err_ms: u32,
    by: pb::WallClockPusher,
    tz: Option<&str>,
) -> CMsg {
    let mut m = pb::SetWallClock {
        unix_ms,
        err_ms,
        r#pushed_by: by,
        ..Default::default()
    };
    if let Some(a) = at {
        m.set_at_device_ms(a);
    }
    if let Some(t) = tz {
        m.set_tz(micropb::heapless::String::try_from(t).unwrap());
    }
    CMsg::SetWallClock(m)
}

fn status_line() -> String {
    let mut b = [0u8; 256];
    let n = unsafe { lm_clock_status_line(b.as_mut_ptr(), b.len()) };
    String::from_utf8_lossy(&b[..n]).into_owned()
}

#[test]
fn wall_clock_end_to_end() {
    use pb::ClockSetResult as R;
    use pb::WallClockPusher as P;
    let mut carry = [0u8; 28];
    let mut now: i64 = 5_000; // device ms

    // Cold boot: no zone record, no carry: invalid.
    unsafe { lm_clock_test_set_mono_us(now * 1000) };
    assert!(!unsafe { lm_clock_boot(carry.as_ptr(), false, core::ptr::null(), 0) });
    let st = get(now);
    assert!(!st.r#valid);
    assert_eq!(st.r#unix_ms, 0);
    assert_eq!(st.r#last_set, R::None);
    // The carry buffer is zeroed while invalid (a power-on's RAM never restores).
    unsafe { lm_clock_tick(carry.as_mut_ptr()) };
    assert_eq!(carry, [0u8; 28]);

    // D-569: a locked kiosk visitor may fill in an UNSET clock (and an unset zone).
    seed_kiosk(true);
    let st = send_on(
        2,
        set(T0_MS, None, 20, P::App, Some("EST5EDT,M3.2.0,M11.1.0")),
        now,
    );
    assert_eq!(st.r#last_set, R::Accepted);
    assert!(st.r#valid);
    assert_eq!(st.r#tz.as_str(), "EST5EDT,M3.2.0,M11.1.0");
    seed_kiosk(false);
    unsafe { lm_clock_test_reset() };

    // The app pushes: UTC that was true at device ms 4_900 (a sync 100 ms ago), ±5 ms,
    // and the phone's zone.
    let st = send(
        set(
            T0_MS,
            Some(4_900),
            5,
            P::App,
            Some("CET-1CEST,M3.5.0,M10.5.0/3"),
        ),
        now,
    );
    assert_eq!(st.r#last_set, R::Accepted);
    assert!(st.r#valid);
    assert_eq!(st.r#unix_ms, T0_MS + 100, "mapped through at_device_ms");
    assert_eq!(st.r#device_ms, now);
    assert_eq!(st.r#source, pb::ClockSource::Push);
    assert_eq!(st.r#pushed_by, P::App);
    assert!(st.r#err_ms >= 5 && st.r#err_ms < 10, "{}", st.r#err_ms);
    assert_eq!(st.r#tz.as_str(), "CET-1CEST,M3.5.0,M10.5.0/3");
    assert_eq!(st.r#utc_offset_s, 3600, "CET in November");
    assert_eq!(st.r#tz_abbrev.as_str(), "CET");
    assert_eq!(st.r#steps, 1);

    // The zone changed: the tick asks for it to be persisted, once.
    let bits = unsafe { lm_clock_tick(carry.as_mut_ptr()) };
    assert_eq!(bits & 1, 1, "tz changed");
    assert_eq!(bits & 2, 2, "status line due after a set");
    assert_eq!(unsafe { lm_clock_tick(carry.as_mut_ptr()) } & 3, 0);
    let mut rec = [0u8; TZ_RECORD_MAX];
    let rn = unsafe { lm_clock_tz_record(rec.as_mut_ptr()) };
    assert_eq!(rec[0] as usize, "CET-1CEST,M3.5.0,M10.5.0/3".len());
    assert!(status_line().contains("src=push/app"), "{}", status_line());
    assert!(
        status_line().contains("local=2026-11-25T09:00:00 CET"),
        "{}",
        status_line()
    );

    // Ten minutes later it reads ten minutes later.
    now += 600_000;
    let st = get(now);
    assert_eq!(st.r#unix_ms, T0_MS + 100 + 600_000);
    assert!(st.r#age_s >= 600);

    // A worse push (bigger error) doesn't move it; a better one slews.
    let st = send(
        set(T0_MS + 100 + 600_000 + 300, Some(now), 500, P::Bridge, None),
        now,
    );
    assert_eq!(st.r#last_set, R::NotBetter);
    let st = send(
        set(T0_MS + 100 + 600_000 + 300, Some(now), 2, P::Bridge, None),
        now,
    );
    assert_eq!(st.r#last_set, R::Accepted);
    assert_eq!(st.r#pushed_by, P::Bridge);
    assert_eq!(
        st.r#unix_ms,
        T0_MS + 100 + 600_000,
        "300 ms is slewed, not stepped"
    );
    assert_eq!(st.r#steps, 1);

    // esp_timer steps back by 2^24 ticks (1.048576 s): the wall clock doesn't.
    now += 50;
    let before = get(now).r#unix_ms;
    now += 50;
    unsafe { lm_clock_test_set_mono_us(now * 1000 - (1 << 20)) };
    unsafe { lm_clock_tick(carry.as_mut_ptr()) };
    let stepped_mono_ms = now - (1 << 20) / 1000;
    let st = get_at_raw(now * 1000 - (1 << 20), stepped_mono_ms);
    assert_eq!(st.r#mono_jumps, 1);
    let adv = st.r#unix_ms - before;
    // (The corrected timeline advances by the last observed interval: ~0 here, one
    // loop pass on the device.)
    assert!(
        (0..=60).contains(&adv),
        "continuous across the step: +{adv} ms"
    );
    // Continue on the stepped timeline.
    let mono_base = now * 1000 - (1 << 20); // raw µs now
    let wall_at_base = st.r#unix_ms;

    // A locked kiosk visitor may not move a set clock (but reads it).
    seed_kiosk(true);
    let st = send_on_raw(
        2,
        set(T0_MS + 3_600_000, None, 1, P::App, Some("EST5EDT")),
        mono_base + S,
        stepped_mono_ms + 1000,
    );
    assert_eq!(st.r#last_set, R::Locked);
    assert_eq!(
        st.r#tz.as_str(),
        "CET-1CEST,M3.5.0,M10.5.0/3",
        "a visitor can't change the owner's zone"
    );
    assert_eq!(st.r#unix_ms, wall_at_base + 1000);

    seed_kiosk(false);

    // Soft reset: the carry record restores the time (error grows by the gap).
    unsafe { lm_clock_test_set_mono_us(mono_base + 2 * S) };
    unsafe { lm_clock_save(carry.as_mut_ptr()) };
    assert_ne!(carry, [0u8; 28]);
    let wall_at_save = wall_at_base + 2000;
    // A cold boot ignores it (power loss: D-568) ...
    unsafe { lm_clock_test_reset() };
    unsafe { lm_clock_test_set_mono_us(300_000) };
    assert!(!unsafe { lm_clock_boot(carry.as_ptr(), false, rec.as_ptr(), rn) });
    let st = get_at_raw(300_000, 300);
    assert!(!st.r#valid);
    assert_eq!(
        st.r#tz.as_str(),
        "CET-1CEST,M3.5.0,M10.5.0/3",
        "the zone is config: kept"
    );
    // ... a corrupt record never decodes ...
    let mut bad = carry;
    bad[7] ^= 1;
    unsafe { lm_clock_test_reset() };
    assert!(!unsafe { lm_clock_boot(bad.as_ptr(), true, core::ptr::null(), 0) });
    // ... and a soft reset restores it: esp_timer restarts at 0, we boot 300 ms in.
    unsafe { lm_clock_test_reset() };
    unsafe { lm_clock_test_set_mono_us(300_000) };
    assert!(unsafe { lm_clock_boot(carry.as_ptr(), true, rec.as_ptr(), rn) });
    let st = get_at_raw(300_000, 300);
    assert!(st.r#valid);
    assert_eq!(st.r#source, pb::ClockSource::Carry);
    // The carried instant is taken as mono 0, so the clock reads save + 300 ms (the
    // 300 ms correction above was still slewing at 500 ppm: ~1 ms over these 2 s).
    let d = st.r#unix_ms - (wall_at_save + 300);
    assert!((0..=2).contains(&d), "restored {d} ms off");
    assert!(
        st.r#err_ms >= 1000,
        "the reboot gap is in the error: {}",
        st.r#err_ms
    );
    assert_eq!(st.r#tz.as_str(), "CET-1CEST,M3.5.0,M10.5.0/3");
    assert!(status_line().contains("src=carry"), "{}", status_line());
    // The app's next push (far better) replaces the carried time.
    let st = send_raw(set(wall_at_save + 400, None, 5, P::App, None), 400_000, 400);
    assert_eq!(st.r#last_set, R::Accepted);
    assert_eq!(st.r#source, pb::ClockSource::Push);

    // An explicit MANUAL set replaces even a better time; an implausible one is refused
    // without losing the clock.
    let st = send_raw(set(1_000, None, 0, P::Manual, None), 400_000, 400);
    assert_eq!(st.r#last_set, R::Implausible);
    assert!(st.r#valid);
    let st = send_raw(
        set(T0_MS + 86_400_000, None, 0, P::Manual, None),
        400_000,
        400,
    );
    assert_eq!(st.r#last_set, R::Accepted);
    assert_eq!(st.r#unix_ms, T0_MS + 86_400_000);
    assert_eq!(st.r#err_ms, 1000, "err 0 = unknown = 1 s");

    // A bad zone is refused, the time still considered.
    let st = send_raw(set(0, None, 0, P::App, Some("not a zone")), 400_000, 400);
    assert_eq!(st.r#last_set, R::BadTz);
    assert_eq!(st.r#tz.as_str(), "CET-1CEST,M3.5.0,M10.5.0/3");
}

/// get_clock with an explicit raw esp_timer reading and device ms.
fn get_at_raw(mono_us: i64, device_ms: i64) -> pb::ClockState {
    send_raw(CMsg::GetClock(pb::GetClock::default()), mono_us, device_ms)
}

fn send_raw(msg: CMsg, mono_us: i64, device_ms: i64) -> pb::ClockState {
    send_on_raw(1, msg, mono_us, device_ms)
}

fn send_on_raw(src: u8, msg: CMsg, mono_us: i64, device_ms: i64) -> pb::ClockState {
    let frame = frame_of(msg);
    let mut out = vec![0u8; 1024];
    unsafe { lm_clock_test_set_mono_us(mono_us) };
    let g = unsafe {
        lm_kiosk_gate(
            src,
            frame.as_ptr(),
            frame.len(),
            device_ms as u32,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert_eq!(g, 0);
    let n = unsafe {
        lm_player_handle(
            frame.as_ptr(),
            frame.len(),
            device_ms,
            device_ms,
            out.as_mut_ptr(),
            out.len(),
        )
    };
    assert!(n > 0);
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).unwrap();
    match reply.r#msg {
        Some(SMsg::ClockState(s)) => s,
        other => panic!("clock_state expected, got {other:?}"),
    }
}

/// Enable / disable the kiosk: on, a wss/BLE connection is a locked visitor.
fn seed_kiosk(enabled: bool) {
    // An enabled kiosk needs an owner secret (the record refuses one without).
    let mut cfg = ledmapper_player_ffi::kiosk_ffi::Config {
        enabled,
        secret_len: 4,
        ..ledmapper_player_ffi::kiosk_ffi::DEFAULT_CONFIG
    };
    cfg.secret[..4].copy_from_slice(b"pass");
    let rec = ledmapper_player_ffi::kiosk_ffi::encode(&cfg);
    unsafe { lm_kiosk_seed(rec.as_ptr(), rec.len()) };
}
