//! #446: after fast motion or an occlusion the tracker must dead reckon honestly, report a
//! lost pose as lost, and lock again promptly once the light is back.
//!
//! A deterministic simulation of the demo setup drives the kernel the P4 runs
//! (lh_kernel_f32, configured as lh_p4.rs configures it, with the stations adopted from lhd)
//! and the health state the player publishes (lh_health): two Lighthouse 1.0 base stations
//! (sync flashes with OOTX, alternating sweeps), a tracker with 24 sensors and a 1 kHz IMU
//! (biased, noisy) consistent with its trajectory, and occlusions per station. Each scenario
//! establishes a lock, moves / occludes as in the recording, then holds the tracker still in
//! clear view, and checks:
//!
//! - dead reckoning: a dark shorter than the covariance allows is coasted through (usable,
//!   within COAST_ERR_M of the truth) and the returning light is fused into the same track
//!   (no fresh solve), Locked within RELOCK_S;
//! - honesty: a longer dark ends in Lost when the position σ passes POS_SIGMA_LIMIT_M
//!   (or, still, at the COAST_MAX_S backstop), never coasting on;
//! - reacquisition: Locked within REACQUIRE_S of being still in clear view after a loss,
//!   from a fresh solve;
//! - no jumps: usable poses within LOCKED_ERR_M (locked) / COAST_ERR_M (coasting) of the
//!   truth, consecutive ones stepping with it (STEP_ERR_M), into and out of coasting.
//!
//! The demo requirement these encode (host time; the P4's bootstrap takes ~0.6 s of CPU per
//! attempt, so on the device add up to ~1 s): a still tracker in clear view is Locked within
//! 0.5 s, whatever happened before. SIMDBG=1 prints every pose and the state log, SIMVEL=1
//! the velocity error per pose.

use lh_health::{Health, TrackHealth, TPS};
use lh_kernel::kernel::{Event, Input, Kernel, KernelConfig};
use lh_kernel::lh1::{SyncCode, CYCLE_TICKS, SLOT_TICKS};
use lh_kernel::linalg::Mat;
use lh_kernel::math::{Pose, Quat, Vec3};
use lh_kernel::model::{faces, predict, StationModel, TrackerModel};
use lh_kernel::solve::look_at;
use lh_kernel::timing::Pulse;
use lh_kernel::Real;

/// Still in clear view -> Locked within this (s).
const REACQUIRE_S: f64 = 0.5;
/// Light back after a coast -> Locked within this (s): fused, no fresh solve.
const RELOCK_S: f64 = 0.05;
/// A Locked pose is within this of the truth (m): the σ limit it's Locked under
/// (POS_SIGMA_LIMIT_M), and within 2σ + 2 mm of its own reported σ (an honest covariance).
const LOCKED_ERR_M: f64 = 0.02;
/// A coasting (dead-reckoned) pose is within this of the truth (m): the 2 cm σ limit
/// (POS_SIGMA_LIMIT_M) the kernel ends coasting at, with margin for σ underestimating.
const COAST_ERR_M: f64 = 0.03;
/// Consecutive Locked poses move by what the tracker moved, within this (m) plus half the
/// pose's σ (a correction of a few mm is what an uncertainty of a cm allows).
const STEP_ERR_M: f64 = 0.005;
/// ... and into, through and out of coasting within this: fusing the light back in
/// corrects what the dead reckoning drifted (COAST_ERR_M bounds that), smoothly.
const COAST_STEP_M: f64 = 0.01;

// ------------------------------------------------------------------ f64 truth

#[derive(Clone, Copy, Debug)]
struct V([f64; 3]);
impl V {
    fn add(self, o: V) -> V {
        V([self.0[0] + o.0[0], self.0[1] + o.0[1], self.0[2] + o.0[2]])
    }
    fn sub(self, o: V) -> V {
        V([self.0[0] - o.0[0], self.0[1] - o.0[1], self.0[2] - o.0[2]])
    }
    fn scale(self, s: f64) -> V {
        V([self.0[0] * s, self.0[1] * s, self.0[2] * s])
    }
    fn norm(self) -> f64 {
        (self.0[0] * self.0[0] + self.0[1] * self.0[1] + self.0[2] * self.0[2]).sqrt()
    }
    fn k(self) -> Vec3 {
        Vec3::new(self.0[0] as Real, self.0[1] as Real, self.0[2] as Real)
    }
}

/// Unit quaternion (w, x, y, z).
#[derive(Clone, Copy, Debug)]
struct Q([f64; 4]);
impl Q {
    fn mul(self, o: Q) -> Q {
        let [w, x, y, z] = self.0;
        let [a, b, c, d] = o.0;
        Q([
            w * a - x * b - y * c - z * d,
            w * b + x * a + y * d - z * c,
            w * c - x * d + y * a + z * b,
            w * d + x * c - y * b + z * a,
        ])
    }
    fn conj(self) -> Q {
        Q([self.0[0], -self.0[1], -self.0[2], -self.0[3]])
    }
    fn exp(r: V) -> Q {
        let th = r.norm();
        if th < 1e-12 {
            return Q([1.0, r.0[0] / 2.0, r.0[1] / 2.0, r.0[2] / 2.0]);
        }
        let s = (th / 2.0).sin() / th;
        Q([(th / 2.0).cos(), r.0[0] * s, r.0[1] * s, r.0[2] * s])
    }
    fn log(self) -> V {
        let q = if self.0[0] < 0.0 { Q([-self.0[0], -self.0[1], -self.0[2], -self.0[3]]) } else { self };
        let s = (q.0[1] * q.0[1] + q.0[2] * q.0[2] + q.0[3] * q.0[3]).sqrt();
        if s < 1e-12 {
            return V([2.0 * q.0[1], 2.0 * q.0[2], 2.0 * q.0[3]]);
        }
        let a = 2.0 * s.atan2(q.0[0]);
        V([q.0[1], q.0[2], q.0[3]]).scale(a / s)
    }
    fn rotate(self, v: V) -> V {
        let p = self.mul(Q([0.0, v.0[0], v.0[1], v.0[2]])).mul(self.conj());
        V([p.0[1], p.0[2], p.0[3]])
    }
    fn k(self) -> Quat {
        Quat::new(self.0[0] as Real, self.0[1] as Real, self.0[2] as Real, self.0[3] as Real)
    }
}

/// A keyframe: at `t` (s) the tracker (body = head) is at `pos`, rotated `rot` from upright.
#[derive(Clone, Copy)]
struct Key {
    t: f64,
    pos: V,
    rot: Q,
}

/// Minimum-jerk motion between keyframes (still at each), still after the last.
struct Path(Vec<Key>);

impl Path {
    fn at(&self, t: f64) -> (V, Q) {
        let k = &self.0;
        if t <= k[0].t {
            return (k[0].pos, k[0].rot);
        }
        for w in k.windows(2) {
            if t < w[1].t {
                let u = (t - w[0].t) / (w[1].t - w[0].t);
                let s = u * u * u * (10.0 - 15.0 * u + 6.0 * u * u);
                let pos = w[0].pos.add(w[1].pos.sub(w[0].pos).scale(s));
                let rot = w[0].rot.mul(Q::exp(w[0].rot.conj().mul(w[1].rot).log().scale(s)));
                return (pos, rot);
            }
        }
        let l = k[k.len() - 1];
        (l.pos, l.rot)
    }

    /// The IMU at `t`: accelerometer (g) and gyro (rad/s), body frame.
    fn imu(&self, t: f64) -> (V, V) {
        let h = 1e-4;
        let (p0, _) = self.at(t - h);
        let (p1, q1) = self.at(t);
        let (p2, q2) = self.at(t + h);
        let a = p2.sub(p1.scale(2.0)).add(p0).scale(1.0 / (h * h));
        let f = q1.conj().rotate(a.add(V([0.0, 0.0, 9.80665]))).scale(1.0 / 9.80665);
        let w = q1.conj().mul(q2).log().scale(1.0 / h);
        (f, w)
    }

    fn last_move(&self) -> f64 {
        self.0[self.0.len() - 1].t
    }
}

// ------------------------------------------------------------------ the rig

struct Station {
    id: u32,
    model: StationModel,
    ootx: Vec<bool>,
}

/// One OOTX packet from station `id` (zero factory calibration), the bits per cycle.
fn ootx_frame(id: u32, mode: u8) -> Vec<bool> {
    let mut payload = [0u8; 33];
    payload[2..6].copy_from_slice(&id.to_le_bytes());
    payload[21] = 127; // gravity along station +y
    payload[31] = mode;
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(payload.len() as u16).to_le_bytes());
    bytes.extend_from_slice(&payload);
    bytes.push(0);
    bytes.extend_from_slice(&lh_kernel::ootx::crc32(&payload).to_le_bytes());
    let mut bits = vec![false; 17];
    bits.push(true);
    for w in bytes.chunks(2) {
        let word = ((w[0] as u16) << 8) | w[1] as u16;
        for i in (0..16).rev() {
            bits.push(word >> i & 1 != 0);
        }
        bits.push(true);
    }
    bits
}

fn tracker_model() -> TrackerModel {
    // A Vive-tracker-ish dome: three rings of 8 sensors, normals out and up.
    let mut sensors = Vec::new();
    let mut normals = Vec::new();
    for ring in 0..3 {
        let (r, z, tilt) = [(0.045, 0.0, 0.2), (0.035, 0.015, 0.7), (0.02, 0.025, 1.5)][ring];
        for i in 0..8 {
            let a = (i as f64 + 0.5 * ring as f64) * std::f64::consts::PI / 4.0;
            sensors.push(Vec3::new((r * a.cos()) as Real, (r * a.sin()) as Real, z as Real));
            normals.push(Vec3::new(a.cos() as Real, a.sin() as Real, tilt as Real).normalized());
        }
    }
    TrackerModel { sensors, normals, body_from_head: Pose::IDENTITY }
}

/// Which stations each second is blocked from the tracker (hand/body): (from, to, station
/// ids) in seconds.
type Occlusion = (f64, f64, &'static [u32]);

struct Sim {
    stations: Vec<Station>,
    model: TrackerModel,
    path: Path,
    occl: Vec<Occlusion>,
    kernel: Kernel,
    health: TrackHealth,
    base: u32,
    /// Per published pose: (time s, health then, estimate, truth).
    poses: Vec<(f64, Health, V, V)>,
    /// Per published pose, its position σ (sqrt of the covariance trace, m).
    sigmas: Vec<f64>,
    /// Health sampled every ms: (time s, state).
    states: Vec<(f64, Health)>,
    /// (time s, event).
    events: Vec<(f64, String)>,
    /// Deterministic noise (an LCG): IMU white noise and per-hit timing jitter.
    rng: u64,
    /// The accelerometer's bias (g, body frame); the gyro's is fixed (5 mrad/s).
    accel_bias: V,
}

const A: u32 = 0x1111_2222;
const B: u32 = 0x3333_4444;

impl Sim {
    fn new(path: Path, occl: Vec<Occlusion>) -> Sim {
        Sim::with_cfg(path, occl, p4_config())
    }

    fn with_cfg(path: Path, occl: Vec<Occlusion>, cfg: KernelConfig) -> Sim {
        let target = Vec3::new(0.0, 0.0, 1.0);
        let st = |id: u32, pos: Vec3, mode: u8| Station {
            id,
            model: StationModel { cal: Default::default(), world_from_station: look_at(pos, target) },
            ootx: ootx_frame(id, mode),
        };
        let mut s = Sim {
            stations: vec![st(A, Vec3::new(2.0, -1.0, 2.2), 1), st(B, Vec3::new(-1.5, 2.0, 2.0), 2)],
            model: tracker_model(),
            path,
            occl,
            kernel: Kernel::new(cfg),
            health: TrackHealth::default(),
            base: 4_000_000_000, // the device clock wraps ~6 s in
            poses: Vec::new(),
            sigmas: Vec::new(),
            states: Vec::new(),
            events: Vec::new(),
            rng: 0x2545_f491_4f6c_dd1d,
            accel_bias: V([0.02, -0.01, 0.015]),
        };
        let mut out = Vec::new();
        for i in 0..s.stations.len() {
            let mut cov = Mat::zeros(6, 6);
            for k in 0..6 {
                cov[(k, k)] = 4e-6;
            }
            let p = s.stations[i].model.world_from_station;
            s.kernel
                .push(Input::StationPrior { id: s.stations[i].id, world_from_station: p, cov, cal: None }, &mut out);
        }
        s.kernel.push(Input::DeviceAdded { dev: 1, model: s.model.clone(), wireless: false }, &mut out);
        s
    }

    /// Roughly N(0, 1), deterministic.
    fn gauss(&mut self) -> f64 {
        let mut sum = 0.0;
        for _ in 0..4 {
            self.rng = self.rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            sum += (self.rng >> 11) as f64 / (1u64 << 53) as f64;
        }
        (sum - 2.0) * 3f64.sqrt()
    }

    fn noise(&mut self, sigma: f64) -> V {
        V([self.gauss() * sigma, self.gauss() * sigma, self.gauss() * sigma])
    }

    fn visible(&self, id: u32, t: f64) -> bool {
        !self.occl.iter().any(|(a, b, ids)| t >= *a && t < *b && ids.contains(&id))
    }

    fn raw(&self, t: f64) -> u32 {
        self.base.wrapping_add((t * TPS as f64).round() as i64 as u32)
    }

    fn truth(&self, t: f64) -> Pose {
        let (p, q) = self.path.at(t);
        Pose { pos: p.k(), rot: q.k() }
    }

    /// Sensors of the tracker station `si` lights at `t` (facing it, not blocked).
    fn lit(&self, si: usize, t: f64) -> Vec<usize> {
        let st = &self.stations[si];
        if !self.visible(st.id, t) {
            return Vec::new();
        }
        let pose = self.truth(t);
        (0..self.model.sensors.len())
            .filter(|&k| faces(&pose, self.model.sensors[k], self.model.normals[k], &st.model))
            .collect()
    }

    fn push(&mut self, t: f64, input: Input) {
        let mut out = Vec::new();
        self.kernel.push(input, &mut out);
        for e in out {
            match &e {
                Event::TrackingStarted { .. } => self.health.started(),
                Event::TrackingLost { .. } => self.health.lost(),
                Event::Pose { world_from_head, cov, used, speculative, velocity, .. } => {
                    if std::env::var("SIMVEL").is_ok() {
                        let (a, _) = self.path.at(t - 1e-3);
                        let (b, _) = self.path.at(t + 1e-3);
                        let tv = b.sub(a).scale(500.0);
                        let ev = V([velocity.x as f64, velocity.y as f64, velocity.z as f64]);
                        eprintln!("vel t={t:.3} err={:.1}mm/s spec={speculative}", ev.sub(tv).norm() * 1e3);
                    }
                    let sigma = (cov[(0, 0)] + cov[(1, 1)] + cov[(2, 2)]).max(0.0).sqrt() as f32;
                    self.health.pose(*used, sigma, *speculative);
                    let p = world_from_head.pos;
                    let est = V([p.x as f64, p.y as f64, p.z as f64]);
                    let (truth, _) = self.path.at(t);
                    self.poses.push((t, self.health.state(), est, truth));
                    self.sigmas.push(sigma as f64);
                    if std::env::var("SIMDBG").is_ok() {
                        eprintln!(
                            "pose t={t:.3} {:?} sigma={:.1}mm err={:.1}mm used={used} spec={speculative}",
                            self.health.state(),
                            sigma * 1e3,
                            est.sub(truth).norm() * 1e3
                        );
                    }
                }
                _ => {}
            }
            match e {
                Event::Pose { .. } | Event::Still { .. } => {}
                other => self.events.push((t, format!("{:?}", other))),
            }
        }
    }

    /// Runs `secs` of device time: per 8.33 ms cycle, slot 0 (A) and slot 1 (B) syncs, the
    /// sweep of whichever doesn't skip, and IMU samples + host clock ticks every ms.
    fn run(&mut self, secs: f64) {
        let cycles = (secs * TPS as f64 / CYCLE_TICKS as f64) as u64;
        let seq = [[4u8, 5, 0, 1], [0u8, 1, 4, 5]];
        let mut next_imu = 0.0f64;
        for k in 0..cycles {
            let t0 = k as f64 * CYCLE_TICKS as f64 / TPS as f64;
            let t_end = (k + 1) as f64 * CYCLE_TICKS as f64 / TPS as f64;
            // (time s, pulse) for this cycle.
            let mut pulses: Vec<(f64, Pulse)> = Vec::new();
            let mut sweeper = None;
            for slot in 0..2usize {
                let st = &self.stations[slot];
                let bit = st.ootx[(k as usize) % st.ootx.len()];
                let code = SyncCode::from_bits(seq[slot][(k % 4) as usize] | (bit as u8) << 1);
                let ts = t0 + (slot as u32 * SLOT_TICKS) as f64 / TPS as f64;
                for (n, s) in self.lit(slot, ts).into_iter().enumerate() {
                    let start = self.raw(ts).wrapping_add(n as u32 * 3);
                    pulses.push((ts, Pulse { sensor: s as u8, start, len: code.nominal_ticks() + 40 }));
                }
                if !code.skip {
                    sweeper = Some((slot, ts, code.axis));
                }
            }
            if let Some((slot, ts, axis)) = sweeper {
                let station = self.stations[slot].model.clone();
                // The rotor crosses the tracker about a quarter turn after the sync.
                let t_hit = ts + 0.25 / 60.0;
                for s in self.lit(slot, t_hit) {
                    // The angle at the hit's own time (the tracker moves during the sweep).
                    let mut th = t_hit;
                    for _ in 0..3 {
                        let ang = predict(&station, &self.truth(th), self.model.sensors[s], axis).angle as f64;
                        th = ts
                            + (ang + std::f64::consts::FRAC_PI_2) / std::f64::consts::PI * CYCLE_TICKS as f64
                                / TPS as f64;
                    }
                    // ~0.1 mrad of jitter per hit (13 ticks at the sweep's rate).
                    let center = self.raw(th).wrapping_add((self.gauss() * 13.0).round() as i32 as u32);
                    pulses.push((th, Pulse { sensor: s as u8, start: center.wrapping_sub(400), len: 800 }));
                }
            }
            pulses.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap());
            // Interleave with the IMU (1 kHz) and the host clock, in time order.
            let mut pi = 0;
            while next_imu < t_end {
                while pi < pulses.len() && pulses[pi].0 <= next_imu {
                    let (tp, p) = pulses[pi];
                    self.push(tp, Input::Pulse { dev: 1, pulse: p });
                    pi += 1;
                }
                // A real IMU: biases (0.02 g, 5 mrad/s) and white noise per sample (2 mg: under the
                // kernel's still detector's 4 mg spread, as on the recorded sessions).
                let (f, w) = self.path.imu(next_imu);
                let f = f.add(self.accel_bias).add(self.noise(0.002));
                let w = w.add(V([0.005, -0.003, 0.004])).add(self.noise(0.003));
                let raw = self.raw(next_imu);
                self.health.clock(raw);
                self.push(next_imu, Input::Imu { dev: 1, time: raw, accel_g: f.k(), gyro: w.k() });
                self.push(next_imu, Input::Clock { dev: 1, time: raw });
                self.states.push((next_imu, self.health.state()));
                next_imu += 1e-3;
            }
            for &(tp, p) in &pulses[pi..] {
                self.push(tp, Input::Pulse { dev: 1, pulse: p });
            }
        }
    }

    /// First time at or after `from` the state is `want`.
    fn first(&self, from: f64, want: Health) -> Option<f64> {
        self.states.iter().find(|(t, h)| *t >= from && *h == want).map(|x| x.0)
    }

    /// Checks every usable pose (Locked or Coasting) published after `from`: Locked ones
    /// within LOCKED_ERR_M of the truth, coasting ones within COAST_ERR_M, and steps
    /// (including into and out of coasting) that follow the truth's.
    fn assert_no_jumps(&self, from: f64) {
        let mut prev: Option<(V, V, Health)> = None;
        let mut n = 0;
        for (i, &(t, h, est, truth)) in self.poses.iter().enumerate() {
            if t < from {
                continue;
            }
            if !h.usable() {
                prev = None;
                continue;
            }
            let err = est.sub(truth).norm();
            let sigma = self.sigmas[i];
            if h == Health::Locked {
                assert!(
                    err < LOCKED_ERR_M && err < 2.0 * sigma + 0.002,
                    "Locked pose {:.1} mm off the truth (σ {:.1} mm) at t={:.3} s\n{}",
                    err * 1e3,
                    sigma * 1e3,
                    t,
                    self.log()
                );
            } else {
                assert!(err < COAST_ERR_M, "{h:?} pose {:.1} mm off the truth at t={:.3} s\n{}", err * 1e3, t, self.log());
            }
            if let Some((pe, pt, ph)) = prev {
                let step = est.sub(pe).sub(truth.sub(pt)).norm();
                // A correction may move a pose by part of its stated uncertainty.
                let base = if h == Health::Locked && ph == Health::Locked { STEP_ERR_M } else { COAST_STEP_M };
                let bound = base + 0.5 * sigma;
                assert!(step < bound, "{h:?} pose jumped {:.1} mm at t={:.3} s\n{}", step * 1e3, t, self.log());
            }
            prev = Some((est, truth, h));
            n += 1;
        }
        assert!(n > 10, "too few usable poses after {from} s ({n})\n{}", self.log());
    }

    /// Fresh solves (TrackingStarted) at or after `from`.
    fn starts(&self, from: f64) -> usize {
        self.events.iter().filter(|(t, e)| *t >= from && e.starts_with("TrackingStarted")).count()
    }

    /// The first TrackingLost at or after `from`: (time, reason as printed).
    fn loss(&self, from: f64) -> Option<(f64, String)> {
        self.events.iter().find(|(t, e)| *t >= from && e.starts_with("TrackingLost")).map(|(t, e)| (*t, e.clone()))
    }

    /// The largest error of a pose published in [from, to), and its state.
    fn max_err(&self, from: f64, to: f64) -> f64 {
        self.poses.iter().filter(|p| p.0 >= from && p.0 < to).map(|p| p.2.sub(p.3).norm()).fold(0.0, f64::max)
    }

    /// The largest error of a usable pose (Locked or Coasting) published in [from, to).
    fn max_usable_err(&self, from: f64, to: f64) -> f64 {
        self.poses.iter().filter(|p| p.0 >= from && p.0 < to && p.1.usable()).map(|p| p.2.sub(p.3).norm()).fold(0.0, f64::max)
    }

    /// From the first Uncertain or Lost state at or after `from`, until `to`, nothing usable.
    fn unusable_once_past_the_limit(&self, from: f64, to: f64) -> bool {
        let Some(&(start, _)) = self.states.iter().find(|x| x.0 >= from && !x.1.usable() && x.1 != Health::Acquiring) else {
            return false;
        };
        self.states.iter().filter(|x| x.0 >= start && x.0 < to).all(|x| !x.1.usable())
    }

    fn log(&self) -> String {
        let mut s = String::new();
        let mut last = None;
        for (t, h) in &self.states {
            if last != Some(*h) {
                s += &format!("  {t:7.3} s  {h:?}\n");
                last = Some(*h);
            }
        }
        for (t, e) in &self.events {
            s += &format!("  {t:7.3} s  {e}\n");
        }
        s
    }
}

/// The kernel as lh_p4.rs configures it, with lhd's stations adopted (lh_station_prior).
fn p4_config() -> KernelConfig {
    let mut cfg = KernelConfig { start_interval: 0.05, ..KernelConfig::default() };
    cfg.timing.stream_sweeps = true;
    cfg.auto_calibrate = false;
    cfg.check_stations = false;
    cfg.lost_sigma_pos = lh_health::COAST_GIVE_UP_M as Real;
    cfg
}

fn key(t: f64, pos: [f64; 3], rotvec: [f64; 3]) -> Key {
    Key { t, pos: V(pos), rot: Q::exp(V(rotvec)) }
}

/// Seconds until the stations are known (OOTX: ~3 s a packet) and the tracker locked.
const SETTLE: f64 = 8.0;

fn locked_by_settle(sim: &Sim) {
    let t = sim.first(0.0, Health::Locked).unwrap_or_else(|| panic!("never locked\n{}", sim.log()));
    assert!(t < SETTLE, "first lock at {t:.2} s\n{}", sim.log());
    assert_eq!(sim.states.iter().rev().find(|x| x.0 < SETTLE).unwrap().1, Health::Locked, "{}", sim.log());
}

/// Time until Locked from `from`, asserted within REACQUIRE_S.
fn reacquired(sim: &Sim, from: f64) -> f64 {
    let t =
        sim.first(from, Health::Locked).unwrap_or_else(|| panic!("never Locked again after {from} s\n{}", sim.log()));
    let dt = t - from;
    eprintln!("reacquired {dt:.3} s after {from:.3} s");
    if std::env::var("SIMDBG").is_ok() {
        eprintln!("{}", sim.log());
    }
    assert!(dt <= REACQUIRE_S, "Locked {dt:.3} s after {from} s (still, clear view)\n{}", sim.log());
    // And it stays Locked while still in clear view.
    assert!(
        sim.states.iter().filter(|x| x.0 > t + 0.1).all(|x| x.1 == Health::Locked),
        "lock dropped again after reacquiring at {t:.3} s\n{}",
        sim.log()
    );
    dt
}

/// A steady carry through the demo space: 0.6 m and 1 rad over 2.4 s (peaks ~0.5 m/s).
fn carry(t0: f64) -> Path {
    Path(vec![key(t0, [0.2, 0.3, 1.0], [0.0, 0.0, 0.3]), key(t0 + 2.4, [-0.3, -0.1, 1.2], [0.3, -0.2, 1.3])])
}

#[test]
fn still_in_clear_view_locks_and_stays_locked() {
    let mut sim = Sim::new(Path(vec![key(0.0, [0.1, 0.2, 1.0], [0.0, 0.0, 0.3])]), vec![]);
    sim.run(12.0);
    locked_by_settle(&sim);
    sim.assert_no_jumps(SETTLE);
}

/// A brisk swing (0.5 m, 1.5 rad in 0.4 s: peaks ~2.3 m/s, ~7 rad/s) through the virtual
/// plane, then put down still.
#[test]
fn fast_swing_then_still_relocks() {
    let p0 = [0.1, 0.2, 1.0];
    let p1 = [-0.3, -0.1, 1.2];
    let path = Path(vec![
        key(SETTLE + 1.0, p0, [0.0, 0.0, 0.3]),
        key(SETTLE + 1.4, p1, [0.4, -0.3, 1.6]),
        key(SETTLE + 1.8, p0, [0.0, 0.0, 0.3]),
    ]);
    let end = path.last_move();
    let mut sim = Sim::new(path, vec![]);
    sim.run(end + 3.0);
    locked_by_settle(&sim);
    // Honest during the swing: whatever the kernel did, a Locked pose is a good one.
    sim.assert_no_jumps(SETTLE);
    reacquired(&sim, end);
}

/// The recorded loss: a fast swing (tipped ~150 deg, ~2 m/s) that takes the tracker behind
/// the presenter's body, out of both stations' view for 1.2 s (past the sweep-timing lock's
/// 1 s), then puts it down in clear view.
#[test]
fn swing_behind_the_body_then_put_down_relocks() {
    let p0 = [0.1, 0.2, 1.0];
    let path = Path(vec![
        key(SETTLE + 1.0, p0, [0.0, 0.0, 0.3]),
        key(SETTLE + 1.4, [-0.3, 0.3, 1.3], [2.6, 0.0, 0.3]),
        key(SETTLE + 2.4, [-0.1, 0.4, 1.4], [2.4, 0.6, 0.3]),
        key(SETTLE + 2.8, [0.2, -0.1, 0.9], [0.0, 0.1, -0.4]),
    ]);
    let end = path.last_move();
    let mut sim = Sim::new(path, vec![(SETTLE + 1.2, SETTLE + 2.4, &[A, B])]);
    sim.run(end + 3.0);
    locked_by_settle(&sim);
    let lost =
        sim.first(SETTLE + 1.2, Health::Lost).unwrap_or_else(|| panic!("never Lost behind the body\n{}", sim.log()));
    assert!(lost < SETTLE + 1.2 + 0.7, "{}", sim.log());
    sim.assert_no_jumps(SETTLE);
    reacquired(&sim, end);
}

/// One station blocked by a hand for 1.5 s while the tracker is carried 20 cm: the other
/// alone gives the full pose (the constellation's known geometry gives the range), so it
/// stays Locked, with an honest σ, and the return of the first is no jump.
#[test]
fn one_station_occluded_keeps_tracking() {
    let path = Path(vec![
        key(SETTLE + 1.0, [0.1, 0.2, 1.0], [0.0, 0.0, 0.3]),
        key(SETTLE + 2.5, [0.25, 0.05, 1.05], [0.0, 0.1, 0.6]),
    ]);
    let mut sim = Sim::new(path, vec![(SETTLE + 0.8, SETTLE + 2.3, &[B])]);
    sim.run(SETTLE + 5.0);
    locked_by_settle(&sim);
    sim.assert_no_jumps(SETTLE);
    let w: Vec<_> = sim.states.iter().filter(|x| x.0 > SETTLE && x.0 < SETTLE + 2.3).collect();
    assert!(w.iter().all(|x| x.1 >= Health::Uncertain), "lost with one station in view\n{}", sim.log());
    let locked = w.iter().filter(|x| x.1 == Health::Locked).count() as f64 / w.len() as f64;
    eprintln!("one station, carried at ~2.9 m: Locked {:.0}% of the time", locked * 100.0);
    // Still and slow it's Locked; at ~2.9 m and moving, σ (honest: above the error) peaks
    // past the 2 cm limit for part of the carry.
    assert!(locked > 0.5, "Locked only {:.0}% with one station\n{}", locked * 100.0, sim.log());
    assert_eq!(sim.starts(SETTLE), 0, "{}", sim.log());
    reacquired(&sim, SETTLE + 2.5);
}

/// Asserts dead reckoning through a dark that ends before the covariance limit: usable
/// (Coasting) from shortly into it to the end, never Lost, no fresh solve, and Locked again
/// within RELOCK_S of the light by fusing it into the same track. Returns the largest error
/// of a coasting pose.
fn coasted_through(sim: &Sim, dark: (f64, f64)) -> f64 {
    let from = dark.0 + 0.11; // the kernel's coast_after + lh_health's FRESH_S
    assert!(
        sim.states.iter().filter(|x| x.0 > from && x.0 < dark.1).all(|x| x.1 == Health::Coasting),
        "not Coasting through a {:.2} s dark\n{}",
        dark.1 - dark.0,
        sim.log()
    );
    assert!(sim.first(dark.0, Health::Lost).is_none(), "Lost in a {:.2} s dark\n{}", dark.1 - dark.0, sim.log());
    assert_eq!(sim.starts(dark.0), 0, "a fresh solve: the light wasn't fused into the coasting track\n{}", sim.log());
    let back = sim.first(dark.1, Health::Locked).unwrap_or_else(|| panic!("never Locked after\n{}", sim.log()));
    assert!(back - dark.1 < RELOCK_S, "Locked {:.3} s after the light came back\n{}", back - dark.1, sim.log());
    let err = sim.max_err(dark.0, dark.1);
    eprintln!("coasted {:.2} s: worst error {:.1} mm, Locked {:.3} s after the light", dark.1 - dark.0, err * 1e3, back - dark.1);
    err
}

/// Both stations blocked for 0.3 s while the tracker sits still (a body passing): it coasts
/// (zero-velocity updates hold it), then the light is fused back in.
#[test]
fn both_occluded_briefly_while_still_coasts() {
    let dark = (SETTLE + 1.0, SETTLE + 1.3);
    let mut sim = Sim::new(Path(vec![key(0.0, [0.1, 0.2, 1.0], [0.0, 0.0, 0.3])]), vec![(dark.0, dark.1, &[A, B])]);
    sim.run(SETTLE + 4.0);
    locked_by_settle(&sim);
    coasted_through(&sim, dark);
    sim.assert_no_jumps(SETTLE);
}

/// Both stations blocked for 0.15 s mid-carry (~0.5 m/s): dead reckoned through it within
/// COAST_ERR_M, and fused back in without a jump.
#[test]
fn brief_occlusion_during_motion_coasts_and_fuses() {
    let dark = (SETTLE + 1.6, SETTLE + 1.75);
    let mut sim = Sim::new(carry(SETTLE + 0.5), vec![(dark.0, dark.1, &[A, B])]);
    sim.run(SETTLE + 5.0);
    locked_by_settle(&sim);
    coasted_through(&sim, dark);
    sim.assert_no_jumps(SETTLE);
}

/// A 2 s dark mid-carry: the dead reckoning's covariance passes the limit and the kernel
/// declares the track lost (Drifted), well before the hard cap; nothing coasts on after.
#[test]
fn long_occlusion_during_motion_ends_lost_on_variance() {
    let dark = (SETTLE + 1.0, SETTLE + 3.0);
    let mut sim = Sim::new(carry(SETTLE + 0.5), vec![(dark.0, dark.1, &[A, B])]);
    sim.run(SETTLE + 5.0);
    locked_by_settle(&sim);
    let (t, why) = sim.loss(dark.0).unwrap_or_else(|| panic!("never lost in a 2 s dark\n{}", sim.log()));
    assert!(why.contains("Drifted"), "lost for {why}, not the covariance\n{}", sim.log());
    assert!(t - dark.0 < 0.6, "coasted {:.3} s", t - dark.0);
    assert!(sim.states.iter().filter(|x| x.0 > t && x.0 < dark.1).all(|x| x.1 == Health::Lost), "{}", sim.log());
    sim.assert_no_jumps(SETTLE);
    reacquired(&sim, SETTLE + 2.9);
}

/// What the accelerometer bias does to dead reckoning: the window is the covariance's (the
/// filter's own bias uncertainty), the same whatever the true bias; the true bias sets how
/// far the coasting pose actually drifts in it. Up to 0.02 g (a warm, tracked IMU) it stays
/// within COAST_ERR_M.
#[test]
fn accelerometer_bias_sets_the_drift_not_the_window() {
    let dark = (SETTLE + 1.0, SETTLE + 3.0);
    let mut windows = Vec::new();
    for bias_g in [0.0, 0.01, 0.02, 0.05] {
        let mut sim = Sim::new(carry(SETTLE + 0.5), vec![(dark.0, dark.1, &[A, B])]);
        sim.accel_bias = V([bias_g, -bias_g * 0.5, bias_g * 0.75]);
        sim.run(SETTLE + 3.2);
        let (t, why) = sim.loss(dark.0).unwrap_or_else(|| panic!("never lost at {bias_g} g\n{}", sim.log()));
        // Past POS_SIGMA_LIMIT_M the coast goes on (Uncertain, not usable) to COAST_GIVE_UP_M:
        // what must stay close to the truth is what was published as usable.
        let err = sim.max_usable_err(dark.0, t);
        eprintln!(
            "accel bias {bias_g:.2} g: coasted {:.0} ms, worst usable error {:.1} mm (any {:.1} mm), {why}",
            (t - dark.0) * 1e3,
            err * 1e3,
            sim.max_err(dark.0, t) * 1e3
        );
        if bias_g <= 0.02 {
            assert!(err < COAST_ERR_M, "{bias_g} g: {:.1} mm", err * 1e3);
        }
        assert!(sim.unusable_once_past_the_limit(dark.0, t), "usable again after Uncertain in the dark\n{}", sim.log());
        windows.push((t - dark.0, err));
    }
    let (w0, e0) = windows[0];
    assert!(windows.iter().all(|w| (w.0 - w0).abs() < 0.03), "window moved with the bias: {windows:?}");
    assert!(windows.last().unwrap().1 > e0, "drift should grow with the bias: {windows:?}");
}

/// Under a hand while sitting still for 2 s: zero-velocity updates keep the covariance in
/// bounds, so the hard cap (lost_after_dark, COAST_MAX_S) is what ends it.
#[test]
fn still_under_a_hand_coasts_until_the_cap() {
    let dark = (SETTLE + 1.0, SETTLE + 3.0);
    let mut sim = Sim::new(Path(vec![key(0.0, [0.1, 0.2, 1.0], [0.0, 0.0, 0.3])]), vec![(dark.0, dark.1, &[A, B])]);
    sim.run(SETTLE + 4.5);
    locked_by_settle(&sim);
    let (t, why) = sim.loss(dark.0).unwrap_or_else(|| panic!("coasted forever\n{}", sim.log()));
    eprintln!("still under a hand: coasted {:.3} s, {why}, worst error {:.1} mm", t - dark.0, sim.max_err(dark.0, t) * 1e3);
    assert!(t - dark.0 <= lh_health::COAST_MAX_S as f64 + 0.02, "past the cap: {:.3} s", t - dark.0);
    sim.assert_no_jumps(SETTLE);
    reacquired(&sim, dark.1);
}

/// Handed over: both stations blocked for 2 s while the tracker is carried 0.4 m and turned
/// (longer than the kernel's sweep-timing lock survives), then set down in clear view.
#[test]
fn both_occluded_during_a_handoff_relocks_fresh() {
    let dark = (SETTLE + 1.0, SETTLE + 3.0);
    let path = Path(vec![
        key(SETTLE + 1.2, [0.1, 0.2, 1.0], [0.0, 0.0, 0.3]),
        key(SETTLE + 2.6, [-0.2, -0.05, 0.85], [0.2, 0.0, -0.9]),
    ]);
    let mut sim = Sim::new(path, vec![(dark.0, dark.1, &[A, B])]);
    sim.run(SETTLE + 6.0);
    locked_by_settle(&sim);
    // Coasting, Uncertain once the carry's dead reckoning passes the usable σ limit, then
    // Lost at the give-up line (Drifted) or the dark cap (NoLight), before the light is back.
    let (t, why) = sim.loss(dark.0).unwrap_or_else(|| panic!("never lost in a 2 s dark\n{}", sim.log()));
    assert!(why.contains("Drifted") || why.contains("NoLight"), "lost for {why}\n{}", sim.log());
    assert!(t - dark.0 <= lh_health::COAST_MAX_S as f64 + 0.02, "tracking held {:.3} s into the dark\n{}", t - dark.0, sim.log());
    assert!(sim.unusable_once_past_the_limit(dark.0, dark.1), "usable again after Uncertain in the dark\n{}", sim.log());
    assert!(
        sim.states.iter().filter(|x| x.0 > dark.0 + 0.13 && x.0 < dark.1).all(|x| x.1 != Health::Locked),
        "{}",
        sim.log()
    );
    sim.assert_no_jumps(SETTLE);
    reacquired(&sim, dark.1);
}

/// After a long dark only the second station (slot 1) comes back at first: the sweep-timing
/// lock can't tell its slot without the master, so the old slot -> station mapping must not
/// be put back on a guess (that would solve a wrong pose); it waits for OOTX or the master.
#[test]
fn only_the_slave_back_first_is_no_wrong_lock() {
    let dark = (SETTLE + 1.0, SETTLE + 3.0);
    let a_back = SETTLE + 7.0;
    let path = Path(vec![
        key(SETTLE + 1.2, [0.1, 0.2, 1.0], [0.0, 0.0, 0.3]),
        key(SETTLE + 2.6, [-0.2, -0.05, 0.85], [0.2, 0.0, -0.9]),
    ]);
    let mut sim = Sim::new(path, vec![(dark.0, dark.1, &[B]), (dark.0, a_back, &[A])]);
    sim.run(a_back + 3.0);
    locked_by_settle(&sim);
    sim.assert_no_jumps(SETTLE);
    reacquired(&sim, a_back);
}

/// One station alone, at 1, 2 and 3 m from it: still, then carried 0.4 m and turned
/// 0.9 rad over 2 s. The known constellation gives the full pose; σ must follow the
/// actual error (no overconfidence) and stay under the limit (Locked) at demo ranges.
/// PixieLamp2's room: one station ~3 m off, the tracker carried, and the lamp's own body
/// blocking it for a quarter second. With light the carried σ sits near POS_SIGMA_LIMIT_M,
/// so dead reckoning passes it within a few tens of ms. Giving up there (the kernel default)
/// throws the track away on every such occlusion and costs a fresh solve; coasting on to
/// COAST_GIVE_UP_M keeps the track (Uncertain while past the limit) and fuses the light back.
#[test]
fn one_far_station_brief_occlusion_mid_carry_keeps_the_track() {
    let a = V([2.0, -1.0, 2.2]);
    let dir = V([-2.0, 1.0, -1.2]).scale(1.0 / V([-2.0, 1.0, -1.2]).norm());
    let p = a.add(dir.scale(3.0));
    let q = p.add(V([0.25, 0.3, 0.05]));
    let path = || Path(vec![key(SETTLE + 1.0, p.0, [0.0, 0.0, 0.3]), key(SETTLE + 3.0, q.0, [0.2, 0.0, 0.9])]);
    let dark = (SETTLE + 2.0, SETTLE + 2.25);
    let occl = || vec![(SETTLE + 0.5, SETTLE + 5.0, &[B][..]), (dark.0, dark.1, &[A, B][..])];
    let mut sim = Sim::new(path(), occl());
    sim.run(SETTLE + 4.0);
    locked_by_settle(&sim);
    assert!(sim.loss(SETTLE + 1.0).is_none(), "lost the track\n{}", sim.log());
    assert_eq!(sim.starts(dark.0), 0, "a fresh solve: the light wasn't fused into the track\n{}", sim.log());
    assert!(sim.first(dark.1, Health::Locked).is_some(), "never Locked after the dark\n{}", sim.log());
    sim.assert_no_jumps(SETTLE);
    // The kernel's default give-up line (= the usable limit) loses it.
    let mut old = Sim::with_cfg(path(), occl(), KernelConfig { lost_sigma_pos: lh_health::POS_SIGMA_LIMIT_M as Real, ..p4_config() });
    old.run(SETTLE + 4.0);
    assert!(old.loss(dark.0).is_some(), "the 2 cm give-up line kept this track too: the test shows nothing\n{}", old.log());
}

#[test]
fn single_station_sigma_follows_the_error() {
    let a = V([2.0, -1.0, 2.2]);
    let dir = V([-2.0, 1.0, -1.2]).scale(1.0 / V([-2.0, 1.0, -1.2]).norm());
    for d in [1.0, 2.0, 3.0] {
        let p = a.add(dir.scale(d));
        let q = p.add(V([0.25, 0.3, 0.05]));
        let path = Path(vec![key(SETTLE + 1.5, p.0, [0.0, 0.0, 0.3]), key(SETTLE + 3.5, q.0, [0.2, 0.0, 0.9])]);
        let mut sim = Sim::new(path, vec![(SETTLE + 0.5, SETTLE + 4.0, &[B])]);
        sim.run(SETTLE + 4.0);
        locked_by_settle(&sim);
        for (lab, w0, w1) in [("still", SETTLE + 0.8, SETTLE + 1.5), ("carried", SETTLE + 1.5, SETTLE + 3.5)] {
            let (mut n, mut e2, mut s2, mut emax, mut smax) = (0.0, 0.0, 0.0, 0.0f64, 0.0f64);
            for (i, p) in sim.poses.iter().enumerate().filter(|(_, p)| p.0 >= w0 && p.0 < w1) {
                let e = p.2.sub(p.3).norm();
                let sg = sim.sigmas[i];
                n += 1.0;
                e2 += e * e;
                s2 += sg * sg;
                emax = emax.max(e);
                smax = smax.max(sg);
            }
            let (erms, srms) = ((e2 / n).sqrt(), (s2 / n).sqrt());
            eprintln!(
                "one station at {d:.0} m, {lab:>7}: error rms {:4.1} mm (max {:4.1}), σ rms {:4.1} mm (max {:4.1})",
                erms * 1e3,
                emax * 1e3,
                srms * 1e3,
                smax * 1e3
            );
            assert!(erms <= srms + 0.001, "{d} m {lab}: σ {:.1} mm under the error {:.1} mm", srms * 1e3, erms * 1e3);
            let states: Vec<_> = sim.states.iter().filter(|x| x.0 >= w0 && x.0 < w1).collect();
            let locked = states.iter().filter(|x| x.1 == Health::Locked).count() as f64 / states.len() as f64;
            eprintln!("    Locked {:.0}% of the time", locked * 100.0);
            // Up to 2 m, and still at 3 m, σ stays under the limit. Carried at 3 m it peaks
            // past it (σ ~4x the simulated error: the noise model is tuned on the recorded
            // sessions, whose hits are noisier than these), so part of that carry reads
            // Uncertain.
            if d <= 2.0 || lab == "still" {
                assert!(locked == 1.0, "{d} m {lab}: not Locked on one station\n{}", sim.log());
            } else {
                assert!(locked > 0.2, "{d} m {lab}: Locked only {:.0}%\n{}", locked * 100.0, sim.log());
            }
        }
        sim.assert_no_jumps(SETTLE);
    }
}
