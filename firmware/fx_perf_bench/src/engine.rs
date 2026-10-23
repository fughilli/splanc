//! The measurement engine shared by the C6 bench and the host test: load an
//! embedded `.fxb` into a RAM copy (the JIT patches it, like ffi.rs's FX_BYTES),
//! run update()+shade() over the fixture through the real fx_vm exactly the
//! way the firmware's render loop does, run a native twin over the same LEDs,
//! and compare.

use core::ptr::{addr_of, addr_of_mut};
use core::sync::atomic::AtomicBool;

use ledmapper_fx_vm::{Budget, Frame, Led, Outcome, Program, Vm, DEFAULT_BUDGET};

use crate::fixture::{q16, FIX, LEDS, MAX_LEDS};
use crate::EffectDesc;

pub type Rgb = (u8, u8, u8);

pub const MAX_FXB: usize = 16384;
pub const ARENA_BYTES: usize = 49152;

pub static mut BYTES: [u8; MAX_FXB] = [0; MAX_FXB];
pub static mut BYTES_LEN: usize = 0;
pub static mut ARENA: [u8; ARENA_BYTES] = [0; ARENA_BYTES];
pub static mut OUT_VM: [Rgb; MAX_LEDS] = [(0, 0, 0); MAX_LEDS];
pub static mut OUT_NAT: [Rgb; MAX_LEDS] = [(0, 0, 0); MAX_LEDS];
static mut VM: Option<Vm> = None;
static mut SCRATCH: Option<Led> = None;
/// Never raised: present so the VM polls a deadline flag like the firmware's.
pub static DEADLINE: AtomicBool = AtomicBool::new(false);

/// Flags of the loaded program (what ffi.rs keys the per-LED framing on).
#[derive(Clone, Copy, Default)]
pub struct Loaded {
    pub uses_ctxfix: bool,
    pub uses_uv: bool,
    pub code_len: usize,
    pub n_consts: usize,
    pub arena: usize,
}

pub fn budget() -> Budget {
    Budget {
        instructions: DEFAULT_BUDGET,
        deadline: Some(&DEADLINE as *const AtomicBool),
    }
}

/// # Safety
/// Single-threaded bench; the returned borrow aliases a static.
pub unsafe fn vm() -> &'static mut Vm {
    (*addr_of_mut!(VM)).get_or_insert_with(Vm::default)
}

/// # Safety
/// Valid only while BYTES holds the loaded program.
pub unsafe fn prog() -> Program<'static> {
    let b: &'static [u8] = &(*addr_of!(BYTES))[..BYTES_LEN];
    Program::parse(b).unwrap()
}

/// Load `d` for `n` LEDs of the current fixture: fresh VM, uniform defaults,
/// topology graph, zeroed arena.
///
/// # Safety
/// Single-threaded bench.
pub unsafe fn load(d: &EffectDesc, n: usize) -> Result<Loaded, &'static str> {
    if d.fxb.is_empty() {
        return Err("compile error");
    }
    if d.fxb.len() > MAX_FXB {
        return Err("fxb too large");
    }
    let bytes = &mut *addr_of_mut!(BYTES);
    bytes[..d.fxb.len()].copy_from_slice(d.fxb);
    BYTES_LEN = d.fxb.len();
    let p = Program::parse(&bytes[..d.fxb.len()]).map_err(|_| "parse")?;
    let arena = p.arena_bytes(n);
    if arena > ARENA_BYTES {
        return Err("arena too large");
    }
    let l = Loaded {
        uses_ctxfix: p.uses_ctxfix(),
        uses_uv: p.uses_uv(),
        code_len: p.code().len(),
        n_consts: p.consts_raw().len() / 4,
        arena,
    };
    let v = (*addr_of_mut!(VM)).insert(Vm::default());
    for (slot, vals) in d.uniforms {
        v.set_uniform(*slot as usize, vals);
    }
    let f = &*addr_of!(FIX);
    v.set_graph(&f.seg_len[..f.n_seg], &f.seg_a[..f.n_seg], &f.seg_b[..f.n_seg]);
    let a = &mut *addr_of_mut!(ARENA);
    for x in a.iter_mut() {
        *x = 0;
    }
    v.set_arena(&mut a[..arena]);
    Ok(l)
}

/// The frame context for frame index `fi` (30 fps, starting at t = 10 s).
pub fn frame(fi: u32, n: usize) -> Frame {
    let time = 10.0 + fi as f32 * (1.0 / 30.0);
    let dt = 1.0 / 30.0;
    Frame {
        time,
        dt,
        frame: fi,
        led_count: n as u32,
        time_fix: q16(time),
        dt_fix: q16(dt),
        ..Default::default()
    }
}

/// Fill the reused per-LED scratch exactly like ffi.rs `fx_shade_one`: pos,
/// idx, topology, the per-LED soft-float uv projection (only if the program
/// reads led.uv) and the Q16 mirrors (only if it reads fixed context).
#[inline(always)]
pub unsafe fn fill_led(led: &mut Led, i: usize, l: &Loaded) {
    let t = &(*addr_of!(LEDS))[i];
    let f = &*addr_of!(FIX);
    let [x, y, z] = t.pos;
    led.pos = [x, y, z];
    led.idx = i as u32;
    if t.seg < 0 {
        led.seg = -1;
        led.s = 0.0;
        led.branch = false;
        led.dist = 0.0;
    } else {
        led.seg = t.seg;
        led.s = t.s;
        led.branch = false;
        led.dist = t.dist;
    }
    led.uv = if l.uses_uv {
        [
            ((x - f.uv_min[0]) * f.uv_inv[0]).clamp(0.0, 1.0),
            ((y - f.uv_min[1]) * f.uv_inv[1]).clamp(0.0, 1.0),
        ]
    } else {
        [0.0, 0.0]
    };
    if l.uses_ctxfix {
        led.pos_fix = [q16(x), q16(y), q16(z)];
        led.uv_fix = [q16(led.uv[0]), q16(led.uv[1])];
        led.s_fix = q16(led.s);
        led.dist_fix = q16(led.dist);
    }
}

/// Cycle counts of one VM frame.
#[derive(Clone, Copy, Default)]
pub struct VmFrame {
    pub update: u32,
    pub shade: u32,
    pub bad: u32,
    pub instrs: u64,
}

/// One frame through the VM: update(), then shade() per LED into OUT_VM.
/// `counted` uses the Tier-1 counted path (opcodes retired) instead of the
/// plain bounded one (the firmware's PERF_FULL vs BASIC split).
///
/// # Safety
/// Single-threaded bench, after `load`.
pub unsafe fn vm_frame(fi: u32, n: usize, l: &Loaded, cyc: fn() -> u32, counted: bool) -> VmFrame {
    let p = prog();
    let v = vm();
    let fr = frame(fi, n);
    let led = (*addr_of_mut!(SCRATCH)).get_or_insert_with(Led::default);
    let out = &mut *addr_of_mut!(OUT_VM);
    let b = budget();
    let mut r = VmFrame::default();
    let t0 = cyc();
    v.run_update_bounded(&p, &fr, &b);
    let t1 = cyc();
    if counted {
        for i in 0..n {
            fill_led(led, i, l);
            let (c, oc, k) = v.run_shade_counted(&p, &fr, led, &b);
            r.instrs += k.instrs as u64;
            if oc != Outcome::Ok {
                r.bad += 1;
            }
            out[i] = c;
        }
    } else {
        for i in 0..n {
            fill_led(led, i, l);
            let (c, oc) = v.run_shade_bounded(&p, &fr, led, &b);
            if oc != Outcome::Ok {
                r.bad += 1;
            }
            out[i] = c;
        }
    }
    let t2 = cyc();
    r.update = t1.wrapping_sub(t0);
    r.shade = t2.wrapping_sub(t1);
    r
}

/// Cycles the per-LED framing alone costs (fill_led over every LED, no VM).
///
/// # Safety
/// Single-threaded bench, after `load`.
pub unsafe fn fill_only(n: usize, l: &Loaded, cyc: fn() -> u32) -> u32 {
    let led = (*addr_of_mut!(SCRATCH)).get_or_insert_with(Led::default);
    let t0 = cyc();
    for i in 0..n {
        fill_led(led, i, l);
        core::hint::black_box(&*led);
    }
    cyc().wrapping_sub(t0)
}

/// Per-channel error between OUT_VM and OUT_NAT over the first `n` LEDs:
/// (max abs diff, sum abs diff, LEDs with any channel off by > 2).
///
/// # Safety
/// Single-threaded bench.
pub unsafe fn compare(n: usize) -> (u32, u64, u32) {
    let a = &*addr_of!(OUT_VM);
    let b = &*addr_of!(OUT_NAT);
    let mut mx = 0u32;
    let mut sum = 0u64;
    let mut off = 0u32;
    for i in 0..n {
        let d = [
            (a[i].0 as i32 - b[i].0 as i32).unsigned_abs(),
            (a[i].1 as i32 - b[i].1 as i32).unsigned_abs(),
            (a[i].2 as i32 - b[i].2 as i32).unsigned_abs(),
        ];
        let m = d[0].max(d[1]).max(d[2]);
        mx = mx.max(m);
        sum += (d[0] + d[1] + d[2]) as u64;
        if m > 2 {
            off += 1;
        }
    }
    (mx, sum, off)
}
