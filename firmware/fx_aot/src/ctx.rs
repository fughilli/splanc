//! The execution context handed to a lowered image and its helper.
//!
//! Generated code loads trusted helper entry points at fixed offsets from s0.
//! Scalar float helpers pass words in a0..a3 and return in a0. Colour helpers
//! return two words in a0/a1 and put the third in a fixed frame word. The
//! original generic window helper remains for operations not specialized yet.

use ledmapper_fx_vm as fxv;

/// The generic indirect helper runs an
/// opcode's `fx_vm` semantics over a window of operand slots.
/// `(ctx, win, op, code_off)` — `op` is the opcode byte, `code_off` the byte
/// offset of its operands within `ctx.code`.
pub type HelperFn = unsafe extern "C" fn(*mut NativeCtx, *mut i32, u32, u32);

/// `ret_kind` values written by the epilogue (mirrors the VM's return arms).
pub const RET_RET: u32 = 0; // `Ret n`: result is up to 3 f32 slots (clamp01*255)
pub const RET_RGB8: u32 = 1; // `RetRgb8`: 3 int channels 0..255
pub const RET_RGBFIX: u32 = 2; // `RetRgbFix frac`: 3 Q1.frac channels in [0,1]

// --- ABI offsets (bytes) the EMITTED code hard-codes, as constants rather than
// `offset_of`, because the image is lowered on the 64-bit host but runs on the
// 32-bit device: pointer-sized fields would land at different offsets. Every
// field the emitted code addresses is a fixed 4-byte slot in the header below,
// so these offsets hold on both. (The helper reaches the pointer fields through
// normal Rust field access, where their real offsets don't matter.)
pub const OUT_OFF: i32 = 0; // out[0..3] at 0, 4, 8
pub const RET_KIND_OFF: i32 = 12;
pub const RET_FRAC_OFF: i32 = 16;
pub const HELPER_OFF: i32 = 24; // 8-aligned on host AND 4-aligned on device
pub const DIRECT_OFF: i32 = 32;

pub(crate) fn direct_index(off: i32) -> Option<usize> {
    let delta = off.checked_sub(DIRECT_OFF)?;
    if delta >= 0 && delta % crate::direct::STRIDE == 0 {
        let i = (delta / crate::direct::STRIDE) as usize;
        if i < crate::direct::COUNT {
            return Some(i);
        }
    }
    None
}

/// Everything a lowered image and its helper touch. `#[repr(C)]`: the header's
/// four-byte slots (out/ret_kind/ret_frac) sit at fixed offsets and `_pad`
/// aligns `helper` to 24 on both 32- and 64-bit builds, so the emitted code's
/// baked offsets ([`OUT_OFF`]/[`RET_KIND_OFF`]/[`RET_FRAC_OFF`]/[`HELPER_OFF`])
/// are host/device-stable.
#[repr(C)]
pub struct NativeCtx {
    /// Result of the last `Ret*`: up to 3 words + which kind + the RetRgbFix frac.
    pub out: [i32; 3],
    pub ret_kind: u32,
    pub ret_frac: u32,
    _pad: u32,
    /// The generic opcode helper (offset 24 — load-bearing for the emitted code).
    pub helper: HelperFn,
    /// Fixed-stride, trusted per-operation entry points (never writable by an
    /// image). Alignment keeps the table offset identical on RV32 and host.
    pub(crate) direct: [crate::direct::Entry; crate::direct::COUNT],
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
}

impl NativeCtx {
    /// Construct a context (keeps `_pad` private).
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        helper: HelperFn,
        code: *const u8,
        code_len: usize,
        uniforms: *const f32,
        state: *mut f32,
        locals: *mut f32,
        frame: *const fxv::Frame,
        led: *const fxv::Led,
        vm: *mut fxv::Vm,
    ) -> Self {
        NativeCtx {
            out: [0; 3],
            ret_kind: 0,
            ret_frac: 0,
            _pad: 0,
            helper,
            direct: crate::direct::TABLE,
            code,
            code_len,
            uniforms,
            state,
            locals,
            frame,
            led,
            vm,
        }
    }
}

// Compile-time guarantee that the baked offsets match the actual struct layout
// on whatever target this crate is built for.
const _: () = {
    assert!(core::mem::offset_of!(NativeCtx, out) == OUT_OFF as usize);
    assert!(core::mem::offset_of!(NativeCtx, ret_kind) == RET_KIND_OFF as usize);
    assert!(core::mem::offset_of!(NativeCtx, ret_frac) == RET_FRAC_OFF as usize);
    assert!(core::mem::offset_of!(NativeCtx, helper) == HELPER_OFF as usize);
    assert!(core::mem::offset_of!(NativeCtx, direct) == DIRECT_OFF as usize);
};

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
