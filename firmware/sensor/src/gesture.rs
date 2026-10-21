//! Cheap motion gestures for effects: tap (a sharp accel transient) and shake
//! (sustained linear-acceleration energy). Counters, not edges, so a consumer
//! that samples slower than the sensor (an effect at 30 fps, an agent poll)
//! never misses one: "did tap_count change since I last looked?".

use crate::math::{Vec3, GRAVITY};

#[derive(Clone, Copy, Debug)]
pub struct GestureParams {
    /// Accel jump between consecutive samples that counts as a tap, in g
    /// per sample period scaled to 100 Hz (so the threshold means the same
    /// thing at any ODR): 0.8 g in 10 ms.
    pub tap_jerk_g_per_s: f32,
    /// Ignore further taps for this long after one (the ring-down), s.
    pub tap_refractory_s: f32,
    /// Shake-energy time constant, s.
    pub shake_tau_s: f32,
    /// RMS linear accel (g) that maps to shake level 1.0.
    pub shake_full_g: f32,
    /// Level hysteresis for counting a shake event.
    pub shake_on: f32,
    pub shake_off: f32,
}

impl Default for GestureParams {
    fn default() -> GestureParams {
        GestureParams {
            tap_jerk_g_per_s: 80.0,
            tap_refractory_s: 0.2,
            shake_tau_s: 0.3,
            shake_full_g: 1.5,
            shake_on: 0.5,
            shake_off: 0.25,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct Gestures {
    pub params: GestureParams,
    prev: Vec3,
    have_prev: bool,
    refractory: f32,
    /// EMA of |linear accel|², g².
    energy: f32,
    shaking: bool,
    pub tap_count: u32,
    pub shake_count: u32,
}

impl Gestures {
    pub fn new(params: GestureParams) -> Gestures {
        Gestures {
            params,
            prev: Vec3::ZERO,
            have_prev: false,
            refractory: 0.0,
            energy: 0.0,
            shaking: false,
            tap_count: 0,
            shake_count: 0,
        }
    }

    /// `accel`: m/s² (fixture frame). `lin`: gravity-removed accel, m/s².
    pub fn update(&mut self, accel: Vec3, lin: Vec3, dt: f32) {
        if !(dt > 0.0) {
            return;
        }
        let inv_g = 1.0 / GRAVITY;
        // Tap: |Δa| / dt above threshold, compared squared (no sqrt).
        if self.have_prev {
            let jump = accel.sub(self.prev).scale(inv_g);
            let thr = self.params.tap_jerk_g_per_s * dt;
            if self.refractory > 0.0 {
                self.refractory -= dt;
            } else if jump.norm2() > thr * thr {
                self.tap_count = self.tap_count.wrapping_add(1);
                self.refractory = self.params.tap_refractory_s;
            }
        }
        self.prev = accel;
        self.have_prev = true;
        // Shake: first-order EMA of |lin|² (alpha = dt / tau, clamped).
        let l = lin.scale(inv_g);
        let alpha = (dt / self.params.shake_tau_s).min(1.0);
        self.energy += alpha * (l.norm2() - self.energy);
        let lvl = self.level();
        if !self.shaking && lvl >= self.params.shake_on {
            self.shaking = true;
            self.shake_count = self.shake_count.wrapping_add(1);
        } else if self.shaking && lvl <= self.params.shake_off {
            self.shaking = false;
        }
    }

    /// Shake level 0..1 (RMS linear accel / shake_full_g, clamped).
    pub fn level(&self) -> f32 {
        let full = self.params.shake_full_g;
        let e = self.energy / (full * full);
        if e >= 1.0 {
            1.0
        } else {
            crate::math::sqrt(e)
        }
    }
}
