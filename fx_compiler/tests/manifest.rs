//! The uniform manifest an agent reads (embedded in the `.fxb`, echoed by
//! get_effect_uniforms): doc strings from comments, explicit ranges, units, and
//! the `.fxb` format version the device checks.

use ledmapper_fx_compiler::{compile, FXB_FORMAT_VERSION, MAX_UNIFORM_DOC};
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
    assert_eq!(c.fxb[4], ledmapper_fx_vm::FORMAT_VERSION);
    // An .fxb claiming another format is refused (the firmware answers bad_fxb).
    let mut other = c.fxb.clone();
    other[4] = FXB_FORMAT_VERSION + 1;
    assert!(Program::parse(&other).is_err());
}
