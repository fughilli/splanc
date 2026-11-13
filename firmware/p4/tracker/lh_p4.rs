//! The lighthouse tracker on the ESP32-P4: lh_device (handshake + report decoding)
//! and lh_kernel (calibration + tracking) behind a small C ABI for tracker.cpp.
//!
//! Single-threaded by contract: every `lh_*` call comes from the tracker task.
//!
//! Latency (photon to photon, see tracker_module.cpp): each report comes with its arrival
//! time on the P4's clock, which maps the tracker's 48 MHz clock onto the P4's
//! (lh_device::clock::HostClock). That gives every pose the P4 time of its light, and the
//! kernel a clock (`lh_clock`, Input::Clock): the kernel streams each sweep's hits into
//! the filter as their report comes in (TimingConfig::stream_sweeps; `lh_set_stream`)
//! instead of waiting for the next cycle's sync. Each pose also carries what the render
//! side needs to predict it forward to when the LEDs light: velocity, angular rate and
//! acceleration (world).
//! The kernel allocates (scene records, per-device queues), so this crate brings a
//! global allocator over the P4's PSRAM (heap_caps, MALLOC_CAP_SPIRAM).
//!
//! Whether the pose is a lock at all (#446) is lh_health's call, on the device clock: the
//! kernel publishes poses only when light comes in, so after fast motion or an occlusion the
//! newest pose can be seconds old while the kernel still says "tracking". `health` in the
//! status is what the player shows (tracker_ok / tracker_state) and sends out.
#![no_std]

extern crate alloc;

use alloc::format;

use alloc::vec::Vec;
use core::alloc::{GlobalAlloc, Layout};
use lh_device::clock::HostClock;
use lh_device::{Decoder, Link, LinkError, Output};
use lh_health::{Health, TrackHealth};
use lh_kernel::kernel::{CalibrationReason, Event, Input, Kernel, KernelConfig};
use lh_kernel::linalg::Mat;
use lh_kernel::math::{Pose, Quat, Vec3};
use lh_protocol::devices::{self, DeviceType};

// ---------------------------------------------------------------- platform

const MALLOC_CAP_8BIT: u32 = 1 << 2;
const MALLOC_CAP_SPIRAM: u32 = 1 << 10;

extern "C" {
    fn heap_caps_aligned_alloc(alignment: usize, size: usize, caps: u32) -> *mut u8;
    fn heap_caps_free(ptr: *mut u8);
    fn abort() -> !;
    // usb_tracker.cpp: HID feature reports on interface 0 (report id first).
    fn p4_tracker_get_feature(report_id: u8, buf: *mut u8, len: usize) -> i32;
    fn p4_tracker_set_feature(data: *const u8, len: usize) -> i32;
    fn p4_delay_ms(ms: u32);
    fn p4_log(msg: *const u8, len: usize);
    // usb_tracker.cpp: esp_timer_get_time() and the CPU cycle counter (profiling).
    fn p4_now_us() -> i64;
    fn p4_cycles() -> u32;
}

struct Psram;

unsafe impl GlobalAlloc for Psram {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        heap_caps_aligned_alloc(layout.align().max(4), layout.size(), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, _layout: Layout) {
        heap_caps_free(ptr)
    }
}

#[global_allocator]
static ALLOC: Psram = Psram;

fn log(s: &str) {
    unsafe { p4_log(s.as_ptr(), s.len()) }
}

#[panic_handler]
fn panic(info: &core::panic::PanicInfo) -> ! {
    log(&format!("lh panic: {}", info));
    unsafe { abort() }
}

struct UsbLink;

impl Link for UsbLink {
    fn get_feature(&mut self, report_id: u8, len: usize) -> Result<Vec<u8>, LinkError> {
        let mut buf = alloc::vec![0u8; len.max(2)];
        let n = unsafe { p4_tracker_get_feature(report_id, buf.as_mut_ptr(), buf.len()) };
        if n < 0 {
            return Err(if n == -2 { LinkError::Gone } else { LinkError::Nak });
        }
        buf.truncate(n as usize);
        Ok(buf)
    }
    fn set_feature(&mut self, data: &[u8]) -> bool {
        unsafe { p4_tracker_set_feature(data.as_ptr(), data.len()) >= 0 }
    }
    fn delay_ms(&mut self, ms: u32) {
        unsafe { p4_delay_ms(ms) }
    }
}

// ---------------------------------------------------------------- state

/// For tracker_service.cpp (mirrored there): the latest pose, what predicting it forward
/// needs, its timeline on the P4's clock, and some counters.
#[repr(C)]
pub struct LhStatus {
    /// 1 once the device config was read and reports are being decoded.
    pub configured: u8,
    /// 1 while the kernel tracks the device.
    pub tracking: u8,
    /// Calibrated base stations.
    pub stations: u8,
    /// 1 once the tracker's clock is mapped onto the P4's (the `*_us` times are valid).
    pub clock_ok: u8,
    /// 1 while the kernel streams sweeps (lh_set_stream).
    pub streaming: u8,
    pub imu: u32,
    pub pulses: u32,
    pub poses: u32,
    /// Sweeps the kernel took, the parts they went out in, and (not streaming) the sweep
    /// pulses that came too late for an early sweep (TimingConfig::sweep_quiet_ticks).
    pub sweeps: u32,
    pub sweep_parts: u32,
    pub late_pulses: u32,
    /// How late light reports have recently come over the fastest delivery (µs): the clock
    /// margin when not streaming.
    pub light_margin_us: u32,
    /// Device time of the latest pose (s), its position (m) and orientation
    /// (w, x, y, z): the tracker's head frame in the world (z up).
    pub t: f64,
    pub pos: [f32; 3],
    pub quat: [f32; 4],
    /// At the pose (world frame): the head's velocity (m/s) and acceleration (m/s², gravity
    /// removed), and the angular rate (rad/s), from the newest IMU sample.
    pub vel: [f32; 3],
    pub accel: [f32; 3],
    pub omega: [f32; 3],
    /// On the P4's clock (µs, esp_timer): the pose's time (the newest IMU sample it was
    /// propagated to), its newest light hit, when the report (or clock tick) that completed
    /// its sweep arrived, and when the kernel was done with it.
    pub pose_us: i64,
    pub light_us: i64,
    pub trigger_us: i64,
    pub ready_us: i64,
    /// The newest pose's position uncertainty (m, sqrt of its covariance trace).
    pub pos_sigma: f32,
    /// Locks gained (fresh pose solves) and lost, and dark stretches dead reckoned, so far.
    pub starts: u32,
    pub losses: u32,
    pub coasts: u32,
    /// lh_health::Health: 0 lost, 1 uncertain, 2 acquiring (a fresh solve settling),
    /// 3 coasting (dead reckoning on the IMU, no light confirming it, still within the σ
    /// limit), 4 locked. 3 and 4 are poses to follow.
    pub health: u8,
    /// 1 if the newest pose is the kernel's speculative dead reckoning.
    pub speculative: u8,
}

/// Where the tracker task's time goes (CPU cycles), per kind of work: 0 decoding reports,
/// 1 IMU samples into the kernel, 2 light pulses / clock ticks that made no pose, 3 those
/// that did (a sweep through the filter). Also how late reports with light came, over the
/// fastest delivery (µs). `lh_profile` returns it and starts over.
#[repr(C)]
#[derive(Clone, Copy, Default)]
pub struct LhProfile {
    pub n: [u32; 4],
    pub cycles: [u64; 4],
    pub max_cycles: [u32; 4],
    pub light_reports: u32,
    pub light_late_sum_us: u64,
    pub light_late_max_us: u32,
}

impl LhProfile {
    fn add(&mut self, kind: usize, cycles: u32) {
        self.n[kind] += 1;
        self.cycles[kind] += cycles as u64;
        self.max_cycles[kind] = self.max_cycles[kind].max(cycles);
    }
}

struct Tracker {
    kernel: Kernel,
    kind: Option<&'static DeviceType>,
    dec: Option<Decoder>,
    events: Vec<Event>,
    outs: Vec<Output>,
    status: LhStatus,
    /// The station poses the kernel's world is built on: its own calibration, or the
    /// ones adopted from lhd (lh_station_prior).
    stations: Vec<(u32, Pose)>,
    /// When lhd last sent each station (P4 µs), adopted or not: a station lhd stops
    /// sending while it sends others is forgotten (it expired there, or lhd solved its
    /// world afresh without it).
    sent_us: Vec<(u32, i64)>,
    /// Stations this kernel levelled again from their gravity (P4 µs): lhd's pose of one
    /// that still has the old tilt is stale for a while (its trackers hear the new OOTX
    /// later) and isn't adopted.
    tilted_us: Vec<(u32, i64)>,
    /// P4 µs of the last forget check (lh_clock).
    forget_check_us: i64,
    clock: HostClock,
    /// The newest IMU sample (body frame: g, rad/s), for the pose's rates.
    accel_g: Vec3,
    gyro: Vec3,
    /// Arrival (P4 µs) of the report or clock tick being pushed into the kernel.
    trigger_us: i64,
    profile: LhProfile,
    health: TrackHealth,
}

static mut TRACKER: Option<Tracker> = None;

fn tracker() -> &'static mut Tracker {
    // Single tracker task (see the module doc).
    #[allow(static_mut_refs)]
    unsafe {
        TRACKER.get_or_insert_with(|| Tracker {
            // A pose bootstrap costs far more than a sweep's worth of time here: at most
            // one every 50 ms while not tracking, or the task falls behind its input.
            kernel: Kernel::new({
                let mut cfg = KernelConfig { start_interval: 0.05, ..KernelConfig::default() };
                // Coast on past the usable limit (Uncertain), up to lh_health's give-up line.
                cfg.lost_sigma_pos = lh_health::COAST_GIVE_UP_M as _;
                // Hits into the filter as their report comes in, not at the next sync.
                cfg.timing.stream_sweeps = true;
                cfg
            }),
            kind: None,
            dec: None,
            events: Vec::new(),
            outs: Vec::new(),
            status: LhStatus {
                configured: 0,
                tracking: 0,
                stations: 0,
                clock_ok: 0,
                streaming: 1,
                imu: 0,
                pulses: 0,
                poses: 0,
                sweeps: 0,
                sweep_parts: 0,
                late_pulses: 0,
                light_margin_us: 0,
                t: 0.0,
                pos: [0.0; 3],
                quat: [1.0, 0.0, 0.0, 0.0],
                vel: [0.0; 3],
                accel: [0.0; 3],
                omega: [0.0; 3],
                pose_us: 0,
                light_us: 0,
                trigger_us: 0,
                ready_us: 0,
                pos_sigma: 0.0,
                starts: 0,
                losses: 0,
                coasts: 0,
                health: Health::Lost as u8,
                speculative: 0,
            },
            stations: Vec::new(),
            sent_us: Vec::new(),
            tilted_us: Vec::new(),
            forget_check_us: 0,
            clock: HostClock::new(),
            accel_g: Vec3::new(0.0, 0.0, 1.0),
            gyro: Vec3::ZERO,
            trigger_us: 0,
            profile: LhProfile::default(),
            health: TrackHealth::default(),
        })
    }
}

impl Tracker {
    fn drain_events(&mut self) {
        for e in self.events.drain(..) {
            match e {
                Event::Pose { time, light, world_from_head, world_from_body, velocity, cov, used, speculative, .. } => {
                    let sigma = lh_kernel::math::sqrt((cov[(0, 0)] + cov[(1, 1)] + cov[(2, 2)]).max(0.0)) as f32;
                    self.health.pose(used, sigma, speculative);
                    let s = &mut self.status;
                    s.pos_sigma = sigma;
                    s.speculative = speculative as u8;
                    s.poses += 1;
                    s.t = time as f64 / 48e6; // i64 ticks: once per pose, so f64 is fine here
                    let p = world_from_head.pos;
                    let q = world_from_head.rot;
                    s.pos = [p.x as f32, p.y as f32, p.z as f32];
                    s.quat = [q.w as f32, q.x as f32, q.y as f32, q.z as f32];
                    // Rates for predicting the head forward: world angular rate and the
                    // body's acceleration from the newest IMU sample (gyro/accel biases are
                    // left out: a few mrad/s and cm/s² move nothing in a frame or two),
                    // carried from the IMU to the head (lever arm r).
                    let rb = world_from_body.rot;
                    let w = rb.rotate(self.gyro);
                    let g = lh_kernel::track::GRAVITY;
                    let a = rb.rotate(self.accel_g.scale(g)).add(Vec3::new(0.0, 0.0, -g));
                    let r = p.sub(world_from_body.pos);
                    let v = velocity.add(w.cross(r));
                    let ah = a.add(w.cross(w.cross(r)));
                    s.vel = [v.x as f32, v.y as f32, v.z as f32];
                    s.accel = [ah.x as f32, ah.y as f32, ah.z as f32];
                    s.omega = [w.x as f32, w.y as f32, w.z as f32];
                    let c = &self.clock;
                    s.pose_us = c.to_host_us(time as u32).unwrap_or(0);
                    s.light_us = c.to_host_us(light as u32).unwrap_or(0);
                    s.trigger_us = self.trigger_us;
                    s.ready_us = unsafe { p4_now_us() };
                    s.clock_ok = (c.mapped() && s.pose_us != 0) as u8;
                }
                Event::Still { .. } => {}
                Event::TrackingStarted { rms, .. } => {
                    self.status.tracking = 1;
                    self.health.started();
                    log(&format!("lh: tracking started (rms {:.0} urad)", rms * 1e6));
                }
                Event::TrackingLost { reason, .. } => {
                    self.status.tracking = 0;
                    self.health.lost();
                    log(&format!("lh: tracking lost ({:?})", reason));
                }
                Event::Calibrated { reason, stations, .. } => {
                    if reason == CalibrationReason::StationTilted {
                        let now = unsafe { p4_now_us() };
                        for s in &stations {
                            let moved = self.stations.iter().find(|(id, _)| *id == s.id).map_or(false, |(_, p)| {
                                rot_angle(p.rot, s.world_from_station.rot) > self.kernel.cfg.station_tilt
                            });
                            if moved {
                                self.tilted_us.retain(|x| x.0 != s.id);
                                self.tilted_us.push((s.id, now));
                            }
                        }
                    }
                    for s in &stations {
                        match self.stations.iter_mut().find(|(id, _)| *id == s.id) {
                            Some(e) => e.1 = s.world_from_station,
                            None => self.stations.push((s.id, s.world_from_station)),
                        }
                    }
                    self.status.stations = self.stations.len() as u8;
                    let mut line = format!("lh: calibrated ({:?}):", reason);
                    for s in &stations {
                        let p = s.world_from_station.pos;
                        line += &format!(" {} at ({:.3}, {:.3}, {:.3}) rms {:.0} urad;", s.id, p.x, p.y, p.z, s.rms * 1e6);
                    }
                    log(&line);
                }
                Event::StationDropped { id, why } => {
                    self.stations.retain(|x| x.0 != id);
                    self.tilted_us.retain(|x| x.0 != id);
                    self.status.stations = self.stations.len() as u8;
                    log(&format!("lh: station {} dropped ({:?})", id, why));
                }
                Event::StationSeen { slot, info, .. } => {
                    log(&format!("lh: station {} in slot {} (mode {})", info.id, slot, info.mode))
                }
                Event::TimingLocked { .. } => log("lh: sweep timing locked"),
                Event::TimingLost { reason, .. } => log(&format!("lh: sweep timing lost ({:?})", reason)),
                Event::StationsDisagree { pos, rot, count, .. } => log(&format!(
                    "lh: stations disagree by {:.3} m / {:.1} deg ({} in a row)",
                    pos,
                    rot.to_degrees(),
                    count
                )),
                other => log(&format!("lh: {:?}", other)),
            }
        }
        self.refresh_health();
    }

    /// The health state (lh_health) into the status, with its transitions on the console.
    fn refresh_health(&mut self) {
        let h = self.health.state();
        let s = &mut self.status;
        if h as u8 != s.health {
            let dark = self.health.dark_ticks().map_or(-1, |t| t / 48_000);
            let sigma_mm = s.pos_sigma * 1e3;
            log(&format!("lh: pose {:?} (was {}; sigma {:.1} mm, {} ms since light)", h, s.health, sigma_mm, dark));
        }
        s.health = h as u8;
        s.starts = self.health.starts;
        s.losses = self.health.losses;
        s.coasts = self.health.coasts;
    }
}

// ---------------------------------------------------------------- C ABI

/// A USB device appeared: 1 if it is a known Vive device (then call lh_handshake).
#[no_mangle]
pub extern "C" fn lh_attach(vid: u16, pid: u16) -> i32 {
    let t = tracker();
    t.kind = devices::lookup(vid, pid);
    t.dec = None;
    t.status.configured = 0;
    match t.kind {
        Some(k) => {
            log(&format!("lh: {} ({:04x}:{:04x})", k.name, vid, pid));
            1
        }
        None => 0,
    }
}

/// Reads the device config and starts its report stream. 0 on success; on
/// failure the reason is logged and the caller retries.
#[no_mangle]
pub extern "C" fn lh_handshake() -> i32 {
    let t = tracker();
    let Some(kind) = t.kind else { return -1 };
    match lh_device::handshake(&mut UsbLink, kind) {
        Ok((config, imu)) => {
            log(&format!(
                "lh: {} {} configured: {} sensors",
                config.model_number,
                config.serial,
                config.model.sensors.len()
            ));
            let dec = Decoder::new(kind, config, imu, 0);
            t.clock = HostClock::new(); // a new device clock
            let added = dec.added();
            t.kernel.push(added, &mut t.events);
            t.dec = Some(dec);
            t.status.configured = 1;
            t.drain_events();
            0
        }
        Err(why) => {
            log(&format!("lh: handshake: {}", why));
            -1
        }
    }
}

/// The device went away.
#[no_mangle]
pub extern "C" fn lh_detach() {
    let t = tracker();
    if let Some(d) = t.dec.take() {
        t.kernel.push(lh_kernel::kernel::Input::DeviceRemoved { dev: d.dev }, &mut t.events);
        t.drain_events();
    }
    t.status.configured = 0;
    t.status.tracking = 0;
    t.health.lost();
    t.refresh_health();
}

impl Tracker {
    /// One input into the kernel, its cost profiled by kind (see LhProfile).
    fn push(&mut self, input: Input) {
        let kind = if matches!(input, Input::Imu { .. }) { 1 } else { 2 };
        let poses = self.status.poses;
        let c0 = unsafe { p4_cycles() };
        self.kernel.push(input, &mut self.events);
        self.drain_events();
        let c = unsafe { p4_cycles() }.wrapping_sub(c0);
        self.profile.add(if kind == 2 && self.status.poses != poses { 3 } else { kind }, c);
    }

    fn timing_counters(&mut self) {
        let Some(dev) = self.dec.as_ref().map(|d| d.dev) else { return };
        if let Some(ts) = self.kernel.timing_stats(dev) {
            self.status.sweeps = ts.sweeps as u32;
            self.status.sweep_parts = ts.sweep_parts as u32;
            self.status.late_pulses = ts.late_sweep_pulses as u32;
        }
        self.status.light_margin_us = self.clock.margin_us().max(0) as u32;
    }
}

/// One input report from HID interface `interface`, which arrived at `us` (esp_timer).
#[no_mangle]
pub unsafe extern "C" fn lh_report(interface: i32, data: *const u8, len: usize, us: i64) {
    let t = tracker();
    let Some(dec) = t.dec.as_mut() else { return };
    let bytes = core::slice::from_raw_parts(data, len);
    t.outs.clear();
    let c0 = p4_cycles();
    dec.report(interface, bytes, &mut t.outs);
    t.profile.add(0, p4_cycles().wrapping_sub(c0));
    // The report's newest device time maps the clocks.
    if let Some((late, true)) = t.clock.observe(&t.outs, us) {
        let p = &mut t.profile;
        p.light_reports += 1;
        p.light_late_sum_us += late.max(0) as u64;
        p.light_late_max_us = p.light_late_max_us.max(late.max(0) as u32);
    }
    t.trigger_us = us;
    let mut outs = core::mem::take(&mut t.outs);
    for o in outs.drain(..) {
        if let Output::Kernel(input) = o {
            match &input {
                Input::Imu { time, accel_g, gyro, .. } => {
                    t.health.clock(*time);
                    t.status.imu += 1;
                    t.accel_g = *accel_g;
                    t.gyro = *gyro;
                }
                Input::Pulse { .. } => t.status.pulses += 1,
                _ => {}
            }
            t.push(input);
        }
    }
    t.outs = outs;
    t.timing_counters();
}

/// The P4's clock is at `us` (esp_timer): tell the kernel which device time that is
/// (Input::Clock), so the hits that came in go into the filter now (streaming), or a sweep
/// whose laser has passed goes out (not streaming: the time less the light margin). The
/// tracker task calls it after every report and between reports.
#[no_mangle]
pub extern "C" fn lh_clock(us: i64) {
    let t = tracker();
    let Some(dev) = t.dec.as_ref().map(|d| d.dev) else { return };
    let raw = if t.status.streaming != 0 { t.clock.now(us) } else { t.clock.passed(us) };
    let Some(raw) = raw else { return };
    if t.status.streaming != 0 {
        t.health.clock(raw); // (not streaming, `raw` lags by the light margin)
    }
    t.trigger_us = us;
    t.push(Input::Clock { dev, time: raw });
    t.timing_counters();
    if us - t.forget_check_us >= 1_000_000 {
        t.forget_check_us = us;
        t.forget_unsent(us);
    }
}

/// lhd re-sends its stations every second. While it does (some station within LHD_ALIVE),
/// one it hasn't sent for FORGET_AFTER is no longer in its world: forget it. lhd gone
/// altogether forgets nothing (the P4 keeps tracking in the last world it had).
const LHD_ALIVE_US: i64 = 3_000_000;
const FORGET_AFTER_US: i64 = 6_000_000;

impl Tracker {
    fn forget_unsent(&mut self, now: i64) {
        if !self.sent_us.iter().any(|x| now - x.1 < LHD_ALIVE_US) {
            return;
        }
        let gone: Vec<u32> = self.sent_us.iter().filter(|x| now - x.1 >= FORGET_AFTER_US).map(|x| x.0).collect();
        for id in gone {
            self.sent_us.retain(|x| x.0 != id);
            log(&format!("lh: lhd no longer sends station {}: forgetting it", id));
            self.push(Input::ForgetStation { id });
        }
        self.tilted_us.retain(|x| now - x.1 < TILT_HOLD_US);
    }
}

/// An lhd pose within this of the one adopted is a refinement of the same world (m, rad):
/// adopted without restarting the track.
const REFINE_POS_M: lh_kernel::Real = 0.10;
const REFINE_ROT_RAD: lh_kernel::Real = 3.0 * core::f32::consts::PI as lh_kernel::Real / 180.0;

/// After levelling a station from its gravity, lhd poses of it that disagree by more than
/// the tilt threshold are ignored for this long.
const TILT_HOLD_US: i64 = 15_000_000;

/// Rotation between two orientations (rad).
fn rot_angle(a: Quat, b: Quat) -> lh_kernel::Real {
    use lh_kernel::math::{atan2, fabs, sqrt};
    let d = a.conj().mul(b);
    2.0 * atan2(sqrt(d.x * d.x + d.y * d.y + d.z * d.z), fabs(d.w))
}

/// Stream sweeps into the filter (1, the default) or send each whole (0: at the next sync,
/// or once its laser has passed on the margin-lagged clock).
#[no_mangle]
pub extern "C" fn lh_set_stream(on: i32) {
    let t = tracker();
    t.kernel.set_stream_sweeps(on != 0);
    t.status.streaming = (on != 0) as u8;
}

/// The profile since the last call (see LhProfile), then starts over.
#[no_mangle]
pub unsafe extern "C" fn lh_profile(out: *mut LhProfile) {
    let t = tracker();
    *out = t.profile;
    t.profile = LhProfile::default();
}

/// Adopt a base station's pose from another tracking host (lhd), so this kernel shares
/// its world: `p` is (x, y, z, qw, qx, qy, qz), world_from_station, metres. A pose within
/// 5 mm / 0.3 deg of what the kernel already has is ignored (lhd re-sends it every second);
/// anything else becomes a station prior and the tracker restarts tracking in the adopted
/// world. Returns 1 if adopted, 0 if unchanged, -1 if not configured.
#[no_mangle]
pub unsafe extern "C" fn lh_station_prior(id: u32, p: *const f32) -> i32 {
    let t = tracker();
    let Some(dev) = t.dec.as_ref().map(|d| d.dev) else { return -1 };
    // lhd owns the world from here: the kernel neither re-solves the stations from its own
    // still scenes (a full calibration on this task stalled tracking ~2 s after every one,
    // i.e. every few seconds while the tracker sat still) nor checks them against each
    // scene (a pose solve, ~0.8 s here; lhd has more trackers and scenes to judge by, and
    // re-sends every second).
    t.kernel.cfg.auto_calibrate = false;
    t.kernel.cfg.check_stations = false;
    let v = core::slice::from_raw_parts(p, 7);
    let pose = Pose {
        pos: Vec3::new(v[0] as _, v[1] as _, v[2] as _),
        rot: Quat::new(v[3] as _, v[4] as _, v[5] as _, v[6] as _).normalized(),
    };
    let now = p4_now_us();
    match t.sent_us.iter_mut().find(|x| x.0 == id) {
        Some(x) => x.1 = now,
        None => t.sent_us.push((id, now)),
    }
    // Levelled here from its new gravity a moment ago: lhd's pose with the old tilt is
    // stale (it adopts the tilt once its own trackers hear the new OOTX).
    if t.tilted_us.iter().any(|x| x.0 == id && now - x.1 < TILT_HOLD_US) {
        if let Some((_, cur)) = t.stations.iter().find(|(sid, _)| *sid == id) {
            if rot_angle(cur.rot, pose.rot) > t.kernel.cfg.station_tilt {
                return 0;
            }
        }
        t.tilted_us.retain(|x| x.0 != id);
    }
    if let Some((_, cur)) = t.stations.iter().find(|(sid, _)| *sid == id) {
        let d = cur.pos.sub(pose.pos);
        let dq = cur.rot.conj().mul(pose.rot);
        // Small-angle: |vector part| ~ half the rotation angle.
        let s2 = dq.x * dq.x + dq.y * dq.y + dq.z * dq.z;
        let half = 0.15 * core::f32::consts::PI / 180.0;
        if (d.x * d.x + d.y * d.y + d.z * d.z) < 0.005 * 0.005 && s2 < (half * half) as _ {
            return 0;
        }
    }
    // Trusted to a few mm / mrad (the kernel floors it there anyway).
    let mut cov = Mat::zeros(6, 6);
    for i in 0..6 {
        cov[(i, i)] = 4e-6;
    }
    // lhd refines its stations as still scenes come in (a centimetre or so each time): the
    // same world, so the tracker keeps its track on the refined pose. Only a station that is
    // new here, or one that moved far (lhd solved a new world), restarts it.
    let refinement = t.stations.iter().find(|(sid, _)| *sid == id).map_or(false, |(_, cur)| {
        cur.pos.sub(pose.pos).norm() < REFINE_POS_M && rot_angle(cur.rot, pose.rot) < REFINE_ROT_RAD
    });
    t.kernel.push(Input::StationPrior { id, world_from_station: pose, cov, cal: None }, &mut t.events);
    match t.stations.iter_mut().find(|(sid, _)| *sid == id) {
        Some(e) => e.1 = pose,
        None => t.stations.push((id, pose)),
    }
    t.status.stations = t.stations.len() as u8;
    if refinement {
        log(&format!("lh: station {} refined by lhd to ({:.3}, {:.3}, {:.3})", id, v[0], v[1], v[2]));
        t.drain_events();
        return 1;
    }
    // The tracker's filter state is in the old world: start it again in the new one.
    t.kernel.push(Input::DeviceRemoved { dev }, &mut t.events);
    if let Some(d) = t.dec.as_ref() {
        t.kernel.push(d.added(), &mut t.events);
    }
    t.status.tracking = 0;
    t.health.lost();
    log(&format!("lh: adopted station {} at ({:.3}, {:.3}, {:.3}) from lhd", id, v[0], v[1], v[2]));
    t.drain_events();
    1
}

#[no_mangle]
pub unsafe extern "C" fn lh_status(out: *mut LhStatus) {
    let t = tracker();
    // The state moves with the clock too (a pose ages into coasting with no new event).
    t.refresh_health();
    let s = &t.status;
    core::ptr::copy_nonoverlapping(s as *const LhStatus, out, 1);
}
