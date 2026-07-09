//! Deterministic synthetic VIO scene — Rust port of the generator in
//! pi/reconstruction/tests/test_vio.py (6×6 LED wall, handheld-style arc,
//! web-platform-pessimistic IMU). Two consumers:
//!
//!  * the end-to-end solver acceptance test (same tolerances as Python's);
//!  * the init-time placement benchmark: host and phone run the SAME canned
//!    problem through the SAME solver code (native vs wasm), so the measured
//!    times are directly comparable.
//!
//! Determinism matters for the benchmark (identical work on both sides), so
//! randomness comes from a seeded splitmix64 — no `rand`, no OS entropy.

use crate::camera::{look_at, project};
use crate::imu::ImuSample;
use crate::linalg::{mat_tvec, scale, sub, Mat3, Vec3};
use crate::so3::so3_log;
use crate::vio::{FrameObservations, G_WORLD};

pub const IMG_W: f64 = 1280.0;
pub const IMG_H: f64 = 720.0;
pub const K: [f64; 4] = [800.0, 800.0, 640.0, 360.0];
pub const FRAME_HZ: f64 = 8.0;
pub const IMU_HZ: f64 = 60.0;

/// splitmix64 + Box-Muller: small, seedable, portable.
pub struct Rng {
    state: u64,
    spare: Option<f64>,
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng {
            state: seed,
            spare: None,
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }

    /// Uniform in [0, 1).
    pub fn uniform(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Standard normal (Box-Muller).
    pub fn normal(&mut self) -> f64 {
        if let Some(v) = self.spare.take() {
            return v;
        }
        let (mut u1, u2) = (self.uniform(), self.uniform());
        if u1 <= 0.0 {
            u1 = f64::MIN_POSITIVE;
        }
        let r = (-2.0 * u1.ln()).sqrt();
        let theta = 2.0 * std::f64::consts::PI * u2;
        self.spare = Some(r * theta.sin());
        r * theta.cos()
    }
}

pub fn wall_leds(cols: usize, rows: usize, pitch: f64) -> Vec<Vec3> {
    (0..cols * rows)
        .map(|i| {
            let (r, c) = (i / cols, i % cols);
            [
                (c as f64 - (cols as f64 - 1.0) / 2.0) * pitch,
                ((rows as f64 - 1.0) / 2.0 - r as f64) * pitch,
                0.0,
            ]
        })
        .collect()
}

pub fn cam_pos(t: f64, duration: f64) -> Vec3 {
    let theta = -0.5 + 1.0 * (t / duration) + 0.12 * (1.7 * t).sin();
    let radius = 1.8;
    [
        radius * theta.sin(),
        0.12 + 0.15 * (2.1 * t).sin(),
        radius * theta.cos(),
    ]
}

pub fn cam_rot(t: f64, duration: f64) -> Mat3 {
    look_at(cam_pos(t, duration), [0.0, 0.0, 0.0])
}

pub fn synth_imu(duration: f64, noise: bool, rng: &mut Rng) -> Vec<ImuSample> {
    let h = 1e-4;
    let gyro_bias = [2e-3, -1e-3, 1.5e-3];
    let accel_bias = [0.03, -0.02, 0.04];
    let n = (duration * IMU_HZ) as usize;
    let mut samples: Vec<ImuSample> = (0..n)
        .map(|i| {
            let t = i as f64 / IMU_HZ;
            let r = cam_rot(t, duration);
            let rel =
                crate::linalg::mat_mul(&crate::linalg::transpose(&r), &cam_rot(t + h, duration));
            let mut omega = scale(so3_log(&rel), 1.0 / h);
            let a_world = scale(
                sub(
                    crate::linalg::add(cam_pos(t + h, duration), cam_pos(t - h, duration)),
                    scale(cam_pos(t, duration), 2.0),
                ),
                1.0 / (h * h),
            );
            let mut f_body = mat_tvec(&r, sub(a_world, G_WORLD));
            let mut ts = t;
            if noise {
                for k in 0..3 {
                    omega[k] += gyro_bias[k] + 2e-3 * rng.normal();
                    f_body[k] += accel_bias[k] + 5e-2 * rng.normal();
                }
                ts = t + 1.5e-3 * rng.normal();
            }
            ImuSample {
                t: ts,
                gyro: omega,
                accel: f_body,
            }
        })
        .collect();
    samples.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    samples
}

pub fn synth_frames(
    leds: &[Vec3],
    duration: f64,
    px_noise: f64,
    drop_p: f64,
    rng: &mut Rng,
) -> Vec<FrameObservations> {
    let n_frames = (duration * FRAME_HZ).ceil() as usize;
    let mut frames = Vec::with_capacity(n_frames);
    for fi in 0..n_frames {
        let t = fi as f64 / FRAME_HZ;
        if t >= duration {
            break;
        }
        let p = cam_pos(t, duration);
        let rot = cam_rot(t, duration);
        let mut obs = Vec::new();
        for (j, led) in leds.iter().enumerate() {
            let (u, v, depth) = project(&rot, p, K, *led);
            if depth <= 0.0 || !(0.0..IMG_W).contains(&u) || !(0.0..IMG_H).contains(&v) {
                continue;
            }
            if rng.uniform() < drop_p {
                continue;
            }
            obs.push((
                j as u32,
                u + px_noise * rng.normal(),
                v + px_noise * rng.normal(),
            ));
        }
        frames.push(FrameObservations { t, k: K, obs });
    }
    frames
}

/// The canned benchmark problem: sized so a fast phone solves it in a couple
/// of seconds and a Pi in comparable time — big enough to exercise the real
/// code paths (linear init, LSMR, preintegration cache), small enough that
/// paying it once at init is painless.
pub fn benchmark_problem() -> (Vec<FrameObservations>, Vec<ImuSample>) {
    let mut rng = Rng::new(11);
    let leds = wall_leds(6, 4, 0.12);
    let duration = 6.0;
    let imu = synth_imu(duration, true, &mut rng);
    let frames = synth_frames(&leds, duration, 0.3, 0.05, &mut rng);
    (frames, imu)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::imu::preintegrate;
    use crate::linalg::{add, dot, mat_mul, mat_vec, norm, transpose, ZERO3};
    use crate::vio::{similarity_align, solve_vio, SolveOptions};

    #[test]
    fn preintegration_matches_true_relative_states() {
        let duration = 12.0;
        let mut rng = Rng::new(1);
        let imu = synth_imu(duration, false, &mut rng);
        let (t0, t1) = (2.0, 2.125);
        let h = 1e-4;
        let (r0, r1) = (cam_rot(t0, duration), cam_rot(t1, duration));
        let (p0, p1) = (cam_pos(t0, duration), cam_pos(t1, duration));
        let v_at = |t: f64| {
            scale(
                sub(cam_pos(t + h, duration), cam_pos(t - h, duration)),
                1.0 / (2.0 * h),
            )
        };
        let (v0, v1) = (v_at(t0), v_at(t1));
        let (d_rot, d_vel, d_pos, dt) = preintegrate(&imu, t0, t1, ZERO3, ZERO3);
        let r1_pred = mat_mul(&r0, &d_rot);
        let v1_pred = add(add(v0, scale(G_WORLD, dt)), mat_vec(&r0, d_vel));
        let p1_pred = add(
            add(p0, add(scale(v0, dt), scale(G_WORLD, 0.5 * dt * dt))),
            mat_vec(&r0, d_pos),
        );
        let rot_err = norm(crate::so3::so3_log(&mat_mul(&transpose(&r1_pred), &r1)));
        assert!(rot_err < 2e-3, "rot err {rot_err}");
        assert!(norm(sub(v1_pred, v1)) < 5e-3);
        assert!(norm(sub(p1_pred, p1)) < 1e-3);
    }

    /// Port of test_vio_recovers_map_metrically_without_poses — the same
    /// acceptance thresholds as the Python solver's synthetic test.
    #[test]
    fn vio_recovers_map_metrically_without_poses() {
        let duration = 12.0;
        let mut rng = Rng::new(11);
        let leds = wall_leds(6, 6, 0.12);
        let imu = synth_imu(duration, true, &mut rng);
        let frames = synth_frames(&leds, duration, 0.3, 0.05, &mut rng);

        let result = solve_vio(&frames, &imu, &SolveOptions::default(), None, None);

        assert_eq!(result.led_ids.len(), leds.len());
        let est: Vec<_> = result.led_positions.clone();
        let truth: Vec<_> = result.led_ids.iter().map(|&id| leds[id as usize]).collect();
        let (s, rot, t) = similarity_align(&est, &truth);
        let mut sq = 0.0;
        for (e, tr) in est.iter().zip(&truth) {
            let aligned = add(mat_vec(&rot, scale(*e, s)), t);
            sq += dot(sub(aligned, *tr), sub(aligned, *tr));
        }
        let rms = (sq / est.len() as f64).sqrt();
        let scale_err = (s - 1.0).abs();
        let g_world = mat_vec(&rot, result.gravity);
        let g_angle = (dot(g_world, G_WORLD) / (norm(g_world) * 9.81))
            .clamp(-1.0, 1.0)
            .acos()
            .to_degrees();
        eprintln!(
            "rust vio synthetic: map rms {:.2} mm, scale err {:.2}%, gravity err {:.2}°, reproj {:.2} px",
            rms * 1000.0,
            scale_err * 100.0,
            g_angle,
            result.rms_reproj_px
        );
        assert!(rms < 0.005, "map rms {} mm", rms * 1000.0);
        assert!(scale_err < 0.02, "scale err {}%", scale_err * 100.0);
        assert!(g_angle < 1.5, "gravity err {g_angle}°");
        assert!(
            result.rms_reproj_px < 1.0,
            "reproj {}",
            result.rms_reproj_px
        );
    }
}
