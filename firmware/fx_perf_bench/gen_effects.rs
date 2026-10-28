//! Host build tool for the FX perf-study bench (docs/design/fx-perf-study.md):
//! compiles a list of `.fx` sources with the REAL fx_compiler and emits a Rust
//! module (`effects_gen.rs`) that embeds each `.fxb` plus its uniform defaults, so
//! the no_std C6 bench image can load them without a filesystem or a manifest
//! parser.
//!
//! usage: gen_effects <out.rs> <spec>...
//!   spec = <group>:<name>:<opt|noopt>:<leds>:<path.fx>
//!   group: study | agent | valid | micro   (what the bench does with it)
//!   leds:  0 = the group's default sweep, else a fixed LED count
//!
//! A spec whose source fails to compile is emitted with an empty `.fxb` and the
//! diagnostic in `err`, so one bad agent program never breaks the image.

use std::fmt::Write as _;

use splanc_fx_sig as sig;

fn bytes_lit(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 4);
    for x in b {
        let _ = write!(s, "{x},");
    }
    s
}

/// The header dev builds sign with: dev key, epoch 0, this crate's native ABI,
/// no minimum firmware, fleet scope.
fn dev_header(img: &ledmapper_fx_aot::Image) -> sig::Header {
    let entry = |o: Option<usize>| o.map(|v| v as u16).unwrap_or(sig::NO_ENTRY);
    sig::Header {
        key_id: sig::DEV_KEY_ID,
        key_epoch: 0,
        abi: ledmapper_fx_aot::NATIVE_ABI,
        flags: 0,
        min_fw: 0,
        scope: sig::SCOPE_FLEET,
        code_words: 0,
        op_code_len: 0,
        update_off: entry(img.update_off),
        shade_off: img.shade_off as u16,
        prep_off: entry(img.prep_off),
        tag: [0; sig::TAG_LEN],
    }
}

fn sign_img(img: &ledmapper_fx_aot::Image, fxb: &[u8], key: &[u8], h: sig::Header) -> Vec<u8> {
    let mut out = vec![0u8; sig::HEADER_LEN + 4 * img.code.len() + img.op_code.len()];
    let n = sig::build_into(&mut out, key, h, &img.code, &img.op_code, fxb).expect(".fxn too large");
    out.truncate(n);
    out
}

/// Signature test cases for the on-device check (device.rs `sig_pass`): one
/// study effect's image signed/tampered/relabelled several ways, each with the
/// reject reason the device must report (`ok` = runs native).
fn emit_sig_cases(
    out: &mut String,
    src: Option<(String, Vec<u8>, ledmapper_fx_aot::Image)>,
    other_fxb: Option<Vec<u8>>,
) {
    out.push_str("\n/// (case, effect, .fxn, use_other_fxb, expected reason)\n");
    out.push_str("pub static SIG_CASES: &[(&str, &str, &[u8], bool, &str)] = &[\n");
    let Some((name, fxb, img)) = src else {
        out.push_str("];\npub static SIG_OTHER_FXB: &[u8] = &[];\n");
        return;
    };
    let good = sign_img(&img, &fxb, &sig::DEV_KEY, dev_header(&img));
    let mut cases: Vec<(&str, Vec<u8>, bool, &str)> = vec![("good", good.clone(), false, "ok")];
    let mut b = good.clone();
    b[sig::HEADER_LEN + 1] ^= 0x01; // one bit of the first code word
    cases.push(("tamper_code", b, false, "bad_tag"));
    if !img.op_code.is_empty() {
        let mut b = good.clone();
        let last = b.len() - 1;
        b[last] ^= 0x80;
        cases.push(("tamper_op_code", b, false, "bad_tag"));
    }
    let mut b = good.clone();
    b[36] ^= 0x01; // the tag itself
    cases.push(("tamper_tag", b, false, "bad_tag"));
    // Validly signed for a newer firmware / another ABI -> gated before the tag.
    let mut h = dev_header(&img);
    h.min_fw = sig::fw_version(99, 0, 0).unwrap();
    let newer = sign_img(&img, &fxb, &sig::DEV_KEY, h);
    cases.push(("fw_too_old", newer.clone(), false, "fw_too_old"));
    let mut h = dev_header(&img);
    h.abi = ledmapper_fx_aot::NATIVE_ABI + 1;
    cases.push(("abi_mismatch", sign_img(&img, &fxb, &sig::DEV_KEY, h), false, "abi_unsupported"));
    // ... and relabelling those signed fields to values the device accepts.
    let mut b = newer;
    b[12..16].copy_from_slice(&0u32.to_le_bytes());
    cases.push(("relabel_min_fw", b, false, "bad_tag"));
    let mut b = good.clone();
    b[6] ^= 0x01; // key epoch 0 -> 1
    cases.push(("relabel_epoch", b, false, "bad_tag"));
    // Wrong key under the dev id; an id the device doesn't hold.
    cases.push(("wrong_key", sign_img(&img, &fxb, &[0x5a; 32], dev_header(&img)), false, "bad_tag"));
    let mut h = dev_header(&img);
    h.key_id = 7;
    cases.push(("unknown_key", sign_img(&img, &fxb, &[0x5a; 32], h), false, "unknown_key"));
    // The right blob checked against a different effect's bytecode.
    if other_fxb.is_some() {
        cases.push(("other_fxb", good, true, "bad_tag"));
    }
    for (case, blob, other, want) in &cases {
        let _ = writeln!(out, "    ({case:?}, {name:?}, &[{}], {other}, {want:?}),", bytes_lit(blob));
    }
    out.push_str("];\n");
    let _ = writeln!(out, "pub static SIG_OTHER_FXB: &[u8] = &[{}];", bytes_lit(&other_fxb.unwrap_or_default()));
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("usage: gen_effects <out.rs> <group:name:opt:leds:path>...");
        std::process::exit(2);
    }
    let mut out = String::new();
    out.push_str("// @generated by firmware/fx_perf_bench/gen_effects.rs — do not edit.\n");
    out.push_str("use crate::EffectDesc;\n\n");
    out.push_str("pub static EFFECTS: &[EffectDesc] = &[\n");
    let mut sig_case_src: Option<(String, Vec<u8>, ledmapper_fx_aot::Image)> = None;
    let mut other_fxb: Option<Vec<u8>> = None;
    for spec in &args[2..] {
        let parts: Vec<&str> = spec.splitn(5, ':').collect();
        if parts.len() != 5 {
            eprintln!("bad spec {spec}");
            std::process::exit(2);
        }
        let (group, name, opt, leds, path) = (parts[0], parts[1], parts[2], parts[3], parts[4]);
        let group_id = match group {
            "study" => 0,
            "agent" => 1,
            "valid" => 2,
            "micro" => 3,
            "user" => 4,
            _ => {
                eprintln!("bad group {group}");
                std::process::exit(2);
            }
        };
        let src = std::fs::read_to_string(path).unwrap_or_else(|e| panic!("read {path}: {e}"));
        let leds: u16 = leds.parse().expect("leds");
        let res = ledmapper_fx_compiler::compile_opts(&src, opt == "opt");
        let (fxb, uniforms, err) = match res {
            Ok(c) => (c.fxb, c.uniforms, String::new()),
            Err(d) => (Vec::new(), Vec::new(), format!("{d:?}")),
        };
        let mut u = String::new();
        for ui in &uniforms {
            let vals: Vec<String> = ui.default.iter().map(|v| format!("{v:?}f32")).collect();
            let _ = write!(u, "({}, &[{}]),", ui.slot, vals.join(","));
        }
        let mut bytes = String::with_capacity(fxb.len() * 5);
        for b in &fxb {
            let _ = write!(bytes, "{b},");
        }
        // AOT: lower the verified .fxb to RV32IM on the host and embed it as a
        // `.fxn` signed with the public DEV key (firmware/fx_sig) — what dev
        // builds do automatically — so the C6 bench authenticates it exactly
        // as a device would before copying the code into its exec region.
        // Unsupported programs embed an empty blob (VM fallback).
        let (aot_ok, aot_fxn) = match ledmapper_fx_vm::Program::parse(&fxb) {
            Ok(prog) => match ledmapper_fx_aot::lower(&prog) {
                Some(img) => {
                    // Never embed an image the sandbox verifier rejects.
                    if let Some(e) = img.verify() {
                        panic!("{name}: verifier rejected the lowered image: {e:?}");
                    }
                    let blob = sign_img(&img, &fxb, &sig::DEV_KEY, dev_header(&img));
                    if group == "study" && sig_case_src.is_none() {
                        sig_case_src = Some((name.to_string(), fxb.clone(), img));
                    }
                    (true, bytes_lit(&blob))
                }
                None => (false, String::new()),
            },
            Err(_) => (false, String::new()),
        };
        if group == "agent" && other_fxb.is_none() && !fxb.is_empty() {
            other_fxb = Some(fxb.clone());
        }
        let _ = writeln!(
            out,
            "    EffectDesc {{ name: {name:?}, group: {group_id}, leds: {leds}, opt: {}, fxb: &[{bytes}], uniforms: &[{u}], err: {err:?}, aot_ok: {aot_ok}, aot_fxn: &[{aot_fxn}] }},",
            opt == "opt"
        );
    }
    out.push_str("];\n");
    emit_sig_cases(&mut out, sig_case_src, other_fxb);
    std::fs::write(&args[1], out).expect("write out");
}
