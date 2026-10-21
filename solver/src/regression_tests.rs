//! Regression tests for "the live preview looked right, the final solve went
//! degenerate" (docs/design/mapping-solve-paths.md), on synthetic captures
//! whose ground truth is known (scenario.rs).
//!
//! Root cause reproduced here: the cold start's linear inertial alignment
//! returns a noisy scale, and on a gentle or decode-swapped capture it can
//! come out ≤ 0. Applied as-is it mirrors the visual init through the gauge
//! camera — every LED behind every camera — and the flat behind-camera
//! penalty leaves the BA no gradient: the map comes back empty. Its sign
//! flips from one prefix of the capture to the next, so interim solves (on
//! prefixes) succeed while the final solve (on everything) fails.

use serde_json::{json, Value};

use crate::diag::Assessment;
use crate::linalg::Vec3;
use crate::pipeline::{reconstruct_vio_diag, SolveDiagnostics};
use crate::scenario::{generate, ScenarioSpec};
use crate::types::{OutputMap, Problem};

const LIVE: &str = r#"{"maxKeyframes": 120, "maxNfev": 20, "rejectOutliers": false}"#;

fn spec(v: Value) -> ScenarioSpec {
    serde_json::from_value(v).unwrap()
}

fn solve(problem: &Value) -> (OutputMap, SolveDiagnostics) {
    let p: Problem = serde_json::from_value(problem.clone()).unwrap();
    reconstruct_vio_diag(&p, None).unwrap()
}

fn with_options(problem: &Value, options: Value) -> Value {
    let mut p = problem.clone();
    p["options"] = options;
    p
}

/// The first `n` detections (time-sorted) and the IMU up to the last one —
/// what an interim solve saw.
fn prefix(problem: &Value, n: usize) -> Value {
    let dets: Vec<Value> = problem["detections"].as_array().unwrap()[..n].to_vec();
    let t_max = dets.last().unwrap()["tCaptureMs"].as_f64().unwrap();
    let imu: Vec<Value> = problem["imu"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|s| s["t"].as_f64().unwrap() <= t_max)
        .cloned()
        .collect();
    json!({"detections": dets, "imu": imu, "ledCount": problem["ledCount"],
           "mapId": "live", "createdAt": problem["createdAt"]})
}

/// Solved size relative to the truth (1 = metric) over the measured LEDs.
fn size_vs_truth(map: &OutputMap, truth: &[Vec3]) -> f64 {
    let (est, tru): (Vec<Vec3>, Vec<Vec3>) = map
        .leds
        .iter()
        .filter(|l| l.n_views > 0)
        .map(|l| (l.xyz, truth[l.id as usize]))
        .unzip();
    1.0 / crate::vio::similarity_align(&est, &tru).0
}

fn describe(a: &Assessment) -> String {
    format!(
        "{:?} measured {}/{} rms {:.1}",
        a.reasons, a.measured, a.observable, a.rms_px
    )
}

/// Gentle-motion captures (half a radian of orbit and 2 cm of bob over 40 s).
/// Seeds 1, 8 and 9 draw a negative final alignment scale (found by sweeping
/// scenario.rs seeds): before the guard their final map was empty, while
/// for 8 and 9 the interim solve on the first half rendered fine.
fn gentle(seed: u64) -> ScenarioSpec {
    spec(json!({"sweep": 0.5, "bob": 0.02, "duration": 40, "frameHz": 6, "seed": seed}))
}

#[test]
fn a_negative_alignment_scale_no_longer_empties_the_final_map() {
    for seed in [1, 9] {
        let sc = generate(&gentle(seed));
        // Reproduce the failure: without the guard the final solve is
        // degenerate (no LED in front of the cameras).
        let (_, before) = solve(&with_options(&sc.problem, json!({"initScaleGuard": false})));
        let cold = &before.trace[0];
        assert!(
            cold.init_scale.unwrap() <= 0.0 && before.assessment.degenerate,
            "seed {seed}: expected the pre-guard failure, got init scale {:?}, {}",
            cold.init_scale,
            describe(&before.assessment)
        );
        // Fixed: the guard seeds a plausible scale and the BA solves it.
        let (map, diag) = solve(&sc.problem);
        assert!(diag.trace[0].init_scale_fallback, "seed {seed}");
        assert!(
            !diag.assessment.degenerate && diag.assessment.measured >= 57,
            "seed {seed}: {}",
            describe(&diag.assessment)
        );
        let size = size_vs_truth(&map, &sc.truth);
        assert!((0.6..1.5).contains(&size), "seed {seed}: size {size:.3}");
    }
}

#[test]
fn decode_swaps_no_longer_collapse_the_cold_start() {
    // 3 % of decodes carry a wrong LED id: the unrobust linear init then
    // yields an alignment scale of ~0 (seed 3: -0.012), same failure.
    let sc = generate(&spec(json!({"swapP": 0.03, "seed": 3})));
    let (_, before) = solve(&with_options(&sc.problem, json!({"initScaleGuard": false})));
    assert!(
        before.assessment.degenerate,
        "{}",
        describe(&before.assessment)
    );
    let (map, diag) = solve(&sc.problem);
    assert!(
        !diag.assessment.degenerate,
        "{}",
        describe(&diag.assessment)
    );
    let size = size_vs_truth(&map, &sc.truth);
    assert!((0.7..1.3).contains(&size), "size {size:.3}");
}

#[test]
fn the_final_solve_is_never_worse_than_the_best_interim() {
    // The safety net on its own (guard off, as before the fix): an interim
    // solve on a prefix renders the fixture, the final cold start on all
    // the data is degenerate — and warm-starting the final from the interim
    // state recovers it.
    let sc = generate(&gentle(8));
    let n = sc.problem["detections"].as_array().unwrap().len();
    let mut best: Option<(Assessment, Value)> = None;
    for k in [n / 4, n / 2, 3 * n / 4] {
        let p = with_options(
            &prefix(&sc.problem, k),
            serde_json::from_str::<Value>(LIVE).unwrap(),
        );
        let p = {
            let mut p = p;
            p["options"]["initScaleGuard"] = json!(false);
            p
        };
        let pr: Problem = serde_json::from_value(p).unwrap();
        if let Ok((_, d)) = reconstruct_vio_diag(&pr, None) {
            if best
                .as_ref()
                .is_none_or(|(b, _)| crate::diag::better(&d.assessment, b))
            {
                best = Some((
                    d.assessment.clone(),
                    serde_json::to_value(&d.state).unwrap(),
                ));
            }
        }
    }
    let (interim, state) = best.expect("an interim solve");
    assert!(!interim.degenerate, "interim {}", describe(&interim));

    let cold_only = with_options(&sc.problem, json!({"initScaleGuard": false}));
    let (_, cold) = solve(&cold_only);
    assert!(cold.assessment.degenerate, "{}", describe(&cold.assessment));

    let warm = with_options(
        &sc.problem,
        json!({"initScaleGuard": false, "warmStart": state}),
    );
    let (_, diag) = solve(&warm);
    assert_eq!(diag.start, "warm");
    assert!(
        !diag.assessment.degenerate && diag.assessment.measured >= interim.measured,
        "final {} vs interim {}",
        describe(&diag.assessment),
        describe(&interim)
    );
}

#[test]
fn a_warm_start_places_leds_the_interim_never_saw() {
    // Stride 3 with 5 s phases: classes 0 and 1 light in the first 10 s,
    // class 2 from 11 s (after 1 s of decode dead time). An interim that ended
    // at 10.5 s never saw class 2; the warm-started final must still place
    // those LEDs (triangulated under the seeded poses, not left on the
    // origin).
    let sc = generate(&spec(
        json!({"stride": 3, "deadS": 1.0, "phaseS": 5, "duration": 30,
                                   "sweep": 1.0, "bob": 0.1, "frameHz": 6, "seed": 2}),
    ));
    let upto = |t_ms: f64| {
        sc.problem["detections"]
            .as_array()
            .unwrap()
            .iter()
            .take_while(|d| d["tCaptureMs"].as_f64().unwrap() < t_ms)
            .count()
    };
    let p = with_options(
        &prefix(&sc.problem, upto(10_500.0)),
        serde_json::from_str(LIVE).unwrap(),
    );
    let (_, interim) = solve(&p);
    let missing = 60 - interim.state.led_ids.len();
    assert!(
        missing >= 5,
        "the interim already saw {} LEDs",
        interim.state.led_ids.len()
    );
    let (_, diag) = solve(&with_options(
        &sc.problem,
        json!({"warmStart": interim.state}),
    ));
    let warm = diag
        .trace
        .iter()
        .find(|t| t.stage == "initial-warm")
        .unwrap();
    assert!(warm.solved >= 57, "warm start solved {}/60", warm.solved);
    assert!(
        !diag.assessment.degenerate,
        "{}",
        describe(&diag.assessment)
    );
}

#[test]
fn an_unusable_warm_start_is_reported_not_fatal() {
    let sc = generate(&spec(json!({"duration": 8, "frameHz": 5})));
    let bad = json!({"frameTimesS": [0.0, 1.0], "quats": [[1.0, 0.0, 0.0, 0.0]],
                     "positions": [], "velocities": [], "gravity": [0.0, -9.81, 0.0],
                     "gyroBias": [0.0, 0.0, 0.0], "accelBias": [0.0, 0.0, 0.0],
                     "ledIds": [], "ledPositions": []});
    let (_, diag) = solve(&with_options(&sc.problem, json!({"warmStart": bad})));
    assert_eq!(diag.start, "cold");
    assert!(diag.warm_start_error.is_some());
    assert!(
        !diag.assessment.degenerate,
        "{}",
        describe(&diag.assessment)
    );
}

#[test]
fn a_recorded_bundle_replays_identically() {
    // Build a bundle the way the app does (interim solves on prefixes, the
    // best one's state as the final's warm start) and replay it: every solve
    // must reproduce exactly. Like the phone, every solve parses its input
    // from JSON text (serde_json's float parsing is deterministic but not
    // always the nearest double, so in-memory and parsed inputs can differ
    // by an ulp — which a 20-evaluation interim solve amplifies to ~0.1 mm).
    let sc = generate(&spec(json!({"duration": 10, "frameHz": 5, "ledCount": 24})));
    let full: Value = serde_json::from_str(&sc.problem.to_string()).unwrap();
    let n = full["detections"].as_array().unwrap().len();
    let solve_text = |p: &Value| -> (OutputMap, SolveDiagnostics) {
        let pr: Problem = serde_json::from_str(&p.to_string()).unwrap();
        reconstruct_vio_diag(&pr, None).unwrap()
    };
    let mut interims = Vec::new();
    let mut best_state = Value::Null;
    for (i, k) in [n / 2, n].into_iter().enumerate() {
        let p = with_options(&prefix(&full, k), serde_json::from_str(LIVE).unwrap());
        let (map, d) = solve_text(&p);
        interims.push(json!({
            "recordCount": k,
            "imuCount": p["imu"].as_array().unwrap().len(),
            "ledCount": p["ledCount"], "mapId": "live", "createdAt": p["createdAt"],
            "options": p["options"], "map": map, "best": i == 1,
        }));
        best_state = serde_json::from_str(&serde_json::to_string(&d.state).unwrap()).unwrap();
    }
    // The bundle stores the capture's full streams; interims replay prefixes.
    let problem = with_options(&full, json!({"warmStart": best_state}));
    let (map, _) = solve_text(&problem);
    let bundle = json!({"format": "splanc-capture-bundle", "version": 1,
                        "problem": problem, "interims": interims,
                        "final": {"map": map}});
    let report = crate::replay::replay_bundle_text(
        &bundle.to_string(),
        &crate::replay::ReplayOptions {
            interims: true,
            drop_warm_start: false,
        },
    )
    .unwrap();
    assert_eq!(report.cases.len(), 3);
    for c in &report.cases {
        assert_eq!(
            c.identical,
            Some(true),
            "{} did not reproduce: {:?}",
            c.label,
            c.max_led_delta_m
        );
    }
}
