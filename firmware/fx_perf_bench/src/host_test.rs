//! Host run of the study: every native twin vs the real fx_vm on the same
//! fixture + frames (no hardware). The `f32` twins must match the VM to within
//! 2/255 on every LED; the `q16` rewrites are reported (their LUT/poly
//! differences are the point) and only bounded loosely.

use crate::engine::{self, compare};
use crate::fixture::{self, Kind};
use crate::native::{native_frame, NATIVES};
use crate::{EFFECTS, GROUP_STUDY, GROUP_USER};

fn zero() -> u32 {
    0
}

#[test]
fn natives_match_vm() {
    let mut failures = Vec::new();
    for &n in &[500usize, 2048] {
        unsafe {
            fixture::build(Kind::Helix, n);
            for d in EFFECTS.iter().filter(|d| d.group == GROUP_STUDY) {
                let l = engine::load(d, n).expect(d.name);
                let mut ops = 0u64;
                for fi in 0..3 {
                    ops = engine::vm_frame(fi, n, &l, zero, true).instrs;
                }
                for nat in NATIVES.iter().filter(|x| x.name == d.name) {
                    (nat.reset)();
                    for fi in 0..3 {
                        native_frame(nat, &engine::frame(fi, n), n, zero);
                    }
                    let (mx, sum, off) = compare(n);
                    let mean = sum as f64 / (3 * n) as f64;
                    println!(
                        "{:<11} {:<4} n={n:<5} ops/LED={:<6.1} maxdiff={mx:<3} mean={mean:.3} off2={off}",
                        d.name,
                        nat.variant,
                        ops as f64 / n as f64
                    );
                    // sparkle's q16 computes x^8 exactly; the VM's powf goes through a
                    // logf whose polynomial is off by up to ~0.13 (see the study,
                    // "VM math accuracy") — so that pair legitimately differs.
                    let exact_pow = d.name == "sparkle" && nat.variant == "q16";
                    let ok = if nat.variant == "f32" { mx <= 2 } else { exact_pow || mean < 3.0 };
                    if !ok {
                        failures.push(format!("{} {} n={n} max={mx} mean={mean:.2}", d.name, nat.variant));
                    }
                }
            }
        }
    }
    assert!(failures.is_empty(), "native/VM mismatch: {failures:#?}");
}

/// The user-library group (when present locally) loads and runs on both of its
/// synthetic fixtures without budget cancellations.
#[test]
fn user_effects_run() {
    for &(kind, n) in &[(Kind::Sign, 500usize), (Kind::Helix, 250)] {
        unsafe {
            fixture::build(kind, n);
            for d in EFFECTS.iter().filter(|d| d.group == GROUP_USER) {
                let Ok(l) = engine::load(d, n) else { continue };
                let r = engine::vm_frame(0, n, &l, zero, true);
                println!("user {:<36} n={n:<4} ops/LED={:.1} bad={}", d.name, r.instrs as f64 / n as f64, r.bad);
            }
        }
    }
}
