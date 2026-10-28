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
use crate::{EffectDesc, EFFECTS, GROUP_AGENT, GROUP_STUDY, GROUP_USER, GROUP_VALID, SIG_CASES, SIG_OTHER_FXB};

use ledmapper_fx_aot_nostd as aot;
use ledmapper_fx_vm::Led;
use splanc_fx_sig as sig;

extern "C" {
    fn fxpb_cycles() -> u32;
    fn fxpb_write(p: *const u8, n: usize);
    fn fxpb_yield();
    fn lm_jit_region_ptr() -> *mut u32;
    fn lm_jit_region_words() -> usize;
    fn lm_jit_arm();
    fn lm_jit_sync_icache();
    fn lm_aot_region_ptr() -> *mut u32;
    fn lm_aot_region_words() -> usize;
    fn lm_aot_arm();
    fn lm_aot_sync_icache();
    // Native-image signatures (bench_main.cpp): ms clock, the C6's hardware
    // SHA-256 (mbedtls), NVS for keys / policy / the backoff, the MAC.
    fn fxpb_millis() -> u32;
    fn fxpb_sha_begin();
    fn fxpb_sha_update(p: *const u8, n: usize);
    fn fxpb_sha_finish(out: *mut u8);
    fn fxpb_nvs_get_u32(key: *const u8, out: *mut u32) -> i32;
    fn fxpb_nvs_set_u32(key: *const u8, v: u32) -> i32;
    fn fxpb_nvs_get_blob(key: *const u8, buf: *mut u8, cap: usize) -> i32;
    fn fxpb_device_id(out: *mut u8);
}

// Native-effect (AOT) execution scratch (docs/design/fx-native-aot.md). The
// emitted image bases `s1` on this frame (locals[128] + deep operand slots +
// window) and `s11` on this state array.
static mut AOT_FRAME: [i32; aot::FRAME_WORDS] = [0; aot::FRAME_WORDS];
static mut AOT_STATE: [i32; ledmapper_fx_vm::MAX_STATE] = [0; ledmapper_fx_vm::MAX_STATE];

type AotFn = unsafe extern "C" fn(*mut aot::NativeCtx, *mut i32, *mut i32);

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
unsafe extern "C" fn jit_noop(_s: *mut i32, _l: *mut i32, _c: *const i32, _st: *mut i32) {}
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

/// Build a NativeCtx for the AOT image over the given program/frame/led.
unsafe fn aot_ctx(
    op_code: &[u8],
    uniforms: *const f32,
    fr: *const ledmapper_fx_vm::Frame,
    led: *const Led,
) -> aot::NativeCtx {
    aot::NativeCtx::new(
        aot::aot_win_helper,
        op_code.as_ptr(),
        op_code.len(),
        uniforms,
        (*addr_of_mut!(AOT_STATE)).as_mut_ptr() as *mut f32,
        (*addr_of_mut!(AOT_FRAME)).as_mut_ptr() as *mut f32,
        fr,
        led,
        engine::vm() as *mut _,
    )
}

/// Run the host-lowered native image for a study effect, measure cycles/frame,
/// and cross-check every LED against the VM's last frame (left in OUT_VM by
/// `vm_and_jit`). Writes a `fxpb aot ...` line.
unsafe fn aot_run(d: &EffectDesc, n: usize, kind: Kind) {
    aot_run_blob(d, d.aot_fxn, n, kind)
}

/// As [`aot_run`] for an explicit `.fxn` (the signature cases pass tampered
/// ones). The blob is authenticated against `d.fxb` first; any reject leaves
/// the effect on the VM (whose frame `vm_and_jit` already rendered) and logs
/// the reason with the running firmware version + ABI, as a client would see.
unsafe fn aot_run_blob(d: &EffectDesc, blob: &[u8], n: usize, kind: Kind) {
    let fx = fixture_name(kind);
    if !d.aot_ok {
        log_line(format_args!("aot {} {fx} n={n} ok=0 reason=vm_fallback", d.name));
        return;
    }
    let fxn = match authenticate(blob, d.fxb) {
        Ok(f) => f,
        Err(e) => {
            log_line(format_args!(
                "aot {} {fx} n={n} ok=0 reason=sig:{} fw={FW_VERSION} abi={} vm=1",
                d.name,
                e.as_str(),
                aot::NATIVE_ABI
            ));
            return;
        }
    };
    let words = fxn.header.code_words as usize;
    let region = core::slice::from_raw_parts_mut(lm_aot_region_ptr(), lm_aot_region_words());
    if words > region.len() {
        log_line(format_args!("aot {} {fx} n={n} ok=0 reason=image_too_large", d.name));
        return;
    }
    for (i, w) in region[..words].iter_mut().enumerate() {
        *w = fxn.word(i);
    }
    lm_aot_arm();
    lm_aot_sync_icache();

    // Fresh load: sets the VM's uniforms/arena/graph (we read uniforms) and lets
    // fill_led know uses_uv/uses_ctxfix. Zero the native state once; update()
    // evolves it across frames, matching the VM.
    let Ok(l) = engine::load(d, n) else {
        log_line(format_args!("aot {} {fx} n={n} ok=0 reason=load", d.name));
        return;
    };
    for x in (*addr_of_mut!(AOT_STATE)).iter_mut() {
        *x = 0;
    }
    let uni = engine::vm().uniforms.as_ptr();
    let base = lm_aot_region_ptr();
    let entry = |o: u16| -> Option<AotFn> {
        (o != sig::NO_ENTRY).then(|| core::mem::transmute::<*mut u32, AotFn>(base.add(o as usize)))
    };
    let f_upd = entry(fxn.header.update_off);
    let f_prep = entry(fxn.header.prep_off);
    let f_shade: AotFn = core::mem::transmute(base.add(fxn.header.shade_off as usize));
    let out = &mut *addr_of_mut!(crate::engine::OUT_NAT);
    let mut led = Led::default();
    let fm = (*addr_of_mut!(AOT_FRAME)).as_mut_ptr();
    let sm = (*addr_of_mut!(AOT_STATE)).as_mut_ptr();
    let mut best = (u32::MAX, u32::MAX);
    for fi in 0..FRAMES {
        let fr = engine::frame(fi, n);
        let mut ctx = aot_ctx(fxn.op_code, uni, &fr, &led);
        let t0 = cyc();
        if let Some(f) = f_upd {
            f(&mut ctx, fm, sm);
        }
        // Per-frame prepare (hoisted shade() work), once per frame.
        if let Some(f) = f_prep {
            f(&mut ctx, fm, sm);
        }
        let t1 = cyc();
        for i in 0..n {
            engine::fill_led(&mut led, i, &l);
            ctx.led = &led;
            f_shade(&mut ctx, fm, sm);
            out[i] = ctx.finish_rgb();
        }
        let t2 = cyc();
        let (u, s) = (t1.wrapping_sub(t0), t2.wrapping_sub(t1));
        if u.wrapping_add(s) < best.0.wrapping_add(best.1) {
            best = (u, s);
        }
        fxpb_yield();
    }
    // Compare OUT_NAT_AOT to OUT_VM (the VM's last frame).
    let (mx, sum, off) = engine::compare(n);
    log_line(format_args!(
        "aot {} {fx} n={n} ok=1 words={} upd={} shade={} frame={} maxdiff={mx} meandiff_x1000={} off2={off}",
        d.name,
        words,
        best.0,
        best.1,
        best.0 + best.1,
        sum * 1000 / (n as u64).max(1)
    ));
}

// --- native-image signatures (firmware/fx_sig; docs/design/fx-native-aot.md) --

/// This bench image's firmware version for `min_fw` (an untagged build: 0).
const FW_VERSION: u32 = 0;
/// Native ABIs this image runs.
const ABIS: &[u16] = &[aot::NATIVE_ABI];
/// NVS namespace keys (bench_main.cpp opens namespace `splanc_fxsig`).
const NVS_FAILS: &[u8] = b"fails\0";
const NVS_MIN_EPOCH: &[u8] = b"minep\0";
const NVS_REVOKED: &[u8] = b"revoked\0";

/// The C6's hardware SHA-256 through mbedtls (one context: one hash at a time,
/// which the single-threaded bench guarantees).
struct HwSha;
impl HwSha {
    fn new() -> Self {
        unsafe { fxpb_sha_begin() };
        HwSha
    }
}
impl sig::Digest for HwSha {
    fn update(&mut self, data: &[u8]) {
        unsafe { fxpb_sha_update(data.as_ptr(), data.len()) }
    }
    fn finish(self) -> [u8; 32] {
        let mut out = [0u8; 32];
        unsafe { fxpb_sha_finish(out.as_mut_ptr()) };
        out
    }
}

struct SigState {
    ring: sig::KeyRing<sig::SoftSha256>,
    policy: sig::Policy,
    limiter: sig::Limiter,
    device_id: [u8; 8],
}
static mut SIG: Option<SigState> = None;

/// Key ring, policy and backoff, loaded from NVS on first use: the dev key is
/// always present (the default every device is provisioned with); user keys
/// `k1`..`k3` (32-byte blobs) are installed if provisioned.
unsafe fn sig_state() -> &'static mut SigState {
    let st = &mut *addr_of_mut!(SIG);
    if st.is_none() {
        let mut ring = sig::KeyRing::with_dev_key(sig::SoftSha256::new);
        let mut users = 0;
        for id in 1u8..=3 {
            let name = [b'k', b'0' + id, 0];
            let mut k = [0u8; 32];
            if fxpb_nvs_get_blob(name.as_ptr(), k.as_mut_ptr(), k.len()) == 32 {
                ring.install(id, &k, sig::SoftSha256::new);
                users += 1;
            }
        }
        let get = |k: &[u8]| {
            let mut v = 0u32;
            if fxpb_nvs_get_u32(k.as_ptr(), &mut v) == 0 {
                v
            } else {
                0
            }
        };
        let policy = sig::Policy { min_epoch: get(NVS_MIN_EPOCH) as u16, revoked: get(NVS_REVOKED) };
        let fails = get(NVS_FAILS);
        let mut device_id = [0u8; 8];
        fxpb_device_id(device_id.as_mut_ptr());
        log_line(format_args!(
            "sig init keys=dev+{users} min_epoch={} revoked={:#x} persisted_fails={fails} fw={FW_VERSION} abi={}",
            policy.min_epoch,
            policy.revoked,
            aot::NATIVE_ABI
        ));
        *st = Some(SigState {
            ring,
            policy,
            limiter: sig::Limiter::restore(fails, fxpb_millis() as u64),
            device_id,
        });
    }
    st.as_mut().unwrap()
}

/// Parse + authenticate a `.fxn` against its `.fxb` with the device-wide key
/// ring, policy and backoff (persisting the backoff when it changes).
unsafe fn authenticate<'a>(blob: &'a [u8], fxb: &[u8]) -> Result<sig::Fxn<'a>, sig::Reject> {
    let st = sig_state();
    let fxn = sig::Fxn::parse(blob)?;
    let dev = sig::Device { fw_version: FW_VERSION, abis: ABIS, device_id: st.device_id };
    let now = fxpb_millis() as u64;
    let r = sig::verify(&fxn, fxb, &st.ring, &st.policy, &dev, &mut st.limiter, now, HwSha::new);
    if st.limiter.take_dirty() {
        fxpb_nvs_set_u32(NVS_FAILS.as_ptr(), st.limiter.persisted());
    }
    if let Err(e) = r {
        log_line(format_args!("sig reject reason={} boot_fails={}", e.as_str(), st.limiter.boot_fails));
    }
    r.map(|()| fxn)
}

/// Signature bring-up on the device: verify cost per embedded image (software
/// vs hardware SHA), the expected reject reason for every case in SIG_CASES,
/// the backoff, and a tampered blob falling back to the VM while the good one
/// runs native. Logs `fxpb sig ...` lines and a summary.
unsafe fn sig_pass() {
    let st = sig_state();
    let dev = sig::Device { fw_version: FW_VERSION, abis: ABIS, device_id: st.device_id };
    // 1. Cost: one SHA-256 over code + op_code + fxb, one HMAC (precomputed pads).
    let (mut n_img, mut sum_sw, mut sum_hw, mut max_bytes) = (0u32, 0u32, 0u32, 0usize);
    for d in EFFECTS.iter().filter(|d| d.aot_ok && d.group == GROUP_STUDY) {
        let Ok(fxn) = sig::Fxn::parse(d.aot_fxn) else { continue };
        let bytes = fxn.code.len() + fxn.op_code.len() + d.fxb.len();
        let mut best = [u32::MAX; 2];
        for _ in 0..3 {
            for (k, b) in best.iter_mut().enumerate() {
                let mut lim = sig::Limiter::default();
                let t0 = cyc();
                let r = if k == 0 {
                    sig::verify(&fxn, d.fxb, &st.ring, &st.policy, &dev, &mut lim, 0, sig::SoftSha256::new)
                } else {
                    sig::verify(&fxn, d.fxb, &st.ring, &st.policy, &dev, &mut lim, 0, HwSha::new)
                };
                let dt = cyc().wrapping_sub(t0);
                if r.is_ok() {
                    *b = (*b).min(dt);
                }
            }
        }
        log_line(format_args!(
            "sig verify {} bytes={bytes} sw_cyc={} hw_cyc={} sw_us={} hw_us={}",
            d.name,
            best[0],
            best[1],
            best[0] / 160,
            best[1] / 160
        ));
        if best[0] != u32::MAX && best[1] != u32::MAX {
            n_img += 1;
            sum_sw += best[0] / 160;
            sum_hw += best[1] / 160;
            max_bytes = max_bytes.max(bytes);
        }
        fxpb_yield();
    }
    // 2. Every case's reason (fresh backoff per case so they're independent).
    let (mut pass, mut total) = (0u32, 0u32);
    for (case, effect, blob, other, want) in SIG_CASES.iter() {
        let Some(d) = EFFECTS.iter().find(|d| d.name == *effect) else { continue };
        let fxb = if *other { SIG_OTHER_FXB } else { d.fxb };
        let mut lim = sig::Limiter::default();
        let got = sig::Fxn::parse(blob)
            .and_then(|f| sig::verify(&f, fxb, &st.ring, &st.policy, &dev, &mut lim, 0, HwSha::new));
        let got = match got {
            Ok(()) => "ok",
            Err(e) => e.as_str(),
        };
        let ok = got == *want;
        total += 1;
        pass += ok as u32;
        log_line(format_args!("sig case={case} got={got} want={want} pass={}", ok as u8));
    }
    // 3. Backoff: back-to-back bad tags on one limiter -> rate limited after
    // FREE_FAILS, and the good blob is held off too until the window passes.
    let (bad, good) = (
        SIG_CASES.iter().find(|c| c.0 == "tamper_code"),
        SIG_CASES.iter().find(|c| c.0 == "good"),
    );
    let mut rl_ok = false;
    if let (Some(bad), Some(good)) = (bad, good) {
        let d = EFFECTS.iter().find(|d| d.name == bad.1).unwrap();
        let mut lim = sig::Limiter::default();
        let t = 1_000u64;
        let mut seq = [""; 6];
        for s in seq.iter_mut().take(5) {
            let f = sig::Fxn::parse(bad.2).unwrap();
            *s = match sig::verify(&f, d.fxb, &st.ring, &st.policy, &dev, &mut lim, t, HwSha::new) {
                Ok(()) => "ok",
                Err(e) => e.as_str(),
            };
        }
        let f = sig::Fxn::parse(good.2).unwrap();
        let held = sig::verify(&f, d.fxb, &st.ring, &st.policy, &dev, &mut lim, t, HwSha::new);
        seq[5] = match held {
            Ok(()) => "ok",
            Err(e) => e.as_str(),
        };
        let later = sig::verify(&f, d.fxb, &st.ring, &st.policy, &dev, &mut lim, t + sig::limiter::BASE_MS, HwSha::new);
        rl_ok = seq[..3].iter().all(|s| *s == "bad_tag")
            && seq[3..].iter().all(|s| *s == "rate_limited")
            && later.is_ok();
        log_line(format_args!(
            "sig ratelimit seq={},{},{},{},{} good_during={} good_after={} persisted={} pass={}",
            seq[0],
            seq[1],
            seq[2],
            seq[3],
            seq[4],
            seq[5],
            if later.is_ok() { "ok" } else { "rejected" },
            lim.persisted(),
            rl_ok as u8
        ));
    }
    // 4. End to end on the device-wide path: the tampered blob stays on the VM,
    // the good one runs native and matches the VM bit for bit.
    if let (Some(bad), Some(good)) = (bad, good) {
        let d = EFFECTS.iter().find(|d| d.name == bad.1).unwrap();
        fixture::build(Kind::Helix, 500);
        if vm_and_jit(d, 500, Kind::Helix, false).is_some() {
            aot_run_blob(d, bad.2, 500, Kind::Helix);
            aot_run_blob(d, good.2, 500, Kind::Helix);
        }
    }
    log_line(format_args!(
        "sig summary images={n_img} max_bytes={max_bytes} mean_sw_us={} mean_hw_us={} cases={total} pass={pass} ratelimit={} ring_bytes={} heap_bytes=0",
        sum_sw / n_img.max(1),
        sum_hw / n_img.max(1),
        rl_ok as u8,
        core::mem::size_of::<SigState>()
    ));
}

/// The whole bench. Called once from setup().
#[no_mangle]
pub unsafe extern "C" fn fxpb_run() {
    log_line(format_args!("start effects={} cpu_hz=160000000", EFFECTS.len()));
    sig_pass();
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
                aot_run(d, n, Kind::Helix);
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
