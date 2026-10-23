//! wasm binding: compile a script live in the browser editor
//! (docs/design/effects-compiler.md). Returns bytecode + the uniform manifest
//! (JSON) + diagnostics (JSON) so the editor can show inline errors, build the
//! uniform panel, and feed the `.fxb` to the preview VM (fx_vm_web).

use ledmapper_fx_compiler::{
    compile, compile_with, disassemble, exports_manifest_json, manifest_json, CompileOptions, Compiled,
    Diagnostic,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct CompileResult {
    ok: bool,
    bytecode: Vec<u8>,
    manifest: String,
    /// Driver export table JSON (FUG-107); "[]" for an effect.
    exports: String,
    diagnostics: String,
}

#[wasm_bindgen]
impl CompileResult {
    #[wasm_bindgen(getter)]
    pub fn ok(&self) -> bool {
        self.ok
    }
    #[wasm_bindgen(getter)]
    pub fn bytecode(&self) -> Vec<u8> {
        self.bytecode.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn manifest(&self) -> String {
        self.manifest.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn exports(&self) -> String {
        self.exports.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn diagnostics(&self) -> String {
        self.diagnostics.clone()
    }
}

#[wasm_bindgen]
pub fn fx_compile(src: &str) -> CompileResult {
    result(compile(src))
}

/// Like [`fx_compile`] but with the variance pass (per-frame hoisting + per-LED
/// memoization) off — for the calibration micro-benchmarks, which must measure
/// raw opcodes rather than a cache hit.
#[wasm_bindgen]
pub fn fx_compile_no_memo(src: &str) -> CompileResult {
    result(compile_with(src, &CompileOptions { optimize: true, memo: None }))
}

fn result(r: Result<Compiled, Vec<Diagnostic>>) -> CompileResult {
    match r {
        Ok(c) => CompileResult {
            ok: true,
            bytecode: c.fxb,
            manifest: manifest_json(&c.uniforms),
            exports: exports_manifest_json(&c.exports),
            diagnostics: "[]".into(),
        },
        Err(ds) => {
            let items: Vec<String> = ds
                .iter()
                .map(|d| {
                    format!(
                        "{{\"line\":{},\"col\":{},\"msg\":{}}}",
                        d.line,
                        d.col,
                        json_str(&d.msg)
                    )
                })
                .collect();
            CompileResult {
                ok: false,
                bytecode: vec![],
                manifest: "[]".into(),
                exports: "[]".into(),
                diagnostics: format!("[{}]", items.join(",")),
            }
        }
    }
}

/// Disassemble compiled `.fxb` bytecode to a readable op listing (offsets +
/// mnemonics + operands, entry points labelled). Wraps the authoritative
/// `ledmapper_fx_compiler::disassemble` so the editor's disassembly panel can
/// never drift from the VM's opcode table.
#[wasm_bindgen]
pub fn fx_disassemble(fxb: &[u8]) -> String {
    disassemble(fxb)
}

fn json_str(s: &str) -> String {
    let mut out = String::from("\"");
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push(' '),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
