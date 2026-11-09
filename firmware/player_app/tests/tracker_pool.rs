//! lm_pool_publish (the P4 player's wired tracker -> uniform pool): an effect declaring
//! `uniform vec3 tracker_pos` keeps its default until a value is published, then sees it
//! every frame; a later publish replaces it.

use ledmapper_player_ffi::{lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update, lm_player_init};

extern "C" {
    fn lm_pool_publish(name: *const u8, name_len: usize, vals: *const f32, n: usize) -> bool;
}

const EFFECT: &str = r#"
uniform vec3 tracker_pos = 0.0, 0.0, 0.0;
uniform float tracker_ok : 0.0 .. 1.0 = 0.0;
vec3 shade(Led led) {
  return vec3(tracker_pos.x, tracker_pos.y, tracker_ok);
}
"#;

// A mat4 entry (the tracker module's `pose`, column-major) drives a mat4 uniform whole.
const MAT_EFFECT: &str = r#"
uniform mat4 pose;
vec3 shade(Led led) {
  return vec3(pose[3].x, pose[3].y, pose[1].x);
}
"#;

fn shade0() -> [f32; 3] {
    assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 1) });
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    rgb.map(|c| c as f32 / 255.0)
}

fn publish(name: &str, vals: &[f32]) -> bool {
    unsafe { lm_pool_publish(name.as_ptr(), name.len(), vals.as_ptr(), vals.len()) }
}

/// One process-global player: everything in one test, in order.
#[test]
fn pool_values_reach_the_effect() {
    lm_player_init(16);
    let fxb = ledmapper_fx_compiler::compile(EFFECT).expect("compiles").fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    let c = shade0();
    assert!(c.iter().all(|v| *v < 0.01), "defaults before any publish: {c:?}");

    assert!(publish("tracker_pos", &[0.25, 0.5, 0.75]));
    assert!(publish("tracker_ok", &[1.0]));
    let c = shade0();
    assert!((c[0] - 0.25).abs() < 0.01 && (c[1] - 0.5).abs() < 0.01 && c[2] > 0.99, "published {c:?}");

    assert!(publish("tracker_ok", &[0.0]));
    let c = shade0();
    assert!(c[2] < 0.01 && (c[0] - 0.25).abs() < 0.01, "ok cleared, pos held: {c:?}");

    assert!(!publish("", &[1.0]), "empty name");
    assert!(!publish("tracker_pos", &[]), "no values");

    // Then a mat4 entry (one process-global player, so in the same test).
    let fxb = ledmapper_fx_compiler::compile(MAT_EFFECT).expect("compiles").fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    // Identity by default: translation 0, pose[1].x = 0.
    let c = shade0();
    assert!(c.iter().all(|v| *v < 0.01), "identity default: {c:?}");
    let mut m = [0.0f32; 16];
    m[0] = 1.0;
    m[4] = 0.5; // column 1, row 0
    m[10] = 1.0;
    m[12] = 0.25; // translation x
    m[13] = 0.75; // translation y
    m[15] = 1.0;
    assert!(publish("pose", &m));
    let c = shade0();
    assert!((c[0] - 0.25).abs() < 0.01 && (c[1] - 0.75).abs() < 0.01 && (c[2] - 0.5).abs() < 0.01, "mat4 {c:?}");
}
