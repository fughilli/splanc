//! Dedicated helpers for the RV32 integer calling convention. Scalar inputs
//! are raw words in a0..a3 and a scalar result returns in a0. Colour returns
//! red/green in a0/a1 (u64) and writes blue to a fixed frame window word.
//! No runtime opcode dispatch or operand-window input spills occur here.
use ledmapper_fx_vm as fxv;

/// Eight-byte entries keep every emitted offset identical on host and RV32.
/// Only the low pointer word is loaded on RV32; addresses are never baked into
/// generated code. The table is installed once per context, outside the bench
/// timer, and remains read-only during execution.
#[repr(C, align(8))]
#[derive(Clone, Copy)]
pub(crate) struct Entry {
    address: *const (),
}

#[derive(Clone, Copy, Debug)]
#[allow(dead_code)] // Most IDs are consumed only by the alloc-enabled lowerer.
#[repr(usize)]
pub(crate) enum Id {
    Add,
    Sub,
    Mul,
    Div,
    Neg,
    Sin,
    Cos,
    Abs,
    Floor,
    Ceil,
    Fract,
    Sqrt,
    Exp,
    Log,
    Sign,
    Tan,
    Min,
    Max,
    Pow,
    Mod,
    Step,
    Atan2,
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
    And,
    Or,
    Not,
    Clamp,
    Smoothstep,
    Hash1,
    Hash3,
    I2F,
    Fix2F,
    FixToF,
    F2I,
    F2Fix,
    FixFromF,
    Hsv2Rgb,
    Palette,
    Count,
}
pub(crate) const COUNT: usize = Id::Count as usize;
pub(crate) const STRIDE: i32 = 8;
const _: () = assert!(core::mem::size_of::<Entry>() == STRIDE as usize);

#[allow(unused_variables)]
extern "C" fn add(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    a + b
}

#[allow(unused_variables)]
extern "C" fn sub(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    a - b
}

#[allow(unused_variables)]
extern "C" fn mul(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    a * b
}

#[allow(unused_variables)]
extern "C" fn div(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if b == 0.0 {
        0.0f32
    } else {
        a / b
    }
}

#[allow(unused_variables)]
extern "C" fn neg(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    -a
}

#[allow(unused_variables)]
extern "C" fn sin(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::sinf(a)
}

#[allow(unused_variables)]
extern "C" fn cos(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::cosf(a)
}

#[allow(unused_variables)]
extern "C" fn abs(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    a.abs()
}

#[allow(unused_variables)]
extern "C" fn floor(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::floorf(a)
}

#[allow(unused_variables)]
extern "C" fn ceil(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    -fxv::floorf(-a)
}

#[allow(unused_variables)]
extern "C" fn fract(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::fractf(a)
}

#[allow(unused_variables)]
extern "C" fn sqrt(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::sqrtf(a)
}

#[allow(unused_variables)]
extern "C" fn exp(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::expf(a)
}

#[allow(unused_variables)]
extern "C" fn log(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::logf(a)
}

#[allow(unused_variables)]
extern "C" fn sign(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a > 0.0 {
        1.0f32
    } else if a < 0.0 {
        -1.0f32
    } else {
        0.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn tan(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::tanf(a)
}

#[allow(unused_variables)]
extern "C" fn min(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a < b {
        a
    } else {
        b
    }
}

#[allow(unused_variables)]
extern "C" fn max(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a > b {
        a
    } else {
        b
    }
}

#[allow(unused_variables)]
extern "C" fn pow(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::powf(a, b)
}

#[allow(unused_variables)]
extern "C" fn modulo(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    a - b * fxv::floorf(a / b)
}

#[allow(unused_variables)]
extern "C" fn step(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if b < a {
        0.0f32
    } else {
        1.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn atan2(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::atan2f(a, b)
}

#[allow(unused_variables)]
extern "C" fn lt(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a < b {
        1.0f32
    } else {
        0.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn le(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a <= b {
        1.0f32
    } else {
        0.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn gt(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a > b {
        1.0f32
    } else {
        0.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn ge(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a >= b {
        1.0f32
    } else {
        0.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn eq(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a == b {
        1.0f32
    } else {
        0.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn ne(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a != b {
        1.0f32
    } else {
        0.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn and(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a != 0.0 && b != 0.0 {
        1.0f32
    } else {
        0.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn or(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a != 0.0 || b != 0.0 {
        1.0f32
    } else {
        0.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn not(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a != 0.0 {
        0.0f32
    } else {
        1.0f32
    }
}

#[allow(unused_variables)]
extern "C" fn clamp(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    if a < b {
        b
    } else if a > c {
        c
    } else {
        a
    }
}

#[allow(unused_variables)]
extern "C" fn smoothstep(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    {
        let t = fxv::clamp01(if b == a { 0.0f32 } else { (c - a) / (b - a) });
        t * t * (3.0 - 2.0 * t)
    }
}

#[allow(unused_variables)]
extern "C" fn hash1(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::hash1(a)
}

#[allow(unused_variables)]
extern "C" fn hash3(a: f32, b: f32, c: f32, _d: f32) -> f32 {
    fxv::hash3(a, b, c)
}

#[allow(unused_variables)]
extern "C" fn i2f(aa: u32, bb: u32, cc: u32, _dd: u32) -> u32 {
    let (a, b, c) = (f32::from_bits(aa), f32::from_bits(bb), f32::from_bits(cc));
    ((aa as i32) as f32).to_bits()
}

#[allow(unused_variables)]
extern "C" fn fix2f(aa: u32, bb: u32, cc: u32, _dd: u32) -> u32 {
    let (a, b, c) = (f32::from_bits(aa), f32::from_bits(bb), f32::from_bits(cc));
    ((aa as i32) as f32 / fxv::FIX_ONE as f32).to_bits()
}

#[allow(unused_variables)]
extern "C" fn fixtof(aa: u32, bb: u32, cc: u32, _dd: u32) -> u32 {
    let (a, b, c) = (f32::from_bits(aa), f32::from_bits(bb), f32::from_bits(cc));
    ((aa as i32) as f32 / (1u32 << bb) as f32).to_bits()
}

#[allow(unused_variables)]
extern "C" fn f2i(aa: u32, bb: u32, cc: u32, _dd: u32) -> u32 {
    let (a, b, c) = (f32::from_bits(aa), f32::from_bits(bb), f32::from_bits(cc));
    (a as i32) as u32
}

#[allow(unused_variables)]
extern "C" fn f2fix(aa: u32, bb: u32, cc: u32, _dd: u32) -> u32 {
    let (a, b, c) = (f32::from_bits(aa), f32::from_bits(bb), f32::from_bits(cc));
    ((a * fxv::FIX_ONE as f32) as i32) as u32
}

#[allow(unused_variables)]
extern "C" fn fixfromf(aa: u32, bb: u32, cc: u32, _dd: u32) -> u32 {
    let (a, b, c) = (f32::from_bits(aa), f32::from_bits(bb), f32::from_bits(cc));
    ((a * (1u32 << bb) as f32) as i32) as u32
}

unsafe extern "C" fn hsv2rgb(h: u32, s: u32, v: u32, blue: *mut u32) -> u64 {
    let (r, g, b) = fxv::hsv2rgb(f32::from_bits(h), f32::from_bits(s), f32::from_bits(v));
    *blue = b.to_bits();
    u64::from(r.to_bits()) | (u64::from(g.to_bits()) << 32)
}
unsafe extern "C" fn palette(t: u32, id: u32, _unused: u32, blue: *mut u32) -> u64 {
    let (r, g, b) = fxv::palette(id as u8, f32::from_bits(t));
    *blue = b.to_bits();
    u64::from(r.to_bits()) | (u64::from(g.to_bits()) << 32)
}

// The RV32 soft-float ABI passes f32 bits in integer registers. Point plain
// operations straight at the same compiler-builtins symbols used by the VM.
// Div/compare/float-to-int need wrappers: VM zero guards, float booleans and
// Rust's saturating casts differ from raw compiler-builtins semantics.
#[cfg(target_arch = "riscv32")]
extern "C" {
    fn __addsf3();
    fn __subsf3();
    fn __mulsf3();
    fn __floatsisf();
}

pub(crate) const TABLE: [Entry; COUNT] = {
    #[allow(unused_mut)]
    let mut table = [
        Entry {
            address: add as *const (),
        },
        Entry {
            address: sub as *const (),
        },
        Entry {
            address: mul as *const (),
        },
        Entry {
            address: div as *const (),
        },
        Entry {
            address: neg as *const (),
        },
        Entry {
            address: sin as *const (),
        },
        Entry {
            address: cos as *const (),
        },
        Entry {
            address: abs as *const (),
        },
        Entry {
            address: floor as *const (),
        },
        Entry {
            address: ceil as *const (),
        },
        Entry {
            address: fract as *const (),
        },
        Entry {
            address: sqrt as *const (),
        },
        Entry {
            address: exp as *const (),
        },
        Entry {
            address: log as *const (),
        },
        Entry {
            address: sign as *const (),
        },
        Entry {
            address: tan as *const (),
        },
        Entry {
            address: min as *const (),
        },
        Entry {
            address: max as *const (),
        },
        Entry {
            address: pow as *const (),
        },
        Entry {
            address: modulo as *const (),
        },
        Entry {
            address: step as *const (),
        },
        Entry {
            address: atan2 as *const (),
        },
        Entry {
            address: lt as *const (),
        },
        Entry {
            address: le as *const (),
        },
        Entry {
            address: gt as *const (),
        },
        Entry {
            address: ge as *const (),
        },
        Entry {
            address: eq as *const (),
        },
        Entry {
            address: ne as *const (),
        },
        Entry {
            address: and as *const (),
        },
        Entry {
            address: or as *const (),
        },
        Entry {
            address: not as *const (),
        },
        Entry {
            address: clamp as *const (),
        },
        Entry {
            address: smoothstep as *const (),
        },
        Entry {
            address: hash1 as *const (),
        },
        Entry {
            address: hash3 as *const (),
        },
        Entry {
            address: i2f as *const (),
        },
        Entry {
            address: fix2f as *const (),
        },
        Entry {
            address: fixtof as *const (),
        },
        Entry {
            address: f2i as *const (),
        },
        Entry {
            address: f2fix as *const (),
        },
        Entry {
            address: fixfromf as *const (),
        },
        Entry {
            address: hsv2rgb as *const (),
        },
        Entry {
            address: palette as *const (),
        },
    ];
    #[cfg(target_arch = "riscv32")]
    {
        table[Id::Add as usize].address = __addsf3 as *const ();
        table[Id::Sub as usize].address = __subsf3 as *const ();
        table[Id::Mul as usize].address = __mulsf3 as *const ();
        table[Id::I2F as usize].address = __floatsisf as *const ();
    }
    table
};

#[cfg(feature = "alloc")]
pub(crate) unsafe fn invoke(id: usize, args: [u32; 4], blue: *mut u32) -> u64 {
    let address = TABLE[id].address;
    if id == Id::Hsv2Rgb as usize || id == Id::Palette as usize {
        let f: unsafe extern "C" fn(u32, u32, u32, *mut u32) -> u64 = core::mem::transmute(address);
        f(args[0], args[1], args[2], blue)
    } else if id < Id::I2F as usize {
        let f: extern "C" fn(f32, f32, f32, f32) -> f32 = core::mem::transmute(address);
        u64::from(
            f(
                f32::from_bits(args[0]),
                f32::from_bits(args[1]),
                f32::from_bits(args[2]),
                f32::from_bits(args[3]),
            )
            .to_bits(),
        )
    } else {
        let f: extern "C" fn(u32, u32, u32, u32) -> u32 = core::mem::transmute(address);
        u64::from(f(args[0], args[1], args[2], args[3]))
    }
}
