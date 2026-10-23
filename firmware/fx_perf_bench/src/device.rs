//! The C6 bench driver: runs every group, prints one parseable line per result
//! (`fxpb ...`), keeps the whole log in RAM so `fxpb_dump` can re-emit it for a
//! late-attaching serial reader, then idles. See tools/fx_perf/run_bench.py for
//! the host side (flash over HITL, capture, parse).

use core::fmt::Write as _;
use core::ptr::{addr_of, addr_of_mut};

use ledmapper_fx_jit::{plan_blocks_into, PlanOut};
use ledmapper_fx_vm::{JitBlock, JitFn, Op};

use crate::engine::{self, Loaded, BYTES, OUT_VM};
use crate::fixture::{self, Kind};
use crate::native::{native_frame, NATIVES};
use crate::{EffectDesc, EFFECTS, GROUP_AGENT, GROUP_STUDY, GROUP_USER, GROUP_VALID};

extern "C" {
    fn fxpb_cycles() -> u32;
    fn fxpb_write(p: *const u8, n: usize);
    fn fxpb_yield();
    fn lm_jit_region_ptr() -> *mut u32;
    fn lm_jit_region_words() -> usize;
    fn lm_jit_arm();
    fn lm_jit_sync_icache();
}

fn cyc() -> u32 {
    unsafe { fxpb_cycles() }
}

// --- logging ------------------------------------------------------------------
const LOG_CAP: usize = 64 * 1024;
static mut LOG: [u8; LOG_CAP] = [0; LOG_CAP];
static mut LOG_LEN: usize = 0;

struct Line {
    buf: [u8; 512],
    len: usize,
}
impl core::fmt::Write for Line {
    fn write_str(&mut self, s: &str) -> core::fmt::Result {
        let b = s.as_bytes();
        let n = b.len().min(self.buf.len() - self.len);
        self.buf[self.len..self.len + n].copy_from_slice(&b[..n]);
        self.len += n;
        Ok(())
    }
}

/// Format one line, append it to the RAM log and write it to serial.
pub fn log_line(args: core::fmt::Arguments) {
    let mut l = Line { buf: [0; 512], len: 0 };
    let _ = l.write_str("fxpb ");
    let _ = l.write_fmt(args);
    let _ = l.write_str("\r\n");
    unsafe {
        let log = &mut *addr_of_mut!(LOG);
        let n = l.len.min(LOG_CAP - LOG_LEN);
        log[LOG_LEN..LOG_LEN + n].copy_from_slice(&l.buf[..n]);
        LOG_LEN += n;
        fxpb_write(l.buf.as_ptr(), l.len);
    }
}

/// Re-emit the whole RAM log between BEGIN/END markers.
#[no_mangle]
pub unsafe extern "C" fn fxpb_dump() {
    let b = b"fxpb-dump BEGIN\r\n";
    fxpb_write(b.as_ptr(), b.len());
    let log = &*addr_of!(LOG);
    let mut o = 0;
    while o < LOG_LEN {
        let n = (LOG_LEN - o).min(256);
        fxpb_write(log[o..].as_ptr(), n);
        o += n;
        fxpb_yield();
    }
    let e = b"fxpb-dump END\r\n";
    fxpb_write(e.as_ptr(), e.len());
}

// --- the on-device JIT, installed exactly like ffi.rs fx_build_jit -----------
const MAX_JIT_BLOCKS: usize = 8;
const MAX_JIT_CONSTS: usize = 64;
const JIT_MAX_CODE: usize = 1024;
unsafe extern "C" fn jit_noop(_s: *mut i32, _l: *mut i32, _c: *const i32) {}
static mut JIT_BLOCKS: [JitBlock; MAX_JIT_BLOCKS] = [JitBlock { func: jit_noop, end: 0, net_delta: 0 }; MAX_JIT_BLOCKS];
static mut JIT_CONSTS: [i32; MAX_JIT_CONSTS] = [0; MAX_JIT_CONSTS];
static mut JIT_PLANS: [PlanOut; MAX_JIT_BLOCKS] =
    [PlanOut { start: 0, end: 0, net_delta: 0, code_off: 0, code_len: 0 }; MAX_JIT_BLOCKS];
static mut JIT_TARGETS: [bool; JIT_MAX_CODE + 1] = [false; JIT_MAX_CODE + 1];

/// Why the JIT did (not) engage: the firmware's own limits.
#[derive(Clone, Copy)]
pub struct JitInfo {
    pub blocks: usize,
    pub words: usize,
    pub why: &'static str,
}

unsafe fn build_jit() -> JitInfo {
    let v = engine::vm();
    v.clear_jit();
    let prog = engine::prog();
    let n_consts = prog.consts_raw().len() / 4;
    if n_consts > MAX_JIT_CONSTS {
        return JitInfo { blocks: 0, words: 0, why: "consts>64" };
    }
    let code = prog.code();
    if code.len() + 1 > JIT_MAX_CODE {
        return JitInfo { blocks: 0, words: 0, why: "code>1024B" };
    }
    let craw = prog.consts_raw();
    let consts = &mut *addr_of_mut!(JIT_CONSTS);
    for i in 0..n_consts {
        consts[i] = i32::from_le_bytes([craw[i * 4], craw[i * 4 + 1], craw[i * 4 + 2], craw[i * 4 + 3]]);
    }
    let region_ptr = lm_jit_region_ptr();
    let region = core::slice::from_raw_parts_mut(region_ptr, lm_jit_region_words());
    let targets = &mut (*addr_of_mut!(JIT_TARGETS))[..code.len() + 1];
    for t in targets.iter_mut() {
        *t = false;
    }
    let code_off = code.as_ptr() as usize - addr_of!(BYTES) as usize;
    let n = plan_blocks_into(code, targets, &mut *addr_of_mut!(JIT_PLANS), region);
    if n == 0 {
        return JitInfo { blocks: 0, words: 0, why: "no block" };
    }
    lm_jit_arm();
    lm_jit_sync_icache();
    let blocks = &mut *addr_of_mut!(JIT_BLOCKS);
    let plans = &*addr_of!(JIT_PLANS);
    let fxb = &mut *addr_of_mut!(BYTES);
    let mut installed = 0;
    let mut words = 0;
    for p in plans.iter().take(n) {
        if installed >= MAX_JIT_BLOCKS {
            break;
        }
        let func: JitFn = core::mem::transmute::<*mut u32, JitFn>(region_ptr.add(p.code_off as usize));
        blocks[installed] = JitBlock { func, end: p.end, net_delta: p.net_delta };
        let at = code_off + p.start as usize;
        fxb[at] = Op::JitCall as u8;
        fxb[at + 1] = (installed & 0xff) as u8;
        fxb[at + 2] = ((installed >> 8) & 0xff) as u8;
        installed += 1;
        words = words.max(p.code_off as usize + p.code_len as usize);
    }
    v.set_jit(&blocks[..installed], consts.as_ptr());
    JitInfo { blocks: installed, words, why: "ok" }
}

// --- measurement helpers --------------------------------------------------------
const FRAMES: u32 = 3;

/// Min-over-frames VM cost: (update, shade, bad) of the cheapest frame; leaves
/// OUT_VM holding the LAST frame's output.
unsafe fn vm_min(n: usize, l: &Loaded) -> (u32, u32, u32) {
    let mut best = (u32::MAX, u32::MAX, 0);
    for fi in 0..FRAMES {
        let r = engine::vm_frame(fi, n, l, cyc, false);
        if r.update.wrapping_add(r.shade) < best.0.wrapping_add(best.1) {
            best = (r.update, r.shade, r.bad);
        }
        fxpb_yield();
    }
    best
}

fn checksum(n: usize) -> u32 {
    let o = unsafe { &*addr_of!(OUT_VM) };
    let mut h = 0x811c9dc5u32;
    for c in o.iter().take(n) {
        for b in [c.0, c.1, c.2] {
            h = (h ^ b as u32).wrapping_mul(0x0100_0193);
        }
    }
    h
}

unsafe fn fixture_name(k: Kind) -> &'static str {
    match k {
        Kind::Helix => "helix",
        Kind::Linear => "linear",
        Kind::Sign => "sign",
    }
}

/// VM (+counted ops) and VM+JIT for one effect on the current fixture.
/// Returns the VM checksum of the last frame (for the native compare).
unsafe fn vm_and_jit(d: &EffectDesc, n: usize, kind: Kind, with_jit: bool) -> Option<Loaded> {
    let fx = fixture_name(kind);
    let l = match engine::load(d, n) {
        Ok(l) => l,
        Err(e) => {
            log_line(format_args!("skip {} {fx} n={n} reason={e} {}", d.name, d.err));
            return None;
        }
    };
    let fill = engine::fill_only(n, &l, cyc);
    let (u, s, bad) = vm_min(n, &l);
    let sum_vm = checksum(n);
    // Opcode count (Tier-1 counted path) on a fresh load, frame 0.
    let _ = engine::load(d, n);
    let k = engine::vm_frame(0, n, &l, cyc, true);
    log_line(format_args!(
        "vm {} {fx} n={n} upd={u} shade={s} frame={} fill={fill} bad={bad} ops={} code={} consts={} arena={} cksum={sum_vm:08x}",
        d.name,
        u + s,
        k.instrs,
        l.code_len,
        l.n_consts,
        l.arena
    ));
    if with_jit {
        let _ = engine::load(d, n);
        let j = build_jit();
        let (ju, js, jbad) = vm_min(n, &l);
        let sum_jit = checksum(n);
        log_line(format_args!(
            "jit {} {fx} n={n} upd={ju} shade={js} frame={} bad={jbad} blocks={} words={} why={} match={}",
            d.name,
            ju + js,
            j.blocks,
            j.words,
            j.why,
            if sum_jit == sum_vm { 1 } else { 0 }
        ));
        engine::vm().clear_jit();
    }
    // Leave the VM's last-frame output in OUT_VM for the native compare.
    let _ = engine::load(d, n);
    for fi in 0..FRAMES {
        engine::vm_frame(fi, n, &l, cyc, false);
    }
    Some(l)
}

unsafe fn natives_for(d: &EffectDesc, n: usize, kind: Kind) {
    let fx = fixture_name(kind);
    for nat in NATIVES.iter().filter(|x| x.name == d.name) {
        (nat.reset)();
        let mut best = (u32::MAX, u32::MAX);
        for fi in 0..FRAMES {
            let fr = engine::frame(fi, n);
            let (u, s) = native_frame(nat, &fr, n, cyc);
            if u.wrapping_add(s) < best.0.wrapping_add(best.1) {
                best = (u, s);
            }
        }
        let (mx, sum, off) = engine::compare(n);
        log_line(format_args!(
            "native {} {} {fx} n={n} upd={} shade={} frame={} maxdiff={mx} meandiff_x1000={} off2={off}",
            d.name,
            nat.variant,
            best.0,
            best.1,
            best.0 + best.1,
            sum * 1000 / (3 * n as u64).max(1)
        ));
        fxpb_yield();
    }
}

/// The whole bench. Called once from setup().
#[no_mangle]
pub unsafe extern "C" fn fxpb_run() {
    log_line(format_args!("start effects={} cpu_hz=160000000", EFFECTS.len()));
    crate::micro::soft_float(cyc);
    crate::micro::vm_ops(cyc);

    // Validation: fx_bench programs at their own LED count on fx_bench's map.
    for d in EFFECTS.iter().filter(|d| d.group == GROUP_VALID) {
        let n = if d.leds > 0 { d.leds as usize } else { 128 };
        fixture::build(Kind::Linear, n);
        vm_and_jit(d, n, Kind::Linear, false);
    }
    // Study: VM, JIT and natives on the helix at 500 and 2048 LEDs.
    for &n in &[500usize, 2048] {
        fixture::build(Kind::Helix, n);
        for d in EFFECTS.iter().filter(|d| d.group == GROUP_STUDY) {
            if vm_and_jit(d, n, Kind::Helix, true).is_some() {
                natives_for(d, n, Kind::Helix);
            }
        }
    }
    // The user's library: sign @ 500 and cylinder @ 250, VM + JIT.
    for &(kind, n) in &[(Kind::Sign, 500usize), (Kind::Helix, 250)] {
        fixture::build(kind, n);
        for d in EFFECTS.iter().filter(|d| d.group == GROUP_USER) {
            vm_and_jit(d, n, kind, true);
        }
    }
    // Agent-generated effects: helix @ 500, VM + JIT.
    fixture::build(Kind::Helix, 500);
    for d in EFFECTS.iter().filter(|d| d.group == GROUP_AGENT) {
        vm_and_jit(d, 500, Kind::Helix, true);
    }
    log_line(format_args!("done"));
}

#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    if let Some(loc) = info.location() {
        log_line(format_args!("PANIC at {}:{}", loc.file(), loc.line()));
    } else {
        log_line(format_args!("PANIC"));
    }
    loop {
        unsafe { fxpb_yield() };
    }
}
