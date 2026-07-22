//! LED Mapper native VIO solver — Rust port of `reconstruction/vio.py` +
//! `vio_api.py` (see those files for the algorithm rationale; comments here
//! only cover what differs from the Python reference).
//!
//! Deployed twice from this one crate: a host binary the Pi server runs as a
//! subprocess, and a wasm32 module the phone runs in-browser. The public
//! surface is JSON-in/JSON-out (`solve_json`) so both carriers stay trivial.

pub mod camera;
pub mod imu;
pub mod linalg;
pub mod lm;
pub mod pipeline;
pub mod quat;
pub mod so3;
pub mod sparse;
pub mod synth;
pub mod types;
pub mod vio;

use types::{Problem, ProgressSnapshot};

/// Solve a JSON problem (§7.4 detections + imu stream + options) into a
/// §7.5 OutputMap JSON string. `progress` receives solve_status-shaped
/// snapshots after every optimizer evaluation — carriers throttle.
pub fn solve_json(
    input: &str,
    mut progress: Option<&mut dyn FnMut(&ProgressSnapshot)>,
) -> Result<String, String> {
    let problem: Problem =
        serde_json::from_str(input).map_err(|e| format!("bad problem JSON: {e}"))?;
    let mut cb =
        |frac: f64, rms: f64, ids: &[u32], leds: &[linalg::Vec3], cams: &[linalg::Vec3]| {
            if let Some(p) = progress.as_mut() {
                p(&pipeline::snapshot(frac, rms, ids, leds, cams));
            }
        };
    let map = pipeline::reconstruct_vio(&problem, Some(&mut cb))?;
    serde_json::to_string(&map).map_err(|e| format!("serialize: {e}"))
}

/// Run the canned benchmark solve once (identical work on every carrier —
/// the CALLER times it; wasm has no monotonic clock of its own).
pub fn run_benchmark() -> f64 {
    let (frames, imu) = synth::benchmark_problem();
    let result = vio::solve_vio(
        &frames,
        &imu,
        &vio::SolveOptions {
            px_sigma: 1.0,
            max_nfev: 20,
            ..vio::SolveOptions::default()
        },
        None,
        None,
    );
    // Return a fingerprint so the work cannot be optimized away and carriers
    // can sanity-check both sides ran the same solve.
    result.rms_reproj_px
}

pub fn version() -> &'static str {
    "0.1.0"
}

#[cfg(test)]
mod tests {
    #[test]
    fn benchmark_runs_and_solves_sanely() {
        let rms = super::run_benchmark();
        assert!(rms.is_finite() && rms < 5.0, "benchmark rms {rms}");
    }
}
