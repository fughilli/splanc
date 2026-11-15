//! Parameterised synthetic capture scenarios → wire-format `Problem` JSON.
//!
//! The reproduction harness's synthetic half: `solver_cli --synth '<spec>'`
//! prints a problem (or a capture bundle, see bundle.rs) for a capture whose
//! ground truth is known, so a failure mode seen on a phone can be dialled in
//! (gentle motion, diffuse stride dead time, decode swaps, …) and replayed
//! through the interim and final solve paths deterministically.
//!
//! Every knob has a default; `{}` is a well-excited 60-LED coil orbit.

use serde::Deserialize;
use serde_json::{json, Value};

use crate::camera::{look_at, project};
use crate::linalg::{add, mat_mul, mat_tvec, scale, sub, transpose, Vec3, ZERO3};
use crate::so3::so3_log;
use crate::synth::Rng;
use crate::vio::G_WORLD;

/// Dwell-and-hop motion: `k` vantage points held `dwell` s each, joined by
/// `hop` s minimum-jerk moves along the orbit arc.
#[derive(Deserialize, Debug, Clone)]
pub struct DwellHop {
    pub k: usize,
    pub dwell: f64,
    pub hop: f64,
    /// Whether the decoder delivers frames mid-hop (diffuse decode usually
    /// loses lock while the phone moves).
    #[serde(default)]
    pub hop_frames: bool,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(default)]
pub struct ScenarioSpec {
    /// "coil" (helix, 7 cm radius), "wall" (planar grid), "strip" (a
    /// straight run along x) or "dodecahedron" (the radiolarian: a closed
    /// dodecahedron of pentagonal panels, LEDs on concentric rings `pitch`
    /// apart, `ledCount` spread over the 12 faces innermost ring first; LEDs
    /// on faces turned away from the camera are hidden).
    pub fixture: String,
    #[serde(rename = "ledCount")]
    pub led_count: usize,
    /// LED pitch (wall/strip), meters.
    pub pitch: f64,
    pub duration: f64,
    /// Orbit radius, meters.
    pub radius: f64,
    /// Orbit arc swept over the capture, radians.
    pub sweep: f64,
    /// Vertical bob amplitude, meters (0.7 rad/s).
    pub bob: f64,
    /// Hand-sway amplitude, meters (multi-sine).
    pub sway: f64,
    #[serde(rename = "dwellHop")]
    pub dwell_hop: Option<DwellHop>,
    #[serde(rename = "frameHz")]
    pub frame_hz: f64,
    #[serde(rename = "imuHz")]
    pub imu_hz: f64,
    /// IMU starvation: the share of the capture inside DeviceMotion gaps (the
    /// browser drops motion events while the main thread is busy), each gap
    /// uniform in [0.1, `imuGapMaxS`] s (a new one may start as one ends).
    /// 0 = none.
    #[serde(rename = "imuGapFrac")]
    pub imu_gap_frac: f64,
    #[serde(rename = "imuGapMaxS")]
    pub imu_gap_max_s: f64,
    #[serde(rename = "pxNoise")]
    pub px_noise: f64,
    /// Per-observation drop probability.
    #[serde(rename = "dropP")]
    pub drop_p: f64,
    /// Diffuse stride `S` (web/src/code/stride.ts): `2S-1` phases — `S`
    /// coverage phases lighting `id % S == phase`, then `S-1` sparse bridge
    /// phases co-lighting class-0 anchors with each other class.
    pub stride: usize,
    /// Stride anchor density `A` (clamped to ≥ 3, as on the phone).
    #[serde(rename = "anchorDensity")]
    pub anchor_density: usize,
    /// Seconds per stride phase.
    #[serde(rename = "phaseS")]
    pub phase_s: f64,
    /// Decode-lock dead time after each phase switch (no frames), seconds.
    #[serde(rename = "deadS")]
    pub dead_s: f64,
    /// Probability an observation carries a wrong (random) LED id.
    #[serde(rename = "swapP")]
    pub swap_p: f64,
    #[serde(rename = "K")]
    pub k: [f64; 4],
    pub seed: u64,
}

impl Default for ScenarioSpec {
    fn default() -> Self {
        ScenarioSpec {
            fixture: "coil".into(),
            led_count: 60,
            pitch: 0.03,
            duration: 20.0,
            radius: 0.75,
            sweep: 1.0,
            bob: 0.15,
            sway: 0.0,
            dwell_hop: None,
            frame_hz: 10.0,
            imu_hz: 100.0,
            imu_gap_frac: 0.0,
            imu_gap_max_s: 0.6,
            px_noise: 1.0,
            drop_p: 0.05,
            stride: 1,
            anchor_density: 3,
            phase_s: 6.0,
            dead_s: 0.0,
            swap_p: 0.0,
            k: [800.0, 800.0, 640.0, 360.0],
            seed: 1,
        }
    }
}

/// Ground-truth LED positions for the spec's fixture.
pub fn fixture_leds(spec: &ScenarioSpec) -> Vec<Vec3> {
    let n = spec.led_count.max(2);
    match spec.fixture.as_str() {
        "wall" => {
            let cols = (n as f64).sqrt().ceil() as usize;
            let rows = n.div_ceil(cols);
            (0..n)
                .map(|i| {
                    let (r, c) = (i / cols, i % cols);
                    [
                        (c as f64 - (cols as f64 - 1.0) / 2.0) * spec.pitch,
                        ((rows as f64 - 1.0) / 2.0 - r as f64) * spec.pitch,
                        0.0,
                    ]
                })
                .collect()
        }
        "dodecahedron" => dodecahedron_leds(n, spec.pitch).0,
        "strip" => (0..n)
            .map(|i| [(i as f64 - (n as f64 - 1.0) / 2.0) * spec.pitch, 0.0, 0.0])
            .collect(),
        _ => (0..n)
            .map(|i| {
                let f = i as f64 / (n - 1) as f64;
                let th = f * 2.5 * std::f64::consts::TAU;
                [0.07 * th.cos(), -0.08 + 0.16 * f, 0.07 * th.sin()]
            })
            .collect(),
    }
}

/// Inradius of the radiolarian's dodecahedron (panel centre to body centre).
pub const DODECA_INRADIUS_M: f64 = 0.105;

/// The radiolarian fixture: `n` LEDs over a dodecahedron's 12 pentagonal
/// faces, each face's LEDs on concentric rings `pitch` apart (1, 6, 12, 18,
/// 24, 44 LEDs: 105 per face, 1260 in all), innermost first. Returns the LEDs
/// and each one's outward face normal (for back-face hiding).
pub fn dodecahedron_leds(n: usize, pitch: f64) -> (Vec<Vec3>, Vec<Vec3>) {
    const RINGS: [usize; 6] = [1, 6, 12, 18, 24, 44];
    let ring_pos: Vec<(f64, f64)> = RINGS
        .iter()
        .enumerate()
        .flat_map(|(ring, &count)| {
            (0..count).map(move |k| {
                let a = std::f64::consts::TAU * k as f64 / count as f64 + ring as f64 * 0.3;
                let r = ring as f64 * pitch;
                (r * a.cos(), r * a.sin())
            })
        })
        .collect();
    // Face normals: the icosahedron's vertices.
    let phi = (1.0 + 5f64.sqrt()) / 2.0;
    let mut normals: Vec<Vec3> = Vec::new();
    for a in [-1.0, 1.0] {
        for b in [-phi, phi] {
            normals.push([0.0, a, b]);
            normals.push([a, b, 0.0]);
            normals.push([b, 0.0, a]);
        }
    }
    let per_face = n.div_ceil(12).min(ring_pos.len());
    let (mut leds, mut ns) = (Vec::new(), Vec::new());
    for nrm in &normals {
        let nn = scale(*nrm, 1.0 / crate::linalg::norm(*nrm));
        // An in-plane basis for the face.
        let helper = if nn[1].abs() < 0.9 { [0.0, 1.0, 0.0] } else { [1.0, 0.0, 0.0] };
        let e1 = crate::linalg::normalize(crate::linalg::cross(helper, nn));
        let e2 = crate::linalg::cross(nn, e1);
        for &(x, y) in ring_pos.iter().take(per_face) {
            leds.push(add(
                scale(nn, DODECA_INRADIUS_M),
                add(scale(e1, x), scale(e2, y)),
            ));
            ns.push(nn);
        }
    }
    leds.truncate(n);
    ns.truncate(n);
    (leds, ns)
}

/// Port of web/src/code/stride.ts `strideLit`.
pub fn stride_lit(led: usize, phase: usize, spacing: usize, anchor_density: usize) -> bool {
    let s = spacing;
    if s <= 1 {
        return true;
    }
    let ph = phase % (2 * s - 1);
    if ph < s {
        return led % s == ph;
    }
    let j = ph - s + 1;
    let a = anchor_density.max(3);
    let m = led % (a * s);
    m == 0 || m == (a / 2) * s + j
}

/// A generated scenario: the wire problem plus its ground truth.
pub struct Scenario {
    pub problem: Value,
    pub truth: Vec<Vec3>,
}

pub fn generate(spec: &ScenarioSpec) -> Scenario {
    let leds = fixture_leds(spec);
    // Closed fixtures hide the LEDs on faces turned away from the camera.
    let normals: Option<Vec<Vec3>> = (spec.fixture == "dodecahedron")
        .then(|| dodecahedron_leds(spec.led_count.max(2), spec.pitch).1);
    let dur = spec.duration;
    let ph: Vec<f64> = {
        let mut r = Rng::new(spec.seed ^ 77);
        (0..6)
            .map(|_| r.uniform() * std::f64::consts::TAU)
            .collect()
    };
    // Orbit parameter u in [0, 1] as a function of time (+ whether mid-hop).
    let u_of = |t: f64| -> (f64, bool) {
        match &spec.dwell_hop {
            None => ((t / dur).clamp(0.0, 1.0), false),
            Some(dh) => {
                let k = dh.k.max(2);
                let seg = dh.dwell + dh.hop;
                let i = (t / seg).floor();
                let r = t - i * seg;
                let (u, moving) = if r < dh.dwell || i as usize >= k - 1 {
                    (i.min((k - 1) as f64), false)
                } else {
                    let x = (r - dh.dwell) / dh.hop;
                    (i + x * x * x * (10.0 - 15.0 * x + 6.0 * x * x), true)
                };
                (u / (k - 1) as f64, moving)
            }
        }
    };
    let pos = |t: f64| -> Vec3 {
        let u = u_of(t).0;
        let th = -0.5 * spec.sweep + spec.sweep * u;
        let s = spec.sway;
        [
            spec.radius * th.sin()
                + s * (0.9 * t + ph[0]).sin()
                + 0.5 * s * (2.3 * t + ph[3]).sin(),
            0.1 + spec.bob * (0.7 * t).sin()
                + s * (1.3 * t + ph[1]).sin()
                + 0.5 * s * (1.9 * t + ph[4]).sin(),
            spec.radius * th.cos()
                + s * (0.6 * t + ph[2]).sin()
                + 0.5 * s * (2.7 * t + ph[5]).sin(),
        ]
    };
    let rot = |t: f64| look_at(pos(t), ZERO3);
    let mut rng = Rng::new(spec.seed);
    let h = 1e-4;
    let (gyro_bias, accel_bias) = ([2e-3, -1e-3, 1.5e-3], [0.03, -0.02, 0.04]);
    // IMU starvation: gaps start as a Poisson process whose rate makes them
    // cover `imu_gap_frac` of the capture on average.
    let mut gap_rng = Rng::new(spec.seed ^ 0x1u64.rotate_left(40));
    let gap_mean = 0.5 * (0.1 + spec.imu_gap_max_s.max(0.1));
    let gap_frac = spec.imu_gap_frac.clamp(0.0, 0.95);
    let gap_start_p = gap_frac / ((1.0 - gap_frac) * gap_mean) / spec.imu_hz;
    let mut gap_until = f64::NEG_INFINITY;
    let imu_times: Vec<f64> = (0..(dur * spec.imu_hz) as usize)
        .map(|i| i as f64 / spec.imu_hz)
        .filter(|&t| {
            if t < gap_until {
                return false;
            }
            if gap_frac > 0.0 && gap_rng.uniform() < gap_start_p {
                gap_until = t + 0.1 + gap_rng.uniform() * (spec.imu_gap_max_s.max(0.1) - 0.1);
                return false;
            }
            true
        })
        .collect();
    let imu: Vec<Value> = imu_times
        .into_iter()
        .map(|t| {
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
            json!({"t": t * 1000.0, "gyro": gyro, "accel": accel})
        })
        .collect();

    let stride = spec.stride.max(1);
    let mut detections: Vec<Value> = Vec::new();
    for i in 0..(dur * spec.frame_hz) as usize {
        let t = i as f64 / spec.frame_hz;
        if u_of(t).1 && !spec.dwell_hop.as_ref().is_some_and(|d| d.hop_frames) {
            continue;
        }
        let phase_idx = (t / spec.phase_s).floor();
        if stride > 1 && phase_idx > 0.0 && t - phase_idx * spec.phase_s < spec.dead_s {
            continue;
        }
        let phase = phase_idx as usize;
        let (p, r) = (pos(t), rot(t));
        for (j, l) in leds.iter().enumerate() {
            if !stride_lit(j, phase, stride, spec.anchor_density) {
                continue;
            }
            if let Some(ns) = &normals {
                if crate::linalg::dot(ns[j], sub(p, *l)) <= 0.0 {
                    continue; // on a face turned away
                }
            }
            let (u, v, d) = project(&r, p, spec.k, *l);
            let inside = d > 0.0
                && (0.0..2.0 * spec.k[2]).contains(&u)
                && (0.0..2.0 * spec.k[3]).contains(&v);
            if !inside || rng.uniform() < spec.drop_p {
                continue;
            }
            let mut id = j as u32;
            if rng.uniform() < spec.swap_p {
                id = (rng.uniform() * leds.len() as f64) as u32 % leds.len() as u32;
            }
            detections.push(json!({
                "ledId": id,
                "u": u + spec.px_noise * rng.normal(),
                "v": v + spec.px_noise * rng.normal(),
                "K": spec.k,
                "tCaptureMs": t * 1000.0,
            }));
        }
    }
    Scenario {
        problem: json!({
            "detections": detections,
            "imu": imu,
            "ledCount": leds.len(),
            "mapId": format!("synth-{}", spec.seed),
            "createdAt": "1970-01-01T00:00:00Z",
        }),
        truth: leds,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::linalg::{norm, sub};

    #[test]
    fn the_dodecahedron_is_the_radiolarian() {
        let (leds, normals) = dodecahedron_leds(1260, 0.0135);
        assert_eq!(leds.len(), 1260, "105 LEDs on each of 12 faces");
        // Every LED sits on its face's plane, at the inradius.
        for (l, n) in leds.iter().zip(&normals) {
            assert!((crate::linalg::dot(*l, *n) - DODECA_INRADIUS_M).abs() < 1e-12);
        }
        // Neighbours on a face are about a ring pitch apart.
        let face = &leds[..105];
        let nn: Vec<f64> = face
            .iter()
            .enumerate()
            .map(|(i, a)| {
                face.iter()
                    .enumerate()
                    .filter(|(j, _)| *j != i)
                    .map(|(_, b)| norm(sub(*a, *b)))
                    .fold(f64::INFINITY, f64::min)
            })
            .collect();
        let mean = nn.iter().sum::<f64>() / nn.len() as f64;
        assert!((0.009..0.014).contains(&mean), "mean NN {mean:.4} m");
    }

    #[test]
    fn imu_gaps_starve_the_stream_as_asked() {
        let sc = generate(&serde_json::from_value(serde_json::json!({
            "duration": 120, "imuHz": 15, "imuGapFrac": 0.3, "imuGapMaxS": 0.6,
            "frameHz": 1,
        }))
        .unwrap());
        let ts: Vec<f64> = sc.problem["imu"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| s["t"].as_f64().unwrap() / 1000.0)
            .collect();
        // Time lost to gaps: each long interval minus the one it replaces.
        let gap: f64 = ts
            .windows(2)
            .map(|w| w[1] - w[0])
            .filter(|&d| d > 0.1)
            .map(|d| d - 1.0 / 15.0)
            .sum();
        let frac = gap / 120.0;
        assert!((0.2..0.4).contains(&frac), "{:.0}% in gaps", frac * 100.0);
        // Gaps are up to 0.6 s each (back-to-back ones can chain).
        let longest = ts.windows(2).map(|w| w[1] - w[0]).fold(0.0, f64::max);
        assert!((0.45..2.0).contains(&longest), "longest gap {longest:.2} s");
    }
}
