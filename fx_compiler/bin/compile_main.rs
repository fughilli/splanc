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
                print!("{}", memo_summary(&c.memo));
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
    // `--no-memo` keeps the optimizer but skips the variance pass (per-frame
    // hoisting + per-LED memoization) — the A/B leg for the memo benchmark.
    let memo = !args.iter().any(|a| a == "--no-memo");
    let args: Vec<String> =
        args.into_iter().filter(|a| a != "--no-opt" && a != "--no-memo").collect();
    let src = if args.len() > 1 {
        std::fs::read_to_string(&args[1]).expect("read source file")
    } else {
        let mut s = String::new();
        std::io::stdin().read_to_string(&mut s).expect("read stdin");
        s
    };
    let opts = ledmapper_fx_compiler::CompileOptions {
        optimize,
        memo: memo.then(ledmapper_fx_compiler::MemoConfig::default),
    };
    match ledmapper_fx_compiler::compile_with(&src, &opts) {
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

/// One-paragraph summary of what the variance pass did (appended to --disasm).
fn memo_summary(r: &ledmapper_fx_compiler::MemoReport) -> String {
    let mut s = String::new();
    if r.hoisted.is_empty() && r.cached.is_empty() {
        return "; memo: nothing hoisted or cached\n".into();
    }
    s.push_str(&format!(
        "; memo: ~{} C6 cycles/LED/frame saved; LED cache {} word(s)/LED (groups {:?}); state {}\n",
        r.cycles_saved_per_led, r.led_cache_words, r.led_cache_groups, r.n_state
    ));
    for h in &r.hoisted {
        s.push_str(&format!(";   hoisted -> state[{}..+{}] (~{} cy): {}\n", h.slot, h.words, h.cycles, h.expr));
    }
    for c in &r.cached {
        s.push_str(&format!(";   led-cache word {}..+{} (~{} cy): {}\n", c.slot, c.words, c.cycles, c.expr));
    }
    for c in &r.over_budget {
        s.push_str(&format!(";   over budget (~{} cy): {}\n", c.cycles, c.expr));
    }
    s
}
