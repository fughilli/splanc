//! Host-side carrier: wasm-bindgen exports over the pulse/flood Sim.
//!
//! The effects-simulator workspace drives the EXACT firmware simulation code
//! (ledmapper_pulse, no_std/integer) so its preview can never drift from what a
//! player renders. This crate is the thin std wrapper wasm-bindgen needs.
//!
//! Usage from JS: build an `EffectSim` from the fixture's segments + per-LED
//! associations + effect config (human units), then each animation frame call
//! `step(dt_ms)` and `render()` → a flat RGB byte array (one triple per LED, in
//! association order).

use ledmapper_pulse::{Effect, EffectConfig, Graph, Sim};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct EffectSim {
    sim: Sim,
    // Per-LED association, resolved to sim segment INDEX (0-based, matching the
    // order segments were passed to `new`).
    seg_idx: Vec<u16>,
    s_mm: Vec<u32>,
    d_perp_mm: Vec<u32>,
}

#[wasm_bindgen]
impl EffectSim {
    /// Build a sim.
    ///
    /// Segments: parallel arrays `seg_a[i]`, `seg_b[i]` (branch-point ids ≥ 0,
    /// or -1 for a free end) and `seg_len_mm[i]`. Per-LED association: parallel
    /// arrays `led_seg[i]` (segment INDEX), `led_s_mm[i]` (foot arclength from
    /// node a), `led_dperp_mm[i]` (perpendicular offset). `effect`: 0 = pulse,
    /// 1 = flood. Config is in human units (meters, m/s, [0,1]); `lead_m`/
    /// `decay_m` ≤ 0 derive from the glow radius, `split_prob` < 0 uses the
    /// default. `palette_rgb` is 0xRRGGBB (empty → white).
    #[wasm_bindgen(constructor)]
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        seg_a: &[i32],
        seg_b: &[i32],
        seg_len_mm: &[u32],
        led_seg: &[u32],
        led_s_mm: &[u32],
        led_dperp_mm: &[u32],
        effect: u8,
        intensity: f32,
        glow_m: f32,
        speed_m_s: f32,
        agent_count: u32,
        lead_m: f32,
        split_prob: f32,
        decay_m: f32,
        palette_rgb: &[u32],
        seed: u32,
    ) -> EffectSim {
        let n = seg_a.len().min(seg_b.len()).min(seg_len_mm.len());
        let mut segs = Vec::with_capacity(n);
        for i in 0..n {
            segs.push((seg_a[i], seg_b[i], seg_len_mm[i]));
        }
        let graph = Graph::build(&segs);
        let eff = if effect == 1 { Effect::Flood } else { Effect::Pulse };
        let cfg = EffectConfig::from_wire(
            eff,
            intensity,
            glow_m,
            speed_m_s,
            agent_count,
            lead_m,
            split_prob,
            decay_m,
            palette_rgb,
        );
        EffectSim {
            sim: Sim::new(graph, cfg, seed),
            seg_idx: led_seg.iter().map(|&x| x as u16).collect(),
            s_mm: led_s_mm.to_vec(),
            d_perp_mm: led_dperp_mm.to_vec(),
        }
    }

    /// Advance the simulation by `dt_ms`.
    pub fn step(&mut self, dt_ms: u32) {
        self.sim.step(dt_ms);
    }

    /// Render every LED to a flat RGB byte array (length = led_count * 3), in
    /// the association order passed to `new`.
    pub fn render(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(self.seg_idx.len() * 3);
        for i in 0..self.seg_idx.len() {
            let (r, g, b) = self.sim.led_color(self.seg_idx[i], self.s_mm[i], self.d_perp_mm[i]);
            out.push(r);
            out.push(g);
            out.push(b);
        }
        out
    }

    /// Live pulse count (HUD / diagnostics).
    pub fn active_pulses(&self) -> usize {
        self.sim.active_pulses()
    }

    /// Flood wavefront distance, mm (HUD / diagnostics).
    pub fn flood_front_mm(&self) -> u32 {
        self.sim.flood_front_mm()
    }
}
