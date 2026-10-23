//! The kernel IR: a hash-consed, scalarized SSA DAG of 32-bit words.
//!
//! Two layers share one node type:
//!
//! * **macro ops** (`M*`) carry exact `fx_vm` semantics (division by zero is 0,
//!   `sinf` is the VM's LUT sine, `hash` mixes the operand's bit pattern, ...).
//!   [`crate::lower`] produces only macro ops and inputs from `.fxb` bytecode.
//! * **primitive ops** (everything else) are what a shader can express directly.
//!   [`crate::legalize`] rewrites macro ops into primitives for one numerics
//!   profile; the GLSL and SPIR-V emitters only ever see primitives.
//!
//! Every value is a 32-bit word with a natural type ([`Ty`]): `F` (f32), `U`
//! (a 32-bit integer; signedness is a property of the op, as in SPIR-V) or `B`
//! (a shader boolean, primitives only). The VM itself is untyped — ints ride in
//! f32 slots bit-for-bit — so a macro op reinterprets its operands as it needs.
//! Nodes are appended in dependency order, so `NodeId` order is a topological
//! order and emitters can walk the arena front to back.

use std::collections::HashMap;

pub type NodeId = u32;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Ty {
    F,
    U,
    B,
}

/// Where an input word comes from. The CPU side fills these (per frame for
/// uniforms, once per map for LED attributes) — see [`crate::kernel`].
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Src {
    /// `uniforms[slot]` (raw word).
    Uniform(u8),
    /// `state[slot]` (raw word; read-only during shade, written by update/prep).
    State(u8),
    /// A frame context value (`fx_vm::C_*` id, component) as f32.
    FrameCtx(u8, u8),
    /// A per-LED context value (`fx_vm::C_*` id, component) as f32.
    LedCtx(u8, u8),
    /// A per-LED Q16.16/int context mirror (`LoadCtxFix`) as a raw word.
    LedCtxFix(u8, u8),
    /// A frame Q16.16/int context mirror as a raw word.
    FrameCtxFix(u8, u8),
    /// A value the CPU computed (exactly, through the VM's own maths) and
    /// passed in: index into the kernel's hoisted-node table.
    Hoisted(u16),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Op {
    // ---- leaves -----------------------------------------------------------
    ConstF(u32),
    ConstU(u32),
    ConstB(bool),
    Input(Src),

    // ---- macro ops: exact fx_vm semantics on raw words ---------------------
    MAdd,
    MSub,
    MMul,
    /// `b == 0 ? 0 : a / b` (the VM's `Div` / `BinTop div`).
    MDiv0,
    /// IEEE `a / b` with no zero guard (used inside smoothstep/mod/normalize/tan).
    MDivRaw,
    MNeg,
    /// `fx_vm` unary math function `F_*` (imm in the op).
    MUn(u8),
    /// `fx_vm` binary math function `B_*`.
    MBin(u8),
    /// float compare (kind 0lt 1le 2gt 3ge 4eq 5ne) -> 1.0 / 0.0
    MCmp(u8),
    /// int compare -> 1.0 / 0.0
    MICmp(u8),
    /// `a != 0.0 ? 0.0 : 1.0`
    MNot,
    MAnd,
    MOr,
    /// `c != 0.0 ? a : b` — if-conversion of the VM's `BrFalse` (exact: shade
    /// code is side-effect free, so evaluating both arms changes nothing).
    MSel,
    MHash1,
    MHash3,
    /// `fx_vm::clamp01`
    MClamp01,
    /// `sqrtf` (length/distance/normalize)
    MSqrt,
    /// lane k of `hsv2rgb(h, s, v)`
    MHsv(u8),
    /// lane k of `palette(id, t)`
    MPal(u8, u8),
    /// `unit_u8(x)` as a float in 0..=255 (the shade epilogue)
    MUnitU8,
    // integer / fixed macros (wrapping, VM div-by-zero rules)
    MIAdd,
    MISub,
    MIMul,
    MIDiv0,
    MIMod0,
    MINeg,
    MIAbs,
    MIMin,
    MIMax,
    /// Q16.16 `(a*b) >> 16` (i64 product)
    MMulFix,
    /// `a as f32`
    MI2F,
    /// `f2i` (truncate, saturate, NaN -> 0)
    MF2I,
    /// `f32_to_fix(x, frac)`
    MF2Fix(u8),
    /// `fix_to_f32(a, frac)`
    MFix2F(u8),
    /// arithmetic shift by a signed amount (FixRescale / LoadCtxFix rescale)
    MShift(i8),
    /// `RetRgb8` channel: clamp(int, 0, 255) as a float
    MClamp255,

    // ---- primitives -------------------------------------------------------
    FAdd,
    FSub,
    FMul,
    /// native (GPU-precision) division — Native profile only
    FDiv,
    /// sign-bit flip (exact)
    FNeg,
    /// sign-bit clear (exact)
    FAbs,
    FLt,
    FLe,
    FGt,
    FGe,
    FEq,
    FNe,
    /// floor (exact on every GPU for |x| < 2^31; Native profile)
    NFloor,
    NSin,
    NCos,
    NExp,
    NLog,
    NSqrt,
    NPow,
    NAtan2,
    /// reinterpret f32 bits as a word
    FBits,
    /// reinterpret a word as f32
    UFloat,
    /// signed int -> f32 (exact for |x| < 2^24, RNE beyond)
    I2F,
    /// unsigned int -> f32
    U2F,
    /// f32 -> unsigned (only used on exactly-integral 0..=255 outputs)
    F2U,
    /// f32 -> signed, round toward zero (OpConvertFToS)
    F2I,
    IAdd,
    ISub,
    IMul,
    /// signed high word of the 64-bit product
    IMulHi,
    /// signed divide / remainder (VM wrapping; residual at INT_MIN/-1)
    IDiv,
    IMod,
    Shl,
    LShr,
    AShr,
    And,
    Or,
    Xor,
    ILt,
    ILe,
    IGt,
    IGe,
    IEq,
    INe,
    ULt,
    UGe,
    BAnd,
    BOr,
    BNot,
    /// `b ? x : y`
    Sel,
    /// `tables[t][clamp(i)]` — a constant f32 table
    Lut(u8),
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Node {
    pub op: Op,
    pub args: [NodeId; 3],
    pub n: u8,
}

impl Node {
    pub fn args(&self) -> &[NodeId] {
        &self.args[..self.n as usize]
    }
}

/// Constant tables referenced by `Op::Lut`.
pub const LUT_SINF: u8 = 0;

/// The DAG arena with hash-consing (structural CSE).
#[derive(Clone, Default)]
pub struct Graph {
    pub nodes: Vec<Node>,
    cse: HashMap<Node, NodeId>,
}

impl Graph {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn node(&self, id: NodeId) -> &Node {
        &self.nodes[id as usize]
    }

    pub fn len(&self) -> usize {
        self.nodes.len()
    }

    pub fn is_empty(&self) -> bool {
        self.nodes.is_empty()
    }

    fn intern(&mut self, n: Node) -> NodeId {
        if let Some(&id) = self.cse.get(&n) {
            return id;
        }
        let id = self.nodes.len() as NodeId;
        self.nodes.push(n);
        self.cse.insert(n, id);
        id
    }

    pub fn add(&mut self, op: Op, args: &[NodeId]) -> NodeId {
        let mut a = [0; 3];
        a[..args.len()].copy_from_slice(args);
        // A few algebraic identities that if-conversion produces a lot of.
        match op {
            Op::Sel => {
                if let Op::ConstB(c) = self.node(args[0]).op {
                    return if c { args[1] } else { args[2] };
                }
                if args[1] == args[2] {
                    return args[1];
                }
            }
            Op::MSel => {
                if let Op::ConstF(c) = self.node(args[0]).op {
                    return if f32::from_bits(c) != 0.0 { args[1] } else { args[2] };
                }
                if args[1] == args[2] {
                    return args[1];
                }
            }
            Op::MAnd => {
                for (x, y) in [(args[0], args[1]), (args[1], args[0])] {
                    if let Op::ConstF(c) = self.node(x).op {
                        let c = f32::from_bits(c);
                        if c != 0.0 && self.is_mbool(y) {
                            return y;
                        }
                        if c == 0.0 {
                            return self.cf(0.0);
                        }
                    }
                }
            }
            Op::MOr => {
                for (x, y) in [(args[0], args[1]), (args[1], args[0])] {
                    if let Op::ConstF(c) = self.node(x).op {
                        let c = f32::from_bits(c);
                        if c == 0.0 && self.is_mbool(y) {
                            return y;
                        }
                        if c != 0.0 {
                            return self.cf(1.0);
                        }
                    }
                }
            }
            Op::BAnd => {
                for (x, y) in [(args[0], args[1]), (args[1], args[0])] {
                    if let Op::ConstB(c) = self.node(x).op {
                        return if c { y } else { x };
                    }
                }
            }
            Op::BOr => {
                for (x, y) in [(args[0], args[1]), (args[1], args[0])] {
                    if let Op::ConstB(c) = self.node(x).op {
                        return if c { x } else { y };
                    }
                }
            }
            _ => {}
        }
        self.intern(Node { op, args: a, n: args.len() as u8 })
    }

    /// Whether `id` is a macro boolean (a value that is exactly 0.0 or 1.0).
    pub fn is_mbool(&self, id: NodeId) -> bool {
        match self.node(id).op {
            Op::MCmp(_) | Op::MICmp(_) | Op::MNot | Op::MAnd | Op::MOr => true,
            Op::ConstF(c) => c == 0 || c == 1.0f32.to_bits(),
            _ => false,
        }
    }

    pub fn cf(&mut self, v: f32) -> NodeId {
        self.add(Op::ConstF(v.to_bits()), &[])
    }
    pub fn cfb(&mut self, bits: u32) -> NodeId {
        self.add(Op::ConstF(bits), &[])
    }
    pub fn cu(&mut self, v: u32) -> NodeId {
        self.add(Op::ConstU(v), &[])
    }
    pub fn ci(&mut self, v: i32) -> NodeId {
        self.add(Op::ConstU(v as u32), &[])
    }
    pub fn cb(&mut self, v: bool) -> NodeId {
        self.add(Op::ConstB(v), &[])
    }
    pub fn input(&mut self, s: Src) -> NodeId {
        self.add(Op::Input(s), &[])
    }

    /// The natural type of a node's value.
    pub fn ty(&self, id: NodeId) -> Ty {
        ty_of(self.node(id).op, |i| self.ty(self.node(id).args[i]))
    }

    /// Nodes reachable from `roots` (a liveness mask over the arena).
    pub fn live(&self, roots: &[NodeId]) -> Vec<bool> {
        let mut live = vec![false; self.nodes.len()];
        for &r in roots {
            live[r as usize] = true;
        }
        for i in (0..self.nodes.len()).rev() {
            if live[i] {
                for &a in self.nodes[i].args() {
                    live[a as usize] = true;
                }
            }
        }
        live
    }
}

/// Natural result type of `op` (`arg_ty(i)` gives operand i's type, used by the
/// polymorphic `Sel`/`MSel`).
pub fn ty_of(op: Op, arg_ty: impl Fn(usize) -> Ty) -> Ty {
    use Op::*;
    match op {
        ConstF(_) => Ty::F,
        ConstU(_) => Ty::U,
        ConstB(_) => Ty::B,
        Input(s) => match s {
            Src::LedCtxFix(..) | Src::FrameCtxFix(..) => Ty::U,
            _ => Ty::F,
        },
        MSel | Sel => arg_ty(1),
        MIAdd | MISub | MIMul | MIDiv0 | MIMod0 | MINeg | MIAbs | MIMin | MIMax | MMulFix | MF2I
        | MF2Fix(_) | MShift(_) => Ty::U,
        FBits | IAdd | ISub | IMul | IMulHi | IDiv | IMod | Shl | LShr | AShr | And | Or | Xor
        | F2U | F2I => Ty::U,
        FLt | FLe | FGt | FGe | FEq | FNe | ILt | ILe | IGt | IGe | IEq | INe | ULt | UGe | BAnd
        | BOr | BNot => Ty::B,
        _ => Ty::F,
    }
}

impl Op {
    pub fn is_macro(self) -> bool {
        use Op::*;
        matches!(
            self,
            MAdd | MSub
                | MMul
                | MDiv0
                | MDivRaw
                | MNeg
                | MUn(_)
                | MBin(_)
                | MCmp(_)
                | MICmp(_)
                | MNot
                | MAnd
                | MOr
                | MSel
                | MHash1
                | MHash3
                | MClamp01
                | MSqrt
                | MHsv(_)
                | MPal(..)
                | MUnitU8
                | MIAdd
                | MISub
                | MIMul
                | MIDiv0
                | MIMod0
                | MINeg
                | MIAbs
                | MIMin
                | MIMax
                | MMulFix
                | MI2F
                | MF2I
                | MF2Fix(_)
                | MFix2F(_)
                | MShift(_)
                | MClamp255
        )
    }
}
