//! The effect runtime's embedded number types on the device. The documented
//! effect system lets a script run in reduced-precision fixed point (`fixed8` /
//! `fixed16`, integer transcendentals, fixed colour output) and keep narrow
//! integer per-LED state (`int16` buffers), so effects avoid the FPU-less C6's
//! soft-float. Those programs rely on the firmware runtime building the
//! fixed-point context itself (Q16.16 LED position and time mirrors, made only
//! when a program reads them). These tests compile such effects and run them
//! through the player's C ABI exactly as the render loop does, against float
//! twins of the same effects.
//!
//! The FFI state is process-global (one player, as on the device), so every
//! test re-initializes it and the target runs with `--test-threads=1`.

use ledmapper_fx_compiler::{compile, disassemble};
use ledmapper_player_ffi::{
    lm_fx_clear, lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update, lm_player_init,
};

const LEDS: u32 = 48;

/// The soft-float compute/colour opcodes (fx_compiler disassembly mnemonics);
/// an all-fixed program must contain none of them.
const SOFT_FLOAT_OPS: &[&str] = &[
    "ADD n=", "SUB n=", "MUL n=", "DIV n=", "UN_MATH", "BIN_MATH", "HSV2RGB\n", "FIX_TO_F",
    "FIX_FROM_F", "I2F", "F2I", "LOAD_CTX ",
];

fn fxb(src: &str) -> Vec<u8> {
    compile(src).unwrap_or_else(|d| panic!("effect compiles: {d:?}")).fxb
}

/// Render `frames` frames of `fxb` over a strip whose LEDs sit along x in [0, 1)
/// and return every frame's colours.
fn render(fxb: &[u8], frames: u32) -> Vec<Vec<[u8; 3]>> {
    lm_player_init(LEDS);
    unsafe { lm_fx_clear() };
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    let mut out = Vec::new();
    for f in 0..frames {
        let t = f as f32 * 0.137;
        assert!(unsafe { lm_fx_update(t, 0.137, f, LEDS) });
        let colours = (0..LEDS)
            .map(|i| {
                let mut rgb = [0u8; 3];
                let x = i as f32 / LEDS as f32;
                assert!(unsafe { lm_fx_shade(i, x, 0.5, 0.0, rgb.as_mut_ptr()) }, "led {i} renders");
                rgb
            })
            .collect();
        out.push(colours);
    }
    out
}

fn max_channel_diff(a: &[Vec<[u8; 3]>], b: &[Vec<[u8; 3]>]) -> i32 {
    a.iter()
        .flatten()
        .zip(b.iter().flatten())
        .flat_map(|(p, q)| (0..3).map(move |k| (p[k] as i32 - q[k] as i32).abs()))
        .max()
        .unwrap_or(0)
}

#[test]
fn an_all_fixed_effect_renders_on_the_device_like_its_float_twin() {
    rr::verifies!("PR-17");
    // An animated hue plasma written entirely in fixed16: inputs (LED position,
    // time), maths and colour output never touch float.
    let fixed = fxb("vec3 shade(Led led) {\n\
           fixed16 h = fract(fixed16(led.pos.x) + fixed16(time) * fixed16(0.25));\n\
           return hsv2rgb(h, fixed16(1.0), fixed16(1.0));\n}\n");
    let asm = disassemble(&fixed);
    for op in SOFT_FLOAT_OPS {
        assert!(!asm.contains(op), "the fixed effect has no `{op}`:\n{asm}");
    }
    let float = fxb("vec3 shade(Led led) {\n\
           float h = fract(led.pos.x + time * 0.25);\n\
           return hsv2rgb(h, 1.0, 1.0);\n}\n");
    let (f, g) = (render(&fixed, 6), render(&float, 6));
    // Non-trivial: the strip shows a spread of hues that moves with time.
    assert_ne!(f[0], f[5], "the plasma animates");
    assert!(f[0].iter().any(|c| c[0] > 200) && f[0].iter().any(|c| c[2] > 200), "a spread of hues");
    let d = max_channel_diff(&f, &g);
    assert!(d <= 3, "fixed16 tracks the float twin within 3/255 on every channel (max diff {d})");
}

#[test]
fn integer_transcendentals_run_on_the_device_like_the_float_maths() {
    rr::verifies!("PR-17");
    // sin/cos of a fixed16 angle (in turns) take the integer LUT path.
    let fixed = fxb("vec3 shade(Led led) {\n\
           fixed16 a = fixed16(led.pos.x);\n\
           float s = float(sin(a)) * 0.5 + 0.5;\n\
           float c = float(cos(a)) * 0.5 + 0.5;\n\
           return vec3(s, c, 0.0);\n}\n");
    let asm = disassemble(&fixed);
    assert!(!asm.contains("UN_MATH sin") && !asm.contains("UN_MATH cos"), "integer path:\n{asm}");
    let float = fxb("vec3 shade(Led led) {\n\
           float a = led.pos.x * 6.2831853;\n\
           return vec3(sin(a) * 0.5 + 0.5, cos(a) * 0.5 + 0.5, 0.0);\n}\n");
    let (f, g) = (render(&fixed, 1), render(&float, 1));
    let d = max_channel_diff(&f, &g);
    assert!(d <= 3, "integer sin/cos within 3/255 of the float maths over a full turn (max diff {d})");
}

#[test]
fn narrow_integer_buffers_keep_per_led_counters_across_frames() {
    rr::verifies!("PR-17");
    // An int16 per-LED counter: each LED adds its own index every frame.
    let counter = fxb("buffer int16 n;\n\
           vec3 shade(Led led) {\n\
             int v = n[led.idx] + led.idx;\n\
             n[led.idx] = v;\n\
             return rgb8(v % 256, v / 256, 0);\n}\n");
    let frames = render(&counter, 7);
    for (i, c) in frames[6].iter().enumerate() {
        let v = 7 * i as i32; // 7 frames x the LED's index
        assert_eq!(*c, [(v % 256) as u8, (v / 256) as u8, 0], "led {i} counted to {v}");
    }
}
