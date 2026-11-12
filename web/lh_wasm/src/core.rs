//! The lighthouse pipeline for a browser host: lh_device (handshake + report
//! decoding) and lh_kernel (calibration + tracking), with lhd's per-device
//! bookkeeping (daemon/src/devices.rs) and the P4's pose health
//! (firmware/p4/tracker/lh_health.rs). No wasm-bindgen here: `lib.rs` is the thin
//! binding, and the host tests drive this directly.
//!
//! # The handshake over an asynchronous link
//!
//! `lh_device::handshake` runs over a synchronous [`Link`]; WebHID's feature
//! reports are promises. Rather than re-implement the handshake, each call of
//! [`Session::handshake`] REPLAYS it from the start over the answers the host
//! has supplied so far ([`Session::handshake_answer`]), in order:
//!
//! - a GET with a recorded answer gets it (`Ok` bytes, `Nak`, `Gone`);
//! - the first GET past the log is the "miss": it and every later call fail
//!   with `NotRecorded` (so `handshake` stops there, or, where it ignores an
//!   error, runs on to a result that is thrown away), and the step comes back
//!   [`Step::Pending`] with that GET for the host to perform;
//! - SETs the host has not sent yet (their results are ignored by `handshake`)
//!   are returned with the step, to be sent, in order, before the GET;
//! - `delay_ms` after the last replayed GET adds up to the wait the host makes
//!   before the GET (a NAK retry, a config chunk not ready yet).
//!
//! The handshake is deterministic in its answers, so the replay walks the same
//! path every time and the host sees exactly the request/response sequence a
//! synchronous link would have produced. Cost: O(n²) in the ~70-140 requests
//! of a handshake, microseconds.
//!
//! # Times
//!
//! Report arrival times (`host_us`) are the host's clock in µs (the browser's
//! `performance.now() * 1000`). With `host_clock` on, as `lhd --host-clock`, each
//! device's clock is mapped onto them (lh_device::clock::HostClock), the kernel is
//! told which device time has passed (Input::Clock, every ms between reports), and
//! every pose carries its time on the host clock.

extern crate alloc;

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;
use core::fmt::Write;

use lh_device::clock::HostClock;
use lh_device::{Decoder, Link, LinkError, Output};
use lh_health::{Health, TrackHealth};
use lh_kernel::kernel::{Event, Input, Kernel, KernelConfig};
use lh_kernel::lh1::AxisCal;
use lh_kernel::linalg::Mat;
use lh_kernel::math::{Pose, Quat, Vec3};
use lh_protocol::devices::{self, DeviceType};

/// One recorded answer to a handshake GET.
#[derive(Clone, Debug)]
pub enum Answer {
    Ok(Vec<u8>),
    Nak,
    Gone,
}

/// What the host does next for a device's handshake.
#[derive(Clone, Debug, PartialEq)]
pub enum Step {
    /// Send `sets` (feature reports, report id first) in order, wait `delay_ms`,
    /// then GET feature report `get` (`len` bytes) and hand its answer to
    /// `handshake_answer`, then call `handshake` again.
    Pending { sets: Vec<Vec<u8>>, delay_ms: u32, get: u8, len: usize },
    /// Configured: the device streams (send `sets` first, if any).
    Ready { sets: Vec<Vec<u8>>, serial: String },
    /// Failed (a dongle without its tracker, a device gone): retry later from
    /// scratch (the log is cleared).
    Failed { why: String },
}

/// The control link for one replay of the handshake.
struct ReplayLink<'a> {
    answers: &'a [(u8, Answer)],
    pos: usize,
    missed: Option<(u8, usize)>,
    /// SETs seen this replay, and how many the host already sent.
    sets: usize,
    sets_sent: usize,
    new_sets: Vec<Vec<u8>>,
    delay_ms: u32,
    /// A replayed answer was for a different report id than asked (the log no
    /// longer matches the handshake's path): start over.
    diverged: bool,
}

impl Link for ReplayLink<'_> {
    fn get_feature(&mut self, report_id: u8, len: usize) -> Result<Vec<u8>, LinkError> {
        if self.missed.is_some() {
            return Err(LinkError::NotRecorded);
        }
        match self.answers.get(self.pos) {
            Some((id, a)) => {
                self.pos += 1;
                self.delay_ms = 0;
                if *id != report_id {
                    self.diverged = true;
                    self.missed = Some((report_id, len));
                    return Err(LinkError::NotRecorded);
                }
                match a {
                    Answer::Ok(b) => Ok(b.clone()),
                    Answer::Nak => Err(LinkError::Nak),
                    Answer::Gone => Err(LinkError::Gone),
                }
            }
            None => {
                self.missed = Some((report_id, len));
                Err(LinkError::NotRecorded)
            }
        }
    }

    fn set_feature(&mut self, data: &[u8]) -> bool {
        if self.missed.is_some() {
            return false;
        }
        if self.sets >= self.sets_sent {
            self.new_sets.push(data.to_vec());
        }
        self.sets += 1;
        true
    }

    fn delay_ms(&mut self, ms: u32) {
        if self.missed.is_none() {
            self.delay_ms += ms;
        }
    }
}

struct Dev {
    handle: u32,
    kind: &'static DeviceType,
    answers: Vec<(u8, Answer)>,
    sets_sent: usize,
    dec: Option<Decoder>,
    clock: HostClock,
    clock_us: i64,
    health: TrackHealth,
    last_health: Health,
    last_report_us: i64,
    buttons: Option<u32>,
}

#[derive(Clone, Copy, Debug)]
pub struct Options {
    /// Map each device's clock onto the host's and tick the kernel with it
    /// (`lhd --host-clock`): sweeps go out once the laser has passed, and poses
    /// carry their host time.
    pub host_clock: bool,
    /// With `host_clock`: stream each sweep's hits into the filter as they come
    /// (`lhd --stream-sweeps`, the P4's default).
    pub stream: bool,
}

/// A wireless device whose reports stop for this long has lost its tracker (lhd).
const QUIET_US: i64 = 1_000_000;

pub struct Session {
    pub opts: Options,
    kernel: Kernel,
    devs: Vec<Dev>,
    next_handle: u32,
    next_kernel_id: u32,
    kernel_ids: Vec<(String, u32)>,
    events: Vec<Event>,
    /// JSON objects (one per element) waiting for `drain`.
    out: Vec<String>,
}

fn kernel_config(opts: &Options) -> KernelConfig {
    let mut cfg = KernelConfig::default();
    cfg.timing.stream_sweeps = opts.host_clock && opts.stream;
    cfg
}

fn num(x: f64) -> String {
    if x.is_finite() {
        format!("{}", x)
    } else {
        "null".into()
    }
}

fn arr(xs: &[f64]) -> String {
    let mut s = String::from("[");
    for (i, x) in xs.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str(&num(*x));
    }
    s.push(']');
    s
}

/// A JSON string literal.
pub fn json_str(s: &str) -> String {
    let mut o = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => o.push_str("\\\""),
            '\\' => o.push_str("\\\\"),
            c if (c as u32) < 0x20 => {
                let _ = write!(o, "\\u{:04x}", c as u32);
            }
            c => o.push(c),
        }
    }
    o.push('"');
    o
}

fn pose7(p: &Pose) -> [f64; 7] {
    [p.pos.x, p.pos.y, p.pos.z, p.rot.w, p.rot.x, p.rot.y, p.rot.z]
}

impl Session {
    pub fn new(opts: Options) -> Session {
        Session {
            opts,
            kernel: Kernel::new(kernel_config(&opts)),
            devs: Vec::new(),
            next_handle: 1,
            next_kernel_id: 0,
            kernel_ids: Vec::new(),
            events: Vec::new(),
            out: Vec::new(),
        }
    }

    /// A HID device was opened: its handle, or 0 if it's not a known Vive device.
    pub fn add_device(&mut self, vid: u16, pid: u16) -> u32 {
        let Some(kind) = devices::lookup(vid, pid) else { return 0 };
        let handle = self.next_handle;
        self.next_handle += 1;
        self.devs.push(Dev {
            handle,
            kind,
            answers: Vec::new(),
            sets_sent: 0,
            dec: None,
            clock: HostClock::new(),
            clock_us: 0,
            health: TrackHealth::default(),
            last_health: Health::Lost,
            last_report_us: 0,
            buttons: None,
        });
        self.out.push(format!("{{\"type\":\"usb\",\"handle\":{},\"product\":{},\"state\":\"added\"}}", handle, json_str(kind.name)));
        handle
    }

    fn dev_index(&self, handle: u32) -> Option<usize> {
        self.devs.iter().position(|d| d.handle == handle)
    }

    /// The device was closed or unplugged.
    pub fn remove_device(&mut self, handle: u32) {
        let Some(i) = self.dev_index(handle) else { return };
        let d = self.devs.remove(i);
        if let Some(dec) = d.dec {
            self.kernel.push(Input::DeviceRemoved { dev: dec.dev }, &mut self.events);
            self.out.push(format!(
                "{{\"type\":\"device\",\"handle\":{},\"serial\":{},\"state\":\"removed\"}}",
                handle,
                json_str(&dec.config.serial)
            ));
        }
        self.drain_kernel();
    }

    /// lhd's kernel id per serial: a tracker that drops off the radio and comes back keeps
    /// its id (and the still scenes it collected).
    fn kernel_id(&mut self, serial: &str) -> u32 {
        let in_use = |id: u32, devs: &[Dev]| devs.iter().filter_map(|d| d.dec.as_ref()).any(|x| x.dev == id);
        if !serial.is_empty() {
            if let Some(&(_, id)) = self.kernel_ids.iter().find(|x| x.0 == serial) {
                if !in_use(id, &self.devs) {
                    return id;
                }
            }
        }
        let id = self.next_kernel_id;
        self.next_kernel_id += 1;
        if !serial.is_empty() {
            self.kernel_ids.retain(|x| x.0 != serial);
            self.kernel_ids.push((serial.into(), id));
        }
        id
    }

    /// The answer to the GET of the last [`Step::Pending`].
    pub fn handshake_answer(&mut self, handle: u32, report_id: u8, a: Answer) {
        if let Some(i) = self.dev_index(handle) {
            self.devs[i].answers.push((report_id, a));
        }
    }

    /// One replay of the handshake over the answers so far (see the module doc).
    pub fn handshake(&mut self, handle: u32) -> Step {
        let Some(i) = self.dev_index(handle) else { return Step::Failed { why: "no such device".into() } };
        if self.devs[i].dec.is_some() {
            let serial = self.devs[i].dec.as_ref().map(|d| d.config.serial.clone()).unwrap_or_default();
            return Step::Ready { sets: Vec::new(), serial };
        }
        let kind = self.devs[i].kind;
        let (result, missed, diverged, new_sets, delay_ms, sets) = {
            let d = &self.devs[i];
            let mut link = ReplayLink {
                answers: &d.answers,
                pos: 0,
                missed: None,
                sets: 0,
                sets_sent: d.sets_sent,
                new_sets: Vec::new(),
                delay_ms: 0,
                diverged: false,
            };
            let r = lh_device::handshake(&mut link, kind);
            (r, link.missed, link.diverged, link.new_sets, link.delay_ms, link.sets)
        };
        let d = &mut self.devs[i];
        if diverged {
            d.answers.clear();
            d.sets_sent = 0;
            return Step::Failed { why: "handshake log diverged".into() };
        }
        d.sets_sent = d.sets_sent.max(sets);
        if let Some((get, len)) = missed {
            return Step::Pending { sets: new_sets, delay_ms, get, len };
        }
        match result {
            Ok((config, imu)) => {
                d.answers.clear();
                d.sets_sent = 0;
                let serial = config.serial.clone();
                let id = self.kernel_id(&serial);
                let d = &mut self.devs[i];
                let n_sensors = config.model.sensors.len();
                let model_number = config.model_number.clone();
                let dec = Decoder::new(d.kind, config, imu, id);
                self.kernel.push(dec.added(), &mut self.events);
                d.dec = Some(dec);
                d.clock = HostClock::new();
                d.clock_us = 0;
                d.health = TrackHealth::default();
                d.buttons = None;
                d.last_report_us = 0;
                self.out.push(format!(
                    "{{\"type\":\"device\",\"handle\":{},\"serial\":{},\"model\":{},\"sensors\":{},\"state\":\"connected\"}}",
                    handle,
                    json_str(&serial),
                    json_str(&model_number),
                    n_sensors
                ));
                self.drain_kernel();
                Step::Ready { sets: new_sets, serial }
            }
            Err(why) => {
                d.answers.clear();
                d.sets_sent = 0;
                Step::Failed { why }
            }
        }
    }

    /// One input report (report id first) from HID interface `interface`, which arrived
    /// at `host_us`. lhd's DeviceManager::handle, Report arm.
    pub fn report(&mut self, handle: u32, interface: i32, data: &[u8], host_us: i64) {
        let Some(i) = self.dev_index(handle) else { return };
        let host_clock = self.opts.host_clock;
        let stream = self.opts.host_clock && self.opts.stream;
        let d = &mut self.devs[i];
        d.last_report_us = host_us;
        let Some(dec) = d.dec.as_mut() else { return };
        let passed = |c: &HostClock, us: i64| if stream { c.now(us) } else { c.passed(us) };
        if host_clock && d.clock.mapped() {
            // Tick every millisecond between reports, like the P4.
            while d.clock_us != 0 && host_us - d.clock_us > 1_000 {
                d.clock_us += 1_000;
                if let Some(raw) = passed(&d.clock, d.clock_us) {
                    if stream {
                        d.health.clock(raw);
                    }
                    self.kernel.push(Input::Clock { dev: dec.dev, time: raw }, &mut self.events);
                }
            }
        }
        let mut outs = Vec::new();
        dec.report(interface, data, &mut outs);
        if host_clock {
            d.clock.observe(&outs, host_us);
        }
        for o in outs {
            match o {
                Output::Kernel(input) => {
                    if let Input::Imu { time, .. } = &input {
                        d.health.clock(*time);
                    }
                    self.kernel.push(input, &mut self.events);
                }
                Output::Battery { percent, charging } => self.out.push(format!(
                    "{{\"type\":\"battery\",\"serial\":{},\"percent\":{},\"charging\":{}}}",
                    json_str(&dec.config.serial),
                    percent,
                    charging
                )),
                Output::Buttons(b) => {
                    if d.buttons != Some(b) {
                        d.buttons = Some(b);
                        self.out.push(format!("{{\"type\":\"buttons\",\"serial\":{},\"buttons\":{}}}", json_str(&dec.config.serial), b));
                    }
                }
                Output::TurnedOff => d.last_report_us = i64::MIN / 2,
            }
        }
        if host_clock {
            if let Some(raw) = passed(&d.clock, host_us) {
                if stream {
                    d.health.clock(raw);
                }
                self.kernel.push(Input::Clock { dev: dec.dev, time: raw }, &mut self.events);
            }
            d.clock_us = host_us;
        }
        self.drain_kernel();
    }

    /// Housekeeping at host time `host_us` (call every ~100 ms): a wireless device quiet
    /// for a second has lost its tracker (the host handshakes it again), and pose health
    /// moves with the clock. Returns the handles that need a new handshake.
    pub fn tick(&mut self, host_us: i64) -> Vec<u32> {
        let mut redo = Vec::new();
        for i in 0..self.devs.len() {
            let d = &mut self.devs[i];
            if d.dec.is_some() && d.kind.wireless() && host_us - d.last_report_us > QUIET_US {
                let dec = d.dec.take().unwrap();
                self.kernel.push(Input::DeviceRemoved { dev: dec.dev }, &mut self.events);
                d.health.lost();
                self.out.push(format!(
                    "{{\"type\":\"device\",\"handle\":{},\"serial\":{},\"state\":\"disconnected\"}}",
                    d.handle,
                    json_str(&dec.config.serial)
                ));
                redo.push(d.handle);
            }
        }
        self.drain_kernel();
        redo
    }

    /// A saved station (lhd's calibration.json: pose x y z qw qx qy qz, 36 covariance
    /// numbers, `cal` 10 numbers or empty). Devices already tracking restart in the
    /// adopted world (lh_p4's lh_station_prior).
    pub fn station_prior(&mut self, id: u32, pose: &[f64], cov: &[f64], cal: &[f64]) -> Result<(), String> {
        if pose.len() != 7 || cov.len() != 36 {
            return Err(format!("station {}: pose needs 7 numbers and cov 36", id));
        }
        let cal = if cal.len() == 10 {
            let a = |o: usize| AxisCal { phase: cal[o], tilt: cal[o + 1], curve: cal[o + 2], gibphase: cal[o + 3], gibmag: cal[o + 4] };
            Some([a(0), a(5)])
        } else {
            None
        };
        let world_from_station = Pose {
            pos: Vec3::new(pose[0], pose[1], pose[2]),
            rot: Quat::new(pose[3], pose[4], pose[5], pose[6]).normalized(),
        };
        self.kernel.push(
            Input::StationPrior { id, world_from_station, cov: Mat { rows: 6, cols: 6, d: cov.to_vec() }, cal },
            &mut self.events,
        );
        self.restart_tracks();
        self.drain_kernel();
        Ok(())
    }

    /// Every configured device starts its track again (a new world).
    fn restart_tracks(&mut self) {
        for d in &mut self.devs {
            if let Some(dec) = &d.dec {
                self.kernel.push(Input::DeviceRemoved { dev: dec.dev }, &mut self.events);
                self.kernel.push(dec.added(), &mut self.events);
                d.health.lost();
            }
        }
    }

    /// Solve the station calibration again from the scenes collected (lhd's
    /// {"cmd":"recalibrate"}).
    pub fn recalibrate(&mut self) {
        self.kernel.push(Input::Recalibrate, &mut self.events);
        self.drain_kernel();
    }

    /// Forget the stations and everything learned: a fresh kernel, the configured
    /// devices announced again; the next still scenes calibrate from scratch.
    pub fn reset(&mut self) {
        self.kernel = Kernel::new(kernel_config(&self.opts));
        self.events.clear();
        for d in &mut self.devs {
            if let Some(dec) = &d.dec {
                self.kernel.push(dec.added(), &mut self.events);
            }
            d.health.lost();
        }
        self.drain_kernel();
    }

    /// The JSON events since the last call, as one JSON array.
    pub fn drain(&mut self) -> String {
        let mut s = String::from("[");
        for (i, e) in self.out.drain(..).enumerate() {
            if i > 0 {
                s.push(',');
            }
            s.push_str(&e);
        }
        s.push(']');
        s
    }

    fn serial_of(devs: &[Dev], kid: u32) -> (String, Option<usize>) {
        match devs.iter().position(|d| d.dec.as_ref().map_or(false, |x| x.dev == kid)) {
            Some(i) => (devs[i].dec.as_ref().unwrap().config.serial.clone(), Some(i)),
            None => (String::new(), None),
        }
    }

    /// Kernel events → JSON (lhd's event_json, plus pose health and host times).
    fn drain_kernel(&mut self) {
        let events = core::mem::take(&mut self.events);
        for e in events {
            let line = match &e {
                Event::DeviceAdded { dev } => {
                    let (s, _) = Self::serial_of(&self.devs, *dev);
                    format!("{{\"type\":\"device\",\"serial\":{},\"state\":\"tracking-ready\"}}", json_str(&s))
                }
                Event::DeviceRemoved { .. } => continue,
                Event::TimingLocked { dev } => {
                    format!("{{\"type\":\"timing\",\"serial\":{},\"locked\":true}}", json_str(&Self::serial_of(&self.devs, *dev).0))
                }
                Event::TimingLost { dev, reason } => format!(
                    "{{\"type\":\"timing\",\"serial\":{},\"locked\":false,\"reason\":\"{:?}\"}}",
                    json_str(&Self::serial_of(&self.devs, *dev).0),
                    reason
                ),
                Event::StationSeen { dev, slot, info } => format!(
                    "{{\"type\":\"station\",\"serial\":{},\"slot\":{},\"id\":{},\"mode\":{}}}",
                    json_str(&Self::serial_of(&self.devs, *dev).0),
                    slot,
                    info.id,
                    info.mode
                ),
                Event::Still { dev, still } => {
                    format!("{{\"type\":\"still\",\"serial\":{},\"still\":{}}}", json_str(&Self::serial_of(&self.devs, *dev).0), still)
                }
                Event::Calibrated { reason, stations, scenes, dropped, tracker_up_error, pending } => {
                    let mut st = String::from("[");
                    for (k, s) in stations.iter().enumerate() {
                        if k > 0 {
                            st.push(',');
                        }
                        let c = &s.cal;
                        let cal = [
                            c[0].phase, c[0].tilt, c[0].curve, c[0].gibphase, c[0].gibmag, c[1].phase, c[1].tilt, c[1].curve,
                            c[1].gibphase, c[1].gibmag,
                        ];
                        let mode = s.mode.map_or("null".into(), |m| format!("{}", m));
                        let _ = write!(
                            st,
                            "{{\"id\":{},\"mode\":{},\"pose\":{},\"cov\":{},\"cal\":{},\"rms\":{},\"up_error\":{}}}",
                            s.id,
                            mode,
                            arr(&pose7(&s.world_from_station)),
                            arr(&s.cov.d),
                            arr(&cal),
                            num(s.rms),
                            num(s.up_error)
                        );
                    }
                    st.push(']');
                    let pend: Vec<f64> = pending.iter().map(|p| *p as f64).collect();
                    format!(
                        "{{\"type\":\"calibrated\",\"reason\":\"{:?}\",\"scenes\":{},\"dropped\":{},\"tracker_up_error\":{},\"stations\":{},\"pending\":{}}}",
                        reason,
                        scenes,
                        dropped,
                        num(*tracker_up_error),
                        st,
                        arr(&pend)
                    )
                }
                Event::CalibrationSkipped { reason, why } => {
                    format!("{{\"type\":\"calibration_skipped\",\"reason\":\"{:?}\",\"why\":{}}}", reason, json_str(why))
                }
                Event::StationsDisagree { dev, pos, rot, count } => format!(
                    "{{\"type\":\"stations_disagree\",\"serial\":{},\"pos_m\":{},\"rot_deg\":{},\"count\":{}}}",
                    json_str(&Self::serial_of(&self.devs, *dev).0),
                    num(*pos),
                    num(rot.to_degrees()),
                    count
                ),
                Event::TrackingStarted { dev, rms } => {
                    let (s, i) = Self::serial_of(&self.devs, *dev);
                    if let Some(i) = i {
                        self.devs[i].health.started();
                    }
                    format!("{{\"type\":\"tracking\",\"serial\":{},\"state\":\"started\",\"rms\":{}}}", json_str(&s), num(*rms))
                }
                Event::TrackingLost { dev, reason } => {
                    let (s, i) = Self::serial_of(&self.devs, *dev);
                    if let Some(i) = i {
                        self.devs[i].health.lost();
                    }
                    format!("{{\"type\":\"tracking\",\"serial\":{},\"state\":\"lost\",\"reason\":\"{:?}\"}}", json_str(&s), reason)
                }
                Event::Pose { dev, time, light, world_from_head, velocity, cov, used, gated, speculative, .. } => {
                    let (s, i) = Self::serial_of(&self.devs, *dev);
                    let sigma = lh_kernel::math::sqrt((cov[(0, 0)] + cov[(1, 1)] + cov[(2, 2)]).max(0.0));
                    let (health, host_us, light_us) = match i {
                        Some(i) => {
                            let d = &mut self.devs[i];
                            d.health.pose(*used, sigma as f32, *speculative);
                            let h = d.health.state();
                            (h as u8, d.clock.to_host_us(*time as u32), d.clock.to_host_us(*light as u32))
                        }
                        None => (0, None, None),
                    };
                    let p = pose7(world_from_head);
                    let opt = |x: Option<i64>| x.map_or("null".into(), |v| format!("{}", v));
                    format!(
                        "{{\"type\":\"pose\",\"serial\":{},\"t\":{},\"p\":{},\"q\":{},\"v\":{},\"used\":{},\"gated\":{},\"speculative\":{},\"sigma\":{},\"health\":{},\"host_us\":{},\"light_us\":{}}}",
                        json_str(&s),
                        num(*time as f64 / 48e6),
                        arr(&p[..3]),
                        arr(&p[3..]),
                        arr(&[velocity.x, velocity.y, velocity.z]),
                        used,
                        gated,
                        speculative,
                        num(sigma),
                        health,
                        opt(host_us),
                        opt(light_us)
                    )
                }
            };
            self.out.push(line);
        }
        // Health moves with the clock too (a pose ages into coasting with no new event).
        for d in &mut self.devs {
            let h = d.health.state();
            if h != d.last_health {
                d.last_health = h;
                let serial = d.dec.as_ref().map(|x| x.config.serial.clone()).unwrap_or_default();
                self.out.push(format!(
                    "{{\"type\":\"health\",\"serial\":{},\"state\":{},\"usable\":{}}}",
                    json_str(&serial),
                    h as u8,
                    h.usable()
                ));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use lh_protocol::commands;

    /// A fake dongle answering the handshake: NAKs the first config read, then a
    /// config (zlib JSON), then the version and IMU scales.
    fn config_json() -> Vec<u8> {
        br#"{"device_serial_number":"LHR-TEST","model_number":"Vive Tracker Pro MV","lighthouse_config":{"modelPoints":[[0,0,0],[0.01,0,0],[0,0.01,0],[0,0,0.01]],"modelNormals":[[0,0,1],[0,0,1],[0,0,1],[0,0,1]]},"imu":{"plus_x":[1,0,0],"plus_z":[0,0,1],"position":[0,0,0]},"head":{"plus_x":[1,0,0],"plus_z":[0,0,1],"position":[0,0,0]}}"#.to_vec()
    }

    /// zlib with one stored block (what the device sends is deflated; inflate takes both).
    fn zlib_stored(data: &[u8]) -> Vec<u8> {
        let mut z = vec![0x78, 0x01, 0x01];
        let n = data.len() as u16;
        z.extend_from_slice(&n.to_le_bytes());
        z.extend_from_slice(&(!n).to_le_bytes());
        z.extend_from_slice(data);
        let (mut a, mut b) = (1u32, 0u32);
        for &x in data {
            a = (a + x as u32) % 65521;
            b = (b + a) % 65521;
        }
        z.extend_from_slice(&((b << 16) | a).to_be_bytes());
        z
    }

    fn device_answers() -> (Vec<u8>, Vec<Vec<u8>>) {
        let z = zlib_stored(&config_json());
        let mut start = vec![0x10, 0, 0];
        let n = z.len() - 2;
        start[1] = (n >> 8) as u8;
        start[2] = n as u8;
        let mut chunks = Vec::new();
        for c in z.chunks(40) {
            let mut r = vec![0x11, c.len() as u8];
            r.extend_from_slice(c);
            chunks.push(r);
        }
        chunks.push(vec![0x11, 0]);
        (start, chunks)
    }

    #[test]
    fn handshake_runs_as_request_response_steps() {
        let mut s = Session::new(Options { host_clock: true, stream: true });
        let h = s.add_device(0x28de, 0x2101);
        assert_ne!(h, 0);
        let (start, chunks) = device_answers();
        let mut chunk = chunks.into_iter();
        let mut naks = 1;
        let mut sent: Vec<Vec<u8>> = Vec::new();
        let mut delays = Vec::new();
        let mut steps = 0;
        let serial = loop {
            steps += 1;
            assert!(steps < 100);
            match s.handshake(h) {
                Step::Pending { sets, delay_ms, get, len } => {
                    sent.extend(sets);
                    delays.push(delay_ms);
                    assert_eq!(len, commands::REPORT_LEN);
                    let a = match get {
                        commands::GET_CONFIG_START if naks > 0 => {
                            naks -= 1;
                            Answer::Nak
                        }
                        commands::GET_CONFIG_START => Answer::Ok(start.clone()),
                        commands::GET_CONFIG_CHUNK => Answer::Ok(chunk.next().unwrap()),
                        commands::GET_VERSION => Answer::Ok(vec![0x05, 1, 2, 3]),
                        commands::GET_IMU_SCALES => Answer::Ok(vec![0x01, 1, 1]),
                        other => panic!("unexpected GET {:#x}", other),
                    };
                    s.handshake_answer(h, get, a);
                }
                Step::Ready { sets, serial } => {
                    sent.extend(sets);
                    break serial;
                }
                Step::Failed { why } => panic!("failed: {}", why),
            }
        };
        assert_eq!(serial, "LHR-TEST");
        // The NAK retry waited 20 ms; the startup SETs went out once each, in order.
        assert_eq!(delays[1], 20);
        assert_eq!(sent, commands::startup(lh_protocol::devices::DeviceKind::Dongle));
        let ev = s.drain();
        assert!(ev.contains("\"state\":\"connected\""), "{}", ev);
    }

    #[test]
    fn a_failed_handshake_starts_over() {
        let mut s = Session::new(Options { host_clock: false, stream: false });
        let h = s.add_device(0x28de, 0x2101);
        let mut steps = 0;
        loop {
            steps += 1;
            match s.handshake(h) {
                Step::Pending { get, .. } => s.handshake_answer(h, get, Answer::Nak),
                Step::Failed { why } => {
                    assert!(why.contains("config start"), "{}", why);
                    break;
                }
                Step::Ready { .. } => panic!("ready without a config"),
            }
        }
        assert_eq!(steps, 6); // five NAKed tries, then the failure
        // From scratch: the first GET again, no delay.
        assert_eq!(s.handshake(h), Step::Pending { sets: vec![], delay_ms: 0, get: 0x10, len: 64 });
    }

    #[test]
    fn unknown_devices_get_no_handle() {
        let mut s = Session::new(Options { host_clock: false, stream: false });
        assert_eq!(s.add_device(0x1234, 0x2101), 0);
        assert_eq!(s.add_device(0x28de, 0x9999), 0);
    }
}
