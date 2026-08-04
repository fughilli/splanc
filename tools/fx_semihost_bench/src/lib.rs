//! Host benchmark for the effects VM (FUG-11: "Export a common profile format
//! so that different execution targets can feed their profiles into the
//! simulator in a uniform way").
//!
//! This runs the **real firmware VM** (`ledmapper_fx_vm`) natively on the host
//! and emits a profile with `source: "host"`. IMPORTANT: this is a
//! pipeline/format SMOKE test, NOT a device performance model — a hardware-FPU
//! host has far too much compute to predict the FPU-less C6 (on the host `sin ≈
//! add`). The AUTHORITATIVE per-opcode model comes from the HITL device
//! benchmark (pi/hitl/harness/fx_bench.py), which flashes the real C6 and
//! collects cycle-accurate PerfReports into the same [`ExecutionProfile`]
//! format. This crate exists to exercise that format + the fit end-to-end with
//! no hardware in CI, and to seed a plausible-shaped profile.
//!
//! To keep even the smoke profile from inverting the C6's economics, each cost
//! is split into a MEASURED dispatch term and a MODELED soft-float weight (see
//! [`build_profile`]); the residual is deliberately wide.
//!
//! The emitted [`ExecutionProfile`] is the common profile format (see
//! web/src/effects/executionProfile.ts): the same JSON shape that the device
//! benchmark and the shipped default also use. This crate splits into:
//!   - a deterministic, unit-tested core here (program builders, the
//!     least-squares slope fit, profile assembly + serde), and
//!   - the timing harness in `main.rs` (wall-clock measurement — non-
//!     deterministic, so kept out of the tested core).

use ledmapper_fx_vm::{Op, C_LED_POS, F_EXP, F_SIN, F_SQRT, B_POW, MAGIC, NO_ENTRY};
use serde::{Deserialize, Serialize};

pub const PROFILE_KIND: &str = "ledmapper-execution-profile";
pub const PROFILE_VERSION: u32 = 1;
pub const TOOL_VERSION: &str = "fx-semihost-bench 0.1.0";

// -- the common profile format (mirror executionProfile.ts) ------------------

/// Fixed / per-LED overheads, in cycles. Field names are snake_case to match
/// the TS `FixedOverhead` exactly (serde default keeps Rust field names).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FixedOverhead {
    pub update_fixed: f64,
    pub shade_fixed: f64,
    pub show_fixed: f64,
    pub show_per_led: f64,
}

/// Available-execution-budget model (FUG-11). camelCase to match TS.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BudgetModel {
    pub fps: f64,
    pub cpu_available_fraction: f64,
    pub transmit_reserves_cpu: bool,
}

/// One raw benchmark observation (predicted vs measured cycles for one
/// micro-program), kept so the model can be re-fit under a new form.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub label: String,
    pub target_op: Option<String>,
    pub reps: u32,
    pub led_count: u32,
    pub measured: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub predicted: Option<f64>,
}

/// The portable, cross-target execution profile. Serializes to the same JSON
/// the web simulator parses (executionProfile.ts `ExecutionProfile`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionProfile {
    pub kind: String,
    pub version: u32,
    pub soc: String,
    pub source: String,
    pub cpu_hz: f64,
    pub unit: String,
    pub tool_version: String,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware_build: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_label: Option<String>,
    /// BTreeMap so the JSON key order is stable (golden-diff friendly).
    pub costs: std::collections::BTreeMap<String, f64>,
    pub fixed: FixedOverhead,
    pub fallback_cost: f64,
    pub residual_error: f64,
    pub budget: BudgetModel,
    pub observations: Vec<Observation>,
}

impl ExecutionProfile {
    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("profile serializes")
    }
}

// -- calibration micro-programs ----------------------------------------------

/// A micro-program that isolates one cost: a shade() whose body repeats a single
/// opcode `reps` times over a scalar seed, so the M/2M/… slope cancels fixed
/// overhead and recovers the per-op cost.
#[derive(Debug, Clone)]
pub struct BenchProgram {
    pub label: String,
    /// Opcode name this bench isolates, or None for a fixed/overhead bench.
    pub target_op: Option<String>,
    pub reps: u32,
    pub led_count: u32,
    pub bytecode: Vec<u8>,
}

/// The step bytes appended once per repetition, for each benchmarked opcode.
/// Each step is stack-neutral (keeps exactly one scalar on the stack): unary
/// ops map a→f(a); binary-with-const ops map a→a·c.
fn step_bytes(op: &str) -> Vec<u8> {
    match op {
        // binary elementwise + a const (n = 1 lane)
        "Add" => vec![Op::PushConst as u8, 0, 0, Op::Add as u8, 1],
        "Mul" => vec![Op::PushConst as u8, 0, 0, Op::Mul as u8, 1],
        "Div" => vec![Op::PushConst as u8, 0, 0, Op::Div as u8, 1],
        // unary transcendentals / specials
        "UnMath.sin" => vec![Op::UnMath as u8, F_SIN, 1],
        "UnMath.sqrt" => vec![Op::UnMath as u8, F_SQRT, 1],
        "UnMath.exp" => vec![Op::UnMath as u8, F_EXP, 1],
        "BinMath.pow" => vec![Op::PushConst as u8, 0, 0, Op::BinMath as u8, B_POW, 1],
        "Hash1" => vec![Op::Hash1 as u8],
        _ => panic!("unknown bench op {op}"),
    }
}

/// The opcode NAME the profile records for a bench op (folds the UnMath/BinMath
/// fn variants back onto their dispatch opcode, since the cost table is keyed by
/// opcode, not math-fn — the fn variance rides the residual).
pub fn profile_op_name(op: &str) -> &str {
    match op {
        "UnMath.sin" | "UnMath.sqrt" | "UnMath.exp" => "UnMath",
        "BinMath.pow" => "BinMath",
        other => other,
    }
}

/// The curated benchmark opcode set (the "fewer benchmarks first" DECISION:
/// isolate the expensive float ops + a cheap anchor; the rest ride the
/// fallback). One representative per dispatch opcode (sin for UnMath, pow for
/// BinMath) so the fold in [`profile_op_name`] never collides. `Add` is the
/// anchor.
pub const BENCH_OPS: &[&str] = &["Add", "Mul", "Div", "UnMath.sin", "BinMath.pow", "Hash1"];

/// The anchor opcode whose cost pins the absolute scale (all others are its
/// measured ratio × the anchor's assumed device cost).
pub const ANCHOR_OP: &str = "Add";

/// Rep counts per op (multiple points → a real least-squares slope + residual).
pub const REP_POINTS: &[u32] = &[32, 64, 96];

/// Build a single-opcode chain shade() `.fxb` with `reps` repetitions of `op`.
pub fn build_op_program(op: &str, reps: u32, led_count: u32) -> BenchProgram {
    // seed: a = led.pos.x  (LoadCtx pos -> swizzle .x)
    let mut code = vec![Op::LoadCtx as u8, C_LED_POS, Op::Swizzle as u8, 3, 1, 0];
    let step = step_bytes(op);
    for _ in 0..reps {
        code.extend_from_slice(&step);
    }
    // finish: return vec3(a, a, a)  (swizzle 1 -> 3)
    code.extend_from_slice(&[Op::Swizzle as u8, 1, 3, 0, 0, 0, Op::Ret as u8, 3]);
    BenchProgram {
        label: format!("{op} x{reps}"),
        target_op: Some(profile_op_name(op).to_string()),
        reps,
        led_count,
        bytecode: fxb(&[1.001], 0, NO_ENTRY, 0, &code),
    }
}

/// An empty shade() (`return vec3(0)`): isolates the per-LED loop framing
/// (shade_fixed).
pub fn build_empty_shade(led_count: u32) -> BenchProgram {
    let code = vec![
        Op::PushConst as u8, 0, 0,
        Op::PushConst as u8, 0, 0,
        Op::PushConst as u8, 0, 0,
        Op::Ret as u8, 3,
    ];
    BenchProgram {
        label: "empty shade".into(),
        target_op: None,
        reps: 0,
        led_count,
        bytecode: fxb(&[0.0], 0, NO_ENTRY, 0, &code),
    }
}

/// An empty update() (`Ret 0`) + trivial shade: isolates update() call framing
/// (update_fixed). update entry = 0, shade entry after it.
pub fn build_empty_update() -> BenchProgram {
    // code: [0] Ret 0            (update)
    //       [2] PushConst0 x3; Ret 3   (shade)
    let code = vec![
        Op::Ret as u8, 0, // update at offset 0
        Op::PushConst as u8, 0, 0,
        Op::PushConst as u8, 0, 0,
        Op::PushConst as u8, 0, 0,
        Op::Ret as u8, 3, // shade at offset 2
    ];
    BenchProgram {
        label: "empty update".into(),
        target_op: None,
        reps: 0,
        led_count: 1,
        bytecode: fxb(&[0.0], 0, 0, 2, &code),
    }
}

/// Assemble a `.fxb` buffer (mirrors the header written by the compiler +
/// firmware/fx_vm/tests/vm.rs `fxb`).
pub fn fxb(consts: &[f32], n_state: u8, update: u16, shade: u16, code: &[u8]) -> Vec<u8> {
    let mut b = Vec::new();
    b.extend_from_slice(&MAGIC);
    b.push(1); // version
    b.push(0); // flags
    b.push(n_state);
    b.push(0); // n_uniform_slots
    b.extend_from_slice(&0u16.to_le_bytes()); // manifest_len
    b.extend_from_slice(&(consts.len() as u16).to_le_bytes());
    b.extend_from_slice(&(code.len() as u16).to_le_bytes());
    b.extend_from_slice(&update.to_le_bytes());
    b.extend_from_slice(&shade.to_le_bytes());
    for c in consts {
        b.extend_from_slice(&c.to_le_bytes());
    }
    b.extend_from_slice(code);
    b
}

// -- the fit -----------------------------------------------------------------

/// A measured (reps, per-call time) point for one op, in host nanoseconds.
#[derive(Debug, Clone, Copy)]
pub struct Point {
    pub reps: u32,
    pub ns: f64,
}

/// Ordinary least-squares slope + intercept of ns = intercept + slope·reps,
/// plus a relative residual (RMS error / mean ns) as a fit-quality signal.
pub fn lsq(points: &[Point]) -> (f64, f64, f64) {
    let n = points.len() as f64;
    if n < 2.0 {
        return (0.0, points.first().map(|p| p.ns).unwrap_or(0.0), 1.0);
    }
    let sx: f64 = points.iter().map(|p| p.reps as f64).sum();
    let sy: f64 = points.iter().map(|p| p.ns).sum();
    let sxx: f64 = points.iter().map(|p| (p.reps as f64) * (p.reps as f64)).sum();
    let sxy: f64 = points.iter().map(|p| (p.reps as f64) * p.ns).sum();
    let denom = n * sxx - sx * sx;
    if denom.abs() < 1e-9 {
        return (0.0, sy / n, 1.0);
    }
    let slope = (n * sxy - sx * sy) / denom;
    let intercept = (sy - slope * sx) / n;
    // relative residual (RMS of prediction error over mean)
    let mut sse = 0.0;
    for p in points {
        let pred = intercept + slope * (p.reps as f64);
        sse += (p.ns - pred) * (p.ns - pred);
    }
    let rms = (sse / n).sqrt();
    let mean = sy / n;
    let rel = if mean.abs() > 1e-12 { rms / mean } else { 1.0 };
    (slope, intercept, rel)
}

/// Per-op measurement: the rep→ns points plus the recovered slope (ns/op).
#[derive(Debug, Clone)]
pub struct OpMeasurement {
    pub op: String,
    pub points: Vec<Point>,
}

/// Inputs to [`build_profile`]: the raw host-ns measurements plus the modeled
/// soft-float weights the host cannot represent (see [`build_profile`]).
#[derive(Debug, Clone)]
pub struct FitInputs {
    pub ops: Vec<OpMeasurement>,
    /// Per-call ns of the empty shade (shade_fixed source).
    pub empty_shade_ns: f64,
    /// Per-call ns of the empty update (update_fixed source).
    pub empty_update_ns: f64,
    pub soc: String,
    pub cpu_hz: f64,
    /// Assumed device cycle cost of a *bare opcode dispatch* (the ISA-portable
    /// interpreter overhead). Pins host-ns → device-cycles via the anchor op,
    /// whose host time is essentially pure dispatch (host add ≈ 1 cycle).
    pub dispatch_ref_cycles: f64,
    /// Modeled per-opcode SOFT-FLOAT arithmetic cost (device cycles) added on
    /// top of the measured dispatch. This is the part a hardware-FPU host
    /// CANNOT measure (host sin ≈ host add), so it comes from the C6's known
    /// soft-float economics; a cycle-accurate target supersedes it. Ops absent
    /// here are treated as pure-dispatch (int/stack/branch → 0 arith).
    pub softfloat: std::collections::BTreeMap<String, f64>,
    /// Default show_fixed / show_per_led (host can't measure transmit).
    pub default_show_fixed: f64,
    pub default_show_per_led: f64,
    pub budget: BudgetModel,
}

/// Fit the [`ExecutionProfile`] from raw host measurements.
///
/// The core honesty of a *semihost* (native, hardware-FPU) benchmark: it can
/// measure the interpreter's ISA-portable parts — the per-opcode DISPATCH and
/// the fixed per-frame/per-LED framing — but it CANNOT represent the C6's
/// soft-float arithmetic (on the host, `sin` and `add` take nearly the same
/// nanoseconds; on the FPU-less C6, `sin` is ~10× an `add`). So each opcode's
/// cost is split:
///
///   cost[op] = dispatch[op]                (MEASURED: host slope × k)
///            + softfloat[op]               (MODELED: C6 soft-float weight)
///
/// where `k = dispatch_ref_cycles / slope[anchor]` maps host ns to device
/// dispatch cycles via the anchor op (whose host time is ~pure dispatch). The
/// raw host measurements are retained in `observations` for transparency, and
/// the residual is deliberately wide (source = semihost) until an on-device or
/// cycle-accurate-emulator profile refines the arithmetic terms.
pub fn build_profile(inp: &FitInputs) -> ExecutionProfile {
    // slopes (ns/op) + per-op residuals
    let mut slopes: std::collections::BTreeMap<String, f64> = Default::default();
    let mut resid_max = 0.0f64;
    let mut anchor_slope = 0.0f64;
    for m in &inp.ops {
        let (slope, _intercept, rel) = lsq(&m.points);
        slopes.insert(m.op.clone(), slope.max(0.0));
        if rel.is_finite() {
            resid_max = resid_max.max(rel);
        }
        if m.op == ANCHOR_OP {
            anchor_slope = slope.max(0.0);
        }
    }
    // cycles-per-ns dispatch scale from the anchor op's (near-pure-dispatch) slope.
    let k = if anchor_slope > 1e-12 { inp.dispatch_ref_cycles / anchor_slope } else { 0.0 };

    // dispatch[op] = measured; cost[op] = dispatch + modeled soft-float weight.
    let mut dispatch: std::collections::BTreeMap<String, f64> = Default::default();
    let mut costs: std::collections::BTreeMap<String, f64> = Default::default();
    for (op, slope) in &slopes {
        let d = round1(slope * k);
        let arith = *inp.softfloat.get(op).unwrap_or(&0.0);
        dispatch.insert(op.clone(), d);
        costs.insert(op.clone(), round1(d + arith));
    }

    let shade_fixed = round1(inp.empty_shade_ns * k);
    let update_fixed = round1(inp.empty_update_ns * k);
    let fixed = FixedOverhead {
        update_fixed,
        shade_fixed,
        show_fixed: inp.default_show_fixed,
        show_per_led: inp.default_show_per_led,
    };

    // fallback: the measured dispatch floor (cheap unmodeled ops are ~dispatch),
    // floored at 1.
    let fallback_cost = dispatch.values().cloned().fold(f64::INFINITY, f64::min);
    let fallback_cost = if fallback_cost.is_finite() { fallback_cost.max(1.0) } else { 8.0 };

    // observations: per (op, reps) point, the MEASURED host cost (device-equiv
    // dispatch cycles) vs the model PREDICTION (dispatch + soft-float). The gap
    // is exactly the modeled soft-float the host couldn't measure.
    let mut observations = Vec::new();
    for m in &inp.ops {
        let d = *dispatch.get(&m.op).unwrap_or(&0.0);
        let cost = *costs.get(&m.op).unwrap_or(&0.0);
        for p in &m.points {
            let measured = round1(shade_fixed + (p.reps as f64) * d);
            let predicted = round1(shade_fixed + (p.reps as f64) * cost);
            observations.push(Observation {
                label: format!("{} x{}", m.op, p.reps),
                target_op: Some(m.op.clone()),
                reps: p.reps,
                led_count: 1,
                measured,
                predicted: Some(predicted),
            });
        }
    }
    observations.push(Observation {
        label: "empty shade".into(),
        target_op: None,
        reps: 0,
        led_count: 1,
        measured: shade_fixed,
        predicted: Some(shade_fixed),
    });
    observations.push(Observation {
        label: "empty update".into(),
        target_op: None,
        reps: 0,
        led_count: 1,
        measured: update_fixed,
        predicted: Some(update_fixed),
    });

    // host≠device penalty keeps the band honest (source = host, non-authoritative).
    let residual_error = round3((resid_max + 0.35).min(0.9));

    ExecutionProfile {
        kind: PROFILE_KIND.into(),
        version: PROFILE_VERSION,
        soc: inp.soc.clone(),
        source: "host".into(),
        cpu_hz: inp.cpu_hz,
        unit: "cycles".into(),
        tool_version: TOOL_VERSION.into(),
        timestamp: String::new(),
        firmware_build: None,
        device_label: Some("host".into()),
        costs,
        fixed,
        fallback_cost: round1(fallback_cost),
        residual_error,
        budget: inp.budget.clone(),
        observations,
    }
}

fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}
fn round3(x: f64) -> f64 {
    (x * 1000.0).round() / 1000.0
}

impl Default for BudgetModel {
    fn default() -> Self {
        BudgetModel { fps: 30.0, cpu_available_fraction: 0.85, transmit_reserves_cpu: false }
    }
}
