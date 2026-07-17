//! Pulse illuminate math: inverse-square falloff over the true 3D distance
//! (along-segment Δs AND perpendicular d_perp), wrap-around, palette, time.

use ledmapper_pulse::{pulse_led_color, PulseConfig, Rgb, MAX_PALETTE};

fn cfg(agents: u32, radius: u32, speed: u32, palette: &[Rgb]) -> PulseConfig {
    let mut pal = [(0, 0, 0); MAX_PALETTE];
    for (i, &c) in palette.iter().enumerate() {
        pal[i] = c;
    }
    PulseConfig {
        intensity_q8: 256,
        glow_radius_mm: radius,
        agent_count: agents,
        speed_mm_s: speed,
        palette: pal,
        palette_len: palette.len(),
    }
}

#[test]
fn agent_at_the_led_is_full_brightness_in_palette_color() {
    let c = cfg(1, 100, 0, &[(255, 0, 0)]); // agent at 0
    assert_eq!(pulse_led_color(0, 0, 1000, 0, &c), (255, 0, 0));
}

#[test]
fn inverse_square_falloff_halves_at_the_glow_radius() {
    let c = cfg(1, 100, 0, &[(200, 0, 0)]); // agent at 0, radius 100 mm
    let at0 = pulse_led_color(0, 0, 1000, 0, &c).0;
    let at_r = pulse_led_color(100, 0, 1000, 0, &c).0; // r = radius → half
    let far = pulse_led_color(350, 0, 1000, 0, &c).0; // r = 3.5·radius → tiny
    assert_eq!(at0, 200);
    assert!((at_r as i32 - 100).abs() <= 3, "≈ half at the glow radius: {at_r}");
    assert!(far < 30, "long tail is dim: {far}");
}

#[test]
fn perpendicular_offset_dims_the_led_like_along_distance() {
    // An LED OFF the wire is farther from the point source, so dimmer — and the
    // 3D distance is symmetric in Δs and d_perp (r² = Δs² + d_perp²).
    let c = cfg(1, 100, 0, &[(255, 0, 0)]); // agent at arclength 0, radius 100
    let on_wire = pulse_led_color(0, 0, 1000, 0, &c).0; // r = 0
    let offset = pulse_led_color(0, 100, 1000, 0, &c).0; // d_perp = radius → r = radius
    let along = pulse_led_color(100, 0, 1000, 0, &c).0; // Δs = radius → r = radius
    assert_eq!(on_wire, 255);
    assert!((offset as i32 - 127).abs() <= 3, "offset by the radius ≈ half: {offset}");
    assert!((offset as i32 - along as i32).abs() <= 2, "Δs and d_perp are symmetric");
}

#[test]
fn distance_wraps_around_the_segment_end() {
    let c = cfg(1, 50, 0, &[(0, 255, 0)]); // agent at 0 on a 1000 mm loop
    assert!(pulse_led_color(990, 0, 1000, 0, &c).1 > 200, "10 mm away over the wrap");
}

#[test]
fn the_agent_travels_with_time() {
    let c = cfg(1, 60, 1000, &[(0, 0, 255)]); // 1000 mm/s
    assert_eq!(pulse_led_color(0, 0, 1000, 0, &c).2, 255, "at t=0 the agent is at 0");
    assert_eq!(pulse_led_color(0, 0, 1000, 500, &c).2, 0, "moved far from 0");
    assert_eq!(pulse_led_color(500, 0, 1000, 500, &c).2, 255, "now over 500 mm");
}

#[test]
fn agents_are_evenly_spaced_and_cycle_the_palette() {
    let c = cfg(2, 40, 0, &[(255, 0, 0), (0, 255, 0)]); // agents at 0 and 500
    assert_eq!(pulse_led_color(0, 0, 1000, 0, &c), (255, 0, 0)); // agent 0 (red)
    assert_eq!(pulse_led_color(500, 0, 1000, 0, &c), (0, 255, 0)); // agent 1 (green)
    assert_eq!(pulse_led_color(250, 0, 1000, 0, &c), (0, 0, 0)); // between → dark
}

#[test]
fn intensity_scales_the_output() {
    let mut c = cfg(1, 100, 0, &[(255, 255, 255)]);
    c.intensity_q8 = 128; // half
    let v = pulse_led_color(0, 0, 1000, 0, &c).0;
    assert!((v as i32 - 128).abs() <= 4, "half intensity ≈ 128: {v}");
}

#[test]
fn degenerate_configs_are_dark_not_a_panic() {
    assert_eq!(pulse_led_color(0, 0, 0, 0, &cfg(1, 100, 0, &[(255, 0, 0)])), (0, 0, 0));
    assert_eq!(pulse_led_color(0, 0, 1000, 0, &cfg(0, 100, 0, &[(255, 0, 0)])), (0, 0, 0));
    assert_eq!(pulse_led_color(0, 0, 1000, 0, &cfg(1, 0, 0, &[(255, 0, 0)])), (0, 0, 0));
    // Empty palette → white at the source.
    assert_eq!(pulse_led_color(0, 0, 1000, 0, &cfg(1, 100, 0, &[])), (255, 255, 255));
}
