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
}

impl Default for SolveOptions {
    fn default() -> Self {
        SolveOptions {
            px_sigma: 0.5,
            gyro_noise: 2e-3,
            accel_noise: 5e-2,
            huber_px: 4.0,
            max_nfev: 60,
            ftol: 1e-6,
        }
    }
}

/// Progress hook: (frac, rms_px, led_ids, led_positions, camera_positions).
/// Called after every residual evaluation — carriers throttle.
pub type ProgressFn<'a> = &'a mut dyn FnMut(f64, f64, &[u32], &[Vec3], &[Vec3]);

// ---------------------------------------------------------------------------
// Initialization stages
// ---------------------------------------------------------------------------

fn rotation_seeds(frames: &[FrameObservations], imu: &[ImuSample]) -> Vec<Mat3> {
    let t_start = frames[0].t;
    let early: Vec<Vec3> = {
        let e: Vec<Vec3> = imu
            .iter()
            .filter(|s| s.t <= t_start + 0.5)
            .map(|s| s.accel)
            .collect();
        if e.is_empty() {
            vec![imu[0].accel]
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
    let mut seeds = vec![r0];
    for i in 1..frames.len() {
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
) -> (Vec<Vec3>, Vec<Vec3>) {
    const SCALE_PINS: usize = 64;
    const W_PIN: f64 = 0.05;
    let n_frames = frames.len();
    let n_leds = led_ids.len();
    let n_unknowns = 3 * (n_frames - 1) + 3 * n_leds;
    let id_index = |led: u32| led_ids.binary_search(&led).unwrap();

    let col_c = |i: usize| -> Option<usize> {
        if i == 0 {
            None
        } else {
            Some(3 * (i - 1))
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
    for i in 1..n_frames {
        centers[i] = [sol[3 * (i - 1)], sol[3 * (i - 1) + 1], sol[3 * (i - 1) + 2]];
    }
    let leds: Vec<Vec3> = (0..n_leds)
        .map(|j| [sol[col_x(j)], sol[col_x(j) + 1], sol[col_x(j) + 2]])
        .collect();
    (centers, leds)
}

/// Linear visual-inertial alignment: scale, gravity, per-frame velocities
/// from zero-bias preintegration deltas, then the gravity-magnitude-
/// constrained re-solve (2 iterations). Port of vio._inertial_alignment.
pub fn inertial_alignment(
    frames: &[FrameObservations],
    rotations: &[Mat3],
    centers: &[Vec3],
    imu: &[ImuSample],
) -> (f64, Vec3, Vec<Vec3>) {
    let n = frames.len();
    let n_unknowns = 1 + 3 + 3 * n;
    let mut rows: Vec<Vec<(usize, f64)>> = Vec::with_capacity(6 * (n - 1));
    let mut rhs: Vec<f64> = Vec::with_capacity(6 * (n - 1));
    // Keep the raw g-block coefficients per row for the constrained re-solve:
    // (row triplets excluding g, g-coeff 3-row block, rhs).
    for i in 0..n - 1 {
        let (d_rot, d_vel, d_pos, dt) =
            preintegrate(imu, frames[i].t, frames[i + 1].t, ZERO3, ZERO3);
        let _ = d_rot;
        let rit_rows = rotations[i]; // use columns of R as rows of R^T
        let dc = sub(centers[i + 1], centers[i]);
        let rit_dc = mat_tvec(&rit_rows, dc);
        for r in 0..3 {
            // R_i^T (s·Δc − v_i·dt − ½·g·dt²) = Δp
            let mut row: Vec<(usize, f64)> = Vec::with_capacity(7);
            row.push((0, rit_dc[r]));
            for c in 0..3 {
                let rit_rc = rotations[i][c][r]; // (R^T)[r][c]
                row.push((1 + c, -0.5 * dt * dt * rit_rc));
                row.push((4 + 3 * i + c, -dt * rit_rc));
            }
            rows.push(row);
            rhs.push(d_pos[r]);
        }
        for r in 0..3 {
            // R_i^T (v_j − v_i − g·dt) = Δv
            let mut row: Vec<(usize, f64)> = Vec::with_capacity(9);
            for c in 0..3 {
                let rit_rc = rotations[i][c][r];
                row.push((1 + c, -dt * rit_rc));
                row.push((4 + 3 * i + c, -rit_rc));
                row.push((4 + 3 * (i + 1) + c, rit_rc));
            }
            rows.push(row);
            rhs.push(d_vel[r]);
        }
    }
    let sol = lstsq_rows(&rows, &rhs, n_unknowns);
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
    (s, g, v)
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
                known_rotation_linear_init(frames, &rotations, &led_ids);
            let (s, g_seed, v_seed) = inertial_alignment(frames, &rotations, &centers, imu);
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
    let rot0_seed = so3_log(&rotations[0]);

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
    let mut sig_r = vec![0.0; n_int];
    let mut sig_v = vec![0.0; n_int];
    let mut sig_p = vec![0.0; n_int];
    for i in 0..n_int {
        let (t0, t1) = (frames[i].t, frames[i + 1].t);
        let cnt = imu.iter().filter(|s| t0 <= s.t && s.t < t1).count().max(1) as f64;
        let dt = (t1 - t0) / cnt;
        sig_r[i] = (opts.gyro_noise * cnt.sqrt() * dt).max(1e-6);
        sig_v[i] = (opts.accel_noise * cnt.sqrt() * dt).max(1e-6);
        sig_p[i] = (0.5 * opts.accel_noise * cnt.sqrt() * dt * (t1 - t0)).max(1e-7);
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

    let n_res = 2 * n_obs + 9 * n_int + 6 + 1 + 6;

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
        spar.block(k, k + 6, 0, 6);
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
        // Gauge: pin pose 0.
        for r in 0..3 {
            out[k + r] = (x[r] - rot0_seed[r]) / 1e-6;
            out[k + 3 + r] = x[3 + r] / 1e-6;
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
    // drift the global scale on low-excitation sessions).
    if n_int > 0 {
        let (s_post, _g_post, v_post) = inertial_alignment(frames, &rots, &ps, imu);
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
