//! Print the effect language reference table (fx_compiler/src/lang.rs) as the
//! web module `web/src/effects/editor/lang-table.gen.ts`; `--json` prints the
//! bare JSON (the same string the wasm `fx_language()` returns).

fn main() {
    if std::env::args().any(|a| a == "--json") {
        println!("{}", ledmapper_fx_compiler::lang::language_json());
    } else {
        print!("{}", ledmapper_fx_compiler::lang::language_ts());
    }
}
