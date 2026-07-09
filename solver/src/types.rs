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
fn default_gap_split_s() -> f64 {
    3.0
}
fn default_outlier_sigma() -> f64 {
    4.0
}
fn default_min_views() -> usize {
    2
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
    #[serde(rename = "gapSplitS")]
    pub gap_split_s: f64,
    #[serde(rename = "outlierSigma")]
    pub outlier_sigma: f64,
    #[serde(rename = "minViews")]
    pub min_views: usize,
}

impl Default for ProblemOptions {
    fn default() -> Self {
        ProblemOptions {
            max_keyframes: default_max_keyframes(),
            max_nfev: default_max_nfev(),
            px_sigma: default_px_sigma(),
            reject_outliers: default_true(),
            gap_split_s: default_gap_split_s(),
            outlier_sigma: default_outlier_sigma(),
            min_views: default_min_views(),
        }
    }
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
