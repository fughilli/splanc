//! Coverage of the language reference table (src/lang.rs, desk D-552).
//!
//! The compiler has no list of its own vocabulary: built-ins are `match` arms,
//! keywords are `kw == "..."` tests. So the coverage test probes it. Every
//! identifier-shaped string literal in the compiler's sources is a candidate;
//! each candidate is dropped into a set of probe programs (top level, statement,
//! expression, call, member access, uniform type and annotation, buffer element
//! and storage, `else`, parameter type, export type, function name) and compared
//! with the same probe holding a nonsense name. A candidate the compiler treats
//! differently from the nonsense name in any position is a word it knows, and
//! must have a table entry. The reverse holds too: every keyword, type,
//! context, member, built-in and entry point in the table must be known.

use ledmapper_fx_compiler::compile;
use ledmapper_fx_compiler::lang::{language_ts, Kind, Scope, LANG};
use std::collections::BTreeSet;

const SOURCES: &[&str] = &[
    include_str!("../src/lib.rs"),
    include_str!("../src/lang.rs"),
    include_str!("../src/lint.rs"),
    include_str!("../src/memo.rs"),
    include_str!("../src/opt.rs"),
];

const GENERATED_TS: &str = include_str!("../../web/src/effects/editor/lang-table.gen.ts");

/// Names the compiler reacts to that intentionally have no entry, with why.
const NOT_DOCUMENTED: &[(&str, &str)] = &[];

const NONCE: &str = "zq_nonce_word";

const SHADE_END: &str = "return vec3(0.0); }";

/// Probe programs; `@` is replaced by the candidate.
fn probes() -> Vec<String> {
    let shade = |body: &str| format!("vec3 shade(Led led) {{ {body} {SHADE_END}");
    let p = vec![
        format!("@ qq_a;\n{}", shade("")),
        shade("@;"),
        shade("float qq_a = @;"),
        shade("float qq_a = @();"),
        shade("float qq_a = @(1.0);"),
        format!("uniform @ qq_u;\n{}", shade("")),
        format!("uniform float qq_u : @ = 0.0;\n{}", shade("")),
        format!("buffer @ qq_b;\n{}", shade("")),
        format!("buffer float qq_b : @;\n{}", shade("")),
        shade("if (true) { } @ { }"),
        format!("vec3 shade(@ led) {{ {SHADE_END}"),
        "export @ qq_e;\nvoid poll() { }".to_string(),
        format!("void @() {{ }}\n{}", shade("")),
        format!("void @(float qq_p) {{ }}\n{}", shade("")),
        format!("vec3 @(Led led) {{ {SHADE_END}"),
    ];
    p
}

/// A probe's observable outcome: the bytecode + manifest on success, else the
/// diagnostic messages.
fn outcome(src: &str) -> String {
    match compile(src) {
        Ok(c) => format!("ok {:?} {}", c.fxb, ledmapper_fx_compiler::manifest_json(&c.uniforms)),
        Err(ds) => {
            let msgs: Vec<String> = ds.iter().map(|d| d.msg.clone()).collect();
            format!("err {}", msgs.join(" | "))
        }
    }
}

/// Whether `probe` (with `@`) treats `name` differently from an unknown word:
/// the nonce's outcome, with the nonce spelled as `name`, is what an unknown
/// `name` would give.
fn differs(probe: &str, name: &str) -> Option<String> {
    let base = outcome(&probe.replace('@', NONCE)).replace(NONCE, name);
    let got = outcome(&probe.replace('@', name));
    (got != base).then(|| format!("probe {probe:?}: {got}"))
}

/// Whether the compiler treats `name` differently from an unknown word anywhere.
fn compiler_knows(name: &str) -> Option<String> {
    probes().iter().find_map(|p| differs(p, name))
}

fn is_ident(s: &str) -> bool {
    let mut cs = s.chars();
    matches!(cs.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// Every identifier-shaped string literal in the compiler's sources.
fn candidates() -> BTreeSet<String> {
    let mut out = BTreeSet::new();
    for src in SOURCES {
        let b = src.as_bytes();
        let mut i = 0;
        while i < b.len() {
            if b[i] == b'"' && (i == 0 || b[i - 1] != b'\\' && b[i - 1] != b'\'') {
                let start = i + 1;
                let mut j = start;
                while j < b.len() && b[j] != b'"' && b[j] != b'\n' {
                    if b[j] == b'\\' {
                        j += 1;
                    }
                    j += 1;
                }
                if j < b.len() && b[j] == b'"' {
                    let lit = &src[start..j];
                    if is_ident(lit) {
                        out.insert(lit.to_string());
                    }
                    i = j + 1;
                    continue;
                }
            }
            i += 1;
        }
    }
    out
}

fn documented(name: &str) -> bool {
    LANG.iter().any(|e| e.name == name) || NOT_DOCUMENTED.iter().any(|(n, _)| *n == name)
}

#[test]
fn every_word_the_compiler_knows_has_an_entry() {
    let cands = candidates();
    assert!(cands.contains("smoothstep") && cands.contains("uniform"), "candidate scan broke");
    let mut missing = Vec::new();
    for name in &cands {
        if documented(name) {
            continue;
        }
        if let Some(why) = compiler_knows(name) {
            missing.push(format!("{name}  ({why})"));
        }
    }
    // Context members: probe `ns.field` for every candidate field.
    for ns in ["led", "imu", "room"] {
        for field in &cands {
            let full = format!("{ns}.{field}");
            if documented(&full) {
                continue;
            }
            let probe = format!("vec3 shade(Led led) {{ float qq_a = {ns}.@; {SHADE_END}");
            if let Some(why) = differs(&probe, field) {
                missing.push(format!("{full}  ({why})"));
            }
        }
    }
    assert!(
        missing.is_empty(),
        "the compiler knows these names but fx_compiler/src/lang.rs has no entry for them \
         (add one, then regenerate the web table):\n  {}",
        missing.join("\n  ")
    );
}

/// The probes themselves: known words of every kind are detected, a nonsense
/// word is not (guards against a probe set that silently detects nothing).
#[test]
fn probes_detect_known_words() {
    for w in ["sin", "rgb8", "transform", "gpio_read", "uniform", "else", "shared", "mat4", "int8", "trigger", "color", "time", "room", "Led", "shade", "update", "init", "poll", "true"] {
        assert!(compiler_knows(w).is_some(), "probes should detect `{w}`");
    }
    for w in ["zz_not_a_word", "speed", "pos", "x"] {
        assert!(compiler_knows(w).is_none(), "probes should not flag `{w}`: {:?}", compiler_knows(w));
    }
}

#[test]
fn every_entry_is_known_to_the_compiler() {
    let mut stale = Vec::new();
    for e in LANG {
        let known = match e.kind {
            Kind::Member => {
                let (ns, field) = e.name.split_once('.').expect("member names are ctx.field");
                let probe = format!("vec3 shade(Led led) {{ float qq_a = {ns}.@; {SHADE_END}");
                differs(&probe, field).is_some()
            }
            Kind::Keyword | Kind::Type | Kind::Context | Kind::Builtin | Kind::Entry => {
                compiler_knows(e.name).is_some()
            }
            // `color` is an identifier; the other annotations and the syntax
            // entries are punctuation, covered by their examples compiling.
            Kind::Annotation if e.name == "color" => compiler_knows(e.name).is_some(),
            Kind::Annotation | Kind::Syntax => true,
        };
        if !known {
            stale.push(e.name);
        }
    }
    assert!(stale.is_empty(), "lang.rs documents names the compiler does not know: {stale:?}");
}

#[test]
fn names_are_unique_and_entries_complete() {
    let mut seen = BTreeSet::new();
    for e in LANG {
        assert!(seen.insert(e.name), "duplicate entry {}", e.name);
        assert!(!e.summary.is_empty(), "{}: no summary", e.name);
        assert!(!e.doc.is_empty(), "{}: no doc", e.name);
        assert!(!e.example.is_empty(), "{}: no example", e.name);
        assert!(!e.category.is_empty(), "{}: no category", e.name);
        if matches!(e.kind, Kind::Builtin) {
            assert!(!e.sigs.is_empty(), "{}: a builtin needs a signature", e.name);
            for s in e.sigs {
                assert!(s.starts_with(&format!("{}(", e.name)), "{}: signature {s:?}", e.name);
            }
        }
        for r in e.related {
            assert!(LANG.iter().any(|x| x.name == *r), "{}: related {r:?} has no entry", e.name);
        }
    }
    // The ones the owner asked for by name.
    for n in ["mat3", "mat4", "transpose", "transform", "rgb", "rgb8", "palette0", "gpio_read", "gpio_mode", "i2c_read8"] {
        assert!(LANG.iter().any(|e| e.name == n), "{n} must be documented");
    }
}

/// The compiler's type for a context or member: assigning it to a `mat4` local
/// fails with "type mismatch: <Ty> vs Mat4" (no context is a matrix).
fn compiler_type(expr: &str) -> String {
    let src = format!("vec3 shade(Led led) {{ mat4 qq_m = {expr}; {SHADE_END}");
    let err = compile(&src).err().expect("assigning a context to a mat4 must fail");
    let msg = &err[0].msg;
    let rest = msg.strip_prefix("type mismatch: ").unwrap_or_else(|| panic!("{expr}: {msg}"));
    rest.split(" vs ").next().unwrap().to_lowercase()
}

#[test]
fn context_types_match_the_compiler() {
    for e in LANG.iter().filter(|e| matches!(e.kind, Kind::Member) || (e.kind == Kind::Context && !e.ty.is_empty())) {
        if e.ty == "Led" {
            continue;
        }
        assert_eq!(compiler_type(e.name), e.ty, "{}: the table's type differs from the compiler's", e.name);
    }
}

/// Examples are whole programs (with `shade(` or `poll(`) or snippets valid
/// inside shade(); all compile without a single warning (so none multiplies
/// `time` by a rate uniform: that is the integrator lint).
#[test]
fn every_example_compiles_warning_free() {
    let mut bad = Vec::new();
    for e in LANG {
        let src = if e.example.contains("shade(") || e.example.contains("poll(") {
            e.example.to_string()
        } else {
            format!("vec3 shade(Led led) {{\n{}\n{SHADE_END}", e.example)
        };
        match compile(&src) {
            Ok(c) if c.warnings.is_empty() => {}
            Ok(c) => bad.push(format!("{}: warnings {:?}", e.name, c.warnings.iter().map(|w| &w.msg).collect::<Vec<_>>())),
            Err(ds) => bad.push(format!("{}: {:?}\n{src}", e.name, ds.iter().map(|d| (d.line, &d.msg)).collect::<Vec<_>>())),
        }
    }
    assert!(bad.is_empty(), "examples that do not compile cleanly:\n{}", bad.join("\n"));
}

#[test]
fn rate_examples_integrate_in_update() {
    for e in LANG {
        let flat: String = e.example.chars().filter(|c| !c.is_whitespace()).collect();
        for rate in ["speed", "rate", "spin"] {
            assert!(
                !flat.contains(&format!("time*{rate}")) && !flat.contains(&format!("{rate}*time")),
                "{}: integrate `{rate}` in update() (ph = fract(ph + dt * {rate})), never time * {rate}",
                e.name
            );
        }
    }
}

#[test]
fn scopes_are_consistent() {
    for e in LANG {
        if e.scope == Scope::Driver && e.kind == Kind::Builtin {
            assert_eq!(e.category.is_empty(), false);
        }
    }
    // `fired` is update()-only in the compiler too.
    let in_shade = "uniform trigger t;\nvec3 shade(Led led) { bool f = fired(t); return vec3(0.0); }";
    assert!(compile(in_shade).is_err(), "fired() in shade() should be rejected");
}

#[test]
fn generated_web_table_is_fresh() {
    let want = language_ts();
    if GENERATED_TS != want {
        panic!(
            "web/src/effects/editor/lang-table.gen.ts is stale; regenerate it:\n  \
             bazel run //fx_compiler:fx_lang > web/src/effects/editor/lang-table.gen.ts"
        );
    }
}
