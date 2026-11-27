//! The wall clock's effect uniforms (uniform_pool.rs CLOCK_ENTRIES) through the
//! C ABI: an effect declaring `clock`, `clock_day`, `clock_date`, `clock_valid`
//! keeps its UI values while the lamp's clock is unset, then sees LOCAL time
//! (the lamp's POSIX zone) once a time arrives, extrapolated per frame from the
//! loop task's cache, across local midnight.
//!
//! Own binary: the player and the clock are process-global.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::clock_ffi::{lm_clock_test_set_mono_us, lm_clock_tick};
use ledmapper_player_ffi::{lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update, lm_player_handle, lm_player_init};
use micropb::{MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;

/// 2026-11-25T22:59:58Z (a Wednesday), ms. 23:59:58 in CET.
const T0_MS: i64 = 1_795_647_598_000;

fn send(msg: CMsg, now_ms: i64) {
    unsafe { lm_clock_test_set_mono_us(now_ms * 1000) };
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 1024>::new());
    env.encode(&mut enc).unwrap();
    let frame = enc.into_writer().to_vec();
    let mut out = vec![0u8; 1024];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), now_ms, now_ms, out.as_mut_ptr(), out.len()) };
    assert!(n > 0);
}

/// Each output channel reads one value; the test shades LED `i` for value `i`.
const EFFECT: &str = r#"
uniform vec4 clock = 9.0, 9.0, 9.0, 9.0;
uniform float clock_day : 0.0 .. 1.0 = 0.5;
uniform vec3 clock_date = 1.0, 1.0, 1.0;
uniform float clock_valid : 0.0 .. 1.0 = 0.5;
uniform float pick : 0.0 .. 16.0 = 0.0;
vec3 shade(Led led) {
  // Encode one value per LED (led.pos.x = which), scaled into 0..1.
  float w = led.pos.x;
  float v = clock_valid;
  if (w < 7.5) { v = clock_date.z / 31.0; }
  if (w < 6.5) { v = clock_date.y / 12.0; }
  if (w < 5.5) { v = (clock_date.x - 2000.0) / 100.0; }
  if (w < 4.5) { v = clock_day; }
  if (w < 3.5) { v = clock.w / 7.0; }
  if (w < 2.5) { v = clock.z / 60.0; }
  if (w < 1.5) { v = clock.y / 60.0; }
  if (w < 0.5) { v = clock.x / 24.0; }
  return vec3(v, v, v);
}
"#;

/// The values the effect sees at device ms `now_ms` (render reads the fake
/// esp_timer too), decoded from 9 shaded LEDs.
fn read(now_ms: i64) -> [f32; 9] {
    unsafe { lm_clock_test_set_mono_us(now_ms * 1000) };
    assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 9) });
    let mut o = [0f32; 9];
    for (i, v) in o.iter_mut().enumerate() {
        let mut rgb = [0u8; 3];
        assert!(unsafe { lm_fx_shade(i as u32, i as f32, 0.0, 0.0, rgb.as_mut_ptr()) });
        *v = rgb[0] as f32 / 255.0;
    }
    o
}

fn near(a: f32, b: f32, tol: f32) -> bool {
    (a - b).abs() <= tol
}

#[test]
fn clock_uniforms_follow_the_lamps_local_time() {
    lm_player_init(16);
    let fxb = ledmapper_fx_compiler::compile(EFFECT).expect("compiles").fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    let tol = 1.5 / 255.0;

    // Unset clock: every clock uniform keeps its UI value except clock_valid = 0.
    let v = read(1_000);
    assert!(near(v[0], 9.0 / 24.0, tol) && near(v[4], 0.5, tol), "UI values kept {v:?}");
    assert!(near(v[8], 0.0, tol), "clock_valid = 0 {v:?}");

    // The app pushes UTC and the CET zone.
    let mut m = pb::SetWallClock { unix_ms: T0_MS, err_ms: 5, r#pushed_by: pb::WallClockPusher::App, ..Default::default() };
    m.set_tz(micropb::heapless::String::try_from("CET-1CEST,M3.5.0,M10.5.0/3").unwrap());
    send(CMsg::SetWallClock(m), 2_000);
    unsafe { lm_clock_tick(core::ptr::null_mut()) };

    // 23:59:58 local, Wednesday 2026-11-25.
    let v = read(2_000);
    assert!(near(v[0], 23.0 / 24.0, tol), "hour {v:?}");
    assert!(near(v[1], 59.0 / 60.0, tol), "minute {v:?}");
    assert!(near(v[2], 58.0 / 60.0, tol), "second {v:?}");
    assert!(near(v[3], 3.0 / 7.0, tol), "weekday {v:?}");
    assert!(near(v[4], 86_398.0 / 86_400.0, tol), "clock_day {v:?}");
    assert!(near(v[5], 0.26, tol) && near(v[6], 11.0 / 12.0, tol) && near(v[7], 25.0 / 31.0, tol), "date {v:?}");
    assert!(near(v[8], 1.0, tol), "valid {v:?}");

    // Render extrapolates between loop-task refreshes: 1.5 s later, no tick.
    let v = read(3_500);
    assert!(near(v[2], 59.5 / 60.0, tol), "second extrapolated {v:?}");

    // Past local midnight before the loop refreshes: time of day and weekday wrap.
    let v = read(4_500);
    assert!(near(v[0], 0.0, tol) && near(v[1], 0.0, tol) && near(v[3], 4.0 / 7.0, tol), "wrapped {v:?}");
    // The loop task's refresh brings the new date.
    unsafe { lm_clock_test_set_mono_us(4_500_000) };
    unsafe { lm_clock_tick(core::ptr::null_mut()) };
    let v = read(4_500);
    assert!(near(v[7], 26.0 / 31.0, tol) && near(v[3], 4.0 / 7.0, tol), "new date {v:?}");
    assert!(near(v[4], 0.5 / 86_400.0, tol), "clock_day restarts at 0 {v:?}");

    // An esp_timer step back (the C6's 2^24-tick quirk) never moves the clock backwards
    // in an effect: render clamps, and the loop task re-anchors through its guard.
    let v = read(4_400);
    assert!(near(v[0], 0.0, tol) && near(v[3], 4.0 / 7.0, tol), "{v:?}");
}
