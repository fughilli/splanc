//! Pulse illuminate math: falloff, wrap-around, palette, time evolution.

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
    // 1 agent, speed 0 → agent sits at arclength 0. An LED at 0 gets full red.
    let c = cfg(1, 100, 0, &[(255, 0, 0)]);
    assert_eq!(pulse_led_color(0, 1000, 0, &c), (255, 0, 0));
}

#[test]
fn brightness_falls_off_linearly_with_distance() {
    let c = cfg(1, 100, 0, &[(200, 0, 0)]); // agent at 0, radius 100 mm
    let at0 = pulse_led_color(0, 1000, 0, &c).0;
    let at50 = pulse_led_color(50, 1000, 0, &c).0; // half radius → ~half
    let at100 = pulse_led_color(100, 1000, 0, &c).0; // at radius → off
    assert_eq!(at0, 200);
    assert!(at50 > 80 && at50 < 120, "half-radius ≈ half: {at50}");
    assert_eq!(at100, 0, "beyond the glow radius → dark");
}

#[test]
fn distance_wraps_around_the_segment_end() {
    // Agent at 0 on a 1000 mm loop; an LED at 990 mm is only 10 mm away going
    // backwards over the wrap, so it lights up.
    let c = cfg(1, 100, 0, &[(0, 255, 0)]);
    assert!(pulse_led_color(990, 1000, 0, &c).1 > 200, "wrap-around glow");
}

#[test]
fn the_agent_travels_with_time() {
    // speed 1000 mm/s → at t=500 ms the agent is at 500 mm. The LED there lights.
    let c = cfg(1, 100, 1000, &[(0, 0, 255)]);
    assert_eq!(pulse_led_color(0, 1000, 0, &c).2, 255, "at t=0 the agent is at 0");
    assert_eq!(pulse_led_color(0, 1000, 500, &c).2, 0, "moved away from 0");
    assert_eq!(pulse_led_color(500, 1000, 500, &c).2, 255, "now over 500 mm");
}

#[test]
fn agents_are_evenly_spaced_and_cycle_the_palette() {
    // 2 agents on a 1000 mm loop → at 0 and 500. Distinct palette colors.
    let c = cfg(2, 50, 0, &[(255, 0, 0), (0, 255, 0)]);
    assert_eq!(pulse_led_color(0, 1000, 0, &c), (255, 0, 0)); // agent 0 (red)
    assert_eq!(pulse_led_color(500, 1000, 0, &c), (0, 255, 0)); // agent 1 (green)
    assert_eq!(pulse_led_color(250, 1000, 0, &c), (0, 0, 0)); // between → dark
}

#[test]
fn intensity_scales_the_output() {
    let mut c = cfg(1, 100, 0, &[(255, 255, 255)]);
    c.intensity_q8 = 128; // half
    let v = pulse_led_color(0, 1000, 0, &c).0;
    assert!(v > 120 && v < 136, "half intensity ≈ 128: {v}");
}

#[test]
fn degenerate_configs_are_dark_not_a_panic() {
    assert_eq!(pulse_led_color(0, 0, 0, &cfg(1, 100, 0, &[(255, 0, 0)])), (0, 0, 0));
    assert_eq!(pulse_led_color(0, 1000, 0, &cfg(0, 100, 0, &[(255, 0, 0)])), (0, 0, 0));
    assert_eq!(pulse_led_color(0, 1000, 0, &cfg(1, 0, 0, &[(255, 0, 0)])), (0, 0, 0));
    // Empty palette → white.
    assert_eq!(pulse_led_color(0, 1000, 0, &cfg(1, 100, 0, &[])), (255, 255, 255));
}
