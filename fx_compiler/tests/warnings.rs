//! Perf warnings (`Compiled::warnings`): the cheap form of an effect should be
//! the easy form, so the compiler points at soft-float the author didn't mean
//! (docs/design/fx-perf-study.md, Q2 "Make the cheap form the easy form").

use ledmapper_fx_compiler::compile;

fn warnings(src: &str) -> Vec<String> {
    compile(src).unwrap_or_else(|d| panic!("compile failed: {d:?}")).warnings.into_iter().map(|w| w.msg).collect()
}

fn shade(body: &str) -> String {
    format!("state fixed ph;\nvoid update() {{ ph = fract(ph + fixed(dt)); }}\nvec3 shade(Led led) {{\n{body}\n}}\n")
}

#[test]
fn float_literal_in_fixed_arithmetic_warns() {
    let w = warnings(&shade("  fixed x = fixed(led.s);\n  float v = float(x * 0.6);\n  return vec3(v, v, v);"));
    assert_eq!(w.len(), 1, "{w:?}");
    assert!(w[0].contains("float literal 0.6") && w[0].contains("fixed(0.6)"), "{}", w[0]);
    // Literal on the left, a negative literal, and a comparison too.
    let w = warnings(&shade(
        "  fixed x = fixed(led.s);\n  fixed y = fixed(0.25 + x);\n  fixed z = fixed(x * -2.5);\n  if (x < 0.5) { return vec3(1.0, 0.0, 0.0); }\n  return vec3(float(y), float(z), 0.0);",
    ));
    assert_eq!(w.len(), 3, "{w:?}");
    assert!(w[1].contains("-2.5"), "{w:?}");
}

#[test]
fn the_cheap_forms_are_silent() {
    // fixed() literals, int literals (promote to fixed), float maths on floats,
    // and float literals in update() (once per frame) don't warn.
    let src = "state fixed ph;\nvoid update() { ph = fract(ph + fixed(dt) * 0.5); }\nvec3 shade(Led led) {\n  fixed x = fixed(led.s) * fixed(0.6) + ph * 2;\n  float f = led.uv.y * 0.6;\n  return hsv2rgb(fract(x), fixed(0.9), fixed(1.0));\n}\n";
    assert!(warnings(src).is_empty(), "{:?}", warnings(src));
}

#[test]
fn builtin_with_fixed_and_float_literal_args_warns() {
    let w = warnings(&shade("  fixed h = fract(fixed(led.s) + ph);\n  return hsv2rgb(h, 0.9, 1.0);"));
    assert_eq!(w.len(), 1, "{w:?}");
    assert!(w[0].contains("hsv2rgb()") && w[0].contains("fixed(0.9)"), "{}", w[0]);
    let w = warnings(&shade("  fixed t = clamp(fixed(led.s) - ph, 0.0, fixed(1.0));\n  return vec3(float(t), 0.0, 0.0);"));
    assert_eq!(w.len(), 1, "{w:?}");
    assert!(w[0].contains("clamp()"), "{}", w[0]);
}

#[test]
fn helper_functions_count_as_per_led_code() {
    let src = "fixed half(fixed x) { return fixed(x * 0.5); }\nvec3 shade(Led led) { return vec3(float(half(fixed(led.s))), 0.0, 0.0); }\n";
    assert_eq!(warnings(src).len(), 1);
}

#[test]
fn pow_with_a_small_constant_exponent_warns() {
    let w = warnings("vec3 shade(Led led) {\n  float a = pow(led.s, 2.0);\n  float b = pow(led.s, 0.5);\n  float c = pow(led.s, 2.7);\n  return vec3(a, b, c);\n}\n");
    assert_eq!(w.len(), 2, "{w:?}");
    assert!(w[0].contains("x * x") && w[1].contains("sqrt(x)"), "{w:?}");
}

#[test]
fn warnings_carry_the_source_position() {
    let c = compile(&shade("  fixed x = fixed(led.s);\n  return vec3(float(x * 0.6), 0.0, 0.0);")).unwrap();
    let w = &c.warnings[0];
    // Same 1-based line/col as compile errors: line 5 holds the `*`.
    assert_eq!(w.line, 5, "{w:?}");
    assert!(w.col > 0);
}
