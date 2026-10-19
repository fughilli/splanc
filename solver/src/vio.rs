//! Joint visual-inertial pose + LED solver — port of `reconstruction/vio.py`
//! (see that file for the full algorithm rationale; stage structure, gauge
//! choices, weights and thresholds are kept identical so the two
//! implementations converge to the same solutions, which the cross-language
//! parity test pins).
//!
//! Intentional difference: intrinsics refinement (`refine_intrinsics`) is
//! not ported — the production path never enables it (a floating focal is a
//! scale-drift channel; clients supply K), and calibration studies keep the
//! Python solver.

use std::cell::RefCell;
use std::rc::Rc;

use crate::imu::{bucket_intervals, preintegrate, ImuSample, PreintCache};
use crate::linalg::{
    add, cross, dot, lstsq_rows, mat_mul, mat_tvec, mat_vec, norm, normalize, scale, sub, Mat3,
    Vec3, EYE3, ZERO3,
};
use crate::lm::{least_squares_lm, LmOptions, Sparsity};
use crate::quat::{quat_to_rotmat, rotmat_to_quat, Quat};
use crate::so3::{so3_exp, so3_log};
use crate::sparse::{lsmr, Csc};

pub const GRAVITY: f64 = 9.81;
pub const G_WORLD: Vec3 = [0.0, -GRAVITY, 0.0];

/// IMU sample noise at the sample rate (the SolveOptions defaults).
pub const GYRO_NOISE: f64 = 2e-3; // rad/s
pub const ACCEL_NOISE: f64 = 5e-2; // m/s²
/// Dead-reckoning drift the white-noise model omits: bias instability and
/// the attitude error that leaks gravity into the specific force. Both grow
/// with the interval length, so a long observation gap (decode-lock dead
/// time, a walk-away) is still IMU-linked — just as loosely as the physics
/// allows.
pub const GYRO_DRIFT: f64 = 1e-3; // rad/s
pub const ACCEL_DRIFT: f64 = 2e-2; // m/s²
/// An interval whose IMU stream has a hole longer than this carries no
/// inertial information at all (zero-order hold across it would be
/// fabricated data).
pub const IMU_HOLE_S: f64 = 0.25;
/// Weight for an interval the IMU does not cover: effectively unconstrained,
/// while keeping the residual layout fixed.
const HOLE_SIGMA: f64 = 1e6;

/// (σ_rot, σ_vel, σ_pos, hole) for the IMU factor over [t0, t1] — port of
/// vio.interval_sigmas. `imu_t` is the sorted IMU sample times. White sample
/// noise (per-sample σ, ∝ √count) plus the drift terms that grow with the
/// interval length. `hole`: the stream has a gap > IMU_HOLE_S inside the
/// interval (including the lead-in from the held sample before t0) — no
/// inertial information.
pub fn interval_sigmas(
    imu_t: &[f64],
    t0: f64,
    t1: f64,
    gyro_noise: f64,
    accel_noise: f64,
) -> (f64, f64, f64, bool) {
    let lo = imu_t.partition_point(|&t| t <= t0);
    let hi = imu_t.partition_point(|&t| t < t1);
    let span = t1 - t0;
    // Coverage points: the held sample at/before t0 (else t0 itself), every
    // sample inside, and t1. No sample at all ⇒ nothing to integrate.
    let mut prev = if lo > 0 { imu_t[lo - 1] } else { t0 };
    let mut max_gap: f64 = 0.0;
    for &t in imu_t[lo..hi.max(lo)].iter().chain(std::iter::once(&t1)) {
        max_gap = max_gap.max(t - prev);
        prev = t;
    }
    if (lo == 0 && hi == 0) || max_gap > IMU_HOLE_S {
        return (HOLE_SIGMA, HOLE_SIGMA, HOLE_SIGMA, true);
    }
    let cnt = imu_t.iter().filter(|&&t| t0 <= t && t < t1).count().max(1) as f64;
    let dt = span / cnt;
    let sr = gyro_noise * cnt.sqrt() * dt + GYRO_DRIFT * span;
    let sv = accel_noise * cnt.sqrt() * dt + ACCEL_DRIFT * span;
    let sp = 0.5 * accel_noise * cnt.sqrt() * dt * span + 0.5 * ACCEL_DRIFT * span * span;
    (sr.max(1e-6), sv.max(1e-6), sp.max(1e-7), false)
}

/// The frame whose pose fixes the gauge: the best-observed one (first on
/// ties). Pinning frame 0 made a stray 2-record leading frame the anchor of
/// the whole solve (the 2026-07-08 469k-px divergence).
pub fn gauge_frame(frames: &[FrameObservations]) -> usize {
    let mut best = 0;
    for (i, fr) in frames.iter().enumerate() {
        if fr.obs.len() > frames[best].obs.len() {
            best = i;
        }
    }
    best
}

fn imu_times(imu: &[ImuSample]) -> Vec<f64> {
    let mut t: Vec<f64> = imu.iter().map(|s| s.t).collect();
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    t
}

#[derive(Clone, Debug)]
pub struct FrameObservations {
    pub t: f64,
    pub k: [f64; 4],
    pub obs: Vec<(u32, f64, f64)>, // (ledId, u, v)
}

#[derive(Clone, Debug)]
pub struct VioResult {
    pub led_ids: Vec<u32>,        // sorted
    pub led_positions: Vec<Vec3>, // parallel to led_ids
    pub positions: Vec<Vec3>,
    pub quats: Vec<Quat>,
    pub velocities: Vec<Vec3>,
    pub gravity: Vec3,
    pub gyro_bias: Vec3,
    pub accel_bias: Vec3,
    pub rms_reproj_px: f64,
    pub frame_times: Vec<f64>,
    /// Relative standard error of the metric scale from the a-posteriori
    /// inertial re-anchor (see `inertial_alignment`); infinite when there
    /// was no inertial data or the scale was unobservable. A rough
    /// excitation gauge, not a calibrated interval: it understates the true
    /// error a few-fold (preintegrated noise is correlated), but it climbs
    /// steeply as the capture motion gets gentler.
    pub scale_rel_se: f64,
}

impl VioResult {
    pub fn led_pos(&self, id: u32) -> Option<Vec3> {
        self.led_ids
            .binary_search(&id)
            .ok()
            .map(|i| self.led_positions[i])
    }
}

#[derive(Clone, Debug)]
pub struct SolveOptions {
    pub px_sigma: f64,
    pub gyro_noise: f64,
    pub accel_noise: f64,
    pub huber_px: f64,
    pub max_nfev: usize,
    pub ftol: f64,
    /// Strip prior "rope" links `(led_a, led_b, max_dist)` (see strip.rs):
    /// one residual each, zero while the two LEDs are within `max_dist` and
    /// `(dist − max_dist) / chain_sigma` past it. Links naming an LED this
    /// solve does not carry are ignored. Empty = no prior (the default).
    pub chain: Vec<(u32, u32, f64)>,
    /// Stiffness of the rope links (meters per unit residual).
    pub chain_sigma: f64,
}

impl Default for SolveOptions {
    fn default() -> Self {
        SolveOptions {
            px_sigma: 0.5,
            gyro_noise: GYRO_NOISE,
            accel_noise: ACCEL_NOISE,
            huber_px: 4.0,
            max_nfev: 60,
            ftol: 1e-6,
            chain: Vec::new(),
            chain_sigma: 0.0,
        }
    }
}

/// Progress hook: (frac, rms_px, led_ids, led_positions, camera_positions).
/// Called after every residual evaluation — carriers throttle.
pub type ProgressFn<'a> = &'a mut dyn FnMut(f64, f64, &[u32], &[Vec3], &[Vec3]);

// ---------------------------------------------------------------------------
// Initialization stages
// ---------------------------------------------------------------------------

/// Camera-to-world rotation seed per frame: gyro-integrated increments, with
/// roll/pitch anchored by the accelerometer mean around the first frame. Across
/// an IMU hole the rotation is held (no information).
fn rotation_seeds(frames: &[FrameObservations], imu: &[ImuSample]) -> Vec<Mat3> {
    let t_start = frames[0].t;
    // A window AROUND the first frame: pre-capture walking must not leak into
    // the gravity direction.
    let early: Vec<Vec3> = {
        let e: Vec<Vec3> = imu
            .iter()
            .filter(|s| (s.t - t_start).abs() <= 0.5)
            .map(|s| s.accel)
            .collect();
        if e.is_empty() {
            let nearest = imu
                .iter()
                .min_by(|a, b| {
                    (a.t - t_start)
                        .abs()
                        .partial_cmp(&(b.t - t_start).abs())
                        .unwrap()
                })
                .unwrap();
            vec![nearest.accel]
        } else {
            e
        }
    };
    let mut f_dir = ZERO3;
    for a in &early {
        f_dir = add(f_dir, *a);
    }
    f_dir = normalize(scale(f_dir, 1.0 / early.len() as f64));
    let up_world = [0.0, 1.0, 0.0];
    let axis = cross(f_dir, up_world);
    let s = norm(axis);
    let c = dot(f_dir, up_world);
    let r0 = if s < 1e-9 {
        if c > 0.0 {
            EYE3
        } else {
            so3_exp([std::f64::consts::PI, 0.0, 0.0])
        }
    } else {
        so3_exp(scale(axis, s.atan2(c) / s))
    };
    let imu_t = imu_times(imu);
    let mut seeds = vec![r0];
    for i in 1..frames.len() {
        let hole = interval_sigmas(
            &imu_t,
            frames[i - 1].t,
            frames[i].t,
            GYRO_NOISE,
            ACCEL_NOISE,
        )
        .3;
        if hole {
            seeds.push(*seeds.last().unwrap());
            continue;
        }
        let (d_rot, _dv, _dp, _dt) = preintegrate(imu, frames[i - 1].t, frames[i].t, ZERO3, ZERO3);
        seeds.push(mat_mul(seeds.last().unwrap(), &d_rot));
    }
    seeds
}

/// Known-rotation linear init: camera centers + LED positions from ray
/// membership, scale gauge via ~64 down-weighted depth pins (see vio.py for
/// the three observed failure modes that weighting resolves).
fn known_rotation_linear_init(
    frames: &[FrameObservations],
    rotations: &[Mat3],
    led_ids: &[u32],
    gauge: usize,
) -> (Vec<Vec3>, Vec<Vec3>) {
    const SCALE_PINS: usize = 64;
    const W_PIN: f64 = 0.05;
    let n_frames = frames.len();
    let n_leds = led_ids.len();
    let n_unknowns = 3 * (n_frames - 1) + 3 * n_leds;
    let id_index = |led: u32| led_ids.binary_search(&led).unwrap();

    // Gauge: c_gauge = 0.
    let col_c = |i: usize| -> Option<usize> {
        match i.cmp(&gauge) {
            std::cmp::Ordering::Equal => None,
            std::cmp::Ordering::Less => Some(3 * i),
            std::cmp::Ordering::Greater => Some(3 * (i - 1)),
        }
    };
    let col_x = |j: usize| 3 * (n_frames - 1) + 3 * j;

    let mut triplets: Vec<(usize, usize, f64)> = Vec::new();
    let mut row = 0usize;
    let mut pin_candidates: Vec<(Vec3, usize, usize)> = Vec::new(); // (w, led j, frame i)
    for (i, fr) in frames.iter().enumerate() {
        let [fx, fy, cx, cy] = fr.k;
        let r = &rotations[i];
        for &(led, u, v) in &fr.obs {
            let d_cam = [(u - cx) / fx, -(v - cy) / fy, -1.0];
            let w = normalize(mat_vec(r, d_cam));
            let j = id_index(led);
            for rr in 0..3 {
                for cc in 0..3 {
                    // proj = I − w w^T (rank 2)
                    let val = (if rr == cc { 1.0 } else { 0.0 }) - w[rr] * w[cc];
                    if val.abs() < 1e-14 {
                        continue;
                    }
                    triplets.push((row + rr, col_x(j) + cc, val));
                    if let Some(ci) = col_c(i) {
                        triplets.push((row + rr, ci + cc, -val));
                    }
                }
            }
            row += 3;
            pin_candidates.push((w, j, i));
        }
    }
    assert!(!pin_candidates.is_empty(), "no observations");
    let stride = (pin_candidates.len() / SCALE_PINS).max(1);
    let pins: Vec<&(Vec3, usize, usize)> = pin_candidates.iter().step_by(stride).collect();
    let mut rhs = vec![0.0; row + pins.len()];
    for &(w0, j0, i0) in &pins {
        // `cc` is a column offset added to `col_x(j0)`/`ci` as well as indexing
        // `w0`; it is arithmetic, not a single-slice walk.
        #[allow(clippy::needless_range_loop)]
        for cc in 0..3 {
            triplets.push((row, col_x(*j0) + cc, W_PIN * w0[cc]));
            if let Some(ci) = col_c(*i0) {
                triplets.push((row, ci + cc, -W_PIN * w0[cc]));
            }
        }
        rhs[row] = W_PIN;
        row += 1;
    }

    let a = Csc::from_triplets(row, n_unknowns, &triplets);
    let sol = lsmr(&a, None, &rhs, 0.0, 1e-10, 1e-10, 8000);

    let mut centers = vec![ZERO3; n_frames];
    for (i, c) in centers.iter_mut().enumerate() {
        if let Some(ci) = col_c(i) {
            *c = [sol[ci], sol[ci + 1], sol[ci + 2]];
        }
    }
    let leds: Vec<Vec3> = (0..n_leds)
        .map(|j| [sol[col_x(j)], sol[col_x(j) + 1], sol[col_x(j) + 2]])
        .collect();
    (centers, leds)
}

/// Linear visual-inertial alignment: scale, gravity, per-frame velocities
/// from zero-bias preintegration deltas, then the gravity-magnitude-
/// constrained re-solve (2 iterations). Port of vio._inertial_alignment:
/// each interval's rows are weighted by its IMU uncertainty relative to the
/// session's typical interval (a regular session is unchanged; one long
/// dead-reckoned gap cannot dominate), and IMU holes contribute nothing.
pub fn inertial_alignment(
    frames: &[FrameObservations],
    rotations: &[Mat3],
    centers: &[Vec3],
    imu: &[ImuSample],
    gyro_bias: Vec3,
    accel_bias: Vec3,
) -> (f64, Vec3, Vec<Vec3>, f64) {
    // The camera centers come from vision and jitter with pixel noise. Weighting
    // the position rows by IMU noise alone treats that jitter as motion the IMU
    // failed to see: on a dwell-heavy capture (long static holds, brief hops
    // between vantage points) the many near-static intervals then dilute the
    // scale toward zero, swamping the hops that actually carry it. So each
    // position row's σ also carries the center noise (metric τ, per center),
    // estimated from the data: a few rounds of solve → pick τ so the position
    // rows' normalized residuals match their expected χ².
    let mut tau = 0.0;
    let mut out =
        alignment_with_center_noise(frames, rotations, centers, imu, gyro_bias, accel_bias, tau);
    for _ in 0..4 {
        let (_, _, _, _, ref resid, dof_frac) = out;
        if resid.is_empty() {
            break;
        }
        let target = dof_frac * resid.len() as f64;
        let chi2 = |t: f64| -> f64 {
            resid
                .iter()
                .map(|&(r2, sp)| r2 / (sp * sp + 2.0 * t * t))
                .sum()
        };
        let next = if chi2(0.0) <= target {
            0.0
        } else {
            let (mut lo, mut hi) = (0.0, 1.0);
            for _ in 0..60 {
                let mid = 0.5 * (lo + hi);
                if chi2(mid) > target {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            0.5 * (lo + hi)
        };
        let done = (next - tau).abs() <= 0.05 * tau.max(1e-6);
        tau = next;
        out = alignment_with_center_noise(
            frames, rotations, centers, imu, gyro_bias, accel_bias, tau,
        );
        if done {
            break;
        }
    }
    (out.0, out.1, out.2, out.3)
}

/// One weighted linear alignment with metric center noise `tau` folded into
/// the position rows' σ. Also returns, per position-row component, (squared
/// metric residual, IMU σ_p) and the residual-dof fraction, for the τ fit.
#[allow(clippy::type_complexity)]
fn alignment_with_center_noise(
    frames: &[FrameObservations],
    rotations: &[Mat3],
    centers: &[Vec3],
    imu: &[ImuSample],
    gyro_bias: Vec3,
    accel_bias: Vec3,
    tau: f64,
) -> (f64, Vec3, Vec<Vec3>, f64, Vec<(f64, f64)>, f64) {
    let n = frames.len();
    let n_unknowns = 1 + 3 + 3 * n;
    let mut rows: Vec<Vec<(usize, f64)>> = Vec::with_capacity(6 * (n - 1));
    let mut rhs: Vec<f64> = Vec::with_capacity(6 * (n - 1));
    let imu_t = imu_times(imu);
    let sig: Vec<(f64, f64, f64, bool)> = (0..n - 1)
        .map(|i| {
            interval_sigmas(
                &imu_t,
                frames[i].t,
                frames[i + 1].t,
                GYRO_NOISE,
                ACCEL_NOISE,
            )
        })
        .collect();
    let covered_median = |pick: fn(&(f64, f64, f64, bool)) -> f64| -> f64 {
        let mut v: Vec<f64> = sig.iter().filter(|s| !s.3).map(pick).collect();
        if v.is_empty() {
            return 1.0;
        }
        v.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let h = v.len() / 2;
        if v.len() % 2 == 1 {
            v[h]
        } else {
            0.5 * (v[h - 1] + v[h])
        }
    };
    let ref_v = covered_median(|s| s.1);
    let ref_p = covered_median(|s| s.2);
    // (interval, position-row weight, IMU σ_p) per included interval.
    let mut intervals: Vec<(usize, f64, f64)> = Vec::with_capacity(n);
    // Keep the raw g-block coefficients per row for the constrained re-solve:
    // (row triplets excluding g, g-coeff 3-row block, rhs).
    for i in 0..n - 1 {
        if sig[i].3 {
            continue;
        }
        let sp_eff = (sig[i].2 * sig[i].2 + 2.0 * tau * tau).sqrt();
        let (w_v, w_p) = (ref_v / sig[i].1, ref_p / sp_eff);
        intervals.push((i, w_p, sig[i].2));
        let (d_rot, d_vel, d_pos, dt) =
            preintegrate(imu, frames[i].t, frames[i + 1].t, gyro_bias, accel_bias);
        let _ = d_rot;
        let rit_rows = rotations[i]; // use columns of R as rows of R^T
        let dc = sub(centers[i + 1], centers[i]);
        let rit_dc = mat_tvec(&rit_rows, dc);
        // `r` is a matrix row: it transposes `rotations[i][c][r]` and indexes the
        // preintegrated residuals — not a walk of one slice.
        #[allow(clippy::needless_range_loop)]
        for r in 0..3 {
            // R_i^T (s·Δc − v_i·dt − ½·g·dt²) = Δp
            let mut row: Vec<(usize, f64)> = Vec::with_capacity(7);
            row.push((0, w_p * rit_dc[r]));
            for c in 0..3 {
                let rit_rc = rotations[i][c][r]; // (R^T)[r][c]
                row.push((1 + c, -w_p * 0.5 * dt * dt * rit_rc));
                row.push((4 + 3 * i + c, -w_p * dt * rit_rc));
            }
            rows.push(row);
            rhs.push(w_p * d_pos[r]);
        }
        // `r` is a matrix row (transposes `rotations[i][c][r]`, indexes `d_vel`).
        #[allow(clippy::needless_range_loop)]
        for r in 0..3 {
            // R_i^T (v_j − v_i − g·dt) = Δv
            let mut row: Vec<(usize, f64)> = Vec::with_capacity(9);
            for c in 0..3 {
                let rit_rc = rotations[i][c][r];
                row.push((1 + c, -w_v * dt * rit_rc));
                row.push((4 + 3 * i + c, -w_v * rit_rc));
                row.push((4 + 3 * (i + 1) + c, w_v * rit_rc));
            }
            rows.push(row);
            rhs.push(w_v * d_vel[r]);
        }
    }
    let sol = lstsq_rows(&rows, &rhs, n_unknowns);
    let mut s_se = scale_std_err(&rows, &rhs, &sol, n_unknowns);
    let mut s = sol[0];
    let mut g = [sol[1], sol[2], sol[3]];
    let mut v: Vec<Vec3> = (0..n)
        .map(|i| [sol[4 + 3 * i], sol[4 + 3 * i + 1], sol[4 + 3 * i + 2]])
        .collect();

    // Gravity-magnitude refinement: g constrained to the 9.81 sphere,
    // parameterized in the tangent plane, iterated twice.
    for _ in 0..2 {
        let g_norm = norm(g);
        if g_norm < 1e-6 {
            break;
        }
        let g_dir = scale(g, 1.0 / g_norm);
        let tmp = if g_dir[0].abs() < 0.9 {
            [1.0, 0.0, 0.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        let b1 = normalize(cross(g_dir, tmp));
        let b2 = cross(g_dir, b1);
        // Unknowns [s, δ(2), v(3n)]: g = GRAVITY·(g_dir + B δ).
        let n2 = 3 + 3 * n;
        let mut rows2: Vec<Vec<(usize, f64)>> = Vec::with_capacity(rows.len());
        let mut rhs2: Vec<f64> = Vec::with_capacity(rows.len());
        for (row, b) in rows.iter().zip(&rhs) {
            let mut out_row: Vec<(usize, f64)> = Vec::with_capacity(row.len());
            let mut b_adj = *b;
            for &(col, val) in row {
                if col == 0 {
                    out_row.push((0, val));
                } else if col < 4 {
                    let c = col - 1;
                    out_row.push((1, val * GRAVITY * b1[c]));
                    out_row.push((2, val * GRAVITY * b2[c]));
                    b_adj -= val * GRAVITY * g_dir[c];
                } else {
                    out_row.push((col - 1, val));
                }
            }
            rows2.push(out_row);
            rhs2.push(b_adj);
        }
        let sol2 = lstsq_rows(&rows2, &rhs2, n2);
        s_se = scale_std_err(&rows2, &rhs2, &sol2, n2);
        s = sol2[0];
        let delta = [sol2[1], sol2[2]];
        g = scale(
            add(g_dir, add(scale(b1, delta[0]), scale(b2, delta[1]))),
            GRAVITY,
        );
        g = scale(normalize(g), GRAVITY);
        v = (0..n)
            .map(|i| [sol2[3 + 3 * i], sol2[3 + 3 * i + 1], sol2[3 + 3 * i + 2]])
            .collect();
    }
    // Position rows are rows 6k..6k+3 of interval k's block; unweight them to
    // metric residuals of the final (s, g, v).
    let x: Vec<f64> = std::iter::once(s)
        .chain(g)
        .chain(v.iter().flatten().copied())
        .collect();
    let mut resid = Vec::with_capacity(3 * intervals.len());
    for (k, &(_, w_p, sp)) in intervals.iter().enumerate() {
        for r in 0..3 {
            let row = &rows[6 * k + r];
            let pred: f64 = row.iter().map(|&(c, val)| val * x[c]).sum();
            let e = (pred - rhs[6 * k + r]) / w_p;
            resid.push((e * e, sp));
        }
    }
    let dof_frac = if rows.len() > n_unknowns {
        (rows.len() - n_unknowns) as f64 / rows.len() as f64
    } else {
        0.0
    };
    (s, g, v, s_se, resid, dof_frac)
}

/// Standard error of unknown 0 (the metric scale) of the weighted linear
/// system `rows · x = rhs` solved as `sol`, via `[(AᵀA)⁻¹]₀₀ = 1/‖(I − P)a₀‖²`
/// (`P` projects onto the other columns): one extra regression of the scale
/// column on the rest. The residual variance comes from the fit itself, so
/// the row weighting's absolute units cancel. Infinite when the scale is not
/// determined.
fn scale_std_err(rows: &[Vec<(usize, f64)>], rhs: &[f64], sol: &[f64], n_cols: usize) -> f64 {
    let dof = rows.len().saturating_sub(n_cols);
    if dof == 0 || n_cols < 2 {
        return f64::INFINITY;
    }
    let rss: f64 = rows
        .iter()
        .zip(rhs)
        .map(|(row, b)| (row.iter().map(|&(c, v)| v * sol[c]).sum::<f64>() - b).powi(2))
        .sum();
    let a0: Vec<f64> = rows
        .iter()
        .map(|row| row.iter().filter(|e| e.0 == 0).map(|e| e.1).sum())
        .collect();
    let rest: Vec<Vec<(usize, f64)>> = rows
        .iter()
        .map(|row| {
            row.iter()
                .filter(|e| e.0 != 0)
                .map(|&(c, v)| (c - 1, v))
                .collect()
        })
        .collect();
    let beta = lstsq_rows(&rest, &a0, n_cols - 1);
    let r0: f64 = rest
        .iter()
        .zip(&a0)
        .map(|(row, a)| (a - row.iter().map(|&(c, v)| v * beta[c]).sum::<f64>()).powi(2))
        .sum();
    if r0 <= 0.0 || !r0.is_finite() {
        return f64::INFINITY;
    }
    (rss / dof as f64 / r0).sqrt()
}

// ---------------------------------------------------------------------------
// Full VI bundle adjustment
// ---------------------------------------------------------------------------

pub fn solve_vio(
    frames: &[FrameObservations],
    imu: &[ImuSample],
    opts: &SolveOptions,
    warm_start: Option<&VioResult>,
    mut progress: Option<ProgressFn>,
) -> VioResult {
    let mut led_ids: Vec<u32> = frames
        .iter()
        .flat_map(|fr| fr.obs.iter().map(|o| o.0))
        .collect();
    led_ids.sort_unstable();
    led_ids.dedup();
    let n = frames.len();
    let m = led_ids.len();
    let id_index = |led: u32| led_ids.binary_search(&led).unwrap();
    let g_idx = gauge_frame(frames);

    // ---- Stages 1–3: seeds (or warm start) --------------------------------
    let (rotations, centers, v_seed, led_seed, g_seed, bg_seed, ba_seed) = match warm_start {
        Some(ws) => {
            let mut rotations = Vec::with_capacity(n);
            let mut centers = Vec::with_capacity(n);
            let mut v_seed = Vec::with_capacity(n);
            for fr in frames {
                let mut best = 0usize;
                let mut best_d = f64::INFINITY;
                for (i, t) in ws.frame_times.iter().enumerate() {
                    let d = (t - fr.t).abs();
                    if d < best_d {
                        best_d = d;
                        best = i;
                    }
                }
                rotations.push(quat_to_rotmat(ws.quats[best]));
                centers.push(ws.positions[best]);
                v_seed.push(ws.velocities[best]);
            }
            let led_seed: Vec<Vec3> = led_ids
                .iter()
                .map(|id| ws.led_pos(*id).unwrap_or(ZERO3))
                .collect();
            (
                rotations,
                centers,
                v_seed,
                led_seed,
                ws.gravity,
                ws.gyro_bias,
                ws.accel_bias,
            )
        }
        None => {
            let rotations = rotation_seeds(frames, imu);
            let (mut centers, mut led_seed) =
                known_rotation_linear_init(frames, &rotations, &led_ids, g_idx);
            let (s, g_seed, v_seed, _) =
                inertial_alignment(frames, &rotations, &centers, imu, ZERO3, ZERO3);
            for c in centers.iter_mut() {
                *c = scale(*c, s);
            }
            for x in led_seed.iter_mut() {
                *x = scale(*x, s);
            }
            (rotations, centers, v_seed, led_seed, g_seed, ZERO3, ZERO3)
        }
    };

    // ---- Stage 4: nonlinear VI-BA ------------------------------------------
    // Layout: per frame [rotvec, p, v] (9n), per led X (3m), bg ba g (9).
    let off_led = 9 * n;
    let off_bias = off_led + 3 * m;
    let n_par = off_bias + 9;

    let mut x0 = vec![0.0; n_par];
    for i in 0..n {
        let rv = so3_log(&rotations[i]);
        x0[9 * i..9 * i + 3].copy_from_slice(&rv);
        x0[9 * i + 3..9 * i + 6].copy_from_slice(&centers[i]);
        x0[9 * i + 6..9 * i + 9].copy_from_slice(&v_seed[i]);
    }
    for j in 0..m {
        x0[off_led + 3 * j..off_led + 3 * j + 3].copy_from_slice(&led_seed[j]);
    }
    x0[off_bias..off_bias + 3].copy_from_slice(&bg_seed);
    x0[off_bias + 3..off_bias + 6].copy_from_slice(&ba_seed);
    x0[off_bias + 6..off_bias + 9].copy_from_slice(&g_seed);
    let gauge_rot_seed = so3_log(&rotations[g_idx]);
    let gauge_pos_seed = centers[g_idx];

    // Flattened observations.
    struct Obs {
        i: usize,
        j: usize,
        u: f64,
        v: f64,
        k: [f64; 4],
    }
    let mut obs_flat: Vec<Obs> = Vec::new();
    for (i, fr) in frames.iter().enumerate() {
        for &(led, u, v) in &fr.obs {
            obs_flat.push(Obs {
                i,
                j: id_index(led),
                u,
                v,
                k: fr.k,
            });
        }
    }
    let n_obs = obs_flat.len();
    let n_int = n - 1;

    // Interval noise scaling (counts from the RAW imu stream, like Python).
    let imu_t = imu_times(imu);
    let mut sig_r = vec![0.0; n_int];
    let mut sig_v = vec![0.0; n_int];
    let mut sig_p = vec![0.0; n_int];
    for i in 0..n_int {
        let (sr, sv, sp, _hole) = interval_sigmas(
            &imu_t,
            frames[i].t,
            frames[i + 1].t,
            opts.gyro_noise,
            opts.accel_noise,
        );
        sig_r[i] = sr;
        sig_v[i] = sv;
        sig_p[i] = sp;
    }

    let frame_times: Vec<f64> = frames.iter().map(|f| f.t).collect();
    let segments = bucket_intervals(&frame_times, imu);
    let interval_dts = segments.interval_dts.clone();
    let preint = RefCell::new(PreintCache::new());

    let hub_delta = opts.huber_px / opts.px_sigma;
    let robustify = move |r: f64| -> f64 {
        let q = r / hub_delta;
        r.signum() * hub_delta * (2.0 * ((1.0 + q * q).sqrt() - 1.0)).sqrt()
    };

    // Strip-prior rope links, resolved to LED parameter indices.
    let links: Vec<(usize, usize, f64)> = if opts.chain_sigma > 0.0 {
        opts.chain
            .iter()
            .filter_map(|&(a, b, max_dist)| {
                let ja = led_ids.binary_search(&a).ok()?;
                let jb = led_ids.binary_search(&b).ok()?;
                (ja != jb && max_dist.is_finite()).then_some((ja, jb, max_dist))
            })
            .collect()
    } else {
        Vec::new()
    };
    let chain_sigma = opts.chain_sigma;

    let n_res_base = 2 * n_obs + 9 * n_int + 6 + 1 + 6;
    let n_res = n_res_base + links.len();

    // Sparsity pattern (mirrors the Python lil_matrix construction). Built
    // BEFORE the residual closure takes ownership of obs_flat.
    let mut spar = Sparsity::new(n_res, n_par);
    {
        let mut k = 0usize;
        for o in &obs_flat {
            spar.block(k, k + 2, 9 * o.i, 9 * o.i + 6);
            spar.block(k, k + 2, off_led + 3 * o.j, off_led + 3 * o.j + 3);
            k += 2;
        }
        for i in 0..n_int {
            spar.block(k, k + 9, 9 * i, 9 * i + 18);
            spar.block(k, k + 9, off_bias, off_bias + 9);
            k += 9;
        }
        spar.block(k, k + 6, off_bias, off_bias + 6);
        k += 6;
        spar.block(k, k + 1, off_bias + 6, off_bias + 9);
        k += 1;
        spar.block(k, k + 6, 9 * g_idx, 9 * g_idx + 6);
        k += 6;
        for &(ja, jb, _) in &links {
            spar.block(k, k + 1, off_led + 3 * ja, off_led + 3 * ja + 3);
            spar.block(k, k + 1, off_led + 3 * jb, off_led + 3 * jb + 3);
            k += 1;
        }
    }

    // Shared snapshot for the progress hook (single-threaded interleaving:
    // the residual writes, the eval hook reads).
    struct Snapshot {
        rms: f64,
        leds: Vec<Vec3>,
        ps: Vec<Vec3>,
    }
    let snapshot = Rc::new(RefCell::new(Snapshot {
        rms: 0.0,
        leds: vec![ZERO3; m],
        ps: vec![ZERO3; n],
    }));

    let px_sigma = opts.px_sigma;
    let snap_w = snapshot.clone();
    let sig_r2 = sig_r.clone();
    let mut residuals = move |x: &[f64], out: &mut [f64]| {
        let rotm: Vec<Mat3> = (0..n)
            .map(|i| so3_exp([x[9 * i], x[9 * i + 1], x[9 * i + 2]]))
            .collect();
        let bg = [x[off_bias], x[off_bias + 1], x[off_bias + 2]];
        let ba = [x[off_bias + 3], x[off_bias + 4], x[off_bias + 5]];
        let g = [x[off_bias + 6], x[off_bias + 7], x[off_bias + 8]];

        // Reprojection block.
        let mut sq_sum = 0.0;
        for (oi, o) in obs_flat.iter().enumerate() {
            let p = [x[9 * o.i + 3], x[9 * o.i + 4], x[9 * o.i + 5]];
            let led = [
                x[off_led + 3 * o.j],
                x[off_led + 3 * o.j + 1],
                x[off_led + 3 * o.j + 2],
            ];
            let xc = mat_tvec(&rotm[o.i], sub(led, p));
            let depth = -xc[2];
            let (mut ru, mut rv);
            if depth <= 1e-6 {
                ru = 50.0;
                rv = 50.0;
            } else {
                let [fx, fy, cx, cy] = o.k;
                ru = (cx + fx * xc[0] / depth - o.u) / px_sigma;
                rv = (cy - fy * xc[1] / depth - o.v) / px_sigma;
            }
            sq_sum += ru * ru + rv * rv;
            ru = robustify(ru);
            rv = robustify(rv);
            out[2 * oi] = ru;
            out[2 * oi + 1] = rv;
        }
        let raw_rms = if n_obs > 0 {
            (sq_sum / (2.0 * n_obs as f64)).sqrt() * px_sigma
        } else {
            0.0
        };

        // IMU preintegration factors.
        let mut k = 2 * n_obs;
        if n_int > 0 {
            let (d_rot_t, d_vel, d_pos) = preint.borrow_mut().query(&segments, bg, ba);
            for i in 0..n_int {
                let ri = &rotm[i];
                let rj = &rotm[i + 1];
                let dt = interval_dts[i];
                // rel = ΔR_meas^T · R_i^T · R_j
                let ritrj = mat_mul(&crate::linalg::transpose(ri), rj);
                let rel = mat_mul(&d_rot_t[i], &ritrj);
                let r_err = so3_log(&rel);
                let vi = [x[9 * i + 6], x[9 * i + 7], x[9 * i + 8]];
                let vj = [x[9 * (i + 1) + 6], x[9 * (i + 1) + 7], x[9 * (i + 1) + 8]];
                let pi = [x[9 * i + 3], x[9 * i + 4], x[9 * i + 5]];
                let pj = [x[9 * (i + 1) + 3], x[9 * (i + 1) + 4], x[9 * (i + 1) + 5]];
                let v_world = sub(sub(vj, vi), scale(g, dt));
                let v_err = sub(mat_tvec(ri, v_world), d_vel[i]);
                let p_world = sub(sub(sub(pj, pi), scale(vi, dt)), scale(g, 0.5 * dt * dt));
                let p_err = sub(mat_tvec(ri, p_world), d_pos[i]);
                for r in 0..3 {
                    out[k + r] = r_err[r] / sig_r2[i];
                    out[k + 3 + r] = v_err[r] / sig_v[i];
                    out[k + 6 + r] = p_err[r] / sig_p[i];
                }
                k += 9;
            }
        }
        // Bias priors.
        for r in 0..3 {
            out[k + r] = bg[r] / 5e-3;
            out[k + 3 + r] = ba[r] / 5e-2;
        }
        k += 6;
        // Gravity magnitude prior.
        out[k] = (norm(g) - GRAVITY) / 1e-3;
        k += 1;
        // Gauge: pin the best-observed pose (gauge_frame) at its seed.
        let gi = 9 * g_idx;
        for r in 0..3 {
            out[k + r] = (x[gi + r] - gauge_rot_seed[r]) / 1e-6;
            out[k + 3 + r] = (x[gi + 3 + r] - gauge_pos_seed[r]) / 1e-6;
        }
        // Strip prior: one-sided rope penalty per link.
        for (li, &(ja, jb, max_dist)) in links.iter().enumerate() {
            let xa = [
                x[off_led + 3 * ja],
                x[off_led + 3 * ja + 1],
                x[off_led + 3 * ja + 2],
            ];
            let xb = [
                x[off_led + 3 * jb],
                x[off_led + 3 * jb + 1],
                x[off_led + 3 * jb + 2],
            ];
            let excess = norm(sub(xa, xb)) - max_dist;
            out[n_res_base + li] = if excess > 0.0 {
                excess / chain_sigma
            } else {
                0.0
            };
        }

        // Snapshot for progress reporting.
        let mut snap = snap_w.borrow_mut();
        snap.rms = raw_rms;
        for j in 0..m {
            snap.leds[j] = [
                x[off_led + 3 * j],
                x[off_led + 3 * j + 1],
                x[off_led + 3 * j + 2],
            ];
        }
        for i in 0..n {
            snap.ps[i] = [x[9 * i + 3], x[9 * i + 4], x[9 * i + 5]];
        }
    };

    let led_ids_hook = led_ids.clone();
    let snap_r = snapshot.clone();
    let mut hook_fn;
    let hook: Option<&mut dyn FnMut(f64)> = match progress.as_mut() {
        Some(cb) => {
            hook_fn = move |frac: f64| {
                let snap = snap_r.borrow();
                cb(frac, snap.rms, &led_ids_hook, &snap.leds, &snap.ps);
            };
            Some(&mut hook_fn)
        }
        None => None,
    };

    let fit = least_squares_lm(
        &mut residuals,
        &x0,
        spar,
        &LmOptions {
            max_nfev: opts.max_nfev,
            ftol: opts.ftol,
        },
        hook,
    );
    let x = fit.x;

    let rots: Vec<Mat3> = (0..n)
        .map(|i| so3_exp([x[9 * i], x[9 * i + 1], x[9 * i + 2]]))
        .collect();
    let mut ps: Vec<Vec3> = (0..n)
        .map(|i| [x[9 * i + 3], x[9 * i + 4], x[9 * i + 5]])
        .collect();
    let mut vs: Vec<Vec3> = (0..n)
        .map(|i| [x[9 * i + 6], x[9 * i + 7], x[9 * i + 8]])
        .collect();
    let mut leds: Vec<Vec3> = (0..m)
        .map(|j| {
            [
                x[off_led + 3 * j],
                x[off_led + 3 * j + 1],
                x[off_led + 3 * j + 2],
            ]
        })
        .collect();
    let bg = [x[off_bias], x[off_bias + 1], x[off_bias + 2]];
    let ba = [x[off_bias + 3], x[off_bias + 4], x[off_bias + 5]];
    let g = [x[off_bias + 6], x[off_bias + 7], x[off_bias + 8]];

    // A-posteriori metric re-anchor (see vio.py: accel-bias freedom can
    // drift the global scale on low-excitation sessions). Preintegrate with
    // the biases the BA just estimated: with zero biases a typical phone
    // accel bias alone pulls the scale ~15% low even on a well-excited
    // capture.
    let mut scale_rel_se = f64::INFINITY;
    if n_int > 0 {
        let (s_post, _g_post, v_post, s_se) = inertial_alignment(frames, &rots, &ps, imu, bg, ba);
        if s_post.is_finite() && s_post > 1e-3 {
            scale_rel_se = s_se / s_post;
        }
        if s_post.is_finite() && s_post > 1e-3 && (s_post - 1.0).abs() > 0.02 {
            for p in ps.iter_mut() {
                *p = scale(*p, s_post);
            }
            vs = v_post;
            for l in leds.iter_mut() {
                *l = scale(*l, s_post);
            }
        }
    }

    // Final rms against the (possibly re-anchored) state.
    let rms = reproj_rms(frames, &rots, &ps, &leds, &led_ids);
    let quats: Vec<Quat> = rots.iter().map(rotmat_to_quat).collect();
    VioResult {
        led_ids,
        led_positions: leds,
        positions: ps,
        quats,
        velocities: vs,
        gravity: g,
        gyro_bias: bg,
        accel_bias: ba,
        rms_reproj_px: rms,
        frame_times,
        scale_rel_se,
    }
}

/// Raw reprojection rms (px) with the same behind-camera penalty semantics
/// as the residual function (bad pixels count as 50σ in each axis).
fn reproj_rms(
    frames: &[FrameObservations],
    rots: &[Mat3],
    ps: &[Vec3],
    leds: &[Vec3],
    led_ids: &[u32],
) -> f64 {
    let mut sq = 0.0;
    let mut cnt = 0usize;
    for (i, fr) in frames.iter().enumerate() {
        for &(led, u, v) in &fr.obs {
            let j = match led_ids.binary_search(&led) {
                Ok(j) => j,
                Err(_) => continue,
            };
            let xc = mat_tvec(&rots[i], sub(leds[j], ps[i]));
            let depth = -xc[2];
            let (du, dv);
            if depth <= 1e-6 {
                du = 50.0;
                dv = 50.0;
            } else {
                let [fx, fy, cx, cy] = fr.k;
                du = cx + fx * xc[0] / depth - u;
                dv = cy - fy * xc[1] / depth - v;
            }
            sq += du * du + dv * dv;
            cnt += 1;
        }
    }
    if cnt == 0 {
        0.0
    } else {
        (sq / (2.0 * cnt as f64)).sqrt()
    }
}

// ---------------------------------------------------------------------------
// Similarity (Horn) alignment — evaluation/test helper.
// ---------------------------------------------------------------------------

pub fn similarity_align(src: &[Vec3], dst: &[Vec3]) -> (f64, Mat3, Vec3) {
    let n = src.len() as f64;
    let mut mu_s = ZERO3;
    let mut mu_d = ZERO3;
    for (s, d) in src.iter().zip(dst) {
        mu_s = add(mu_s, *s);
        mu_d = add(mu_d, *d);
    }
    mu_s = scale(mu_s, 1.0 / n);
    mu_d = scale(mu_d, 1.0 / n);
    let mut cov = [[0.0; 3]; 3];
    let mut var = 0.0;
    for (s, d) in src.iter().zip(dst) {
        let sc = sub(*s, mu_s);
        let dc = sub(*d, mu_d);
        // Outer product dc·scᵀ: `i` and `j` index the covariance matrix and the
        // two centered vectors — a 2-D matrix build, not a single-slice walk.
        #[allow(clippy::needless_range_loop)]
        for i in 0..3 {
            for j in 0..3 {
                cov[i][j] += dc[i] * sc[j] / n;
            }
        }
        var += dot(sc, sc);
    }
    var /= n;
    let (u, d, vt) = crate::linalg::svd3(&cov);
    let mut sgn = EYE3;
    if crate::linalg::det3(&mat_mul(&u, &vt)) < 0.0 {
        sgn[2][2] = -1.0;
    }
    let rot = mat_mul(&u, &mat_mul(&sgn, &vt));
    let s = (d[0] * sgn[0][0] + d[1] * sgn[1][1] + d[2] * sgn[2][2]) / var;
    let t = sub(mu_d, mat_vec(&rot, scale(mu_s, s)));
    (s, rot, t)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::camera::{look_at, project};
    use crate::linalg::{add, mat_mul, mat_tvec, scale, sub, transpose};
    use crate::synth::Rng;

    /// A 60-LED coil (7 cm radius, 16 cm tall) watched from a camera orbiting
    /// at 0.75 m: `sweep` rad of arc over `dur` s plus a `bob` m vertical bob.
    /// Smaller sweep/bob over a longer time = gentler motion = less inertial
    /// excitation, the regime where a diffuse capture loses metric scale.
    fn coil_session(
        dur: f64,
        sweep: f64,
        bob: f64,
        seed: u64,
    ) -> (Vec<FrameObservations>, Vec<ImuSample>, Vec<Vec3>) {
        let leds: Vec<Vec3> = (0..60)
            .map(|i| {
                let f = i as f64 / 59.0;
                let th = f * 2.5 * std::f64::consts::TAU;
                [0.07 * th.cos(), -0.08 + 0.16 * f, 0.07 * th.sin()]
            })
            .collect();
        let pos = |t: f64| -> Vec3 {
            let th = -0.5 * sweep + sweep * (t / dur);
            [
                0.75 * th.sin(),
                0.1 + bob * (0.7 * t).sin(),
                0.75 * th.cos(),
            ]
        };
        let rot = |t: f64| look_at(pos(t), ZERO3);
        let mut rng = Rng::new(seed);
        let (imu_hz, h) = (100.0, 1e-4);
        let (gyro_bias, accel_bias) = ([2e-3, -1e-3, 1.5e-3], [0.03, -0.02, 0.04]);
        let imu: Vec<ImuSample> = (0..(dur * imu_hz) as usize)
            .map(|i| {
                let t = i as f64 / imu_hz;
                let r = rot(t);
                let mut gyro = scale(so3_log(&mat_mul(&transpose(&r), &rot(t + h))), 1.0 / h);
                let a = scale(
                    sub(add(pos(t + h), pos(t - h)), scale(pos(t), 2.0)),
                    1.0 / (h * h),
                );
                let mut accel = mat_tvec(&r, sub(a, G_WORLD));
                for k in 0..3 {
                    gyro[k] += gyro_bias[k] + 2e-3 * rng.normal();
                    accel[k] += accel_bias[k] + 5e-2 * rng.normal();
                }
                ImuSample { t, gyro, accel }
            })
            .collect();
        let k = [800.0, 800.0, 640.0, 360.0];
        let frames: Vec<FrameObservations> = (0..(dur * 3.0) as usize)
            .map(|i| {
                let t = i as f64 / 3.0;
                let (p, r) = (pos(t), rot(t));
                let obs = leds
                    .iter()
                    .enumerate()
                    .filter_map(|(j, l)| {
                        let (u, v, d) = project(&r, p, k, *l);
                        (d > 0.0 && (0.0..1280.0).contains(&u) && (0.0..720.0).contains(&v))
                            .then(|| (j as u32, u + 0.5 * rng.normal(), v + 0.5 * rng.normal()))
                    })
                    .collect();
                FrameObservations { t, k, obs }
            })
            .collect();
        (frames, imu, leds)
    }

    /// Solved size relative to truth (1 = metric).
    fn solved_size(res: &VioResult, leds: &[Vec3]) -> f64 {
        let truth: Vec<Vec3> = res.led_ids.iter().map(|&id| leds[id as usize]).collect();
        1.0 / similarity_align(&res.led_positions, &truth).0
    }

    #[test]
    fn reanchor_uses_the_estimated_biases() {
        // A well-excited capture. Re-anchoring with zero biases let the
        // accel bias pull these to 0.87 / 0.84 of true size; with the BA's
        // biases they land within 10%.
        for seed in [1, 2] {
            let (frames, imu, leds) = coil_session(10.0, 1.0, 0.15, seed);
            let res = solve_vio(&frames, &imu, &SolveOptions::default(), None, None);
            let size = solved_size(&res, &leds);
            assert!(
                (size - 1.0).abs() < 0.1,
                "seed {seed}: size {size:.3} of true"
            );
            assert!(
                res.scale_rel_se < 0.1,
                "seed {seed}: rel se {:.3}",
                res.scale_rel_se
            );
        }
    }

    #[test]
    fn a_near_static_capture_reports_an_undetermined_scale() {
        // A minute of barely-moving phone: the BA shrinks this coil to ~1/5
        // of its size and no inertial estimator can recover it. The scale's
        // standard error must say so (the pipeline turns it into a warning).
        let (frames, imu, _) = coil_session(60.0, 0.5, 0.005, 2);
        let res = solve_vio(&frames, &imu, &SolveOptions::default(), None, None);
        assert!(res.scale_rel_se > 0.3, "rel se {:.3}", res.scale_rel_se);
    }

    /// A dwell-and-hop diffuse capture of the coil_session coil: `k` vantage
    /// points on a 0.75 m arc held `dwell` s each with `sway` m of hand sway,
    /// joined by `hop` s minimum-jerk moves; 3 Hz frames with `px` pixel
    /// noise. `hop_frames`: whether the camera decodes anything mid-hop.
    fn dwell_hop_session(
        k: usize,
        dwell: f64,
        hop: f64,
        sway: f64,
        px: f64,
        hop_frames: bool,
        seed: u64,
    ) -> (Vec<FrameObservations>, Vec<ImuSample>, Vec<Vec3>) {
        let fps = 3.0;
        let leds: Vec<Vec3> = (0..60)
            .map(|i| {
                let f = i as f64 / 59.0;
                let th = f * 2.5 * std::f64::consts::TAU;
                [0.07 * th.cos(), -0.08 + 0.16 * f, 0.07 * th.sin()]
            })
            .collect();
        let seg = dwell + hop;
        let dur = k as f64 * dwell + (k - 1) as f64 * hop;
        let arc = |u: f64| -> Vec3 {
            // u in [0, k-1]: vantage index (fractional mid-hop)
            let th = -0.6 + 1.2 * u / (k - 1) as f64;
            let y = 0.1 + 0.12 * ((u * 1.7).sin());
            [0.75 * th.sin(), y, 0.75 * th.cos()]
        };
        let u_of = |t: f64| -> (f64, bool) {
            let i = (t / seg).floor();
            let r = t - i * seg;
            if r < dwell || i as usize >= k - 1 {
                (i.min((k - 1) as f64), false)
            } else {
                let x = (r - dwell) / hop;
                (i + x * x * x * (10.0 - 15.0 * x + 6.0 * x * x), true)
            }
        };
        let ph: Vec<f64> = {
            let mut r = Rng::new(seed ^ 77);
            (0..9).map(|_| r.uniform() * 6.28).collect()
        };
        let pos = |t: f64| -> Vec3 {
            let b = arc(u_of(t).0);
            let w = [0.9, 1.3, 0.6];
            [
                b[0] + sway * (w[0] * t + ph[0]).sin() + 0.5 * sway * (2.3 * t + ph[3]).sin(),
                b[1] + sway * (w[1] * t + ph[1]).sin() + 0.5 * sway * (1.9 * t + ph[4]).sin(),
                b[2] + sway * (w[2] * t + ph[2]).sin() + 0.5 * sway * (2.7 * t + ph[5]).sin(),
            ]
        };
        let rot = |t: f64| look_at(pos(t), ZERO3);
        let mut rng = Rng::new(seed);
        let (imu_hz, h) = (100.0, 1e-4);
        let (gyro_bias, accel_bias) = ([2e-3, -1e-3, 1.5e-3], [0.03, -0.02, 0.04]);
        let imu: Vec<ImuSample> = (0..(dur * imu_hz) as usize)
            .map(|i| {
                let t = i as f64 / imu_hz;
                let r = rot(t);
                let mut gyro = scale(so3_log(&mat_mul(&transpose(&r), &rot(t + h))), 1.0 / h);
                let a = scale(
                    sub(add(pos(t + h), pos(t - h)), scale(pos(t), 2.0)),
                    1.0 / (h * h),
                );
                let mut accel = mat_tvec(&r, sub(a, G_WORLD));
                for c in 0..3 {
                    gyro[c] += gyro_bias[c] + 2e-3 * rng.normal();
                    accel[c] += accel_bias[c] + 5e-2 * rng.normal();
                }
                ImuSample { t, gyro, accel }
            })
            .collect();
        let kk = [800.0, 800.0, 640.0, 360.0];
        let frames: Vec<FrameObservations> = (0..(dur * fps) as usize)
            .filter_map(|i| {
                let t = i as f64 / fps;
                if !hop_frames && u_of(t).1 {
                    return None;
                }
                let (p, r) = (pos(t), rot(t));
                let obs: Vec<_> = leds
                    .iter()
                    .enumerate()
                    .filter_map(|(j, l)| {
                        let (u, v, d) = project(&r, p, kk, *l);
                        (d > 0.0 && (0.0..1280.0).contains(&u) && (0.0..720.0).contains(&v))
                            .then(|| (j as u32, u + px * rng.normal(), v + px * rng.normal()))
                    })
                    .collect();
                Some(FrameObservations { t, k: kk, obs })
            })
            .collect();
        (frames, imu, leds)
    }

    #[test]
    fn dwell_heavy_captures_keep_the_scale_the_hops_carry() {
        // A diffuse capture: five 10 s holds with hand sway, 1 s hops between
        // vantage points, and NO camera frames during the hops (the decoder
        // loses lock while moving). Vision-pose jitter on the ~145 hold
        // intervals used to dilute the linear alignment's scale to 0.2-0.6 of
        // true size, which the BA then kept; modelling the center noise lets
        // the 4 hops set the scale.
        for seed in [1, 2] {
            let (frames, imu, leds) = dwell_hop_session(5, 10.0, 1.0, 0.003, 2.0, false, seed);
            let res = solve_vio(&frames, &imu, &SolveOptions::default(), None, None);
            let size = solved_size(&res, &leds);
            assert!(
                (size - 1.0).abs() < 0.1,
                "seed {seed}: size {size:.3} of true"
            );
            assert!(
                res.scale_rel_se < 0.1,
                "seed {seed}: rel se {:.3}",
                res.scale_rel_se
            );
        }
    }

    #[test]
    fn dwell_heavy_captures_with_frames_through_the_hops() {
        for seed in [1, 2] {
            let (frames, imu, leds) = dwell_hop_session(5, 10.0, 1.0, 0.003, 2.0, true, seed);
            let res = solve_vio(&frames, &imu, &SolveOptions::default(), None, None);
            let size = solved_size(&res, &leds);
            assert!(
                (size - 1.0).abs() < 0.05,
                "seed {seed}: size {size:.3} of true"
            );
        }
    }
}
