//! Playback keeps real time when the execution rate drops. When an effect (or
//! the network) eats the frame budget, the render task simply renders fewer
//! frames per second: main.cpp measures each frame's real elapsed time and hands
//! it to the player — lm_playback_step(dt_ms) for the built-in topology effects,
//! lm_fx_update(time, dt) for user effects. These tests pin the player side of
//! that adaptation: the per-frame advance scales with the measured frame period,
//! so the same wall-clock time renders the same picture whether the device
//! managed 30, 10 or 3 frames per second — a slower execution rate never slows,
//! speeds up or desynchronizes playback.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fx_clear, lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update, lm_playback_color,
    lm_playback_step, lm_player_handle, lm_player_init,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

const MAP_ID: &str = "m-rate";
/// LEDs on the fixture: 10 per arm of a Y, every 10 cm along each 1 m arm.
const LEDS: u32 = 30;

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn handle(frame: &[u8]) -> Option<SMsg> {
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "lm_player_handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn expect_result_ready(reply: Option<SMsg>, what: &str) {
    match reply {
        Some(SMsg::ResultReady(r)) => assert_eq!(r.r#map_id.as_str(), MAP_ID),
        other => panic!("{what} must be stored, got {other:?}"),
    }
}

/// A fresh device holding a Y fixture (three 1 m arms meeting at one junction)
/// with a flood effect at 1 m/s configured on it.
fn boot_with_flood() {
    lm_player_init(LEDS);
    unsafe { lm_fx_clear() };

    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = MAP_ID.parse().unwrap();
    map.r#led_count = LEDS as i32;
    for i in 0..LEDS {
        let mut led = pb::LedEntry { r#id: i as i32, ..Default::default() };
        led.r#xyz.extend_from_slice(&[i as f64 * 0.01, 0.0, 0.0]).unwrap();
        map.r#leds.push(led).unwrap();
    }
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    expect_result_ready(handle(&encode(CMsg::SubmitMap(submit))), "map");

    let mut topo = Box::new(pb::Topology { r#map_id: MAP_ID.parse().unwrap(), ..Default::default() });
    let mut junction = pb::BranchPoint { r#id: 0, ..Default::default() };
    junction.r#xyz.extend_from_slice(&[0.0, 0.0, 0.0]).unwrap();
    topo.r#branch_points.push(junction).unwrap();
    for sid in [10, 11, 12] {
        let seg = pb::TopologySegment { r#id: sid, r#a: 0, r#b: -1, r#length: 1.0, ..Default::default() };
        topo.r#segments.push(seg).unwrap();
    }
    for i in 0..LEDS {
        let a = pb::LedAssociation {
            r#led_id: i as i32,
            r#segment_id: 10 + (i % 3) as i32,
            r#foot_arclength: (i / 3) as f64 * 0.1,
            ..Default::default()
        };
        topo.r#associations.push(a).unwrap();
    }
    let mut submit = pb::SubmitTopology::default();
    submit.set_topology(*topo);
    expect_result_ready(handle(&encode(CMsg::SubmitTopology(submit))), "topology");

    let mut params = pb::PlaybackParams::default();
    params.set_intensity(1.0);
    params.set_speed(1.0); // m/s
    params.set_glow_radius(0.05);
    params.set_decay(0.4);
    let mut sp = pb::SetPlayback::default();
    sp.r#effect = "flood".parse().unwrap();
    sp.set_params(params);
    match handle(&encode(CMsg::SetPlayback(sp))) {
        Some(SMsg::PlaybackState(_)) => {}
        other => panic!("set_playback replies playback_state, got {other:?}"),
    }
}

/// Run the flood for `frames` frames of `dt_ms` each, as render_once does (one
/// lm_playback_step per frame), and return the LED colours of the last frame.
fn flood_after(frames: u32, dt_ms: u32) -> Vec<[u8; 3]> {
    boot_with_flood();
    for _ in 0..frames {
        assert!(unsafe { lm_playback_step(dt_ms) }, "the flood is renderable");
    }
    (0..LEDS)
        .map(|i| {
            let mut rgb = [0u8; 3];
            assert!(unsafe { lm_playback_color(i, rgb.as_mut_ptr()) }, "LED {i} is associated");
            rgb
        })
        .collect()
}

#[test]
fn a_flood_shows_the_same_picture_at_the_same_time_at_any_frame_rate() {
    rr::verifies!("PR-19");
    // 990 ms of playback reached at ~30 fps, ~10 fps, ~3 fps and in one step.
    let at_30fps = flood_after(30, 33);
    let at_10fps = flood_after(10, 99);
    let at_3fps = flood_after(3, 330);
    let one_step = flood_after(1, 990);
    // Non-vacuous: the wavefront has lit part of the fixture by then, and the
    // picture has moved on from half-way (the playback really advanced in time).
    assert!(at_30fps.iter().any(|c| *c != [0, 0, 0]), "the flood lit something: {at_30fps:?}");
    assert_ne!(at_30fps, flood_after(15, 33), "playback advanced between 495 ms and 990 ms");
    assert_eq!(at_10fps, at_30fps, "10 fps renders the 30 fps picture at the same time");
    assert_eq!(at_3fps, at_30fps, "3 fps renders the 30 fps picture at the same time");
    assert_eq!(one_step, at_30fps);
}

/// A user effect that integrates the frame period it is handed.
const DT_DRIVEN: &str = "state float phase;\n\
     void update() { phase = phase + dt; }\n\
     vec3 shade(Led led) { return vec3(fract(phase), 0.0, 0.0); }\n";

/// Render `frames` frames of `dt` seconds through the FX path exactly as
/// render_once does (time accumulates the measured dt; update then shade) and
/// return LED 0's colour.
fn effect_after(frames: u32, dt: f32) -> [u8; 3] {
    lm_player_init(LEDS);
    unsafe { lm_fx_clear() };
    let fxb = ledmapper_fx_compiler::compile(DT_DRIVEN)
        .unwrap_or_else(|d| panic!("effect compiles: {d:?}"))
        .fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    let mut time = 0.0f32;
    let mut rgb = [0u8; 3];
    for frame in 0..frames {
        time += dt;
        assert!(unsafe { lm_fx_update(time, dt, frame, LEDS) });
        assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    }
    rgb
}

#[test]
fn a_user_effect_driven_by_the_frame_period_keeps_real_time_at_any_frame_rate() {
    rr::verifies!("PR-19");
    // 0.75 s of playback (binary-exact frame periods, so no rounding noise) at
    // 32, 8 and 4 frames per second.
    let at_32fps = effect_after(24, 1.0 / 32.0);
    let at_8fps = effect_after(6, 1.0 / 8.0);
    let at_4fps = effect_after(3, 1.0 / 4.0);
    assert_eq!(at_32fps, [191, 0, 0], "phase 0.75 after 0.75 s");
    assert_eq!(at_8fps, at_32fps, "8 fps reaches the same phase in the same time");
    assert_eq!(at_4fps, at_32fps, "4 fps reaches the same phase in the same time");
    // ...and half the wall time is half the phase, whatever the rate.
    assert_eq!(effect_after(12, 1.0 / 32.0), [95, 0, 0]);
    assert_eq!(effect_after(3, 1.0 / 8.0), [95, 0, 0]);
}
