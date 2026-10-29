//! The Halloween effect pack (web/src/halloween/presets.ts) compiles with zero
//! warnings, declares its sliders and the `rope_start` channel-split uniform, and
//! renders on the real VM: never all-black over 10 s, and the rope (LEDs from
//! rope_start) gets its own look.

use ledmapper_fx_vm::{Budget, Frame, Led, Program, Vm};

const PRESETS: &str = include_str!("../../web/src/halloween/presets.ts");

/// (id, sliders, source) for every preset, scraped from the TS literal.
fn presets() -> Vec<(String, Vec<String>, String)> {
    let mut out = Vec::new();
    let mut rest = PRESETS;
    while let Some(i) = rest.find("    id: \"") {
        rest = &rest[i + 9..];
        let id = rest[..rest.find('"').unwrap()].to_string();
        let s = rest.find("sliders: [").unwrap() + 10;
        let sliders = rest[s..s + rest[s..].find(']').unwrap()]
            .split(',')
            .map(|x| x.trim().trim_matches('"').to_string())
            .collect();
        let b = rest.find("source: `").unwrap() + 9;
        let e = b + rest[b..].find('`').unwrap();
        out.push((id, sliders, rest[b..e].to_string()));
        rest = &rest[e..];
    }
    out
}

/// A lumpy 20x15 curtain (serpentine columns) + a 60-LED rope in front.
fn positions() -> Vec<[f32; 3]> {
    let mut p = Vec::new();
    for c in 0..20 {
        for k in 0..15 {
            let row = if c % 2 == 0 { k } else { 14 - k };
            let (x, y) = (c as f32 * 0.1, 1.4 - row as f32 * 0.1);
            p.push([x, y, 0.1 * (x * 7.0).sin().abs() * (1.4 - y)]);
        }
    }
    for j in 0..60 {
        let t = j as f32 / 59.0;
        p.push([t * 1.9, 0.02, 0.5 + 0.15 * (t * 12.0).sin()]);
    }
    p
}

#[test]
fn halloween_presets_compile_and_render() {
    let ps = presets();
    assert!(ps.len() >= 8, "found {} presets", ps.len());
    let pos = positions();
    let (n, rope_start) = (pos.len(), 300usize);
    for (id, sliders, src) in ps {
        let c = ledmapper_fx_compiler::compile(&src).unwrap_or_else(|d| panic!("{id}: {d:?}"));
        assert!(c.warnings.is_empty(), "{id}: {:?}", c.warnings.iter().map(|w| &w.msg).collect::<Vec<_>>());
        for s in sliders.iter().chain(std::iter::once(&"rope_start".to_string())) {
            assert!(c.uniforms.iter().any(|u| &u.name == s), "{id}: no uniform {s}");
        }
        let prog = Program::parse(&c.fxb).unwrap();
        let mut vm = Vm::new();
        for u in &c.uniforms {
            let v = if u.name == "rope_start" { vec![rope_start as f32] } else { u.default.clone() };
            vm.set_uniform(u.slot as usize, &v);
        }
        let mut arena = vec![0u8; prog.arena_bytes(n)];
        let (mn_y, mx_y) = (0.0f32, 1.4f32);
        let (mut curtain_lum, mut rope_lum) = (0f64, 0f64);
        let dt = 1.0 / 30.0;
        for fr in 0..300u32 {
            let t = fr as f32 * dt;
            let q = |x: f32| (x * 65536.0) as i32;
            let f = Frame { time: t, dt, frame: fr, led_count: n as u32, time_fix: q(t), dt_fix: q(dt), ..Default::default() };
            vm.set_arena(&mut arena);
            vm.run_update(&prog, &f);
            let mut lit = false;
            for (i, p) in pos.iter().enumerate() {
                let uv = [p[0] / 1.9, (p[1] - mn_y) / (mx_y - mn_y)];
                let led = Led { pos: *p, idx: i as u32, seg: -1, uv, pos_fix: [q(p[0]), q(p[1]), q(p[2])], uv_fix: [q(uv[0]), q(uv[1])], ..Default::default() };
                let (rgb, o) = vm.run_shade_bounded(&prog, &f, &led, &Budget::default());
                assert!(!o.timed_out(), "{id}: shade over budget");
                let l = rgb.0 as f64 + rgb.1 as f64 + rgb.2 as f64;
                lit |= l > 0.0;
                if i < rope_start { curtain_lum += l } else { rope_lum += l }
            }
            assert!(lit, "{id}: frame {fr} is all black");
        }
        assert!(curtain_lum > 0.0 && rope_lum > 0.0, "{id}: curtain {curtain_lum} rope {rope_lum}");
    }
}
