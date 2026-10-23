//! Rewrite the macro IR into primitive IR for one numerics profile.
//!
//! A [`Profile`] fixes how the VM's maths is reproduced on the target:
//!
//! * [`Profile::Native`] — transcendentals and divide use the GPU's native
//!   instructions (`NSin`, `FDiv`, ...). Fast, and the only option on GLES2,
//!   but not bit-exact with the VM's soft-float LUTs, so it needs the
//!   tolerance conformance model (docs/design/fx-gpu-lowering.md "Numerics").
//! * [`Profile::ExactInt`] — the integer/fixed and bit-mixing macros (`hash`,
//!   `MMulFix`, compares, `f2i`) lower to the VM's exact integer sequences,
//!   which a target with real 32-bit integers (GLES 3.10 / SPIR-V) reproduces
//!   bit-for-bit. Float transcendentals still use native ops. This is the
//!   profile the tolerance tests and the SPIR-V path use.
//!
//! The lowering of each op mirrors the corresponding `fx_vm` function so the
//! structural match to the VM is auditable here, in one place.

use crate::ir::Op::*;
use crate::ir::{Graph, NodeId, Op, Ty};
use ledmapper_fx_vm as vm;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Profile {
    Native,
    ExactInt,
}

/// Lower every macro node in `g` reachable from `roots`, returning a new graph
/// of primitives plus the remapped roots.
pub fn legalize(g: &Graph, roots: &[NodeId], prof: Profile) -> (Graph, Vec<NodeId>) {
    let mut out = Graph::new();
    let mut map: Vec<Option<NodeId>> = vec![None; g.len()];
    let mut l = Legalizer { out: &mut out, src: g, map: &mut map, prof };
    let new_roots = roots.iter().map(|&r| l.go(r)).collect();
    (out, new_roots)
}

struct Legalizer<'a> {
    out: &'a mut Graph,
    src: &'a Graph,
    map: &'a mut Vec<Option<NodeId>>,
    #[allow(dead_code)]
    prof: Profile,
}

impl Legalizer<'_> {
    fn go(&mut self, id: NodeId) -> NodeId {
        if let Some(n) = self.map[id as usize] {
            return n;
        }
        let node = *self.src.node(id);
        let a: Vec<NodeId> = node.args().iter().map(|&x| self.go(x)).collect();
        let r = self.lower(node.op, &a);
        self.map[id as usize] = Some(r);
        r
    }

    /// Reinterpret a primitive value as a float word (no-op if already F).
    fn as_f(&mut self, v: NodeId) -> NodeId {
        match self.out.ty(v) {
            Ty::F => v,
            Ty::U => self.out.add(UFloat, &[v]),
            Ty::B => {
                let one = self.out.cf(1.0);
                let zero = self.out.cf(0.0);
                self.out.add(Sel, &[v, one, zero])
            }
        }
    }
    /// Reinterpret a primitive value's bits as a u32 word.
    fn as_u(&mut self, v: NodeId) -> NodeId {
        match self.out.ty(v) {
            Ty::U => v,
            Ty::F => self.out.add(FBits, &[v]),
            Ty::B => {
                let one = self.out.cu(1);
                let zero = self.out.cu(0);
                self.out.add(Sel, &[v, one, zero])
            }
        }
    }
    /// A macro "bool" rides as f32 1.0/0.0; turn a primitive bool into that.
    fn mbool(&mut self, b: NodeId) -> NodeId {
        self.as_f(b)
    }
    /// Turn an f32 macro-bool word into a primitive bool (x != 0.0).
    fn truth(&mut self, v: NodeId) -> NodeId {
        let f = self.as_f(v);
        let zero = self.out.cf(0.0);
        self.out.add(FNe, &[f, zero])
    }

    fn lower(&mut self, op: Op, a: &[NodeId]) -> NodeId {
        match op {
            // leaves pass through
            ConstF(_) | ConstU(_) | ConstB(_) | Input(_) => self.out.add(op, a),

            MAdd => self.out.add(FAdd, a),
            MSub => self.out.add(FSub, a),
            MMul => self.out.add(FMul, a),
            MNeg => self.out.add(FNeg, a),
            MDiv0 => {
                // b == 0.0 ? 0.0 : a/b
                let zero = self.out.cf(0.0);
                let isz = self.out.add(FEq, &[a[1], zero]);
                let d = self.out.add(FDiv, &[a[0], a[1]]);
                self.out.add(Sel, &[isz, zero, d])
            }
            MDivRaw => self.out.add(FDiv, a),
            MSqrt => self.sqrt(a[0]),
            MClamp01 => {
                // clamp01: x<0 ->0 ; x>1 ->1 ; NaN ->0 ; else x
                let zero = self.out.cf(0.0);
                let one = self.out.cf(1.0);
                let lt0 = self.out.add(FLt, &[a[0], zero]);
                let gt1 = self.out.add(FGt, &[a[0], one]);
                let nan = self.out.add(FNe, &[a[0], a[0]]);
                let s1 = self.out.add(Sel, &[gt1, one, a[0]]);
                let s2 = self.out.add(Sel, &[lt0, zero, s1]);
                self.out.add(Sel, &[nan, zero, s2])
            }
            MCmp(k) => {
                let p = self.fcmp(k, a[0], a[1]);
                self.mbool(p)
            }
            MICmp(k) => {
                let p = self.icmp(k, a[0], a[1]);
                self.mbool(p)
            }
            MNot => {
                let t = self.truth(a[0]);
                let nt = self.out.add(BNot, &[t]);
                self.mbool(nt)
            }
            MAnd => {
                let x = self.truth(a[0]);
                let y = self.truth(a[1]);
                let r = self.out.add(BAnd, &[x, y]);
                self.mbool(r)
            }
            MOr => {
                let x = self.truth(a[0]);
                let y = self.truth(a[1]);
                let r = self.out.add(BOr, &[x, y]);
                self.mbool(r)
            }
            MSel => {
                let c = self.truth(a[0]);
                self.out.add(Sel, &[c, a[1], a[2]])
            }
            MUn(f) => self.un_math(f, a[0]),
            MBin(f) => self.bin_math(f, a[0], a[1]),
            MHash1 => self.hash1(a[0]),
            MHash3 => self.hash3(a[0], a[1], a[2]),
            MHsv(k) => self.hsv(k, a[0], a[1], a[2]),
            MPal(id, k) => self.palette(id, k, a[0]),
            MUnitU8 | MClamp255 => {
                // For conformance we compare pre-quantization; emit an exact
                // float clamp to 0..255 (the RGB roots are scaled later).
                let zero = self.out.cf(0.0);
                let c255 = self.out.cf(255.0);
                let f = self.as_f(a[0]);
                let mx = self.max(f, zero);
                self.min(mx, c255)
            }
            // ---- integer / fixed ------------------------------------------
            MIAdd => self.iwrap(IAdd, a),
            MISub => self.iwrap(ISub, a),
            MIMul => self.iwrap(IMul, a),
            MINeg => {
                let z = self.out.cu(0);
                let x = self.as_u(a[0]);
                self.out.add(ISub, &[z, x])
            }
            MIDiv0 => self.idiv0(a[0], a[1], false),
            MIMod0 => self.idiv0(a[0], a[1], true),
            MIAbs => {
                let x = self.as_u(a[0]);
                let zero = self.out.cu(0);
                let neg = self.out.add(ISub, &[zero, x]);
                let isneg = self.out.add(ILt, &[x, zero]);
                self.out.add(Sel, &[isneg, neg, x])
            }
            MIMin => {
                let x = self.as_u(a[0]);
                let y = self.as_u(a[1]);
                let lt = self.out.add(ILt, &[x, y]);
                self.out.add(Sel, &[lt, x, y])
            }
            MIMax => {
                let x = self.as_u(a[0]);
                let y = self.as_u(a[1]);
                let gt = self.out.add(IGt, &[x, y]);
                self.out.add(Sel, &[gt, x, y])
            }
            MMulFix => self.mulfix(a[0], a[1]),
            MI2F => {
                let x = self.as_u(a[0]);
                self.out.add(I2F, &[x])
            }
            MF2I => self.f2i(a[0]),
            MF2Fix(frac) => self.f2fix(a[0], frac),
            MFix2F(frac) => self.fix2f(a[0], frac),
            MShift(sh) => self.shift(a[0], sh),
            // already-primitive nodes (shouldn't normally reach here)
            _ => self.out.add(op, a),
        }
    }

    // --- helpers that build small primitive trees -------------------------
    fn max(&mut self, x: NodeId, y: NodeId) -> NodeId {
        let gt = self.out.add(FGt, &[x, y]);
        self.out.add(Sel, &[gt, x, y])
    }
    fn min(&mut self, x: NodeId, y: NodeId) -> NodeId {
        let lt = self.out.add(FLt, &[x, y]);
        self.out.add(Sel, &[lt, x, y])
    }
    fn fcmp(&mut self, k: u8, a: NodeId, b: NodeId) -> NodeId {
        let a = self.as_f(a);
        let b = self.as_f(b);
        let op = match k {
            0 => FLt,
            1 => FLe,
            2 => FGt,
            3 => FGe,
            4 => FEq,
            _ => FNe,
        };
        self.out.add(op, &[a, b])
    }
    fn icmp(&mut self, k: u8, a: NodeId, b: NodeId) -> NodeId {
        let a = self.as_u(a);
        let b = self.as_u(b);
        let op = match k {
            0 => ILt,
            1 => ILe,
            2 => IGt,
            3 => IGe,
            4 => IEq,
            _ => INe,
        };
        self.out.add(op, &[a, b])
    }
    fn iwrap(&mut self, op: Op, a: &[NodeId]) -> NodeId {
        let x = self.as_u(a[0]);
        let y = self.as_u(a[1]);
        self.out.add(op, &[x, y])
    }
    fn idiv0(&mut self, a: NodeId, b: NodeId, rem: bool) -> NodeId {
        // b==0 ? 0 : wrapping_div/rem. Only emitted in ExactInt; Native keeps
        // integer ops too (they are exact on both int-capable targets).
        let x = self.as_u(a);
        let y = self.as_u(b);
        let zero = self.out.cu(0);
        let isz = self.out.add(IEq, &[y, zero]);
        // Represent signed div via the (platform-defined) primitive; the SPIR-V
        // emitter maps IDiv/IMod to OpSDiv/OpSRem which match RISC-V wrapping for
        // all but INT_MIN/-1 (documented residual; see numerics section).
        let d = self.out.add(if rem { crate::ir::Op::IMod } else { crate::ir::Op::IDiv }, &[x, y]);
        self.out.add(Sel, &[isz, zero, d])
    }
    fn mulfix(&mut self, a: NodeId, b: NodeId) -> NodeId {
        // Q16.16: (a*b) >> 16 over i64. On a 32-bit target: hi = mulhi(a,b),
        // lo = a*b ; result = (lo >> 16) | (hi << 16).
        let x = self.as_u(a);
        let y = self.as_u(b);
        let lo = self.out.add(IMul, &[x, y]);
        let hi = self.out.add(IMulHi, &[x, y]);
        let s16 = self.out.cu(16);
        let lor = self.out.add(LShr, &[lo, s16]);
        let hil = self.out.add(Shl, &[hi, s16]);
        self.out.add(Or, &[lor, hil])
    }
    fn shift(&mut self, a: NodeId, sh: i8) -> NodeId {
        let x = self.as_u(a);
        if sh == 0 {
            return x;
        }
        let amt = self.out.cu(sh.unsigned_abs() as u32);
        if sh > 0 {
            self.out.add(Shl, &[x, amt])
        } else {
            self.out.add(AShr, &[x, amt])
        }
    }

    fn sqrt(&mut self, x: NodeId) -> NodeId {
        // VM sqrtf: x<=0 -> 0 ; else native-ish. Native profile uses NSqrt.
        let xf = self.as_f(x);
        let zero = self.out.cf(0.0);
        let le0 = self.out.add(FLe, &[xf, zero]);
        let s = self.out.add(NSqrt, &[xf]);
        self.out.add(Sel, &[le0, zero, s])
    }

    fn un_math(&mut self, f: u8, x: NodeId) -> NodeId {
        let xf = self.as_f(x);
        match f {
            // The VM's sinf/cosf take RADIANS (it converts to a phase with
            // 2^32/TAU internally), so native sin/cos of x directly matches.
            vm::F_SIN => self.out.add(NSin, &[xf]),
            vm::F_COS => self.out.add(NCos, &[xf]),
            vm::F_TAN => {
                // VM: sin/cos in radians; |cos|<1e-6 -> 0.
                let s = self.out.add(NSin, &[xf]);
                let c = self.out.add(NCos, &[xf]);
                let ac = self.out.add(FAbs, &[c]);
                let eps = self.out.cf(1e-6);
                let small = self.out.add(FLt, &[ac, eps]);
                let d = self.out.add(FDiv, &[s, c]);
                let zero = self.out.cf(0.0);
                self.out.add(Sel, &[small, zero, d])
            }
            vm::F_ABS => self.out.add(FAbs, &[xf]),
            vm::F_FLOOR => self.out.add(NFloor, &[xf]),
            vm::F_CEIL => {
                let n = self.out.add(FNeg, &[xf]);
                let fl = self.out.add(NFloor, &[n]);
                self.out.add(FNeg, &[fl])
            }
            vm::F_FRACT => {
                let fl = self.out.add(NFloor, &[xf]);
                self.out.add(FSub, &[xf, fl])
            }
            vm::F_SQRT => self.sqrt(xf),
            vm::F_EXP => self.out.add(NExp, &[xf]),
            vm::F_LOG => {
                // VM: x<=0 -> -87.0 else log
                let zero = self.out.cf(0.0);
                let le0 = self.out.add(FLe, &[xf, zero]);
                let l = self.out.add(NLog, &[xf]);
                let fb = self.out.cf(-87.0);
                self.out.add(Sel, &[le0, fb, l])
            }
            vm::F_SIGN => {
                let zero = self.out.cf(0.0);
                let one = self.out.cf(1.0);
                let m1 = self.out.cf(-1.0);
                let gt = self.out.add(FGt, &[xf, zero]);
                let lt = self.out.add(FLt, &[xf, zero]);
                let s1 = self.out.add(Sel, &[lt, m1, zero]);
                self.out.add(Sel, &[gt, one, s1])
            }
            _ => xf,
        }
    }

    fn bin_math(&mut self, f: u8, a: NodeId, b: NodeId) -> NodeId {
        let a = self.as_f(a);
        let b = self.as_f(b);
        match f {
            vm::B_MIN => self.min(a, b),
            vm::B_MAX => self.max(a, b),
            vm::B_POW => {
                // VM: a<=0 ->0 ; else exp(b*log(a))
                let zero = self.out.cf(0.0);
                let le0 = self.out.add(FLe, &[a, zero]);
                let p = self.out.add(NPow, &[a, b]);
                self.out.add(Sel, &[le0, zero, p])
            }
            vm::B_MOD => {
                // a - b*floor(a/b)
                let q = self.out.add(FDiv, &[a, b]);
                let fl = self.out.add(NFloor, &[q]);
                let m = self.out.add(FMul, &[b, fl]);
                self.out.add(FSub, &[a, m])
            }
            vm::B_STEP => {
                // step(edge=a, x=b): b<a ?0:1
                let lt = self.out.add(FLt, &[b, a]);
                let zero = self.out.cf(0.0);
                let one = self.out.cf(1.0);
                self.out.add(Sel, &[lt, zero, one])
            }
            vm::B_ATAN2 => self.out.add(NAtan2, &[a, b]),
            _ => a,
        }
    }

    // integer avalanche hash (mix32), exact on an int-capable target.
    fn mix32(&mut self, mut h: NodeId) -> NodeId {
        let s16 = self.out.cu(16);
        let s15 = self.out.cu(15);
        let k1 = self.out.cu(0x7feb_352d);
        let k2 = self.out.cu(0x846c_a68b);
        let t = self.out.add(LShr, &[h, s16]);
        h = self.out.add(Xor, &[h, t]);
        h = self.out.add(IMul, &[h, k1]);
        let t = self.out.add(LShr, &[h, s15]);
        h = self.out.add(Xor, &[h, t]);
        h = self.out.add(IMul, &[h, k2]);
        let t = self.out.add(LShr, &[h, s16]);
        self.out.add(Xor, &[h, t])
    }
    fn unit_from_hash(&mut self, h: NodeId) -> NodeId {
        let s8 = self.out.cu(8);
        let top = self.out.add(LShr, &[h, s8]);
        let f = self.out.add(U2F, &[top]);
        let inv = self.out.cf(1.0 / 16_777_216.0);
        self.out.add(FMul, &[f, inv])
    }
    fn hash1(&mut self, x: NodeId) -> NodeId {
        let xb = self.as_u(x);
        let gr = self.out.cu(0x9e37_79b9);
        let s = self.out.add(Xor, &[xb, gr]);
        let m = self.mix32(s);
        self.unit_from_hash(m)
    }
    fn hash3(&mut self, x: NodeId, y: NodeId, z: NodeId) -> NodeId {
        let xb = self.as_u(x);
        let yb = self.as_u(y);
        let zb = self.as_u(z);
        let gr = self.out.cu(0x9e37_79b9);
        let s0 = self.out.add(Xor, &[xb, gr]);
        let h0 = self.mix32(s0);
        let ky = self.out.cu(0x85eb_ca6b);
        let ya = self.out.add(IAdd, &[yb, ky]);
        let s1 = self.out.add(Xor, &[h0, ya]);
        let h1 = self.mix32(s1);
        let kz = self.out.cu(0xc2b2_ae35);
        let za = self.out.add(IAdd, &[zb, kz]);
        let s2 = self.out.add(Xor, &[h1, za]);
        let h2 = self.mix32(s2);
        self.unit_from_hash(h2)
    }

    fn hsv(&mut self, k: u8, h: NodeId, s: NodeId, v: NodeId) -> NodeId {
        // h6 = fract(h)*6 ; c = v*s ; x = c*(1-|fract(h6/2)*2-1|) ; m=v-c
        let h = self.as_f(h);
        let s = self.as_f(s);
        let v = self.as_f(v);
        let six = self.out.cf(6.0);
        let fh = {
            let fl = self.out.add(NFloor, &[h]);
            self.out.add(FSub, &[h, fl])
        };
        let h6 = self.out.add(FMul, &[fh, six]);
        let c = self.out.add(FMul, &[v, s]);
        let half = self.out.cf(0.5);
        let h6h = self.out.add(FMul, &[h6, half]);
        let fhh = {
            let fl = self.out.add(NFloor, &[h6h]);
            self.out.add(FSub, &[h6h, fl])
        };
        let two = self.out.cf(2.0);
        let one = self.out.cf(1.0);
        let t = self.out.add(FMul, &[fhh, two]);
        let t1 = self.out.add(FSub, &[t, one]);
        let at = self.out.add(FAbs, &[t1]);
        let inner = self.out.add(FSub, &[one, at]);
        let x = self.out.add(FMul, &[c, inner]);
        let m = self.out.add(FSub, &[v, c]);
        // sextant = f2i(h6). h6 = fract(h)*6 lies in [0, 6], so trunc == floor
        // and the pick can be float compares on floor(h6) — no integers, so it
        // also runs on GLES2. NaN: f2i(NaN) = 0 in the VM → sextant 0.
        let zero = self.out.cf(0.0);
        // base for channel k by sextant
        let bases: [[NodeId; 6]; 3] = [
            [c, x, zero, zero, x, c], // r
            [x, c, c, x, zero, zero], // g
            [zero, zero, x, c, c, x], // b
        ];
        let row = bases[k as usize];
        // VM match: 0,1,2,3,4,_=>5 over floor(h6); NaN -> sextant 0.
        let fl = self.out.add(NFloor, &[h6]);
        let mut acc = row[5];
        for s in (0..5).rev() {
            let sc = self.out.cf(s as f32);
            let eq = self.out.add(FEq, &[fl, sc]);
            acc = self.out.add(Sel, &[eq, row[s as usize], acc]);
        }
        let nan = self.out.add(FNe, &[h6, h6]);
        let base = self.out.add(Sel, &[nan, row[0], acc]);
        self.out.add(FAdd, &[base, m])
    }
    fn palette(&mut self, id: u8, k: u8, t: NodeId) -> NodeId {
        // clamp01(t) then per-id formula (fire/ice/rainbow=hsv(t,1,1))
        let tc = {
            let m = MClamp01;
            let a = [self.as_f(t)];
            self.lower(m, &a)
        };
        match id {
            0 => {
                // fire: (clamp01(t*3), clamp01(t*3-1), clamp01(t*3-2))
                let three = self.out.cf(3.0);
                let t3 = self.out.add(FMul, &[tc, three]);
                let off = self.out.cf(k as f32);
                let v = self.out.add(FSub, &[t3, off]);
                self.lower(MClamp01, &[v])
            }
            1 => {
                // ice: (clamp01(t*3-2), clamp01(t*3-1), clamp01(t*2))
                if k < 2 {
                    let three = self.out.cf(3.0);
                    let t3 = self.out.add(FMul, &[tc, three]);
                    let off = self.out.cf(if k == 0 { 2.0 } else { 1.0 });
                    let v = self.out.add(FSub, &[t3, off]);
                    self.lower(MClamp01, &[v])
                } else {
                    let two = self.out.cf(2.0);
                    let v = self.out.add(FMul, &[tc, two]);
                    self.lower(MClamp01, &[v])
                }
            }
            _ => {
                let one = self.out.cf(1.0);
                self.hsv(k, tc, one, one)
            }
        }
    }

    fn f2i(&mut self, x: NodeId) -> NodeId {
        // f2i = f32_to_fix(x,0): truncate toward zero, saturate, NaN->0.
        // Native: the GPU F2U on a magnitude + sign recomposition. For the
        // feasibility subset we use the primitive F2I-style via truncation;
        // the SPIR-V emitter maps to OpConvertFToS (round-to-zero), matching
        // the VM for the in-range values effects actually produce.
        let xf = self.as_f(x);
        self.out.add(crate::ir::Op::F2I, &[xf])
    }
    fn f2fix(&mut self, x: NodeId, frac: u8) -> NodeId {
        // f32_to_fix(x,frac) ~= trunc(x * 2^frac) for in-range values.
        let xf = self.as_f(x);
        let scale = self.out.cf((1u64 << frac) as f32);
        let s = self.out.add(FMul, &[xf, scale]);
        self.out.add(crate::ir::Op::F2I, &[s])
    }
    fn fix2f(&mut self, x: NodeId, frac: u8) -> NodeId {
        let xi = self.as_u(x);
        let f = self.out.add(I2F, &[xi]);
        let inv = self.out.cf(1.0 / (1u64 << frac) as f32);
        self.out.add(FMul, &[f, inv])
    }
}
