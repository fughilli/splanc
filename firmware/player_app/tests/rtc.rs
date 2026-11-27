//! The hardware RTC (rtc_ffi.rs) through the C ABI, over register-file chip fakes
//! on a fake I2C bus: no chip changes nothing; a chip that lost time is filled by
//! the first good push; a chip with a kept time sets the clock at boot and is
//! written back when a better source disagrees (at its set phase, verified by a
//! read, throttled, forced by write_rtc); set_clock_config re-detects / turns it
//! off; and a player module offers / reads the time (lm_clock_offer / lm_clock_now).
//!
//! One test function: the clock and the RTC are process-global, like the firmware's.

#[path = "../../rtc/tests/fake_rtc.rs"]
mod fake_rtc;

use core::ffi::c_void;
use fake_rtc::{Bus, FakeRtc, Kind};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::clock_ffi::{
    lm_clock_now, lm_clock_offer, lm_clock_status_line, lm_clock_test_reset,
    lm_clock_test_set_mono_us, lm_clock_tick,
};
use ledmapper_player_ffi::rtc_ffi::{
    lm_rtc_begin, lm_rtc_configure, lm_rtc_persist, lm_rtc_poll, lm_rtc_status_line,
    lm_rtc_test_reset, lm_rtc_wants_bus, PERSIST_CFG, PERSIST_WB,
};
use ledmapper_player_ffi::{lm_player_handle, lm_sensor_set_ops, LmI2cOps, FEATURES};
use ledmapper_sensor::{BusError, I2cBus};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

const S: i64 = 1_000_000;
/// 2026-11-25T12:34:56Z.
const T: i64 = 1_795_610_096;

static mut BUS: Option<Bus> = None;
/// The first chip ticks like the real part: (seconds, at mono µs, phase µs) since
/// its last time write (the fakes are register files with no clock of their own).
static mut TICK: Option<(i64, i64, i64)> = None;

fn bus() -> &'static mut Bus {
    unsafe { (*core::ptr::addr_of_mut!(BUS)).as_mut().unwrap() }
}

unsafe extern "C" fn wr(
    _: *mut c_void,
    addr: u8,
    w: *const u8,
    wn: usize,
    r: *mut u8,
    rn: usize,
) -> i32 {
    match bus().write_read(
        addr,
        core::slice::from_raw_parts(w, wn),
        core::slice::from_raw_parts_mut(r, rn),
    ) {
        Ok(()) => 0,
        Err(BusError::Nack) => 1,
        Err(_) => 2,
    }
}

unsafe extern "C" fn w(_: *mut c_void, addr: u8, b: *const u8, n: usize) -> i32 {
    match bus().write(addr, core::slice::from_raw_parts(b, n)) {
        Ok(()) => 0,
        Err(BusError::Nack) => 1,
        Err(_) => 2,
    }
}

static mut OPS: LmI2cOps = LmI2cOps {
    ctx: core::ptr::null_mut(),
    write_read: Some(wr),
    write: Some(w),
    cycles: None,
};

/// A cold boot with `chips` on the bus: fresh clock + RTC state, the persisted
/// config / last write-back, then sensor_bus.cpp's lm_rtc_begin.
fn boot(chips: Vec<FakeRtc>, cfg: u16, last_wb: i64, mono_us: i64) -> u8 {
    unsafe {
        BUS = Some(Bus {
            rtcs: chips,
            ..Default::default()
        });
        TICK = None;
        lm_clock_test_reset();
        lm_rtc_test_reset();
        lm_clock_test_set_mono_us(mono_us);
        lm_sensor_set_ops(core::ptr::addr_of!(OPS));
        lm_rtc_configure(cfg, last_wb);
        lm_rtc_begin(mono_us)
    }
}

/// The register holding a chip's seconds, and when its first tick follows a write.
fn time_reg(k: Kind) -> (u8, i64) {
    match k {
        Kind::Pcf8563 => (0x02, 492_000), // STOP released: first tick ~0.508 s later
        _ => (0x00, 0),                   // the divider restarts: first tick 1 s later
    }
}

/// Moves the first chip's time registers to mono `us`.
fn advance(us: i64) {
    let Some((base, at, phase)) = (unsafe { TICK }) else {
        return;
    };
    let f = bus().rtc();
    let secs = base + (us - at + phase).div_euclid(S);
    let x = ledmapper_rtc::Fields::from_unix(secs).unwrap();
    let b = ledmapper_rtc::to_bcd;
    match f.kind {
        Kind::Pcf8563 => {
            let vl = f.regs[0x02] & 0x80;
            f.poke(
                0x02,
                &[
                    vl | b(x.second),
                    b(x.minute),
                    b(x.hour),
                    b(x.day),
                    x.wday,
                    b(x.month),
                    b(x.yy),
                ],
            );
        }
        Kind::Ds3231 => f.poke(
            0x00,
            &[
                b(x.second),
                b(x.minute),
                b(x.hour),
                x.wday + 1,
                b(x.day),
                b(x.month),
                b(x.yy),
            ],
        ),
        Kind::Rv3028 => f.poke(
            0x00,
            &[
                b(x.second),
                b(x.minute),
                b(x.hour),
                x.wday,
                b(x.day),
                b(x.month),
                b(x.yy),
            ],
        ),
    }
}

/// One loop pass at monotonic `us`: the RTC poll (no mutex), then the clock tick.
fn pass(us: i64) -> u32 {
    advance(us);
    let before = bus().rtcs.first().map(|r| r.writes.len()).unwrap_or(0);
    unsafe {
        lm_clock_test_set_mono_us(us);
        let bits = lm_rtc_poll(us, true);
        if let Some(r) = bus().rtcs.first() {
            let (reg, phase) = time_reg(r.kind);
            if r.writes[before..].iter().any(|&(w, _)| w == reg) {
                TICK = Some((chip_secs(r), us, phase));
            }
        }
        let mut carry = [0u8; 28];
        lm_clock_tick(carry.as_mut_ptr());
        bits
    }
}

fn handle(msg: CMsg, us: i64) -> pb::ClockState {
    unsafe { lm_clock_test_set_mono_us(us) };
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 1024>::new());
    env.encode(&mut enc).unwrap();
    let frame = enc.into_writer().to_vec();
    let mut out = vec![0u8; 1024];
    let ms = us / 1000;
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

fn get(us: i64) -> pb::ClockState {
    handle(CMsg::GetClock(pb::GetClock::default()), us)
}

fn rtc_of(st: &pb::ClockState) -> pb::RtcState {
    st.rtc().cloned().unwrap_or_default()
}

/// set_wall_clock: UTC `unix_ms` true now, ± `err_ms`.
fn push(unix_ms: i64, err_ms: u32, write_rtc: bool, us: i64) -> pb::ClockState {
    let m = pb::SetWallClock {
        unix_ms,
        err_ms,
        r#pushed_by: pb::WallClockPusher::App,
        write_rtc,
        ..Default::default()
    };
    handle(CMsg::SetWallClock(m), us)
}

fn config(chip: Option<pb::RtcChip>, addr: Option<u32>, us: i64) -> pb::ClockState {
    let mut m = pb::SetClockConfig::default();
    if let Some(c) = chip {
        m.set_rtc_chip(c);
    }
    if let Some(a) = addr {
        m.set_rtc_addr(a);
    }
    handle(CMsg::SetClockConfig(m), us)
}

fn rtc_line() -> String {
    let mut b = [0u8; 256];
    let n = unsafe { lm_rtc_status_line(b.as_mut_ptr(), b.len()) };
    String::from_utf8_lossy(&b[..n]).into_owned()
}

fn clock_line() -> String {
    let mut b = [0u8; 256];
    let n = unsafe { lm_clock_status_line(b.as_mut_ptr(), b.len()) };
    String::from_utf8_lossy(&b[..n]).into_owned()
}

fn persist() -> (u32, u16, i64) {
    let (mut c, mut wb) = (0u16, 0i64);
    let bits = unsafe { lm_rtc_persist(&mut c, &mut wb) };
    (bits, c, wb)
}

/// Passes every 5 ms from `from` until `until` (µs).
fn run(from: i64, until: i64) {
    let mut t = from;
    while t < until {
        pass(t);
        t += 5_000;
    }
}

/// Seconds held in a fake chip's BCD time registers (DS3231 / RV-3028 layout at 0x00).
fn chip_secs(f: &FakeRtc) -> i64 {
    let off = if f.kind == Kind::Pcf8563 { 2 } else { 0 };
    let r = &f.regs[off..off + 7];
    let b = |v: u8| ((v >> 4) * 10 + (v & 0xF)) as u8;
    let (day, month, yy) = if f.kind == Kind::Pcf8563 {
        (r[3], r[5], r[6])
    } else {
        (r[4], r[5], r[6])
    };
    ledmapper_rtc::Fields {
        yy: b(yy),
        month: b(month & 0x1F),
        day: b(day & 0x3F),
        hour: b(r[2] & 0x3F),
        minute: b(r[1] & 0x7F),
        second: b(r[0] & 0x7F),
        wday: 0,
    }
    .to_unix()
    .unwrap()
}

#[test]
fn hardware_rtc_through_the_c_abi() {
    assert!(FEATURES.contains(&"rtc"));

    // -- No chip: nothing changes. -----------------------------------------------------
    assert_eq!(boot(vec![], 0, 0, S), 0);
    assert_eq!(pass(S), 1, "one [rtc] line at boot");
    assert_eq!(rtc_line(), "[rtc] none (auto)");
    let st = get(S);
    assert!(!st.r#valid);
    let r = rtc_of(&st);
    assert!(!r.r#present);
    assert_eq!(
        (r.r#chip, r.r#configured),
        (pb::RtcChip::Auto, pb::RtcChip::Auto)
    );
    let st = push(T * 1000, 5, true, 2 * S);
    assert_eq!(st.r#source, pb::ClockSource::Push);
    run(2 * S, 10 * S);
    assert!(
        bus().log.iter().all(|&(_, _, w)| !w),
        "no chip: nothing written, ever"
    );
    assert_eq!(persist().0, 0, "and nothing persisted");
    assert!(!clock_line().contains("rtc="));
    assert_eq!(get(10 * S).r#source, pb::ClockSource::Push);

    // -- An RV-3028 that lost time (PORF): filled by the first good push. ----------------
    assert_eq!(boot(vec![FakeRtc::new(Kind::Rv3028)], 0, 0, S), 3);
    pass(S);
    let st = get(S);
    assert!(!st.r#valid, "a lost-time chip is not a source");
    let r = rtc_of(&st);
    assert!(r.r#present && !r.r#time_valid && r.r#battery_low);
    assert_eq!((r.r#chip, r.r#addr), (pb::RtcChip::Rv3028, 0x52));
    assert!(bus().rtc().writes.is_empty(), "boot writes nothing");
    // The push lands 400 ms into a second; the write waits for the next second's start.
    push(T * 1000 + 400, 5, false, 2 * S);
    pass(2 * S);
    assert!(bus().rtc().writes.is_empty(), "not mid-second");
    run(2 * S, 2 * S + 590_000);
    assert!(
        bus().rtc().writes.is_empty(),
        "still before the second boundary"
    );
    run(2 * S + 590_000, 2 * S + 640_000);
    assert_eq!(chip_secs(bus().rtc()), T + 1, "written at the start of T+1");
    let (bits, _, wb) = persist();
    assert_eq!((bits, wb), (PERSIST_WB, T + 1));
    assert!(
        rtc_line().contains("last_write=chip-lost-time"),
        "{}",
        rtc_line()
    );
    // The verify read 2 s later: kept time now, the offset within the half second.
    run(2 * S + 640_000, 5 * S);
    let r = rtc_of(&get(5 * S));
    assert!(r.r#time_valid);
    assert_eq!(r.r#writes, 1);
    assert!(r.r#offset_ms.abs() <= 600, "offset {}", r.r#offset_ms);
    assert!(clock_line().contains("rtc=RV-3028"), "{}", clock_line());
    // No more writes while it agrees.
    run(5 * S, 20 * S);
    assert_eq!(rtc_of(&get(20 * S)).r#writes, 1);

    // -- A DS3231 with a kept time: the clock's source at boot. ----------------------------
    let mut ds = FakeRtc::new(Kind::Ds3231);
    ds.poke(0x00, &[0x56, 0x34, 0x12, 0x04, 0x25, 0x11, 0x26]); // T
    ds.regs[0x0F] = 0x08; // OSF clear
    assert_eq!(boot(vec![ds], 0, T - 86_400, S), 1);
    unsafe { TICK = Some((T, S - 500_000, 0)) }; // second T began 0.5 s before the read
    pass(S);
    let st = get(S);
    assert!(st.r#valid);
    assert_eq!(st.r#source, pb::ClockSource::HwRtc);
    assert_eq!(
        st.r#unix_ms,
        T * 1000 + 500,
        "the middle of the read second"
    );
    assert_eq!(st.r#err_ms, 500 + 172, "±0.5 s + 2 ppm × 1 day");
    let r = rtc_of(&st);
    assert!(r.r#time_valid && !r.r#battery_low && r.r#has_temp);
    assert_eq!(r.r#temp_cc, 2525);
    assert_eq!(r.r#since_write_s, 86_400);
    run(S, 5 * S);
    assert!(
        bus().rtc().writes.is_empty(),
        "the chip is the source: no write-back to itself"
    );
    // A better source 3 s ahead: drifted -> written back (at a second's start).
    push((T + 4) * 1000 + 500 + 3000, 5, false, 5 * S);
    run(5 * S, 7 * S);
    assert_eq!(rtc_of(&get(7 * S)).r#writes, 1);
    assert!(rtc_line().contains("last_write=drifted"), "{}", rtc_line());
    run(7 * S, 10 * S); // verify read
    let r = rtc_of(&get(10 * S));
    assert!(r.r#offset_ms.abs() <= 600, "offset {}", r.r#offset_ms);
    assert_eq!(
        get(10 * S).r#source,
        pb::ClockSource::Push,
        "the push stays the source"
    );
    // Inside 10 min of that write another disagreement is held off...
    push((T + 9) * 1000 + 500 + 5000, 5, false, 10 * S);
    run(10 * S, 15 * S);
    assert_eq!(rtc_of(&get(15 * S)).r#writes, 1, "throttled");
    // ...but write_rtc forces it.
    push((T + 14) * 1000 + 500 + 5000, 5, true, 15 * S);
    run(15 * S, 20 * S);
    assert_eq!(rtc_of(&get(20 * S)).r#writes, 2);
    assert!(rtc_line().contains("last_write=forced"), "{}", rtc_line());

    // -- set_clock_config: off, then auto again. --------------------------------------------
    let st = config(Some(pb::RtcChip::Off), None, 20 * S);
    assert_eq!(rtc_of(&st).r#configured, pb::RtcChip::Off, "shown at once");
    pass(20 * S); // the tick hands it to the RTC side
    assert!(!unsafe { lm_rtc_wants_bus() }, "off needs no bus");
    pass(20 * S + 5_000);
    let r = rtc_of(&get(21 * S));
    assert!(!r.r#present);
    assert_eq!(rtc_line(), "[rtc] none (off)");
    let (bits, cfg, _) = persist();
    assert_eq!(bits & PERSIST_CFG, PERSIST_CFG);
    assert_eq!(cfg, 15);
    let n = bus().log.len();
    run(21 * S, 25 * S);
    assert_eq!(bus().log.len(), n, "off: the bus is never touched");
    config(Some(pb::RtcChip::Auto), None, 25 * S);
    pass(25 * S);
    assert!(unsafe { lm_rtc_wants_bus() });
    pass(25 * S + 5_000);
    assert!(rtc_of(&get(26 * S)).r#present);
    assert_eq!(persist().1, 0);
    // A forced chip + address: the address alone then moves it.
    config(Some(pb::RtcChip::Ds3231), Some(0x68), 26 * S);
    config(None, Some(0x69), 26 * S);
    pass(26 * S);
    pass(26 * S + 5_000);
    let r = rtc_of(&get(27 * S));
    assert_eq!(
        (r.r#configured, r.r#configured_addr),
        (pb::RtcChip::Ds3231, 0x69)
    );
    assert!(!r.r#present, "nothing ACKs at 0x69");

    // -- A PCF8563: written 492 ms into the second (its first tick comes 508 ms later). --
    let mut pcf = FakeRtc::new(Kind::Pcf8563);
    pcf.regs[0x00] = 0x00;
    assert_eq!(boot(vec![pcf], 0, 0, S), 2);
    pass(S);
    push(T * 1000, 5, false, 2 * S); // the second starts at mono 2 s
    run(2 * S, 2 * S + 480_000);
    assert!(bus().rtc().writes.is_empty());
    run(2 * S + 480_000, 2 * S + 530_000);
    assert_eq!(chip_secs(bus().rtc()), T, "T, written at T + 0.492 s");

    // -- Module time sources (player_module.h). ------------------------------------------
    assert_eq!(boot(vec![], 0, 0, S), 0);
    let (mut u, mut e) = (0i64, 0u32);
    pass(S);
    assert!(
        !unsafe { lm_clock_now(&mut u, &mut e) },
        "invalid until a source"
    );
    assert_eq!(
        unsafe { lm_clock_offer(T * 1000, S, 0, 1) },
        -1,
        "an error bound is required"
    );
    assert_eq!(
        unsafe { lm_clock_offer(T * 1000, S, 2, 9) },
        -1,
        "unknown source"
    );
    assert_eq!(
        unsafe { lm_clock_offer(T * 1000, S, 2, 1) },
        0,
        "a GNSS fix, ±2 ms"
    );
    assert_eq!(
        unsafe { lm_clock_offer(T * 1000, S, 2, 1) },
        1,
        "one waiting: busy"
    );
    pass(S + 10_000);
    let st = get(S + 10_000);
    assert_eq!(
        st.r#source,
        pb::ClockSource::Sntp,
        "a reference ranks with SNTP"
    );
    unsafe { lm_clock_test_set_mono_us(S + 1_010_000) };
    assert!(unsafe { lm_clock_now(&mut u, &mut e) });
    assert!((u - (T * 1000 + 1010)).abs() <= 1, "{u}");
    assert!((2..=3).contains(&e), "{e}");
    // Null outputs are fine.
    assert!(unsafe { lm_clock_now(core::ptr::null_mut(), core::ptr::null_mut()) });
}
