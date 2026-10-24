//! Source lints: warnings that never stop a program compiling, but that an
//! author (usually an AI agent) should act on. They ride [`crate::Compiled`]'s
//! `warnings` and reach the agent through `compile_effect` / the editor's
//! `set_script` result.
//!
//! **Rate × time phases.** `fract(led.s - time * speed)` with `speed` a uniform
//! looks right in a still preview, but moving the `speed` slider rescales ALL of
//! the elapsed time: the phase jumps by `Δspeed × time`, which after a few
//! minutes of uptime is many whole cycles — the effect stutters erratically
//! while the slider moves. The fix is to integrate the rate once per frame in
//! `update()` (`ph = fract(ph + dt * speed);`), so a slider change only changes
//! how fast the phase advances from where it is.
//!
//! The check is a taint analysis riding the single-pass parser: every
//! expression carries a [`Taint`] — "linear in `time`", "depends on a
//! uniform", and "is time scaled by a uniform" (a *rate product*, with the line
//! it was formed on). Taints flow through arithmetic, swizzles, constructors
//! and variables (`state`/locals, so `z = time * speed;` in update() and `fract(z)`
//! in shade() are connected). A warning fires only when a rate product reaches
//! a *phase sink* — an argument of a wrapping/periodic builtin (`fract`, `sin`,
//! `cos`, `mod`/`%`, `floor`, `hash`, `hsv2rgb`, ...). It is deliberately
//! conservative: `time * 0.5` (a literal), `fract(led.s * pulses - time)` (no
//! product), `sin(time) * amp` (amplitude, not rate: the periodic builtin's
//! bounded output is clean) and `fract(ph + dt * speed)` (`dt`, not `time`) are
//! all silent. One warning per source line that formed the product.

use crate::Diagnostic;
use std::collections::{BTreeSet, HashMap};

/// What an expression's value depends on (for the lints only).
#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Taint {
    /// Linear in `time` (through + - * / unary minus, swizzles, constructors).
    pub time: bool,
    /// The first uniform it depends on (a non-bool uniform, directly or via a
    /// variable assigned from one).
    pub uniform: Option<String>,
    /// `time` scaled by a uniform: where the operator that formed the product
    /// is, and what scaled it.
    pub rate: Option<Rate>,
    /// The variable this value was read from, while it is still just that
    /// variable (a bare `speed` or `k`), for naming it in the message.
    pub leaf: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Rate {
    pub line: u32,
    pub col: u32,
    /// The uniform the scale depends on.
    pub uniform: String,
    /// The operand as written when it was a bare variable (`speed`, or a `k`
    /// computed from it), else the uniform.
    pub operand: String,
}

impl Taint {
    pub fn time() -> Taint {
        Taint {
            time: true,
            ..Default::default()
        }
    }
    pub fn uniform(name: &str) -> Taint {
        Taint {
            uniform: Some(name.to_string()),
            ..Default::default()
        }
    }
    /// This taint, read through the variable `name`.
    pub fn named(mut self, name: &str) -> Taint {
        self.leaf = Some(name.to_string());
        self
    }
    /// Join (the value depends on both).
    pub fn union(mut self, o: Taint) -> Taint {
        self.time |= o.time;
        if self.uniform.is_none() {
            self.uniform = o.uniform;
        }
        if self.rate.is_none() {
            self.rate = o.rate;
        }
        self.leaf = None;
        self
    }
}

/// Builtins whose argument is treated as a PHASE: periodic or wrapping
/// (fract/mod/sin/...), or quantizing time into epochs (floor/ceil/hash) —
/// where a jump of the argument is a visible jump of the effect.
const PHASE_SINKS: &[&str] = &[
    "fract", "mod", "sin", "cos", "tan", "floor", "ceil", "hash", "hsv2rgb", "palette", "palette0",
    "palette1", "palette2",
];

/// Builtins that keep a value linear-ish in its argument, so `time` stays
/// `time` through them (everything else non-sink keeps uniform/rate taint but
/// drops plain `time`).
const TIME_TRANSPARENT: &[&str] = &["min", "max", "clamp", "mix", "abs"];

/// Lint state for one compile.
#[derive(Default)]
pub(crate) struct Lint {
    /// Taint of the most recently parsed (sub)expression.
    pub taint: Taint,
    /// Per-variable taint (state + locals), by name, as last assigned.
    pub vars: HashMap<String, Taint>,
    /// Taints of the arguments of the builtin call being parsed.
    pub arg_taints: Vec<Taint>,
    pub warnings: Vec<Diagnostic>,
    warned: BTreeSet<u32>,
}

impl Lint {
    /// A binary operator `op` at (line, col) joined `l` and `r`.
    pub fn binop(&mut self, op: &str, l: Taint, r: Taint, line: u32, col: u32) -> Taint {
        if matches!(op, "<" | ">" | "<=" | ">=" | "==" | "!=" | "&&" | "||") {
            return Taint::default();
        }
        if op == "%" {
            // `%` wraps like mod(): a phase sink for its left operand.
            self.sink("%", &l);
            return Taint::default();
        }
        let scale = match op {
            "*" if l.time && r.uniform.is_some() => Some(&r),
            "*" if r.time && l.uniform.is_some() => Some(&l),
            // `time / period`: a period uniform is a rate control too.
            "/" if l.time && r.uniform.is_some() => Some(&r),
            _ => None,
        };
        let rate = scale.map(|s| {
            let uniform = s.uniform.clone().unwrap_or_default();
            Rate {
                line,
                col,
                operand: s.leaf.clone().unwrap_or_else(|| uniform.clone()),
                uniform,
            }
        });
        let mut t = l.union(r);
        if t.rate.is_none() {
            t.rate = rate;
        }
        t
    }

    /// The builtin `name` was called with `self.arg_taints`: returns its taint.
    pub fn builtin(&mut self, name: &str) -> Taint {
        let args = std::mem::take(&mut self.arg_taints);
        if PHASE_SINKS.contains(&name) {
            for a in &args {
                self.sink(name, a);
            }
            // The bounded output of a periodic/wrapping builtin is a fresh value:
            // `sin(time) * amp` is an amplitude, not a rate.
            return Taint::default();
        }
        let keep_time = TIME_TRANSPARENT.contains(&name);
        let mut t = args.into_iter().fold(Taint::default(), Taint::union);
        t.time &= keep_time;
        t
    }

    fn sink(&mut self, name: &str, t: &Taint) {
        let Some(Rate {
            line,
            col,
            uniform: u,
            operand: x,
        }) = &t.rate
        else {
            return;
        };
        if !self.warned.insert(*line) {
            return;
        }
        let ph = format!("{x}_phase");
        let used = if name == "%" {
            "`%`".to_string()
        } else {
            format!("{name}()")
        };
        let epoch = if matches!(name, "floor" | "ceil" | "hash") {
            format!(
                " For an epoch (floor/hash of the product), wrap `{ph}` by hand and count the wraps: \
                 `{ph} = {ph} + dt * {x}; if ({ph} >= 1.0) {{ {ph} = {ph} - 1.0; epoch = epoch + 1.0; }}` \
                 with `state float epoch;`."
            )
        } else {
            String::new()
        };
        let what = if x == u {
            format!("the uniform `{u}`")
        } else {
            format!("`{x}` (from the uniform `{u}`)")
        };
        self.warnings.push(Diagnostic {
            line: *line,
            col: *col,
            msg: format!(
                "warning: `time` scaled by {what} is used as a phase (in {used}): moving the `{u}` slider \
                 rescales ALL elapsed time, so the effect jumps (by Δ{x} × time). Integrate the rate in \
                 update() instead — `state float {ph};` and `{ph} = fract({ph} + dt * {x});` — then use \
                 `{ph}` where `time * {x}` was (one phase per rate; keep constant factors inside: \
                 `dt * {x} * 0.5`).{epoch}"
            ),
        });
    }
}
