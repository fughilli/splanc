//! The player's per-frame advance scales with the frame period it is handed.
//! main.cpp measures each frame's real elapsed time and hands it to the effect
//! via lm_fx_update(time, dt). These tests pin the player side only: within the
//! periods main.cpp passes through unchanged (dt <= 200 ms; longer gaps are
//! clamped to 33 ms there, so a device rendering slower than that runs slow),
//! the same elapsed time renders the same picture at any frame period.
//!
//! Untraced: this is not evidence for PR-19 (adapting the playback or execution
//! rate to preserve stability). The firmware does no rate adaptation; it only
//! renders fewer frames when a frame takes longer.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use ledmapper_player_ffi::{
    lm_fx_clear, lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update, lm_player_init,
};

/// LEDs the effect renders.
const LEDS: u32 = 30;

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
fn lm_fx_update_hands_a_user_effect_its_dt_for_frame_periods_within_the_200ms_clamp() {
    // 0.75 s of playback (binary-exact frame periods, so no rounding noise) in
    // 1/32 s and 1/8 s frames: both under main.cpp's 200 ms FX clamp, so the
    // device hands them over unchanged.
    let at_32fps = effect_after(24, 1.0 / 32.0);
    let at_8fps = effect_after(6, 1.0 / 8.0);
    assert_eq!(at_32fps, [191, 0, 0], "phase 0.75 after 0.75 s");
    assert_eq!(at_8fps, at_32fps, "8 fps reaches the same phase in the same time");
    // ...and half the elapsed time is half the phase, at either period.
    assert_eq!(effect_after(12, 1.0 / 32.0), [95, 0, 0]);
    assert_eq!(effect_after(3, 1.0 / 8.0), [95, 0, 0]);
}
