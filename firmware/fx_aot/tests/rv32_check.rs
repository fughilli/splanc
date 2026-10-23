//! Executes both the real RV32 soft-float VM and generated RV32 instructions
//! under QEMU user-mode. Linux syscalls are only test plumbing; no hardware,
//! C6 timing, arena-placement or device-peripheral behavior is modeled.
#![no_std]
#![no_main]
use core::{
    arch::{asm, global_asm},
    fmt::{self, Write},
};
use ledmapper_fx_aot_nostd as aot;
use ledmapper_fx_vm as fxv;
struct Case {
    op: &'static [u8],
    bytes: &'static [u8],
    image: &'static [u32],
    entries: &'static [usize],
    shade: usize,
    inputs: usize,
    outputs: usize,
}
include!(env!("FX_AOT_RV32_CASES"));
global_asm!(".global _start", "_start:", "call main");
unsafe fn syscall(n: usize, a: usize, b: usize, c: usize, d: usize, e: usize, f: usize) -> usize {
    let out;
    asm!("ecall",in("a7")n,inlateout("a0")a=>out,in("a1")b,in("a2")c,in("a3")d,in("a4")e,in("a5")f);
    out
}
fn exit(code: usize) -> ! {
    unsafe {
        syscall(93, code, 0, 0, 0, 0, 0);
    }
    loop {}
}
struct Output;
impl Write for Output {
    fn write_str(&mut self, s: &str) -> fmt::Result {
        unsafe {
            syscall(64, 1, s.as_ptr() as usize, s.len(), 0, 0, 0);
        }
        Ok(())
    }
}
#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    let _ = writeln!(Output, "{info}");
    exit(2)
}
#[no_mangle]
extern "C" fn main() -> ! {
    let fr = fxv::Frame::default();
    let led = fxv::Led::default();
    let mut random = 0xa07beefu32;
    let mut comparisons = 0;
    let code = unsafe { syscall(222, 0, 65536, 7, 0x22, usize::MAX, 0) } as *mut u32;
    assert!((code as usize) < 0xfffff000);
    for case in CASES {
        let prog = fxv::Program::parse(case.bytes).unwrap();
        assert_eq!(
            aot::verify(case.image, case.entries, &aot::VerifyLimits::DEFAULT),
            None
        );
        unsafe {
            core::ptr::copy_nonoverlapping(case.image.as_ptr(), code, case.image.len());
            asm!("fence.i");
        }
        let entry: unsafe extern "C" fn(*mut aot::NativeCtx, *mut i32, *mut i32) =
            unsafe { core::mem::transmute(code.add(case.shade)) };
        let mut vm = fxv::Vm::new();
        let mut nvm = fxv::Vm::new();
        let mut u = [0.0; fxv::MAX_UNIFORM_SLOTS];
        let mut frame = [0i32; aot::FRAME_WORDS];
        let mut state = [0i32; fxv::MAX_STATE];
        let mut ctx = aot::NativeCtx::new(
            aot::aot_win_helper,
            prog.code().as_ptr(),
            prog.code().len(),
            u.as_ptr(),
            state.as_mut_ptr().cast(),
            frame.as_mut_ptr().cast(),
            &fr,
            &led,
            &mut nvm,
        );
        for sample in 0..EDGES.len() * EDGES.len() + 256 {
            for (i, value) in u[..case.inputs].iter_mut().enumerate() {
                random ^= random << 13;
                random ^= random >> 17;
                random ^= random << 5;
                let bits = if sample < EDGES.len() * EDGES.len() {
                    EDGES[if i % 2 == 0 {
                        sample % EDGES.len()
                    } else {
                        sample / EDGES.len()
                    }]
                } else {
                    random
                };
                *value = f32::from_bits(bits);
            }
            vm.set_uniform(0, &u);
            vm.run_shade(&prog, &fr, &led);
            unsafe {
                entry(&mut ctx, frame.as_mut_ptr(), state.as_mut_ptr());
            }
            for i in 0..case.outputs {
                if state[i] as u32 != vm.state[i].to_bits() {
                    let _ = writeln!(
                        Output,
                        "FAIL op={:?} inputs={} sample={} lane={} native={:08x} vm={:08x}",
                        case.op,
                        case.inputs,
                        sample,
                        i,
                        state[i],
                        vm.state[i].to_bits()
                    );
                    exit(1)
                }
            }
            comparisons += 1;
        }
    }
    let _ = writeln!(Output, "RV32 raw comparisons: {comparisons} passed");
    exit(0)
}
#[no_mangle]
unsafe extern "C" fn memset(p: *mut u8, c: i32, n: usize) -> *mut u8 {
    for i in 0..n {
        p.add(i).write_volatile(c as u8);
    }
    p
}
#[no_mangle]
unsafe extern "C" fn memcpy(p: *mut u8, q: *const u8, n: usize) -> *mut u8 {
    for i in 0..n {
        p.add(i).write_volatile(q.add(i).read_volatile());
    }
    p
}
#[no_mangle]
unsafe extern "C" fn memmove(p: *mut u8, q: *const u8, n: usize) -> *mut u8 {
    if (p as usize) < q as usize {
        memcpy(p, q, n)
    } else {
        for i in (0..n).rev() {
            p.add(i).write_volatile(q.add(i).read_volatile());
        }
        p
    }
}
