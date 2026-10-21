//! Wire-format reconstruction pipeline — port of `reconstruction/vio_api.py`
//! (+ the consensus filter and triangulation helpers it borrows from api.py
//! and triangulate.py). See the Python docstrings for the rationale behind
//! every stage; structure and thresholds are identical.

use std::collections::BTreeMap;

use crate::camera::project;
use crate::diag::{assess_state, Assessment};
use crate::linalg::{
    add, cross, dot, mat_vec, norm, normalize, scale, solve3_spd, sub, Mat3, Vec3, EYE3, ZERO3,
};
use crate::quat::{back_project_dir, quat_to_rotmat};
use crate::strip;
use crate::types::{
    LedEntry, OutputMap, OutputMapStats, Problem, ProgressLed, ProgressSnapshot, WarmState,
};
use crate::vio::{solve_vio, FrameObservations, ProgressFn, SolveOptions, VioResult};

// ---------------------------------------------------------------------------
// Small stats helpers (numpy-compatible median / linear-interp percentile).
// ---------------------------------------------------------------------------

fn median(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v: Vec<f64> = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 {
        v[n / 2]
    } else {
        0.5 * (v[n / 2 - 1] + v[n / 2])
    }
}

fn percentile(values: &[f64], q: f64) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let mut v: Vec<f64> = values.to_vec();
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let pos = q / 100.0 * (v.len() - 1) as f64;
    let lo = pos.floor() as usize;
    let hi = pos.ceil() as usize;
    if lo == hi {
        v[lo]
    } else {
        v[lo] + (v[hi] - v[lo]) * (pos - lo as f64)
    }
}

fn linspace_indices(len: usize, count: usize) -> Vec<usize> {
    if count <= 1 || len <= 1 {
        return vec![0];
    }
    (0..count)
        .map(|k| ((len - 1) as f64 * k as f64 / (count - 1) as f64).round() as usize)
        .collect()
}

// ---------------------------------------------------------------------------
// Triangulation / parallax (triangulate.py)
// ---------------------------------------------------------------------------

pub fn triangulate_point(origins: &[Vec3], dirs: &[Vec3]) -> Result<Vec3, &'static str> {
    if origins.len() < 2 {
        return Err("need at least 2 observations to triangulate");
    }
    let mut a = [[0.0; 3]; 3];
    let mut b = ZERO3;
    for (o, d) in origins.iter().zip(dirs) {
        let d = normalize(*d);
        for i in 0..3 {
            for j in 0..3 {
                let proj = (if i == j { 1.0 } else { 0.0 }) - d[i] * d[j];
                a[i][j] += proj;
            }
        }
        let po = sub(*o, scale(d, dot(d, *o)));
        b = add(b, po);
    }
    solve3_spd(&a, b)
}

pub fn max_parallax_deg(dirs: &[Vec3]) -> f64 {
    let n = dirs.len();
    if n < 2 {
        return 0.0;
    }
    let unit: Vec<Vec3> = dirs.iter().map(|d| normalize(*d)).collect();
    let mut max_angle: f64 = 0.0;
    for i in 0..n {
        for j in i + 1..n {
            let c = dot(unit[i], unit[j]).clamp(-1.0, 1.0);
            max_angle = max_angle.max(c.acos().to_degrees());
        }
    }
    max_angle
}

// ---------------------------------------------------------------------------
// Frame grouping (vio_api.py)
// ---------------------------------------------------------------------------

pub fn frames_from_records(
    detections: &[crate::types::DetectionRecordWire],
    max_keyframes: Option<usize>,
) -> Vec<FrameObservations> {
    let mut by_t: BTreeMap<u64, Vec<&crate::types::DetectionRecordWire>> = BTreeMap::new();
    for rec in detections {
        // tCaptureMs is non-negative, so the f64 bit pattern sorts numerically.
        by_t.entry(rec.t_capture_ms.to_bits())
            .or_default()
            .push(rec);
    }
    let mut times: Vec<u64> = by_t.keys().copied().collect();
    if let Some(maxk) = max_keyframes {
        if times.len() > maxk {
            let mut idx = linspace_indices(times.len(), maxk);
            idx.dedup();
            times = idx.into_iter().map(|i| times[i]).collect();
        }
    }
    times
        .into_iter()
        .map(|tb| {
            let recs = &by_t[&tb];
            FrameObservations {
                t: f64::from_bits(tb) / 1000.0,
                k: recs[0].k,
                obs: recs.iter().map(|r| (r.led_id, r.u, r.v)).collect(),
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Quality scoring + outlier rejection (vio_api.py + api._consensus_filter)
// ---------------------------------------------------------------------------

struct SolvedObs {
    u: f64,
    v: f64,
    k: [f64; 4],
    p: Vec3,
    rot: Mat3, // cam-to-world
    key: (usize, usize),
}

fn reproj_err(o: &SolvedObs, x: Vec3) -> f64 {
    let (u, v, depth) = project(&o.rot, o.p, o.k, x);
    if depth <= 0.0 {
        return f64::INFINITY;
    }
    ((u - o.u).powi(2) + (v - o.v).powi(2)).sqrt()
}

pub fn solved_led_count(
    frames: &[FrameObservations],
    result: &VioResult,
    ceiling_px: f64,
) -> usize {
    let mut errs_by_led: BTreeMap<u32, Vec<f64>> = BTreeMap::new();
    for (fi, fr) in frames.iter().enumerate() {
        let rot = quat_to_rotmat(result.quats[fi]);
        let p = result.positions[fi];
        for &(led, u, v) in &fr.obs {
            let x = match result.led_pos(led) {
                Some(x) => x,
                None => continue,
            };
            let (uu, vv, depth) = project(&rot, p, fr.k, x);
            let e = if depth <= 1e-6 {
                f64::INFINITY
            } else {
                ((uu - u).powi(2) + (vv - v).powi(2)).sqrt()
            };
            errs_by_led.entry(led).or_default().push(e);
        }
    }
    errs_by_led
        .values()
        .filter(|errs| errs.len() >= 2 && median(errs) <= ceiling_px)
        .count()
}

/// RANSAC-style consensus pre-filter for one LED's observations
/// (api._consensus_filter). Returns surviving indices into `obs`.
fn consensus_filter(
    obs: &[SolvedObs],
    min_views: usize,
    engage_p90_px: f64,
    inlier_px: f64,
) -> Vec<usize> {
    const MAX_SEEDS: usize = 10;
    let n = obs.len();
    let all: Vec<usize> = (0..n).collect();
    if n < 4 {
        return all;
    }
    let origins: Vec<Vec3> = obs.iter().map(|o| o.p).collect();
    let dirs: Vec<Vec3> = obs
        .iter()
        .map(|o| back_project_dir(&o.rot, o.k, o.u, o.v))
        .collect();

    if let Ok(x) = triangulate_point(&origins, &dirs) {
        let errs: Vec<f64> = obs.iter().map(|o| reproj_err(o, x)).collect();
        if errs.iter().all(|e| e.is_finite()) && percentile(&errs, 90.0) <= engage_p90_px {
            return all;
        }
    }

    let mut seeds = linspace_indices(n, MAX_SEEDS.min(n));
    seeds.dedup();
    let mut best: Option<Vec<usize>> = None;
    for ai in 0..seeds.len() {
        for bi in ai + 1..seeds.len() {
            let (a, b) = (seeds[ai], seeds[bi]);
            if dot(dirs[a], dirs[b]) > 0.99995 {
                continue;
            }
            let x = match triangulate_point(&[origins[a], origins[b]], &[dirs[a], dirs[b]]) {
                Ok(x) if x.iter().all(|c| c.is_finite()) => x,
                _ => continue,
            };
            let inliers: Vec<usize> = (0..n)
                .filter(|&i| reproj_err(&obs[i], x) <= inlier_px)
                .collect();
            if best.as_ref().is_none_or(|b| inliers.len() > b.len()) {
                best = Some(inliers);
            }
        }
    }
    match best {
        Some(inliers) if inliers.len() >= min_views.max(3) => inliers,
        _ => all,
    }
}

/// Per-observation rejection against the solved trajectory
/// (vio_api.reject_outlier_observations): consensus + re-triangulated MAD.
pub fn reject_outlier_observations(
    frames: &[FrameObservations],
    result: &VioResult,
    outlier_sigma: f64,
    floor_px: f64,
) -> (Vec<FrameObservations>, usize) {
    let mut by_led: BTreeMap<u32, Vec<SolvedObs>> = BTreeMap::new();
    for (fi, fr) in frames.iter().enumerate() {
        let rot = quat_to_rotmat(result.quats[fi]);
        for (oi, &(led, u, v)) in fr.obs.iter().enumerate() {
            by_led.entry(led).or_default().push(SolvedObs {
                u,
                v,
                k: fr.k,
                p: result.positions[fi],
                rot,
                key: (fi, oi),
            });
        }
    }

    // Session-adaptive gates off the global median residual vs solved LEDs.
    let mut all_errs: Vec<f64> = Vec::new();
    for (led, obs_list) in &by_led {
        if let Some(x) = result.led_pos(*led) {
            all_errs.extend(
                obs_list
                    .iter()
                    .map(|o| reproj_err(o, x))
                    .filter(|e| e.is_finite()),
            );
        }
    }
    let global_med = if all_errs.is_empty() {
        1.0
    } else {
        median(&all_errs)
    };
    let engage_p90_px = (4.0 * global_med).max(8.0);
    let inlier_px = (3.0 * global_med).max(6.0);
    let floor = floor_px.max(2.0 * global_med);

    let mut keyed_errs: Vec<((usize, usize), f64)> = Vec::new();
    for obs_list in by_led.values() {
        let survivors = consensus_filter(obs_list, 2, engage_p90_px, inlier_px);
        if survivors.len() < 2 {
            continue; // keys absent -> observations dropped
        }
        let sel: Vec<&SolvedObs> = survivors.iter().map(|&i| &obs_list[i]).collect();
        let origins: Vec<Vec3> = sel.iter().map(|o| o.p).collect();
        let dirs: Vec<Vec3> = sel
            .iter()
            .map(|o| back_project_dir(&o.rot, o.k, o.u, o.v))
            .collect();
        let errs: Vec<f64> = match triangulate_point(&origins, &dirs) {
            Ok(x) => sel.iter().map(|o| reproj_err(o, x)).collect(),
            Err(_) => vec![0.0; sel.len()], // can't judge: keep, next round decides
        };
        for (o, e) in sel.iter().zip(errs) {
            keyed_errs.push((o.key, e));
        }
    }

    if keyed_errs.is_empty() {
        return (frames.to_vec(), 0);
    }
    let finite: Vec<f64> = keyed_errs
        .iter()
        .map(|(_k, e)| *e)
        .filter(|e| e.is_finite())
        .collect();
    let med = median(&finite);
    let mad = median(&finite.iter().map(|e| (e - med).abs()).collect::<Vec<f64>>());
    let mut threshold = (outlier_sigma * 1.4826 * mad).max(floor);
    // Safety valve: cap a round at the worst quartile (vio_api rationale).
    if !finite.is_empty() {
        let frac_over = keyed_errs.iter().filter(|(_k, e)| *e > threshold).count() as f64
            / keyed_errs.len() as f64;
        if frac_over > 0.25 {
            threshold = percentile(&finite, 75.0);
        }
    }
    let keep: std::collections::BTreeSet<(usize, usize)> = keyed_errs
        .iter()
        .filter(|(_k, e)| *e <= threshold)
        .map(|(k, _e)| *k)
        .collect();

    let mut kept: Vec<FrameObservations> = Vec::new();
    let mut dropped = 0usize;
    for (fi, fr) in frames.iter().enumerate() {
        let obs: Vec<(u32, f64, f64)> = fr
            .obs
            .iter()
            .enumerate()
            .filter(|(oi, _o)| keep.contains(&(fi, *oi)))
            .map(|(_oi, o)| *o)
            .collect();
        dropped += fr.obs.len() - obs.len();
        if !obs.is_empty() {
            kept.push(FrameObservations {
                t: fr.t,
                k: fr.k,
                obs,
            });
        }
    }
    (kept, dropped)
}

// ---------------------------------------------------------------------------
// Confidence + output assembly (vio_api.reconstruct_vio)
// ---------------------------------------------------------------------------

fn confidence(parallax_deg: f64, n_views: usize, rms_px: f64) -> f64 {
    let par_score = (parallax_deg / 15.0).clamp(0.0, 1.0);
    let view_score = (n_views as f64 / 8.0).clamp(0.0, 1.0);
    let rms_score = 1.0 / (1.0 + (rms_px / 4.0).powi(2));
    (par_score * (0.4 + 0.6 * rms_score) * (0.5 + 0.5 * view_score)).clamp(0.0, 1.0)
}

/// Per-LED view count, reprojection rms (px) and max parallax (deg) against a
/// solved state (observations behind the camera don't count as views).
struct LedQuality {
    views: usize,
    rms: f64,
    parallax: f64,
}

fn led_quality(frames: &[FrameObservations], result: &VioResult) -> BTreeMap<u32, LedQuality> {
    let mut sq_err: BTreeMap<u32, Vec<f64>> = BTreeMap::new();
    let mut dirs: BTreeMap<u32, Vec<Vec3>> = BTreeMap::new();
    for (fi, fr) in frames.iter().enumerate() {
        let r = quat_to_rotmat(result.quats[fi]);
        let p = result.positions[fi];
        for &(led, u, v) in &fr.obs {
            let x = match result.led_pos(led) {
                Some(x) => x,
                None => continue,
            };
            let (uu, vv, depth) = project(&r, p, fr.k, x);
            if depth <= 1e-6 {
                continue;
            }
            sq_err
                .entry(led)
                .or_default()
                .push((uu - u).powi(2) + (vv - v).powi(2));
            dirs.entry(led).or_default().push(normalize(sub(x, p)));
        }
    }
    sq_err
        .into_iter()
        .map(|(led, errs)| {
            let q = LedQuality {
                views: errs.len(),
                rms: (errs.iter().sum::<f64>() / errs.len() as f64).sqrt(),
                parallax: max_parallax_deg(&dirs[&led]),
            };
            (led, q)
        })
        .collect()
}

/// Rope stiffness for the strip prior, in pitches per unit residual: a link
/// overshooting its bound by a full pitch costs as much as a 20σ pixel error,
/// so a misplaced LED is pulled back to its neighbours while well-observed
/// geometry (which already satisfies the bound) feels nothing.
const CHAIN_SIGMA_PITCH: f64 = 0.05;

/// Scale relative standard error above which the map is flagged as having a
/// weakly determined metric scale. Well-excited synthetic captures sit at
/// ≤ 0.05; gentle ones (whose size came out 15-40% off) at 0.07-0.25, and
/// the near-static ones that collapsed to a fraction of true size at 0.5+.
const SCALE_REL_SE_WARN: f64 = 0.1;

/// Median camera-to-fixture distance below which the solved scale is
/// implausible: nobody maps a whole fixture from closer than this, so a
/// path this close means the metric scale collapsed (the coil-lamp scan
/// that came out 8.6x small had its camera path ~9 cm from the fixture).
const MIN_PLAUSIBLE_CAMERA_DIST_M: f64 = 0.15;

/// Solve-quality warnings about the metric scale. Shape is unaffected by
/// either condition (reprojection is scale-invariant); size is what's wrong.
fn scale_warnings(scale_rel_se: f64, median_camera_dist_m: Option<f64>) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(d) = median_camera_dist_m.filter(|d| d.is_finite()) {
        if d < MIN_PLAUSIBLE_CAMERA_DIST_M {
            out.push(format!(
                "The solved camera path is only {:.0} cm from the fixture, which is \
                 implausibly close: the map's size has probably collapsed (its shape \
                 may still be right). Re-capture with more phone movement, or rescale \
                 the map.",
                d * 100.0
            ));
        }
    }
    if scale_rel_se > SCALE_REL_SE_WARN {
        let pct = if scale_rel_se.is_finite() {
            format!(" (±{:.0}% or more)", scale_rel_se * 100.0)
        } else {
            String::new()
        };
        out.push(format!(
            "The map's size is uncertain{pct}: the capture had too little phone \
             motion to measure scale. Its shape is unaffected. For a reliable size, \
             include a few brisk side-to-side and up-down sweeps when capturing."
        ));
    }
    out
}

/// Median distance from the solved camera centers to the LEDs' centroid.
fn median_camera_distance(cams: &[Vec3], leds: &[Vec3]) -> Option<f64> {
    if cams.is_empty() || leds.is_empty() {
        return None;
    }
    let c = scale(
        leds.iter().fold(ZERO3, |a, l| add(a, *l)),
        1.0 / leds.len() as f64,
    );
    let d: Vec<f64> = cams.iter().map(|p| norm(sub(*p, c))).collect();
    Some(median(&d))
}
/// Confidence at which an LED counts as solidly solved for the strip prior
/// (spacing estimate, break detection).
const STRIP_CONFIDENT: f64 = 0.5;

/// The strip prior's view of a solved state: output-eligible LEDs (sorted
/// ids), their positions, and whether each is confidently solved.
fn strip_inputs(
    frames: &[FrameObservations],
    result: &VioResult,
    min_views: usize,
) -> (Vec<u32>, Vec<Vec3>, Vec<bool>) {
    let quality = led_quality(frames, result);
    let mut ids = Vec::new();
    let mut pos = Vec::new();
    let mut conf = Vec::new();
    for (idx, &led) in result.led_ids.iter().enumerate() {
        if let Some(q) = quality.get(&led) {
            if q.views >= min_views {
                ids.push(led);
                pos.push(result.led_positions[idx]);
                conf.push(confidence(q.parallax, q.views, q.rms) >= STRIP_CONFIDENT);
            }
        }
    }
    (ids, pos, conf)
}

/// Rotation leveling the estimated gravity onto -Y.
fn gravity_level_rot(g: Vec3) -> Mat3 {
    let gn = scale(g, 1.0 / (norm(g) + 1e-12));
    let target = [0.0, -1.0, 0.0];
    let v = cross(gn, target);
    let s = norm(v);
    let c = dot(gn, target);
    if s < 1e-12 {
        if c > 0.0 {
            return EYE3;
        }
        return [[1.0, 0.0, 0.0], [0.0, -1.0, 0.0], [0.0, 0.0, -1.0]];
    }
    let vx = crate::so3::skew(v);
    let vx2 = crate::linalg::mat_mul(&vx, &vx);
    let f = (1.0 - c) / (s * s);
    let mut rot = EYE3;
    for i in 0..3 {
        for j in 0..3 {
            rot[i][j] += vx[i][j] + vx2[i][j] * f;
        }
    }
    rot
}

pub fn decimate_path(positions: &[Vec3], max_points: usize) -> Vec<[f64; 3]> {
    if positions.len() <= max_points {
        return positions.to_vec();
    }
    linspace_indices(positions.len(), max_points)
        .into_iter()
        .map(|i| positions[i])
        .collect()
}

/// One optimizer stage of `reconstruct_vio`, for the reproduction bundle's
/// diagnostics (what each solve did to the map: kept observations, residual,
/// how far the inertial re-anchor rescaled it).
#[derive(serde::Serialize, Debug, Clone)]
pub struct StageTrace {
    pub stage: String,
    pub frames: usize,
    pub observations: usize,
    pub leds: usize,
    /// LEDs with ≥ 2 views whose median reprojection error is ≤ 8 px.
    pub solved: usize,
    #[serde(rename = "rmsPx")]
    pub rms_px: f64,
    /// Factor this stage's re-anchor multiplied the geometry by.
    #[serde(rename = "reanchorScale")]
    pub reanchor_scale: f64,
    #[serde(rename = "scaleRelStdErr")]
    pub scale_rel_se: Option<f64>,
    /// RMS distance of the LEDs from their centroid, meters.
    #[serde(rename = "spreadM")]
    pub spread_m: f64,
    /// Cold start only: the linear inertial alignment's scale for the visual
    /// init (≤ 0 mirrors the scene behind the cameras).
    #[serde(rename = "initScale", skip_serializing_if = "Option::is_none")]
    pub init_scale: Option<f64>,
    /// The cold start rejected `initScale` and seeded an arm's-length prior.
    #[serde(
        rename = "initScaleFallback",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub init_scale_fallback: bool,
    /// Degeneracy reasons of this stage's state (initial solves only).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub degenerate: Vec<String>,
}

fn trace_stage(stage: &str, frames: &[FrameObservations], r: &VioResult) -> StageTrace {
    StageTrace {
        stage: stage.to_string(),
        frames: frames.len(),
        observations: frames.iter().map(|f| f.obs.len()).sum(),
        leds: r.led_ids.len(),
        solved: solved_led_count(frames, r, 8.0),
        rms_px: r.rms_reproj_px,
        reanchor_scale: r.reanchor_scale,
        scale_rel_se: r.scale_rel_se.is_finite().then_some(r.scale_rel_se),
        spread_m: crate::diag::geometry(&r.led_positions, &[]).spread_m,
        init_scale: r.init_scale,
        init_scale_fallback: r.init_scale_fallback,
        degenerate: Vec::new(),
    }
}

/// The production entry point — port of vio_api.reconstruct_vio (frames →
/// solve → iterative outlier rejection with best-state rollback →
/// gravity-leveled OutputMap). Every observation is kept, however the
/// timeline is interrupted: a gap only loosens the inertial link across it
/// (vio::interval_sigmas), and bad observations are the robust loss's and
/// the rejection loop's job.
pub fn reconstruct_vio(
    problem: &Problem,
    progress: Option<ProgressFn>,
) -> Result<OutputMap, String> {
    reconstruct_vio_diag(problem, progress).map(|(map, _diag)| map)
}

/// What a solve did, beside its map: the capture bundle's diagnostics.
#[derive(serde::Serialize, Debug, Clone)]
pub struct SolveDiagnostics {
    /// Every optimizer stage, in order.
    pub trace: Vec<StageTrace>,
    /// Which initial solve the pipeline continued from: "cold" (from
    /// scratch) or "warm" (from `options.warmStart`).
    pub start: String,
    /// Why a supplied warm start was not usable (it was ignored).
    #[serde(rename = "warmStartError", skip_serializing_if = "Option::is_none")]
    pub warm_start_error: Option<String>,
    /// The degeneracy verdict on the returned map (diag.rs).
    pub assessment: Assessment,
    /// The final solver state, un-leveled — a later solve's `warmStart`.
    pub state: WarmState,
}

/// `reconstruct_vio`, with the per-stage trace, the degeneracy assessment
/// and the final solver state.
pub fn reconstruct_vio_diag(
    problem: &Problem,
    mut progress: Option<ProgressFn>,
) -> Result<(OutputMap, SolveDiagnostics), String> {
    let mut trace: Vec<StageTrace> = Vec::new();
    // `&mut dyn` is invariant, so the Option can't be reborrowed per solve
    // call; route every solve through one concrete relay closure instead.
    let has_progress = progress.is_some();
    let mut relay = |frac: f64, rms: f64, ids: &[u32], leds: &[Vec3], cams: &[Vec3]| {
        if let Some(p) = progress.as_mut() {
            p(frac, rms, ids, leds, cams);
        }
    };
    macro_rules! prog {
        () => {
            if has_progress {
                Some(&mut relay as ProgressFn)
            } else {
                None
            }
        };
    }
    let opts = &problem.options;
    let mut frames = frames_from_records(&problem.detections, opts.max_keyframes);
    let mut imu: Vec<crate::imu::ImuSample> = problem
        .imu
        .iter()
        .map(|s| crate::imu::ImuSample {
            t: s.t / 1000.0,
            gyro: s.gyro,
            accel: s.accel,
        })
        .collect();
    imu.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());

    if frames.len() < 8 {
        return Err(format!(
            "too few observation frames for a VIO solve ({})",
            frames.len()
        ));
    }
    if imu.len() < 30 {
        return Err(format!(
            "too few IMU samples for a VIO solve ({})",
            imu.len()
        ));
    }

    let solve_opts = SolveOptions {
        px_sigma: opts.px_sigma,
        max_nfev: opts.max_nfev,
        init_scale_guard: opts.init_scale_guard,
        ..SolveOptions::default()
    };
    // Initial solve. From scratch ("cold") — and, when the caller hands over
    // the state of an earlier solve of this capture (the live preview's best
    // interim), also from that ("warm"); the better start carries on. The cold
    // start re-derives scale and gravity from all the data, which is usually
    // the better start, but it can also land in a basin the interim solves
    // never saw; the warm start guarantees the final solve begins no worse
    // than what the user was shown.
    let observable = crate::diag::observable_leds(&problem.detections);
    let cold = solve_vio(&frames, &imu, &solve_opts, None, prog!());
    let mut start = "cold";
    let mut warm_start_error = None;
    let cold_q = assess_state(&cold, solved_led_count(&frames, &cold, 8.0), observable);
    let mut cold_trace = trace_stage("initial-cold", &frames, &cold);
    cold_trace.degenerate = cold_q.reasons.clone();
    trace.push(cold_trace);
    let mut result = cold;
    if let Some(ws) = &opts.warm_start {
        match crate::diag::from_warm_state(ws) {
            Ok(ws) => {
                let warm = solve_vio(&frames, &imu, &solve_opts, Some(&ws), prog!());
                let warm_q = assess_state(&warm, solved_led_count(&frames, &warm, 8.0), observable);
                let mut warm_trace = trace_stage("initial-warm", &frames, &warm);
                warm_trace.degenerate = warm_q.reasons.clone();
                trace.push(warm_trace);
                if crate::diag::better(&warm_q, &cold_q) {
                    result = warm;
                    start = "warm";
                }
            }
            Err(e) => warm_start_error = Some(e),
        }
    }

    if opts.reject_outliers {
        let score = |res: &VioResult, frs: &[FrameObservations]| -> (usize, f64) {
            (solved_led_count(frs, res, 8.0), -res.rms_reproj_px)
        };
        let cmp = |a: (usize, f64), b: (usize, f64)| -> std::cmp::Ordering {
            a.0.cmp(&b.0).then(a.1.partial_cmp(&b.1).unwrap())
        };
        let mut best_result = result.clone();
        let mut best_frames = frames.clone();
        let mut best_score = score(&result, &frames);
        for round in 0..3 {
            let (kept, outliers_dropped) =
                reject_outlier_observations(&frames, &result, opts.outlier_sigma, 3.0);
            if outliers_dropped == 0 || kept.len() < 8 {
                break;
            }
            frames = kept;
            let first_resolve = round == 0;
            let resolve_opts = SolveOptions {
                max_nfev: if first_resolve {
                    (opts.max_nfev / 2).max(30)
                } else {
                    (opts.max_nfev / 4).max(15)
                },
                ftol: if first_resolve { 1e-5 } else { 1e-4 },
                ..solve_opts.clone()
            };
            result = solve_vio(&frames, &imu, &resolve_opts, Some(&result), prog!());
            trace.push(trace_stage(
                &format!("outlier-round-{round}"),
                &frames,
                &result,
            ));
            let cur = score(&result, &frames);
            if cmp(cur, best_score) == std::cmp::Ordering::Greater {
                best_result = result.clone();
                best_frames = frames.clone();
                best_score = cur;
            }
        }
        if cmp(best_score, score(&result, &frames)) == std::cmp::Ordering::Greater {
            result = best_result;
            frames = best_frames;
            trace.push(trace_stage("rollback-to-best-round", &frames, &result));
        }
    }

    // Strip prior (strip.rs): estimate the pitch from the unconstrained
    // solve, then re-solve with rope links between consecutive mapped LEDs,
    // warm-started from the best state. The gap fill happens at assembly.
    let strip_tol = opts.strip_tolerance.max(0.0);
    let known_spacing = opts.strip_spacing_m.filter(|s| s.is_finite() && *s > 0.0);
    let mut strip_ctx: Option<(f64, Vec<(u32, u32)>)> = None;
    if opts.strip_prior {
        let (ids, pos, conf) = strip_inputs(&frames, &result, opts.min_views);
        if let Some(spacing) = known_spacing.or_else(|| strip::estimate_spacing(&ids, &pos, &conf))
        {
            // LEDs already off the chain (a decode swap, a bad triangulation)
            // stay out of the rope: their consistent-but-wrong observations
            // would otherwise drag their neighbours (and through them the
            // poses). Their neighbours link across them instead; they are
            // demoted at assembly if they still don't fit.
            let (_links, breaks) = strip::chain_links(&ids, &pos, &conf, spacing, strip_tol);
            let off_chain = strip::chain_outliers(&ids, &pos, spacing, strip_tol, &breaks);
            let keep: Vec<usize> = (0..ids.len())
                .filter(|&w| !off_chain.contains(&ids[w]))
                .collect();
            let (ids, pos, conf): (Vec<u32>, Vec<Vec3>, Vec<bool>) = (
                keep.iter().map(|&w| ids[w]).collect(),
                keep.iter().map(|&w| pos[w]).collect(),
                keep.iter().map(|&w| conf[w]).collect(),
            );
            let (links, _breaks) = strip::chain_links(&ids, &pos, &conf, spacing, strip_tol);
            if !links.is_empty() {
                let chain_opts = SolveOptions {
                    max_nfev: (opts.max_nfev / 2).max(30),
                    ftol: 1e-5,
                    chain: links.iter().map(|l| (l.a, l.b, l.max_dist)).collect(),
                    chain_sigma: CHAIN_SIGMA_PITCH * spacing,
                    ..solve_opts.clone()
                };
                result = solve_vio(&frames, &imu, &chain_opts, Some(&result), prog!());
                trace.push(trace_stage("strip-prior", &frames, &result));
            }
            // Re-measure on the constrained state: the solve's a-posteriori
            // metric re-anchor may have rescaled it.
            let (ids, pos, conf) = strip_inputs(&frames, &result, opts.min_views);
            let spacing = known_spacing
                .or_else(|| strip::estimate_spacing(&ids, &pos, &conf))
                .unwrap_or(spacing);
            let (_links, breaks) = strip::chain_links(&ids, &pos, &conf, spacing, strip_tol);
            strip_ctx = Some((spacing, breaks));
        }
    }

    // Gravity leveling + per-LED quality (view count, rms, parallax).
    let rot = gravity_level_rot(result.gravity);
    let quality = led_quality(&frames, &result);

    let mut entries: Vec<LedEntry> = Vec::new();
    for (idx, &led) in result.led_ids.iter().enumerate() {
        let q = match quality.get(&led) {
            Some(q) if q.views >= opts.min_views => q,
            _ => continue,
        };
        let xyz = mat_vec(&rot, result.led_positions[idx]);
        entries.push(LedEntry {
            id: led,
            xyz,
            confidence: confidence(q.parallax, q.views, q.rms),
            n_views: q.views,
            rms_reproj_px: q.rms,
            parallax_deg: q.parallax,
        });
    }

    let led_count = problem
        .led_count
        .unwrap_or_else(|| result.led_ids.iter().max().map(|m| m + 1).unwrap_or(0));

    // Strip prior, output side: demote LEDs that still break the chain, then
    // place interior unmapped runs on the segment between their mapped
    // neighbours. Placed LEDs carry nViews = 0 / confidence = 0 — measured by
    // nothing, so any real observation (a supplemental scan) outranks them.
    if let Some((spacing, breaks)) = &strip_ctx {
        let ids: Vec<u32> = entries.iter().map(|e| e.id).collect();
        let pos: Vec<Vec3> = entries.iter().map(|e| e.xyz).collect();
        let demoted = strip::chain_outliers(&ids, &pos, *spacing, strip_tol, breaks);
        entries.retain(|e| !demoted.contains(&e.id));
        let ids: Vec<u32> = entries.iter().map(|e| e.id).collect();
        let pos: Vec<Vec3> = entries.iter().map(|e| e.xyz).collect();
        for (id, xyz) in strip::fill_gaps(&ids, &pos, *spacing, strip_tol, breaks) {
            if id < led_count {
                entries.push(LedEntry {
                    id,
                    xyz,
                    confidence: 0.0,
                    n_views: 0,
                    rms_reproj_px: 0.0,
                    parallax_deg: 0.0,
                });
            }
        }
        entries.sort_by_key(|e| e.id);
    }

    let parallaxes: Vec<f64> = entries
        .iter()
        .filter(|e| e.n_views > 0)
        .map(|e| e.parallax_deg)
        .collect();
    let placed: std::collections::BTreeSet<u32> = entries.iter().map(|e| e.id).collect();
    let unmapped: Vec<u32> = (0..led_count).filter(|id| !placed.contains(id)).collect();
    let leveled_traj: Vec<Vec3> = result.positions.iter().map(|p| mat_vec(&rot, *p)).collect();
    let measured: Vec<Vec3> = entries
        .iter()
        .filter(|e| e.n_views > 0)
        .map(|e| e.xyz)
        .collect();
    // Infinite = the re-anchor couldn't observe scale at all (warned below);
    // only a finite estimate goes on the wire.
    let warnings = scale_warnings(
        result.scale_rel_se,
        median_camera_distance(&leveled_traj, &measured),
    );

    let map = OutputMap {
        map_id: problem
            .map_id
            .clone()
            .unwrap_or_else(|| "rust-solve".to_string()),
        created_at: problem
            .created_at
            .clone()
            .unwrap_or_else(|| "1970-01-01T00:00:00Z".to_string()),
        units: "meters".to_string(),
        frame: "gravity_leveled".to_string(),
        led_count,
        leds: entries,
        unmapped,
        trajectory: decimate_path(&leveled_traj, 240),
        stats: OutputMapStats {
            rms_reproj_px_global: result.rms_reproj_px,
            median_parallax_deg: median(&parallaxes),
            scale_rel_std_err: Some(result.scale_rel_se).filter(|s| s.is_finite()),
            warnings,
        },
    };
    let assessment = crate::diag::assess_map(&map, observable);
    let diag = SolveDiagnostics {
        trace,
        start: start.to_string(),
        warm_start_error,
        assessment,
        state: crate::diag::to_warm_state(&result),
    };
    Ok((map, diag))
}

/// Progress snapshot assembly shared by the carriers.
pub fn snapshot(
    frac: f64,
    rms_px: f64,
    led_ids: &[u32],
    leds: &[Vec3],
    cams: &[Vec3],
) -> ProgressSnapshot {
    ProgressSnapshot {
        progress: (frac * 1e4).round() / 1e4,
        rms_px,
        leds: led_ids
            .iter()
            .zip(leds)
            .map(|(id, xyz)| ProgressLed { id: *id, xyz: *xyz })
            .collect(),
        trajectory: decimate_path(cams, 240),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{DetectionRecordWire, ImuSampleWire, ProblemOptions};

    #[test]
    fn scale_warnings_flag_collapsed_and_uncertain_scale() {
        assert!(
            scale_warnings(0.02, Some(0.75)).is_empty(),
            "a sound solve warns nothing"
        );
        let close = scale_warnings(0.02, Some(0.09));
        assert_eq!(close.len(), 1);
        assert!(close[0].contains("9 cm"), "{}", close[0]);
        let vague = scale_warnings(0.4, Some(0.75));
        assert_eq!(vague.len(), 1);
        assert!(vague[0].contains("±40%"), "{}", vague[0]);
        assert!(!scale_warnings(f64::INFINITY, None)[0].contains('±'));
        assert_eq!(scale_warnings(0.4, Some(0.09)).len(), 2);
    }

    #[test]
    fn median_and_percentile_match_numpy_conventions() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&[4.0, 1.0, 2.0, 3.0]), 2.5);
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 75.0), 3.25);
        assert_eq!(percentile(&[1.0, 2.0], 90.0), 1.9);
    }

    #[test]
    fn triangulate_recovers_intersection() {
        let x_true = [0.3, -0.2, 1.5];
        let origins = vec![[0.0, 0.0, 0.0], [1.0, 0.0, 0.0], [0.0, 1.0, 0.0]];
        let dirs: Vec<Vec3> = origins.iter().map(|o| normalize(sub(x_true, *o))).collect();
        let x = triangulate_point(&origins, &dirs).unwrap();
        for i in 0..3 {
            assert!((x[i] - x_true[i]).abs() < 1e-10);
        }
    }

    /// Regression on a REAL iOS capture (60-LED strip, iPhone SE 3 / iOS 26.6).
    ///
    /// Guards the accelerometer sign convention, which has bitten this project
    /// twice and never fails loudly. The solver's model wants specific force
    /// f = R^T(a - g) (see synth.rs); CoreMotion's userAcceleration is the
    /// NEGATIVE of body-frame acceleration, so the client must send
    /// -(userAcceleration + gravity). Get it wrong and you do not get an error —
    /// you get either a collapsed metric scale (0 leds) or, worse, a clean
    /// sub-pixel fit whose map is silently upside down, because a global rotation
    /// that negates gravity satisfies every reprojection exactly.
    ///
    /// So this asserts ORIENTATION as well as fit: the capture was shot from
    /// ABOVE the fixture looking down, so the solved camera path must sit above
    /// the LEDs. rms alone cannot see that.
    #[test]
    fn ios_capture_solves_upright() {
        let raw = std::fs::read_to_string("solver/testdata/ios_capture.json")
            .expect("fixture: solver/testdata/ios_capture.json");
        let problem: Problem = serde_json::from_str(&raw).expect("fixture parses");
        let map = reconstruct_vio(&problem, None).unwrap();

        assert!(map.leds.len() >= 50, "solved {} of 60", map.leds.len());
        assert!(
            map.stats.rms_reproj_px_global < 3.0,
            "rms {}",
            map.stats.rms_reproj_px_global
        );

        let led_y: f64 = map.leds.iter().map(|l| l.xyz[1]).sum::<f64>() / map.leds.len() as f64;
        let cam_y: f64 =
            map.trajectory.iter().map(|p| p[1]).sum::<f64>() / map.trajectory.len() as f64;
        assert!(
            cam_y > led_y,
            "map is upside down: camera {cam_y:.2} should be above LEDs {led_y:.2} \
             (check the accelerometer sign convention)"
        );

        // Metric scale: a 30mm-pitch strip. A sign error collapses this to ~1.5cm
        // across the whole fixture rather than per-LED.
        let mut xs: Vec<f64> = map.leds.iter().map(|l| l.xyz[0]).collect();
        xs.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let span = xs.last().unwrap() - xs.first().unwrap();
        assert!(span > 0.3, "x span {span:.3} m — metric scale collapsed?");
    }

    /// A coiled strip captured the way diffuse mode sees it: bloomed blobs
    /// (2 px noise), striding (each LED in ~10% of frames), a run of LEDs
    /// never decoded, an LED seen once, and a decode swap that puts LED 50's
    /// observations at LED 12's spot. Returns (truth, problem).
    fn hostile_strip_problem(seed: u64) -> (Vec<Vec3>, Problem) {
        use crate::synth::{synth_frames, synth_imu, Rng};
        let n = 60usize;
        let (r, rise_per_turn, pitch) = (0.15, 0.08, 0.05);
        let arc_per_turn = (std::f64::consts::TAU * r).hypot(rise_per_turn);
        let truth: Vec<Vec3> = (0..n)
            .map(|i| {
                let th = std::f64::consts::TAU * (i as f64 * pitch) / arc_per_turn;
                [
                    r * th.cos(),
                    rise_per_turn * th / std::f64::consts::TAU - 0.12,
                    r * th.sin(),
                ]
            })
            .collect();
        let mut observed = truth.clone();
        observed[50] = truth[12]; // decode swap
        let mut rng = Rng::new(seed);
        let duration = 8.0;
        let imu_samples = synth_imu(duration, true, &mut rng);
        let frames = synth_frames(&observed, duration, 2.0, 0.85, &mut rng);
        let mut seen_once = false;
        let detections: Vec<DetectionRecordWire> = frames
            .iter()
            .flat_map(|fr| {
                fr.obs
                    .iter()
                    .filter(|&&(led, _, _)| !(20..=22).contains(&led) && led != 41)
                    .filter(|&&(led, _, _)| led != 33 || !std::mem::replace(&mut seen_once, true))
                    .map(|&(led, u, v)| DetectionRecordWire {
                        led_id: led,
                        u,
                        v,
                        k: fr.k,
                        t_capture_ms: fr.t * 1000.0,
                    })
                    .collect::<Vec<_>>()
            })
            .collect();
        let imu: Vec<ImuSampleWire> = imu_samples
            .iter()
            .map(|s| ImuSampleWire {
                t: s.t * 1000.0,
                gyro: s.gyro,
                accel: s.accel,
            })
            .collect();
        let problem = Problem {
            detections,
            imu,
            led_count: Some(n as u32),
            map_id: Some("strip-test".into()),
            created_at: Some("2026-10-17T00:00:00Z".into()),
            options: ProblemOptions::default(),
        };
        (truth, problem)
    }

    /// Per-LED error (m) of `map` against `truth`, after a similarity fit on
    /// the measured LEDs other than the swapped one.
    fn errors_vs_truth(map: &OutputMap, truth: &[Vec3]) -> BTreeMap<u32, f64> {
        let fit: Vec<&LedEntry> = map
            .leds
            .iter()
            .filter(|l| l.n_views > 0 && l.id != 50)
            .collect();
        let est: Vec<Vec3> = fit.iter().map(|l| l.xyz).collect();
        let tru: Vec<Vec3> = fit.iter().map(|l| truth[l.id as usize]).collect();
        let (s, r, t) = crate::vio::similarity_align(&est, &tru);
        map.leds
            .iter()
            .map(|l| {
                (
                    l.id,
                    norm(sub(
                        add(mat_vec(&r, scale(l.xyz, s)), t),
                        truth[l.id as usize],
                    )),
                )
            })
            .collect()
    }

    #[test]
    fn strip_prior_repairs_a_sparse_noisy_strip() {
        // One seed keeps this affordable in fastbuild (~10× slower than opt);
        // seeds 1–12 all pass, with the prior's measured-LED rms at or below
        // the plain solve's on every one.
        check_strip_prior_on_hostile_strip(4);
    }

    fn check_strip_prior_on_hostile_strip(seed: u64) {
        let (truth, problem) = hostile_strip_problem(seed);
        let pitch = 0.05;

        let plain = reconstruct_vio(&problem, None).unwrap();
        let mut with_prior = problem.clone();
        with_prior.options.strip_prior = true;
        let strip_map = reconstruct_vio(&with_prior, None).unwrap();

        let e_plain = errors_vs_truth(&plain, &truth);
        let e_strip = errors_vs_truth(&strip_map, &truth);
        let rms = |m: &OutputMap, e: &BTreeMap<u32, f64>| {
            let v: Vec<f64> = m
                .leds
                .iter()
                .filter(|l| l.n_views > 0 && l.id != 50)
                .map(|l| e[&l.id])
                .collect();
            (v.iter().map(|x| x * x).sum::<f64>() / v.len() as f64).sqrt()
        };
        eprintln!(
            "strip prior (seed {seed}): plain {} mapped, rms {:.1} mm, unmapped {:?}, led50 err {:.0} mm",
            plain.leds.len(),
            rms(&plain, &e_plain) * 1000.0,
            plain.unmapped,
            e_plain.get(&50).copied().unwrap_or(f64::NAN) * 1000.0
        );
        eprintln!(
            "strip prior: prior {} placed ({} inferred), rms {:.1} mm, unmapped {:?}, led50 err {:.0} mm",
            strip_map.leds.len(),
            strip_map.leds.iter().filter(|l| l.n_views == 0).count(),
            rms(&strip_map, &e_strip) * 1000.0,
            strip_map.unmapped,
            e_strip[&50] * 1000.0
        );
        for id in [20u32, 21, 22, 33, 41, 50] {
            eprintln!(
                "  led {id}: err {:.1} mm",
                e_strip.get(&id).copied().unwrap_or(f64::NAN) * 1000.0
            );
        }

        // Without the prior, the swap lands LED 50 across the coil and the
        // undecoded LEDs are simply missing.
        assert!(
            e_plain[&50] > 3.0 * pitch,
            "plain led50 err {}",
            e_plain[&50]
        );
        for id in [20u32, 21, 22, 33, 41] {
            assert!(plain.unmapped.contains(&id), "plain should not map {id}");
        }

        // With it: LED 50 is demoted and re-placed between its neighbours, the
        // undecoded run, the lone LED and the once-seen LED are placed on their
        // segments, and nothing interior is left unmapped.
        let placed: Vec<u32> = strip_map.leds.iter().map(|l| l.id).collect();
        let first = *placed.first().unwrap();
        let last = *placed.last().unwrap();
        assert!(
            (first..=last).all(|id| placed.contains(&id)),
            "interior gap: {:?}",
            strip_map.unmapped
        );
        assert!(e_strip[&50] < pitch, "led50 err {}", e_strip[&50]);
        for id in [20u32, 21, 22, 33, 41] {
            let l = strip_map.leds.iter().find(|l| l.id == id).unwrap();
            assert_eq!(
                (l.n_views, l.confidence),
                (0, 0.0),
                "led {id} should be inferred"
            );
            assert!(e_strip[&id] < pitch, "led {id} err {}", e_strip[&id]);
        }
        let led50 = strip_map.leds.iter().find(|l| l.id == 50).unwrap();
        assert_eq!(
            led50.n_views, 0,
            "the swapped LED should be demoted + re-placed"
        );
        // ...and the rope does not cost the measured LEDs any accuracy.
        assert!(
            rms(&strip_map, &e_strip) <= rms(&plain, &e_plain) * 1.05 + 1e-3,
            "measured rms {} vs {}",
            rms(&strip_map, &e_strip),
            rms(&plain, &e_plain)
        );
        assert_eq!(strip_map.led_count, 60);
        assert_eq!(strip_map.leds.len() + strip_map.unmapped.len(), 60);
    }

    /// A raster-wired wall (row-major ids, no serpentine): every row wrap is a
    /// ~5-pitch jump between two well-solved LEDs. The prior must read those as
    /// breaks — no rope across them, nothing demoted, nothing inferred.
    #[test]
    fn strip_prior_treats_raster_row_wraps_as_breaks() {
        let mut rng = crate::synth::Rng::new(3);
        let leds = crate::synth::wall_leds(6, 6, 0.12);
        let imu_samples = crate::synth::synth_imu(10.0, true, &mut rng);
        let frames = crate::synth::synth_frames(&leds, 10.0, 0.3, 0.05, &mut rng);
        let detections: Vec<DetectionRecordWire> = frames
            .iter()
            .flat_map(|fr| {
                fr.obs.iter().map(|&(led, u, v)| DetectionRecordWire {
                    led_id: led,
                    u,
                    v,
                    k: fr.k,
                    t_capture_ms: fr.t * 1000.0,
                })
            })
            .collect();
        let imu: Vec<ImuSampleWire> = imu_samples
            .iter()
            .map(|s| ImuSampleWire {
                t: s.t * 1000.0,
                gyro: s.gyro,
                accel: s.accel,
            })
            .collect();
        let mut problem = Problem {
            detections,
            imu,
            led_count: Some(36),
            map_id: None,
            created_at: None,
            options: ProblemOptions::default(),
        };
        problem.options.strip_prior = true;
        let map = reconstruct_vio(&problem, None).unwrap();
        assert_eq!(map.leds.len(), 36);
        assert!(
            map.leds.iter().all(|l| l.n_views > 0),
            "nothing should be inferred"
        );
        let err = errors_vs_truth(&map, &leds);
        let rms = (err.values().map(|e| e * e).sum::<f64>() / err.len() as f64).sqrt();
        assert!(rms < 0.002, "wall rms {} mm", rms * 1000.0);
    }

    #[test]
    fn strip_prior_options_parse_from_the_wire() {
        let o: ProblemOptions =
            serde_json::from_str(r#"{"stripPrior": true, "stripSpacingM": 0.0166667}"#).unwrap();
        assert!(o.strip_prior);
        assert_eq!(o.strip_spacing_m, Some(0.0166667));
        assert_eq!(o.strip_tolerance, 0.25);
        let d: ProblemOptions = serde_json::from_str("{}").unwrap();
        assert!(!d.strip_prior && d.strip_spacing_m.is_none());
    }

    /// End-to-end wire test on the synthetic scene (mirrors
    /// test_reconstruct_vio_wire_end_to_end's shape checks).
    #[test]
    fn reconstruct_vio_wire_end_to_end() {
        let mut rng = crate::synth::Rng::new(7);
        let duration = 10.0;
        let leds = crate::synth::wall_leds(6, 6, 0.12);
        let imu_samples = crate::synth::synth_imu(duration, true, &mut rng);
        let frames = crate::synth::synth_frames(&leds, duration, 0.3, 0.05, &mut rng);

        let detections: Vec<DetectionRecordWire> = frames
            .iter()
            .flat_map(|fr| {
                fr.obs.iter().map(|&(led, u, v)| DetectionRecordWire {
                    led_id: led,
                    u,
                    v,
                    k: fr.k,
                    t_capture_ms: fr.t * 1000.0,
                })
            })
            .collect();
        let imu: Vec<ImuSampleWire> = imu_samples
            .iter()
            .map(|s| ImuSampleWire {
                t: s.t * 1000.0,
                gyro: s.gyro,
                accel: s.accel,
            })
            .collect();
        let problem = Problem {
            detections,
            imu,
            led_count: Some(36),
            map_id: Some("test-map".into()),
            created_at: Some("2026-07-09T00:00:00Z".into()),
            options: ProblemOptions::default(),
        };
        let map = reconstruct_vio(&problem, None).unwrap();
        assert_eq!(map.led_count, 36);
        assert_eq!(map.units, "meters");
        assert_eq!(map.frame, "gravity_leveled");
        assert!(map.leds.len() >= 34, "solved {}", map.leds.len());
        assert!(map.stats.rms_reproj_px_global < 1.5);
        assert!(!map.trajectory.is_empty());
        // Gravity-leveled: the wall is vertical, solved points should span
        // x/y and be near-planar in some orientation; at minimum the map is
        // metric — check pitch against truth via nearest-neighbor distances.
        let xs: Vec<f64> = map.leds.iter().map(|l| l.xyz[0]).collect();
        let span = xs.iter().cloned().fold(f64::MIN, f64::max)
            - xs.iter().cloned().fold(f64::MAX, f64::min);
        assert!(span > 0.3, "x span {span}");
    }
}
