//! Host tests for the on-device OSC logic: wire parsing, manifest scanning, and
//! end-to-end ingest against a recording sink. These pin the exact byte-level
//! behaviour the firmware relies on (the crate itself is `no_std`).

use ledmapper_osc::{
    for_each_message, ingest, parse_manifest, Config, OscArg, PortTable, Shadow,
};

/// Build a null-terminated, 4-byte-padded OSC-string.
fn ostr(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    while v.len() % 4 != 0 {
        v.push(0);
    }
    v
}

/// Build an OSC message `addr ,<tags> <body>`.
fn msg(addr: &str, tags: &str, body: &[u8]) -> Vec<u8> {
    let mut v = ostr(addr);
    v.extend(ostr(&format!(",{tags}")));
    v.extend_from_slice(body);
    v
}

fn one(data: &[u8]) -> (String, Vec<OscArg>) {
    let mut out = None;
    assert!(for_each_message(data, &mut |m| {
        out = Some((m.addr.to_string(), m.args().to_vec()));
    }));
    out.expect("a message")
}

// --- wire parsing ---------------------------------------------------------

#[test]
fn parses_float_int_bools() {
    let (a, args) = one(&msg("/speed", "f", &2.5f32.to_be_bytes()));
    assert_eq!(a, "/speed");
    assert_eq!(args, vec![OscArg::Float(2.5)]);

    let (_, args) = one(&msg("/mix", "iTF", &7i32.to_be_bytes()));
    assert_eq!(args, vec![OscArg::Int(7), OscArg::Bool(true), OscArg::Bool(false)]);
    assert_eq!(args[0].as_f32(), Some(7.0));
    assert_eq!(args[1].as_f32(), Some(1.0));
    assert_eq!(args[2].as_f32(), Some(0.0));
}

#[test]
fn skips_string_but_keeps_alignment() {
    let mut v = ostr("/named");
    v.extend(ostr(",sf"));
    v.extend(ostr("label"));
    v.extend_from_slice(&1.25f32.to_be_bytes());
    let (_, args) = one(&v);
    assert_eq!(args.len(), 2);
    assert_eq!(args[0], OscArg::Other);
    assert_eq!(args[1].as_f32(), Some(1.25));
}

#[test]
fn flattens_a_bundle() {
    let a = msg("/tint/x", "f", &1.0f32.to_be_bytes());
    let b = msg("/tint/y", "f", &0.5f32.to_be_bytes());
    let mut pkt = b"#bundle\0".to_vec();
    pkt.extend_from_slice(&1u64.to_be_bytes());
    pkt.extend_from_slice(&(a.len() as i32).to_be_bytes());
    pkt.extend_from_slice(&a);
    pkt.extend_from_slice(&(b.len() as i32).to_be_bytes());
    pkt.extend_from_slice(&b);
    let mut addrs = Vec::new();
    assert!(for_each_message(&pkt, &mut |m| addrs.push(m.addr.to_string())));
    assert_eq!(addrs, vec!["/tint/x", "/tint/y"]);
}

#[test]
fn rejects_garbage() {
    assert!(!for_each_message(b"nope", &mut |_| {}));
    assert!(!for_each_message(&[], &mut |_| {}));
    // truncated float arg
    let mut v = ostr("/x");
    v.extend(ostr(",f"));
    v.extend_from_slice(&[0, 0]);
    assert!(!for_each_message(&v, &mut |_| {}));
}

// --- manifest scanning ----------------------------------------------------

const MANIFEST: &str = r#"[
    {"name":"speed","slot":0,"width":1,"ui":{"kind":"slider","min":0,"max":5,"step":0},"default":[1.0]},
    {"name":"tint","slot":3,"width":3,"ui":{"kind":"color"},"default":[1,0,0]},
    {"name":"mirror","slot":7,"width":1,"ui":{"kind":"toggle"},"default":[0]}
]"#;

#[test]
fn parses_manifest_names_slots_widths() {
    let t = parse_manifest(MANIFEST.as_bytes());
    assert_eq!(t.len(), 3);
    let speed = t.resolve("speed").unwrap();
    assert_eq!((speed.slot, speed.width), (0, 1));
    let tint = t.resolve("tint").unwrap();
    assert_eq!((tint.slot, tint.width), (3, 3));
    let mirror = t.resolve("mirror").unwrap();
    assert_eq!((mirror.slot, mirror.width), (7, 1));
    assert!(t.resolve("nope").is_none());
}

#[test]
fn empty_or_bad_manifest_is_empty() {
    assert!(parse_manifest(b"").is_empty());
    assert!(parse_manifest(b"[]").is_empty());
    assert!(parse_manifest(b"garbage").is_empty());
}

// --- ingest ---------------------------------------------------------------

#[test]
fn drives_scalar_by_name() {
    let table = parse_manifest(MANIFEST.as_bytes());
    let mut shadow = Shadow::new();
    let cfg = Config { prefix: "/", by_name: true };
    let mut writes: Vec<(u16, Vec<f32>)> = Vec::new();
    let n = ingest(
        &msg("/speed", "f", &2.5f32.to_be_bytes()),
        &cfg,
        &table,
        &mut shadow,
        &mut |slot, vals| writes.push((slot, vals.to_vec())),
    );
    assert_eq!(n, 1);
    assert_eq!(writes, vec![(0, vec![2.5])]);
}

#[test]
fn per_axis_vector_components_accumulate() {
    let table = parse_manifest(MANIFEST.as_bytes());
    let mut shadow = Shadow::new();
    let cfg = Config { prefix: "/", by_name: true };
    let mut writes: Vec<(u16, Vec<f32>)> = Vec::new();
    let mut sink = |slot: u16, vals: &[f32]| writes.push((slot, vals.to_vec()));

    ingest(&msg("/tint/x", "f", &1.0f32.to_be_bytes()), &cfg, &table, &mut shadow, &mut sink);
    ingest(&msg("/tint/z", "f", &0.5f32.to_be_bytes()), &cfg, &table, &mut shadow, &mut sink);

    // Each component write re-sends the whole width-3 vector; the last one has
    // x from the first message, z from the second, y still 0.
    assert_eq!(writes.last().unwrap(), &(3, vec![1.0, 0.0, 0.5]));
}

#[test]
fn whole_vector_in_one_message() {
    let table = parse_manifest(MANIFEST.as_bytes());
    let mut shadow = Shadow::new();
    let cfg = Config { prefix: "/", by_name: true };
    let mut body = Vec::new();
    for v in [0.2f32, 0.4, 0.6] {
        body.extend_from_slice(&v.to_be_bytes());
    }
    let mut writes: Vec<(u16, Vec<f32>)> = Vec::new();
    ingest(
        &msg("/tint", "fff", &body),
        &cfg,
        &table,
        &mut shadow,
        &mut |slot, vals| writes.push((slot, vals.to_vec())),
    );
    assert_eq!(writes, vec![(3, vec![0.2, 0.4, 0.6])]);
}

#[test]
fn unknown_name_is_dropped_in_named_mode() {
    let table = parse_manifest(MANIFEST.as_bytes());
    let mut shadow = Shadow::new();
    let cfg = Config { prefix: "/", by_name: true };
    let n = ingest(
        &msg("/nonexistent", "f", &1.0f32.to_be_bytes()),
        &cfg,
        &table,
        &mut shadow,
        &mut |_, _| panic!("should not write"),
    );
    assert_eq!(n, 0);
}

#[test]
fn slot_index_mode_ignores_names() {
    // No manifest / by_name=false: the address is the raw slot number.
    let table = PortTable::empty();
    let mut shadow = Shadow::new();
    let cfg = Config { prefix: "/", by_name: false };
    let mut writes: Vec<(u16, Vec<f32>)> = Vec::new();
    let mut sink = |slot: u16, vals: &[f32]| writes.push((slot, vals.to_vec()));

    ingest(&msg("/5", "f", &0.9f32.to_be_bytes()), &cfg, &table, &mut shadow, &mut sink);
    ingest(&msg("/slot2", "f", &0.1f32.to_be_bytes()), &cfg, &table, &mut shadow, &mut sink);
    assert_eq!(writes, vec![(5, vec![0.9]), (2, vec![0.1])]);
}

#[test]
fn prefix_is_stripped() {
    let table = parse_manifest(MANIFEST.as_bytes());
    let mut shadow = Shadow::new();
    let cfg = Config { prefix: "/uniform/", by_name: true };
    let mut writes: Vec<(u16, Vec<f32>)> = Vec::new();
    let n = ingest(
        &msg("/uniform/speed", "f", &3.0f32.to_be_bytes()),
        &cfg,
        &table,
        &mut shadow,
        &mut |slot, vals| writes.push((slot, vals.to_vec())),
    );
    assert_eq!(n, 1);
    assert_eq!(writes, vec![(0, vec![3.0])]);
}
