//! Host tests for the sensor core: driver (fake I2C bus), hub lifecycle, fusion
//! on synthetic motion (static tilt, known-rate rotation, gyro bias), gestures
//! and the calibration record.

mod fake_mpu;

use fake_mpu::{FakeBus, FakeMpu};
use ledmapper_sensor::calib::{self, Calibration};
use ledmapper_sensor::fusion::{AttitudeFilter, Mahony, MahonyParams};
use ledmapper_sensor::math::{Quat, Vec3, GRAVITY};
use ledmapper_sensor::mpu6050::{self as mpu, bits, reg, Config, Family, Variant};
use ledmapper_sensor::{CalAction, CalError, Hub, State};

const DEG: f32 = core::f32::consts::PI / 180.0;
/// Default config scales: ±8 g, ±1000 °/s.
const LSB_G: f32 = 4096.0;
const LSB_DPS: f32 = 32.8;

fn raw_accel(a: Vec3) -> [i16; 3] {
    let k = LSB_G / GRAVITY;
    [(a.x * k).round() as i16, (a.y * k).round() as i16, (a.z * k).round() as i16]
}

fn raw_gyro(w: Vec3) -> [i16; 3] {
    let k = LSB_DPS / DEG;
    [(w.x * k).round() as i16, (w.y * k).round() as i16, (w.z * k).round() as i16]
}

/// Body-frame specific force for a true body->world orientation `q` at rest.
fn accel_at(q: Quat) -> Vec3 {
    q.rotate_inv(Vec3::UP.scale(GRAVITY))
}

fn running_hub(who: u8, addr: u8) -> (Hub, FakeBus, u64) {
    let mut bus = FakeBus::with(FakeMpu::new(addr, who));
    let mut hub = Hub::new(Config::default());
    assert_eq!(hub.probe(&mut bus, 0), State::Starting);
    let t = 100_000;
    hub.poll(&mut bus, t);
    assert_eq!(hub.state(), State::Running);
    (hub, bus, t)
}

/// Produce `n` samples at the 100 Hz ODR then drain (one poll per 20 ms).
fn run(hub: &mut Hub, bus: &mut FakeBus, t: &mut u64, n: usize, mut f: impl FnMut(usize) -> (Vec3, Vec3)) {
    for i in 0..n {
        let (a, w) = f(i);
        bus.dev().produce(raw_accel(a), raw_gyro(w), 0);
        *t += 10_000;
        if i % 2 == 1 {
            hub.poll(bus, *t);
        }
    }
    hub.poll(bus, *t);
}

// -- driver -------------------------------------------------------------------

#[test]
fn identify_known_and_clone_ids() {
    assert_eq!(mpu::identify(0x68), Some(Variant::Mpu6050));
    assert_eq!(mpu::identify(0x70), Some(Variant::Mpu6500));
    assert_eq!(mpu::identify(0x71), Some(Variant::Mpu9250));
    assert_eq!(mpu::identify(0x73), Some(Variant::Mpu9255));
    assert_eq!(mpu::identify(0x98), Some(Variant::Icm20689));
    assert_eq!(mpu::identify(0x72), Some(Variant::Clone6500(0x72)));
    assert_eq!(mpu::identify(0x12), None); // ICM-20602 / an RTC's junk: refused
    assert_eq!(Variant::Mpu6050.family(), Family::Mpu6050);
    assert_eq!(Variant::Mpu6050.fifo_bytes(), 1024);
    assert_eq!(Variant::Icm20689.family(), Family::Mpu6500);
    assert_eq!(Variant::Mpu6500.fifo_bytes(), 512);
}

#[test]
fn probe_absent_ad0_high_and_unknown() {
    let mut empty = FakeBus::default();
    assert_eq!(mpu::probe(&mut empty), None);
    let mut hub = Hub::new(Config::default());
    empty.transactions = 0;
    assert_eq!(hub.probe(&mut empty, 0), State::Absent);
    assert_eq!(empty.transactions, 2, "absent costs exactly two 1-byte probes");

    let mut b = FakeBus::with(FakeMpu::new(0x69, 0x68));
    let f = mpu::probe(&mut b).unwrap();
    assert_eq!((f.addr, f.variant), (0x69, Some(Variant::Mpu6050)));

    // An RTC-ish device at 0x68 is reported but not driven...
    let mut b = FakeBus::with(FakeMpu::new(0x68, 0x00));
    let mut hub = Hub::new(Config::default());
    assert_eq!(hub.probe(&mut b, 0), State::Unknown);
    assert_eq!(hub.snapshot().who_am_i, 0x00);
    assert!(b.dev().writes.is_empty(), "never write to an unrecognized device");
    // ...and a real IMU at 0x69 next to it wins.
    b.devs.push(FakeMpu::new(0x69, 0x70));
    let f = mpu::probe(&mut b).unwrap();
    assert_eq!((f.addr, f.variant), (0x69, Some(Variant::Mpu6500)));
}

#[test]
fn configure_programs_the_6050() {
    let mut b = FakeBus::with(FakeMpu::new(0x68, 0x68));
    let cfg = Config::default();
    assert_eq!(cfg.smplrt_div(), 9);
    assert_eq!(cfg.actual_odr_hz(), 100.0);
    mpu::configure(&mut b, 0x68, Variant::Mpu6050, &cfg).unwrap();
    let r = b.dev().regs;
    assert_eq!(r[reg::PWR_MGMT_1 as usize], bits::PWR_CLK_PLL_X);
    assert_eq!(r[reg::SMPLRT_DIV as usize], 9);
    assert_eq!(r[reg::CONFIG as usize], 3, "42 Hz DLPF, no FIFO_MODE bit on a 6050");
    assert_eq!(r[reg::GYRO_CONFIG as usize], 0x10);
    assert_eq!(r[reg::ACCEL_CONFIG as usize], 0x10);
    assert_eq!(r[reg::FIFO_EN as usize], bits::FIFO_GYRO_ACCEL);
    assert_eq!(r[reg::USER_CTRL as usize], bits::USER_FIFO_EN);
    assert!(!b.dev().writes.iter().any(|w| w.0 == reg::ACCEL_CONFIG2), "6050 has no ACCEL_CONFIG2");
}

#[test]
fn configure_6500_family_sets_fifo_stop_and_accel_dlpf() {
    let mut b = FakeBus::with(FakeMpu::new(0x68, 0x70));
    mpu::configure(&mut b, 0x68, Variant::Mpu6500, &Config::default()).unwrap();
    let r = b.dev().regs;
    assert_eq!(r[reg::CONFIG as usize], 3 | bits::CONFIG_FIFO_MODE_STOP);
    assert_eq!(r[reg::ACCEL_CONFIG2 as usize], 3);
}

#[test]
fn configure_detects_writes_that_did_not_land() {
    let mut dev = FakeMpu::new(0x68, 0x68);
    dev.ignore_writes.push(reg::GYRO_CONFIG);
    let mut b = FakeBus::with(dev);
    assert!(mpu::configure(&mut b, 0x68, Variant::Mpu6050, &Config::default()).is_err());
}

#[test]
fn parse_and_scale() {
    let mut burst = [0u8; 14];
    burst[0..2].copy_from_slice(&4096i16.to_be_bytes());
    burst[4..6].copy_from_slice(&(-4096i16).to_be_bytes());
    burst[6..8].copy_from_slice(&(-521i16).to_be_bytes());
    burst[12..14].copy_from_slice(&328i16.to_be_bytes());
    let raw = mpu::parse_burst(&burst);
    assert_eq!(raw.accel, [4096, 0, -4096]);
    assert_eq!(raw.gyro, [0, 0, 328]);
    assert_eq!(raw.temp, Some(-521));
    assert!((mpu::temp_c(Family::Mpu6050, -521) - 35.0).abs() < 0.01);
    assert!((mpu::temp_c(Family::Mpu6500, 1336) - 25.0).abs() < 0.01);
    assert_eq!(mpu::AccelRange::G8.lsb_per_g(), 4096.0);
    assert_eq!(mpu::GyroRange::Dps1000.lsb_per_dps(), 32.75);
}

// -- hub lifecycle --------------------------------------------------------------

#[test]
fn hub_waits_out_the_reset_without_blocking() {
    let mut bus = FakeBus::with(FakeMpu::new(0x68, 0x68));
    let mut hub = Hub::new(Config::default());
    assert_eq!(hub.probe(&mut bus, 0), State::Starting);
    let ms = hub.poll(&mut bus, 30_000);
    assert!(ms >= 70 && ms <= 71, "asks to sleep out the reset, got {ms}");
    assert_eq!(hub.state(), State::Starting);
    assert!(!bus.dev().writes.iter().any(|w| w.0 == reg::SMPLRT_DIV), "no config during reset");
    assert_eq!(hub.poll(&mut bus, 100_000), ledmapper_sensor::hub::DRAIN_MS);
    assert_eq!(hub.state(), State::Running);
}

#[test]
fn fifo_drain_fuses_every_sample_at_the_imu_clock() {
    let (mut hub, mut bus, mut t) = running_hub(0x68, 0x68);
    run(&mut hub, &mut bus, &mut t, 250, |_| (Vec3::new(0.0, 0.0, GRAVITY), Vec3::ZERO));
    let s = hub.snapshot();
    assert_eq!(s.samples, 250);
    assert_eq!(s.fifo, 1);
    assert!((s.rate_hz - 100.0).abs() < 5.0, "rate {}", s.rate_hz);
    assert_eq!(s.fifo_overflows, 0);
    assert!((s.accel[2] - GRAVITY).abs() < 0.01);
    assert!((s.gravity[2] + 1.0).abs() < 1e-3, "down = -z when level: {:?}", s.gravity);
}

#[test]
fn fifo_overflow_resyncs() {
    let (mut hub, mut bus, mut t) = running_hub(0x68, 0x68);
    // 6050 overwrite-oldest: 100 samples (1200 B) into a 1024-B FIFO, no drain.
    for _ in 0..100 {
        bus.dev().produce(raw_accel(Vec3::new(0.0, 0.0, GRAVITY)), [0; 3], 0);
    }
    t += 1_000_000;
    hub.poll(&mut bus, t);
    assert_eq!(hub.snapshot().fifo_overflows, 1);
    assert!(bus.dev().fifo.is_empty(), "FIFO reset");
    run(&mut hub, &mut bus, &mut t, 10, |_| (Vec3::new(0.0, 0.0, GRAVITY), Vec3::ZERO));
    let s = hub.snapshot();
    assert_eq!(s.samples, 10, "clean frames after the resync");
    assert!((s.accel[2] - GRAVITY).abs() < 0.01);
}

#[test]
fn dead_fifo_falls_back_to_direct_polling() {
    let mut dev = FakeMpu::new(0x68, 0x72);
    dev.dead_fifo = true;
    let mut bus = FakeBus::with(dev);
    let mut hub = Hub::new(Config::default());
    hub.probe(&mut bus, 0);
    let mut t = 100_000;
    hub.poll(&mut bus, t);
    for _ in 0..40 {
        bus.dev().produce(raw_accel(Vec3::new(0.0, 0.0, GRAVITY)), [0; 3], 0);
        t += 20_000;
        hub.poll(&mut bus, t);
    }
    let s = hub.snapshot();
    assert_eq!(s.fifo, 0, "gave up on the FIFO");
    assert!(s.samples > 0, "direct polling delivers samples");
    assert!((s.accel[2] - GRAVITY).abs() < 0.01);
}

#[test]
fn unplug_faults_and_replug_recovers() {
    let (mut hub, mut bus, mut t) = running_hub(0x68, 0x68);
    run(&mut hub, &mut bus, &mut t, 10, |_| (Vec3::new(0.0, 0.0, GRAVITY), Vec3::ZERO));
    bus.dev().present = false;
    for _ in 0..ledmapper_sensor::hub::FAULT_AFTER {
        t += 20_000;
        hub.poll(&mut bus, t);
    }
    assert_eq!(hub.state(), State::Fault);
    assert!(hub.snapshot().bus_errors >= ledmapper_sensor::hub::FAULT_AFTER as u32);
    bus.dev().present = true;
    t += 1_100_000;
    hub.poll(&mut bus, t);
    assert_eq!(hub.state(), State::Starting, "re-probed + reset");
    t += 100_000;
    hub.poll(&mut bus, t);
    assert_eq!(hub.state(), State::Running);
}

// -- fusion -----------------------------------------------------------------------

/// Static tilt: the filter levels from the first sample and holds it.
#[test]
fn static_tilt_is_recovered() {
    for (roll, pitch) in [(30.0f32, -20.0f32), (-75.0, 10.0), (170.0, 0.0), (0.0, 89.0)] {
        let q_true = Quat::from_axis_angle(Vec3::new(1.0, 0.0, 0.0), roll * DEG)
            .mul(Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), pitch * DEG));
        let mut f = Mahony::new(MahonyParams::default());
        let a = accel_at(q_true);
        for _ in 0..200 {
            f.update(a, Vec3::ZERO, 0.01);
        }
        // Tilt (gravity direction) must match; yaw is unobservable.
        let up_est = f.quat().up_in_body();
        let up_true = q_true.up_in_body();
        let err = up_est.sub(up_true).norm();
        assert!(err < 0.005, "roll {roll} pitch {pitch}: up error {err}");
    }
}

/// A tilt that starts wrong converges at roughly the kp time constant.
#[test]
fn tilt_error_converges() {
    let q_true = Quat::from_axis_angle(Vec3::new(1.0, 0.0, 0.0), 40.0 * DEG);
    let mut f = Mahony::new(MahonyParams::default());
    f.update(Vec3::new(0.0, 0.0, GRAVITY), Vec3::ZERO, 0.01); // levels at identity
    let a = accel_at(q_true);
    for _ in 0..500 {
        f.update(a, Vec3::ZERO, 0.01);
    }
    let err = f.quat().up_in_body().sub(q_true.up_in_body()).norm();
    assert!(err < 0.01, "after 5 s: {err}");
}

/// Rotation at a known body rate with a consistent accel: attitude tracks.
#[test]
fn rotation_at_known_rate_is_tracked() {
    let dt = 0.01;
    for axis in [Vec3::new(0.0, 0.0, 1.0), Vec3::new(1.0, 0.0, 0.0), Vec3::new(0.6, 0.0, 0.8)] {
        let rate = 1.5; // rad/s
        let w = axis.scale(rate);
        let step = Quat::from_axis_angle(axis, rate * dt);
        let mut q_true = Quat::IDENTITY;
        let mut f = Mahony::new(MahonyParams::default());
        f.update(accel_at(q_true), Vec3::ZERO, dt);
        for _ in 0..300 {
            q_true = q_true.mul(step).normalized();
            f.update(accel_at(q_true), w, dt);
        }
        let err = f.quat().angle_to(q_true);
        assert!(err < 1.0 * DEG, "axis {axis:?}: {} deg after 4.5 rad", err / DEG);
    }
}

/// Pure yaw at 1 rad/s for 2 s: the integrated angle is right to <1%.
#[test]
fn yaw_rate_integrates() {
    let mut f = Mahony::new(MahonyParams::default());
    let a = Vec3::new(0.0, 0.0, GRAVITY);
    f.update(a, Vec3::ZERO, 0.01);
    for _ in 0..200 {
        f.update(a, Vec3::new(0.0, 0.0, 1.0), 0.01);
    }
    let q = f.quat();
    let yaw = 2.0 * q.z.atan2(q.w);
    assert!((yaw - 2.0).abs() < 0.02, "yaw {yaw}");
}

/// A constant gyro bias on a still fixture is learned at rest; afterwards yaw
/// (unobservable from gravity) no longer drifts.
#[test]
fn gyro_bias_is_learned_at_rest() {
    let (mut hub, mut bus, mut t) = running_hub(0x68, 0x68);
    let bias = Vec3::new(0.03, -0.02, 0.025); // ~1.7 °/s, a typical 6050 ZRO
    let a = Vec3::new(0.0, 0.0, GRAVITY);
    run(&mut hub, &mut bus, &mut t, 300, |_| (a, bias));
    let b = Vec3::from_array(hub.snapshot().gyro_bias);
    assert!(b.sub(bias).norm() < 0.002, "learned {b:?} vs {bias:?}");
    let q0 = Quat::from_array(hub.snapshot().quat);
    run(&mut hub, &mut bus, &mut t, 6000, |_| (a, bias)); // 60 s
    let drift = Quat::from_array(hub.snapshot().quat).angle_to(q0);
    assert!(drift < 0.5 * DEG, "yaw drift {} deg/min (unlearned: {} deg)", drift / DEG, 0.025 * 60.0 / DEG);
    assert_eq!(hub.snapshot().at_rest, 1);
}

/// Without rest learning (bias unknown, fixture moving), the integral term still
/// pulls roll/pitch bias out — the classic Mahony property.
#[test]
fn mahony_integral_tracks_tilt_axis_bias() {
    let mut f = Mahony::new(MahonyParams { ki: 0.2, ..MahonyParams::default() });
    let a = Vec3::new(0.0, 0.0, GRAVITY);
    let bias = Vec3::new(0.02, -0.01, 0.0);
    f.update(a, Vec3::ZERO, 0.01);
    for _ in 0..6000 {
        f.update(a, bias, 0.01);
    }
    let b = f.gyro_bias();
    assert!((b.x - 0.02).abs() < 0.002 && (b.y + 0.01).abs() < 0.002, "{b:?}");
    assert!(f.quat().up_in_body().sub(Vec3::UP).norm() < 0.01);
}

/// While shaken (|a| far from g) the accel correction is gated off, so a
/// strong linear acceleration doesn't drag the tilt estimate.
#[test]
fn shaking_does_not_drag_tilt() {
    let mut f = Mahony::new(MahonyParams::default());
    f.update(Vec3::new(0.0, 0.0, GRAVITY), Vec3::ZERO, 0.01);
    for i in 0..100 {
        let s = if i % 20 < 10 { 1.0 } else { -1.0 };
        f.update(Vec3::new(s * 15.0, 0.0, GRAVITY), Vec3::ZERO, 0.01);
    }
    let err = f.quat().up_in_body().sub(Vec3::UP).norm();
    assert!(err < 0.01, "tilt dragged by {err}");
}

// -- gestures ---------------------------------------------------------------------

#[test]
fn tap_and_shake() {
    let (mut hub, mut bus, mut t) = running_hub(0x68, 0x68);
    let g = Vec3::new(0.0, 0.0, GRAVITY);
    run(&mut hub, &mut bus, &mut t, 100, |_| (g, Vec3::ZERO));
    assert_eq!((hub.snapshot().tap_count, hub.snapshot().shake_count), (0, 0));
    // A knock: one sample 2 g off, then a ring-down sample (refractory).
    run(&mut hub, &mut bus, &mut t, 6, |i| match i {
        2 => (g.add(Vec3::new(2.0 * GRAVITY, 0.0, 0.0)), Vec3::ZERO),
        3 => (g.add(Vec3::new(-1.0 * GRAVITY, 0.0, 0.0)), Vec3::ZERO),
        _ => (g, Vec3::ZERO),
    });
    assert_eq!(hub.snapshot().tap_count, 1, "one knock = one tap");
    // Shake: ±1.5 g side to side at ~3 Hz for 2 s.
    run(&mut hub, &mut bus, &mut t, 200, |i| {
        let s = (i as f32 * 0.19).sin() * 1.5 * GRAVITY;
        (g.add(Vec3::new(s, 0.0, 0.0)), Vec3::ZERO)
    });
    let s = hub.snapshot();
    assert_eq!(s.shake_count, 1, "one sustained shake = one event");
    assert!(s.shake > 0.5, "level {}", s.shake);
    run(&mut hub, &mut bus, &mut t, 300, |_| (g, Vec3::ZERO));
    assert!(hub.snapshot().shake < 0.05);
}

// -- calibration --------------------------------------------------------------------

#[test]
fn calibration_record_roundtrip_and_rejects_corruption() {
    let c = Calibration {
        gyro_bias: Vec3::new(0.01, -0.02, 0.03),
        accel_offset: Vec3::new(0.1, 0.2, -0.3),
        accel_scale: Vec3::new(1.01, 0.99, 1.0),
        mount: Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), 0.5),
        flags: calib::FLAG_GYRO_BIAS | calib::FLAG_MOUNT,
        ..Calibration::default()
    };
    let rec = c.encode();
    assert_eq!(rec.len(), calib::RECORD_LEN);
    let d = Calibration::decode(&rec).unwrap();
    assert_eq!(d.gyro_bias, c.gyro_bias);
    assert_eq!(d.flags, c.flags);
    assert!(d.mount.angle_to(c.mount) < 1e-3);
    for i in [0, 4, 9, 40, calib::RECORD_LEN - 1] {
        let mut bad = rec;
        bad[i] ^= 0x10;
        assert!(Calibration::decode(&bad).is_none(), "flip at {i} accepted");
    }
    assert!(Calibration::decode(&rec[..10]).is_none());
    assert_eq!(calib::crc32(b"123456789"), 0xCBF4_3926);
}

#[test]
fn level_calibration_absorbs_a_sideways_mount() {
    // Board mounted on its side: sensor +x points up.
    let (mut hub, mut bus, mut t) = running_hub(0x68, 0x68);
    let a = Vec3::new(GRAVITY, 0.0, 0.0);
    assert_eq!(hub.calibrate(CalAction::Level), Err(CalError::NotAtRest));
    run(&mut hub, &mut bus, &mut t, 120, |_| (a, Vec3::ZERO));
    hub.calibrate(CalAction::Level).unwrap();
    assert!(hub.take_cal_dirty());
    assert!(!hub.take_cal_dirty());
    run(&mut hub, &mut bus, &mut t, 50, |_| (a, Vec3::ZERO));
    let s = hub.snapshot();
    assert!((s.gravity[2] + 1.0).abs() < 1e-3, "fixture down after level: {:?}", s.gravity);
    assert!((s.accel[2] - GRAVITY).abs() < 0.02);
    // The record persists the mount and restores it on the next boot.
    let rec = hub.calibration().encode();
    let (mut hub2, mut bus2, mut t2) = running_hub(0x68, 0x68);
    hub2.load_calibration(Calibration::decode(&rec).unwrap());
    run(&mut hub2, &mut bus2, &mut t2, 20, |_| (a, Vec3::ZERO));
    assert!((hub2.snapshot().gravity[2] + 1.0).abs() < 1e-3);
    assert_eq!(hub2.snapshot().calibrated, 1);
}

#[test]
fn gyro_bias_calibration_persists_and_seeds() {
    let (mut hub, mut bus, mut t) = running_hub(0x68, 0x68);
    let bias = Vec3::new(0.02, 0.01, -0.03);
    let a = Vec3::new(0.0, 0.0, GRAVITY);
    run(&mut hub, &mut bus, &mut t, 300, |_| (a, bias));
    hub.calibrate(CalAction::GyroBias).unwrap();
    let rec = hub.calibration().encode();
    // Next boot: seeded, so a moving start doesn't need a rest period first.
    let (mut hub2, _bus2, _t2) = running_hub(0x68, 0x68);
    hub2.load_calibration(Calibration::decode(&rec).unwrap());
    let b = Vec3::from_array(hub2.snapshot().gyro_bias);
    assert!(b.sub(bias).norm() < 0.002, "{b:?}");
    hub2.calibrate(CalAction::Reset).unwrap();
    assert_eq!(hub2.snapshot().gyro_bias, [0.0; 3]);
    assert_eq!(hub2.snapshot().calibrated, 0);
}

/// A part whose accel reads 14% low (indoor_localization saw 8.4 m/s² on a
/// real MPU-6050) is flagged and re-scaled from the first second at rest.
#[test]
fn accel_scale_error_is_learned_at_rest() {
    let (mut hub, mut bus, mut t) = running_hub(0x68, 0x68);
    let a = Vec3::new(0.0, 0.0, 8.4);
    run(&mut hub, &mut bus, &mut t, 250, |_| (a, Vec3::ZERO));
    let s = hub.snapshot();
    assert_eq!(s.accel_suspect, 1);
    assert!((s.accel[2] - GRAVITY).abs() < 0.02, "rescaled: {:?}", s.accel);
    assert_eq!(s.at_rest, 1);
    hub.calibrate(CalAction::GyroBias).unwrap();
    let c = hub.calibration();
    assert_eq!(c.flags & calib::FLAG_ACCEL, calib::FLAG_ACCEL);
    assert!((c.accel_scale.z - GRAVITY / 8.4).abs() < 0.01);
}

#[test]
fn euler_and_atan2() {
    use ledmapper_sensor::math::{asin, atan2};
    for (y, x) in [(1.0f32, 1.0f32), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0), (0.3, -2.0), (0.0, -1.0)] {
        assert!((atan2(y, x) - y.atan2(x)).abs() < 2e-5, "atan2({y},{x})");
    }
    assert!((asin(0.5) - 0.5f32.asin()).abs() < 2e-5);
    let q = Quat::from_axis_angle(Vec3::new(0.0, 0.0, 1.0), 0.7)
        .mul(Quat::from_axis_angle(Vec3::new(0.0, 1.0, 0.0), -0.3))
        .mul(Quat::from_axis_angle(Vec3::new(1.0, 0.0, 0.0), 0.2));
    let e = q.to_euler();
    assert!((e[0] - 0.2).abs() < 1e-3 && (e[1] + 0.3).abs() < 1e-3 && (e[2] - 0.7).abs() < 1e-3, "{e:?}");
}

// -- extrinsic calibration (docs/design/sensor-core.md §7) ---------------------------

#[test]
fn calibration_v2_metadata_and_v1_compat() {
    let c = Calibration {
        mount: Quat::from_axis_angle(Vec3::new(1.0, 2.0, 3.0), 0.7),
        flags: calib::FLAG_MOUNT | calib::FLAG_EXTRINSIC | calib::FLAG_YAW_RESOLVED,
        mount_residual_deg: 0.8,
        mount_poses: 3,
        calibrated_at: 1_792_000_000,
        ..Calibration::default()
    };
    let rec = c.encode();
    assert_eq!(rec.len(), calib::RECORD_LEN);
    assert_eq!(rec[4], 2);
    let d = Calibration::decode(&rec).unwrap();
    assert_eq!((d.mount_poses, d.calibrated_at, d.mount_residual_deg), (3, 1_792_000_000, 0.8));
    // A v1 record (fixtures calibrated before this existed) still loads.
    let mut v1 = [0u8; calib::RECORD_LEN_V1];
    v1[..4].copy_from_slice(b"SCAL");
    v1[4] = 1;
    v1[5] = calib::FLAG_GYRO_BIAS;
    let one = 1.0f32.to_le_bytes();
    for i in [6usize, 7, 8, 9] {
        v1[8 + 4 * i..12 + 4 * i].copy_from_slice(&one); // accel scale 1, mount w 1
    }
    let crc = calib::crc32(&v1[..calib::RECORD_LEN_V1 - 4]);
    v1[calib::RECORD_LEN_V1 - 4..].copy_from_slice(&crc.to_le_bytes());
    let d1 = Calibration::decode(&v1).expect("v1 decodes");
    assert_eq!((d1.flags, d1.mount_poses, d1.calibrated_at), (calib::FLAG_GYRO_BIAS, 0, 0));
    assert!(d1.mount.angle_to(Quat::IDENTITY) < 1e-3);
}

/// The settled up in the RAW IMU frame (before the mount) is what the app pairs
/// with the camera's up; an installed extrinsic then makes the fused gravity the
/// map's -Y and the reported mount equal what was installed.
#[test]
fn rest_up_and_installed_extrinsic() {
    let (mut hub, mut bus, mut t) = running_hub(0x68, 0x68);
    // IMU mounted so its +x points up.
    let a = Vec3::new(GRAVITY, 0.0, 0.0);
    run(&mut hub, &mut bus, &mut t, 150, |_| (a, Vec3::ZERO));
    let s = hub.snapshot();
    assert!(s.rest_samples > 50);
    assert!(Vec3::from_array(s.rest_up_imu).sub(Vec3::new(1.0, 0.0, 0.0)).norm() < 1e-3);
    assert!(s.rest_up_sigma_deg < 0.5, "{}", s.rest_up_sigma_deg);
    // R_fi: IMU +x -> map +Y (up), IMU +y -> map +X, IMU +z -> map -Z.
    // 180° about (1, 1, 0)/sqrt2.
    let h = core::f32::consts::FRAC_1_SQRT_2;
    let r_fi = Quat::new(0.0, h, h, 0.0);
    assert!(r_fi.rotate(Vec3::new(1.0, 0.0, 0.0)).sub(Vec3::new(0.0, 1.0, 0.0)).norm() < 1e-5);
    hub.set_extrinsic(r_fi, 0.6, 2, true, 1_792_000_000);
    assert!(hub.take_cal_dirty());
    // rest_up survives the mount change (still the raw IMU frame).
    run(&mut hub, &mut bus, &mut t, 80, |_| (a, Vec3::ZERO));
    let s = hub.snapshot();
    assert!(Quat::from_array(s.mount_map).angle_to(r_fi) < 1e-3, "{:?}", s.mount_map);
    assert_ne!(s.cal_flags & calib::FLAG_YAW_RESOLVED, 0);
    assert!(Vec3::from_array(s.rest_up_imu).sub(Vec3::new(1.0, 0.0, 0.0)).norm() < 1e-3);
    // Fixture (z-up) down = -z, which the pool maps to map -Y.
    assert!((s.gravity[2] + 1.0).abs() < 1e-3, "{:?}", s.gravity);
    // The extrinsic persists with its metadata.
    let c = Calibration::decode(&hub.calibration().encode()).unwrap();
    assert_eq!((c.mount_poses, c.calibrated_at), (2, 1_792_000_000));
    // Redoing the map: yaw no longer resolved, tilt kept.
    hub.map_changed();
    assert!(hub.take_cal_dirty());
    assert_eq!(hub.snapshot().cal_flags & calib::FLAG_YAW_RESOLVED, 0);
    assert_ne!(hub.snapshot().cal_flags & calib::FLAG_EXTRINSIC, 0);
    // A plain "level" afterwards drops the extrinsic flags.
    hub.calibrate(CalAction::Level).unwrap();
    assert_eq!(hub.snapshot().cal_flags & calib::FLAG_EXTRINSIC, 0);
}
