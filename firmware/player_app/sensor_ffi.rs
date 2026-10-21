//! Sensor core glue (docs/design/sensor-core.md): the C ABI the firmware's
//! sensor task drives (`lm_sensor_*`), the bus seam over the C++ ESP-IDF
//! `i2c_master` callbacks, the seqlocked [`Snapshot`] every other context
//! reads, and the get_sensors / calibrate_sensors protocol arms.
//!
//! Threading: the hub is touched ONLY by the sensor task (`lm_sensor_poll`) —
//! and by `lm_sensor_begin`, which runs before that task exists. Everything
//! else (the render task via lm_fx_update, the message handler) reads the
//! published snapshot. Calibration requests cross over through an atomic
//! mailbox the task applies at its next poll. The snapshot is a seqlock with a
//! BOUNDED reader retry: on one core a higher-priority reader that preempted
//! the writer mid-publish must not spin (the writer can't run until it stops),
//! so it falls back to the last snapshot it read whole.

use core::ffi::c_void;
use core::ptr::{addr_of, addr_of_mut};
use core::sync::atomic::{fence, AtomicBool, AtomicU32, AtomicU8, Ordering};

use ledmapper_sensor::calib::Calibration;
use ledmapper_sensor::mpu6050::{Config, Variant};
use ledmapper_sensor::{BusError, CalAction, CalError, Hub, I2cBus, Snapshot};

use super::{client_arm, write_arm, CArm, PbOut};

/// The C++ bus callbacks: `0` = ACK'd and done, `1` = address NACK, anything
/// else = other failure (timeout, arbitration, stuck bus).
#[repr(C)]
pub struct LmI2cOps {
    pub ctx: *mut c_void,
    pub write_read:
        Option<unsafe extern "C" fn(ctx: *mut c_void, addr: u8, wr: *const u8, wn: usize, rd: *mut u8, rn: usize) -> i32>,
    pub write: Option<unsafe extern "C" fn(ctx: *mut c_void, addr: u8, wr: *const u8, wn: usize) -> i32>,
    /// Free-running CPU cycle counter (self-measured fusion cost); optional.
    pub cycles: Option<unsafe extern "C" fn() -> u32>,
}

struct FfiBus(*const LmI2cOps);

fn bus_result(r: i32) -> Result<(), BusError> {
    match r {
        0 => Ok(()),
        1 => Err(BusError::Nack),
        _ => Err(BusError::Other),
    }
}

impl I2cBus for FfiBus {
    fn write_read(&mut self, addr: u8, wr: &[u8], rd: &mut [u8]) -> Result<(), BusError> {
        let ops = unsafe { &*self.0 };
        match ops.write_read {
            Some(f) => bus_result(unsafe { f(ops.ctx, addr, wr.as_ptr(), wr.len(), rd.as_mut_ptr(), rd.len()) }),
            None => Err(BusError::Other),
        }
    }
    fn write(&mut self, addr: u8, wr: &[u8]) -> Result<(), BusError> {
        let ops = unsafe { &*self.0 };
        match ops.write {
            Some(f) => bus_result(unsafe { f(ops.ctx, addr, wr.as_ptr(), wr.len()) }),
            None => Err(BusError::Other),
        }
    }
}

/// SensorStatus.SENSOR_STATUS_DISABLED (hub states 1..=5 match the enum).
const STATUS_DISABLED: u8 = 6;

static mut HUB: Option<Hub> = None;
static mut OPS: LmI2cOps = LmI2cOps { ctx: core::ptr::null_mut(), write_read: None, write: None, cycles: None };
/// SDA, SCL, INT (-1 = none).
static mut PINS: [i32; 3] = [-1, -1, -1];

static SNAP_SEQ: AtomicU32 = AtomicU32::new(0);
static mut SNAP: Snapshot = SNAP_INIT;
/// Reader-side last whole copy (bounded-retry fallback). Only lm_fx_update /
/// the handler read, both under the player mutex, so one cache is enough.
static mut SNAP_LAST: Snapshot = SNAP_INIT;
const SNAP_INIT: Snapshot = Snapshot {
    state: 0,
    addr: 0,
    who_am_i: 0,
    variant: 0,
    fifo: 0,
    at_rest: 0,
    calibrated: 0,
    accel_suspect: 0,
    samples: 0,
    accel: [0.0; 3],
    gyro: [0.0; 3],
    quat: [1.0, 0.0, 0.0, 0.0],
    gravity: [0.0, 0.0, -1.0],
    linear_accel: [0.0; 3],
    gyro_bias: [0.0; 3],
    temperature_c: 0.0,
    shake: 0.0,
    tap_count: 0,
    shake_count: 0,
    rate_hz: 0.0,
    fifo_overflows: 0,
    bus_errors: 0,
    ingest_cycles_mean: 0,
    ingest_cycles_min: 0,
    rest_up_imu: [0.0; 3],
    rest_up_sigma_deg: 0.0,
    rest_samples: 0,
    mount_map: [
        core::f32::consts::FRAC_1_SQRT_2,
        -core::f32::consts::FRAC_1_SQRT_2,
        0.0,
        0.0,
    ],
    cal_flags: 0,
    mount_poses: 0,
    mount_residual_deg: 0.0,
    calibrated_at: 0,
};

/// Calibration mailbox: 0 = none, else CalibrateSensors.Action.
static PENDING_CAL: AtomicU8 = AtomicU8::new(0);
static CAL_SEQ: AtomicU32 = AtomicU32::new(0);
/// 0 none, 1 ok, 2 not_running, 3 not_at_rest.
static CAL_RESULT: AtomicU8 = AtomicU8::new(0);
/// Mailbox for set_sensor_mount (§7): the data is written before the flag is
/// raised (Release), read after it is taken (Acquire).
static MOUNT_PENDING: AtomicBool = AtomicBool::new(false);
static mut MOUNT_REQ: ([f32; 4], f32, u8, bool, u32) = ([1.0, 0.0, 0.0, 0.0], 0.0, 0, false, 0);
/// The LED map was replaced (lm_map_replaced): clear the extrinsic's yaw.
static MAP_CHANGED: AtomicBool = AtomicBool::new(false);

/// Who owns the hub. NATIVE: the sensor task (if any). HANDOVER: the driver VM
/// asked for it while the task exists — the task converts the hub itself at its
/// next poll and exits (so the hub is never touched by two tasks). EXTERNAL:
/// the driver VM feeds it via [`ingest_external`] on the loop task.
static OWNER: AtomicU8 = AtomicU8::new(OWNER_NATIVE);
const OWNER_NATIVE: u8 = 0;
const OWNER_HANDOVER: u8 = 1;
const OWNER_EXTERNAL: u8 = 2;
/// lm_sensor_begin started a native task (set before the task exists).
static TASK_EXISTS: AtomicBool = AtomicBool::new(false);
/// lm_sensor_poll's "exit the task" return.
pub const POLL_STOP: u32 = u32::MAX;

fn ops_cycles() -> u32 {
    match unsafe { (*addr_of!(OPS)).cycles } {
        Some(f) => unsafe { f() },
        None => 0,
    }
}

unsafe fn publish(s: &Snapshot) {
    let seq = SNAP_SEQ.load(Ordering::Relaxed);
    SNAP_SEQ.store(seq.wrapping_add(1), Ordering::Relaxed);
    fence(Ordering::Release);
    core::ptr::write_volatile(addr_of_mut!(SNAP), *s);
    fence(Ordering::Release);
    SNAP_SEQ.store(seq.wrapping_add(2), Ordering::Release);
    SENSOR_LIVE.store(s.state == ledmapper_sensor::State::Running as u8, Ordering::Relaxed);
}

/// The latest published snapshot (never blocks; see the module doc).
pub(crate) unsafe fn snapshot() -> Snapshot {
    for _ in 0..4 {
        let s1 = SNAP_SEQ.load(Ordering::Acquire);
        if s1 & 1 == 0 {
            let s = core::ptr::read_volatile(addr_of!(SNAP));
            fence(Ordering::Acquire);
            if SNAP_SEQ.load(Ordering::Relaxed) == s1 {
                *addr_of_mut!(SNAP_LAST) = s;
                return s;
            }
        }
    }
    *addr_of!(SNAP_LAST)
}

/// Probe for an IMU on the bus `ops` drives (SDA/SCL/INT recorded for reporting;
/// INT is not used yet — the task polls the FIFO).
/// `cal`/`cal_len`: the NVS calibration record, if any. Returns the hub state
/// (SensorStatus numbering): 1 absent, 2 unknown device, 3 starting (start the
/// sensor task and call lm_sensor_poll), 5 fault. ~0.2 ms when absent.
///
/// # Safety
/// `ops` must outlive the sensor core; no sensor task may be running.
#[no_mangle]
pub unsafe extern "C" fn lm_sensor_begin(
    ops: *const LmI2cOps,
    sda: i32,
    scl: i32,
    int_gpio: i32,
    now_us: u64,
    cal: *const u8,
    cal_len: usize,
) -> u8 {
    if ops.is_null() {
        return 0;
    }
    *addr_of_mut!(OPS) = core::ptr::read(ops);
    *addr_of_mut!(PINS) = [sda, scl, int_gpio];
    let hub = (*addr_of_mut!(HUB)).insert(Hub::new(Config::default()));
    if (*addr_of!(OPS)).cycles.is_some() {
        hub.set_cycle_source(ops_cycles);
    }
    if !cal.is_null() && cal_len > 0 {
        if let Some(c) = Calibration::decode(core::slice::from_raw_parts(cal, cal_len)) {
            hub.load_calibration(c);
        }
    }
    let st = hub.probe(&mut FfiBus(addr_of!(OPS)), now_us) as u8;
    // State 3 = Starting: the caller now creates the sensor task.
    TASK_EXISTS.store(st == ledmapper_sensor::State::Starting as u8, Ordering::Release);
    publish(&hub.snapshot());
    st
}

/// Mark the sensor core disabled (config off / pin conflict with the LED
/// outputs) so get_sensors says why there is no data.
///
/// # Safety
/// Not concurrently with a running sensor task.
#[no_mangle]
pub unsafe extern "C" fn lm_sensor_set_disabled(sda: i32, scl: i32, int_gpio: i32) {
    *addr_of_mut!(PINS) = [sda, scl, int_gpio];
    let mut s = SNAP_INIT;
    s.state = STATUS_DISABLED;
    publish(&s);
}

/// One sensor-task step: apply a pending calibration, advance the hub (drain
/// the FIFO, fuse), publish. Returns ms to sleep.
///
/// # Safety
/// Sensor task only, after lm_sensor_begin.
#[no_mangle]
pub unsafe extern "C" fn lm_sensor_poll(now_us: u64) -> u32 {
    match OWNER.load(Ordering::Acquire) {
        OWNER_NATIVE => {}
        OWNER_HANDOVER => {
            // The driver VM takes the IMU: convert the hub here (this task owns
            // it until now), then exit.
            to_external();
            TASK_EXISTS.store(false, Ordering::Release);
            OWNER.store(OWNER_EXTERNAL, Ordering::Release);
            return POLL_STOP;
        }
        _ => return POLL_STOP,
    }
    let Some(hub) = (*addr_of_mut!(HUB)).as_mut() else { return 1000 };
    apply_pending_cal(hub);
    let ms = hub.poll(&mut FfiBus(addr_of!(OPS)), now_us);
    publish(&hub.snapshot());
    ms
}

/// If a calibration action changed the record since the last call, copy it to
/// `out` (for the task to persist to NVS) and return its length; else 0.
///
/// # Safety
/// Sensor task only; `out` valid for `cap` bytes.
#[no_mangle]
pub unsafe extern "C" fn lm_sensor_take_cal_record(out: *mut u8, cap: usize) -> i32 {
    let Some(hub) = (*addr_of_mut!(HUB)).as_mut() else { return 0 };
    if !hub.take_cal_dirty() {
        return 0;
    }
    let rec = hub.calibration().encode();
    if out.is_null() || cap < rec.len() {
        return -1;
    }
    core::ptr::copy_nonoverlapping(rec.as_ptr(), out, rec.len());
    rec.len() as i32
}

/// A one-line status for the periodic serial log. `u`: [state | addr<<8 |
/// who<<16 | fifo<<24, samples, bus_errors, fusion cycles mean, min,
/// fifo_overflows]; `f`: [rate_hz, quat w, x, y, z].
///
/// # Safety
/// `u` valid for 6 u32, `f` for 5 f32.
#[no_mangle]
pub unsafe extern "C" fn lm_sensor_status(u: *mut u32, f: *mut f32) {
    let s = snapshot();
    let u = core::slice::from_raw_parts_mut(u, 6);
    let f = core::slice::from_raw_parts_mut(f, 5);
    u[0] = s.state as u32 | (s.addr as u32) << 8 | (s.who_am_i as u32) << 16 | (s.fifo as u32) << 24;
    u[1] = s.samples;
    u[2] = s.bus_errors;
    u[3] = s.ingest_cycles_mean;
    u[4] = s.ingest_cycles_min;
    u[5] = s.fifo_overflows;
    f[0] = s.rate_hz;
    f[1..5].copy_from_slice(&s.quat);
}

// -- the bus, shared with the driver VM (driver_ffi.rs) -----------------------

/// Install the bus callbacks without probing (the driver VM brings the bus up
/// when no native sensor did).
///
/// # Safety
/// `ops` valid for the call; not while a native sensor task runs.
#[no_mangle]
pub unsafe extern "C" fn lm_sensor_set_ops(ops: *const LmI2cOps) {
    if !ops.is_null() {
        *addr_of_mut!(OPS) = core::ptr::read(ops);
    }
}

pub(crate) unsafe fn bus_write(addr: u8, bytes: &[u8]) -> bool {
    FfiBus(addr_of!(OPS)).write(addr, bytes).is_ok()
}

pub(crate) unsafe fn bus_write_read(addr: u8, wr: &[u8], rd: &mut [u8]) -> bool {
    FfiBus(addr_of!(OPS)).write_read(addr, wr, rd).is_ok()
}

/// Run a calibration action posted by calibrate_sensors (whichever context owns
/// the hub calls this before advancing it).
unsafe fn apply_pending_cal(hub: &mut Hub) {
    if MOUNT_PENDING.swap(false, Ordering::AcqRel) {
        let (q, residual, poses, yaw, ts) = *addr_of!(MOUNT_REQ);
        hub.set_extrinsic(ledmapper_sensor::math::Quat::from_array(q).normalized(), residual, poses, yaw, ts);
        CAL_RESULT.store(1, Ordering::Relaxed);
        CAL_SEQ.fetch_add(1, Ordering::Release);
    }
    if MAP_CHANGED.swap(false, Ordering::AcqRel) {
        hub.map_changed();
    }
    let act = PENDING_CAL.swap(0, Ordering::AcqRel);
    if act != 0 {
        let action = match act {
            1 => Some(CalAction::GyroBias),
            2 => Some(CalAction::Level),
            3 => Some(CalAction::Reset),
            _ => None,
        };
        if let Some(a) = action {
            let r = match hub.calibrate(a) {
                Ok(()) => 1,
                Err(CalError::NotRunning) => 2,
                Err(CalError::NotAtRest) => 3,
            };
            CAL_RESULT.store(r, Ordering::Relaxed);
            CAL_SEQ.fetch_add(1, Ordering::Release);
        }
    }
}

/// Convert the hub to the external feed (whoever owns it calls this).
unsafe fn to_external() {
    let hub = (*addr_of_mut!(HUB)).get_or_insert_with(|| Hub::new(Config::default()));
    if (*addr_of!(OPS)).cycles.is_some() {
        hub.set_cycle_source(ops_cycles);
    }
    let (addr, who) = hub.found().map(|f| (f.addr, f.who_am_i)).unwrap_or((0x68, 0x68));
    hub.start_external(addr, who, 0);
    publish(&hub.snapshot());
}

/// Hand the IMU to the driver VM's feed. Loop task, player mutex held. With a
/// native task alive the task converts the hub and exits at its next poll
/// (≤ ~20 ms; samples arriving before that are dropped); otherwise now.
/// Reverting to the native driver takes a reboot.
pub(crate) unsafe fn start_external() {
    if OWNER.load(Ordering::Acquire) != OWNER_NATIVE {
        return;
    }
    if TASK_EXISTS.load(Ordering::Acquire) {
        OWNER.store(OWNER_HANDOVER, Ordering::Release);
    } else {
        to_external();
        OWNER.store(OWNER_EXTERNAL, Ordering::Release);
    }
}

/// One sample from the driver VM (raw counts, ±8 g / ±1000 °/s like the
/// native config). Loop task.
pub(crate) unsafe fn ingest_external(accel: [i16; 3], gyro: [i16; 3], now_us: u64) {
    if OWNER.load(Ordering::Acquire) != OWNER_EXTERNAL {
        return;
    }
    let Some(hub) = (*addr_of_mut!(HUB)).as_mut() else { return };
    apply_pending_cal(hub);
    hub.ingest_external(&ledmapper_sensor::mpu6050::Raw { accel, gyro, temp: None }, now_us);
    publish(&hub.snapshot());
}

// -- effects ------------------------------------------------------------------

/// The snapshot, if a sensor is running.
pub(crate) unsafe fn running_snapshot() -> Option<Snapshot> {
    if SNAP_SEQ.load(Ordering::Relaxed) == 0 {
        return None;
    }
    let s = snapshot();
    (s.state == ledmapper_sensor::State::Running as u8).then_some(s)
}

/// True while the hub is Running (set on every publish): lm_fx_update checks it
/// inline before touching any sensor code.
pub static SENSOR_LIVE: AtomicBool = AtomicBool::new(false);

/// `imu.accel` (g, fixture frame — 1.0 straight up at rest) and `imu.gyro`
/// (rad/s) into the fx Frame, with their Q16.16 mirrors (LoadCtxFix). Out of
/// line + cold: only reached while a sensor runs.
#[cold]
#[inline(never)]
pub(crate) unsafe fn fill_frame_imu(f: &mut ledmapper_fx_vm::Frame) {
    let s = snapshot();
    if s.state != ledmapper_sensor::State::Running as u8 {
        return;
    }
    let k = 1.0 / ledmapper_sensor::math::GRAVITY;
    let a = [s.accel[0] * k, s.accel[1] * k, s.accel[2] * k];
    let fx = |v: [f32; 3]| [super::q16_16(v[0]), super::q16_16(v[1]), super::q16_16(v[2])];
    f.imu_accel = a;
    f.imu_gyro = s.gyro;
    f.imu_accel_fix = fx(a);
    f.imu_gyro_fix = fx(s.gyro);
}

// -- protocol -----------------------------------------------------------------

/// ServerMessage.sensor_state field number.
const ARM_SENSOR_STATE: u32 = 27;

fn part_name(code: u8) -> &'static str {
    match code {
        1 => Variant::Mpu6050.name(),
        2 => Variant::Mpu6500.name(),
        3 => Variant::Mpu9250.name(),
        4 => Variant::Mpu9255.name(),
        5 => Variant::Icm20689.name(),
        6 => Variant::Clone6500(0).name(),
        _ => "",
    }
}

impl PbOut<'_> {
    fn sint(&mut self, field: u32, v: i32) {
        // proto int32: negative values are 10-byte sign-extended varints.
        self.key(field, 0);
        self.varint(v as i64 as u64);
    }
    fn float(&mut self, field: u32, v: f32) {
        self.key(field, 5);
        for b in v.to_le_bytes() {
            self.byte(b);
        }
    }
    fn floats(&mut self, field: u32, vs: &[f32]) {
        self.key(field, 2);
        self.varint((vs.len() * 4) as u64);
        for v in vs {
            for b in v.to_le_bytes() {
                self.byte(b);
            }
        }
    }
}

fn write_sensor_state(w: &mut PbOut, s: &Snapshot, pins: [i32; 3]) {
    w.uint(1, s.state as u64);
    let part = part_name(s.variant);
    if !part.is_empty() {
        w.bytes(2, part.as_bytes());
    }
    w.uint(3, s.addr as u64);
    w.uint(4, s.who_am_i as u64);
    w.sint(5, pins[0]);
    w.sint(6, pins[1]);
    let running = s.state == ledmapper_sensor::State::Running as u8;
    if running {
        w.floats(7, &s.accel);
        w.floats(8, &s.gyro);
        w.floats(9, &s.quat);
        w.floats(10, &s.gravity);
        w.floats(11, &s.linear_accel);
        w.floats(12, &s.gyro_bias);
        w.float(13, s.temperature_c);
        w.float(14, s.shake);
    }
    w.uint(15, s.tap_count as u64);
    w.uint(16, s.shake_count as u64);
    w.uint(17, s.at_rest as u64);
    w.float(18, s.rate_hz);
    w.uint(19, s.samples as u64);
    w.uint(20, s.fifo_overflows as u64);
    w.uint(21, s.bus_errors as u64);
    w.uint(22, s.fifo as u64);
    w.uint(23, s.calibrated as u64);
    w.uint(24, s.accel_suspect as u64);
    w.uint(25, s.ingest_cycles_mean as u64);
    w.uint(26, CAL_SEQ.load(Ordering::Acquire) as u64);
    let r = match CAL_RESULT.load(Ordering::Relaxed) {
        1 => "ok",
        2 => "not_running",
        3 => "not_at_rest",
        _ => "",
    };
    if !r.is_empty() {
        w.bytes(27, r.as_bytes());
    }
    w.sint(28, pins[2]);
    if s.rest_samples > 0 {
        w.floats(29, &s.rest_up_imu);
        w.float(30, s.rest_up_sigma_deg);
        w.uint(31, s.rest_samples as u64);
    }
    use ledmapper_sensor::calib::{FLAG_EXTRINSIC, FLAG_MOUNT, FLAG_YAW_RESOLVED};
    if s.cal_flags & FLAG_MOUNT != 0 || s.state == ledmapper_sensor::State::Running as u8 {
        w.floats(32, &s.mount_map);
    }
    w.uint(33, (s.cal_flags & FLAG_EXTRINSIC != 0) as u64);
    w.uint(34, (s.cal_flags & FLAG_YAW_RESOLVED != 0) as u64);
    w.uint(35, s.mount_poses as u64);
    w.float(36, s.mount_residual_deg);
    w.uint(37, s.calibrated_at as u64 * 1000);
}

/// get_sensors -> sensor_state, encoded zero-copy into `out`.
pub(crate) unsafe fn handle_get_sensors(out: *mut u8, out_cap: usize) -> i32 {
    let s = snapshot();
    let pins = *addr_of!(PINS);
    write_arm(out, out_cap, ARM_SENSOR_STATE, |w| write_sensor_state(w, &s, pins))
}

/// calibrate_sensors: post the action to the sensor task's mailbox and reply
/// with the current state (calibration_seq advances once it's applied).
pub(crate) unsafe fn handle_calibrate_sensors(frame: &[u8], out: *mut u8, out_cap: usize) -> i32 {
    if let Some(CArm::CalibrateSensors(m)) = client_arm(frame) {
        let a = m.action();
        if (1..=3).contains(&a) {
            PENDING_CAL.store(a as u8, Ordering::Release);
        }
    }
    handle_get_sensors(out, out_cap)
}

/// set_sensor_mount (§7): post R_fi + its quality to the owner of the hub;
/// reply with the state (calibration_seq advances once it is applied).
pub(crate) unsafe fn handle_set_sensor_mount(frame: &[u8], out: *mut u8, out_cap: usize) -> i32 {
    if let Some(CArm::SetSensorMount(m)) = client_arm(frame) {
        let mut q = [0.0f32; 4];
        let mut n = 0;
        for v in m.quat() {
            if n < 4 {
                q[n] = v;
            }
            n += 1;
        }
        let norm2: f32 = q.iter().map(|x| x * x).sum();
        if n == 4 && norm2 > 0.5 && norm2 < 1.5 {
            let secs = (m.calibrated_at_ms() / 1000).min(u32::MAX as u64) as u32;
            *addr_of_mut!(MOUNT_REQ) =
                (q, m.residual_deg(), m.poses().min(255) as u8, m.yaw_resolved(), secs);
            MOUNT_PENDING.store(true, Ordering::Release);
        } else {
            return super::encode_reply(
                &super::fx_error("bad_mount", "set_sensor_mount needs a unit quaternion w,x,y,z"),
                out,
                out_cap,
            );
        }
    }
    handle_get_sensors(out, out_cap)
}

// -- capture profile (§7.5) -------------------------------------------------------

/// The stored CaptureProfile message, encoded (the device doesn't interpret it).
const PROFILE_CAP: usize = 192;
static mut PROFILE: [u8; PROFILE_CAP] = [0; PROFILE_CAP];
static mut PROFILE_LEN: usize = 0;
static PROFILE_GEN: AtomicU32 = AtomicU32::new(0);
/// ServerMessage.capture_profile.
const ARM_CAPTURE_PROFILE: u32 = 30;

pub(crate) unsafe fn handle_set_capture_profile(frame: &[u8], out: *mut u8, out_cap: usize) -> i32 {
    if let Some(CArm::SetCaptureProfile(m)) = client_arm(frame) {
        let p = m.profile().map(|v| v.as_bytes()).unwrap_or(&[]);
        if p.len() > PROFILE_CAP {
            return super::encode_reply(&super::fx_error("too_large", "capture profile too large"), out, out_cap);
        }
        (*addr_of_mut!(PROFILE))[..p.len()].copy_from_slice(p);
        PROFILE_LEN = p.len();
        PROFILE_GEN.fetch_add(1, Ordering::Release);
    }
    handle_get_capture_profile(out, out_cap)
}

pub(crate) unsafe fn handle_get_capture_profile(out: *mut u8, out_cap: usize) -> i32 {
    let n = PROFILE_LEN;
    write_arm(out, out_cap, ARM_CAPTURE_PROFILE, |w| {
        for &b in &(*addr_of!(PROFILE))[..n] {
            w.byte(b);
        }
    })
}

/// Boot: the profile persisted in NVS.
///
/// # Safety
/// `p` valid for `len`.
#[no_mangle]
pub unsafe extern "C" fn lm_capture_profile_seed(p: *const u8, len: usize) {
    if !p.is_null() && len <= PROFILE_CAP {
        core::ptr::copy_nonoverlapping(p, addr_of_mut!(PROFILE) as *mut u8, len);
        PROFILE_LEN = len;
    }
}

/// Generation counter: bumped by set_capture_profile / a map replacement; the
/// firmware persists (or erases) the profile when it changes.
#[no_mangle]
pub extern "C" fn lm_capture_profile_gen() -> u32 {
    PROFILE_GEN.load(Ordering::Acquire)
}

/// Copy the current profile out (for NVS); returns its length (0 = none).
///
/// # Safety
/// `out` valid for `cap`.
#[no_mangle]
pub unsafe extern "C" fn lm_capture_profile_get(out: *mut u8, cap: usize) -> usize {
    let n = PROFILE_LEN;
    if out.is_null() || cap < n {
        return 0;
    }
    core::ptr::copy_nonoverlapping(addr_of!(PROFILE) as *const u8, out, n);
    n
}

/// A NEW LED map was stored (a live upload, not the boot replay): the capture
/// profile belonged to the old map, and the IMU extrinsic's yaw is relative to
/// the old map's frame.
#[no_mangle]
pub unsafe extern "C" fn lm_map_replaced() {
    PROFILE_LEN = 0;
    PROFILE_GEN.fetch_add(1, Ordering::Release);
    MAP_CHANGED.store(true, Ordering::Release);
}
