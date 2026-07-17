//! Topology-aware pulse effect (design doc §7.8 / Phase G): light "agents"
//! travel along the fixture's topology segments by ARCLENGTH, and each LED is
//! lit by its distance (along its segment) to the nearest agent, with a soft
//! glow falloff. So an effect runs along the fixture's PHYSICAL shape, not LED
//! index.
//!
//! Stateless by construction: agent positions are a closed-form function of
//! time (evenly spaced, constant speed, wrapping at the segment length), so the
//! player keeps NO per-frame animation state — it just calls
//! [`pulse_led_color`] per LED with `now_ms` and that LED's association from the
//! stored topology (its segment length + foot arclength).
//!
//! Integer / fixed-point throughout (the C6 RISC-V core has no hardware f64):
//! arclengths and radius in millimetres, speed in mm/s, brightness in Q8. The
//! same crate is the shared reference for the Pi and ESP32 backends.

#![no_std]

pub type Rgb = (u8, u8, u8);

/// Max palette entries carried in a PulseConfig (agents cycle through them).
pub const MAX_PALETTE: usize = 8;

#[derive(Clone, Copy)]
pub struct PulseConfig {
    /// Global brightness scale, Q8 (256 == full).
    pub intensity_q8: u16,
    /// Soft-glow radius along the segment, millimetres.
    pub glow_radius_mm: u32,
    /// Agents evenly spaced along each segment.
    pub agent_count: u32,
    /// Agent travel speed, mm/s.
    pub speed_mm_s: u32,
    /// Color palette; agent i uses `palette[i % palette_len]`. len 0 → white.
    pub palette: [Rgb; MAX_PALETTE],
    pub palette_len: usize,
}

impl PulseConfig {
    fn palette_at(&self, i: u32) -> Rgb {
        if self.palette_len == 0 {
            (255, 255, 255)
        } else {
            self.palette[(i as usize) % self.palette_len]
        }
    }
}

/// Color for an LED whose foot point is at `s_mm` along a segment of length
/// `seg_len_mm`, at player time `now_ms`. Agents are evenly spaced on the
/// segment and wrap at its end; the LED accumulates each agent's palette color
/// weighted by a linear falloff of the (wrap-around) along-segment distance
/// over `glow_radius_mm`, then scaled by `intensity_q8` and saturated.
pub fn pulse_led_color(s_mm: u32, seg_len_mm: u32, now_ms: u64, cfg: &PulseConfig) -> Rgb {
    if seg_len_mm == 0 || cfg.agent_count == 0 || cfg.glow_radius_mm == 0 {
        return (0, 0, 0);
    }
    let l = seg_len_mm as u64;
    // How far the lead agent has traveled, wrapped into [0, L).
    let travel = (cfg.speed_mm_s as u64).saturating_mul(now_ms) / 1000 % l;

    let (mut ar, mut ag, mut ab) = (0u32, 0u32, 0u32); // Σ weight·channel
    for i in 0..cfg.agent_count {
        let pos = (travel + (i as u64) * l / cfg.agent_count as u64) % l;
        let raw = (s_mm as u64).abs_diff(pos);
        let d = raw.min(l - raw) as u32; // circular distance on [0, L), mm
        if d >= cfg.glow_radius_mm {
            continue;
        }
        let w = 256 * (cfg.glow_radius_mm - d) / cfg.glow_radius_mm; // Q8 falloff
        let (r, g, b) = cfg.palette_at(i);
        ar += w * r as u32;
        ag += w * g as u32;
        ab += w * b as u32;
    }
    // Undo the Q8 weight (>>8), apply intensity (Q8), saturate to 8-bit.
    let scale = |c: u32| -> u8 { (((c >> 8) * cfg.intensity_q8 as u32) >> 8).min(255) as u8 };
    (scale(ar), scale(ag), scale(ab))
}
