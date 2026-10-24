//! A host evaluator for the *primitive* IR — the semantic model of what the
//! GPU shader computes. It executes each node in `f32`/`i32`/`bool`, using Rust
//! `std` for the native transcendentals (`NSin` = `f32::sin`, ...), so it is a
//! faithful stand-in for a highp GPU lane. The conformance harness compares its
//! per-LED RGB against `fx_vm`'s and reports the max channel error; the GPU is
//! then expected to match THIS within a small extra tolerance for its own
//! rounding (documented in the numerics section).
//!
//! It is also the oracle the GLSL/SPIR-V emitters are checked against: emit,
//! render on a real GPU, and compare the device pixels to `eval` here.

use crate::ir::{Graph, NodeId, Op};

/// One per-LED/per-frame set of input words, indexed the way [`crate::ir::Src`]
/// addresses them. Raw 32-bit words (f32 bits or int bits), exactly as the VM
/// slot would hold.
#[derive(Clone, Default)]
pub struct Inputs {
    pub uniforms: Vec<u32>,
    pub state: Vec<u32>,
    /// `led_ctx[(id, comp)]` as an f32 bit pattern.
    pub led_ctx: std::collections::HashMap<(u8, u8), u32>,
    pub frame_ctx: std::collections::HashMap<(u8, u8), u32>,
    pub led_ctx_fix: std::collections::HashMap<(u8, u8), u32>,
    pub frame_ctx_fix: std::collections::HashMap<(u8, u8), u32>,
}

#[derive(Clone, Copy)]
enum Val {
    F(f32),
    U(u32),
    B(bool),
}

impl Val {
    fn f(self) -> f32 {
        match self {
            Val::F(x) => x,
            Val::U(u) => f32::from_bits(u),
            Val::B(b) => {
                if b {
                    1.0
                } else {
                    0.0
                }
            }
        }
    }
    fn u(self) -> u32 {
        match self {
            Val::U(u) => u,
            Val::F(x) => x.to_bits(),
            Val::B(b) => b as u32,
        }
    }
    fn i(self) -> i32 {
        self.u() as i32
    }
    fn b(self) -> bool {
        match self {
            Val::B(b) => b,
            Val::F(x) => x != 0.0,
            Val::U(u) => u != 0,
        }
    }
}

pub fn eval_rgb(g: &Graph, roots: &[NodeId; 3], inp: &Inputs) -> [f32; 3] {
    let mut memo: Vec<Option<Val>> = vec![None; g.len()];
    let mut out = [0.0f32; 3];
    for (i, o) in out.iter_mut().enumerate() {
        *o = ev(g, roots[i], inp, &mut memo).f();
    }
    out
}

fn ev(g: &Graph, id: NodeId, inp: &Inputs, memo: &mut Vec<Option<Val>>) -> Val {
    if let Some(v) = memo[id as usize] {
        return v;
    }
    let node = g.node(id);
    let a = |k: usize, memo: &mut Vec<Option<Val>>| ev(g, node.args[k], inp, memo);
    use Op::*;
    let v = match node.op {
        ConstF(b) => Val::F(f32::from_bits(b)),
        ConstU(u) => Val::U(u),
        ConstB(b) => Val::B(b),
        Input(s) => Val::U(read_src(inp, s)),
        FAdd => Val::F(a(0, memo).f() + a(1, memo).f()),
        FSub => Val::F(a(0, memo).f() - a(1, memo).f()),
        FMul => Val::F(a(0, memo).f() * a(1, memo).f()),
        FDiv => Val::F(a(0, memo).f() / a(1, memo).f()),
        FNeg => Val::F(-a(0, memo).f()),
        FAbs => Val::F(a(0, memo).f().abs()),
        FLt => Val::B(a(0, memo).f() < a(1, memo).f()),
        FLe => Val::B(a(0, memo).f() <= a(1, memo).f()),
        FGt => Val::B(a(0, memo).f() > a(1, memo).f()),
        FGe => Val::B(a(0, memo).f() >= a(1, memo).f()),
        FEq => Val::B(a(0, memo).f() == a(1, memo).f()),
        FNe => Val::B(a(0, memo).f() != a(1, memo).f()),
        NFloor => Val::F(a(0, memo).f().floor()),
        NSin => Val::F(a(0, memo).f().sin()),
        NCos => Val::F(a(0, memo).f().cos()),
        NExp => Val::F(a(0, memo).f().exp()),
        NLog => Val::F(a(0, memo).f().ln()),
        NSqrt => Val::F(a(0, memo).f().sqrt()),
        NPow => Val::F(a(0, memo).f().powf(a(1, memo).f())),
        NAtan2 => Val::F(a(0, memo).f().atan2(a(1, memo).f())),
        FBits => Val::U(a(0, memo).f().to_bits()),
        UFloat => Val::F(f32::from_bits(a(0, memo).u())),
        I2F => Val::F(a(0, memo).i() as f32),
        U2F => Val::F(a(0, memo).u() as f32),
        F2U => Val::U(a(0, memo).f() as u32),
        F2I => Val::U(to_i_trunc(a(0, memo).f()) as u32),
        IAdd => Val::U(a(0, memo).i().wrapping_add(a(1, memo).i()) as u32),
        ISub => Val::U(a(0, memo).i().wrapping_sub(a(1, memo).i()) as u32),
        IMul => Val::U(a(0, memo).i().wrapping_mul(a(1, memo).i()) as u32),
        IMulHi => {
            let p = (a(0, memo).i() as i64) * (a(1, memo).i() as i64);
            Val::U((p >> 32) as i32 as u32)
        }
        IDiv => {
            let (x, y) = (a(0, memo).i(), a(1, memo).i());
            Val::U(x.wrapping_div(y) as u32)
        }
        IMod => {
            let (x, y) = (a(0, memo).i(), a(1, memo).i());
            Val::U(x.wrapping_rem(y) as u32)
        }
        Shl => Val::U(a(0, memo).u().wrapping_shl(a(1, memo).u())),
        LShr => Val::U(a(0, memo).u().wrapping_shr(a(1, memo).u())),
        AShr => Val::U(a(0, memo).i().wrapping_shr(a(1, memo).u()) as u32),
        And => Val::U(a(0, memo).u() & a(1, memo).u()),
        Or => Val::U(a(0, memo).u() | a(1, memo).u()),
        Xor => Val::U(a(0, memo).u() ^ a(1, memo).u()),
        ILt => Val::B(a(0, memo).i() < a(1, memo).i()),
        ILe => Val::B(a(0, memo).i() <= a(1, memo).i()),
        IGt => Val::B(a(0, memo).i() > a(1, memo).i()),
        IGe => Val::B(a(0, memo).i() >= a(1, memo).i()),
        IEq => Val::B(a(0, memo).i() == a(1, memo).i()),
        INe => Val::B(a(0, memo).i() != a(1, memo).i()),
        ULt => Val::B(a(0, memo).u() < a(1, memo).u()),
        UGe => Val::B(a(0, memo).u() >= a(1, memo).u()),
        BAnd => Val::B(a(0, memo).b() && a(1, memo).b()),
        BOr => Val::B(a(0, memo).b() || a(1, memo).b()),
        BNot => Val::B(!a(0, memo).b()),
        Sel => {
            if a(0, memo).b() {
                a(1, memo)
            } else {
                a(2, memo)
            }
        }
        other => panic!("eval: non-primitive op {other:?}"),
    };
    memo[id as usize] = Some(v);
    v
}

/// `f2i` — truncate toward zero, saturate, NaN -> 0 (matches `fx_vm::f2i`).
fn to_i_trunc(x: f32) -> i32 {
    if x.is_nan() {
        0
    } else if x >= 2147483648.0 {
        i32::MAX
    } else if x <= -2147483648.0 {
        i32::MIN
    } else {
        x as i32
    }
}

/// The raw input word for `s` (what the GPU's attribute/uniform carries).
pub fn read_src(inp: &Inputs, s: crate::ir::Src) -> u32 {
    use crate::ir::Src::*;
    match s {
        Uniform(i) => *inp.uniforms.get(i as usize).unwrap_or(&0),
        State(i) => *inp.state.get(i as usize).unwrap_or(&0),
        FrameCtx(id, c) => *inp.frame_ctx.get(&(id, c)).unwrap_or(&0),
        LedCtx(id, c) => *inp.led_ctx.get(&(id, c)).unwrap_or(&0),
        LedCtxFix(id, c) => *inp.led_ctx_fix.get(&(id, c)).unwrap_or(&0),
        FrameCtxFix(id, c) => *inp.frame_ctx_fix.get(&(id, c)).unwrap_or(&0),
        Hoisted(_) => 0,
    }
}
