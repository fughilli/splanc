//! Solve diagnostics: the degeneracy assessment of a solved map, the per-stage
//! trace, and the wire form of a solver state (for warm starts + replay).
//!
//! "Degenerate" is defined here once, precisely, so the pipeline's choice
//! between starts, the replay harness and the app's capture bundles (web
//! src/solver/degeneracy.ts mirrors the reasons by name) agree on it:
//!
//! | reason            | condition                                                  |
//! |-------------------|------------------------------------------------------------|
//! | `non-finite`      | a NaN/∞ in any LED position, the residual or the trajectory |
//! | `too-few-leds`    | < 4 measured LEDs, or < 25 % of the LEDs the input observed |
//! |                   | in ≥ 2 frames                                               |
//! | `huge-residual`   | global reprojection rms > 20 px (the behind-camera penalty  |
//! |                   | is 50 px, so this means most rays miss)                    |
//! | `scale-collapse`  | median camera-to-fixture distance < 0.15 m, or the LEDs'   |
//! |                   | rms spread < 2 mm                                           |
//! | `scale-blowup`    | median camera-to-fixture distance > 30 m                    |
//!
//! `scale-uncertain` (scale relative standard error > 0.5) is reported as a
//! warning, not a degeneracy: the shape is still right.

use serde::Serialize;

use crate::linalg::{add, dot, norm, scale, sub, Vec3, ZERO3};
use crate::quat::{quat_to_rotmat, rotmat_to_quat};
use crate::types::{OutputMap, WarmState};
use crate::vio::VioResult;

pub const MIN_MEASURED_LEDS: usize = 4;
pub const MIN_MEASURED_FRAC: f64 = 0.25;
pub const MAX_RMS_PX: f64 = 20.0;
pub const MIN_CAMERA_DIST_M: f64 = 0.15;
pub const MAX_CAMERA_DIST_M: f64 = 30.0;
pub const MIN_SPREAD_M: f64 = 0.002;
pub const SCALE_UNCERTAIN_REL_SE: f64 = 0.5;

/// Geometry metrics of a set of LED positions + camera centers.
#[derive(Serialize, Debug, Clone, Default, PartialEq)]
pub struct Geometry {
    /// RMS distance of the LEDs from their centroid, meters.
    #[serde(rename = "spreadM")]
    pub spread_m: f64,
    /// Principal standard deviations of the LED cloud, largest first.
    #[serde(rename = "principalM")]
    pub principal_m: [f64; 3],
    /// Median camera-center distance to the LED centroid, meters.
    #[serde(rename = "medianCameraDistM")]
    pub median_camera_dist_m: Option<f64>,
}

pub fn geometry(leds: &[Vec3], cams: &[Vec3]) -> Geometry {
    if leds.is_empty() {
        return Geometry::default();
    }
    let n = leds.len() as f64;
    let c = scale(leds.iter().fold(ZERO3, |a, l| add(a, *l)), 1.0 / n);
    let mut cov = [[0.0; 3]; 3];
    for l in leds {
        let d = sub(*l, c);
        for (i, row) in cov.iter_mut().enumerate() {
            for (j, v) in row.iter_mut().enumerate() {
                *v += d[i] * d[j] / n;
            }
        }
    }
    let (_, sv, _) = crate::linalg::svd3(&cov);
    let mut pr = [
        sv[0].max(0.0).sqrt(),
        sv[1].max(0.0).sqrt(),
        sv[2].max(0.0).sqrt(),
    ];
    pr.sort_by(|a, b| b.partial_cmp(a).unwrap_or(std::cmp::Ordering::Equal));
    let spread = (leds
        .iter()
        .map(|l| dot(sub(*l, c), sub(*l, c)))
        .sum::<f64>()
        / n)
        .sqrt();
    let median_cam = if cams.is_empty() {
        None
    } else {
        let mut d: Vec<f64> = cams.iter().map(|p| norm(sub(*p, c))).collect();
        d.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let m = d.len();
        Some(if m % 2 == 1 {
            d[m / 2]
        } else {
            0.5 * (d[m / 2 - 1] + d[m / 2])
        })
    };
    Geometry {
        spread_m: spread,
        principal_m: pr,
        median_camera_dist_m: median_cam,
    }
}

/// The degeneracy verdict on one solve.
#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct Assessment {
    pub degenerate: bool,
    /// Degeneracy reasons (table above); empty when `degenerate` is false.
    pub reasons: Vec<String>,
    /// Non-fatal findings (`scale-uncertain`).
    pub warnings: Vec<String>,
    /// LEDs with at least one measurement (nViews > 0).
    pub measured: usize,
    /// LEDs the input observed in ≥ 2 frames (the most a solve could place).
    pub observable: usize,
    #[serde(rename = "rmsPx")]
    pub rms_px: f64,
    #[serde(rename = "scaleRelStdErr")]
    pub scale_rel_se: Option<f64>,
    #[serde(flatten)]
    pub geometry: Geometry,
}

fn verdict(
    measured: usize,
    observable: usize,
    rms_px: f64,
    finite: bool,
    scale_rel_se: Option<f64>,
    geometry: Geometry,
) -> Assessment {
    let mut reasons = Vec::new();
    if !finite || !rms_px.is_finite() {
        reasons.push("non-finite".to_string());
    }
    let need = MIN_MEASURED_LEDS.max((MIN_MEASURED_FRAC * observable as f64).ceil() as usize);
    if measured < need {
        reasons.push("too-few-leds".to_string());
    }
    if rms_px > MAX_RMS_PX {
        reasons.push("huge-residual".to_string());
    }
    if measured >= 2 {
        let cam = geometry.median_camera_dist_m;
        if cam.is_some_and(|d| d < MIN_CAMERA_DIST_M) || geometry.spread_m < MIN_SPREAD_M {
            reasons.push("scale-collapse".to_string());
        }
        if cam.is_some_and(|d| d > MAX_CAMERA_DIST_M) {
            reasons.push("scale-blowup".to_string());
        }
    }
    let mut warnings = Vec::new();
    if scale_rel_se.is_some_and(|s| s > SCALE_UNCERTAIN_REL_SE) {
        warnings.push("scale-uncertain".to_string());
    }
    Assessment {
        degenerate: !reasons.is_empty(),
        reasons,
        warnings,
        measured,
        observable,
        rms_px,
        scale_rel_se,
        geometry,
    }
}

/// LEDs observed in at least two distinct capture frames (by timestamp, over
/// every record — before keyframe decimation; web degeneracy.ts
/// `observableLeds` counts the same way).
pub fn observable_leds(detections: &[crate::types::DetectionRecordWire]) -> usize {
    let mut frames: std::collections::BTreeMap<u32, std::collections::BTreeSet<u64>> =
        std::collections::BTreeMap::new();
    for d in detections {
        frames
            .entry(d.led_id)
            .or_default()
            .insert(d.t_capture_ms.to_bits());
    }
    frames.values().filter(|s| s.len() >= 2).count()
}

/// Assess a finished OutputMap (`observable` from the input frames).
pub fn assess_map(map: &OutputMap, observable: usize) -> Assessment {
    let measured: Vec<Vec3> = map
        .leds
        .iter()
        .filter(|l| l.n_views > 0)
        .map(|l| l.xyz)
        .collect();
    let finite = map.leds.iter().all(|l| l.xyz.iter().all(|c| c.is_finite()))
        && map
            .trajectory
            .iter()
            .all(|p| p.iter().all(|c| c.is_finite()));
    let cams: Vec<Vec3> = map.trajectory.clone();
    verdict(
        measured.len(),
        observable,
        map.stats.rms_reproj_px_global,
        finite,
        map.stats.scale_rel_std_err,
        geometry(&measured, &cams),
    )
}

/// Assess a raw solver state (the pipeline's choice between starts).
/// `solved` = LEDs with ≥ 2 views and median reprojection error ≤ 8 px.
pub fn assess_state(result: &VioResult, solved: usize, observable: usize) -> Assessment {
    let finite = result
        .led_positions
        .iter()
        .chain(&result.positions)
        .all(|p| p.iter().all(|c| c.is_finite()));
    verdict(
        solved,
        observable,
        result.rms_reproj_px,
        finite,
        Some(result.scale_rel_se).filter(|s| s.is_finite()),
        geometry(&result.led_positions, &result.positions),
    )
}

/// Order two candidate solves of the same frames: a non-degenerate one beats
/// a degenerate one; then more solved LEDs; then the lower residual.
pub fn better(a: &Assessment, b: &Assessment) -> bool {
    if a.degenerate != b.degenerate {
        return !a.degenerate;
    }
    if a.measured != b.measured {
        return a.measured > b.measured;
    }
    a.rms_px < b.rms_px
}

pub fn to_warm_state(r: &VioResult) -> WarmState {
    WarmState {
        frame_times_s: r.frame_times.clone(),
        quats: r.quats.clone(),
        positions: r.positions.clone(),
        velocities: r.velocities.clone(),
        gravity: r.gravity,
        gyro_bias: r.gyro_bias,
        accel_bias: r.accel_bias,
        led_ids: r.led_ids.clone(),
        led_positions: r.led_positions.clone(),
    }
}

/// A VioResult usable as `solve_vio`'s warm start, or why the state is
/// unusable (inconsistent lengths, non-finite values, no frames).
pub fn from_warm_state(w: &WarmState) -> Result<VioResult, String> {
    let n = w.frame_times_s.len();
    if n == 0 {
        return Err("warm start has no frames".into());
    }
    if w.quats.len() != n || w.positions.len() != n || w.velocities.len() != n {
        return Err("warm start frame arrays differ in length".into());
    }
    if w.led_ids.len() != w.led_positions.len() {
        return Err("warm start LED arrays differ in length".into());
    }
    let finite = |v: &[f64]| v.iter().all(|c| c.is_finite());
    let all_finite = finite(&w.frame_times_s)
        && w.quats.iter().all(|q| finite(q))
        && w.positions.iter().all(|p| finite(p))
        && w.velocities.iter().all(|p| finite(p))
        && w.led_positions.iter().all(|p| finite(p))
        && finite(&w.gravity)
        && finite(&w.gyro_bias)
        && finite(&w.accel_bias);
    if !all_finite {
        return Err("warm start has non-finite values".into());
    }
    // led_pos() binary-searches: sort by id (and re-normalize the quats so a
    // JSON round trip can't feed a non-unit rotation).
    let mut leds: Vec<(u32, Vec3)> = w
        .led_ids
        .iter()
        .copied()
        .zip(w.led_positions.iter().copied())
        .collect();
    leds.sort_by_key(|l| l.0);
    leds.dedup_by_key(|l| l.0);
    let quats = w
        .quats
        .iter()
        .map(|q| rotmat_to_quat(&quat_to_rotmat(*q)))
        .collect();
    Ok(VioResult {
        led_ids: leds.iter().map(|l| l.0).collect(),
        led_positions: leds.iter().map(|l| l.1).collect(),
        positions: w.positions.clone(),
        quats,
        velocities: w.velocities.clone(),
        gravity: w.gravity,
        gyro_bias: w.gyro_bias,
        accel_bias: w.accel_bias,
        rms_reproj_px: f64::NAN,
        frame_times: w.frame_times_s.clone(),
        scale_rel_se: f64::INFINITY,
        reanchor_scale: 1.0,
        init_scale: None,
        init_scale_fallback: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn geo(spread: f64, cam: f64) -> Geometry {
        Geometry {
            spread_m: spread,
            principal_m: [spread, spread, 0.0],
            median_camera_dist_m: Some(cam),
        }
    }

    #[test]
    fn verdict_names_each_degeneracy() {
        let ok = verdict(60, 60, 1.0, true, Some(0.02), geo(0.08, 0.75));
        assert!(!ok.degenerate, "{:?}", ok.reasons);
        let r = |a: Assessment| a.reasons;
        assert_eq!(
            r(verdict(60, 60, 1.0, false, None, geo(0.08, 0.75))),
            ["non-finite"]
        );
        assert_eq!(
            r(verdict(3, 60, 1.0, true, None, geo(0.08, 0.75))),
            ["too-few-leds"]
        );
        assert_eq!(
            r(verdict(10, 60, 1.0, true, None, geo(0.08, 0.75))),
            ["too-few-leds"]
        );
        assert!(r(verdict(15, 60, 1.0, true, None, geo(0.08, 0.75))).is_empty());
        assert_eq!(
            r(verdict(60, 60, 50.0, true, None, geo(0.08, 0.75))),
            ["huge-residual"]
        );
        assert_eq!(
            r(verdict(60, 60, 1.0, true, None, geo(0.01, 0.09))),
            ["scale-collapse"]
        );
        assert_eq!(
            r(verdict(60, 60, 1.0, true, None, geo(0.001, 0.5))),
            ["scale-collapse"]
        );
        assert_eq!(
            r(verdict(60, 60, 1.0, true, None, geo(5.0, 40.0))),
            ["scale-blowup"]
        );
        let unc = verdict(60, 60, 1.0, true, Some(0.8), geo(0.08, 0.75));
        assert!(!unc.degenerate);
        assert_eq!(unc.warnings, ["scale-uncertain"]);
        // Under 4 measured LEDs nothing downstream can register or use the map,
        // however few the capture saw.
        assert!(verdict(3, 3, 1.0, true, None, geo(0.08, 0.75)).degenerate);
    }

    #[test]
    fn better_prefers_non_degenerate_then_coverage_then_residual() {
        let good = verdict(50, 60, 2.0, true, None, geo(0.08, 0.75));
        let more = verdict(55, 60, 3.0, true, None, geo(0.08, 0.75));
        let bad = verdict(60, 60, 50.0, true, None, geo(0.08, 0.75));
        assert!(better(&good, &bad) && !better(&bad, &good));
        assert!(better(&more, &good));
        let tighter = verdict(50, 60, 1.0, true, None, geo(0.08, 0.75));
        assert!(better(&tighter, &good));
    }

    #[test]
    fn geometry_principal_axes() {
        let line: Vec<Vec3> = (0..10).map(|i| [i as f64 * 0.1, 0.0, 0.0]).collect();
        let g = geometry(&line, &[[0.45, 0.0, 1.0]]);
        assert!(g.principal_m[0] > 0.2 && g.principal_m[1] < 1e-9 && g.principal_m[2] < 1e-9);
        assert!((g.median_camera_dist_m.unwrap() - 1.0).abs() < 1e-9);
    }
}
