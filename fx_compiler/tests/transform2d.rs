//! D-541 PR 10 (D-556): `uniform mat3 x : transform2d` marks a mat3 as a 2D
//! homogeneous affine transform (the app's flat Move / Rotate / Scale gizmo);
//! a plain mat3 stays a 3D rotation / linear transform (`ui.kind: matrix`).
//! The new kind rides the SAME `.fxb` format 2 as `vector` / `direction`
//! (D-557: one bump, batched widget kinds).

use ledmapper_fx_compiler::{compile, fxb_format_for, UiKind, FXB_FORMAT_V1, FXB_FORMAT_V2, FXB_FORMAT_VERSION};
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
fn transform2d_annotation_forms() {
    let src = format!(
        r#"
uniform mat3 xf : transform2d;
uniform mat3 uv : transform2d -4 .. 4 = mat3(2, 0, 0, 0, 2, 0, 0.5, -0.5, 1);
uniform mat3 rot;
{SHADE}"#
    );
    let c = compile(&src).unwrap();
    let xf = c.uniforms.iter().find(|u| u.name == "xf").unwrap();
    assert_eq!(xf.ui, UiKind::Transform2d { min: -1000.0, max: 1000.0 }, "no range: the matrix default");
    let m = manifest(&src);
    let xf = by_name(&m, "xf");
    assert_eq!(xf["ui"]["kind"], "transform2d");
    assert_eq!(xf["width"], 9);
    assert_eq!(nums(&xf["default"]), vec![1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0], "identity default");
    let uv = by_name(&m, "uv");
    assert_eq!((uv["ui"]["min"].as_f64(), uv["ui"]["max"].as_f64()), (Some(-4.0), Some(4.0)));
    assert_eq!((uv["min"].as_f64(), uv["max"].as_f64()), (Some(-4.0), Some(4.0)));
    // Column-major: the translation is column 2.
    assert_eq!(nums(&uv["default"])[6..8], [0.5, -0.5]);
    // A plain mat3 is still a matrix (3D rotation / linear, D-556).
    assert_eq!(by_name(&m, "rot")["ui"]["kind"], "matrix");
}

#[test]
fn transform2d_is_mat3_only() {
    assert!(err_of(&format!("uniform mat4 q : transform2d;\n{SHADE}")).contains("mat3"));
    assert!(err_of(&format!("uniform vec3 q : transform2d = vec3(0);\n{SHADE}")).contains("mat3"));
    assert!(err_of(&format!("uniform mat3 q : transform2d 2 .. -2;\n{SHADE}")).contains("must not exceed"));
}

#[test]
fn transform2d_rides_format_2_without_another_bump() {
    assert_eq!(FXB_FORMAT_VERSION, FXB_FORMAT_V2, "D-557: still one bump");
    let plain = compile(&format!("uniform mat3 m;\nuniform mat4 p;\n{SHADE}")).unwrap();
    assert_eq!(plain.fxb[4], FXB_FORMAT_V1, "plain matrices stay format 1");
    let c = compile(&format!("uniform mat3 m : transform2d;\n{SHADE}")).unwrap();
    assert_eq!(c.fxb[4], FXB_FORMAT_V2);
    assert_eq!(fxb_format_for(&c.uniforms), FXB_FORMAT_V2);
    assert!(Program::parse(&c.fxb).is_ok());
}

#[test]
fn transform2d_is_usable_as_a_mat3() {
    // The annotation is UI only: the program sees an ordinary mat3.
    let src = r#"
uniform mat3 xf : transform2d = mat3(1, 0, 0, 0, 1, 0, 0.25, 0, 1);
vec3 shade(Led led) { vec3 p = xf * vec3(led.pos.x, led.pos.y, 1.0); return vec3(p.x, p.y, 0.0); }
"#;
    assert!(compile(src).is_ok());
}

#[test]
fn firmware_keypoints_read_transform2d() {
    let src = format!("uniform mat3 xf : transform2d -2 .. 2;\nuniform mat3 rot;\n{SHADE}");
    let c = compile(&src).unwrap();
    let prog = Program::parse(&c.fxb).unwrap();
    let r = Rules::parse(prog.manifest);
    let rs = r.rules();
    assert_eq!((rs[0].kind, rs[0].width, rs[0].min, rs[0].max), (Kind::Transform2d, 9, -2.0, 2.0));
    assert_eq!(rs[1].kind, Kind::Other, "a plain matrix lerps as before");
}
