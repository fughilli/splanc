//! Tiny host-side CLI: compile a GLSL-ish effect source to `.fxb`.
//! `fx_compile <src.fx> [out.fxb]` — writes raw `.fxb` bytes to `out.fxb` if
//! given, else prints the `.fxb` as one lowercase hex line to stdout (handy for
//! piping a precompiled effect into the wss `/wseffect` submit test). Exits
//! non-zero with the diagnostics on a compile error.

use std::io::{Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    // `--disasm <src.fx>` prints the human-readable disassembly (verifies an
    // effect is soft-float-free); handled before the normal source read.
    if args.get(1).map(|s| s == "--disasm").unwrap_or(false) {
        let src2 = std::fs::read_to_string(&args[2]).expect("read source file");
        match ledmapper_fx_compiler::compile(&src2) {
            Ok(c) => {
                print!("{}", ledmapper_fx_compiler::disassemble(&c.fxb));
                return;
            }
            Err(diags) => {
                eprintln!("compile error: {diags:?}");
                std::process::exit(1);
            }
        }
    }
    // `--no-opt` disables the bytecode optimizer (FUG-125) — used to produce an
    // optimized/unoptimized A/B of the SAME source for on-device (HITL) cycle
    // comparison against one firmware build. Filtered out of the positional args.
    let optimize = !args.iter().any(|a| a == "--no-opt");
    let args: Vec<String> = args.into_iter().filter(|a| a != "--no-opt").collect();
    let src = if args.len() > 1 {
        std::fs::read_to_string(&args[1]).expect("read source file")
    } else {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).expect("read stdin");
        s
    };
    match ledmapper_fx_compiler::compile_opts(&src, optimize) {
        Ok(c) => {
            if args.len() > 2 {
                std::fs::write(&args[2], &c.fxb).expect("write .fxb");
                eprintln!("wrote {} bytes to {}", c.fxb.len(), args[2]);
            } else {
                let mut hex = String::with_capacity(c.fxb.len() * 2);
                for b in &c.fxb {
                    hex.push_str(&format!("{b:02x}"));
                }
                let mut out = std::io::stdout();
                let _ = writeln!(out, "{hex}");
            }
        }
        Err(diags) => {
            eprintln!("compile error: {diags:?}");
            std::process::exit(1);
        }
    }
}
