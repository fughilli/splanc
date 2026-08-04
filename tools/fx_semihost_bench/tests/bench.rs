//! Deterministic tests for the semihost benchmark core: the micro-programs
//! parse + run on the real VM, the least-squares fit recovers a known slope,
//! and the emitted profile round-trips through the common JSON format with the
//! expected key shape (pinning the cross-language contract with
//! web/src/effects/executionProfile.ts).

use fx_semihost_bench::*;
use ledmapper_fx_vm::{Frame, Led, Program, Vm};

#[test]
fn micro_programs_parse_and_run() {
    let frame = Frame { led_count: 4, ..Default::default() };
    let led = Led { pos: [0.3, 0.4, 0.5], ..Default::default() };
    for &op in BENCH_OPS {
        for &reps in REP_POINTS {
            let bp = build_op_program(op, reps, 4);
            let prog = Program::parse(&bp.bytecode)
                .unwrap_or_else(|_| panic!("{op} x{reps} must parse"));
            let vm = Vm::new();
            // must produce a color without panicking (bounded budget covers it).
            let _rgb = vm.run_shade(&prog, &frame, &led);
        }
    }
    // overhead programs parse + run too.
    let es = build_empty_shade(4);
    let prog = Program::parse(&es.bytecode).expect("empty shade parses");
    let vm = Vm::new();
    assert_eq!(vm.run_shade(&prog, &frame, &led), (0, 0, 0), "empty shade is black");

    let eu = build_empty_update();
    let prog = Program::parse(&eu.bytecode).expect("empty update parses");
    let mut vm = Vm::new();
    vm.run_update(&prog, &frame); // must not panic
}

#[test]
fn lsq_recovers_known_slope() {
    // ns = 10 + 3*reps exactly → slope 3, intercept 10, ~0 residual.
    let pts = vec![
        Point { reps: 32, ns: 10.0 + 3.0 * 32.0 },
        Point { reps: 64, ns: 10.0 + 3.0 * 64.0 },
        Point { reps: 96, ns: 10.0 + 3.0 * 96.0 },
    ];
    let (slope, intercept, resid) = lsq(&pts);
    assert!((slope - 3.0).abs() < 1e-9, "slope {slope}");
    assert!((intercept - 10.0).abs() < 1e-6, "intercept {intercept}");
    assert!(resid < 1e-9, "clean data → ~0 residual, got {resid}");
}

/// Modeled soft-float weights used by the synthetic fit (mirror main.rs).
fn synthetic_softfloat() -> std::collections::BTreeMap<String, f64> {
    [("Add", 10.0), ("Mul", 12.0), ("Div", 40.0), ("UnMath", 110.0), ("BinMath", 120.0), ("Hash1", 50.0)]
        .iter()
        .map(|(k, v)| (k.to_string(), *v))
        .collect()
}

/// Build a synthetic FitInputs where each op has a known host ns/op, so the fit
/// is deterministic and testable without wall-clock timing. The host slopes are
/// deliberately near-flat across ops (as a real hardware-FPU host measures):
/// the float-cost structure must come from the modeled soft-float weights, not
/// the host slopes.
fn synthetic_inputs() -> FitInputs {
    // host ns/op ≈ pure dispatch (~2ns) for every op — the FPU makes them alike.
    let host_dispatch_ns = 2.0;
    let ops = ["Add", "Mul", "Div", "UnMath", "BinMath", "Hash1"]
        .iter()
        .map(|op| OpMeasurement {
            op: (*op).to_string(),
            points: REP_POINTS
                .iter()
                .map(|&r| Point { reps: r, ns: 20.0 + host_dispatch_ns * (r as f64) })
                .collect(),
        })
        .collect();
    FitInputs {
        ops,
        empty_shade_ns: 20.0,
        empty_update_ns: 50.0,
        soc: "esp32c6".into(),
        cpu_hz: 160_000_000.0,
        dispatch_ref_cycles: 6.0,
        softfloat: synthetic_softfloat(),
        default_show_fixed: 40_000.0,
        default_show_per_led: 480.0,
        budget: BudgetModel::default(),
    }
}

#[test]
fn fit_splits_dispatch_and_softfloat() {
    let p = build_profile(&synthetic_inputs());
    // Anchor slope 2ns → k = 6/2 = 3 cycles/ns; every op's dispatch = 2*3 = 6.
    // cost[op] = dispatch(6) + softfloat[op].
    assert!((p.costs["Add"] - 16.0).abs() < 0.2, "Add = 6 + 10, got {}", p.costs["Add"]);
    assert!((p.costs["Div"] - 46.0).abs() < 0.2, "Div = 6 + 40, got {}", p.costs["Div"]);
    // Even though the host measured every op the SAME, the modeled soft-float
    // restores the C6 economics: transcendentals ≫ add.
    assert!(p.costs["UnMath"] > p.costs["Add"] * 5.0, "UnMath ≫ Add (soft-float)");
    assert!(p.costs["BinMath"] > p.costs["Mul"], "BinMath ≫ Mul");
    // fixed overheads are measured: shade_fixed = 20ns * 3 = 60 cycles.
    assert!((p.fixed.shade_fixed - 60.0).abs() < 0.2, "shade_fixed measured, got {}", p.fixed.shade_fixed);
    // show model carries the host-unmeasurable defaults.
    assert_eq!(p.fixed.show_per_led, 480.0);
    // semihost profiles are honestly wide.
    assert!(p.residual_error >= 0.35, "semihost residual wide, got {}", p.residual_error);
    assert_eq!(p.source, "semihost");
}

#[test]
fn profile_round_trips_json_with_expected_keys() {
    let p = build_profile(&synthetic_inputs());
    let json = p.to_json();
    // top-level keys the web parser (executionProfile.ts) requires, in the
    // exact camelCase the format specifies.
    for key in [
        "\"kind\"",
        "\"version\"",
        "\"soc\"",
        "\"source\"",
        "\"cpuHz\"",
        "\"unit\"",
        "\"toolVersion\"",
        "\"fallbackCost\"",
        "\"residualError\"",
        "\"budget\"",
        "\"observations\"",
    ] {
        assert!(json.contains(key), "profile JSON missing {key}");
    }
    // fixed uses snake_case to match the TS FixedOverhead.
    assert!(json.contains("\"show_per_led\""), "fixed keeps snake_case");
    // budget uses camelCase.
    assert!(json.contains("\"cpuAvailableFraction\""), "budget camelCase");
    // observation field casing.
    assert!(json.contains("\"targetOp\""), "observation camelCase");

    // deserialize back to an equal profile.
    let back: ExecutionProfile = serde_json::from_str(&json).expect("round-trips");
    assert_eq!(back, p);
}
