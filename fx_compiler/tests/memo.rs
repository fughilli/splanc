//! Variance analysis + per-frame hoisting + per-LED memoization (fx_compiler
//! `memo.rs`, fx_vm `LoadLedCache`/`StoreLedCache`).
//!
//! The contract under test: the pass may only change HOW MUCH work the VM does,
//! never WHAT it renders. Every program here is compiled with the pass on and
//! off and run through the real fx_vm across several frames — with the per-LED
//! cache bound, unbound, too small to bind, and across a map change — and the
//! RGB must be bit-identical in every case.

use ledmapper_fx_compiler::{classify_shade, compile_with, CompileOptions, MemoConfig, Variance};
use ledmapper_fx_vm::{led_cache_bytes, Budget, Frame, Led, Program, Vm};

/// The user's motivating case: a cylindrical texture mapping. `atan2` and
/// `length` of the LED position never change; time/uniform terms change per
/// frame but not per LED.
const CYLINDER: &str = r#"uniform float speed : 0.0 .. 2.0 = 0.35;
uniform float bands : 1.0 .. 16.0 = 6.0;
vec3 shade(Led led) {
  float ang = atan2(led.pos.x, led.pos.z) * 0.15915494 + 0.5;
  float r = length(led.pos.xz);
  float t = time * speed;
  float v = fract(ang * bands + t);
  float glow = 0.5 + 0.5 * sin(t * 6.2831853);
  return hsv2rgb(v, 0.8, clamp(r * glow, 0.0, 1.0));
}"#;

/// Fixed-point twin: the LUT atan2 is cheap but still worth one table load.
const CYLINDER_FIXED: &str = r#"uniform float speed : 0.0 .. 2.0 = 0.35;
vec3 shade(Led led) {
  fixed16 a = atan2(fixed16(led.pos.x), fixed16(led.pos.z));
  fixed16 r = length(vec2(fixed16(led.pos.x), fixed16(led.pos.z)));
  fixed16 t = fixed16(fract(time * speed));
  fixed16 v = fract(a + t);
  return vec3(float(v), float(r), 0.2);
}"#;

/// The user's rain effect (/workspace/.claude/mcplive/rain.fx) — hand-caches
/// clouds 1/16 of the LEDs per frame into buffers; the pass must leave its
/// buffer/state traffic alone and still render identically.
const RAIN: &str = include_str!("testdata/rain.fx");

/// Hash-of-index sparkle: the per-LED random phase is LED-invariant.
const SPARKLE: &str = r#"uniform float rate : 0.1 .. 4.0 = 1.0;
state float t;
void update() { t = t + dt * rate; }
vec3 shade(Led led) {
  float ph = hash(float(led.idx) * 7.31 + 0.5);
  float sp = 0.6 + 0.8 * hash(float(led.idx) * 3.7 + 1.3);
  float b = pow(0.5 + 0.5 * sin((t * sp + ph) * 6.2831853), 8.0);
  return vec3(b, b, b);
}"#;

/// A helper called from BOTH update() and shade(): it must not be memoized (in
/// update() `led` is a default Led).
const SHARED_HELPER: &str = r#"state float acc;
float ring() { return length(led.pos.xy) * 3.0; }
void update() { acc = fract(acc + ring() * 0.01 + dt); }
vec3 shade(Led led) {
  float a = atan2(led.pos.y, led.pos.x);
  return vec3(fract(ring() + acc), a * 0.1, 0.0);
}"#;

fn opts(memo: bool) -> CompileOptions {
    CompileOptions {
        optimize: true,
        memo: memo.then(MemoConfig::default),
    }
}

fn leds(n: u32, salt: f32) -> Vec<Led> {
    (0..n)
        .map(|i| {
            let f = i as f32 / (n as f32 - 1.0);
            let a = f * 12.566 + salt;
            let pos = [
                a.cos() * (0.3 + salt),
                f * 2.0 - 1.0,
                a.sin() * (0.3 + salt),
            ];
            let q = |x: f32| (x * 65536.0) as i32;
            Led {
                pos,
                idx: i,
                seg: (i % 3) as i32,
                s: f,
                dist: f,
                uv: [f, 1.0 - f],
                pos_fix: [q(pos[0]), q(pos[1]), q(pos[2])],
                uv_fix: [q(f), q(1.0 - f)],
                s_fix: q(f),
                dist_fix: q(f),
                ..Default::default()
            }
        })
        .collect()
}

fn frame(i: u32) -> Frame {
    let t = 0.37 * i as f32 + 0.11;
    Frame {
        time: t,
        dt: 0.033,
        frame: i,
        led_count: 48,
        time_fix: (t * 65536.0) as i32,
        dt_fix: (0.033 * 65536.0) as i32,
        ..Default::default()
    }
}

/// Cache binding mode for a run.
#[derive(Clone, Copy, Debug)]
enum Cache {
    /// No cache bound: the bracket ops are no-ops.
    Unbound,
    /// The program's full request bound.
    Full,
    /// A buffer too small for even one group: binds nothing (graceful fallback).
    Starved,
}

struct Run {
    rgb: Vec<Vec<(u8, u8, u8)>>,
    shade_ops: Vec<u64>,
}

/// Run `fxb` for `frames` frames over `leds` (switching to `leds2` — a new map —
/// at frame `swap_at`, invalidating the cache like the firmware does).
fn render(
    fxb: &[u8],
    uniforms: &[(usize, Vec<f32>)],
    cache: Cache,
    frames: u32,
    leds1: &[Led],
    leds2: &[Led],
    swap_at: u32,
    invalidate: bool,
) -> Run {
    let prog = Program::parse(fxb).expect("parse");
    let mut vm = Vm::new();
    for (slot, v) in uniforms {
        vm.set_uniform(*slot, v);
    }
    let n = leds1.len();
    let mut arena = vec![0u8; prog.arena_bytes(n) + 64];
    vm.set_arena(&mut arena);
    let mut mem = vec![0u8; led_cache_bytes(prog.led_cache_words(), n).max(4)];
    match cache {
        Cache::Unbound => {}
        Cache::Full => {
            let w = prog.led_cache_fit(n, mem.len());
            vm.set_led_cache(&mut mem, w, n);
        }
        Cache::Starved => {
            let w = prog.led_cache_fit(n, 3);
            assert_eq!(w, 0);
            vm.set_led_cache(&mut mem[..3], w, n);
            assert_eq!(vm.led_cache_words_bound(), 0);
        }
    }
    let big = Budget::instructions(5_000_000);
    let mut out = Run {
        rgb: Vec::new(),
        shade_ops: Vec::new(),
    };
    for f in 0..frames {
        if f == swap_at && invalidate {
            vm.invalidate_led_cache();
        }
        let ls = if f >= swap_at { leds2 } else { leds1 };
        let fr = frame(f);
        vm.run_update_counted(&prog, &fr, &big);
        let mut row = Vec::new();
        let mut ops = 0u64;
        for l in ls {
            let (c, _, k) = vm.run_shade_counted(&prog, &fr, l, &big);
            row.push(c);
            ops += k.instrs as u64;
        }
        out.rgb.push(row);
        out.shade_ops.push(ops);
    }
    out
}

fn uniforms_of(c: &ledmapper_fx_compiler::Compiled) -> Vec<(usize, Vec<f32>)> {
    c.uniforms
        .iter()
        .map(|u| (u.slot as usize, u.default.clone()))
        .collect()
}

/// The equivalence harness: memo on (cache full / unbound / starved, with a map
/// change mid-run) must equal memo off, bit for bit.
fn assert_equivalent(name: &str, src: &str) -> (Run, Run) {
    let base = compile_with(src, &opts(false)).unwrap_or_else(|d| panic!("{name}: {d:?}"));
    let memo = compile_with(src, &opts(true)).unwrap_or_else(|d| panic!("{name}: {d:?}"));
    let l1 = leds(48, 0.0);
    let l2 = leds(48, 0.25); // a different map, same LED count
    let frames = 8;
    let want = render(
        &base.fxb,
        &uniforms_of(&base),
        Cache::Unbound,
        frames,
        &l1,
        &l2,
        4,
        true,
    );
    let mut full = None;
    for cache in [Cache::Full, Cache::Unbound, Cache::Starved] {
        let got = render(
            &memo.fxb,
            &uniforms_of(&memo),
            cache,
            frames,
            &l1,
            &l2,
            4,
            true,
        );
        for f in 0..frames as usize {
            assert_eq!(
                got.rgb[f], want.rgb[f],
                "{name}: {cache:?} frame {f} differs from the uncached build"
            );
        }
        if matches!(cache, Cache::Full) {
            full = Some(got);
        }
    }
    (want, full.unwrap())
}

#[test]
fn classifies_cylindrical_mapping() {
    let cls = classify_shade(CYLINDER);
    let find = |needle: &str, v: Variance| cls.iter().any(|(e, c)| *c == v && e.contains(needle));
    assert!(
        find("BIN_MATH atan2", Variance::Led),
        "atan2(pos.x,pos.z) is per-LED static: {cls:#?}"
    );
    assert!(
        find("LENGTH n=2", Variance::Led),
        "length(pos.xz) is per-LED static: {cls:#?}"
    );
    assert!(
        find("LOAD_CTX time", Variance::Frame),
        "time*speed is per-frame: {cls:#?}"
    );
    assert!(
        find("UN_MATH sin", Variance::Frame),
        "sin(t*TAU) is per-frame: {cls:#?}"
    );
    // fract(ang*bands + t) mixes a per-LED and a per-frame value -> dynamic,
    // so no listed range may contain the fract.
    assert!(
        !cls.iter().any(|(e, _)| e.contains("UN_MATH fract")),
        "fract(...) is dynamic: {cls:#?}"
    );
}

#[test]
fn classifies_index_hashes_and_excludes_mutable_sources() {
    let cls = classify_shade(SPARKLE);
    assert!(
        cls.iter().any(|(e, v)| *v == Variance::Led
            && e.contains("LOAD_CTX led.idx")
            && e.contains("HASH1")),
        "hash(idx) is per-LED static: {cls:#?}"
    );
    // `state t` is per-frame (shade can't write state).
    assert!(
        cls.iter()
            .any(|(e, v)| *v == Variance::Frame && e.contains("LOAD_STATE")),
        "{cls:#?}"
    );
    // led.dist / buffers are never LED-static.
    let d = classify_shade(
        "vec3 shade(Led led) { float a = sqrt(led.dist) * 3.0; return vec3(a, a, a); }",
    );
    assert!(
        d.iter().all(|(e, _)| !e.contains("led.dist")),
        "led.dist follows flood_from: {d:#?}"
    );
}

#[test]
fn memoizes_and_hoists_cylinder() {
    let c = compile_with(CYLINDER, &opts(true)).unwrap();
    let r = &c.memo;
    assert!(
        r.cached.iter().any(|m| m.expr.contains("BIN_MATH atan2")),
        "atan2 cached: {r:#?}"
    );
    assert!(
        r.cached.iter().any(|m| m.expr.contains("LENGTH")),
        "length cached: {r:#?}"
    );
    assert!(
        r.hoisted.iter().any(|m| m.expr.contains("UN_MATH sin")),
        "sin(t) hoisted: {r:#?}"
    );
    assert!(
        r.led_cache_words >= 2
            && r.led_cache_words as usize * 4 <= MemoConfig::default().max_led_cache_bytes
    );
    assert!(r.n_state >= 1, "hoisted values live in state");
    // The .fxb carries the trailer + an update() entry was synthesized.
    let p = Program::parse(&c.fxb).unwrap();
    assert_eq!(p.led_cache_words(), r.led_cache_words);
    assert_ne!(
        p.prep_entry(), 0xFFFF,
        "the hoisted work rides a per-frame prep entry"
    );
    assert_eq!(
        p.update_entry, 0xFFFF,
        "update() is untouched (none declared)"
    );
    assert_eq!(p.n_state, r.n_state);
    assert!(
        r.cycles_saved_per_led > 1000,
        "atan2+length+sin are ~2.5k cycles: {r:#?}"
    );
}

#[test]
fn cylinder_is_bit_identical_and_cheaper() {
    let (base, memo) = assert_equivalent("cylinder", CYLINDER);
    // Frame 0 computes + records; later frames hit the cache.
    let steady_base = base.shade_ops[2];
    let steady_memo = memo.shade_ops[2];
    assert!(
        steady_memo * 10 < steady_base * 7,
        "steady-state shade ops should drop >30%: {steady_base} -> {steady_memo}"
    );
    // After the map change (frame 4) the first frame recomputes, then hits again.
    assert!(memo.shade_ops[4] > memo.shade_ops[5]);
}

#[test]
fn fixed_cylinder_rain_sparkle_shared_helper_are_bit_identical() {
    for (name, src) in [
        ("cylinder_fixed", CYLINDER_FIXED),
        ("rain", RAIN),
        ("sparkle", SPARKLE),
        ("shared_helper", SHARED_HELPER),
    ] {
        assert_equivalent(name, src);
    }
}

#[test]
fn stale_cache_without_invalidation_is_observable() {
    // Proves the cache is really serving values: skip the invalidation on a map
    // change and the output diverges (the firmware MUST invalidate on upload).
    let c = compile_with(CYLINDER, &opts(true)).unwrap();
    let l1 = leds(48, 0.0);
    let l2 = leds(48, 0.25);
    let fresh = render(&c.fxb, &uniforms_of(&c), Cache::Full, 6, &l1, &l2, 3, true);
    let stale = render(&c.fxb, &uniforms_of(&c), Cache::Full, 6, &l1, &l2, 3, false);
    assert_eq!(fresh.rgb[2], stale.rgb[2]);
    assert_ne!(
        fresh.rgb[4], stale.rgb[4],
        "a stale cache must show (so invalidation matters)"
    );
}

#[test]
fn shared_helper_is_not_memoized_inside_the_function() {
    let c = compile_with(SHARED_HELPER, &opts(true)).unwrap();
    // atan2 in shade's own body is fine to cache; the helper's length() is not
    // (it's reachable from update()).
    assert!(
        c.memo.cached.iter().any(|m| m.expr.contains("atan2")),
        "{:#?}",
        c.memo
    );
    assert!(
        c.memo.cached.iter().all(|m| !m.expr.contains("LENGTH")),
        "{:#?}",
        c.memo
    );
}

#[test]
fn cache_budget_picks_best_saving_per_byte() {
    // Three LED-invariant values: a scalar atan2 (cheap per byte saved), a vec3
    // normalize (3 words) and a scalar pow. With a 2-word budget the two scalars
    // win; the vec3 is reported over budget.
    let src = r#"vec3 shade(Led led) {
  float a = atan2(led.pos.x, led.pos.z);
  vec3 n = normalize(led.pos * 2.0 + vec3(0.1, 0.2, 0.3));
  float p = pow(led.s + 0.5, 3.3);
  return vec3(fract(a + time), n.y * fract(time), p * fract(time * 2.0));
}"#;
    let cfg = MemoConfig {
        max_led_cache_bytes: 8,
        ..Default::default()
    };
    let c = compile_with(
        src,
        &CompileOptions {
            optimize: true,
            memo: Some(cfg),
        },
    )
    .unwrap();
    let r = &c.memo;
    assert_eq!(r.led_cache_words, 2, "{r:#?}");
    assert!(r.cached.iter().any(|m| m.expr.contains("atan2")));
    assert!(r.cached.iter().any(|m| m.expr.contains("pow")));
    assert!(
        r.over_budget.iter().any(|m| m.expr.contains("NORMALIZE")),
        "{r:#?}"
    );
    // Groups are cumulative and in priority order, so a host with room for one
    // word binds the single best expression.
    assert_eq!(r.led_cache_groups, vec![1, 2]);
    let p = Program::parse(&c.fxb).unwrap();
    assert_eq!(p.led_cache_fit(100, led_cache_bytes(1, 100)), 1);
    assert_eq!(p.led_cache_fit(100, led_cache_bytes(2, 100)), 2);
    // A generous budget caches all three.
    let roomy = MemoConfig {
        max_led_cache_bytes: 32,
        ..Default::default()
    };
    let c3 = compile_with(
        src,
        &CompileOptions {
            optimize: true,
            memo: Some(roomy),
        },
    )
    .unwrap();
    assert_eq!(c3.memo.led_cache_words, 5, "{:#?}", c3.memo);
    assert_equivalent("budget", src);
}

#[test]
fn cheap_ranges_are_left_alone() {
    // led.pos.x is LED-static but a lookup saves less than min_memo_saving, and
    // a lone uniform load is already as cheap as the state load replacing it.
    let c = compile_with(
        "uniform float k : 0.0 .. 1.0 = 0.5; vec3 shade(Led led) { return vec3(led.pos.x, k, 0.0); }",
        &opts(true),
    )
    .unwrap();
    assert!(
        c.memo.cached.is_empty() && c.memo.hoisted.is_empty(),
        "{:#?}",
        c.memo
    );
    assert_eq!(Program::parse(&c.fxb).unwrap().led_cache_words(), 0);
}

#[test]
fn hoists_after_existing_update_writes() {
    // shade reads `glow` that update() writes this frame: the hoisted prep must
    // see update's writes (the VM re-runs prep after every update()).
    let src = r#"uniform float rate : 0.1 .. 3.0 = 0.6;
state float glow;
void update() { glow = 0.5 + 0.5 * sin(time * rate); }
vec3 shade(Led led) {
  float g = sqrt(glow) * smoothstep(0.0, 1.0, glow);
  return vec3(g * led.s, g, 0.0);
}"#;
    let c = compile_with(src, &opts(true)).unwrap();
    assert!(
        c.memo.hoisted.iter().any(|h| h.expr.contains("SMOOTHSTEP")),
        "{:#?}",
        c.memo
    );
    assert_equivalent("glow", src);
}

#[test]
fn optimizer_off_means_no_memo() {
    let c = compile_with(
        CYLINDER,
        &CompileOptions {
            optimize: false,
            memo: Some(MemoConfig::default()),
        },
    )
    .unwrap();
    assert!(c.memo.cached.is_empty() && c.memo.hoisted.is_empty());
}

#[test]
fn drivers_are_never_memoized() {
    // A FUG-107 sensor driver's poll() rides the shade slot but runs with no LED
    // and no per-frame sweep: the variance pass must leave it alone (no prep
    // entry, no LED-cache bracket, no FLAG_MEMO), even with per-frame math in it.
    let src = r#"
export float a;
void poll() {
  float raw = float(i2c_read16s(104, 59));
  a = sin(time * 0.5) * 3.0 + raw * 0.001;
}"#;
    let c = compile_with(src, &opts(true)).unwrap();
    assert!(c.memo.cached.is_empty() && c.memo.hoisted.is_empty(), "{:#?}", c.memo);
    let p = Program::parse(&c.fxb).unwrap();
    assert_eq!(p.flags & ledmapper_fx_vm::FLAG_MEMO, 0);
    assert_ne!(p.flags & ledmapper_fx_vm::FLAG_DRIVER, 0);
    assert_eq!(p.prep_entry(), 0xFFFF);
}
