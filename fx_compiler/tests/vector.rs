//! D-541 PR 4: `: vector` and `: direction` uniforms (the XY pad / direction
//! dial in the app), their manifest, and the `.fxb` format they are stamped
//! with (D-557: format 2 only when a newer widget kind is used).

use ledmapper_fx_compiler::{compile, fxb_format_for, UiKind, FXB_FORMAT_V1, FXB_FORMAT_V2};
use ledmapper_fx_vm::Program;
use ledmapper_keypoint::{Kind, Rules};

const SHADE: &str = "vec3 shade(Led led) { return vec3(0.0); }";

fn manifest(src: &str) -> serde_json::Value {
    let c = compile(src).unwrap_or_else(|d| panic!("compile error: {d:?}"));
    let prog = Program::parse(&c.fxb).expect("the device VM accepts the .fxb");
    serde_json::from_slice(prog.manifest).expect("embedded manifest is valid JSON")
}

fn by_name<'a>(m: &'a serde_json::Value, name: &str) -> &'a serde_json::Value {
    m.as_array().unwrap().iter().find(|u| u["name"] == name).unwrap_or_else(|| panic!("{name}"))
}

fn nums(v: &serde_json::Value) -> Vec<f64> {
    v.as_array().expect("array").iter().map(|x| x.as_f64().unwrap()).collect()
}

fn err_of(src: &str) -> String {
    match compile(src) {
        Ok(_) => panic!("expected a compile error for:\n{src}"),
        Err(d) => d[0].msg.clone(),
    }
}

#[test]
fn vector_annotation_forms() {
    let src = format!(
        r#"
uniform vec2 wind : vector = vec2(0.5, 0);
uniform vec2 drift : vector -3 .. 3 step 0.5 "m/s" = vec2(1, -1);
uniform vec3 aim : vector vec3(-1, -1, 0) .. vec3(1, 1, 2) = vec3(0, 0, 1);
{SHADE}"#
    );
    let m = manifest(&src);
    let wind = by_name(&m, "wind");
    assert_eq!(wind["ui"]["kind"], "vector");
    assert_eq!((wind["ui"]["min"].as_f64(), wind["ui"]["max"].as_f64()), (Some(-1.0), Some(1.0)));
    assert_eq!(wind["ui"]["step"].as_f64(), Some(0.0), "float vector: continuous");
    assert_eq!((wind["min"].as_f64(), wind["max"].as_f64()), (Some(-1.0), Some(1.0)));
    let drift = by_name(&m, "drift");
    assert_eq!(drift["ui"]["step"].as_f64(), Some(0.5));
    assert_eq!(drift["unit"], "m/s");
    assert_eq!(nums(&drift["default"]), vec![1.0, -1.0]);
    let aim = by_name(&m, "aim");
    assert_eq!(aim["ui"]["kind"], "vector");
    assert_eq!(nums(&aim["mins"]), vec![-1.0, -1.0, 0.0]);
    assert_eq!(nums(&aim["maxs"]), vec![1.0, 1.0, 2.0]);
    assert_eq!((aim["min"].as_f64(), aim["max"].as_f64()), (Some(-1.0), Some(2.0)), "envelope");
}

#[test]
fn direction_is_unit_length() {
    let src = format!(
        r#"
uniform vec3 sun : direction = vec3(3, 0, 4);
uniform vec2 heading : direction;
{SHADE}"#
    );
    let c = compile(&src).unwrap();
    let sun = c.uniforms.iter().find(|u| u.name == "sun").unwrap();
    assert_eq!(sun.ui, UiKind::Direction);
    assert_eq!(sun.default, vec![0.6, 0.0, 0.8], "the default is normalised");
    let m = manifest(&src);
    assert_eq!(by_name(&m, "sun")["ui"]["kind"], "direction");
    assert_eq!((by_name(&m, "sun")["min"].as_f64(), by_name(&m, "sun")["max"].as_f64()), (Some(-1.0), Some(1.0)));
    assert_eq!(nums(&by_name(&m, "heading")["default"]), vec![0.0, 1.0], "no default: +y");
}

#[test]
fn vector_and_direction_are_vec2_or_vec3_only() {
    assert!(err_of(&format!("uniform vec4 q : vector = vec4(0);\n{SHADE}")).contains("vec2 or vec3"));
    assert!(err_of(&format!("uniform float q : direction = 1.0;\n{SHADE}")).contains("vec2 or vec3"));
    assert!(err_of(&format!("uniform mat3 q : vector;\n{SHADE}")).contains("vec2 or vec3"));
    assert!(err_of(&format!("uniform vec3 d : direction = vec3(0);\n{SHADE}")).contains("zero vector"));
    assert!(err_of(&format!("uniform vec2 v : vector 1 .. -1 = vec2(0);\n{SHADE}")).contains("must not exceed"));
}

#[test]
fn format_2_only_when_a_new_widget_is_used() {
    let plain = compile(&format!("uniform vec3 p : -1 .. 1 = vec3(0);\nuniform vec3 c : color = vec3(1);\n{SHADE}")).unwrap();
    assert_eq!(plain.fxb[4], FXB_FORMAT_V1);
    assert_eq!(fxb_format_for(&plain.uniforms), FXB_FORMAT_V1);
    for decl in ["uniform vec2 v : vector = vec2(0);", "uniform vec3 d : direction = vec3(0, 0, 1);"] {
        let c = compile(&format!("{decl}\n{SHADE}")).unwrap();
        assert_eq!(c.fxb[4], FXB_FORMAT_V2, "{decl}");
        // This VM runs it; firmware from before the bump (which accepted only
        // format 1) answers bad_fxb instead of mishandling the control.
        assert!(Program::parse(&c.fxb).is_ok());
        assert_ne!(c.fxb[4], 1, "pre-bump firmware refuses it");
    }
}

#[test]
fn firmware_keypoints_read_the_compiled_kinds() {
    let src = format!(
        r#"
uniform vec2 wind : vector -2 .. 2 = vec2(0);
uniform vec3 sun : direction = vec3(0, 1, 0);
{SHADE}"#
    );
    let c = compile(&src).unwrap();
    let prog = Program::parse(&c.fxb).unwrap();
    let r = Rules::parse(prog.manifest);
    let rs = r.rules();
    assert_eq!((rs[0].kind, rs[0].min, rs[0].max), (Kind::Vector, -2.0, 2.0));
    assert_eq!((rs[1].kind, rs[1].width, rs[1].min, rs[1].max), (Kind::Direction, 3, -1.0, 1.0));
}
