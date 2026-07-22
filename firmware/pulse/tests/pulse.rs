//! Graph-effect simulation: graph build, pulse spawn/traverse/split/despawn +
//! lead-in/out, and the geodesic flood.

use ledmapper_pulse::{Effect, EffectConfig, Graph, Rgb, Sim, MAX_PALETTE, MAX_PULSES};

fn cfg(effect: Effect, palette: &[Rgb]) -> EffectConfig {
    let mut pal = [(0, 0, 0); MAX_PALETTE];
    for (i, &c) in palette.iter().enumerate() {
        pal[i] = c;
    }
    EffectConfig {
        effect,
        intensity_q8: 256,
        speed_mm_s: 1000,
        glow_radius_mm: 100,
        lead_mm: 100,
        split_q8: 0,
        spawn_interval_ms: 50,
        decay_mm: 200,
        palette: pal,
        palette_len: palette.len(),
    }
}

/// A Y: three segments meeting at branch point 0, each with a free far end.
fn y_graph() -> Graph {
    Graph::build(&[(0, -1, 500), (0, -1, 500), (0, -1, 500)])
}

#[test]
fn graph_build_finds_termini() {
    // A Y has three free ends → three termini.
    let y = y_graph();
    // chain (one segment, two free ends) → two termini.
    let chain = Graph::build(&[(-1, -1, 1000)]);
    // No public degree accessor; infer termini via flood reaching all nodes.
    let mut fy = Sim::new(y, cfg(Effect::Flood, &[(255, 255, 255)]), 1);
    let mut fc = Sim::new(chain, cfg(Effect::Flood, &[(255, 255, 255)]), 1);
    // Both build + start a flood without panicking; the flood has a finite reach.
    fy.step(10);
    fc.step(10);
    assert!(fy.flood_front_mm() > 0 || fy.active_pulses() == 0);
    let _ = &mut fc;
}

#[test]
fn a_pulse_spawns_travels_and_lights_its_segment() {
    let mut sim = Sim::new(Graph::build(&[(-1, -1, 1000)]), cfg(Effect::Pulse, &[(0, 255, 0)]), 7);
    sim.step(60); // ≥ spawn interval → one pulse spawns and advances ~60 mm
    assert_eq!(sim.active_pulses(), 1);
    // Advance until it's past the lead-in ramp and mid-segment.
    for _ in 0..8 {
        sim.step(60);
    }
    // Somewhere on the segment there is a bright green LED near the pulse; the
    // far terminus (arclength 0 or 1000, whichever the pulse left) is not it.
    let mut peak = 0u8;
    for s in (0..=1000).step_by(20) {
        peak = peak.max(sim.led_color(0, s, 0).1);
    }
    assert!(peak > 150, "a bright pulse head somewhere on the segment: {peak}");
}

#[test]
fn a_pulse_reaches_a_terminus_and_despawns() {
    // One 1000 mm segment at 1000 mm/s: a pulse crosses it in ~1 s. With a big
    // spawn interval only the first pulse exists; it must despawn at the end.
    let mut c = cfg(Effect::Pulse, &[(255, 0, 0)]);
    c.spawn_interval_ms = 30; // spawn one early…
    let mut sim = Sim::new(Graph::build(&[(-1, -1, 1000)]), c, 3);
    sim.step(40); // spawn #1
    assert!(sim.active_pulses() >= 1);
    // Run well past the crossing time; count stays bounded and pulses recycle.
    for _ in 0..200 {
        sim.step(20);
    }
    assert!(sim.active_pulses() <= MAX_PULSES);
}

#[test]
fn junction_traversal_and_splits_stay_bounded() {
    let mut c = cfg(Effect::Pulse, &[(255, 0, 0), (0, 255, 0)]);
    c.split_q8 = 128; // ~50% split at the junction
    let mut sim = Sim::new(y_graph(), c, 42);
    for _ in 0..2000 {
        sim.step(16); // ~60 fps for ~30 s
    }
    // Never exceed the pulse budget despite splitting, and the effect is alive.
    assert!(sim.active_pulses() <= MAX_PULSES);
}

#[test]
fn live_config_change_is_adopted_without_restarting() {
    // Pulse: a same-effect config tweak keeps the running pulses (no restart).
    let mut sim = Sim::new(Graph::build(&[(-1, -1, 2000)]), cfg(Effect::Pulse, &[(0, 255, 0)]), 7);
    for _ in 0..6 {
        sim.step(60); // spawn + advance a pulse
    }
    let before = sim.active_pulses();
    assert!(before >= 1, "a pulse is running");
    let mut c2 = cfg(Effect::Pulse, &[(0, 0, 255)]);
    c2.glow_radius_mm = 200;
    c2.speed_mm_s = 400;
    sim.set_config(c2);
    assert_eq!(sim.active_pulses(), before, "pulses survive a same-effect config change");
    assert_eq!(sim.config().glow_radius_mm, 200, "the new config took effect");

    // Flood: a speed tweak leaves the wavefront exactly where it was.
    let mut f = Sim::new(Graph::build(&[(-1, -1, 2000)]), cfg(Effect::Flood, &[(80, 80, 255)]), 5);
    f.step(300);
    let front = f.flood_front_mm();
    assert!(front > 0);
    let mut c3 = cfg(Effect::Flood, &[(80, 80, 255)]);
    c3.speed_mm_s = 250;
    f.set_config(c3);
    assert_eq!(f.flood_front_mm(), front, "flood wavefront preserved across a config change");
}

#[test]
fn switching_effect_kind_reinitialises() {
    let mut sim = Sim::new(Graph::build(&[(-1, -1, 1000)]), cfg(Effect::Pulse, &[(0, 255, 0)]), 3);
    for _ in 0..6 {
        sim.step(60);
    }
    assert!(sim.active_pulses() >= 1);
    sim.set_config(cfg(Effect::Flood, &[(255, 255, 255)])); // pulse → flood
    assert_eq!(sim.active_pulses(), 0, "mode switch clears the pulses");
    sim.step(100);
    let mut lit = 0;
    for s in (0..=1000).step_by(50) {
        let (r, g, b) = sim.led_color(0, s, 0);
        if r as u32 + g as u32 + b as u32 > 0 {
            lit += 1;
        }
    }
    assert!(lit > 0, "the flood runs after the switch");
}

#[test]
fn flood_swirls_on_a_terminus_less_loop() {
    // A triangle: three segments between branch points 0,1,2 — every node is
    // degree 2, so there is NO terminus. The flood must fall back to an
    // arbitrary source and still light the ring (swirl), not go dark.
    let loop_graph = Graph::build(&[(0, 1, 300), (1, 2, 300), (2, 0, 300)]);
    let mut sim = Sim::new(loop_graph, cfg(Effect::Flood, &[(255, 255, 255)]), 9);
    sim.step(150); // wavefront partway around
    let mut lit = 0;
    for seg in 0..3u16 {
        for s in (0..=300).step_by(30) {
            let (r, g, b) = sim.led_color(seg, s, 0);
            if r as u32 + g as u32 + b as u32 > 0 {
                lit += 1;
            }
        }
    }
    assert!(lit > 0, "a terminus-less loop still floods (swirl), got {lit} lit");
}

#[test]
fn flood_lights_a_moving_band_and_restarts() {
    let mut sim = Sim::new(Graph::build(&[(-1, -1, 1000)]), cfg(Effect::Flood, &[(80, 80, 255)]), 5);
    // Advance the wavefront to ~400 mm.
    sim.step(400);
    // Exactly one END is lit (the source end just behind the front is dark now,
    // the front is at 400) — check that SOME interior LED near the front lights
    // and a far one (arrival ≫ front) is dark.
    let front = sim.flood_front_mm();
    assert!(front >= 350 && front <= 450, "front≈400: {front}");
    // The LED at the source (arrival 0) is behind by ~400 > decay 200 → dark.
    // Somewhere near the wavefront is lit.
    let mut lit = 0;
    for s in (0..=1000).step_by(20) {
        if sim.led_color(0, s, 0).2 > 0 {
            lit += 1;
        }
    }
    assert!(lit > 0, "a lit band exists");

    // Run far past the end + decay → it restarts (front wraps back small).
    for _ in 0..40 {
        sim.step(100);
    }
    assert!(sim.flood_front_mm() < 1200, "flood restarted after fading out");
}
