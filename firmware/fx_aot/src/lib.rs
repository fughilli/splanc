//! Ahead-of-time (AOT) lowering of verified `.fxb` effect bytecode to RV32IM
//! machine code for the ESP32-C6 (docs/design/fx-native-aot.md), extending the
//! idea of the on-device JIT (`firmware/fx_jit`) to a whole `shade()`/`update()`.
//!
//! The VM (`firmware/fx_vm`) stays the semantic reference: this is a translation
//! of the *same bytes the device already executes*, and the differential tests
//! assert the native output equals the VM's bit for bit. Design highlights,
//! matching the doc:
//!
//! - **Static stack-depth check.** Abstract interpretation over the CFG fixes a
//!   single operand-stack depth at every instruction; lowering refuses (→ VM)
//!   any program whose depth isn't single-valued, goes out of range, or whose
//!   branch/call targets aren't instruction boundaries.
//! - **Fixed slot homes.** Because depth is static, operand slot `i` has a fixed
//!   home: slots 0..7 in callee-saved `s2..s9` (survive helper calls with no
//!   spill), deeper slots in a frame next to the locals.
//! - **Inline vs helper.** Integer/fixed arithmetic, compares, the control flow,
//!   const pushes, local/state loads/stores and the moves lower to inline RV32.
//!   Scalar/lane float arithmetic, maths, comparisons, conversions and colour
//!   use dedicated register-argument helpers. Scale/Mix, vector reductions,
//!   context and remaining complex ops retain the generic window helper.
//!   All reuse `fx_vm`'s maths and are checked bit-for-bit, including NaNs.
//! - **Unsupported → VM.** Anything not in the supported set (buffers, textures,
//!   graph queries, flood, I2C, the JIT op, user functions) makes [`lower`]
//!   return `None`; the caller keeps the VM for that effect.
//!
//! Correctness is established on the host with no hardware: `rv32`-style
//! encodings (the shared ones reused read-only from `fx_jit::rv32`), a small
//! RV32IM [`emu`]lator with a helper-call trap, and a differential test against
//! the real `fx_vm`.
#![cfg_attr(not(test), no_std)]

#[cfg(feature = "alloc")]
extern crate alloc;
#[cfg(feature = "alloc")]
use alloc::vec::Vec;

use ledmapper_fx_vm as fxv;
use ledmapper_fx_vm::Op;

pub mod arena;
mod ctx;
mod direct;
mod helper;
mod verify;

pub use ctx::{HelperFn, NativeCtx, RET_RET, RET_RGB8, RET_RGBFIX};
pub use helper::aot_win_helper;
pub use verify::{verify, VerifyErr, VerifyLimits};

#[cfg(feature = "alloc")]
pub mod emu;

// Register allocation (see module docs / docs/design/fx-native-aot.md).
mod reg {
    pub const ZERO: u32 = 0;
    pub const RA: u32 = 1;
    pub const SP: u32 = 2;
    pub const T0: u32 = 5;
    pub const T1: u32 = 6;
    pub const T2: u32 = 7;
    pub const S0: u32 = 8; // NativeCtx*
    pub const S1: u32 = 9; // frame base (locals[128] then deep operand slots)
    pub const A0: u32 = 10;
    pub const A1: u32 = 11;
    pub const A2: u32 = 12;
    pub const A3: u32 = 13;
    pub const T3: u32 = 28;
    pub const S10: u32 = 26; // remaining instruction budget
    pub const S11: u32 = 27; // state base
    /// Home register for operand slot `i` when `i < 8` (s2..s9).
    pub const fn slot(i: usize) -> u32 {
        18 + i as u32 // s2 == x18
    }
}

/// Frame layout in words (each 4 bytes), based at `s1`.
const LOCALS_WORDS: usize = fxv::MAX_LOCALS; // 128
const DEEP_WORDS: usize = fxv::MAX_STACK; // operand slots 8.. (over-provisioned)
const WIN_WORDS: usize = 16; // helper I/O window (max single-op pop/push < 16)
/// Word offset of deep operand slot `i` (i >= 8) in the frame.
const fn deep_off(i: usize) -> usize {
    LOCALS_WORDS + (i - 8)
}
const WIN_OFF: usize = LOCALS_WORDS + DEEP_WORDS;
/// Total frame size in words a lowered program needs.
pub const FRAME_WORDS: usize = LOCALS_WORDS + DEEP_WORDS + WIN_WORDS;

/// RV32 encoders. The subset shared with the JIT is reused read-only from
/// `fx_jit::rv32`; everything else (branches, `lui`, logical/shift-by-reg,
/// `div`/`rem`, `jalr` with an explicit rd) is encoded here.
#[allow(dead_code)] // a few encoders are kept for completeness / future ops
mod enc {
    pub use ledmapper_fx_jit::rv32::{add, addi, lw, mul, mulh, or, slli, srai, srli, sub, sw};

    fn r(funct7: u32, rs2: u32, rs1: u32, funct3: u32, rd: u32, opcode: u32) -> u32 {
        (funct7 << 25) | (rs2 << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode
    }
    fn i_(imm: i32, rs1: u32, funct3: u32, rd: u32, opcode: u32) -> u32 {
        ((imm as u32 & 0xfff) << 20) | (rs1 << 15) | (funct3 << 12) | (rd << 7) | opcode
    }
    pub fn and(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x00, rs2, rs1, 0x7, rd, 0x33)
    }
    pub fn xor(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x00, rs2, rs1, 0x4, rd, 0x33)
    }
    pub fn div(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x01, rs2, rs1, 0x4, rd, 0x33)
    }
    pub fn rem(rd: u32, rs1: u32, rs2: u32) -> u32 {
        r(0x01, rs2, rs1, 0x6, rd, 0x33)
    }
    pub fn lui(rd: u32, imm20: u32) -> u32 {
        (imm20 << 12) | (rd << 7) | 0x37
    }
    /// `jalr rd, rs1, imm`.
    pub fn jalr(rd: u32, rs1: u32, imm: i32) -> u32 {
        i_(imm, rs1, 0x0, rd, 0x67)
    }
    /// B-type branch (`beq/bne/blt/bge/bltu/bgeu`); `imm` is a byte offset.
    pub fn branch(funct3: u32, rs1: u32, rs2: u32, imm: i32) -> u32 {
        let im = imm as u32;
        let b12 = (im >> 12) & 1;
        let b11 = (im >> 11) & 1;
        let b10_5 = (im >> 5) & 0x3f;
        let b4_1 = (im >> 1) & 0xf;
        (b12 << 31)
            | (b10_5 << 25)
            | (rs2 << 20)
            | (rs1 << 15)
            | (funct3 << 12)
            | (b4_1 << 8)
            | (b11 << 7)
            | 0x63
    }
    /// `jal rd, imm` (byte offset).
    pub fn jal(rd: u32, imm: i32) -> u32 {
        let im = imm as u32;
        let b20 = (im >> 20) & 1;
        let b19_12 = (im >> 12) & 0xff;
        let b11 = (im >> 11) & 1;
        let b10_1 = (im >> 1) & 0x3ff;
        (b20 << 31) | (b10_1 << 21) | (b11 << 20) | (b19_12 << 12) | (rd << 7) | 0x6f
    }
    pub const F3_BEQ: u32 = 0x0;
    pub const F3_BNE: u32 = 0x1;
    pub const F3_BLT: u32 = 0x4;
    pub const F3_BGE: u32 = 0x5;
}

/// How an opcode is handled by the lowering.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
    Inline,
    Helper,
    /// Terminal (writes the result and returns).
    Ret,
    /// Not supported — the whole program falls back to the VM.
    No,
}

/// `(pop, push)` operand-stack effect of the op at `code[pc]`, plus how it is
/// handled. `None` for an unknown opcode byte.
fn effect(code: &[u8], pc: usize) -> Option<(usize, usize, Kind)> {
    let op = Op::from_u8(code[pc])?;
    let b = |k: usize| *code.get(pc + 1 + k).unwrap_or(&0) as usize;
    use Kind::*;
    Some(match op {
        Op::PushConst => (0, 1, Inline),
        Op::LoadLocal => (0, b(1), Inline),
        Op::StoreLocal => (b(1), 0, Inline),
        Op::LoadState => (0, b(1), Inline),
        Op::StoreState => (b(1), 0, Inline),
        Op::LoadUniform => (0, b(1), Helper),
        Op::LoadCtx => (0, ctx_size(code[pc + 1]), Helper),
        Op::LoadCtxFix => (0, 1, Helper),
        Op::Add | Op::Sub | Op::Mul | Op::Div => (2 * b(0), b(0), Helper),
        Op::Neg => (b(0), b(0), Helper),
        Op::Scale => (b(0) + 1, b(0), Helper),
        Op::UnMath => (b(1), b(1), Helper),
        Op::BinMath => (2 * b(1), b(1), Helper),
        Op::Clamp => (3 * b(0), b(0), Helper),
        Op::Mix => (2 * b(0) + 1, b(0), Helper),
        Op::Smoothstep => (3 * b(0), b(0), Helper),
        Op::Dot => (2 * b(0), 1, Helper),
        Op::Cross => (6, 3, Helper),
        Op::Length => (b(0), 1, Helper),
        Op::Normalize => (b(0), b(0), Helper),
        Op::Distance => (2 * b(0), 1, Helper),
        Op::Swizzle => (b(0), b(1), Inline),
        Op::Cmp => (2, 1, Helper),
        Op::Logic => (if code[pc + 1] == 2 { 1 } else { 2 }, 1, Helper),
        Op::BrFalse => (1, 0, Inline),
        Op::Jmp => (0, 0, Inline),
        Op::Hash1 => (1, 1, Helper),
        Op::Hash3 => (3, 1, Helper),
        Op::Hsv2Rgb => (3, 3, Helper),
        Op::Palette => (1, 3, Helper),
        Op::Pop => (b(0), 0, Inline),
        Op::Ret => (b(0), 0, Ret),
        Op::Swap => (b(0) + b(1), b(0) + b(1), Inline),
        Op::AddI | Op::SubI | Op::MulI => (2, 1, Inline),
        Op::DivI | Op::ModI => (2, 1, Helper),
        Op::NegI => (1, 1, Inline),
        Op::CmpI => (2, 1, Helper),
        Op::MulFix => (2, 1, Inline),
        Op::MulFixN => (2, 1, Inline),
        Op::DivFix | Op::DivFixN => (2, 1, Helper),
        Op::I2F | Op::F2I | Op::Fix2F | Op::F2Fix => (1, 1, Helper),
        Op::I2Fix | Op::Fix2I | Op::FixRescale => (1, 1, Inline),
        Op::FixToF | Op::FixFromF => (1, 1, Helper),
        Op::SinFix | Op::CosFix | Op::ExpFix => (1, 1, Helper),
        Op::AbsI => (1, 1, Helper),
        Op::MinI | Op::MaxI => (2, 1, Helper),
        Op::ClampI => (3, 1, Helper),
        Op::SignI => (1, 1, Helper),
        Op::StepI => (2, 1, Helper),
        Op::FloorFix | Op::CeilFix | Op::FractFix => (1, 1, Helper),
        Op::MixFix => (3, 1, Helper),
        Op::SqrtFix => (1, 1, Helper),
        Op::ScaleFix => (b(1) + 1, b(1), Helper),
        Op::DotFix => (2 * b(1), 1, Helper),
        Op::LengthFix => (b(1), 1, Helper),
        Op::DistanceFix => (2 * b(1), 1, Helper),
        Op::NormalizeFix => (b(1), b(1), Helper),
        Op::CrossFix => (6, 3, Helper),
        Op::SmoothstepFix => (3 * b(1), b(1), Helper),
        Op::ClampVFix => (3 * b(0), b(0), Helper),
        Op::MixVFix => (2 * b(1) + 1, b(1), Helper),
        Op::Hsv2RgbFix => (3, 3, Helper),
        Op::PaletteFix => (1, 3, Helper),
        Op::Atan2Fix => (2, 1, Helper),
        Op::LogFix | Op::TanFix => (1, 1, Helper),
        Op::PowFix => (2, 1, Helper),
        Op::HashFix => (1, 1, Helper),
        Op::Hash3Fix => (3, 1, Helper),
        Op::RetRgb8 => (3, 0, Ret),
        Op::RetRgbFix => (3, 0, Ret),
        Op::LoadStateIdx | Op::LoadLocalIdx => (1, b(3), Helper),
        Op::StoreStateIdx | Op::StoreLocalIdx => (b(3) + 1, 0, Helper),
        Op::TeeLocal => (0, 0, Inline),
        Op::IncLocalI => (0, 0, Inline),
        Op::BrCmpI => (2, 0, Inline),
        Op::FillLocal => (0, 0, Inline),
        // Unsupported — fall back to the VM.
        Op::GraphQuery
        | Op::LoadBuf
        | Op::StoreBuf
        | Op::SampleTex
        | Op::PaintTex
        | Op::FloodFrom
        | Op::Call
        | Op::RetFn
        | Op::JitCall
        | Op::I2cWrite
        | Op::I2cRead => (0, 0, No),
    })
}

/// Component count a `LoadCtx`/`LoadCtxFix` id pushes.
fn ctx_size(id: u8) -> usize {
    use fxv::*;
    match id {
        C_LED_POS | C_IMU_ACCEL | C_IMU_GYRO | C_LED_ROOM | C_ROOM_MIN | C_ROOM_MAX => 3,
        C_LED_UV => 2,
        _ => 1,
    }
}

/// A lowered program image.
#[cfg(feature = "alloc")]
pub struct Image {
    /// RV32IM words.
    pub code: Vec<u32>,
    /// Word offset of the `update()` entry (None if the program has none).
    pub update_off: Option<usize>,
    /// Word offset of the `shade()` entry.
    pub shade_off: usize,
}

#[cfg(feature = "alloc")]
impl Image {
    /// The callable entry offsets (`update` if present, then `shade`). These
    /// are the only offsets a caller may jump to and what [`verify`] checks.
    pub fn entries(&self) -> Vec<usize> {
        self.update_off
            .into_iter()
            .chain([self.shade_off])
            .collect()
    }

    /// [`verify`] this image against the in-tree buffer sizes
    /// ([`VerifyLimits::DEFAULT`]).
    pub fn verify(&self) -> Option<VerifyErr> {
        verify(&self.code, &self.entries(), &VerifyLimits::DEFAULT)
    }
}

/// Lower a verified `.fxb` program to a position-independent RV32IM image, or
/// `None` if any opcode is outside the supported set or the static-depth check
/// fails (the caller keeps the VM for that effect).
///
/// The emitted functions have the C ABI
/// `extern "C" fn(ctx: *mut NativeCtx, frame: *mut i32, state: *mut i32)`.
#[cfg(feature = "alloc")]
pub fn lower(prog: &fxv::Program) -> Option<Image> {
    // Drivers stay on the VM (poll()/i2c), and any program whose supported set we
    // don't cover bails inside lower_body.
    if prog.flags & fxv::FLAG_DRIVER != 0 {
        return None;
    }
    let mut code: Vec<u32> = Vec::new();
    let update_off = if prog.update_entry != fxv::NO_ENTRY {
        let off = code.len();
        lower_body(prog, prog.update_entry as usize, &mut code)?;
        Some(off)
    } else {
        None
    };
    if prog.shade_entry == fxv::NO_ENTRY {
        return None;
    }
    let shade_off = code.len();
    lower_body(prog, prog.shade_entry as usize, &mut code)?;
    Some(Image {
        code,
        update_off,
        shade_off,
    })
}

/// Default per-invocation instruction budget mirrored into native code.
pub const DEFAULT_BUDGET: i32 = fxv::DEFAULT_BUDGET as i32;

#[cfg(feature = "alloc")]
mod lowerer;
#[cfg(feature = "alloc")]
use lowerer::lower_body;
