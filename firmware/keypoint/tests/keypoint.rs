use ledmapper_keypoint::*;

const MANIFEST: &[u8] = br#"[{"name":"speed","slot":0,"width":1,"ui":{"kind":"slider","min":0,"max":4,"step":0.5},"default":[1],"min":0,"max":4,"doc":"say \"min\":99 here"},{"name":"tint","slot":1,"width":3,"ui":{"kind":"color"},"default":[1,0,0],"min":0,"max":1},{"name":"sparkle","slot":4,"width":1,"ui":{"kind":"toggle"},"default":[0],"min":0,"max":1},{"name":"mode","slot":5,"width":1,"ui":{"kind":"dropdown","options":["a","b","c"]},"default":[0],"min":0,"max":2},{"name":"drift","slot":6,"width":2,"ui":{"kind":"slider","min":-1,"max":1,"step":0},"default":[0,0],"min":-1,"max":1,"unit":"m/s"}]"#;

fn packed(vals: &[f32]) -> Packed {
    let mut p = UNSET;
    p[..vals.len()].copy_from_slice(vals);
    p
}

#[test]
fn parses_rules_in_manifest_order() {
    let r = Rules::parse(MANIFEST);
    let rs = r.rules();
    assert_eq!(rs.len(), 5);
    assert_eq!(r.floats(), 1 + 3 + 1 + 1 + 2);
    assert_eq!((rs[0].slot, rs[0].kind, rs[0].min, rs[0].max, rs[0].step), (0, Kind::Slider, 0.0, 4.0, 0.5));
    assert_eq!((rs[1].slot, rs[1].width, rs[1].off, rs[1].kind), (1, 3, 1, Kind::Color));
    assert_eq!(rs[2].kind, Kind::Toggle);
    assert_eq!((rs[3].kind, rs[3].max), (Kind::Dropdown, 2.0));
    assert_eq!((rs[4].slot, rs[4].width, rs[4].off, rs[4].min), (6, 2, 6, -1.0));
    assert!(r.by_name(b"tint").is_some());
    assert_eq!(r.by_slot(2).map(|x| x.slot), Some(1));
    assert_eq!(r.manifest_hash, fnv1a(MANIFEST));
}

#[test]
fn malformed_manifest_never_panics() {
    for cut in 0..MANIFEST.len() {
        let _ = Rules::parse(&MANIFEST[..cut]);
    }
    assert!(Rules::parse(b"").is_empty());
    assert!(Rules::parse(b"{}").is_empty());
}

#[test]
fn pack_unpack_round_trip() {
    let r = Rules::parse(MANIFEST);
    let mut u = [0.0f32; 16];
    for (i, x) in u.iter_mut().enumerate() {
        *x = i as f32 * 0.1;
    }
    let p = r.pack(&u);
    let mut back = [9.0f32; 16];
    r.unpack(&p, |slot, v| back[slot as usize..slot as usize + v.len()].copy_from_slice(v));
    assert_eq!(&back[..8], &u[..8]);
}

#[test]
fn slider_lerps_snaps_and_clamps() {
    let r = Rules::parse(MANIFEST);
    let a = packed(&[0.0, 1.0, 0.0, 0.0, 0.0, 0.0, -1.0, 0.0]);
    let b = packed(&[4.0, 1.0, 0.0, 0.0, 1.0, 2.0, 1.0, 0.5]);
    let mut out = UNSET;
    blend(&r, &[&a, &b], &[0.6, 0.4], &a, COLOR_RGB, &mut out);
    // 0.4 * 4 = 1.6 → snapped to 0.5 steps = 1.5
    assert!((out[0] - 1.5).abs() < 1e-6, "{}", out[0]);
    // drift (continuous) lerps per component
    assert!((out[6] - (-0.2)).abs() < 1e-6);
    assert!((out[7] - 0.2).abs() < 1e-6);
    // toggle + dropdown: heaviest source (a)
    assert_eq!((out[4], out[5]), (0.0, 0.0));
    blend(&r, &[&a, &b], &[0.4, 0.6], &a, COLOR_RGB, &mut out);
    assert_eq!((out[4], out[5]), (1.0, 2.0));
}

#[test]
fn hsv_colour_takes_shortest_hue() {
    let r = Rules::parse(MANIFEST);
    // Red (h=0) to magenta-ish magenta (h≈0.833): the short way passes through
    // h≈0.917 (pink), not through green.
    let a = packed(&[0.0, 1.0, 0.0, 0.0]);
    let b = packed(&[0.0, 1.0, 0.0, 1.0]);
    let mut rgb = UNSET;
    let mut hsv = UNSET;
    blend(&r, &[&a, &b], &[0.5, 0.5], &a, COLOR_RGB, &mut rgb);
    blend(&r, &[&a, &b], &[0.5, 0.5], &a, COLOR_HSV, &mut hsv);
    assert_eq!(&rgb[1..4], &[1.0, 0.0, 0.5]);
    let (h, s, v) = rgb_to_hsv(hsv[1], hsv[2], hsv[3]);
    assert!((h - 0.9167).abs() < 1e-3 && (s - 1.0).abs() < 1e-4 && (v - 1.0).abs() < 1e-4, "{h} {s} {v}");
    // Endpoints are exact.
    blend(&r, &[&a, &b], &[1.0, 0.0], &a, COLOR_HSV, &mut hsv);
    assert_eq!(&hsv[1..4], &[1.0, 0.0, 0.0]);
}

#[test]
fn unset_values_fall_back_to_live() {
    let r = Rules::parse(MANIFEST);
    let live = packed(&[2.0, 0.1, 0.2, 0.3, 1.0, 1.0, 0.5, 0.5]);
    let kp = packed(&[4.0]); // only speed set
    let mut out = UNSET;
    blend(&r, &[&kp], &[1.0], &live, COLOR_RGB, &mut out);
    assert_eq!(out[0], 4.0);
    assert_eq!(&out[1..8], &live[1..8]);
}

#[test]
fn morph_eases_from_live_to_target_and_lands_exactly() {
    let mut m = Morph::new();
    m.reset(MANIFEST);
    let live = packed(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]);
    let kp = packed(&[4.0, 1.0, 1.0, 1.0, 1.0, 2.0, 1.0, -1.0]);
    m.begin_sources(7);
    assert!(m.push_source(b"storm", &kp));
    assert!(m.cached(7, &[b"storm"]));
    assert!(!m.cached(8, &[b"storm"]));
    assert!(m.start(&live, &[1.0], 2.0, COLOR_RGB).is_none());
    assert!(m.running());
    let mid = m.advance(1.0).unwrap();
    assert!((mid[6] - 0.5).abs() < 1e-6, "smoothstep(0.5) = 0.5: {}", mid[6]);
    assert_eq!(mid[0], 2.0); // 0.5 * 4 = 2.0, on a step
    let end = m.advance(5.0).unwrap();
    assert!(!m.running());
    assert_eq!(&end[..8], &kp[..8]);
    assert!(m.advance(0.1).is_none());
    assert_eq!(&m.target()[..8], &kp[..8]);
}

#[test]
fn instant_blend_returns_the_mix() {
    let mut m = Morph::new();
    m.reset(MANIFEST);
    let a = packed(&[0.0, 0.0, 0.0, 0.0, 0.0, 0.0, -1.0, -1.0]);
    let b = packed(&[4.0, 1.0, 1.0, 1.0, 1.0, 2.0, 1.0, 1.0]);
    m.begin_sources(1);
    m.push_source(b"calm", &a);
    m.push_source(b"storm", &b);
    let out = m.start(&a, &[3.0, 1.0], 0.0, COLOR_RGB).unwrap();
    assert!(!m.running());
    assert!((out[6] - (-0.5)).abs() < 1e-6);
    assert_eq!(out[0], 1.0);
}

#[test]
fn record_round_trip_by_name() {
    let r = Rules::parse(MANIFEST);
    let vals = packed(&[1.5, 0.1, 0.2, 0.3, 1.0, 2.0, -0.25, 0.75]);
    let mut buf = [0u8; RECORD_CAP];
    let n = encode_record(b"dawn", MANIFEST, &r, &vals, &mut buf).unwrap();
    assert!(n < 200, "{n}");
    let mut out = UNSET;
    let (info, stale) = decode_record(&buf[..n], &r, &mut out).unwrap();
    assert_eq!(info.name, b"dawn");
    assert!(!stale);
    assert_eq!(&out[..8], &vals[..8]);

    // A recompiled effect whose slots moved (tint now first) recalls by name and
    // is reported stale; a dropped uniform is simply skipped.
    let moved: &[u8] = br#"[{"name":"tint","slot":0,"width":3,"ui":{"kind":"color"},"min":0,"max":1},{"name":"speed","slot":3,"width":1,"ui":{"kind":"slider","min":0,"max":4,"step":0.5},"min":0,"max":4}]"#;
    let r2 = Rules::parse(moved);
    let (_, stale) = decode_record(&buf[..n], &r2, &mut out).unwrap();
    assert!(stale);
    let mut u = [0.0f32; 4];
    r2.unpack(&out, |slot, v| u[slot as usize..slot as usize + v.len()].copy_from_slice(v));
    assert_eq!(u, [0.1, 0.2, 0.3, 1.5]);
}

#[test]
fn record_skips_unset_and_rejects_bad_input() {
    let r = Rules::parse(MANIFEST);
    let mut buf = [0u8; RECORD_CAP];
    let n = encode_record(b"x", MANIFEST, &r, &packed(&[2.0]), &mut buf).unwrap();
    let mut seen = 0;
    for_each_value(&buf[..n], |name, v| {
        assert_eq!((name, v), (&b"speed"[..], &[2.0f32][..]));
        seen += 1;
    })
    .unwrap();
    assert_eq!(seen, 1);
    assert_eq!(encode_record(b"", MANIFEST, &r, &UNSET, &mut buf), Err(RecordError::BadName));
    assert_eq!(encode_record(&[b'a'; 33], MANIFEST, &r, &UNSET, &mut buf), Err(RecordError::BadName));
    let mut tiny = [0u8; 8];
    assert_eq!(encode_record(b"x", MANIFEST, &r, &packed(&[2.0]), &mut tiny), Err(RecordError::TooBig));
    for cut in 0..n {
        let mut out = UNSET;
        let _ = decode_record(&buf[..cut], &r, &mut out);
    }
    assert!(record_info(b"nope").is_err());
}

#[test]
fn record_cap_bounds_the_worst_case() {
    // 32 uniforms of 24-byte names, 64 floats total, a 32-byte keypoint name.
    let mut m = Vec::new();
    m.push(b'[');
    for i in 0..32 {
        if i > 0 {
            m.push(b',');
        }
        let w = if i < 16 { 3 } else { 1 };
        let slot: usize = if i < 16 { i * 3 } else { 48 + (i - 16) };
        m.extend_from_slice(format!(r#"{{"name":"u{:0>22}","slot":{},"width":{},"ui":{{"kind":"slider"}}}}"#, i, slot, w).as_bytes());
    }
    m.push(b']');
    let r = Rules::parse(&m);
    assert_eq!(r.rules().len(), 32);
    assert_eq!(r.floats(), 64);
    let vals = [0.5f32; MAX_FLOATS];
    let mut buf = [0u8; RECORD_CAP];
    let n = encode_record(&[b'k'; 32], &m, &r, &vals, &mut buf).unwrap();
    assert!(n <= RECORD_CAP);
}

// --- FX deck crossfade blend ---------------------------------------------------

#[test]
fn blend_rgb_endpoints_are_exact() {
    let a = (200, 10, 40);
    let b = (5, 220, 90);
    // A parked crossfader never perturbs a deck; out-of-range clamps.
    for mode in [0u32, 1u32] {
        assert_eq!(blend_rgb8(a, b, 0.0, mode), a, "mode {mode} t=0");
        assert_eq!(blend_rgb8(a, b, 1.0, mode), b, "mode {mode} t=1");
        assert_eq!(blend_rgb8(a, b, -0.5, mode), a, "mode {mode} t<0");
        assert_eq!(blend_rgb8(a, b, 2.0, mode), b, "mode {mode} t>1");
    }
}

#[test]
fn blend_rgb_linear_midpoint() {
    assert_eq!(blend_rgb8((0, 0, 0), (100, 200, 50), 0.5, 0), (50, 100, 25));
}

#[test]
fn blend_hsv_keeps_saturation_and_takes_short_hue_path() {
    // Red -> green through yellow at full value (an RGB lerp dims to 127,127,0).
    let (r, g, b) = blend_rgb8((255, 0, 0), (0, 255, 0), 0.5, 1);
    assert!(r > 200 && g > 200 && b < 20, "hsv mid red->green = {r},{g},{b}");
    // Red -> blue wraps down through magenta, not up through green.
    let (mr, mg, mb) = blend_rgb8((255, 0, 0), (0, 0, 255), 0.5, 1);
    assert!(mr > 150 && mb > 150 && mg < 60, "hsv red->blue = {mr},{mg},{mb}");
}

#[test]
fn blend_hsv_grey_end_borrows_the_other_hue() {
    // Greys lerp value only.
    let (r, g, b) = blend_rgb8((40, 40, 40), (200, 200, 200), 0.5, 1);
    assert!((r as i32 - 120).abs() <= 1 && r == g && g == b, "grey hsv mid = {r},{g},{b}");
    // White -> green stays on green's hue (no detour through red).
    let (r, g, b) = blend_rgb8((255, 255, 255), (0, 255, 0), 0.5, 1);
    assert!(g == 255 && r == b && r > 100, "white->green = {r},{g},{b}");
}

#[test]
fn manifest_defaults_are_scanned() {
    // fx_compiler's manifest shape: scalar + vec3 defaults, plus a doc string
    // that mentions "default" (must not confuse the key-position scanner).
    let m = br#"[{"name":"speed","slot":0,"width":1,"ui":{"kind":"slider","min":0,"max":4},"default":[1.25],"doc":"\"default\":[9]"},
{"name":"tint","slot":1,"width":3,"ui":{"kind":"color"},"default":[0.2, 0.6, -1e-1]},
{"name":"waves","slot":4,"width":1,"default":[]}]"#;
    let mut seen = Vec::new();
    ledmapper_keypoint::for_each_uniform(m, |u| seen.push((u.slot, u.default[..u.n_default as usize].to_vec())));
    assert_eq!(seen, vec![(0, vec![1.25]), (1, vec![0.2, 0.6, -0.1]), (4, vec![])]);
}
