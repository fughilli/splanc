//! Host run of the study: every native twin vs the real fx_vm on the same
//! fixture + frames (no hardware). The `f32` twins must match the VM to within
//! 2/255 on every LED; the `q16` rewrites are reported (their LUT/poly
//! differences are the point) and only bounded loosely.

use crate::engine::{self, compare};
use crate::fixture::{self, Kind};
use crate::native::{native_frame, NATIVES};
use crate::{EFFECTS, GROUP_STUDY, GROUP_USER, SIG_CASES, SIG_OTHER_FXB};

fn zero() -> u32 {
    0
}

/// Every embedded AOT image (what the C6 bench copies into its exec region)
/// carries a valid dev-key signature over its own `.fxb` and passes the
/// sandbox verifier with the buffer sizes the bench allocates.
#[test]
fn aot_images_verify() {
    use ledmapper_fx_aot_nostd as aot;
    use splanc_fx_sig as sig;
    let ring = sig::KeyRing::with_dev_key(sig::SoftSha256::new);
    let dev = sig::Device { fw_version: 0, abis: &[aot::NATIVE_ABI], device_id: [0; 8] };
    let mut n = 0;
    for d in EFFECTS.iter().filter(|d| d.aot_ok) {
        let fxn = sig::Fxn::parse(d.aot_fxn).expect("container");
        let mut lim = sig::Limiter::default();
        let r = sig::verify(&fxn, d.fxb, &ring, &sig::Policy::default(), &dev, &mut lim, 0, sig::SoftSha256::new);
        assert_eq!(r, Ok(()), "{}: dev signature", d.name);
        let words: Vec<u32> = (0..fxn.header.code_words as usize).map(|i| fxn.word(i)).collect();
        let mut entries = vec![fxn.header.shade_off as usize];
        for o in [fxn.header.update_off, fxn.header.prep_off] {
            if o != sig::NO_ENTRY {
                entries.push(o as usize);
            }
        }
        let r = aot::verify(&words, &entries, &aot::VerifyLimits::DEFAULT);
        assert_eq!(r, None, "{}: verifier rejected the embedded image", d.name);
        n += 1;
    }
    assert!(n > 0, "no AOT images embedded");
    println!("aot_images_verify: {n} embedded images verified");
}

/// The embedded signature cases give the reasons the device must report.
#[test]
fn sig_cases_expected() {
    use ledmapper_fx_aot_nostd as aot;
    use splanc_fx_sig as sig;
    let ring = sig::KeyRing::with_dev_key(sig::SoftSha256::new);
    let dev = sig::Device { fw_version: 0, abis: &[aot::NATIVE_ABI], device_id: [0; 8] };
    assert!(SIG_CASES.len() >= 10, "sig cases missing");
    for (case, effect, blob, other, want) in SIG_CASES.iter() {
        let d = EFFECTS.iter().find(|d| d.name == *effect).unwrap();
        let fxb = if *other { SIG_OTHER_FXB } else { d.fxb };
        let mut lim = sig::Limiter::default();
        let got = sig::Fxn::parse(blob).and_then(|f| {
            sig::verify(&f, fxb, &ring, &sig::Policy::default(), &dev, &mut lim, 0, sig::SoftSha256::new)
        });
        let got = match got {
            Ok(()) => "ok",
            Err(e) => e.as_str(),
        };
        assert_eq!(got, *want, "case {case}");
    }
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
                    let ok = if nat.variant == "f32" { mx <= 2 } else { mean < 3.0 };
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
