//! Generate native images on the host for the opt-in RV32 execution test.
mod raw_cases;
use ledmapper_fx_aot::{lower, verify};
use ledmapper_fx_vm as fxv;
fn main() {
    let edges = raw_cases::EDGES;
    let mut cases = raw_cases::cases();
    for n in 1..=4 {
        // Regression coverage for the two deliberately unspecialized arms.
        cases.push((vec![fxv::Op::Scale as u8, n], n + 1, n));
        cases.push((vec![fxv::Op::Mix as u8, n], 2 * n + 1, n));
    }
    println!("const EDGES: &[u32] = &{:?};", edges);
    println!("const CASES: &[Case] = &[");
    for (op, pop, push) in cases {
        for prefix in [0u8, 7, 8, 13] {
            let bytes = raw_cases::raw_program(&op, pop, push, prefix);
            let p = fxv::Program::parse(&bytes).unwrap();
            let img = lower(&p).unwrap();
            assert_eq!(verify(&img.code), None);
            println!("Case {{ op: &{:?}, bytes: &{:?}, image: &{:?}, shade: {}, inputs: {}, outputs: {} }},",
                op, bytes, img.code, img.shade_off, prefix+pop, prefix+push);
        }
    }
    println!("];");
}
