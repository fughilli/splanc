//! Micro-benchmark for the OSC ingest path: by-name vs by-slot per-packet cost,
//! plus the one-time manifest→table build (FUG-121, for Kevin's "measure both").
//!
//! Run on the host (`bazel run //firmware/osc:osc_bench`). The ABSOLUTE numbers
//! are host-CPU, not the C6 — the portable signal is the RATIO between the name
//! and slot legs and the ratio of both to a frame budget. Ingest runs in its own
//! UDP task off the render loop, so neither leg touches the per-frame path; this
//! quantifies the ingest cost itself. On-device cycle counts come from the HITL
//! rig separately.

use std::time::Instant;

use ledmapper_osc::{ingest, parse_manifest, Config, Shadow};

/// A representative manifest: 8 scalar sliders + a colour + a vec2 (10 uniforms).
fn manifest() -> String {
    let mut s = String::from("[");
    for i in 0..8 {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&format!(
            "{{\"name\":\"param{i}\",\"slot\":{i},\"width\":1,\"ui\":{{\"kind\":\"slider\",\"min\":0,\"max\":1,\"step\":0}},\"default\":[0.5]}}"
        ));
    }
    s.push_str(",{\"name\":\"tint\",\"slot\":8,\"width\":3,\"ui\":{\"kind\":\"color\"},\"default\":[1,0,0]}");
    s.push_str(",{\"name\":\"center\",\"slot\":11,\"width\":2,\"ui\":{\"kind\":\"slider\",\"min\":0,\"max\":1,\"step\":0},\"default\":[0,0]}");
    s.push(']');
    s
}

fn osc_str(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    while v.len() % 4 != 0 {
        v.push(0);
    }
    v
}

fn osc_msg(addr: &str, val: f32) -> Vec<u8> {
    let mut v = osc_str(addr);
    v.extend(osc_str(",f"));
    v.extend_from_slice(&val.to_be_bytes());
    v
}

fn time<F: FnMut()>(iters: u32, mut f: F) -> f64 {
    let t = Instant::now();
    for _ in 0..iters {
        f();
    }
    t.elapsed().as_nanos() as f64 / iters as f64
}

fn main() {
    let json = manifest();
    let iters = 2_000_000u32;

    // (1) One-time table build at effect activation.
    let build_ns = time(iters / 10, || {
        std::hint::black_box(parse_manifest(std::hint::black_box(json.as_bytes())));
    });
    let table = parse_manifest(json.as_bytes());
    println!("manifest: {} bytes, {} uniforms", json.len(), table.len());
    println!("parse_manifest (once per effect load): {build_ns:.1} ns");

    // Worst case for a name scan: the LAST scalar in the table.
    let pkt_name = osc_msg("/param7", 0.9);
    // Equivalent slot-index packet (address IS the slot number).
    let pkt_slot = osc_msg("/7", 0.9);

    let cfg_name = Config { prefix: "/", by_name: true };
    let cfg_slot = Config { prefix: "/", by_name: false };

    let mut shadow = Shadow::new();
    let name_ns = time(iters, || {
        let n = ingest(std::hint::black_box(&pkt_name), &cfg_name, &table, &mut shadow, &mut |_, _| {});
        std::hint::black_box(n);
    });
    let slot_ns = time(iters, || {
        let n = ingest(std::hint::black_box(&pkt_slot), &cfg_slot, &table, &mut shadow, &mut |_, _| {});
        std::hint::black_box(n);
    });

    println!("ingest by-name (worst-case last uniform): {name_ns:.1} ns/packet");
    println!("ingest by-slot (index parse):             {slot_ns:.1} ns/packet");
    println!("by-name overhead vs by-slot: {:+.1} ns ({:.2}x)", name_ns - slot_ns, name_ns / slot_ns);

    // Frame budget context: the render loop runs at ~30 FPS (33 ms/frame). Show
    // how many packets' worth of ingest cost that budget could absorb — even
    // though ingest is off the render task entirely.
    let frame_ns = 33_000_000.0;
    println!(
        "context: one 33 ms frame budget = {:.0}k by-name ingests; a knob at 200 Hz spends {:.4}% of a core",
        frame_ns / name_ns / 1000.0,
        name_ns * 200.0 / 1_000_000_000.0 * 100.0
    );
}
