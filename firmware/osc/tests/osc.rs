//! Host tests for the on-device OSC logic: wire parsing, manifest scanning, and
//! end-to-end ingest against a recording sink. These pin the exact byte-level
//! behaviour the firmware relies on (the crate itself is `no_std`).

use ledmapper_osc::{
    for_each_message, ingest, parse_manifest, Config, Mailbox, OscArg, PortTable, MAX_WIDTH,
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
    let cfg = Config { prefix: "/", by_name: true };
    let mut writes: Vec<(u16, Vec<f32>)> = Vec::new();
    let n = ingest(
        &msg("/speed", "f", &2.5f32.to_be_bytes()),
        &cfg,
        &table,
        &mut |slot, vals| writes.push((slot, vals.to_vec())),
    );
    assert_eq!(n, 1);
    assert_eq!(writes, vec![(0, vec![2.5])]);
}

#[test]
fn per_axis_vector_components_accumulate() {
    let table = parse_manifest(MANIFEST.as_bytes());
    let cfg = Config { prefix: "/", by_name: true };
    let mut writes: Vec<(u16, Vec<f32>)> = Vec::new();
    let mut sink = |slot: u16, vals: &[f32]| writes.push((slot, vals.to_vec()));

    ingest(&msg("/tint/x", "f", &1.0f32.to_be_bytes()), &cfg, &table, &mut sink);
    ingest(&msg("/tint/z", "f", &0.5f32.to_be_bytes()), &cfg, &table, &mut sink);

    // Each component message writes exactly that component (at its own slot),
    // so the others keep whatever the VM holds — never zeroed.
    assert_eq!(writes, vec![(3, vec![1.0]), (5, vec![0.5])]);
}

#[test]
fn whole_vector_in_one_message() {
    let table = parse_manifest(MANIFEST.as_bytes());
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
        &mut |slot, vals| writes.push((slot, vals.to_vec())),
    );
    assert_eq!(writes, vec![(3, vec![0.2, 0.4, 0.6])]);
}

#[test]
fn unknown_name_is_dropped_in_named_mode() {
    let table = parse_manifest(MANIFEST.as_bytes());
    let cfg = Config { prefix: "/", by_name: true };
    let n = ingest(
        &msg("/nonexistent", "f", &1.0f32.to_be_bytes()),
        &cfg,
        &table,
        &mut |_, _| panic!("should not write"),
    );
    assert_eq!(n, 0);
}

#[test]
fn slot_index_mode_ignores_names() {
    // No manifest / by_name=false: the address is the raw slot number.
    let table = PortTable::empty();
    let cfg = Config { prefix: "/", by_name: false };
    let mut writes: Vec<(u16, Vec<f32>)> = Vec::new();
    let mut sink = |slot: u16, vals: &[f32]| writes.push((slot, vals.to_vec()));

    ingest(&msg("/5", "f", &0.9f32.to_be_bytes()), &cfg, &table, &mut sink);
    ingest(&msg("/slot2", "f", &0.1f32.to_be_bytes()), &cfg, &table, &mut sink);
    assert_eq!(writes, vec![(5, vec![0.9]), (2, vec![0.1])]);
}

#[test]
fn prefix_is_stripped() {
    let table = parse_manifest(MANIFEST.as_bytes());
    let cfg = Config { prefix: "/uniform/", by_name: true };
    let mut writes: Vec<(u16, Vec<f32>)> = Vec::new();
    let n = ingest(
        &msg("/uniform/speed", "f", &3.0f32.to_be_bytes()),
        &cfg,
        &table,
        &mut |slot, vals| writes.push((slot, vals.to_vec())),
    );
    assert_eq!(n, 1);
    assert_eq!(writes, vec![(0, vec![3.0])]);
}

// --- latest-wins mailbox (netstack OSC) -------------------------------------

fn bundle(elems: &[Vec<u8>]) -> Vec<u8> {
    let mut v = ostr("#bundle");
    v.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 1]);
    for e in elems {
        v.extend_from_slice(&(e.len() as i32).to_be_bytes());
        v.extend_from_slice(e);
    }
    v
}

#[test]
fn mailbox_keeps_the_latest_value_per_address() {
    let table = parse_manifest(MANIFEST.as_bytes());
    let cfg = Config { prefix: "/", by_name: true };
    let mut mb: Mailbox<4> = Mailbox::new();
    for i in 0..50 {
        assert_eq!(mb.post(&msg("/speed", "f", &(i as f32).to_be_bytes())), 1);
    }
    // A bundle with two addresses (one already waiting).
    let b = bundle(&[msg("/speed", "f", &99f32.to_be_bytes()), msg("/tint/y", "f", &0.5f32.to_be_bytes())]);
    assert_eq!(mb.post(&b), 2);
    assert_eq!(mb.len(), 2);
    assert_eq!(mb.coalesced, 50);
    let mut writes = Vec::new();
    let n = mb.drain(&cfg, &table, &mut |slot, v| writes.push((slot, v.to_vec())));
    assert_eq!(n, 2);
    let speed = table.resolve("speed").unwrap().slot;
    assert_eq!(writes[0], (speed, vec![99.0]), "one write, the newest value");
    assert!(mb.is_empty(), "drained");
    assert_eq!(mb.drain(&cfg, &table, &mut |_, _| panic!("nothing waits")), 0);
}

#[test]
fn mailbox_bounds_and_garbage() {
    let mut mb: Mailbox<2> = Mailbox::new();
    assert_eq!(mb.post(b"garbage"), 0);
    mb.post(&msg("/a", "f", &1f32.to_be_bytes()));
    mb.post(&msg("/b", "f", &1f32.to_be_bytes()));
    assert_eq!(mb.post(&msg("/c", "f", &1f32.to_be_bytes())), 0, "full: a new address is dropped");
    let long = format!("/{}", "x".repeat(60));
    assert_eq!(mb.post(&msg(&long, "f", &1f32.to_be_bytes())), 0);
    assert_eq!(mb.dropped, 2);
    mb.clear();
    assert!(mb.is_empty());
}

#[test]
fn mailbox_flattens_one_bundle_level_only() {
    // The network-task path is iterative: a nested bundle is skipped, its
    // sibling message kept.
    let inner = bundle(&[msg("/a", "f", &1f32.to_be_bytes())]);
    let outer = bundle(&[inner, msg("/b", "f", &2f32.to_be_bytes())]);
    let mut mb: Mailbox<4> = Mailbox::new();
    assert_eq!(mb.post(&outer), 1);
    assert_eq!(mb.len(), 1);
}

#[test]
fn mailbox_is_compact_and_zero_initialised() {
    // The firmware binds the mailbox into a fresh heap block on the first OSC
    // datagram (static RAM would shrink board.max_leds): keep it small, and an
    // all-zero block must read as empty.
    assert!(std::mem::size_of::<Mailbox<12>>() <= 12 * 60 + 8, "{}", std::mem::size_of::<Mailbox<12>>());
    let mb: Mailbox<12> = unsafe { std::mem::zeroed() };
    assert!(mb.is_empty());
    let mut mb = mb;
    mb.post(&msg("/speed", "i", &7i32.to_be_bytes()));
    assert_eq!(mb.len(), 1);
}

// --- wide uniforms: mat3/mat4 + signed vec4 (#400) ----------------------------

const WIDE: &str = r#"[
    {"name":"plane","slot":0,"width":4,"ui":{"kind":"slider","min":-5,"max":5,"step":0.1},"default":[0,1,0,0],"min":-5,"max":5},
    {"name":"pose","slot":4,"width":16,"ui":{"kind":"matrix","min":-1000,"max":1000},"default":[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1],"min":-1000,"max":1000},
    {"name":"rot","slot":20,"width":9,"ui":{"kind":"matrix","min":-1,"max":1},"default":[1,0,0,0,1,0,0,0,1],"min":-1,"max":1},
    {"name":"width","slot":29,"width":1,"ui":{"kind":"slider","min":0,"max":1,"step":0.01},"default":[0.1],"min":0,"max":1}
]"#;

fn floats(vals: &[f32]) -> (String, Vec<u8>) {
    let mut body = Vec::new();
    for v in vals {
        body.extend_from_slice(&v.to_be_bytes());
    }
    ("f".repeat(vals.len()), body)
}

fn fmsg(addr: &str, vals: &[f32]) -> Vec<u8> {
    let (tags, body) = floats(vals);
    msg(addr, &tags, &body)
}

fn run(data: &[u8], cfg: &Config) -> Vec<(u16, Vec<f32>)> {
    let table = parse_manifest(WIDE.as_bytes());
    let mut w = Vec::new();
    ingest(data, cfg, &table, &mut |slot, v| w.push((slot, v.to_vec())));
    w
}

const NAMED: Config = Config { prefix: "/", by_name: true };

#[test]
fn manifest_keeps_matrix_widths() {
    let t = parse_manifest(WIDE.as_bytes());
    assert_eq!(MAX_WIDTH, 16);
    assert_eq!(t.resolve("pose").map(|p| (p.slot, p.width)), Some((4, 16)));
    assert_eq!(t.resolve("rot").map(|p| (p.slot, p.width)), Some((20, 9)));
}

#[test]
fn signed_vec4_plane_is_one_message_as_before() {
    let w = run(&fmsg("/plane", &[0.0, -0.8, 0.6, -2.5]), &NAMED);
    assert_eq!(w, vec![(0, vec![0.0, -0.8, 0.6, -2.5])]);
    // Extra args past the width are ignored.
    let w = run(&fmsg("/plane", &[1.0, 2.0, 3.0, 4.0, 5.0]), &NAMED);
    assert_eq!(w, vec![(0, vec![1.0, 2.0, 3.0, 4.0])]);
}

#[test]
fn whole_mat4_in_one_message_column_major() {
    let m: Vec<f32> = (0..16).map(|i| i as f32 - 7.5).collect();
    let w = run(&fmsg("/pose", &m), &NAMED);
    assert_eq!(w, vec![(4, m.clone())]);
    let m3: Vec<f32> = (0..9).map(|i| -(i as f32)).collect();
    assert_eq!(run(&fmsg("/rot", &m3), &NAMED), vec![(20, m3)]);
}

#[test]
fn flat_index_and_element_addressing() {
    // /pose/12 ,fff = the translation (column 3, rows 0..2).
    assert_eq!(run(&fmsg("/pose/12", &[1.0, -2.0, 0.5]), &NAMED), vec![(16, vec![1.0, -2.0, 0.5])]);
    // Never past the width: /pose/14 with 3 args writes components 14, 15.
    assert_eq!(run(&fmsg("/pose/14", &[1.0, 2.0, 3.0]), &NAMED), vec![(18, vec![1.0, 2.0])]);
    assert!(run(&fmsg("/pose/16", &[1.0]), &NAMED).is_empty());
    // /pose/<c>/<r>: one element, column-major (c*4 + r).
    assert_eq!(run(&fmsg("/pose/3/1", &[-2.0, 9.0]), &NAMED), vec![(4 + 13, vec![-2.0])]);
    assert_eq!(run(&fmsg("/pose/3/y", &[-2.0]), &NAMED), vec![(4 + 13, vec![-2.0])]);
    assert_eq!(run(&fmsg("/rot/2/2", &[0.5]), &NAMED), vec![(20 + 8, vec![0.5])]);
    assert!(run(&fmsg("/rot/3/0", &[0.5]), &NAMED).is_empty(), "column out of range");
    assert!(run(&fmsg("/plane/1/1", &[0.5]), &NAMED).is_empty(), "element form is for matrices");
    // Flat index and axis letters on a vector.
    assert_eq!(run(&fmsg("/plane/3", &[-4.0]), &NAMED), vec![(3, vec![-4.0])]);
    assert_eq!(run(&fmsg("/plane/w", &[-4.0]), &NAMED), vec![(3, vec![-4.0])]);
    assert_eq!(run(&fmsg("/plane/1", &[0.1, 0.2]), &NAMED), vec![(1, vec![0.1, 0.2])]);
}

#[test]
fn slot_mode_takes_every_arg() {
    let cfg = Config { prefix: "/", by_name: false };
    let m: Vec<f32> = (0..16).map(|i| i as f32).collect();
    assert_eq!(run(&fmsg("/4", &m), &cfg), vec![(4, m)]);
    assert_eq!(run(&fmsg("/4/12", &[1.0, 2.0]), &cfg), vec![(16, vec![1.0, 2.0])]);
}

#[test]
fn mailbox_carries_a_whole_mat4_in_chunks() {
    let table = parse_manifest(WIDE.as_bytes());
    let mut mb: Mailbox<12> = Mailbox::new();
    let m: Vec<f32> = (0..16).map(|i| i as f32 * 0.5 - 3.0).collect();
    assert_eq!(mb.post(&fmsg("/pose", &m)), 1);
    assert_eq!(mb.len(), 4, "four 4-value chunks");
    // A newer translation replaces only the last chunk; a vec4 stays one entry.
    assert_eq!(mb.post(&fmsg("/pose/12", &[7.0, 8.0, 9.0])), 1);
    assert_eq!(mb.post(&fmsg("/plane", &[0.0, -1.0, 0.0, 2.0])), 1);
    assert_eq!(mb.len(), 5);
    let mut vm = [0.0f32; 32];
    let n = mb.drain(&NAMED, &table, &mut |slot, v| vm[slot as usize..slot as usize + v.len()].copy_from_slice(v));
    assert_eq!(n, 5);
    let mut want = m.clone();
    want[12..15].copy_from_slice(&[7.0, 8.0, 9.0]);
    // (component 15: the newer 3-value /pose/12 replaced its chunk, so it keeps
    // whatever the VM held — latest value per address.)
    assert_eq!(&vm[4..19], &want[..15]);
    assert_eq!(&vm[0..4], &[0.0, -1.0, 0.0, 2.0]);
}

#[test]
fn mailbox_drops_a_long_message_that_does_not_fit_whole() {
    let mut mb: Mailbox<4> = Mailbox::new();
    mb.post(&fmsg("/width", &[0.2]));
    let m = [1.0f32; 16];
    assert_eq!(mb.post(&fmsg("/pose", &m)), 0, "needs 4 free entries, has 3");
    assert_eq!(mb.dropped, 1);
    assert_eq!(mb.len(), 1);
    // Slot-index addresses chunk too.
    let mut mb: Mailbox<4> = Mailbox::new();
    assert_eq!(mb.post(&fmsg("/4", &m[..9])), 1);
    let mut got = Vec::new();
    let cfg = Config { prefix: "/", by_name: false };
    mb.drain(&cfg, &PortTable::empty(), &mut |slot, v| got.push((slot, v.len())));
    got.sort();
    assert_eq!(got, vec![(4, 4), (8, 4), (12, 1)]);
}
