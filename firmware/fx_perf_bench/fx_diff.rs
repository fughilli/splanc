//! Host tool: render two effects over the same synthetic fixture and frames
//! through the real fx_vm and report how different they look — used to check
//! that a hand-optimised rewrite keeps the original's look
//! (docs/design/fx-perf-study.md). Also prints each one's opcodes/LED.
//!
//!   fx_diff [--fixture sign|helix|linear] [--leds N] [--frames F] a.fx b.fx
use fx_perf_bench::engine::{self, OUT_VM};
use fx_perf_bench::fixture::{self, Kind};
use fx_perf_bench::EffectDesc;

fn desc(path: &str) -> &'static EffectDesc {
    let src = std::fs::read_to_string(path).expect("read");
    let c = ledmapper_fx_compiler::compile(&src).unwrap_or_else(|e| panic!("{path}: {e:?}"));
    let uniforms: Vec<(u8, &'static [f32])> =
        c.uniforms.iter().map(|u| (u.slot, &*Box::leak(u.default.clone().into_boxed_slice()))).collect();
    Box::leak(Box::new(EffectDesc {
        name: Box::leak(path.to_string().into_boxed_str()),
        group: 0,
        leds: 0,
        opt: true,
        fxb: Box::leak(c.fxb.into_boxed_slice()),
        uniforms: Box::leak(uniforms.into_boxed_slice()),
        err: "",
    }))
}

fn zero() -> u32 {
    0
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mut kind = Kind::Sign;
    let mut n = 500usize;
    let mut frames = 90u32;
    let mut files = Vec::new();
    let mut i = 1;
    while i < a.len() {
        match a[i].as_str() {
            "--fixture" => {
                kind = match a[i + 1].as_str() {
                    "helix" => Kind::Helix,
                    "linear" => Kind::Linear,
                    _ => Kind::Sign,
                };
                i += 1;
            }
            "--leds" => {
                n = a[i + 1].parse().unwrap();
                i += 1;
            }
            "--frames" => {
                frames = a[i + 1].parse().unwrap();
                i += 1;
            }
            f => files.push(f.to_string()),
        }
        i += 1;
    }
    let (da, db) = (desc(&files[0]), desc(&files[1]));
    unsafe {
        fixture::build(kind, n);
        let la = engine::load(da, n).unwrap();
        let mut outs_a = Vec::new();
        let mut ops_a = 0u64;
        for f in 0..frames {
            ops_a += engine::vm_frame(f, n, &la, zero, true).instrs;
            outs_a.push((*core::ptr::addr_of!(OUT_VM))[..n].to_vec());
        }
        let lb = engine::load(db, n).unwrap();
        let (mut sum, mut mx, mut off, mut ops_b) = (0u64, 0u32, 0u64, 0u64);
        for f in 0..frames {
            ops_b += engine::vm_frame(f, n, &lb, zero, true).instrs;
            let ob = &(*core::ptr::addr_of!(OUT_VM))[..n];
            for (x, y) in outs_a[f as usize].iter().zip(ob) {
                let d = [(x.0 as i32 - y.0 as i32).abs(), (x.1 as i32 - y.1 as i32).abs(), (x.2 as i32 - y.2 as i32).abs()];
                let m = *d.iter().max().unwrap() as u32;
                mx = mx.max(m);
                sum += (d[0] + d[1] + d[2]) as u64;
                if m > 8 {
                    off += 1;
                }
            }
        }
        let cnt = (frames as u64) * n as u64;
        println!(
            "mean_abs_diff={:.2} max={} leds_off_by_gt8={:.1}% ops_per_led a={:.1} b={:.1}",
            sum as f64 / (3 * cnt) as f64,
            mx,
            100.0 * off as f64 / cnt as f64,
            ops_a as f64 / cnt as f64,
            ops_b as f64 / cnt as f64
        );
    }
}
