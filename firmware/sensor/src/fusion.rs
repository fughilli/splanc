//! Attitude fusion: the filter seam, a Mahony complementary filter (the
//! phase-1 default), and the at-rest gyro-bias learner.
//!
//! ## Why Mahony first, and how indoor_localization's ESKF plugs in
//!
//! indoor_localization's `swarm/core` runs a 15-state error-state Kalman filter
//! (p, v, q, accel bias, gyro bias; 15x15 covariance). Its `predict` is a dense
//! `F P F^T` — ~6,750 MACs per IMU sample — which at 100 Hz is ~1.35 MFLOP/s:
//! fine on an FPU part, but on the FPU-less C6 (every f32 op a libgcc call,
//! ~50-100 cycles) it is ~0.5-1 s of CPU per second. A lamp has no UWB/GPS
//! to make position observable anyway, so the position/velocity half would
//! only random-walk. Mahony is ~150 flops per sample (~1% CPU at 100 Hz).
//!
//! The seam is [`AttitudeFilter`]: same units and conventions as
//! `swarm_core::Estimator` (SI accel incl. gravity reaction, rad/s gyro, q
//! body->world scalar-first, world z-up). An adapter maps
//! `update(a, w, dt)` onto `Estimator::predict(a, w, dt)` +
//! `Estimator::update_gravity(a, sigma)` (gated on |a| ~ g, which the ESKF
//! leaves to the caller), `quat()` onto `.q`, `gyro_bias()` onto `.bg` — see
//! docs/design/sensor-core.md §Fusion for the attitude-only (6-state) cut that
//! fits the C6 budget.

use crate::math::{Quat, Vec3, GRAVITY};

/// The fusion seam. One sample per call, in the FIXTURE frame (mount rotation
/// already applied), gyro NOT bias-corrected (the filter owns its bias).
pub trait AttitudeFilter {
    /// `accel`: m/s², specific force (reads +g up at rest). `gyro`: rad/s.
    fn update(&mut self, accel: Vec3, gyro: Vec3, dt: f32);
    /// Body(fixture)->world orientation.
    fn quat(&self) -> Quat;
    /// Current gyro bias estimate, rad/s.
    fn gyro_bias(&self) -> Vec3;
    /// Seed the gyro bias (from stored calibration).
    fn set_gyro_bias(&mut self, b: Vec3);
    /// Forget the attitude (re-levels from the next accel sample).
    fn reset(&mut self);
}

/// Mahony gains + gating.
#[derive(Clone, Copy, Debug)]
pub struct MahonyParams {
    /// Proportional gain on the gravity-direction error (1/s): the tilt
    /// correction time constant is ~1/kp. 1.0 -> ~1 s, quick to re-level
    /// after a disturbance yet smooths vibration.
    pub kp: f32,
    /// Integral gain (1/s²) — slow online gyro-bias tracking.
    pub ki: f32,
    /// Skip the accel correction when | |a| - g | exceeds this fraction of g
    /// (the lamp is being shaken: the accel isn't measuring gravity).
    pub accel_gate: f32,
    /// Integral clamp, rad/s (no wind-up beyond a plausible MEMS bias).
    pub bias_limit: f32,
}

impl Default for MahonyParams {
    fn default() -> MahonyParams {
        MahonyParams { kp: 1.0, ki: 0.02, accel_gate: 0.15, bias_limit: 0.2 }
    }
}

/// Mahony explicit complementary filter (Mahony, Hamel, Pflimlin 2008).
#[derive(Clone, Copy, Debug)]
pub struct Mahony {
    pub params: MahonyParams,
    q: Quat,
    /// Bias = seed - integral term (rad/s).
    bias: Vec3,
    initialized: bool,
}

impl Mahony {
    pub fn new(params: MahonyParams) -> Mahony {
        Mahony { params, q: Quat::IDENTITY, bias: Vec3::ZERO, initialized: false }
    }

    /// Orientation that maps the measured "up" (normalized accel) onto world
    /// +z with zero yaw — the best guess from one sample.
    pub fn level_from_accel(accel: Vec3) -> Quat {
        let n2 = accel.norm2();
        if n2 <= 0.0 {
            return Quat::IDENTITY;
        }
        let up = accel.scale(crate::math::inv_sqrt(n2));
        Quat::from_two_unit(up, Vec3::UP)
    }
}

impl AttitudeFilter for Mahony {
    fn update(&mut self, accel: Vec3, gyro: Vec3, dt: f32) {
        if !self.initialized {
            self.q = Mahony::level_from_accel(accel);
            self.initialized = accel.norm2() > 0.0;
            return;
        }
        if !(dt > 0.0) {
            return;
        }
        let mut w = gyro.sub(self.bias);
        let n2 = accel.norm2();
        // Gate on |a| ~ g without a sqrt: (|a|/g)^2 in [(1-k)^2, (1+k)^2].
        let r2 = n2 * (1.0 / (GRAVITY * GRAVITY));
        let k = self.params.accel_gate;
        if r2 > (1.0 - k) * (1.0 - k) && r2 < (1.0 + k) * (1.0 + k) {
            let a = accel.scale(crate::math::inv_sqrt(n2));
            let v = self.q.up_in_body();
            let e = a.cross(v);
            // Integral feedback lives in the bias estimate.
            let lim = self.params.bias_limit;
            let b = self.bias.sub(e.scale(self.params.ki * dt));
            self.bias = Vec3::new(b.x.clamp(-lim, lim), b.y.clamp(-lim, lim), b.z.clamp(-lim, lim));
            w = w.add(e.scale(self.params.kp));
        }
        // First-order quaternion integration q += 0.5 q (0, w) dt, renormalized
        // (error O((w dt)^2): 1e-4 rad/step at 1 rad/s, 100 Hz — negligible).
        let h = 0.5 * dt;
        let dq = self.q.mul(Quat::new(0.0, w.x * h, w.y * h, w.z * h));
        self.q = Quat::new(self.q.w + dq.w, self.q.x + dq.x, self.q.y + dq.y, self.q.z + dq.z).normalized();
    }

    fn quat(&self) -> Quat {
        self.q
    }

    fn gyro_bias(&self) -> Vec3 {
        self.bias
    }

    fn set_gyro_bias(&mut self, b: Vec3) {
        self.bias = b;
    }

    fn reset(&mut self) {
        self.q = Quat::IDENTITY;
        self.initialized = false;
    }
}

/// Learns the gyro bias while the fixture sits still: much faster than the
/// Mahony integral (which only sees roll/pitch error — yaw bias is
/// unobservable from gravity), and it pins yaw drift for a stationary lamp.
#[derive(Clone, Copy, Debug)]
pub struct RestDetector {
    /// |gyro - bias| below this (rad/s) counts as still.
    pub gyro_thresh: f32,
    /// | |a|/g - 1 | below this counts as still.
    pub accel_thresh: f32,
    /// Consecutive still samples before the fixture is "at rest".
    pub settle: u16,
    still: u16,
    /// Accel at the start of the current still streak.
    anchor: Vec3,
}

impl Default for RestDetector {
    fn default() -> RestDetector {
        // 0.05 rad/s ≈ 2.9 °/s: well above MPU-6050 rate noise (0.005 °/s/√Hz
        // -> ~0.1 °/s rms at a 42 Hz DLPF) once the bias is known.
        // |a| within 15% of g: the accel gain is learned in ONE orientation
        // (the first rest after boot), and the MPU-6050's per-axis zero-g
        // offsets (±50 mg x/y, ±80 mg z typ.) and ±3% sensitivity move |a| by
        // up to ~12% in another orientation. A 3% gate never let a tilted
        // fixture come to rest (the Calibrate IMU flow's 2nd/3rd pose stuck at
        // "hold the fixture still"). Stillness itself is the anchored-
        // direction check below (0.02 g ≈ 1.1° over the whole streak), which
        // also bounds the magnitude drift.
        RestDetector { gyro_thresh: 0.05, accel_thresh: 0.15, settle: 50, still: 0, anchor: Vec3::ZERO }
    }
}

impl RestDetector {
    /// Feed one sample; returns true while at rest. `bias` is the current
    /// estimate; the first-ever samples (bias unknown) use looser gyro and
    /// accel-magnitude thresholds so a large factory ZRO / scale error can
    /// still be learned (the anchored-direction check keeps it honest).
    pub fn update(&mut self, accel: Vec3, gyro: Vec3, bias: Vec3, bias_known: bool) -> bool {
        let g_thr = if bias_known { self.gyro_thresh } else { 0.35 }; // ~20 °/s ZRO spec
        // Before the first rest second the accel scale is unverified too
        // (cheap parts read 10-15% off): accept |a| within 30% of g.
        let w = gyro.sub(bias);
        let r2 = accel.norm2() * (1.0 / (GRAVITY * GRAVITY));
        let k = if bias_known { self.accel_thresh } else { 0.3 };
        let mag_ok = w.norm2() < g_thr * g_thr && r2 > (1.0 - k) * (1.0 - k) && r2 < (1.0 + k) * (1.0 + k);
        // The accel DIRECTION must also hold over the whole streak (a slow
        // tilting rotation keeps |a| = g and can sit under the loose
        // unknown-bias gyro threshold). 0.02 g ≈ 1.1°. A slow spin purely about
        // the gravity axis is indistinguishable from bias here — the stored
        // calibration (bias_known) is what protects that case.
        if mag_ok && self.still > 0 {
            let drift = accel.sub(self.anchor).norm2() * (1.0 / (GRAVITY * GRAVITY));
            if drift < 0.02 * 0.02 {
                self.still = self.still.saturating_add(1);
            } else {
                self.still = 0;
            }
        } else if mag_ok {
            self.anchor = accel;
            self.still = 1;
        } else {
            self.still = 0;
        }
        self.still >= self.settle
    }

    pub fn at_rest(&self) -> bool {
        self.still >= self.settle
    }
}
