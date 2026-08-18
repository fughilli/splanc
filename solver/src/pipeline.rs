//! Wire-format reconstruction pipeline — port of `reconstruction/vio_api.py`
//! (+ the consensus filter and triangulation helpers it borrows from api.py
//! and triangulate.py). See the Python docstrings for the rationale behind
//! every stage; structure and thresholds are identical.

use std::collections::BTreeMap;

use crate::camera::project;
use crate::linalg::{
    add, cross, dot, mat_vec, norm, normalize, scale, solve3_spd, sub, Mat3, Vec3, EYE3, ZERO3,
};
use crate::quat::{back_project_dir, quat_to_rotmat};
use crate::types::{LedEntry, OutputMap, OutputMapStats, Problem, ProgressLed, ProgressSnapshot};
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
// Frame grouping + segment filtering (vio_api.py)
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

/// Two-stage dominant-segment filter (stub drop at `stub_gap_s`, coarse
/// regroup at `gap_split_s`) — see vio_api.keep_dominant_segment.
pub fn keep_dominant_segment(
    frames: &[FrameObservations],
    gap_split_s: f64,
    stub_gap_s: f64,
) -> (Vec<FrameObservations>, usize) {
    if frames.len() < 2 {
        return (frames.to_vec(), 0);
    }
    let total_obs: usize = frames.iter().map(|f| f.obs.len()).sum();

    let split = |gap: f64| -> Vec<Vec<&FrameObservations>> {
        let mut segs: Vec<Vec<&FrameObservations>> = vec![vec![&frames[0]]];
        for w in frames.windows(2) {
            if w[1].t - w[0].t > gap {
                segs.push(Vec::new());
            }
            segs.last_mut().unwrap().push(&w[1]);
        }
        segs
    };

    let fine = split(stub_gap_s);
    let min_obs = 10.max((0.02 * total_obs as f64) as usize);
    let seg_obs = |seg: &[&FrameObservations]| seg.iter().map(|f| f.obs.len()).sum::<usize>();
    let mut substantial: Vec<Vec<&FrameObservations>> = fine
        .iter()
        .filter(|seg| seg_obs(seg) >= min_obs && seg.len() >= 5)
        .cloned()
        .collect();
    if substantial.is_empty() {
        let best = fine
            .iter()
            .max_by_key(|seg| seg_obs(seg))
            .cloned()
            .unwrap_or_default();
        substantial = vec![best];
    }

    let mut groups: Vec<Vec<&FrameObservations>> = vec![substantial[0].clone()];
    for w in substantial.windows(2) {
        let (prev_seg, seg) = (&w[0], &w[1]);
        if seg[0].t - prev_seg.last().unwrap().t > gap_split_s {
            groups.push(Vec::new());
        }
        groups.last_mut().unwrap().extend(seg.iter().copied());
    }
    let best = groups.into_iter().max_by_key(|g| seg_obs(g)).unwrap();
    let kept: Vec<FrameObservations> = best.into_iter().cloned().collect();
    let dropped = total_obs - kept.iter().map(|f| f.obs.len()).sum::<usize>();
    (kept, dropped)
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
            if best.as_ref().map_or(true, |b| inliers.len() > b.len()) {
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

/// The production entry point — port of vio_api.reconstruct_vio (frames →
/// dominant segment → solve → divergence retry → iterative outlier
/// rejection with best-state rollback → gravity-leveled OutputMap).
pub fn reconstruct_vio(
    problem: &Problem,
    mut progress: Option<ProgressFn>,
) -> Result<OutputMap, String> {
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

    let (kept, gap_dropped) = keep_dominant_segment(&frames, opts.gap_split_s, 1.0);
    frames = kept;
    if gap_dropped > 0 && !frames.is_empty() {
        // Trim the IMU to the kept span (bad pre-segment data poisons the
        // gravity anchor; small lead-in keeps held-rate semantics intact).
        let (t0, t1) = (frames[0].t - 0.25, frames.last().unwrap().t + 0.05);
        imu.retain(|s| t0 <= s.t && s.t <= t1);
    }
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
        ..SolveOptions::default()
    };
    let mut result = solve_vio(&frames, &imu, &solve_opts, None, prog!());

    // Divergence gate: retry once with stricter segmentation.
    if result.rms_reproj_px > 100.0 && opts.gap_split_s > 1.2 {
        let (strict, extra) = keep_dominant_segment(&frames, 1.2, 0.8);
        if extra > 0 && strict.len() >= 8 {
            let retry = solve_vio(&strict, &imu, &solve_opts, None, prog!());
            if retry.rms_reproj_px < result.rms_reproj_px {
                frames = strict;
                result = retry;
            }
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
        }
    }

    // Gravity leveling + per-LED quality (view count, rms, parallax).
    let rot = gravity_level_rot(result.gravity);
    let mut n_views: BTreeMap<u32, usize> = BTreeMap::new();
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
            *n_views.entry(led).or_insert(0) += 1;
            let ray = normalize(sub(x, p));
            dirs.entry(led).or_default().push(ray);
        }
    }

    let mut entries: Vec<LedEntry> = Vec::new();
    let mut parallaxes: Vec<f64> = Vec::new();
    let mut solved_ids: Vec<u32> = Vec::new();
    for (idx, &led) in result.led_ids.iter().enumerate() {
        let views = n_views.get(&led).copied().unwrap_or(0);
        if views < opts.min_views {
            continue;
        }
        let errs = &sq_err[&led];
        let rms = (errs.iter().sum::<f64>() / errs.len() as f64).sqrt();
        let par = max_parallax_deg(&dirs[&led]);
        parallaxes.push(par);
        solved_ids.push(led);
        let xyz = mat_vec(&rot, result.led_positions[idx]);
        entries.push(LedEntry {
            id: led,
            xyz,
            confidence: confidence(par, views, rms),
            n_views: views,
            rms_reproj_px: rms,
            parallax_deg: par,
        });
    }

    let led_count = problem
        .led_count
        .unwrap_or_else(|| result.led_ids.iter().max().map(|m| m + 1).unwrap_or(0));
    let unmapped: Vec<u32> = (0..led_count)
        .filter(|id| !solved_ids.contains(id))
        .collect();
    let leveled_traj: Vec<Vec3> = result.positions.iter().map(|p| mat_vec(&rot, *p)).collect();

    Ok(OutputMap {
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
        },
    })
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
    fn median_and_percentile_match_numpy_conventions() {
        assert_eq!(median(&[3.0, 1.0, 2.0]), 2.0);
        assert_eq!(median(&[4.0, 1.0, 2.0, 3.0]), 2.5);
        assert_eq!(percentile(&[1.0, 2.0, 3.0, 4.0], 75.0), 3.25);
        assert_eq!(percentile(&[1.0, 2.0], 90.0), 1.9);
    }

    #[test]
    fn dominant_segment_drops_leading_stub() {
        // 2-observation stub at t=0, then a substantial segment after 2.6 s.
        let mut frames = vec![FrameObservations {
            t: 0.0,
            k: [800.0, 800.0, 640.0, 360.0],
            obs: vec![(0, 1.0, 1.0), (1, 2.0, 2.0)],
        }];
        for i in 0..40 {
            frames.push(FrameObservations {
                t: 2.6 + i as f64 * 0.125,
                k: [800.0, 800.0, 640.0, 360.0],
                obs: (0..8).map(|j| (j, j as f64, j as f64)).collect(),
            });
        }
        let (kept, dropped) = keep_dominant_segment(&frames, 3.0, 1.0);
        assert_eq!(dropped, 2);
        assert_eq!(kept.len(), 40);
        assert!(kept[0].t > 2.0);
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
