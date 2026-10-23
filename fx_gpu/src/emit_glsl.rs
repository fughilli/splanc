//! Emit GLSL from the primitive IR.
//!
//! A straight walk of the DAG into SSA `vN` temporaries (CSE already happened
//! in the graph, so each live node is exactly one statement). Two targets:
//!
//! * [`Target::Es310Compute`] — GLSL ES 3.10 compute, one invocation per LED,
//!   inputs from a std430 `float` SSBO (raw words; int inputs reinterpreted
//!   with `floatBitsToUint`), RGBA packed into a `uint` output SSBO. Real
//!   32-bit integers, so the hash/fixed ops are exact. This is the Pi 4/5 path
//!   and the one glslang turns into SPIR-V.
//! * [`Target::Es100Fragment`] — GLSL ES 1.00 fragment over a 1×N strip, one
//!   fragment per LED, `gl_FragColor` as the result. No integers on VC4, so a
//!   graph that needs an integer op is refused (`Err`) and the effect stays on
//!   the VM / an int-capable tier — the Pi 3 tiering decision in the design doc.
//!
//! A text generator on purpose (no `naga`/`rspirv` dep) so the prototype builds
//! under the repo's offline Bazel crate universe; the doc specifies `naga` for
//! production.

use crate::ir::{Graph, NodeId, Op, Src, Ty};
use std::fmt::Write;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Es310Compute,
    Es100Fragment,
}

pub struct EmitOut {
    pub src: String,
    /// Input words referenced, in binding order (index = SSBO/uniform slot).
    pub inputs: Vec<Src>,
}

pub fn emit(g: &Graph, roots: &[NodeId; 3], target: Target) -> Result<EmitOut, String> {
    let live = g.live(roots);
    let es2 = target == Target::Es100Fragment;

    // Inputs in first-seen order → binding slot.
    let mut inputs: Vec<Src> = Vec::new();
    for (i, n) in g.nodes.iter().enumerate() {
        if live[i] {
            if es2 && needs_int(n.op) {
                return Err(format!("GLES2 has no integer op for {:?}", n.op));
            }
            if let Op::Input(s) = n.op {
                if !inputs.contains(&s) {
                    inputs.push(s);
                }
            }
        }
    }
    let slot = |s: Src| inputs.iter().position(|&x| x == s).unwrap();

    let gty = |id: NodeId| -> &'static str {
        match g.ty(id) {
            Ty::F => "float",
            // ES2 has no integers (refused earlier); a U here can't occur.
            Ty::U => "uint",
            Ty::B => "bool",
        }
    };
    let _ = es2;

    let mut body = String::new();
    for (i, n) in g.nodes.iter().enumerate() {
        if !live[i] {
            continue;
        }
        let id = i as NodeId;
        let rhs = match n.op {
            Op::Input(s) => fetch(s, slot(s), target),
            _ => expr(g, id, target)?,
        };
        writeln!(body, "  {} v{id} = {rhs};", gty(id)).unwrap();
    }

    let (r, gb, b) = (roots[0], roots[1], roots[2]);
    let src = match target {
        Target::Es310Compute => format!(
            "#version 310 es\n\
             layout(local_size_x = 64) in;\n\
             layout(std430, binding = 0) readonly buffer In {{ float indata[]; }};\n\
             layout(std430, binding = 1) writeonly buffer Out {{ uint outp[]; }};\n\
             layout(location = 0) uniform uint led_count;\n\
             layout(location = 1) uniform uint n_inputs;\n\
             int mulhi_s(int a, int b) {{ int hi; int lo; imulExtended(a, b, hi, lo); return hi; }}\n\
             void main() {{\n  \
               uint gid = gl_GlobalInvocationID.x;\n  \
               if (gid >= led_count) return;\n\
             {body}  \
               uint R = uint(clamp(v{r}, 0.0, 255.0));\n  \
               uint G = uint(clamp(v{gb}, 0.0, 255.0));\n  \
               uint B = uint(clamp(v{b}, 0.0, 255.0));\n  \
               outp[gid] = R | (G << 8) | (B << 16);\n}}\n"
        ),
        Target::Es100Fragment => {
            // per-LED inputs sampled from a 1×N data texture (RGBA32F-ish); the
            // feasibility emitter passes them as a uniform array instead.
            let mut u = String::new();
            writeln!(u, "#version 100\nprecision highp float;\nuniform float indata[{}];", inputs.len().max(1))
                .unwrap();
            format!(
                "{u}\nvoid main() {{\n{body}  \
                   gl_FragColor = vec4(clamp(v{r},0.0,255.0)/255.0, \
                   clamp(v{gb},0.0,255.0)/255.0, clamp(v{b},0.0,255.0)/255.0, 1.0);\n}}\n"
            )
        }
    };
    Ok(EmitOut { src, inputs })
}

fn fetch(s: Src, slot: usize, target: Target) -> String {
    // Raw word for input `slot`. ES3.10 reads a float SSBO; int inputs
    // reinterpret the bits. ES2 reads a float uniform array (floats only).
    let word = match target {
        Target::Es310Compute => format!("indata[gid * n_inputs + {slot}u]"),
        Target::Es100Fragment => format!("indata[{slot}]"),
    };
    match s {
        // int/fixed mirrors are raw words → reinterpret on int-capable targets
        Src::LedCtxFix(..) | Src::FrameCtxFix(..) if target == Target::Es310Compute => {
            format!("floatBitsToUint({word})")
        }
        _ => word,
    }
}

fn needs_int(op: Op) -> bool {
    use Op::*;
    matches!(
        op,
        ConstU(_)
            | IAdd
            | ISub
            | IMul
            | IMulHi
            | IDiv
            | IMod
            | Shl
            | LShr
            | AShr
            | And
            | Or
            | Xor
            | ILt
            | ILe
            | IGt
            | IGe
            | IEq
            | INe
            | ULt
            | UGe
            | FBits
            | UFloat
            | U2F
            | F2U
            | F2I
    ) || matches!(op, Input(Src::LedCtxFix(..)) | Input(Src::FrameCtxFix(..)))
}

fn expr(g: &Graph, id: NodeId, t: Target) -> Result<String, String> {
    let n = g.node(id);
    let a = n.args();
    let x = |k: usize| format!("v{}", a[k]);
    use Op::*;
    let _ = t;
    Ok(match n.op {
        ConstF(bits) => fmt_float(f32::from_bits(bits)),
        ConstU(u) => format!("{u}u"),
        ConstB(b) => b.to_string(),
        Input(_) => unreachable!("inputs handled by fetch()"),
        FAdd => format!("({} + {})", x(0), x(1)),
        FSub => format!("({} - {})", x(0), x(1)),
        FMul => format!("({} * {})", x(0), x(1)),
        FDiv => format!("({} / {})", x(0), x(1)),
        FNeg => format!("(-{})", x(0)),
        FAbs => format!("abs({})", x(0)),
        FLt => format!("({} < {})", x(0), x(1)),
        FLe => format!("({} <= {})", x(0), x(1)),
        FGt => format!("({} > {})", x(0), x(1)),
        FGe => format!("({} >= {})", x(0), x(1)),
        FEq => format!("({} == {})", x(0), x(1)),
        FNe => format!("({} != {})", x(0), x(1)),
        NFloor => format!("floor({})", x(0)),
        NSin => format!("sin({})", x(0)),
        NCos => format!("cos({})", x(0)),
        NExp => format!("exp({})", x(0)),
        NLog => format!("log({})", x(0)),
        NSqrt => format!("sqrt({})", x(0)),
        NPow => format!("pow({}, {})", x(0), x(1)),
        NAtan2 => format!("atan({}, {})", x(0), x(1)),
        FBits => format!("floatBitsToUint({})", x(0)),
        UFloat => format!("uintBitsToFloat({})", x(0)),
        I2F => format!("float(int({}))", x(0)),
        U2F => format!("float({})", x(0)),
        F2U => format!("uint({})", x(0)),
        F2I => format!("uint(int({}))", x(0)),
        IAdd => format!("({} + {})", x(0), x(1)),
        ISub => format!("({} - {})", x(0), x(1)),
        IMul => format!("({} * {})", x(0), x(1)),
        IMulHi => format!("uint(mulhi_s(int({}), int({})))", x(0), x(1)),
        IDiv => format!("uint(int({}) / int({}))", x(0), x(1)),
        IMod => format!("uint(int({}) % int({}))", x(0), x(1)),
        Shl => format!("({} << {})", x(0), x(1)),
        LShr => format!("({} >> {})", x(0), x(1)),
        AShr => format!("uint(int({}) >> {})", x(0), x(1)),
        And => format!("({} & {})", x(0), x(1)),
        Or => format!("({} | {})", x(0), x(1)),
        Xor => format!("({} ^ {})", x(0), x(1)),
        ILt => format!("(int({}) < int({}))", x(0), x(1)),
        ILe => format!("(int({}) <= int({}))", x(0), x(1)),
        IGt => format!("(int({}) > int({}))", x(0), x(1)),
        IGe => format!("(int({}) >= int({}))", x(0), x(1)),
        IEq => format!("({} == {})", x(0), x(1)),
        INe => format!("({} != {})", x(0), x(1)),
        ULt => format!("({} < {})", x(0), x(1)),
        UGe => format!("({} >= {})", x(0), x(1)),
        BAnd => format!("({} && {})", x(0), x(1)),
        BOr => format!("({} || {})", x(0), x(1)),
        BNot => format!("(!{})", x(0)),
        Sel => format!("({} ? {} : {})", x(0), x(1), x(2)),
        Lut(_) => return Err("Lut not emitted in this subset".into()),
        other => return Err(format!("non-primitive op reached emitter: {other:?}")),
    })
}

fn fmt_float(x: f32) -> String {
    if x.is_nan() {
        return "(0.0 / 0.0)".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "(1.0 / 0.0)".into() } else { "(-1.0 / 0.0)".into() };
    }
    let s = format!("{x:?}");
    if s.contains('.') || s.contains('e') || s.contains('E') {
        s
    } else {
        format!("{s}.0")
    }
}
