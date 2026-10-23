//! The execution context handed to a lowered image and its helper.
//!
//! The emitted code reaches float/complex ops through a single generic helper
//! whose pointer is the **first** field of [`NativeCtx`] (so `lw t0, 0(s0)`
//! loads it, with `s0` = the context pointer). The helper reproduces the exact
//! `fx_vm` interpreter arm for the op, reading the op's operand bytes from
//! `code` and the live operands from a window the emitted code spilled.

use ledmapper_fx_vm as fxv;

/// The one indirect call the sandbox allows besides `ret`: a helper that runs an
/// opcode's `fx_vm` semantics over a window of operand slots.
/// `(ctx, win, op, code_off)` — `op` is the opcode byte, `code_off` the byte
/// offset of its operands within `ctx.code`.
pub type HelperFn = unsafe extern "C" fn(*mut NativeCtx, *mut i32, u32, u32);

/// `ret_kind` values written by the epilogue (mirrors the VM's return arms).
pub const RET_RET: u32 = 0; // `Ret n`: result is up to 3 f32 slots (clamp01*255)
pub const RET_RGB8: u32 = 1; // `RetRgb8`: 3 int channels 0..255
pub const RET_RGBFIX: u32 = 2; // `RetRgbFix frac`: 3 Q1.frac channels in [0,1]

/// Everything a lowered image and its helper touch. `#[repr(C)]` with the helper
/// pointer first: the emitted code hard-codes offset 0 for it.
#[repr(C)]
pub struct NativeCtx {
    /// The generic opcode helper (offset 0 — load-bearing for the emitted code).
    pub helper: HelperFn,
    /// The `.fxb` code bytes (helpers read operand bytes from here).
    pub code: *const u8,
    pub code_len: usize,
    /// Uniform values (read-only), `state` and `locals` the same arrays the
    /// emitted code bases `s11`/`s1` on.
    pub uniforms: *const f32,
    pub state: *mut f32,
    pub locals: *mut f32,
    /// Per-frame and per-LED context (the `fx_vm` structs, read-only).
    pub frame: *const fxv::Frame,
    pub led: *const fxv::Led,
    /// The VM, for the few helpers that read its graph/flood/arena state. Unused
    /// by the currently-supported opcode set; kept for the device wiring.
    pub vm: *mut fxv::Vm,
    /// Result of the last `Ret*`: up to 3 words + which kind + the RetRgbFix frac.
    pub out: [i32; 3],
    pub ret_kind: u32,
    pub ret_frac: u32,
}

impl NativeCtx {
    /// Finish a `shade()` invocation: turn `out`/`ret_kind` into an RGB triple
    /// exactly as `fx_vm`'s `run_shade_counted` epilogue does.
    pub fn finish_rgb(&self) -> (u8, u8, u8) {
        match self.ret_kind {
            RET_RGB8 => {
                let ch = |v: i32| v.clamp(0, 255) as u8;
                (ch(self.out[0]), ch(self.out[1]), ch(self.out[2]))
            }
            RET_RGBFIX => {
                let frac = self.ret_frac;
                let to8 = |v: i64| ((v * 255) >> frac).clamp(0, 255) as u8;
                (
                    to8(self.out[0] as i64),
                    to8(self.out[1] as i64),
                    to8(self.out[2] as i64),
                )
            }
            _ => {
                let c = |v: i32| (fxv::clamp01(f32::from_bits(v as u32)) * 255.0) as u8;
                (c(self.out[0]), c(self.out[1]), c(self.out[2]))
            }
        }
    }
}
