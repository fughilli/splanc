//! Effects bytecode VM (see docs/design/effects-runtime.md).
//!
//! A tiny stack machine over `f32` slots (a `vecN` is N contiguous slots; the
//! compiler guarantees types so the VM is untyped at runtime). It runs a
//! program's `update()` once per frame (evolving `state`) and `shade(led)` once
//! per LED (returning linear RGB). no_std, no alloc — bounded fixed arrays,
//! borrows the `.fxb` bytes so the firmware can execute straight from the flash
//! range LittleFS mapped. The SAME crate compiles to wasm for the offline
//! preview, so the browser and the device render identically.
#![no_std]

pub type Rgb = (u8, u8, u8);

pub const MAX_STACK: usize = 128; // f32 slots
pub const MAX_STATE: usize = 64;
pub const MAX_LOCALS: usize = 64;
pub const MAX_UNIFORM_SLOTS: usize = 128;

/// Opcodes. Operands follow inline in the code stream (little-endian).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Op {
    PushConst = 0, // u16 const idx        -> push consts[idx] (1 slot)
    LoadUniform,   // u8 slot, u8 n        -> push uniforms[slot..slot+n]
    LoadState,     // u8 slot, u8 n        -> push state[..]
    StoreState,    // u8 slot, u8 n        -> pop n into state[..]
    LoadLocal,     // u8 slot, u8 n
    StoreLocal,    // u8 slot, u8 n
    LoadCtx,       // u8 id                -> push a context value (size by id)
    // element-wise arithmetic, operand u8 n (components)
    Add,
    Sub,
    Mul,
    Div,
    Neg,
    Scale, // u8 n: pop n-vec then scalar -> n-vec * scalar
    // unary math applied per component, operand: u8 fn, u8 n
    UnMath,
    // binary math per component, operand: u8 fn, u8 n
    BinMath,
    Clamp,      // u8 n: pop x(n),lo(n),hi(n)
    Mix,        // u8 n: pop a(n),b(n),t(1) -> a+(b-a)*t
    Smoothstep, // u8 n: pop e0(n),e1(n),x(n)
    Dot,        // u8 n -> scalar
    Cross,      // (n=3) pop a(3),b(3) -> 3
    Length,     // u8 n -> scalar
    Normalize,  // u8 n
    Distance,   // u8 n -> scalar
    Swizzle,    // u8 srcN, u8 dstN, dstN bytes of component indices
    Cmp,        // u8 kind (0lt 1le 2gt 3ge 4eq 5ne) scalar -> bool(0/1)
    Logic,      // u8 kind (0and 1or 2not)
    BrFalse,    // i16 rel: pop bool; branch if 0
    Jmp,        // i16 rel
    Hash1,      // scalar -> scalar in [0,1)
    Hash3,      // pop vec3 -> scalar
    Hsv2Rgb,    // pop vec3(h,s,v) -> vec3 rgb
    Palette,    // u8 id: pop scalar t -> vec3
    Pop,        // u8 n
    Ret,        // return `n` slots (0 for update, 3 for shade) : u8 n
    // --- integer / Q16.16 fixed-point fast path (scalar, no FPU) ------------
    Swap,   // u8 an, u8 bn : swap the top bn slots with the an below (broadcast)
    AddI,   // i32 add
    SubI,
    MulI,
    DivI,
    ModI,
    NegI,
    CmpI,   // u8 kind : integer compare -> bool
    MulFix, // Q16.16: (a*b)>>16
    DivFix, // Q16.16: (a<<16)/b
    I2F,    // i32 -> f32
    F2I,    // f32 -> i32 (trunc)
    Fix2F,  // Q16.16 -> f32
    F2Fix,  // f32 -> Q16.16
    I2Fix,  // i32 -> Q16.16 (<<16)
    Fix2I,  // Q16.16 -> i32 (>>16)
    // --- user functions -----------------------------------------------------
    Call,  // u16 target : push return pc, jump
    RetFn, // pop return pc, jump back (values left on the operand stack)
}

pub const FIX_ONE: i32 = 1 << 16;

impl Op {
    #[inline]
    fn from_u8(b: u8) -> Option<Op> {
        // Op is a contiguous enum 0..=RetFn; guard the range then transmute.
        if b <= Op::RetFn as u8 {
            Some(unsafe { core::mem::transmute::<u8, Op>(b) })
        } else {
            None
        }
    }
}

// unary math fn ids
pub const F_SIN: u8 = 0;
pub const F_COS: u8 = 1;
pub const F_ABS: u8 = 2;
pub const F_FLOOR: u8 = 3;
pub const F_CEIL: u8 = 4;
pub const F_FRACT: u8 = 5;
pub const F_SQRT: u8 = 6;
pub const F_EXP: u8 = 7;
pub const F_LOG: u8 = 8;
pub const F_SIGN: u8 = 9;
pub const F_TAN: u8 = 10;
// binary math fn ids
pub const B_MIN: u8 = 0;
pub const B_MAX: u8 = 1;
pub const B_POW: u8 = 2;
pub const B_MOD: u8 = 3;
pub const B_STEP: u8 = 4; // step(edge, x)
pub const B_ATAN2: u8 = 5;

// context value ids (LoadCtx)
pub const C_TIME: u8 = 0; // 1
pub const C_DT: u8 = 1; // 1
pub const C_FRAME: u8 = 2; // 1
pub const C_LED_POS: u8 = 3; // 3
pub const C_LED_IDX: u8 = 4; // 1
pub const C_LED_COUNT: u8 = 5; // 1
pub const C_LED_SEG: u8 = 6; // 1
pub const C_LED_S: u8 = 7; // 1
pub const C_LED_BRANCH: u8 = 8; // 1
pub const C_IMU_ACCEL: u8 = 9; // 3
pub const C_IMU_GYRO: u8 = 10; // 3

pub const MAGIC: [u8; 4] = *b"FXB1";
pub const NO_ENTRY: u16 = 0xFFFF;

/// A parsed program, borrowing the `.fxb` byte buffer.
pub struct Program<'a> {
    consts: &'a [u8], // n_consts * 4 bytes (LE f32; read unaligned)
    code: &'a [u8],
    pub n_state: u8,
    pub n_uniform_slots: u8,
    pub update_entry: u16, // NO_ENTRY if absent
    pub shade_entry: u16,
    /// The raw uniforms manifest (for the app; the VM ignores it).
    pub manifest: &'a [u8],
}

#[derive(Debug, PartialEq, Eq)]
pub enum ParseErr {
    TooShort,
    BadMagic,
    BadVersion,
}

fn rd_u16(b: &[u8], o: usize) -> u16 {
    u16::from_le_bytes([b[o], b[o + 1]])
}

impl<'a> Program<'a> {
    /// Header: magic(4) ver(1) flags(1) n_state(1) n_uniform_slots(1)
    /// manifest_len(2) n_consts(2) code_len(2) update_entry(2) shade_entry(2)
    pub fn parse(buf: &'a [u8]) -> Result<Program<'a>, ParseErr> {
        if buf.len() < 18 {
            return Err(ParseErr::TooShort);
        }
        if buf[0..4] != MAGIC {
            return Err(ParseErr::BadMagic);
        }
        if buf[4] != 1 {
            return Err(ParseErr::BadVersion);
        }
        let n_state = buf[6];
        let n_uniform_slots = buf[7];
        let manifest_len = rd_u16(buf, 8) as usize;
        let n_consts = rd_u16(buf, 10) as usize;
        let code_len = rd_u16(buf, 12) as usize;
        let update_entry = rd_u16(buf, 14);
        let shade_entry = rd_u16(buf, 16);
        let mut o = 18;
        let manifest = buf.get(o..o + manifest_len).ok_or(ParseErr::TooShort)?;
        o += manifest_len;
        let consts = buf.get(o..o + n_consts * 4).ok_or(ParseErr::TooShort)?;
        o += n_consts * 4;
        let code = buf.get(o..o + code_len).ok_or(ParseErr::TooShort)?;
        Ok(Program {
            consts,
            code,
            n_state,
            n_uniform_slots,
            update_entry,
            shade_entry,
            manifest,
        })
    }

    #[inline]
    fn const_f32(&self, idx: usize) -> f32 {
        let o = idx * 4;
        f32::from_le_bytes([
            self.consts[o],
            self.consts[o + 1],
            self.consts[o + 2],
            self.consts[o + 3],
        ])
    }
}

/// Per-frame context (constant across all LEDs of one frame).
#[derive(Clone, Copy, Default)]
pub struct Frame {
    pub time: f32,
    pub dt: f32,
    pub frame: u32,
    pub led_count: u32,
    pub imu_accel: [f32; 3],
    pub imu_gyro: [f32; 3],
}

/// Per-LED context.
#[derive(Clone, Copy, Default)]
pub struct Led {
    pub pos: [f32; 3],
    pub idx: u32,
    pub seg: i32,
    pub s: f32,
    pub branch: bool,
}

/// Persistent VM state across frames: uniform values + `state` vars.
pub struct Vm {
    pub uniforms: [f32; MAX_UNIFORM_SLOTS],
    pub state: [f32; MAX_STATE],
}

impl Default for Vm {
    fn default() -> Self {
        Vm {
            uniforms: [0.0; MAX_UNIFORM_SLOTS],
            state: [0.0; MAX_STATE],
        }
    }
}

impl Vm {
    pub fn new() -> Self {
        Self::default()
    }

    /// Set a uniform's value (`vals` length = its slot count).
    pub fn set_uniform(&mut self, slot: usize, vals: &[f32]) {
        for (i, v) in vals.iter().enumerate() {
            if slot + i < MAX_UNIFORM_SLOTS {
                self.uniforms[slot + i] = *v;
            }
        }
    }

    /// Run `update()` (if present), evolving `state`.
    pub fn run_update(&mut self, prog: &Program, frame: &Frame) {
        if prog.update_entry == NO_ENTRY {
            return;
        }
        let led = Led::default();
        let mut st = self.state;
        run(prog, self.uniforms, &mut st, frame, &led, prog.update_entry as usize);
        self.state = st;
    }

    /// Run `shade(led)` → RGB. Does not mutate `state` (read-only in shade).
    pub fn run_shade(&self, prog: &Program, frame: &Frame, led: &Led) -> Rgb {
        let mut st = self.state; // copy; shade shouldn't write it, but be safe
        let out = run(prog, self.uniforms, &mut st, frame, led, prog.shade_entry as usize);
        let r = clamp01(out[0]);
        let g = clamp01(out[1]);
        let b = clamp01(out[2]);
        ((r * 255.0) as u8, (g * 255.0) as u8, (b * 255.0) as u8)
    }
}

#[inline]
fn clamp01(x: f32) -> f32 {
    if x < 0.0 {
        0.0
    } else if x > 1.0 {
        1.0
    } else if x.is_nan() {
        0.0
    } else {
        x
    }
}

/// Execute from `entry`, returning up to 3 result slots (RGB for shade). A
/// bounded instruction budget hard-caps frame time and traps runaway loops.
fn run(
    prog: &Program,
    uniforms: [f32; MAX_UNIFORM_SLOTS],
    state: &mut [f32; MAX_STATE],
    frame: &Frame,
    led: &Led,
    entry: usize,
) -> [f32; 3] {
    let code = prog.code;
    let mut stack = [0.0f32; MAX_STACK];
    let mut locals = [0.0f32; MAX_LOCALS];
    let mut sp: usize = 0;
    let mut pc: usize = entry;
    let mut budget: u32 = 100_000; // instructions per invocation
    let mut call_stack = [0usize; 16];
    let mut csp: usize = 0;

    macro_rules! push {
        ($v:expr) => {{
            if sp < MAX_STACK {
                stack[sp] = $v;
                sp += 1;
            }
        }};
    }
    macro_rules! pop {
        () => {{
            sp = sp.saturating_sub(1);
            stack[sp]
        }};
    }
    // Integers/fixed ride in the f32 slots bit-for-bit (the compiler types every
    // op, so the runtime interpretation is unambiguous).
    macro_rules! popi {
        () => {{
            pop!().to_bits() as i32
        }};
    }
    macro_rules! pushi {
        ($v:expr) => {{
            let vv: i32 = $v;
            push!(f32::from_bits(vv as u32));
        }};
    }

    while pc < code.len() {
        if budget == 0 {
            break;
        }
        budget -= 1;
        let op = match Op::from_u8(code[pc]) {
            Some(o) => o,
            None => break,
        };
        pc += 1;
        match op {
            Op::PushConst => {
                let idx = rd_u16(code, pc) as usize;
                pc += 2;
                push!(prog.const_f32(idx));
            }
            Op::LoadUniform => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    push!(*uniforms.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::LoadState => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    push!(*state.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::StoreState => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in (0..n).rev() {
                    let v = pop!();
                    if slot + i < MAX_STATE {
                        state[slot + i] = v;
                    }
                }
            }
            Op::LoadLocal => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    push!(*locals.get(slot + i).unwrap_or(&0.0));
                }
            }
            Op::StoreLocal => {
                let slot = code[pc] as usize;
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in (0..n).rev() {
                    let v = pop!();
                    if slot + i < MAX_LOCALS {
                        locals[slot + i] = v;
                    }
                }
            }
            Op::LoadCtx => {
                let id = code[pc];
                pc += 1;
                match id {
                    C_TIME => push!(frame.time),
                    C_DT => push!(frame.dt),
                    C_FRAME => push!(frame.frame as f32),
                    C_LED_POS => {
                        push!(led.pos[0]);
                        push!(led.pos[1]);
                        push!(led.pos[2]);
                    }
                    C_LED_IDX => push!(led.idx as f32),
                    C_LED_COUNT => push!(frame.led_count as f32),
                    C_LED_SEG => push!(led.seg as f32),
                    C_LED_S => push!(led.s),
                    C_LED_BRANCH => push!(if led.branch { 1.0 } else { 0.0 }),
                    C_IMU_ACCEL => {
                        push!(frame.imu_accel[0]);
                        push!(frame.imu_accel[1]);
                        push!(frame.imu_accel[2]);
                    }
                    C_IMU_GYRO => {
                        push!(frame.imu_gyro[0]);
                        push!(frame.imu_gyro[1]);
                        push!(frame.imu_gyro[2]);
                    }
                    _ => push!(0.0),
                }
            }
            Op::Add | Op::Sub | Op::Mul | Op::Div => {
                let n = code[pc] as usize;
                pc += 1;
                // stack: a(n) b(n) ; result a op b
                let base = sp - 2 * n;
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = match op {
                        Op::Add => a + b,
                        Op::Sub => a - b,
                        Op::Mul => a * b,
                        _ => {
                            if b == 0.0 {
                                0.0
                            } else {
                                a / b
                            }
                        }
                    };
                }
                sp = base + n;
            }
            Op::Neg => {
                let n = code[pc] as usize;
                pc += 1;
                for i in 0..n {
                    stack[sp - n + i] = -stack[sp - n + i];
                }
            }
            Op::Scale => {
                let n = code[pc] as usize;
                pc += 1;
                let s = pop!();
                for i in 0..n {
                    stack[sp - n + i] *= s;
                }
            }
            Op::UnMath => {
                let f = code[pc];
                let n = code[pc + 1] as usize;
                pc += 2;
                for i in 0..n {
                    let x = stack[sp - n + i];
                    stack[sp - n + i] = un_math(f, x);
                }
            }
            Op::BinMath => {
                let f = code[pc];
                let n = code[pc + 1] as usize;
                pc += 2;
                let base = sp - 2 * n;
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = bin_math(f, a, b);
                }
                sp = base + n;
            }
            Op::Clamp => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 3 * n;
                for i in 0..n {
                    let x = stack[base + i];
                    let lo = stack[base + n + i];
                    let hi = stack[base + 2 * n + i];
                    stack[base + i] = if x < lo {
                        lo
                    } else if x > hi {
                        hi
                    } else {
                        x
                    };
                }
                sp = base + n;
            }
            Op::Mix => {
                let n = code[pc] as usize;
                pc += 1;
                let t = pop!(); // scalar t
                let base = sp - 2 * n;
                for i in 0..n {
                    let a = stack[base + i];
                    let b = stack[base + n + i];
                    stack[base + i] = a + (b - a) * t;
                }
                sp = base + n;
            }
            Op::Smoothstep => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 3 * n;
                for i in 0..n {
                    let e0 = stack[base + i];
                    let e1 = stack[base + n + i];
                    let x = stack[base + 2 * n + i];
                    let t = clamp01(if e1 == e0 { 0.0 } else { (x - e0) / (e1 - e0) });
                    stack[base + i] = t * t * (3.0 - 2.0 * t);
                }
                sp = base + n;
            }
            Op::Dot => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 2 * n;
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + n + i];
                }
                sp = base;
                push!(acc);
            }
            Op::Cross => {
                pc += 1; // n operand (always 3), ignore
                let base = sp - 6;
                let a = [stack[base], stack[base + 1], stack[base + 2]];
                let b = [stack[base + 3], stack[base + 4], stack[base + 5]];
                stack[base] = a[1] * b[2] - a[2] * b[1];
                stack[base + 1] = a[2] * b[0] - a[0] * b[2];
                stack[base + 2] = a[0] * b[1] - a[1] * b[0];
                sp = base + 3;
            }
            Op::Length => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - n;
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + i];
                }
                sp = base;
                push!(sqrtf(acc));
            }
            Op::Distance => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - 2 * n;
                let mut acc = 0.0;
                for i in 0..n {
                    let d = stack[base + i] - stack[base + n + i];
                    acc += d * d;
                }
                sp = base;
                push!(sqrtf(acc));
            }
            Op::Normalize => {
                let n = code[pc] as usize;
                pc += 1;
                let base = sp - n;
                let mut acc = 0.0;
                for i in 0..n {
                    acc += stack[base + i] * stack[base + i];
                }
                let len = sqrtf(acc);
                if len > 1e-9 {
                    for i in 0..n {
                        stack[base + i] /= len;
                    }
                }
            }
            Op::Swizzle => {
                let src_n = code[pc] as usize;
                let dst_n = code[pc + 1] as usize;
                pc += 2;
                let mut tmp = [0.0f32; 4];
                let base = sp - src_n;
                for i in 0..dst_n {
                    let ci = code[pc + i] as usize;
                    tmp[i] = *stack.get(base + ci).unwrap_or(&0.0);
                }
                pc += dst_n;
                for i in 0..dst_n {
                    stack[base + i] = tmp[i];
                }
                sp = base + dst_n;
            }
            Op::Cmp => {
                let kind = code[pc];
                pc += 1;
                let b = pop!();
                let a = pop!();
                let r = match kind {
                    0 => a < b,
                    1 => a <= b,
                    2 => a > b,
                    3 => a >= b,
                    4 => a == b,
                    _ => a != b,
                };
                push!(if r { 1.0 } else { 0.0 });
            }
            Op::Logic => {
                let kind = code[pc];
                pc += 1;
                if kind == 2 {
                    let a = pop!();
                    push!(if a != 0.0 { 0.0 } else { 1.0 });
                } else {
                    let b = pop!();
                    let a = pop!();
                    let r = if kind == 0 {
                        (a != 0.0) && (b != 0.0)
                    } else {
                        (a != 0.0) || (b != 0.0)
                    };
                    push!(if r { 1.0 } else { 0.0 });
                }
            }
            Op::BrFalse => {
                let rel = i16::from_le_bytes([code[pc], code[pc + 1]]);
                pc += 2;
                let c = pop!();
                if c == 0.0 {
                    pc = (pc as isize + rel as isize) as usize;
                }
            }
            Op::Jmp => {
                let rel = i16::from_le_bytes([code[pc], code[pc + 1]]);
                pc += 2;
                pc = (pc as isize + rel as isize) as usize;
            }
            Op::Hash1 => {
                let x = pop!();
                push!(hash1(x));
            }
            Op::Hash3 => {
                let z = pop!();
                let y = pop!();
                let x = pop!();
                push!(hash1(x * 127.1 + y * 311.7 + z * 74.7));
            }
            Op::Hsv2Rgb => {
                let v = pop!();
                let s = pop!();
                let h = pop!();
                let (r, g, b) = hsv2rgb(h, s, v);
                push!(r);
                push!(g);
                push!(b);
            }
            Op::Palette => {
                let id = code[pc];
                pc += 1;
                let t = pop!();
                let (r, g, b) = palette(id, t);
                push!(r);
                push!(g);
                push!(b);
            }
            Op::Pop => {
                let n = code[pc] as usize;
                pc += 1;
                sp = sp.saturating_sub(n);
            }
            Op::Ret => {
                let n = code[pc] as usize;
                let mut out = [0.0f32; 3];
                let base = sp.saturating_sub(n);
                for i in 0..n.min(3) {
                    out[i] = stack[base + i];
                }
                return out;
            }
            Op::Swap => {
                let an = code[pc] as usize;
                let bn = code[pc + 1] as usize;
                pc += 2;
                // stack: [.. a(an) b(bn)] -> [.. b(bn) a(an)]
                let base = sp - an - bn;
                let mut tmp = [0.0f32; 8];
                for i in 0..an {
                    tmp[i] = stack[base + i];
                }
                for i in 0..bn {
                    stack[base + i] = stack[base + an + i];
                }
                for i in 0..an {
                    stack[base + bn + i] = tmp[i];
                }
            }
            Op::AddI => {
                let b = popi!();
                let a = popi!();
                pushi!(a.wrapping_add(b));
            }
            Op::SubI => {
                let b = popi!();
                let a = popi!();
                pushi!(a.wrapping_sub(b));
            }
            Op::MulI => {
                let b = popi!();
                let a = popi!();
                pushi!(a.wrapping_mul(b));
            }
            Op::DivI => {
                let b = popi!();
                let a = popi!();
                pushi!(if b == 0 { 0 } else { a.wrapping_div(b) });
            }
            Op::ModI => {
                let b = popi!();
                let a = popi!();
                pushi!(if b == 0 { 0 } else { a.wrapping_rem(b) });
            }
            Op::NegI => {
                let a = popi!();
                pushi!(a.wrapping_neg());
            }
            Op::CmpI => {
                let kind = code[pc];
                pc += 1;
                let b = popi!();
                let a = popi!();
                let r = match kind {
                    0 => a < b,
                    1 => a <= b,
                    2 => a > b,
                    3 => a >= b,
                    4 => a == b,
                    _ => a != b,
                };
                push!(if r { 1.0 } else { 0.0 });
            }
            Op::MulFix => {
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(((a * b) >> 16) as i32);
            }
            Op::DivFix => {
                let b = popi!() as i64;
                let a = popi!() as i64;
                pushi!(if b == 0 { 0 } else { ((a << 16) / b) as i32 });
            }
            Op::I2F => {
                let a = popi!();
                push!(a as f32);
            }
            Op::F2I => {
                let a = pop!();
                pushi!(a as i32);
            }
            Op::Fix2F => {
                let a = popi!();
                push!(a as f32 / FIX_ONE as f32);
            }
            Op::F2Fix => {
                let a = pop!();
                pushi!((a * FIX_ONE as f32) as i32);
            }
            Op::I2Fix => {
                let a = popi!();
                pushi!(a.wrapping_shl(16));
            }
            Op::Fix2I => {
                let a = popi!();
                pushi!(a >> 16);
            }
            Op::Call => {
                let target = rd_u16(code, pc) as usize;
                pc += 2;
                if csp < call_stack.len() {
                    call_stack[csp] = pc;
                    csp += 1;
                }
                pc = target;
            }
            Op::RetFn => {
                if csp == 0 {
                    break;
                }
                csp -= 1;
                pc = call_stack[csp];
            }
        }
    }
    [0.0, 0.0, 0.0]
}

// --- soft-float helpers (no libm dependency; small polynomial approximations
// good enough for LED effects, deterministic on host + wasm + device) ---------

fn sqrtf(x: f32) -> f32 {
    if x <= 0.0 {
        return 0.0;
    }
    // Newton from a bit-twiddle seed.
    let mut y = f32::from_bits(0x5f37_59df - (x.to_bits() >> 1));
    y = y * (1.5 - 0.5 * x * y * y);
    y = y * (1.5 - 0.5 * x * y * y);
    x * y // x * rsqrt(x) = sqrt(x)
}

fn floorf(x: f32) -> f32 {
    let t = x as i32 as f32;
    if t > x {
        t - 1.0
    } else {
        t
    }
}
fn fractf(x: f32) -> f32 {
    x - floorf(x)
}

const PI: f32 = core::f32::consts::PI;
const TAU: f32 = 2.0 * PI;

fn sinf(x: f32) -> f32 {
    // range-reduce to [-PI,PI], then a 5th-order minimax-ish poly.
    let mut a = x - TAU * floorf(x / TAU + 0.5);
    // a in [-PI, PI]
    if a > PI {
        a -= TAU;
    }
    let a2 = a * a;
    a * (0.9999966 + a2 * (-0.16664824 + a2 * (0.00830629 + a2 * -0.00018363)))
}
fn cosf(x: f32) -> f32 {
    sinf(x + PI * 0.5)
}
fn expf(x: f32) -> f32 {
    // 2^(x/ln2) via bit manipulation + poly (adequate for decay curves).
    let xln = x * 1.442695; // x / ln2
    let i = floorf(xln);
    let f = xln - i;
    let poly = 1.0 + f * (0.6931472 + f * (0.2402265 + f * 0.0555041));
    let bits = ((i as i32 + 127) as u32) << 23;
    f32::from_bits(bits) * poly
}
fn logf(x: f32) -> f32 {
    if x <= 0.0 {
        return -87.0;
    }
    let bits = x.to_bits();
    let e = ((bits >> 23) & 0xff) as i32 - 127;
    let m = f32::from_bits((bits & 0x007f_ffff) | 0x3f80_0000); // [1,2)
    let p = -1.7417939 + m * (2.8212026 + m * (-1.4699568 + m * (0.4471623 - m * 0.0821854)));
    (e as f32) * 0.6931472 + p
}
fn powf(a: f32, b: f32) -> f32 {
    if a <= 0.0 {
        return 0.0;
    }
    expf(b * logf(a))
}
fn tanf(x: f32) -> f32 {
    let c = cosf(x);
    if c.abs() < 1e-6 {
        0.0
    } else {
        sinf(x) / c
    }
}

fn un_math(f: u8, x: f32) -> f32 {
    match f {
        F_SIN => sinf(x),
        F_COS => cosf(x),
        F_ABS => x.abs(),
        F_FLOOR => floorf(x),
        F_CEIL => -floorf(-x),
        F_FRACT => fractf(x),
        F_SQRT => sqrtf(x),
        F_EXP => expf(x),
        F_LOG => logf(x),
        F_SIGN => {
            if x > 0.0 {
                1.0
            } else if x < 0.0 {
                -1.0
            } else {
                0.0
            }
        }
        F_TAN => tanf(x),
        _ => x,
    }
}
fn bin_math(f: u8, a: f32, b: f32) -> f32 {
    match f {
        B_MIN => {
            if a < b {
                a
            } else {
                b
            }
        }
        B_MAX => {
            if a > b {
                a
            } else {
                b
            }
        }
        B_POW => powf(a, b),
        B_MOD => a - b * floorf(a / b),
        B_STEP => {
            if b < a {
                0.0
            } else {
                1.0
            }
        } // step(edge=a, x=b)
        B_ATAN2 => atan2f(a, b),
        _ => a,
    }
}
fn atan2f(y: f32, x: f32) -> f32 {
    // crude atan2 adequate for effects (angles for radial patterns).
    if x == 0.0 && y == 0.0 {
        return 0.0;
    }
    let ax = x.abs();
    let ay = y.abs();
    let a = if ax >= ay { ay / ax } else { ax / ay };
    let s = a * a;
    let mut r = ((-0.0464964749 * s + 0.15931422) * s - 0.327622764) * s * a + a;
    if ay > ax {
        r = PI * 0.5 - r;
    }
    if x < 0.0 {
        r = PI - r;
    }
    if y < 0.0 {
        r = -r;
    }
    r
}

fn hash1(x: f32) -> f32 {
    // fract(sin(x)*k) style, but with our sinf; deterministic.
    fractf(sinf(x * 12.9898) * 43758.547)
}

fn hsv2rgb(h: f32, s: f32, v: f32) -> (f32, f32, f32) {
    let h6 = fractf(h) * 6.0;
    let c = v * s;
    let x = c * (1.0 - (fractf(h6 * 0.5) * 2.0 - 1.0).abs());
    let m = v - c;
    let (r, g, b) = match h6 as i32 {
        0 => (c, x, 0.0),
        1 => (x, c, 0.0),
        2 => (0.0, c, x),
        3 => (0.0, x, c),
        4 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    (r + m, g + m, b + m)
}

fn palette(id: u8, t: f32) -> (f32, f32, f32) {
    let t = clamp01(t);
    match id {
        // fire: black -> red -> orange -> yellow -> white
        0 => (clamp01(t * 3.0), clamp01(t * 3.0 - 1.0), clamp01(t * 3.0 - 2.0)),
        // ice: black -> blue -> cyan -> white
        1 => (clamp01(t * 3.0 - 2.0), clamp01(t * 3.0 - 1.0), clamp01(t * 2.0)),
        // rainbow
        _ => hsv2rgb(t, 1.0, 1.0),
    }
}
