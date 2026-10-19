//! Multi-fixture room frame + shared time base through the C ABI: set_fixture_pose
//! (validated, echoed in welcome, commit flag), the FX_LED_ROOM cache read as
//! `led.room` / `room.min` / `room.max`, the unposed fallback (led.room ==
//! led.pos), and set_time_base.

use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_fixture_pose_commit, lm_fixture_pose_gen, lm_fx_load, lm_fx_set_active, lm_fx_shade,
    lm_fx_update, lm_player_handle, lm_player_init, lm_time_base, FEATURES,
};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

fn encode(msg: CMsg) -> Vec<u8> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 131072>::new());
    env.encode(&mut enc).unwrap();
    enc.into_writer().to_vec()
}

fn handle(msg: CMsg) -> Option<SMsg> {
    let frame = encode(msg);
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n >= 0, "handle returned {n}");
    if n == 0 {
        return None;
    }
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

/// LED i at (0.2 i, 0.1, 0.3).
const LEDS: usize = 4;
fn led_pos(i: usize) -> [f32; 3] {
    [0.2 * i as f32, 0.1, 0.3]
}

fn submit_map() {
    let mut map = Box::new(pb::OutputMap::default());
    map.r#map_id = "m-room".parse().unwrap();
    map.r#led_count = LEDS as i32;
    for i in 0..LEDS {
        let mut led = pb::LedEntry { r#id: i as i32, ..Default::default() };
        let p = led_pos(i);
        led.r#xyz.extend_from_slice(&[p[0] as f64, p[1] as f64, p[2] as f64]).unwrap();
        map.r#leds.push(led).unwrap();
    }
    let mut submit = pb::SubmitMap::default();
    submit.set_map(*map);
    assert!(matches!(handle(CMsg::SubmitMap(submit)), Some(SMsg::ResultReady(_))));
}

fn load(src: &str) {
    let fxb = ledmapper_fx_compiler::compile(src).expect("compiles").fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
}

/// Shade every LED (after an update) and return the RGB as 0..1 floats.
fn shade_all() -> Vec<[f32; 3]> {
    assert!(unsafe { lm_fx_update(0.0, 0.033, 0, LEDS as u32) });
    (0..LEDS)
        .map(|i| {
            let p = led_pos(i);
            let mut rgb = [0u8; 3];
            assert!(unsafe { lm_fx_shade(i as u32, p[0], p[1], p[2], rgb.as_mut_ptr()) });
            rgb.map(|c| c as f32 / 255.0)
        })
        .collect()
}

fn near(a: [f32; 3], b: [f32; 3]) -> bool {
    a.iter().zip(b).all(|(x, y)| (x - y).abs() <= 1.5 / 255.0)
}

fn pose(t: [f32; 3], q: [f32; 4], scale: f32) -> pb::FixturePose {
    let mut p = pb::FixturePose { r#scale: scale, ..Default::default() };
    p.r#room = "living".parse().unwrap();
    p.r#translation.extend_from_slice(&t).unwrap();
    p.r#rotation.extend_from_slice(&q).unwrap();
    p
}

fn set_pose(p: Option<pb::FixturePose>, commit: Option<bool>) -> Option<SMsg> {
    let mut m = pb::SetFixturePose::default();
    match p {
        Some(p) => {
            m.set_pose(p);
        }
        None => m.r#clear = true,
    }
    if let Some(c) = commit {
        m.set_commit(c);
    }
    handle(CMsg::SetFixturePose(m))
}

#[test]
fn room_frame_and_time_base() {
    lm_player_init(LEDS as u32);
    assert!(FEATURES.contains(&"fixture_pose") && FEATURES.contains(&"time_base"));
    submit_map();

    // Unposed: led.room IS led.pos (effects written for one fixture keep working),
    // and room.min/max is this fixture's own map box.
    load("vec3 shade(Led led) { return led.room; }");
    for (i, c) in shade_all().into_iter().enumerate() {
        assert!(near(c, led_pos(i)), "unposed LED {i}: {c:?}");
    }
    load("vec3 shade(Led led) { return room.max; }");
    assert!(near(shade_all()[0], [0.6, 0.1, 0.3]), "own box max");

    // Pose: t = (0.2, 0.1, 0), 90 deg about z, scale 0.5:
    // room = t + Rz90 * (0.5 p) = (0.2 - 0.05, 0.1 + 0.1 i, 0.15).
    let h = std::f32::consts::FRAC_1_SQRT_2;
    let gen0 = unsafe { lm_fixture_pose_gen() };
    let Some(SMsg::Welcome(w)) = set_pose(Some(pose([0.2, 0.1, 0.0], [0.0, 0.0, h, h], 0.5)), None)
    else {
        panic!("welcome");
    };
    let echoed = w.r#pose().expect("welcome echoes the pose");
    assert_eq!((echoed.r#room.as_str(), echoed.r#scale), ("living", 0.5));
    assert!(unsafe { lm_fixture_pose_gen() } != gen0 && unsafe { lm_fixture_pose_commit() });
    load("vec3 shade(Led led) { return led.room; }");
    for (i, c) in shade_all().into_iter().enumerate() {
        let want = [0.15, 0.1 + 0.1 * i as f32, 0.15];
        assert!(near(c, want), "posed LED {i}: {c:?} != {want:?}");
    }
    load("vec3 shade(Led led) { return room.min; }");
    assert!(near(shade_all()[0], [0.15, 0.1, 0.15]), "posed own-box min");

    // A host-supplied room box (the union over every fixture) wins.
    let mut p = pose([0.2, 0.1, 0.0], [0.0, 0.0, h, h], 0.5);
    p.r#room_min.extend_from_slice(&[0.0, 0.0, 0.0]).unwrap();
    p.r#room_max.extend_from_slice(&[0.9, 0.8, 0.7]).unwrap();
    set_pose(Some(p), Some(false));
    assert!(!unsafe { lm_fixture_pose_commit() }, "commit=false is live-only");
    load("vec3 shade(Led led) { return room.max; }");
    assert!(near(shade_all()[0], [0.9, 0.8, 0.7]));

    // Malformed poses are refused (and leave the pose as it was).
    let mut bad = pose([0.0, 0.0, 0.0], [0.0, 0.0, 0.0, 1.0], 1.0);
    bad.r#translation.pop();
    let Some(SMsg::Error(e)) = set_pose(Some(bad), None) else { panic!("error expected") };
    assert_eq!(e.r#code.as_str(), "bad_pose");

    // Clearing returns to the unposed fallback.
    let Some(SMsg::Welcome(w)) = set_pose(None, None) else { panic!("welcome") };
    assert!(w.r#pose().is_none(), "a cleared pose is no longer echoed");
    load("vec3 shade(Led led) { return led.room; }");
    assert!(near(shade_all()[2], led_pos(2)));

    // The HITL skew run's binary clock (pi/hitl/harness/ab_demo/timeBaseClock.fx):
    // LED k = bit k of floor(time / 4 ms). At t = 1.0 s, ticks = 250 = 0b11111010.
    load(include_str!("../../../pi/hitl/harness/ab_demo/timeBaseClock.fx"));
    assert!(unsafe { lm_fx_update(1.0, 0.033, 1, LEDS as u32) });
    let lit: Vec<bool> = (0..LEDS)
        .map(|i| {
            let p = led_pos(i);
            let mut rgb = [0u8; 3];
            assert!(unsafe { lm_fx_shade(i as u32, p[0], p[1], p[2], rgb.as_mut_ptr()) });
            rgb[0] > 128
        })
        .collect();
    assert_eq!(lit, vec![false, true, false, true], "250 = ...1010");

    // Shared time base: stored (device-clock ms), echoed, clearable.
    let mut epoch = 0i64;
    assert!(!unsafe { lm_time_base(&mut epoch) });
    let Some(SMsg::Welcome(w)) = handle(CMsg::SetTimeBase(pb::SetTimeBase { r#epoch_ms: 123_456, ..Default::default() }))
    else {
        panic!("welcome");
    };
    assert_eq!(w.r#time_base_ms().copied(), Some(123_456));
    assert!(unsafe { lm_time_base(&mut epoch) } && epoch == 123_456);
    handle(CMsg::SetTimeBase(pb::SetTimeBase { r#clear: true, ..Default::default() }));
    assert!(!unsafe { lm_time_base(&mut epoch) });
}
