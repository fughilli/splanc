//! The driver VM host (FUG-107, docs/design/sensor-core.md §8; supersedes PR
//! #96's design): runs ONE `.fxb` sensor driver — a program with `void poll()`
//! and `export` declarations — on the loop task, on the same I2C bus seam as
//! the native sensor core, and publishes its exports into the uniform pool BY
//! NAME. A driver that exports `imu_raw_accel` + `imu_raw_gyro` (counts) can
//! instead feed the native fusion (`feed_imu`), so the MPU-6050 runs either
//! natively or as bytecode with everything downstream identical — the A/B.
//!
//! Memory: nothing is resident until a driver is submitted. The slot (bytes +
//! VM + export table) is heap memory the C++ host hands over (`LmDrvHost`),
//! and is returned on remove_driver — the driver VM costs RAM only while used.
//!
//! Threading: everything here runs on the loop task under the player mutex
//! (submit/remove/state from the message handler, lm_drv_poll from loop()).

use core::ffi::c_void;
use core::ptr::{addr_of, addr_of_mut};

use ledmapper_fx_vm::{Budget, Frame as FxFrame, Outcome, Program, Vm as FxVm, FLAG_DRIVER};
use ledmapper_osc as osc;

use super::{client_arm, fx_error, pb, sensor_ffi, uniform_pool, write_arm, CArm};

/// Largest driver `.fxb` (MPU-6050 driver: ~400 B).
pub const DRV_MAX_BYTES: usize = 1024;
/// Exports a driver may publish.
pub const DRV_MAX_EXPORTS: usize = 8;
/// Opcode budget per poll (a driver is a few dozen bus ops + arithmetic).
pub const DRV_BUDGET: u32 = 20_000;
const MIN_INTERVAL_MS: u32 = 5;
const DEFAULT_INTERVAL_MS: u32 = 10;

/// What the C++ side provides. `alloc`/`free`: heap for the driver slot
/// (MALLOC_CAP_8BIT internal); `bus_ensure`: bring the I2C bus up (installing
/// the sensor core's LmI2cOps) if no native sensor did, true when usable;
/// `scan`: probe 0x08..0x77, writing ACKing addresses to `out`, returning the
/// count; `cycles`: the CPU cycle counter (cost accounting).
#[repr(C)]
pub struct LmDrvHost {
    pub alloc: Option<unsafe extern "C" fn(size: usize) -> *mut c_void>,
    pub free: Option<unsafe extern "C" fn(p: *mut c_void)>,
    pub bus_ensure: Option<unsafe extern "C" fn() -> bool>,
    pub scan: Option<unsafe extern "C" fn(out: *mut u8, cap: usize) -> usize>,
    pub cycles: Option<unsafe extern "C" fn() -> u32>,
}

static mut HOST: LmDrvHost = LmDrvHost { alloc: None, free: None, bus_ensure: None, scan: None, cycles: None };

#[derive(Clone, Copy)]
struct ExportRef {
    name: [u8; osc::MAX_NAME],
    name_len: u8,
    slot: u16,
    width: u8,
}

struct Driver {
    bytes: [u8; DRV_MAX_BYTES],
    len: usize,
    vm: FxVm,
    exports: [ExportRef; DRV_MAX_EXPORTS],
    n_exports: usize,
    interval_ms: u32,
    feed_imu: bool,
    next_us: u64,
    // stats
    polls: u32,
    bus_errors: u32,
    last_outcome: u8, // 0 ok, 1 budget, 2 timeout, 3 bus_error
    cyc_sum: u64,
    cyc_n: u32,
    cyc_mean: u32,
    cyc_max: u32,
    instr_sum: u64,
    instr_mean: u32,
    bus_ops_last: u32,
    jitter_us_max: u32,
}

static mut DRV: *mut Driver = core::ptr::null_mut();

/// Install the host callbacks (once, at boot).
///
/// # Safety
/// `h` valid for the call.
#[no_mangle]
pub unsafe extern "C" fn lm_drv_set_host(h: *const LmDrvHost) {
    if !h.is_null() {
        *addr_of_mut!(HOST) = core::ptr::read(h);
    }
}

/// Bytes a driver slot takes on the heap (reported in driver_state).
pub fn slot_bytes() -> usize {
    core::mem::size_of::<Driver>()
}

/// The VM-facing bus: the sensor core's LmI2cOps, counting ops and failures.
struct DrvBus {
    ops: u32,
    errors: u32,
}

impl ledmapper_fx_vm::I2cBus for DrvBus {
    fn write(&mut self, addr: u8, bytes: &[u8]) -> bool {
        self.ops += 1;
        let ok = unsafe { sensor_ffi::bus_write(addr, bytes) };
        self.errors += !ok as u32;
        ok
    }
    fn read_reg(&mut self, addr: u8, reg: u8, out: &mut [u8]) -> bool {
        self.ops += 1;
        let ok = unsafe { sensor_ffi::bus_write_read(addr, &[reg], out) };
        self.errors += !ok as u32;
        ok
    }
}

unsafe fn free_driver() {
    if !DRV.is_null() {
        core::ptr::drop_in_place(DRV);
        if let Some(f) = (*addr_of!(HOST)).free {
            f(DRV as *mut c_void);
        }
        DRV = core::ptr::null_mut();
    }
    uniform_pool::clear_dynamic();
}

/// One loop-task step: run the driver's poll() if due, publish its exports.
///
/// # Safety
/// Loop task, under the player mutex.
#[no_mangle]
pub unsafe extern "C" fn lm_drv_poll(now_us: u64) {
    if DRV.is_null() {
        return;
    }
    let d = &mut *DRV;
    if now_us < d.next_us {
        return;
    }
    // Lateness vs the schedule = the loop task's scheduling jitter.
    let late = (now_us - d.next_us) as u32;
    if d.polls > 0 && late > d.jitter_us_max {
        d.jitter_us_max = late;
    }
    d.next_us = now_us + d.interval_ms as u64 * 1000;
    let Ok(prog) = Program::parse(&d.bytes[..d.len]) else { return };
    let mut bus = DrvBus { ops: 0, errors: 0 };
    let budget = Budget { instructions: DRV_BUDGET, deadline: None };
    let cycles = (*addr_of!(HOST)).cycles;
    let c0 = cycles.map(|f| f()).unwrap_or(0);
    let (outcome, counters) = d.vm.run_poll(&prog, &FxFrame::default(), &mut bus, &budget);
    let c1 = cycles.map(|f| f()).unwrap_or(0);
    d.polls = d.polls.wrapping_add(1);
    d.bus_ops_last = bus.ops;
    d.bus_errors = d.bus_errors.wrapping_add(bus.errors);
    d.last_outcome = match outcome {
        Outcome::Ok if bus.errors > 0 => 3,
        Outcome::Ok => 0,
        Outcome::Budget => 1,
        _ => 2,
    };
    let c = c1.wrapping_sub(c0);
    d.cyc_sum += c as u64;
    d.cyc_max = d.cyc_max.max(c);
    d.instr_sum += counters.instrs as u64;
    d.cyc_n += 1;
    if d.cyc_n >= 64 {
        d.cyc_mean = (d.cyc_sum / d.cyc_n as u64) as u32;
        d.instr_mean = (d.instr_sum / d.cyc_n as u64) as u32;
        d.cyc_sum = 0;
        d.instr_sum = 0;
        d.cyc_n = 0;
    }
    // A poll with a bus error publishes nothing (a -1 read is a valid i16).
    if d.last_outcome != 0 {
        return;
    }
    let mut accel = None;
    let mut gyro = None;
    for e in &d.exports[..d.n_exports] {
        let mut v = [0.0f32; 4];
        d.vm.export(e.slot as usize, &mut v[..e.width as usize]);
        let name = &e.name[..e.name_len as usize];
        if d.feed_imu && e.width == 3 && name == b"imu_raw_accel" {
            accel = Some([v[0], v[1], v[2]]);
        } else if d.feed_imu && e.width == 3 && name == b"imu_raw_gyro" {
            gyro = Some([v[0], v[1], v[2]]);
        } else {
            uniform_pool::publish(name, &v[..e.width as usize]);
        }
    }
    if let (Some(a), Some(g)) = (accel, gyro) {
        let raw = |x: [f32; 3]| [x[0] as i16, x[1] as i16, x[2] as i16];
        sensor_ffi::ingest_external(raw(a), raw(g), now_us);
    }
}

/// Load a driver (replacing any running one). Returns an error reply or None.
unsafe fn load(fxb: &[u8], interval_ms: u32, feed_imu: bool) -> Result<(), pb::ServerMessage> {
    if fxb.len() > DRV_MAX_BYTES {
        return Err(fx_error("driver_too_large", "driver fxb exceeds the 1 KiB driver buffer"));
    }
    let prog = Program::parse(fxb).map_err(|_| fx_error("bad_fxb", "driver fxb failed to parse"))?;
    if prog.flags & FLAG_DRIVER == 0 {
        return Err(fx_error("not_a_driver", "that program has no poll(); submit it as an effect"));
    }
    let table = osc::parse_manifest(prog.manifest);
    let host = &*addr_of!(HOST);
    let (Some(alloc), Some(bus_ensure)) = (host.alloc, host.bus_ensure) else {
        return Err(fx_error("unsupported", "this firmware has no driver host"));
    };
    if !bus_ensure() {
        return Err(fx_error("no_bus", "the I2C bus could not be started (pins disabled or conflicting)"));
    }
    free_driver();
    let p = alloc(core::mem::size_of::<Driver>()) as *mut Driver;
    if p.is_null() {
        return Err(fx_error("no_memory", "not enough heap for the driver VM"));
    }
    // Field-by-field init in place: no 6+ KB Driver temporary on this stack.
    addr_of_mut!((*p).vm).write(FxVm::new());
    addr_of_mut!((*p).bytes).write([0; DRV_MAX_BYTES]);
    (*p).bytes[..fxb.len()].copy_from_slice(fxb);
    addr_of_mut!((*p).len).write(fxb.len());
    let mut ex = [ExportRef { name: [0; osc::MAX_NAME], name_len: 0, slot: 0, width: 0 }; DRV_MAX_EXPORTS];
    let mut n = 0;
    for port in table.ports() {
        if n >= DRV_MAX_EXPORTS {
            break;
        }
        let b = port.name().as_bytes();
        ex[n].name[..b.len()].copy_from_slice(b);
        ex[n].name_len = b.len() as u8;
        ex[n].slot = port.slot;
        ex[n].width = port.width.clamp(1, 4);
        n += 1;
    }
    addr_of_mut!((*p).exports).write(ex);
    addr_of_mut!((*p).n_exports).write(n);
    let iv = if interval_ms == 0 { DEFAULT_INTERVAL_MS } else { interval_ms.max(MIN_INTERVAL_MS) };
    addr_of_mut!((*p).interval_ms).write(iv);
    addr_of_mut!((*p).feed_imu).write(feed_imu);
    addr_of_mut!((*p).next_us).write(0);
    addr_of_mut!((*p).cyc_sum).write(0);
    addr_of_mut!((*p).instr_sum).write(0);
    for f in [
        addr_of_mut!((*p).polls),
        addr_of_mut!((*p).bus_errors),
        addr_of_mut!((*p).cyc_n),
        addr_of_mut!((*p).cyc_mean),
        addr_of_mut!((*p).cyc_max),
        addr_of_mut!((*p).instr_mean),
        addr_of_mut!((*p).bus_ops_last),
        addr_of_mut!((*p).jitter_us_max),
    ] {
        f.write(0);
    }
    addr_of_mut!((*p).last_outcome).write(0);
    DRV = p;
    if feed_imu {
        // The VM driver now owns the IMU: stop the native sampler (if any) and
        // switch the hub to externally fed samples.
        sensor_ffi::start_external();
    }
    Ok(())
}

// -- protocol -------------------------------------------------------------------

/// ServerMessage field numbers.
const ARM_I2C_SCAN_RESULT: u32 = 28;
const ARM_DRIVER_STATE: u32 = 29;

pub(crate) unsafe fn handle_scan_i2c(out: *mut u8, out_cap: usize) -> i32 {
    let host = &*addr_of!(HOST);
    let mut addrs = [0u8; 112];
    let mut n = 0usize;
    if let (Some(ensure), Some(scan)) = (host.bus_ensure, host.scan) {
        if ensure() {
            n = scan(addrs.as_mut_ptr(), addrs.len());
        }
    }
    write_arm(out, out_cap, ARM_I2C_SCAN_RESULT, |w| {
        if n > 0 {
            // repeated uint32 addresses = 1 [packed]
            w.key(1, 2);
            w.varint(n as u64);
            for &a in &addrs[..n] {
                w.byte(a); // all < 0x80: one varint byte each
            }
        }
    })
}

pub(crate) unsafe fn handle_submit_driver(frame: &[u8], out: *mut u8, out_cap: usize) -> i32 {
    let Some(CArm::SubmitDriver(m)) = client_arm(frame) else {
        return super::encode_reply(&fx_error("bad_fxb", "submit_driver is malformed"), out, out_cap);
    };
    if let Err(e) = load(m.fxb(), m.poll_interval_ms(), m.feed_imu()) {
        return super::encode_reply(&e, out, out_cap);
    }
    handle_get_driver_state(out, out_cap)
}

pub(crate) unsafe fn handle_remove_driver(out: *mut u8, out_cap: usize) -> i32 {
    free_driver();
    handle_get_driver_state(out, out_cap)
}

pub(crate) unsafe fn handle_get_driver_state(out: *mut u8, out_cap: usize) -> i32 {
    write_arm(out, out_cap, ARM_DRIVER_STATE, |w| {
        if DRV.is_null() {
            return;
        }
        let d = &*DRV;
        w.uint(1, 1); // running
        w.uint(2, d.interval_ms as u64);
        for e in &d.exports[..d.n_exports] {
            let mut v = [0.0f32; 4];
            d.vm.export(e.slot as usize, &mut v[..e.width as usize]);
            w.value_msg(3, super::ValueKey::Name(&e.name[..e.name_len as usize]), &v[..e.width as usize]);
        }
        let oc: &[u8] = match d.last_outcome {
            0 => b"ok",
            1 => b"budget",
            2 => b"timeout",
            _ => b"bus_error",
        };
        if d.polls > 0 {
            w.bytes(4, oc);
        }
        w.uint(5, d.polls as u64);
        w.uint(6, d.bus_errors as u64);
        w.uint(7, d.cyc_mean as u64);
        w.uint(8, d.cyc_max as u64);
        w.uint(9, d.instr_mean as u64);
        w.uint(10, d.bus_ops_last as u64);
        w.uint(11, slot_bytes() as u64);
        w.uint(12, d.jitter_us_max as u64);
        w.uint(13, d.feed_imu as u64);
    })
}
