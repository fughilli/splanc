//! Wire-shaped problem/result types (serde). The problem mirrors the
//! server's session-log JSON (§7.4 detection records + imu stream); the
//! result is a §7.5 OutputMap — byte-compatible with the pydantic/TS
//! contract models on the JSON level.

use serde::{Deserialize, Serialize};

#[derive(Deserialize, Debug, Clone)]
pub struct DetectionRecordWire {
    #[serde(rename = "ledId")]
    pub led_id: u32,
    pub u: f64,
    pub v: f64,
    #[serde(rename = "K")]
    pub k: [f64; 4],
    #[serde(rename = "tCaptureMs")]
    pub t_capture_ms: f64,
}

#[derive(Deserialize, Debug, Clone)]
pub struct ImuSampleWire {
    pub t: f64, // ms
    pub gyro: [f64; 3],
    pub accel: [f64; 3],
}

fn default_max_keyframes() -> Option<usize> {
    Some(250)
}
fn default_max_nfev() -> usize {
    60
}
fn default_px_sigma() -> f64 {
    1.0
}
fn default_true() -> bool {
    true
}
fn default_outlier_sigma() -> f64 {
    4.0
}
fn default_min_views() -> usize {
    2
}
fn default_strip_tolerance() -> f64 {
    0.25
}

/// Mirrors reconstruct_vio's keyword arguments (and their defaults).
#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct ProblemOptions {
    #[serde(rename = "maxKeyframes")]
    pub max_keyframes: Option<usize>,
    #[serde(rename = "maxNfev")]
    pub max_nfev: usize,
    #[serde(rename = "pxSigma")]
    pub px_sigma: f64,
    #[serde(rename = "rejectOutliers")]
    pub reject_outliers: bool,
    #[serde(rename = "outlierSigma")]
    pub outlier_sigma: f64,
    #[serde(rename = "minViews")]
    pub min_views: usize,
    /// Strip prior (strip.rs): LED ids are wired in order, so consecutive ids
    /// are at most one pitch apart. Constrains the bundle adjustment, demotes
    /// LEDs that break the chain, and places interior unmapped runs on the
    /// segment between their mapped neighbours. Off by default.
    #[serde(rename = "stripPrior")]
    pub strip_prior: bool,
    /// Known LED pitch in meters (e.g. 1/60 for a 60 LED/m strip). Unset =
    /// estimated from the unconstrained solve.
    #[serde(rename = "stripSpacingM")]
    pub strip_spacing_m: Option<f64>,
    /// Fractional slack on the pitch bound (bound = gap · pitch · (1 + tol)).
    #[serde(rename = "stripTolerance")]
    pub strip_tolerance: f64,
    /// Solver state of an earlier (interim) solve of the same capture — the
    /// final solve also starts from it and keeps whichever start solves
    /// better, so it can't come back worse than what the live preview showed
    /// (see pipeline::reconstruct_vio_traced).
    #[serde(rename = "warmStart")]
    pub warm_start: Option<WarmState>,
    /// Cold-start scale guard (vio::SolveOptions::init_scale_guard). Only
    /// for replaying a capture the way the solver handled it before the
    /// guard existed; leave it on.
    #[serde(rename = "initScaleGuard")]
    pub init_scale_guard: bool,
}

impl Default for ProblemOptions {
    fn default() -> Self {
        ProblemOptions {
            max_keyframes: default_max_keyframes(),
            max_nfev: default_max_nfev(),
            px_sigma: default_px_sigma(),
            reject_outliers: default_true(),
            outlier_sigma: default_outlier_sigma(),
            min_views: default_min_views(),
            strip_prior: false,
            strip_spacing_m: None,
            strip_tolerance: default_strip_tolerance(),
            warm_start: None,
            init_scale_guard: true,
        }
    }
}

/// A solved VIO state on the wire: the solver's own (un-leveled,
/// camera-anchored) frame, everything needed to warm-start a later solve of
/// the same capture. Frame times are seconds on the detections' clock.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct WarmState {
    #[serde(rename = "frameTimesS")]
    pub frame_times_s: Vec<f64>,
    /// Camera-to-world quaternions (w, x, y, z), one per frame.
    pub quats: Vec<[f64; 4]>,
    pub positions: Vec<[f64; 3]>,
    pub velocities: Vec<[f64; 3]>,
    pub gravity: [f64; 3],
    #[serde(rename = "gyroBias")]
    pub gyro_bias: [f64; 3],
    #[serde(rename = "accelBias")]
    pub accel_bias: [f64; 3],
    #[serde(rename = "ledIds")]
    pub led_ids: Vec<u32>,
    #[serde(rename = "ledPositions")]
    pub led_positions: Vec<[f64; 3]>,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Problem {
    pub detections: Vec<DetectionRecordWire>,
    #[serde(default)]
    pub imu: Vec<ImuSampleWire>,
    #[serde(rename = "ledCount", default)]
    pub led_count: Option<u32>,
    #[serde(rename = "mapId", default)]
    pub map_id: Option<String>,
    #[serde(rename = "createdAt", default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub options: ProblemOptions,
}

// ---- §7.5 OutputMap -------------------------------------------------------

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct LedEntry {
    pub id: u32,
    pub xyz: [f64; 3],
    pub confidence: f64,
    #[serde(rename = "nViews")]
    pub n_views: usize,
    #[serde(rename = "rmsReprojPx")]
    pub rms_reproj_px: f64,
    #[serde(rename = "parallaxDeg")]
    pub parallax_deg: f64,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OutputMapStats {
    #[serde(rename = "rmsReprojPxGlobal")]
    pub rms_reproj_px_global: f64,
    #[serde(rename = "medianParallaxDeg")]
    pub median_parallax_deg: f64,
    #[serde(
        rename = "scaleRelStdErr",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub scale_rel_std_err: Option<f64>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct OutputMap {
    #[serde(rename = "mapId")]
    pub map_id: String,
    #[serde(rename = "createdAt")]
    pub created_at: String,
    pub units: String,
    pub frame: String,
    #[serde(rename = "ledCount")]
    pub led_count: u32,
    pub leds: Vec<LedEntry>,
    pub unmapped: Vec<u32>,
    // Optional on the TS side (host maps may omit it); a replayed bundle's
    // recorded map must still parse.
    #[serde(default)]
    pub trajectory: Vec<[f64; 3]>,
    pub stats: OutputMapStats,
}

/// One progress snapshot, shaped like §7 solve_status content so carriers
/// can pass it straight through.
#[derive(Serialize, Debug, Clone)]
pub struct ProgressSnapshot {
    pub progress: f64,
    #[serde(rename = "rmsPx")]
    pub rms_px: f64,
    pub leds: Vec<ProgressLed>,
    pub trajectory: Vec<[f64; 3]>,
}

#[derive(Serialize, Debug, Clone)]
pub struct ProgressLed {
    pub id: u32,
    pub xyz: [f64; 3],
}
