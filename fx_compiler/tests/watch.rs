//! D-541 Watch (host preview only, D-550): the host watch build
//! (`compile_watch`) watches selected sub-expressions without changing what the
//! program computes. Checked on the real fx_vm: the selection must be one whole
//! expression, the instrumented program renders exactly what the normal build
//! renders (feedback buffers included), and each watch reads back the value the
//! expression had, per frame (update()) or per LED (shade()), with its class.

use ledmapper_fx_compiler::{
    compile, compile_watch, watches_json, Compiled, Variance, WatchInfo, WatchStore, WATCH_NOT_AN_EXPRESSION,
    WATCH_NOT_PER_FRAME,
};
use ledmapper_fx_vm::{Frame, Led, Program, Vm};

/// Byte range of the `nth` occurrence of `needle` in `src`.
fn range(src: &str, needle: &str, nth: usize) -> (usize, usize) {
    let start = src
        .match_indices(needle)
        .nth(nth)
        .unwrap_or_else(|| panic!("no {needle:?} #{nth}"))
        .0;
    (start, start + needle.len())
}

fn watch(src: &str, sel: &[(&str, usize)]) -> (Compiled, Vec<WatchInfo>) {
    let ranges: Vec<_> = sel.iter().map(|(n, k)| range(src, n, *k)).collect();
    let w = compile_watch(src, &ranges);
    let c = w.result.unwrap_or_else(|d| panic!("watch build failed: {d:?}"));
    (c, w.watches)
}

const N: usize = 8;

fn led(i: usize) -> Led {
    let pos = [i as f32 * 0.1, 0.5, -(i as f32) * 0.05];
    let q16 = |x: f32| (x * 65536.0) as i32;
    Led { pos, pos_fix: [q16(pos[0]), q16(pos[1]), q16(pos[2])], idx: i as u32, ..Default::default() }
}

/// Run `frames` frames over N LEDs; returns every frame's colours, the VM and
/// its arena.
fn run(c: &Compiled, frames: usize) -> (Vec<Vec<(u8, u8, u8)>>, Vm, Vec<u8>) {
    let prog = Program::parse(&c.fxb).expect("parse fxb");
    let mut vm = Vm::new();
    for u in &c.uniforms {
        vm.set_uniform(u.slot as usize, &u.default);
    }
    let mut arena = vec![0u8; prog.arena_bytes(N)];
    let mut out = Vec::new();
    for f in 0..frames {
        let fr = Frame { frame: f as u32, time: f as f32 * 0.25, dt: 0.25, led_count: N as u32, ..Default::default() };
        vm.set_arena(&mut arena);
        vm.run_update(&prog, &fr);
        out.push((0..N).map(|i| vm.run_shade(&prog, &fr, &led(i))).collect());
    }
    (out, vm, arena)
}

/// Watch `w`'s per-LED values (decoded as f32 words).
fn led_values(c: &Compiled, arena: &[u8], w: &WatchInfo) -> Vec<Vec<f32>> {
    let prog = Program::parse(&c.fxb).unwrap();
    let WatchStore::Led { buffers } = &w.store else { panic!("not per-LED: {w:?}") };
    (0..N)
        .map(|i| {
            let mut v = Vec::new();
            for &id in buffers {
                let d = prog.buf_desc(id as usize).unwrap();
                let base = prog.buf_base(id as usize, N) + i * d.elem_bytes();
                for k in 0..d.elem as usize {
                    let o = base + 4 * k;
                    v.push(f32::from_le_bytes(arena[o..o + 4].try_into().unwrap()));
                }
            }
            v
        })
        .collect()
}

fn state_values(vm: &Vm, w: &WatchInfo) -> Vec<f32> {
    let WatchStore::State { slot } = w.store else { panic!("not per-frame: {w:?}") };
    vm.state[slot as usize..slot as usize + w.width as usize].to_vec()
}

const FX: &str = "uniform float gain = 0.5; // 0..1
state float ph;
void update() { ph = fract(ph + dt * gain); }
vec3 shade(Led led) {
    float a = led.pos.x * 2.0;
    float b = a + gain * ph;
    return vec3(a, b, 0.25 + 0.5);
}";

#[test]
fn a_selection_must_be_one_whole_expression() {
    let src = "vec3 shade(Led led) { float y = led.pos.x + led.pos.y * 2.0; return vec3(y); }";
    let cases = [
        ("led.pos.x + led.pos.y * 2.0", None),
        ("led.pos.y * 2.0", None),
        ("led.pos.y", None),
        ("led.pos", None),
        ("2.0", None),
        // Wrapping the text would turn it into (x + y) * 2: not an expression here.
        ("led.pos.x + led.pos.y", Some(WATCH_NOT_AN_EXPRESSION)),
        ("pos.x", Some(WATCH_NOT_AN_EXPRESSION)), // cuts `led.`
        ("os.x", Some(WATCH_NOT_AN_EXPRESSION)),  // cuts a token
        ("float y = led.pos.x", Some(WATCH_NOT_AN_EXPRESSION)),
        ("return vec3(y);", Some(WATCH_NOT_AN_EXPRESSION)),
    ];
    for (sel, want) in cases {
        let (_, ws) = watch(src, &[(sel, 0)]);
        assert_eq!(ws[0].error.as_deref(), want, "selection {sel:?}");
    }
    // Surrounding whitespace is ignored.
    let r = range(src, "led.pos.y * 2.0", 0);
    let w = compile_watch(src, &[(r.0 - 1, r.1)]);
    assert_eq!(w.watches[0].error, None);
    // A declaration is never evaluated per frame.
    let src2 = "uniform float k = 0.25; // 0..1\nstate float s = 0.5 * 2.0;\nvec3 shade(Led led) { return vec3(k); }";
    let (_, ws) = watch(src2, &[("0.5 * 2.0", 0)]);
    assert_eq!(ws[0].error.as_deref(), Some(WATCH_NOT_PER_FRAME));
}

#[test]
fn the_watch_build_renders_what_the_normal_build_renders() {
    // A feedback buffer + state + uniforms + a loop: the watch copies must not
    // change a single colour.
    let src = "uniform float speed = 0.3; // 0..1
buffer float trail;
state float ph;
void update() { ph = fract(ph + dt * speed); }
vec3 shade(Led led) {
    int i = int(led.idx);
    float acc = 0.0;
    for (int k = 0; k < 3; k = k + 1) { acc = acc + sin(led.pos.x * float(k) + ph); }
    trail[i] = trail[i] * 0.8 + max(0.0, acc) * 0.2;
    return vec3(trail[i], ph, abs(acc) * 0.3);
}";
    let normal = compile(src).unwrap();
    let (watched, ws) = watch(
        src,
        &[
            ("sin(led.pos.x * float(k) + ph)", 0),
            ("trail[i] * 0.8", 0),
            ("fract(ph + dt * speed)", 0),
            ("abs(acc) * 0.3", 0),
        ],
    );
    assert!(ws.iter().all(|w| w.error.is_none()), "{ws:?}");
    let (a, _, _) = run(&normal, 12);
    let (b, _, _) = run(&watched, 12);
    assert_eq!(a, b, "the watch build changed the output");
}

#[test]
fn watched_values_class_and_storage() {
    let (c, ws) = watch(
        FX,
        &[
            ("led.pos.x * 2.0", 0),
            ("a + gain * ph", 0),
            ("0.25 + 0.5", 0),
            ("fract(ph + dt * gain)", 0),
            ("gain * ph", 0),
            ("led.pos", 0),
        ],
    );
    for w in &ws {
        assert_eq!(w.error, None, "{w:?}");
    }
    let class: Vec<_> = ws.iter().map(|w| w.class).collect();
    assert_eq!(
        class,
        vec![
            Some(Variance::Led),
            Some(Variance::Dynamic), // `a` is per-LED, `gain * ph` per frame
            Some(Variance::Const),
            Some(Variance::Frame),
            Some(Variance::Frame),
            Some(Variance::Led),
        ]
    );
    assert_eq!(ws[0].ty, "float");
    assert_eq!(ws[5].ty, "vec3");
    assert_eq!(ws[5].width, 3);
    assert_eq!(ws[3].func, "update");
    assert_eq!(ws[0].func, "shade");
    assert!(matches!(ws[3].store, WatchStore::State { .. }));
    assert!(matches!(ws[0].store, WatchStore::Led { .. }));

    let (_, vm, arena) = run(&c, 3);
    // Per LED: led.pos.x * 2 for each LED.
    let a = led_values(&c, &arena, &ws[0]);
    for (i, v) in a.iter().enumerate() {
        assert!((v[0] - led(i).pos[0] * 2.0).abs() < 1e-6, "LED {i}: {v:?}");
    }
    assert_eq!(led_values(&c, &arena, &ws[2])[3], vec![0.75]);
    assert_eq!(led_values(&c, &arena, &ws[5])[2], led(2).pos.to_vec());
    // Per frame: after 3 updates ph = 3 * 0.25 * 0.5.
    let ph = state_values(&vm, &ws[3])[0];
    assert!((ph - 0.375).abs() < 1e-6, "{ph}");
    // `gain * ph` in shade() saw the post-update ph.
    assert!((led_values(&c, &arena, &ws[4])[0][0] - 0.5 * 0.375).abs() < 1e-6);
}

#[test]
fn int_fixed_bool_and_matrix_values_decode() {
    let src = "uniform mat4 m;
vec3 shade(Led led) {
    int n = int(led.idx) * 3;
    fixed f = fixed(led.pos.x);
    bool on = led.pos.x > 0.25;
    vec4 p = m * vec4(led.pos, 1.0);
    float o = 0.0;
    if (on) { o = 1.0; }
    return vec3(float(n), float(f), o) + p.xyz;
}";
    let m_at = range(src, "m * vec4", 0).0;
    let ranges = [
        range(src, "int(led.idx) * 3", 0),
        range(src, "fixed(led.pos.x)", 0),
        range(src, "led.pos.x > 0.25", 0),
        range(src, "m * vec4(led.pos, 1.0)", 0),
        (m_at, m_at + 1),
    ];
    let w = compile_watch(src, &ranges);
    let c = w.result.unwrap_or_else(|d| panic!("{d:?}"));
    let ws = w.watches;
    for w in &ws {
        assert_eq!(w.error, None, "{w:?}");
    }
    assert_eq!((ws[0].ty.as_str(), ws[0].decode.as_str()), ("int", "i32"));
    assert_eq!((ws[1].ty.as_str(), ws[1].decode.as_str()), ("fixed", "q16"));
    assert_eq!((ws[2].ty.as_str(), ws[2].decode.as_str()), ("bool", "bool"));
    assert_eq!((ws[3].ty.as_str(), ws[3].width), ("vec4", 4));
    assert_eq!((ws[4].ty.as_str(), ws[4].width), ("mat4", 16));
    let WatchStore::Led { buffers } = &ws[4].store else { panic!() };
    assert_eq!(buffers.len(), 4, "16 words in 4-word buffers");
    let (_, _, arena) = run(&c, 1);
    let bits = |w: &WatchInfo, i: usize| -> Vec<u32> {
        led_values(&c, &arena, w)[i].iter().map(|v| v.to_bits()).collect()
    };
    assert_eq!(bits(&ws[0], 5), vec![15]);
    assert_eq!(bits(&ws[1], 5)[0] as i32, (0.5f32 * 65536.0) as i32);
    assert_ne!(bits(&ws[2], 5)[0], 0, "0.5 > 0.25");
    assert_eq!(bits(&ws[2], 1)[0], 0, "0.1 > 0.25 is false");
    // The default mat4 is the identity.
    let m = led_values(&c, &arena, &ws[4])[0].clone();
    assert_eq!(m, (0..16).map(|i| if i % 5 == 0 { 1.0 } else { 0.0 }).collect::<Vec<f32>>());
}

#[test]
fn nested_and_helper_watches() {
    let src = "float tri(float x) { return abs(fract(x) * 2.0 - 1.0); }
vec3 shade(Led led) { return vec3(tri(led.pos.x + 0.5)); }";
    let (c, ws) = watch(src, &[("fract(x) * 2.0 - 1.0", 0), ("fract(x)", 0), ("tri(led.pos.x + 0.5)", 0)]);
    for w in &ws {
        assert_eq!(w.error, None, "{w:?}");
    }
    assert_eq!(ws[0].func, "tri");
    assert_eq!(ws[2].class, Some(Variance::Dynamic), "a helper call");
    let (_, _, arena) = run(&c, 1);
    let x = led(3).pos[0] + 0.5;
    let fx = x - x.floor();
    assert!((led_values(&c, &arena, &ws[1])[3][0] - fx).abs() < 1e-6);
    assert!((led_values(&c, &arena, &ws[0])[3][0] - (fx * 2.0 - 1.0)).abs() < 1e-6);
    assert!((led_values(&c, &arena, &ws[2])[3][0] - (fx * 2.0 - 1.0).abs()).abs() < 1e-6);
}

#[test]
fn a_source_that_does_not_compile_fails_the_same_way() {
    let src = "vec3 shade(Led led) { return vec3(nope); }";
    let w = compile_watch(src, &[range(src, "nope", 0)]);
    assert!(w.result.is_err());
    assert_eq!(compile(src).err().unwrap()[0].msg, w.result.err().unwrap()[0].msg);
}

#[test]
fn watches_json_shape() {
    let (_, ws) = watch(FX, &[("led.pos.x * 2.0", 0), ("fract(ph + dt * gain)", 0), ("a + gain", 0)]);
    let j = watches_json(&ws);
    assert!(j.starts_with("[{\"error\":null,\"ty\":\"float\",\"width\":1,\"decode\":\"f32\",\"class\":\"led\""), "{j}");
    assert!(j.contains("\"store\":\"state\""), "{j}");
    assert!(j.contains("\"error\":\"selection is not an expression\""), "{j}");
}

#[test]
fn hidden_storage_comes_after_the_programs_own() {
    // State and buffers declared AFTER the functions keep the slots / buffer
    // ids (and so the arena layout) of the normal build: the editor syncs the
    // watch VM from the live preview's state + arena.
    let src = "state float b;
void update() { b = b + dt; }
buffer vec2 t2;
buffer float t;
vec3 shade(Led led) { t[int(led.idx)] = led.pos.x + b; return vec3(t[int(led.idx)]); }
state float init_me = 0.25;";
    let normal = compile(src).unwrap();
    let (watched, ws) = watch(src, &[("b + dt", 0), ("led.pos.x + b", 0)]);
    assert!(ws.iter().all(|w| w.error.is_none()), "{ws:?}");
    let slot = |c: &Compiled, n: &str| c.symbols.iter().find(|s| s.name == n).map(|s| (s.kind, s.slot)).unwrap();
    for n in ["b", "t", "t2", "init_me"] {
        assert_eq!(slot(&normal, n), slot(&watched, n), "{n}");
    }
    let WatchStore::State { slot: ws0 } = ws[0].store else { panic!() };
    let max_user = normal.symbols.iter().filter(|s| s.kind == "state").map(|s| s.slot + s.width).max().unwrap();
    assert!(ws0 >= max_user, "watch slot {ws0} after the program's state ({max_user})");
    let WatchStore::Led { buffers } = &ws[1].store else { panic!() };
    assert_eq!(buffers, &vec![2u8], "after the two declared buffers");
    // Same arena prefix.
    let (pn, pw) = (Program::parse(&normal.fxb).unwrap(), Program::parse(&watched.fxb).unwrap());
    assert_eq!(pn.arena_bytes(N), pw.buf_base(2, N));
    // And still the same output.
    assert_eq!(run(&normal, 5).0, run(&watched, 5).0);
}
