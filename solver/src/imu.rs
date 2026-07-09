//! IMU preintegration — port of vio.py's `preintegrate`, the per-interval
//! segment bucketing, and the bias-linearized preintegration cache.

use crate::linalg::{add, mat_mul, mat_vec, scale, sub, Mat3, Vec3, EYE3, ZERO3};
use crate::so3::{so3_exp, so3_log};

#[derive(Clone, Copy, Debug)]
pub struct ImuSample {
    pub t: f64,
    pub gyro: Vec3,
    pub accel: Vec3, // specific force (a − g), body frame
}

/// (ΔR, Δv, Δp, Δt) over [t0, t1]: zero-order hold with the leading span
/// rate taken from the last sample at/before t0 (see the Python docstring
/// for why dropping that span systematically under-integrates).
pub fn preintegrate(
    samples: &[ImuSample], // time-sorted
    t0: f64,
    t1: f64,
    gyro_bias: Vec3,
    accel_bias: Vec3,
) -> (Mat3, Vec3, Vec3, f64) {
    let mut d_rot = EYE3;
    let mut d_vel = ZERO3;
    let mut d_pos = ZERO3;
    let inside: Vec<&ImuSample> = samples.iter().filter(|s| t0 < s.t && s.t < t1).collect();
    let before: Option<&ImuSample> = samples.iter().rev().find(|s| s.t <= t0);
    let active = match before.or(inside.first().copied()) {
        Some(s) => s,
        None => return (d_rot, d_vel, d_pos, t1 - t0),
    };
    let mut bounds = Vec::with_capacity(inside.len() + 2);
    bounds.push(t0);
    bounds.extend(inside.iter().map(|s| s.t));
    bounds.push(t1);
    let mut rates: Vec<&ImuSample> = Vec::with_capacity(inside.len() + 1);
    rates.push(active);
    rates.extend(inside.iter());
    for (seg, s) in rates.iter().enumerate() {
        let dt = bounds[seg + 1] - bounds[seg];
        if dt <= 0.0 {
            continue;
        }
        let acc = sub(s.accel, accel_bias);
        let a_w = mat_vec(&d_rot, acc);
        d_pos = add(d_pos, add(scale(d_vel, dt), scale(a_w, 0.5 * dt * dt)));
        d_vel = add(d_vel, scale(a_w, dt));
        d_rot = mat_mul(&d_rot, &so3_exp(scale(sub(s.gyro, gyro_bias), dt)));
    }
    (d_rot, d_vel, d_pos, t1 - t0)
}

/// Pre-bucketed integration segments for the frame intervals, mirroring
/// vio.py's `_bucket` (ZOH-with-leading-span semantics). Flattened across
/// intervals; `seg_ranges[i]` indexes this interval's samples.
pub struct Segments {
    pub dts: Vec<f64>,
    pub gyr: Vec<Vec3>,
    pub acc: Vec<Vec3>,
    pub seg_ranges: Vec<Option<(usize, usize)>>,
    pub interval_dts: Vec<f64>,
}

pub fn bucket_intervals(frame_times: &[f64], imu: &[ImuSample]) -> Segments {
    let n_int = frame_times.len().saturating_sub(1);
    let mut out = Segments {
        dts: Vec::new(),
        gyr: Vec::new(),
        acc: Vec::new(),
        seg_ranges: Vec::with_capacity(n_int),
        interval_dts: Vec::with_capacity(n_int),
    };
    for i in 0..n_int {
        let (t0, t1) = (frame_times[i], frame_times[i + 1]);
        out.interval_dts.push(t1 - t0);
        let lo = imu.partition_point(|s| s.t <= t0);
        let hi = imu.partition_point(|s| s.t < t1);
        let inside = &imu[lo..hi];
        let active = if lo > 0 {
            Some(&imu[lo - 1])
        } else {
            inside.first()
        };
        let active = match active {
            Some(a) => a,
            None => {
                out.seg_ranges.push(None);
                continue;
            }
        };
        let start = out.dts.len();
        let mut prev_t = t0;
        let mut rates: Vec<&ImuSample> = Vec::with_capacity(inside.len() + 1);
        rates.push(active);
        rates.extend(inside.iter());
        for (k, s) in rates.iter().enumerate() {
            let next_t = if k < inside.len() { inside[k].t } else { t1 };
            out.dts.push(next_t - prev_t);
            out.gyr.push(s.gyro);
            out.acc.push(s.accel);
            prev_t = next_t;
        }
        out.seg_ranges.push(Some((start, out.dts.len())));
    }
    out
}

impl Segments {
    /// (ΔR^T, Δv, Δp) per interval for the given biases.
    pub fn integrate_all(&self, bg: Vec3, ba: Vec3) -> (Vec<Mat3>, Vec<Vec3>, Vec<Vec3>) {
        let n_int = self.seg_ranges.len();
        let mut rot_t = Vec::with_capacity(n_int);
        let mut vel = Vec::with_capacity(n_int);
        let mut pos = Vec::with_capacity(n_int);
        for range in &self.seg_ranges {
            let mut d_rot = EYE3;
            let mut d_vel = ZERO3;
            let mut d_pos = ZERO3;
            if let Some((start, stop)) = range {
                for mi in *start..*stop {
                    let dt = self.dts[mi];
                    if dt <= 0.0 {
                        continue;
                    }
                    let a_w = mat_vec(&d_rot, sub(self.acc[mi], ba));
                    d_pos = add(d_pos, add(scale(d_vel, dt), scale(a_w, 0.5 * dt * dt)));
                    d_vel = add(d_vel, scale(a_w, dt));
                    d_rot = mat_mul(&d_rot, &so3_exp(scale(sub(self.gyr[mi], bg), dt)));
                }
            }
            rot_t.push(crate::linalg::transpose(&d_rot));
            vel.push(d_vel);
            pos.push(d_pos);
        }
        (rot_t, vel, pos)
    }
}

/// Bias-linearized preintegration cache (Forster-style, numerically derived):
/// integrate once at a reference bias, form the 6-column bias Jacobian by
/// finite differences, answer nearby-bias queries with the first-order
/// correction. Refreshed when the query strays beyond the linearization
/// neighborhood. Port of vio.py's `preint_all`.
pub struct PreintCache {
    ref_b: Option<[f64; 6]>,
    rot_t: Vec<Mat3>,
    vel: Vec<Vec3>,
    pos: Vec<Vec3>,
    jr: Vec<[[f64; 6]; 3]>,
    jv: Vec<[[f64; 6]; 3]>,
    jp: Vec<[[f64; 6]; 3]>,
}

const JH: f64 = 1e-6;

impl PreintCache {
    pub fn new() -> PreintCache {
        PreintCache {
            ref_b: None,
            rot_t: Vec::new(),
            vel: Vec::new(),
            pos: Vec::new(),
            jr: Vec::new(),
            jv: Vec::new(),
            jp: Vec::new(),
        }
    }

    pub fn query(
        &mut self,
        segments: &Segments,
        bg: Vec3,
        ba: Vec3,
    ) -> (Vec<Mat3>, Vec<Vec3>, Vec<Vec3>) {
        let b = [bg[0], bg[1], bg[2], ba[0], ba[1], ba[2]];
        let stale = match self.ref_b {
            None => true,
            Some(rb) => (0..6).any(|k| (b[k] - rb[k]).abs() > 1e-4),
        };
        if stale {
            let (rot_t, vel, pos) = segments.integrate_all(bg, ba);
            let n_int = rot_t.len();
            let mut jr = vec![[[0.0; 6]; 3]; n_int];
            let mut jv = vec![[[0.0; 6]; 3]; n_int];
            let mut jp = vec![[[0.0; 6]; 3]; n_int];
            for kdim in 0..6 {
                let mut bp = b;
                bp[kdim] += JH;
                let (rot_t_k, vel_k, pos_k) =
                    segments.integrate_all([bp[0], bp[1], bp[2]], [bp[3], bp[4], bp[5]]);
                for i in 0..n_int {
                    // rel = ΔR_ref^T · ΔR_k; stored values are the ΔR^T, so
                    // rel = rot_t[i] · rot_t_k[i]^T.
                    let rel = mat_mul(&rot_t[i], &crate::linalg::transpose(&rot_t_k[i]));
                    let lg = so3_log(&rel);
                    for r in 0..3 {
                        jr[i][r][kdim] = lg[r] / JH;
                        jv[i][r][kdim] = (vel_k[i][r] - vel[i][r]) / JH;
                        jp[i][r][kdim] = (pos_k[i][r] - pos[i][r]) / JH;
                    }
                }
            }
            self.ref_b = Some(b);
            self.rot_t = rot_t;
            self.vel = vel;
            self.pos = pos;
            self.jr = jr;
            self.jv = jv;
            self.jp = jp;
        }
        let rb = self.ref_b.unwrap();
        let delta = [
            b[0] - rb[0],
            b[1] - rb[1],
            b[2] - rb[2],
            b[3] - rb[3],
            b[4] - rb[4],
            b[5] - rb[5],
        ];
        if delta.iter().all(|d| *d == 0.0) {
            return (self.rot_t.clone(), self.vel.clone(), self.pos.clone());
        }
        let n_int = self.rot_t.len();
        let mut rot_t = Vec::with_capacity(n_int);
        let mut vel = Vec::with_capacity(n_int);
        let mut pos = Vec::with_capacity(n_int);
        for i in 0..n_int {
            let mut jrd = ZERO3;
            let mut jvd = ZERO3;
            let mut jpd = ZERO3;
            for r in 0..3 {
                for (k, dk) in delta.iter().enumerate() {
                    jrd[r] += self.jr[i][r][k] * dk;
                    jvd[r] += self.jv[i][r][k] * dk;
                    jpd[r] += self.jp[i][r][k] * dk;
                }
            }
            // ΔR(b)^T = exp(−J_r δ) · ΔR_ref^T
            rot_t.push(mat_mul(&so3_exp(scale(jrd, -1.0)), &self.rot_t[i]));
            vel.push(add(self.vel[i], jvd));
            pos.push(add(self.pos[i], jpd));
        }
        (rot_t, vel, pos)
    }
}

impl Default for PreintCache {
    fn default() -> Self {
        Self::new()
    }
}

/// Convenience for tests/seeding: world-frame relative-state check helper.
pub fn apply_delta(
    r0: &Mat3,
    p0: Vec3,
    v0: Vec3,
    g: Vec3,
    d_rot: &Mat3,
    d_vel: Vec3,
    d_pos: Vec3,
    dt: f64,
) -> (Mat3, Vec3, Vec3) {
    let r1 = mat_mul(r0, d_rot);
    let v1 = add(add(v0, scale(g, dt)), mat_vec(r0, d_vel));
    let p1 = add(
        add(p0, add(scale(v0, dt), scale(g, 0.5 * dt * dt))),
        mat_vec(r0, d_pos),
    );
    (r1, v1, p1)
}

/// Rotation increment measured between two body attitudes (test helper).
pub fn body_rate(r_a: &Mat3, r_b: &Mat3, dt: f64) -> Vec3 {
    let rel = mat_mul(&crate::linalg::transpose(r_a), r_b);
    scale(so3_log(&rel), 1.0 / dt)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linalg::mat_tvec;

    #[test]
    fn transpose_apply_agrees() {
        let m = so3_exp([0.2, 0.1, -0.3]);
        let v = [1.0, 2.0, 3.0];
        let a = mat_tvec(&m, v);
        let b = mat_vec(&crate::linalg::transpose(&m), v);
        assert!((0..3).all(|i| (a[i] - b[i]).abs() < 1e-14));
    }

    #[test]
    fn preintegrate_constant_rates_match_closed_form() {
        // Constant specific force, zero rotation: Δp = ½ a t², Δv = a t.
        let samples: Vec<ImuSample> = (0..101)
            .map(|i| ImuSample {
                t: i as f64 * 0.01,
                gyro: ZERO3,
                accel: [0.5, -0.2, 9.81],
            })
            .collect();
        let (d_rot, d_vel, d_pos, dt) = preintegrate(&samples, 0.0, 1.0, ZERO3, ZERO3);
        assert!((dt - 1.0).abs() < 1e-12);
        for r in 0..3 {
            assert!((d_rot[r][r] - 1.0).abs() < 1e-12);
        }
        assert!((d_vel[0] - 0.5).abs() < 1e-9 && (d_pos[0] - 0.25).abs() < 1e-3);
    }

    #[test]
    fn segments_match_scalar_preintegrate() {
        let samples: Vec<ImuSample> = (0..200)
            .map(|i| {
                let t = i as f64 * 0.016;
                ImuSample {
                    t,
                    gyro: [0.1 * (t * 3.0).sin(), -0.05, 0.2 * (t * 1.3).cos()],
                    accel: [0.3 * (t * 2.0).cos(), 9.7, -0.4 * (t * 0.7).sin()],
                }
            })
            .collect();
        let frame_times: Vec<f64> = (0..10).map(|i| 0.05 + i as f64 * 0.3).collect();
        let segs = bucket_intervals(&frame_times, &samples);
        let bg = [1e-3, -2e-3, 5e-4];
        let ba = [0.02, -0.01, 0.03];
        let (rot_t, vel, pos) = segs.integrate_all(bg, ba);
        for i in 0..frame_times.len() - 1 {
            let (d_rot, d_vel, d_pos, _) =
                preintegrate(&samples, frame_times[i], frame_times[i + 1], bg, ba);
            let d_rot_t = crate::linalg::transpose(&d_rot);
            for r in 0..3 {
                for c in 0..3 {
                    assert!((rot_t[i][r][c] - d_rot_t[r][c]).abs() < 1e-12);
                }
                assert!((vel[i][r] - d_vel[r]).abs() < 1e-12);
                assert!((pos[i][r] - d_pos[r]).abs() < 1e-12);
            }
        }
    }

    #[test]
    fn preint_cache_first_order_correction_is_close() {
        let samples: Vec<ImuSample> = (0..300)
            .map(|i| {
                let t = i as f64 * 0.016;
                ImuSample {
                    t,
                    gyro: [0.3 * (t * 2.0).sin(), 0.1, -0.2 * (t * 0.9).cos()],
                    accel: [0.5 * (t * 1.1).cos(), 9.6, -0.3 * (t * 1.7).sin()],
                }
            })
            .collect();
        let frame_times: Vec<f64> = (0..12).map(|i| 0.1 + i as f64 * 0.35).collect();
        let segs = bucket_intervals(&frame_times, &samples);
        let mut cache = PreintCache::new();
        let _ = cache.query(&segs, ZERO3, ZERO3); // set reference
        let bg = [3e-5, -2e-5, 1e-5];
        let ba = [4e-4, -3e-4, 2e-4];
        let (rot_t_lin, vel_lin, pos_lin) = cache.query(&segs, bg, ba);
        let (rot_t_true, vel_true, pos_true) = segs.integrate_all(bg, ba);
        for i in 0..rot_t_lin.len() {
            for r in 0..3 {
                assert!((vel_lin[i][r] - vel_true[i][r]).abs() < 1e-6);
                assert!((pos_lin[i][r] - pos_true[i][r]).abs() < 1e-6);
                for c in 0..3 {
                    assert!((rot_t_lin[i][r][c] - rot_t_true[i][r][c]).abs() < 1e-5);
                }
            }
        }
    }
}
