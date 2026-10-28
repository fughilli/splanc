//! Sensor core through the C ABI: lm_sensor_begin/poll over a fake MPU-6050 on
//! a fake I2C bus, get_sensors / calibrate_sensors, and the uniform pool — an
//! effect declaring `uniform vec3 imu_gravity` sees the fused gravity vector,
//! while with no sensor the uniform keeps its default.

#[path = "../../sensor/tests/fake_mpu.rs"]
mod fake_mpu;

use core::ffi::c_void;
use fake_mpu::{FakeBus, FakeMpu};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_capture_profile_gen, lm_capture_profile_get, lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update,
    lm_map_replaced, lm_player_handle, lm_player_init, lm_sensor_begin, lm_sensor_poll, lm_sensor_take_cal_record,
    LmI2cOps, FEATURES,
};
use ledmapper_sensor::{BusError, I2cBus};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;

unsafe extern "C" fn wr(ctx: *mut c_void, addr: u8, w: *const u8, wn: usize, r: *mut u8, rn: usize) -> i32 {
    let bus = &mut *(ctx as *mut FakeBus);
    match bus.write_read(addr, core::slice::from_raw_parts(w, wn), core::slice::from_raw_parts_mut(r, rn)) {
        Ok(()) => 0,
        Err(BusError::Nack) => 1,
        Err(_) => 2,
    }
}

unsafe extern "C" fn w(ctx: *mut c_void, addr: u8, b: *const u8, n: usize) -> i32 {
    let bus = &mut *(ctx as *mut FakeBus);
    match bus.write(addr, core::slice::from_raw_parts(b, n)) {
        Ok(()) => 0,
        Err(BusError::Nack) => 1,
        Err(_) => 2,
    }
}

fn handle(msg: CMsg) -> Option<SMsg> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 4096>::new());
    env.encode(&mut enc).unwrap();
    let frame = enc.into_writer().to_vec();
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n > 0, "handle returned {n}");
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn sensors() -> pb::SensorState {
    match handle(CMsg::GetSensors(pb::GetSensors::default())) {
        Some(SMsg::SensorState(s)) => s,
        other => panic!("expected sensor_state, got {other:?}"),
    }
}

const EFFECT: &str = r#"
uniform vec3 imu_gravity = 0.0, 0.0, 0.0;
uniform float imu_shake : 0.0 .. 1.0 = 0.0;
vec3 shade(Led led) {
  // Floor-side red, sky-side blue: x/y/z of the DOWN vector mapped to 0..1.
  return vec3(0.5 + 0.5 * imu_gravity.x, 0.5 + 0.5 * imu_gravity.y, 0.5 + 0.5 * imu_gravity.z);
}
"#;

fn shade0() -> [f32; 3] {
    assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 1) });
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    rgb.map(|c| c as f32 / 255.0)
}

/// One process-global player: everything in one test, in order.
#[test]
fn sensor_core_through_the_c_abi() {
    assert!(FEATURES.contains(&"sensors"));
    lm_player_init(16);

    // Before the sensor core starts: status unspecified, no vectors.
    let s = sensors();
    assert_eq!(s.r#status, pb::SensorStatus::Unspecified);

    let fxb = ledmapper_fx_compiler::compile(EFFECT).expect("compiles").fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    // No sensor: imu_gravity keeps its default (0,0,0) -> mid grey.
    let c = shade0();
    assert!(c.iter().all(|v| (v - 0.5).abs() < 0.01), "default uniform {c:?}");

    // A fake MPU-6050 at 0x68, tilted: sensor +x is up (lying on its side).
    let bus = Box::leak(Box::new(FakeBus::with(FakeMpu::new(0x68, 0x68))));
    let ops = Box::leak(Box::new(LmI2cOps {
        ctx: bus as *mut FakeBus as *mut c_void,
        write_read: Some(wr),
        write: Some(w),
        cycles: None,
    }));
    let st = unsafe { lm_sensor_begin(ops, 6, 7, 21, 0, core::ptr::null(), 0) };
    assert_eq!(st, 3, "found + starting");
    let mut t = 100_000u64;
    unsafe { lm_sensor_poll(t) };
    let up_x = [4096i16, 0, 0];
    for _ in 0..150 {
        bus.dev().produce(up_x, [0; 3], 0);
        t += 10_000;
        unsafe { lm_sensor_poll(t) };
    }
    let s = sensors();
    assert_eq!(s.r#status, pb::SensorStatus::Running);
    assert_eq!(s.r#i2c_address, 0x68);
    assert_eq!(s.r#who_am_i, 0x68);
    assert_eq!((s.r#sda_gpio, s.r#scl_gpio, s.r#int_gpio), (6, 7, 21));
    assert!(s.r#fifo && s.r#at_rest);
    assert_eq!(s.r#samples, 150);
    // Firmware encodes the vectors zero-copy; host-profile decode sees them.
    assert!((s.r#accel[0] - 9.80665).abs() < 0.01, "{:?}", s.r#accel);
    assert!((s.r#gravity[0] + 1.0).abs() < 1e-3, "down = -x: {:?}", s.r#gravity);
    assert_eq!(s.r#quat.len(), 4);

    // The pool drives the effect (map frame; -x stays -x): red ~0, others ~0.5.
    let c = shade0();
    assert!(c[0] < 0.02 && (c[1] - 0.5).abs() < 0.02 && (c[2] - 0.5).abs() < 0.02, "pool-driven {c:?}");

    // calibrate_sensors(LEVEL): queued, applied at the next poll, persisted.
    let mut cal = pb::CalibrateSensors::default();
    cal.r#action = pb::CalibrateSensors_::Action::Level;
    let seq0 = match handle(CMsg::CalibrateSensors(cal)) {
        Some(SMsg::SensorState(s)) => s.r#calibration_seq,
        o => panic!("{o:?}"),
    };
    bus.dev().produce(up_x, [0; 3], 0);
    t += 20_000;
    unsafe { lm_sensor_poll(t) };
    let mut rec = [0u8; 96];
    assert!(unsafe { lm_sensor_take_cal_record(rec.as_mut_ptr(), rec.len()) } > 0, "record to persist");
    for _ in 0..30 {
        bus.dev().produce(up_x, [0; 3], 0);
        t += 10_000;
        unsafe { lm_sensor_poll(t) };
    }
    let s = sensors();
    assert_eq!(s.r#calibration_seq, seq0 + 1);
    assert_eq!(s.r#calibration_result.as_str(), "ok");
    assert!(s.r#calibrated);
    assert!((s.r#gravity[2] + 1.0).abs() < 1e-3, "levelled: {:?}", s.r#gravity);
    let c = shade0();
    // Levelled: down = sensor -z = map -Y -> green ~0, red/blue ~0.5.
    assert!(c[1] < 0.02 && (c[0] - 0.5).abs() < 0.02 && (c[2] - 0.5).abs() < 0.02, "levelled pool {c:?}");

    // -- §7: the settled raw-IMU up, an installed extrinsic, the capture profile --
    // (the level above moved the mount: let the rest detector settle again)
    for _ in 0..80 {
        bus.dev().produce(up_x, [0; 3], 0);
        t += 10_000;
        unsafe { lm_sensor_poll(t) };
    }
    let s = sensors();
    assert!(s.r#rest_samples > 0);
    assert!((s.r#rest_up_imu[0] - 1.0).abs() < 1e-3, "raw IMU up is +x: {:?}", s.r#rest_up_imu);
    // R_fi: IMU +x -> map +Y, IMU +y -> map +X, IMU +z -> map -Z.
    let h = core::f32::consts::FRAC_1_SQRT_2;
    let mut m = pb::SetSensorMount {
        r#residual_deg: 0.7,
        r#poses: 2,
        r#yaw_resolved: true,
        r#calibrated_at_ms: 1_792_000_000_000,
        ..Default::default()
    };
    m.r#quat.extend_from_slice(&[0.0, h, h, 0.0]).unwrap();
    let seq0 = match handle(CMsg::SetSensorMount(m)) {
        Some(SMsg::SensorState(s)) => s.r#calibration_seq,
        o => panic!("{o:?}"),
    };
    for _ in 0..30 {
        bus.dev().produce(up_x, [0; 3], 0);
        t += 10_000;
        unsafe { lm_sensor_poll(t) };
    }
    let s = sensors();
    assert_eq!(s.r#calibration_seq, seq0 + 1);
    // The sensor task persists what it applied (sensor_bus.cpp persist_cal ->
    // NVS "sens_cal"): the record is handed over exactly once.
    let mut mount_rec = [0u8; 96];
    let mount_len = unsafe { lm_sensor_take_cal_record(mount_rec.as_mut_ptr(), mount_rec.len()) };
    assert!(mount_len > 0, "the extrinsic is handed to NVS");
    assert_eq!(unsafe { lm_sensor_take_cal_record(mount_rec.as_mut_ptr(), mount_rec.len()) }, 0);
    assert!(s.r#mount_extrinsic && s.r#mount_yaw_resolved);
    assert_eq!((s.r#mount_poses, s.r#mount_calibrated_at_ms), (2, 1_792_000_000_000));
    let q = &s.r#mount_quat;
    assert!((q[0].abs() < 1e-3) && (q[1] - h).abs() < 1e-3 && (q[2] - h).abs() < 1e-3, "{q:?}");
    // The pool now sees map -Y as down: green ~0 (the effect maps down to rgb).
    let c = shade0();
    assert!(c[1] < 0.02 && (c[0] - 0.5).abs() < 0.02, "extrinsic pool {c:?}");
    // A malformed mount is refused.
    let mut bad = pb::SetSensorMount::default();
    bad.r#quat.extend_from_slice(&[3.0, 0.0, 0.0, 0.0]).unwrap();
    assert!(matches!(handle(CMsg::SetSensorMount(bad)), Some(SMsg::Error(e)) if e.r#code.as_str() == "bad_mount"));

    // Capture profile: none for a fixture mapped before this existed...
    match handle(CMsg::GetCaptureProfile(pb::GetCaptureProfile::default())) {
        Some(SMsg::CaptureProfile(p)) => assert_eq!(p.r#map_id.as_str(), ""),
        o => panic!("{o:?}"),
    }
    let gen0 = lm_capture_profile_gen();
    let mut prof = pb::CaptureProfile {
        r#diffuse: true,
        r#stride_spacing: 4,
        r#anchor_density: 6,
        r#symbols: 4,
        r#bit_period_ms: 66,
        r#brightness: 0.4,
        r#captured_at_ms: 1_792_000_000_000,
        ..Default::default()
    };
    prof.r#map_id = "m-lamp".parse().unwrap();
    let mut set = pb::SetCaptureProfile::default();
    set.set_profile(prof.clone());
    match handle(CMsg::SetCaptureProfile(set)) {
        Some(SMsg::CaptureProfile(p)) => assert_eq!(p, prof),
        o => panic!("{o:?}"),
    }
    assert_eq!(lm_capture_profile_gen(), gen0 + 1, "the firmware persists it");
    let mut buf = [0u8; 192];
    assert!(unsafe { lm_capture_profile_get(buf.as_mut_ptr(), buf.len()) } > 0);
    match handle(CMsg::GetCaptureProfile(pb::GetCaptureProfile::default())) {
        Some(SMsg::CaptureProfile(p)) => {
            assert!(p.r#diffuse);
            assert_eq!((p.r#stride_spacing, p.r#map_id.as_str()), (4, "m-lamp"));
        }
        o => panic!("{o:?}"),
    }
    // ...a new map drops it and un-resolves the extrinsic's yaw (tilt kept).
    unsafe { lm_map_replaced() };
    for _ in 0..3 {
        bus.dev().produce(up_x, [0; 3], 0);
        t += 10_000;
        unsafe { lm_sensor_poll(t) };
    }
    assert_eq!(unsafe { lm_capture_profile_get(buf.as_mut_ptr(), buf.len()) }, 0);
    let s = sensors();
    assert!(s.r#mount_extrinsic && !s.r#mount_yaw_resolved);

    // -- reboot: main.cpp reads "sens_cal" and hands it to lm_sensor_begin -------
    // The record persisted right after set_sensor_mount comes back with the
    // mount, the yaw flag, the pose count and the timestamp the app reads back.
    let bus2 = Box::leak(Box::new(FakeBus::with(FakeMpu::new(0x68, 0x68))));
    let ops2 = Box::leak(Box::new(LmI2cOps {
        ctx: bus2 as *mut FakeBus as *mut c_void,
        write_read: Some(wr),
        write: Some(w),
        cycles: None,
    }));
    let st = unsafe { lm_sensor_begin(ops2, 6, 7, 21, 0, mount_rec.as_ptr(), mount_len as usize) };
    assert_eq!(st, 3);
    let mut t = 100_000u64;
    unsafe { lm_sensor_poll(t) };
    for _ in 0..60 {
        bus2.dev().produce(up_x, [0; 3], 0);
        t += 10_000;
        unsafe { lm_sensor_poll(t) };
    }
    let s = sensors();
    assert_eq!(s.r#status, pb::SensorStatus::Running);
    assert!(s.r#mount_extrinsic && s.r#mount_yaw_resolved, "extrinsic survives the reboot");
    assert_eq!((s.r#mount_poses, s.r#mount_calibrated_at_ms), (2, 1_792_000_000_000));
    let q = &s.r#mount_quat;
    assert!((q[0].abs() < 1e-3) && (q[1] - h).abs() < 1e-3 && (q[2] - h).abs() < 1e-3, "{q:?}");
}
