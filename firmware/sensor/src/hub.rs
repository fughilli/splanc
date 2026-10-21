//! The sampling state machine: probe -> reset -> configure -> run, FIFO
//! draining (or direct polling for clones with a dead FIFO), unit scaling,
//! calibration, fusion, gestures, and the published [`Snapshot`].
//!
//! Driven by one caller (the firmware's sensor task) through [`Hub::poll`],
//! which never blocks: it does at most one FIFO drain per call and returns how
//! long to sleep. Bus-agnostic (generic over [`I2cBus`]) and clock-agnostic
//! (the caller passes `now_us`), so the whole thing runs under host tests.

use crate::bus::{BusError, I2cBus};
use crate::calib::{Calibration, FLAG_ACCEL, FLAG_EXTRINSIC, FLAG_GYRO_BIAS, FLAG_MOUNT, FLAG_YAW_RESOLVED};
use crate::fusion::{AttitudeFilter, Mahony, MahonyParams, RestDetector};
use crate::gesture::{GestureParams, Gestures};
use crate::math::{Quat, Vec3, GRAVITY};
use crate::mpu6050::{self as mpu, Config, Family, Found, Raw, Variant, FIFO_SAMPLE_BYTES};

/// Hub lifecycle (also the wire `SensorStatus` numbering, see ledmapper.proto).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum State {
    /// Nothing answered at 0x68/0x69 (the task is never started).
    Absent = 1,
    /// Something ACKed with an unrecognized WHO_AM_I; left alone.
    Unknown = 2,
    /// Reset issued; waiting out the part's ~100 ms reset time.
    Starting = 3,
    Running = 4,
    /// Repeated bus errors (unplugged / bad wiring); re-probing periodically.
    Fault = 5,
}

/// FIFO samples read per I2C transaction (192 bytes on the caller's stack).
pub const CHUNK_SAMPLES: usize = 16;
/// Upper bound on samples processed per `poll` (bounds the CPU burst).
pub const MAX_SAMPLES_PER_POLL: usize = 48;
/// Reset settle time, µs (MPU-6500 RM: 100 ms after DEVICE_RESET).
pub const RESET_US: u64 = 100_000;
/// FIFO drain cadence, ms: 2 samples per drain at 100 Hz, so effects see at
/// most ~20 ms of extra latency while the IMU clock keeps dt exact.
pub const DRAIN_MS: u32 = 20;
/// Consecutive failed transactions before Running -> Fault.
pub const FAULT_AFTER: u8 = 5;
/// Re-probe period in Fault, ms.
pub const REPROBE_MS: u32 = 1000;
/// Empty drains (with time elapsed) before giving up on the FIFO.
pub const FIFO_STALL_LIMIT: u8 = 5;

const DEG2RAD: f32 = core::f32::consts::PI / 180.0;

/// Everything a consumer (effects, protocol, logs) reads. Plain data, `repr(C)`
/// so ffi.rs can seqlock-copy it between the sensor task and readers.
#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(C)]
pub struct Snapshot {
    /// [`State`] as u8 (0 = hub never probed).
    pub state: u8,
    pub addr: u8,
    pub who_am_i: u8,
    /// [`Variant::code`] (0 = none).
    pub variant: u8,
    /// 1 = FIFO batching, 0 = direct polling.
    pub fifo: u8,
    pub at_rest: u8,
    /// A stored calibration record was loaded / committed.
    pub calibrated: u8,
    /// Mean |accel| over the first second was >5% off 1 g (cheap/clone part
    /// scale error, or the wrong range). A 0.7-1.3x error is re-scaled from
    /// the first second at rest; this flag says it happened.
    pub accel_suspect: u8,
    /// Fused samples since start.
    pub samples: u32,
    /// Fixture-frame accel, m/s² (calibrated, gravity included).
    pub accel: [f32; 3],
    /// Fixture-frame angular rate, rad/s, bias-corrected.
    pub gyro: [f32; 3],
    /// Body(fixture)->world, [w, x, y, z].
    pub quat: [f32; 4],
    /// Unit vector pointing DOWN (toward the floor), fixture frame.
    pub gravity: [f32; 3],
    /// Gravity-removed accel in the WORLD frame (z up), m/s².
    pub linear_accel: [f32; 3],
    /// Current gyro bias estimate, rad/s, fixture frame.
    pub gyro_bias: [f32; 3],
    pub temperature_c: f32,
    /// 0..1 shake level.
    pub shake: f32,
    pub tap_count: u32,
    pub shake_count: u32,
    /// Measured fused-sample rate, Hz.
    pub rate_hz: f32,
    pub fifo_overflows: u32,
    pub bus_errors: u32,
    /// CPU cycles per [`Hub::ingest`] (scale+cal+bias+fusion+gestures), mean
    /// and minimum over the last ~1 s window; 0 without a cycle source.
    pub ingest_cycles_mean: u32,
    pub ingest_cycles_min: u32,
    /// The settled "up" (specific-force direction) in the raw IMU body frame —
    /// before the mount — averaged over the current rest streak: one side of
    /// an extrinsic-calibration pose (docs/design/sensor-core.md §7).
    pub rest_up_imu: [f32; 3],
    /// 1-sigma uncertainty of that mean direction, degrees.
    pub rest_up_sigma_deg: f32,
    /// Samples in the current rest streak (0 = moving).
    pub rest_samples: u32,
    /// R_fi: IMU body -> fixture/map frame (+Y up), [w, x, y, z].
    pub mount_map: [f32; 4],
    /// calib FLAG_* bits (MOUNT / EXTRINSIC / YAW_RESOLVED ...).
    pub cal_flags: u8,
    pub mount_poses: u8,
    pub mount_residual_deg: f32,
    pub calibrated_at: u32,
}

impl Default for Snapshot {
    fn default() -> Snapshot {
        Snapshot {
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
            mount_map: MAP_FROM_ZUP.to_array(),
            cal_flags: 0,
            mount_poses: 0,
            mount_residual_deg: 0.0,
            calibrated_at: 0,
        }
    }
}

/// The map frame (+Y up) from the sensor core's z-up fixture frame: -90° about
/// x, i.e. (x, y, z) -> (x, z, -y). `mount = conj(MAP_FROM_ZUP) * R_fi`.
pub const MAP_FROM_ZUP: Quat = Quat { w: core::f32::consts::FRAC_1_SQRT_2, x: -core::f32::consts::FRAC_1_SQRT_2, y: 0.0, z: 0.0 };

/// Calibration actions (the `SensorCalibrate` request).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CalAction {
    /// Commit the learned gyro bias (requires the fixture at rest).
    GyroBias,
    /// "The lamp is upright NOW": rotate the mount so the measured gravity is
    /// fixture -z (zero tilt), keeping yaw arbitrary (minimal rotation).
    Level,
    /// Forget everything (defaults; re-learn at rest).
    Reset,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CalError {
    NotRunning,
    NotAtRest,
}

pub struct Hub<F: AttitudeFilter = Mahony> {
    pub cfg: Config,
    state: State,
    found: Option<Found>,
    fifo: bool,
    t_state_us: u64,
    t_last_us: u64,
    t_temp_us: u64,
    rate_t0_us: u64,
    rate_n0: u32,
    rate_hz: f32,
    dt_nominal: f32,
    accel_lsb: f32,
    gyro_lsb: f32,
    filter: F,
    rest: RestDetector,
    gestures: Gestures,
    cal: Calibration,
    calibrated: bool,
    bias_known: bool,
    rest_samples: u32,
    errors_in_row: u8,
    fifo_stalls: u8,
    accel_norm_sum: f32,
    accel_norm_n: u16,
    accel_suspect: bool,
    /// Scalar accel gain learned from |a| at rest (upstream indoor_localization
    /// measured one MPU-6050 reading 8.4 m/s² at rest: >10% scale error is
    /// common on cheap parts and would gate out every gravity correction).
    accel_gain: f32,
    rest_norm_sum: f32,
    samples: u32,
    fifo_overflows: u32,
    bus_errors: u32,
    accel: Vec3,
    gyro: Vec3,
    temp_c: f32,
    lin_world: Vec3,
    cal_dirty: bool,
    cycle_source: Option<fn() -> u32>,
    rest_up: Vec3,
    rest_dev2: f32,
    rest_n: u32,
    cyc_sum: u32,
    cyc_min: u32,
    cyc_n: u32,
    cyc_mean_pub: u32,
    cyc_min_pub: u32,
}

impl Hub<Mahony> {
    pub fn new(cfg: Config) -> Hub<Mahony> {
        Hub::with_filter(cfg, Mahony::new(MahonyParams::default()))
    }
}

impl<F: AttitudeFilter> Hub<F> {
    pub fn with_filter(cfg: Config, filter: F) -> Hub<F> {
        Hub {
            cfg,
            state: State::Absent,
            found: None,
            fifo: cfg.fifo,
            t_state_us: 0,
            t_last_us: 0,
            t_temp_us: 0,
            rate_t0_us: 0,
            rate_n0: 0,
            rate_hz: 0.0,
            dt_nominal: 1.0 / cfg.actual_odr_hz(),
            accel_lsb: cfg.accel_range.lsb_per_g(),
            gyro_lsb: cfg.gyro_range.lsb_per_dps(),
            filter,
            rest: RestDetector::default(),
            gestures: Gestures::new(GestureParams::default()),
            cal: Calibration::default(),
            calibrated: false,
            bias_known: false,
            rest_samples: 0,
            errors_in_row: 0,
            fifo_stalls: 0,
            accel_norm_sum: 0.0,
            accel_norm_n: 0,
            accel_suspect: false,
            accel_gain: 1.0,
            rest_norm_sum: 0.0,
            samples: 0,
            fifo_overflows: 0,
            bus_errors: 0,
            accel: Vec3::ZERO,
            gyro: Vec3::ZERO,
            temp_c: 0.0,
            lin_world: Vec3::ZERO,
            cal_dirty: false,
            cycle_source: None,
            rest_up: Vec3::ZERO,
            rest_dev2: 0.0,
            rest_n: 0,
            cyc_sum: 0,
            cyc_min: u32::MAX,
            cyc_n: 0,
            cyc_mean_pub: 0,
            cyc_min_pub: 0,
        }
    }

    /// A free-running CPU cycle counter (the C6's esp_cpu_get_cycle_count) to
    /// self-measure the per-sample fusion cost on the device.
    pub fn set_cycle_source(&mut self, f: fn() -> u32) {
        self.cycle_source = Some(f);
    }

    pub fn state(&self) -> State {
        self.state
    }

    pub fn found(&self) -> Option<Found> {
        self.found
    }

    pub fn variant(&self) -> Option<Variant> {
        self.found.and_then(|f| f.variant)
    }

    /// External feed (FUG-107 driver VM backend): another driver owns the bus
    /// and hands raw samples to [`Hub::ingest_external`]; the hub skips its own
    /// probe/FIFO and only runs scaling, calibration, fusion and gestures. The
    /// device is assumed configured like [`Config::default`] (same ranges).
    pub fn start_external(&mut self, addr: u8, who_am_i: u8, now_us: u64) {
        self.found = Some(Found { addr, who_am_i, variant: mpu::identify(who_am_i) });
        self.state = State::Running;
        self.fifo = false;
        self.t_state_us = now_us;
        self.t_last_us = 0;
        self.rate_t0_us = now_us;
        self.rate_n0 = self.samples;
        self.filter.reset();
    }

    /// One externally read sample; dt from the caller's clock (clamped).
    pub fn ingest_external(&mut self, raw: &Raw, now_us: u64) {
        if self.state != State::Running {
            return;
        }
        let dt = if self.t_last_us == 0 {
            self.dt_nominal
        } else {
            (now_us.wrapping_sub(self.t_last_us) as f32 * 1e-6).clamp(0.0, 0.1)
        };
        self.t_last_us = now_us;
        self.ingest(raw, dt);
        self.update_rate(now_us);
    }

    /// Install a stored calibration (call before or after probe).
    pub fn load_calibration(&mut self, cal: Calibration) {
        self.cal = cal;
        self.calibrated = true;
        if cal.flags & FLAG_GYRO_BIAS != 0 {
            self.filter.set_gyro_bias(cal.mount.rotate(cal.gyro_bias));
            self.bias_known = true;
        }
    }

    pub fn calibration(&self) -> Calibration {
        self.cal
    }

    /// True once after a calibration action changed the record (the caller
    /// persists `calibration().encode()` and clears it with this call).
    pub fn take_cal_dirty(&mut self) -> bool {
        core::mem::replace(&mut self.cal_dirty, false)
    }

    /// Probe at boot. On a recognized IMU, issues the reset and moves to
    /// Starting (the caller then starts polling); otherwise the hub stays
    /// Absent/Unknown and costs nothing further. ~0.2 ms of bus time.
    pub fn probe<B: I2cBus>(&mut self, bus: &mut B, now_us: u64) -> State {
        self.found = mpu::probe(bus);
        self.state = match self.found {
            None => State::Absent,
            Some(f) if f.variant.is_none() => State::Unknown,
            Some(f) => {
                if mpu::reset(bus, f.addr).is_ok() {
                    self.t_state_us = now_us;
                    State::Starting
                } else {
                    State::Fault
                }
            }
        };
        self.state
    }

    /// Advance the state machine; returns ms to sleep before the next call.
    pub fn poll<B: I2cBus>(&mut self, bus: &mut B, now_us: u64) -> u32 {
        match self.state {
            State::Absent | State::Unknown => REPROBE_MS * 10,
            State::Fault => {
                if now_us.wrapping_sub(self.t_state_us) >= REPROBE_MS as u64 * 1000 {
                    self.t_state_us = now_us;
                    if let Some(f) = mpu::probe(bus) {
                        if f.variant.is_some() && mpu::reset(bus, f.addr).is_ok() {
                            self.found = Some(f);
                            self.state = State::Starting;
                            return (RESET_US / 1000) as u32;
                        }
                    }
                }
                REPROBE_MS
            }
            State::Starting => {
                let el = now_us.wrapping_sub(self.t_state_us);
                if el < RESET_US {
                    return ((RESET_US - el) / 1000) as u32 + 1;
                }
                self.start(bus, now_us)
            }
            State::Running => {
                let r = if self.fifo { self.drain_fifo(bus, now_us) } else { self.poll_direct(bus, now_us) };
                match r {
                    Ok(()) => {
                        self.errors_in_row = 0;
                    }
                    Err(_) => {
                        self.bus_errors = self.bus_errors.wrapping_add(1);
                        self.errors_in_row = self.errors_in_row.saturating_add(1);
                        if self.errors_in_row >= FAULT_AFTER {
                            self.state = State::Fault;
                            self.t_state_us = now_us;
                            return REPROBE_MS;
                        }
                    }
                }
                self.update_rate(now_us);
                if self.fifo {
                    DRAIN_MS
                } else {
                    ((1000.0 / self.cfg.actual_odr_hz()) as u32).max(1)
                }
            }
        }
    }

    fn start<B: I2cBus>(&mut self, bus: &mut B, now_us: u64) -> u32 {
        let Some(f) = self.found else {
            self.state = State::Absent;
            return REPROBE_MS * 10;
        };
        let Some(v) = f.variant else {
            self.state = State::Unknown;
            return REPROBE_MS * 10;
        };
        let mut cfg = self.cfg;
        cfg.fifo = self.fifo;
        if mpu::configure(bus, f.addr, v, &cfg).is_err() {
            self.bus_errors = self.bus_errors.wrapping_add(1);
            self.state = State::Fault;
            self.t_state_us = now_us;
            return REPROBE_MS;
        }
        self.state = State::Running;
        self.t_state_us = now_us;
        self.t_last_us = now_us;
        self.t_temp_us = now_us;
        self.rate_t0_us = now_us;
        self.rate_n0 = self.samples;
        self.fifo_stalls = 0;
        self.errors_in_row = 0;
        self.filter.reset();
        DRAIN_MS
    }

    fn update_rate(&mut self, now_us: u64) {
        let el = now_us.wrapping_sub(self.rate_t0_us);
        if el >= 1_000_000 {
            let n = self.samples.wrapping_sub(self.rate_n0);
            self.rate_hz = n as f32 * 1e6 / el as f32;
            self.rate_t0_us = now_us;
            self.rate_n0 = self.samples;
        }
    }

    fn drain_fifo<B: I2cBus>(&mut self, bus: &mut B, now_us: u64) -> Result<(), BusError> {
        let addr = self.found.map(|f| f.addr).unwrap_or(mpu::ADDR_AD0_LOW);
        let cap = self.variant().map(|v| v.fifo_bytes()).unwrap_or(512);
        let count = mpu::fifo_count(bus, addr)? as usize;
        // Overflow (6050 overwrites the oldest -> frames misaligned) or a count
        // that isn't whole frames (torn by an overflow): resync.
        if count >= cap as usize || count % FIFO_SAMPLE_BYTES != 0 {
            self.fifo_overflows = self.fifo_overflows.wrapping_add(1);
            mpu::fifo_enable(bus, addr)?;
            self.t_last_us = now_us;
            return Ok(());
        }
        let mut n = count / FIFO_SAMPLE_BYTES;
        if n == 0 {
            // A FIFO that never fills (seen on some clones) -> direct polling.
            let late = now_us.wrapping_sub(self.t_last_us) > (self.dt_nominal * 5e6) as u64 + 50_000;
            if late {
                self.fifo_stalls += 1;
                self.t_last_us = now_us;
                if self.fifo_stalls >= FIFO_STALL_LIMIT {
                    self.fifo = false;
                    mpu::fifo_disable(bus, addr)?;
                }
            }
            return Ok(());
        }
        self.fifo_stalls = 0;
        self.t_last_us = now_us;
        // The FIFO path carries no temperature: sample it once a second.
        if now_us.wrapping_sub(self.t_temp_us) >= 1_000_000 {
            self.t_temp_us = now_us;
            if let (Ok(t), Some(v)) = (mpu::read_temp(bus, addr), self.variant()) {
                self.temp_c = mpu::temp_c(v.family(), t);
            }
        }
        n = n.min(MAX_SAMPLES_PER_POLL);
        let mut buf = [0u8; CHUNK_SAMPLES * FIFO_SAMPLE_BYTES];
        while n > 0 {
            let k = n.min(CHUNK_SAMPLES);
            let b = &mut buf[..k * FIFO_SAMPLE_BYTES];
            mpu::fifo_read(bus, addr, b)?;
            for s in b.chunks_exact(FIFO_SAMPLE_BYTES) {
                let raw = mpu::parse_fifo(s);
                self.ingest(&raw, self.dt_nominal);
            }
            n -= k;
        }
        Ok(())
    }

    fn poll_direct<B: I2cBus>(&mut self, bus: &mut B, now_us: u64) -> Result<(), BusError> {
        let addr = self.found.map(|f| f.addr).unwrap_or(mpu::ADDR_AD0_LOW);
        let raw = mpu::read_burst(bus, addr)?;
        let dt = (now_us.wrapping_sub(self.t_last_us) as f32 * 1e-6).clamp(0.0, 0.1);
        self.t_last_us = now_us;
        self.ingest(&raw, dt);
        Ok(())
    }

    /// One raw sample through scaling, calibration, bias learning, fusion and
    /// gestures. Public so tests (and a future INT-driven path) can feed it.
    pub fn ingest(&mut self, raw: &Raw, dt: f32) {
        let c0 = self.cycle_source.map(|f| f());
        self.ingest_inner(raw, dt);
        if let (Some(c0), Some(f)) = (c0, self.cycle_source) {
            let c = f().wrapping_sub(c0);
            self.cyc_sum = self.cyc_sum.saturating_add(c);
            self.cyc_min = self.cyc_min.min(c);
            self.cyc_n += 1;
            if self.cyc_n >= 100 {
                self.cyc_mean_pub = self.cyc_sum / self.cyc_n;
                self.cyc_min_pub = self.cyc_min;
                self.cyc_sum = 0;
                self.cyc_min = u32::MAX;
                self.cyc_n = 0;
            }
        }
    }

    fn ingest_inner(&mut self, raw: &Raw, dt: f32) {
        let ka = GRAVITY / self.accel_lsb;
        let kg = DEG2RAD / self.gyro_lsb;
        let a_s = Vec3::new(raw.accel[0] as f32 * ka, raw.accel[1] as f32 * ka, raw.accel[2] as f32 * ka);
        let w_s = Vec3::new(raw.gyro[0] as f32 * kg, raw.gyro[1] as f32 * kg, raw.gyro[2] as f32 * kg);
        let (a, w) = if self.cal.flags & FLAG_MOUNT != 0 {
            (self.cal.apply_accel(a_s), self.cal.apply_gyro(w_s))
        } else {
            (a_s.sub(self.cal.accel_offset).mul(self.cal.accel_scale), w_s)
        };
        let a = a.scale(self.accel_gain);
        // Raw-body-frame direction for the extrinsic observation (§7): the
        // corrected accel pulled back through the mount (gain doesn't matter).
        let a_body = if self.cal.flags & FLAG_MOUNT != 0 { self.cal.mount.rotate_inv(a) } else { a };
        if let (Some(t), Some(v)) = (raw.temp, self.variant()) {
            self.temp_c = mpu::temp_c(v.family(), t);
        }
        // Gyro bias at rest: fast EMA until known (1 s of stillness), then slow.
        let bias = self.filter.gyro_bias();
        if self.rest.update(a, w, bias, self.bias_known) {
            let alpha = if self.bias_known { 0.01 } else { 0.05 };
            self.filter.set_gyro_bias(bias.add(w.sub(bias).scale(alpha)));
            self.rest_samples = self.rest_samples.saturating_add(1);
            // First second at rest also fixes a gross accel scale error (the
            // same boot calibration indoor_localization's node runtime does),
            // unless a stored record already carries the accel calibration.
            if self.rest_samples <= 100 && self.cal.flags & FLAG_ACCEL == 0 {
                self.rest_norm_sum += a.norm() / self.accel_gain;
                if self.rest_samples == 100 {
                    let gain = GRAVITY * 100.0 / self.rest_norm_sum;
                    if (0.7..1.3).contains(&gain) {
                        self.accel_gain = gain;
                    }
                }
            }
            if self.rest_samples >= 100 {
                self.bias_known = true;
            }
        }
        // Settled up in the IMU body frame, averaged while at rest.
        if self.rest.at_rest() {
            let n2 = a_body.norm2();
            if n2 > 0.0 {
                let u = a_body.scale(crate::math::inv_sqrt(n2));
                self.rest_n = self.rest_n.saturating_add(1);
                if self.rest_n == 1 {
                    self.rest_up = u;
                    self.rest_dev2 = 0.0;
                } else {
                    // Running mean (exact up to 1000 samples, then a 10 s EMA).
                    let k = 1.0 / (self.rest_n.min(1000) as f32);
                    let d = u.sub(self.rest_up);
                    self.rest_up = self.rest_up.add(d.scale(k));
                    self.rest_dev2 += k * (d.norm2() - self.rest_dev2);
                }
            }
        } else {
            self.rest_n = 0;
        }
        // Sanity: mean |a| over the first 100 samples should be ~1 g (±5%).
        if self.accel_norm_n < 100 {
            self.accel_norm_sum += a.norm() / GRAVITY;
            self.accel_norm_n += 1;
            if self.accel_norm_n == 100 {
                let m = self.accel_norm_sum / 100.0;
                self.accel_suspect = !(0.95..=1.05).contains(&m);
            }
        }
        self.filter.update(a, w, dt);
        let q = self.filter.quat();
        let up_b = q.up_in_body();
        let lin_b = a.sub(up_b.scale(GRAVITY));
        self.lin_world = q.rotate(lin_b);
        self.gestures.update(a, lin_b, dt);
        self.accel = a;
        self.gyro = w.sub(self.filter.gyro_bias());
        self.samples = self.samples.wrapping_add(1);
    }

    /// Install an IMU -> fixture/map extrinsic `r_fi` (the post-mapping
    /// calibration's solve, §7). Tilt AND yaw come from it; the gyro bias is
    /// re-expressed across the mount change.
    pub fn set_extrinsic(&mut self, r_fi: Quat, residual_deg: f32, poses: u8, yaw_resolved: bool, unix_s: u32) {
        let bias_s = self.cal.mount.rotate_inv(self.filter.gyro_bias());
        self.cal.mount = MAP_FROM_ZUP.conj().mul(r_fi).normalized();
        self.cal.flags |= FLAG_MOUNT | FLAG_EXTRINSIC;
        if yaw_resolved {
            self.cal.flags |= FLAG_YAW_RESOLVED;
        } else {
            self.cal.flags &= !FLAG_YAW_RESOLVED;
        }
        self.cal.mount_residual_deg = residual_deg;
        self.cal.mount_poses = poses;
        self.cal.calibrated_at = unix_s;
        self.filter.set_gyro_bias(self.cal.mount.rotate(bias_s));
        self.filter.reset();
        self.rest_n = 0;
        self.calibrated = true;
        self.cal_dirty = true;
    }

    /// The LED map was redone: its gravity-levelled frame keeps the tilt part
    /// of the extrinsic but not the yaw. Mark yaw unresolved.
    pub fn map_changed(&mut self) {
        if self.cal.flags & FLAG_YAW_RESOLVED != 0 {
            self.cal.flags &= !FLAG_YAW_RESOLVED;
            self.cal_dirty = true;
        }
    }

    /// Run a calibration action against the live state.
    pub fn calibrate(&mut self, action: CalAction) -> Result<(), CalError> {
        match action {
            CalAction::Reset => {
                self.cal = Calibration::default();
                self.calibrated = false;
                self.bias_known = false;
                self.rest_samples = 0;
                self.rest_norm_sum = 0.0;
                self.accel_gain = 1.0;
                self.filter.set_gyro_bias(Vec3::ZERO);
                self.filter.reset();
            }
            CalAction::GyroBias => {
                if self.state != State::Running {
                    return Err(CalError::NotRunning);
                }
                if !self.rest.at_rest() || !self.bias_known {
                    return Err(CalError::NotAtRest);
                }
                self.cal.gyro_bias = self.cal.mount.rotate_inv(self.filter.gyro_bias());
                self.cal.flags |= FLAG_GYRO_BIAS;
                // Fold the learned scalar gain into the stored per-axis scale.
                if self.cal.flags & FLAG_ACCEL == 0 && self.accel_gain != 1.0 {
                    self.cal.accel_scale = self.cal.accel_scale.scale(self.accel_gain);
                    self.cal.flags |= FLAG_ACCEL;
                    self.accel_gain = 1.0;
                }
                self.calibrated = true;
            }
            CalAction::Level => {
                if self.state != State::Running {
                    return Err(CalError::NotRunning);
                }
                if !self.rest.at_rest() {
                    return Err(CalError::NotAtRest);
                }
                // Measured up in the SENSOR frame = current fixture-frame up
                // pulled back through the current mount.
                let up_fix = self.accel;
                let up_s = self.cal.mount.rotate_inv(up_fix);
                let n2 = up_s.norm2();
                if n2 <= 0.0 {
                    return Err(CalError::NotAtRest);
                }
                let up_s = up_s.scale(crate::math::inv_sqrt(n2));
                // Re-express the bias (fixture frame) across the mount change.
                let bias_s = self.cal.mount.rotate_inv(self.filter.gyro_bias());
                self.cal.mount = Quat::from_two_unit(up_s, Vec3::UP);
                self.cal.flags |= FLAG_MOUNT;
                // A level is tilt-only: any extrinsic yaw is gone.
                self.cal.flags &= !(FLAG_EXTRINSIC | FLAG_YAW_RESOLVED);
                self.cal.mount_poses = 0;
                self.filter.set_gyro_bias(self.cal.mount.rotate(bias_s));
                self.filter.reset();
                self.calibrated = true;
            }
        }
        self.cal_dirty = true;
        Ok(())
    }

    pub fn snapshot(&self) -> Snapshot {
        let q = self.filter.quat();
        let down = q.up_in_body().scale(-1.0);
        Snapshot {
            state: self.state as u8,
            addr: self.found.map(|f| f.addr).unwrap_or(0),
            who_am_i: self.found.map(|f| f.who_am_i).unwrap_or(0),
            variant: self.variant().map(|v| v.code()).unwrap_or(0),
            fifo: self.fifo as u8,
            at_rest: self.rest.at_rest() as u8,
            calibrated: self.calibrated as u8,
            accel_suspect: self.accel_suspect as u8,
            samples: self.samples,
            accel: self.accel.to_array(),
            gyro: self.gyro.to_array(),
            quat: q.to_array(),
            gravity: down.to_array(),
            linear_accel: self.lin_world.to_array(),
            gyro_bias: self.filter.gyro_bias().to_array(),
            temperature_c: self.temp_c,
            shake: self.gestures.level(),
            tap_count: self.gestures.tap_count,
            shake_count: self.gestures.shake_count,
            rate_hz: self.rate_hz,
            fifo_overflows: self.fifo_overflows,
            bus_errors: self.bus_errors,
            ingest_cycles_mean: self.cyc_mean_pub,
            ingest_cycles_min: self.cyc_min_pub,
            rest_up_imu: self.rest_up.to_array(),
            rest_up_sigma_deg: if self.rest_n > 1 {
                crate::math::sqrt(self.rest_dev2 / self.rest_n.min(1000) as f32) * (180.0 / core::f32::consts::PI)
            } else {
                0.0
            },
            rest_samples: self.rest_n,
            mount_map: MAP_FROM_ZUP.mul(self.cal.mount).normalized().to_array(),
            cal_flags: self.cal.flags,
            mount_poses: self.cal.mount_poses,
            mount_residual_deg: self.cal.mount_residual_deg,
            calibrated_at: self.cal.calibrated_at,
        }
    }

    /// Family of the detected part (for temperature conversion by callers).
    pub fn family(&self) -> Option<Family> {
        self.variant().map(|v| v.family())
    }
}
