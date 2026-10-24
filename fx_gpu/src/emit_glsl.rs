//! Emit GLSL from the primitive IR.
//!
//! A straight walk of the DAG into SSA `vN` temporaries (CSE already happened
//! in the graph, so each live node is exactly one statement). Targets:
//!
//! * [`Target::Es310Compute`] — GLSL ES 3.10 compute, one invocation per LED,
//!   per-LED inputs from a std430 `float` SSBO (int inputs reinterpreted with
//!   `floatBitsToUint`), frame inputs from a second SSBO, RGB packed into a
//!   `uint` output SSBO. Real 32-bit integers, so hash/fixed ops are exact. The
//!   Pi 4/5 path and the SPIR-V source (glslang).
//! * [`Target::Es100Vertex`] — GLSL ES 1.00 for VideoCore IV (Pi 3 / Zero 2 W):
//!   the kernel runs in the **vertex** shader, one `GL_POINTS` vertex per LED.
//!   Vertex shaders guarantee highp float, take per-LED inputs as float
//!   attributes (vc4 has no float textures), and the colour reaches a trivial
//!   pass-through fragment shader as a varying, written to a W×H RGBA8 target
//!   (row = channel). No integers on vc4, so an int graph is refused (`Err`).
//! * [`Target::Es100Fragment`] — the same kernel as a fragment shader with the
//!   inputs as uniforms; kept only as a parse/validation target.
//!
//! Output quantization reproduces the VM epilogue: for a linear-float shade
//! `floor(clamp01(x) * 255)` (the VM's `unit_u8` truncates the RNE product),
//! for `RetRgb8`/`RetRgbFix` `floor(clamp(x, 0, 255))`. The GLES2 targets write
//! `q / 255`: the RGBA8 store computes `round(c * 255)`, which lands on `q` with
//! ~0.5 of margin (`(q + 0.5) / 255` would sit on the rounding tie — off by one).

use crate::ir::{Graph, NodeId, Op, Src, Ty};
use ledmapper_fx_vm as vm;
use std::fmt::Write;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Target {
    Es310Compute,
    Es100Vertex,
    Es100Fragment,
}

pub struct EmitOut {
    /// The main shader (compute, vertex, or fragment).
    pub src: String,
    /// The pass-through fragment shader paired with `Es100Vertex`.
    pub frag: Option<String>,
    /// Per-LED inputs, in attribute/record order (`a{k/4}.{xyzw}` for GLES2).
    pub led_inputs: Vec<Src>,
    /// Per-frame inputs, in uniform order (`u{k}` for GLES2, `fr[k]` compute).
    pub frame_inputs: Vec<Src>,
}

/// Whether a `LoadCtx` id is per-frame (a uniform) rather than per-LED.
pub fn is_frame_ctx(id: u8) -> bool {
    matches!(
        id,
        vm::C_TIME
            | vm::C_DT
            | vm::C_FRAME
            | vm::C_LED_COUNT
            | vm::C_IMU_ACCEL
            | vm::C_IMU_GYRO
            | vm::C_ROOM_MIN
            | vm::C_ROOM_MAX
    )
}

/// Per-LED (attribute) vs per-frame (uniform) classification of an input.
pub fn is_led_input(s: Src) -> bool {
    match s {
        Src::LedCtx(id, _) | Src::LedCtxFix(id, _) => !is_frame_ctx(id),
        _ => false,
    }
}

pub fn emit(g: &Graph, roots: &[NodeId; 3], raw: bool, target: Target) -> Result<EmitOut, String> {
    let live = g.live(roots);
    let es2 = target != Target::Es310Compute;

    let mut led_inputs: Vec<Src> = Vec::new();
    let mut frame_inputs: Vec<Src> = Vec::new();
    for (i, n) in g.nodes.iter().enumerate() {
        if !live[i] {
            continue;
        }
        if es2 && needs_int(n.op) {
            return Err(format!("GLES2 has no integer op for {:?}", n.op));
        }
        if let Op::Input(s) = n.op {
            let list = if is_led_input(s) { &mut led_inputs } else { &mut frame_inputs };
            if !list.contains(&s) {
                list.push(s);
            }
        }
    }
    if target == Target::Es100Vertex && led_inputs.len() > 28 {
        return Err(format!("{} per-LED inputs exceed 7 vec4 attributes", led_inputs.len()));
    }

    let gty = |id: NodeId| -> &'static str {
        match g.ty(id) {
            Ty::F => "float",
            Ty::U => "uint",
            Ty::B => "bool",
        }
    };
    let mut body = String::new();
    for (i, n) in g.nodes.iter().enumerate() {
        if !live[i] {
            continue;
        }
        let id = i as NodeId;
        let rhs = match n.op {
            Op::Input(s) => fetch(s, &led_inputs, &frame_inputs, target),
            _ => expr(g, id)?,
        };
        writeln!(body, "  {} v{id} = {rhs};", gty(id)).unwrap();
    }

    // Quantized channel q in 0..255 (a float holding an integer value).
    let q = |r: NodeId| {
        if raw {
            format!("floor(clamp(v{r}, 0.0, 255.0))")
        } else {
            format!("floor(clamp(v{r}, 0.0, 1.0) * 255.0)")
        }
    };
    let (qr, qg, qb) = (q(roots[0]), q(roots[1]), q(roots[2]));

    let mut out = EmitOut { src: String::new(), frag: None, led_inputs, frame_inputs };
    out.src = match target {
        Target::Es310Compute => format!(
            "#version 310 es\n\
             layout(local_size_x = 64) in;\n\
             layout(std430, binding = 0) readonly buffer Leds {{ float led[]; }};\n\
             layout(std430, binding = 1) readonly buffer Frame {{ float fr[]; }};\n\
             layout(std430, binding = 2) writeonly buffer Out {{ uint outp[]; }};\n\
             layout(location = 0) uniform uint led_count;\n\
             int mulhi_s(int a, int b) {{ int hi; int lo; imulExtended(a, b, hi, lo); return hi; }}\n\
             void main() {{\n  \
               uint gid = gl_GlobalInvocationID.x;\n  \
               if (gid >= led_count) return;\n\
             {body}  \
               outp[gid] = uint({qr}) | (uint({qg}) << 8) | (uint({qb}) << 16);\n}}\n",
        ),
        Target::Es100Vertex => {
            let mut h = String::from("#version 100\nprecision highp float;\nattribute vec2 a_px;\n");
            for k in 0..out.led_inputs.len().div_ceil(4) {
                writeln!(h, "attribute vec4 a{k};").unwrap();
            }
            for k in 0..out.frame_inputs.len() {
                writeln!(h, "uniform float u{k};").unwrap();
            }
            h.push_str("varying vec4 v_col;\n");
            out.frag = Some(
                "#version 100\n#ifdef GL_FRAGMENT_PRECISION_HIGH\nprecision highp float;\n#else\n\
                 precision mediump float;\n#endif\nvarying vec4 v_col;\n\
                 void main() { gl_FragColor = v_col; }\n"
                    .into(),
            );
            format!(
                "{h}void main() {{\n{body}  \
                   v_col = vec4({qr} / 255.0, {qg} / 255.0, {qb} / 255.0, 1.0);\n  \
                   gl_Position = vec4(a_px, 0.0, 1.0);\n  \
                   gl_PointSize = 1.0;\n}}\n"
            )
        }
        Target::Es100Fragment => {
            let mut h = String::from("#version 100\nprecision highp float;\n");
            for k in 0..out.led_inputs.len() {
                writeln!(h, "uniform float l{k};").unwrap();
            }
            for k in 0..out.frame_inputs.len() {
                writeln!(h, "uniform float u{k};").unwrap();
            }
            format!(
                "{h}void main() {{\n{body}  \
                   gl_FragColor = vec4({qr} / 255.0, {qg} / 255.0, {qb} / 255.0, 1.0);\n}}\n"
            )
        }
    };
    Ok(out)
}

fn fetch(s: Src, led: &[Src], frame: &[Src], target: Target) -> String {
    let int_word = matches!(s, Src::LedCtxFix(..) | Src::FrameCtxFix(..));
    let word = if is_led_input(s) {
        let k = led.iter().position(|&x| x == s).unwrap();
        match target {
            Target::Es310Compute => format!("led[gid * {}u + {k}u]", led.len().max(1)),
            Target::Es100Vertex => format!("a{}.{}", k / 4, ["x", "y", "z", "w"][k % 4]),
            Target::Es100Fragment => format!("l{k}"),
        }
    } else {
        let k = frame.iter().position(|&x| x == s).unwrap();
        match target {
            Target::Es310Compute => format!("fr[{k}u]"),
            _ => format!("u{k}"),
        }
    };
    if int_word && target == Target::Es310Compute {
        format!("floatBitsToUint({word})")
    } else {
        word
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

fn expr(g: &Graph, id: NodeId) -> Result<String, String> {
    let n = g.node(id);
    let a = n.args();
    let x = |k: usize| format!("v{}", a[k]);
    use Op::*;
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
    // `{:?}` is the shortest repr that round-trips through f32; GLSL parsers
    // round decimal→float correctly for these.
    let s = format!("{x:?}");
    if s.contains('.') || s.contains('e') || s.contains('E') {
        s
    } else {
        format!("{s}.0")
    }
}
