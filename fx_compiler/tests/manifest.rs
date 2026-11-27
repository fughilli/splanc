//! The uniform manifest an agent reads (embedded in the `.fxb`, echoed by
//! get_effect_uniforms): doc strings from comments, explicit ranges, units, and
//! the `.fxb` format version the device checks.

use ledmapper_fx_compiler::{compile, FXB_FORMAT_V1, FXB_FORMAT_VERSION, MAX_UNIFORM_DOC};
use ledmapper_fx_vm::Program;

const SRC: &str = r#"
// How heavy the rain is.
// 0 = dry, 1 = a downpour.
uniform float rain : 0..1 = 0.2;
uniform float speed : 0..5 "m/s" = 1.0; // Drift speed of the "mist" layer.
uniform vec3 tint : color = 0.2, 0.6, 1.0;

uniform bool lightning = false;
uniform int mode : {"calm", "storm", "monsoon"} = 0;
vec3 shade(Led led) { return tint * rain * speed; }
"#;

fn manifest(src: &str) -> serde_json::Value {
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {d:?}"));
    let prog = Program::parse(&c.fxb).expect("the device VM accepts the .fxb");
    serde_json::from_slice(prog.manifest).expect("embedded manifest is valid JSON")
}

fn by_name<'a>(m: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    m.as_array().unwrap().iter().find(|u| u["name"] == name).unwrap_or_else(|| panic!("{name}"))
}

#[test]
fn doc_strings_come_from_comments() {
    let m = manifest(SRC);
    // The own-line comment block directly above, joined.
    assert_eq!(by_name(&m, "rain")["doc"], "How heavy the rain is. 0 = dry, 1 = a downpour.");
    // A trailing comment on the declaration's line wins; quotes are escaped.
    assert_eq!(by_name(&m, "speed")["doc"], "Drift speed of the \"mist\" layer.");
    // A blank line separates `lightning` from any comment above: no doc.
    assert!(by_name(&m, "lightning").get("doc").is_none());
    assert!(by_name(&m, "tint").get("doc").is_none(), "a trailing comment belongs to its own line only");
}

#[test]
fn every_uniform_states_its_range_and_unit() {
    let m = manifest(SRC);
    assert_eq!((by_name(&m, "rain")["min"].as_f64(), by_name(&m, "rain")["max"].as_f64()), (Some(0.0), Some(1.0)));
    assert_eq!(by_name(&m, "speed")["max"].as_f64(), Some(5.0));
    assert_eq!(by_name(&m, "speed")["unit"], "m/s");
    assert!(by_name(&m, "rain").get("unit").is_none());
    assert_eq!(by_name(&m, "tint")["max"].as_f64(), Some(1.0));
    assert_eq!(by_name(&m, "lightning")["max"].as_f64(), Some(1.0));
    assert_eq!(by_name(&m, "mode")["max"].as_f64(), Some(2.0), "dropdown: 0..n_options-1");
    // The existing fields are untouched.
    assert_eq!(by_name(&m, "speed")["ui"]["kind"], "slider");
    assert_eq!(by_name(&m, "tint")["width"], 3);
}

#[test]
fn long_docs_are_truncated_in_the_embedded_manifest() {
    let long = "x".repeat(MAX_UNIFORM_DOC * 3);
    let src = format!("// {long}\nuniform float a = 0.5;\nvec3 shade(Led led) {{ return vec3(a); }}\n");
    let m = manifest(&src);
    assert_eq!(by_name(&m, "a")["doc"].as_str().unwrap().len(), MAX_UNIFORM_DOC);
}

#[test]
fn the_devices_port_scanner_still_resolves_every_uniform() {
    // ledmapper_osc::parse_manifest (the firmware's name -> slot table) is a
    // tolerant scanner, not a JSON parser: the new fields must not confuse it.
    let c = compile(SRC).unwrap();
    let prog = Program::parse(&c.fxb).unwrap();
    let table = ledmapper_osc::parse_manifest(prog.manifest);
    let m = manifest(SRC);
    for u in &c.uniforms {
        let p = table.resolve(&u.name).unwrap_or_else(|| panic!("{} unresolved", u.name));
        let width = by_name(&m, &u.name)["width"].as_u64().unwrap() as u8;
        assert_eq!((p.slot, p.width), (u.slot as u16, width));
    }
}

#[test]
fn the_compiler_emits_the_format_the_vm_runs() {
    assert_eq!(FXB_FORMAT_VERSION, ledmapper_fx_vm::FORMAT_VERSION);
    let c = compile(SRC).unwrap();
    // D-557: an effect with no newer widget kind keeps format 1, so firmware
    // from before the bump still loads it.
    assert_eq!(c.fxb[4], FXB_FORMAT_V1);
    assert_eq!(ledmapper_fx_vm::MIN_FORMAT_VERSION, FXB_FORMAT_V1);
    assert!(Program::parse(&c.fxb).is_ok());
    // An .fxb claiming a newer format (or format 0) is refused (bad_fxb).
    let mut other = c.fxb.clone();
    other[4] = FXB_FORMAT_VERSION + 1;
    assert!(Program::parse(&other).is_err());
    other[4] = 0;
    assert!(Program::parse(&other).is_err());
}

fn compile_err(src: &str) -> String {
    match compile(src) {
        Ok(_) => panic!("expected a compile error"),
        Err(d) => format!("{d:?}"),
    }
}

#[test]
fn sliders_default_to_the_uniforms_native_precision() {
    // D-541: uniform values ride the wire and flash as f32, so a float slider
    // is continuous (step 0 = no snap in the app, MIDI or keypoint blend), an
    // int steps by whole numbers and a fixed type by its LSB. No 101-step grid.
    let m = manifest(
        r#"
uniform float f : 0..5 = 1.0;
uniform float plain = 0.5;
uniform int n : 0..10 = 3;
uniform int bare = 0;
uniform fixed8 q : -1..1 = 0.0;
uniform vec3 dir : -1..1 = 0, 1, 0;
vec3 shade(Led led) { return dir * f * plain * float(n + bare) * float(q); }
"#,
    );
    let step = |name: &str| by_name(&m, name)["ui"]["step"].as_f64().unwrap();
    assert_eq!(step("f"), 0.0);
    assert_eq!(step("plain"), 0.0);
    assert_eq!(step("n"), 1.0);
    assert_eq!(step("bare"), 1.0);
    assert_eq!(step("q"), 1.0 / 64.0, "fixed8 is Q1.6");
    assert_eq!(step("dir"), 0.0);
}

#[test]
fn an_explicit_step_annotation_sets_the_grid() {
    let m = manifest(
        r#"
uniform float n : 0..8 step 0.5 "beats" = 2.0;
uniform int k : 0..100 step 5 = 10;
uniform float c : 0..1 step 0 = 0.5;
uniform vec2 p : vec2(-1, 0) .. vec2(1, 2) step 0.25 = 0.0;
vec3 shade(Led led) { return vec3(n * float(k) * c * p.x); }
"#,
    );
    let step = |name: &str| by_name(&m, name)["ui"]["step"].as_f64().unwrap();
    assert_eq!(step("n"), 0.5);
    assert_eq!(by_name(&m, "n")["unit"], "beats", "the unit string still follows the annotation");
    assert_eq!(step("k"), 5.0);
    assert_eq!(step("c"), 0.0);
    assert_eq!(step("p"), 0.25);
    let shade = "vec3 shade(Led led) { return vec3(0.0); }";
    assert!(compile_err(&format!("uniform float x : 0..1 step -1 = 0.0;\n{shade}")).contains("positive"));
    assert!(compile_err(&format!("uniform int x : 0..9 step 0.5 = 0;\n{shade}")).contains("whole number"));
    assert!(compile_err(&format!("uniform float x : 0..1 step = 0.0;\n{shade}")).contains("after `step`"));
}
