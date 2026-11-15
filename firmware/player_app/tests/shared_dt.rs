//! update()'s dt on the shared time base (lm_fx_clock / time_base_frame;
//! docs/design/synced-show.md, "Stateful effects"). With a time base set, dt is the
//! change in (now - epoch) since the last frame, not the local crystal's frame
//! period, so an effect that integrates (`phase += dt * speed`) accumulates the
//! same total on every player — through the bridge's 1-2 ms drift-correcting epoch
//! nudges — and players with different crystals and frame cadences stay in step.
//!
//! The FFI state is process-global (one player, as on the device); the C-ABI test
//! runs alone in this binary.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fx_clear, lm_fx_clock, lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update,
    lm_player_handle, lm_player_init, time_base_frame, TB_JUMP_SLACK_MS,
};
use micropb::{MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;

/// |a - b| within one Q16.16 tick (dt is quantized to ticks).
fn close(a: f32, b: f32) -> bool {
    (a - b).abs() <= 1.0 / 65536.0
}

#[test]
fn before_the_epoch_time_and_dt_hold_at_zero() {
    assert_eq!(time_base_frame(None, -500, 33), (0.0, 0.0));
    assert_eq!(time_base_frame(Some(0), 0, 33), (0.0, 0.0));
    // The first frame past the epoch advances by what has elapsed since it, at most
    // the frame period.
    let (t, dt) = time_base_frame(Some(0), 12, 33);
    assert!(t == 0.012 && close(dt, 0.012), "{t} {dt}");
    assert!(close(time_base_frame(None, 12, 33).1, 0.012));
    let (t, dt) = time_base_frame(None, 60_000, 33);
    assert!(t == 60.0 && close(dt, 0.033));
}

#[test]
fn dt_follows_the_shared_time_not_the_frame_period() {
    // A frame measured as 33 ms on our crystal, while (now - epoch) moved 34 ms
    // because the bridge nudged the epoch 1 ms earlier: dt is 34 ms.
    let (t, dt) = time_base_frame(Some(10_000), 10_034, 33);
    assert_eq!(t, 10.034);
    assert!(close(dt, 0.034));
    // ...and 2 ms later (a slew the other way): 31 ms.
    assert!(close(time_base_frame(Some(10_000), 10_031, 33).1, 0.031));
}

#[test]
fn dt_is_whole_q16_ticks_that_sum_to_the_elapsed_shared_time() {
    // Irregular frames (a ms clock, 25..41 ms) for ten minutes: the sum of the
    // Q16.16 dt (what `fixed(dt)` reads) is the elapsed shared time to the tick —
    // while truncating each ms/1000 frame period loses ~0.5 tick per frame.
    let (mut since, mut prev) = (5i64, None);
    let (mut fix_sum, mut trunc_sum, mut f_sum) = (0i64, 0i64, 0f64);
    let mut k = 0i64;
    while since < 600_000 {
        let wall = 25 + (k * 7919 % 17);
        since += wall;
        let (_, dt) = time_base_frame(prev, since, wall as u32);
        prev = Some(since);
        let ticks = dt * 65536.0;
        assert_eq!(ticks, ticks.trunc(), "dt {dt} is not whole ticks");
        fix_sum += ticks as i64;
        trunc_sum += ((wall as f32 / 1000.0) * 65536.0) as i64;
        f_sum += dt as f64;
        k += 1;
    }
    let first = (5i64 << 16) / 1000; // the first frame here started 5 ms past the epoch
    assert_eq!(fix_sum + first, (since << 16) / 1000);
    assert!(((since - 5) as f64 / 1000.0 - f_sum).abs() < 1e-3, "f32 dts sum {f_sum}");
    let lost = ((since - 5) << 16) / 1000 - trunc_sum;
    assert!(lost > 1000, "truncating would lose {lost} ticks over {k} frames");
}

#[test]
fn a_re_align_neither_rewinds_nor_fast_forwards_integrators() {
    // Epoch moved later by more than the frame: effect time stepped back; hold.
    assert_eq!(time_base_frame(Some(10_000), 9_000, 33).1, 0.0);
    // Epoch moved much earlier (a re-align onto an older room epoch): the wall period.
    let (t, dt) = time_base_frame(Some(1_000), 3_600_000, 33);
    assert_eq!(t, 3600.0);
    assert!(close(dt, 0.033));
    // ...but a long frame (a slow effect, 400 ms) within the slack is real time.
    assert!(close(time_base_frame(Some(1_000), 1_400, 400).1, 0.4));
    assert!(close(time_base_frame(Some(1_000), 1_000 + 33 + TB_JUMP_SLACK_MS + 1, 33).1, 0.033));
}

/// One simulated player: a crystal `ppm` fast, frames every `frame_ms` of ITS clock
/// starting at `phase_ms`, an epoch the bridge keeps correcting. Integrates
/// `phase += dt * speed` per frame (in f64 so the test sees the clock, not float
/// rounding) and returns (shared hub time of the last frame, phase), for frames
/// up to hub time `until_ms`.
fn integrate(ppm: f64, frame_ms: f64, phase_ms: f64, until_ms: f64, shared_dt: bool) -> (f64, f64) {
    let rate = 1.0 + ppm * 1e-6;
    let dev = |h: f64| (h * rate).floor() as i64; // millis() at hub time h
    let speed = 1.0;
    // The bridge's view: epoch = hub epoch 0 in the player's clock, re-derived every
    // 30 s and slewed toward in <= 2 ms steps (exactly what TimeDiscipline does).
    let mut epoch: i64 = 0;
    let mut next_fix = 30_000.0;
    let mut prev_since: Option<i64> = None;
    let mut last_dev: Option<i64> = None;
    let mut phase = 0.0f64;
    let mut h = phase_ms;
    let mut last_h = h;
    while h <= until_ms {
        while h >= next_fix {
            let want = (next_fix * rate).round() as i64 - next_fix.round() as i64;
            let err = epoch - want;
            epoch -= err.clamp(-2, 2);
            next_fix += if err.abs() > 2 { 5_000.0 } else { 30_000.0 };
        }
        let now = dev(h);
        let wall = last_dev.map_or(33, |l| (now - l) as u32);
        last_dev = Some(now);
        let dt = if shared_dt {
            let since = now - epoch;
            let (_, dt) = time_base_frame(prev_since, since, wall);
            prev_since = Some(since.max(0));
            dt as f64
        } else {
            wall as f64 / 1000.0
        };
        phase += dt * speed;
        last_h = h;
        h += frame_ms / rate; // frame_ms of the player's clock, in hub time
    }
    (last_h, phase)
}

#[test]
fn integrated_phases_stay_in_step_across_drifting_players() {
    let hour = 3_600_000.0;
    // Three players: crystals -60 / +5 / +70 ppm, different frame cadences and frame
    // phase, all on one room epoch, integrating dt for an hour.
    let players = [(-60.0, 33.0, 0.0), (5.0, 25.0, 7.0), (70.0, 40.0, 13.0)];
    for shared in [true, false] {
        let mut worst: f64 = 0.0;
        for &(ppm, frame, ph) in &players {
            let (h, phase) = integrate(ppm, frame, ph, hour, shared);
            // In step = phase equals the shared time (s) at that frame.
            worst = worst.max((phase - h / 1000.0).abs());
        }
        if shared {
            // Within the slew's lag (a few ms) — not growing with the hour.
            assert!(worst < 0.006, "shared-time dt: worst {worst} s off after an hour");
        } else {
            // Local frame periods: each integrates its own crystal (~0.2 s/hour at 70 ppm).
            assert!(worst > 0.2, "local dt drifts: worst only {worst} s");
        }
    }
}

fn handle(msg: CMsg) {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 4096>::new());
    env.encode(&mut enc).unwrap();
    let frame = enc.into_writer().to_vec();
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
}

#[test]
fn c_abi_render_loop_hands_update_the_shared_dt() {
    // The render loop's sequence (main.cpp): measure dt, lm_fx_clock, lm_fx_update.
    lm_player_init(4);
    unsafe { lm_fx_clear() };
    let src = "state float phase;\n\
         void update() { phase = phase + dt; }\n\
         vec3 shade(Led led) { return vec3(fract(phase), fract(time), 0.0); }\n";
    let fxb = ledmapper_fx_compiler::compile(src).expect("compiles").fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };

    let (mut t, mut dt) = (0.0f32, 0.033f32);
    // No time base: lm_fx_clock leaves the local clock alone.
    assert!(!unsafe { lm_fx_clock(1_000, 33, &mut t, &mut dt) });
    assert_eq!((t, dt), (0.0, 0.033));

    handle(CMsg::SetTimeBase(pb::SetTimeBase { r#epoch_ms: 10_000, ..Default::default() }));
    let mut frame = 0u32;
    let mut run = |now: i64, wall: u32| -> (f32, f32) {
        let (mut t, mut dt) = (0.0f32, wall as f32 / 1000.0);
        assert!(unsafe { lm_fx_clock(now, wall, &mut t, &mut dt) });
        assert!(unsafe { lm_fx_update(t, dt, frame, 4) });
        frame += 1;
        (t, dt)
    };
    // Before the epoch: held.
    assert_eq!(run(9_990, 33), (0.0, 0.0));
    // 16 frames of 1/32 s past the epoch, with the epoch nudged 2 ms earlier at frame 8:
    // the phase integrates exactly (now - epoch), i.e. time.
    let mut now = 10_000i64;
    for k in 0..16 {
        if k == 8 {
            handle(CMsg::SetTimeBase(pb::SetTimeBase { r#epoch_ms: 9_998, ..Default::default() }));
        }
        now += if k == 0 { 0 } else { 31 + (k % 2) as i64 }; // ~1/32 s frames on a ms clock
        run(now, 33);
    }
    let (t, _) = run(now + 31, 31);
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    // phase = time (both 0.x s): same red and green within one 8-bit step.
    assert!((t - (now + 31 - 9_998) as f32 / 1000.0).abs() < 1e-4);
    assert!((rgb[0] as i32 - rgb[1] as i32).abs() <= 1, "phase {rgb:?} != time");

    // Clearing the time base: back to the local clock.
    handle(CMsg::SetTimeBase(pb::SetTimeBase { r#clear: true, ..Default::default() }));
    let (mut t2, mut dt2) = (1.5f32, 0.02f32);
    assert!(!unsafe { lm_fx_clock(now + 100, 20, &mut t2, &mut dt2) });
    assert_eq!((t2, dt2), (1.5, 0.02));
}
