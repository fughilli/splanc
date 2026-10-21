//! FUG-107 driver VM through the C ABI, and the native-vs-VM A/B for the
//! MPU-6050 (docs/design/sensor-core.md §8): the same raw sample stream through
//! (A) the native driver path (Hub::ingest at the IMU clock) and (B) the
//! bytecode driver (firmware/sensor/drivers/mpu6050.fx) feeding the same native
//! fusion via submit_driver{feed_imu}. Also: scan_i2c, a plain driver's export
//! landing in an effect uniform through the pool, remove_driver.

#[path = "../../sensor/tests/fake_mpu.rs"]
mod fake_mpu;

use core::ffi::c_void;
use fake_mpu::{FakeBus, FakeMpu};
use ledmapper_pb::ledmapper_::v1_ as pb;
use ledmapper_player_ffi::{
    lm_drv_poll, lm_drv_set_host, lm_fx_load, lm_fx_set_active, lm_fx_shade, lm_fx_update, lm_player_handle,
    lm_player_init, lm_sensor_set_ops, LmDrvHost, LmI2cOps, FEATURES,
};
use ledmapper_sensor::mpu6050::{Config, Raw};
use ledmapper_sensor::{BusError, Hub, I2cBus};
use micropb::{MessageDecode, MessageEncode, PbEncoder};
use pb::ClientMessage_::Msg as CMsg;
use pb::ServerMessage_::Msg as SMsg;
use std::alloc::{alloc_zeroed, dealloc, Layout};
use std::sync::Mutex;

static BUS: Mutex<Option<usize>> = Mutex::new(None);

fn bus() -> &'static mut FakeBus {
    let p = BUS.lock().unwrap().expect("bus");
    unsafe { &mut *(p as *mut FakeBus) }
}

unsafe extern "C" fn wr(_: *mut c_void, addr: u8, w: *const u8, wn: usize, r: *mut u8, rn: usize) -> i32 {
    match bus().write_read(addr, core::slice::from_raw_parts(w, wn), core::slice::from_raw_parts_mut(r, rn)) {
        Ok(()) => 0,
        Err(BusError::Nack) => 1,
        Err(_) => 2,
    }
}
unsafe extern "C" fn w(_: *mut c_void, addr: u8, b: *const u8, n: usize) -> i32 {
    match bus().write(addr, core::slice::from_raw_parts(b, n)) {
        Ok(()) => 0,
        Err(BusError::Nack) => 1,
        Err(_) => 2,
    }
}
struct SyncOps(LmI2cOps);
// SAFETY: ctx is null; the callbacks are plain fns.
unsafe impl Sync for SyncOps {}
static OPS: SyncOps = SyncOps(LmI2cOps { ctx: core::ptr::null_mut(), write_read: Some(wr), write: Some(w), cycles: None });

const ALIGN: usize = 16;
unsafe extern "C" fn h_alloc(n: usize) -> *mut c_void {
    // Size header in front so free knows the layout.
    let p = alloc_zeroed(Layout::from_size_align(n + ALIGN, ALIGN).unwrap());
    *(p as *mut usize) = n;
    p.add(ALIGN) as *mut c_void
}
unsafe extern "C" fn h_free(p: *mut c_void) {
    let base = (p as *mut u8).sub(ALIGN);
    let n = *(base as *mut usize);
    dealloc(base, Layout::from_size_align(n + ALIGN, ALIGN).unwrap());
}
unsafe extern "C" fn h_bus_ensure() -> bool {
    lm_sensor_set_ops(&OPS.0);
    true
}
unsafe extern "C" fn h_scan(out: *mut u8, cap: usize) -> usize {
    let mut n = 0;
    for a in 0x08u8..0x78 {
        if n < cap && bus().write_read(a, &[0x75], &mut [0u8]).is_ok() {
            *out.add(n) = a;
            n += 1;
        }
    }
    n
}
static HOST: LmDrvHost =
    LmDrvHost { alloc: Some(h_alloc), free: Some(h_free), bus_ensure: Some(h_bus_ensure), scan: Some(h_scan), cycles: None };

fn handle(msg: CMsg) -> Option<SMsg> {
    let env = pb::ClientMessage { r#msg: Some(msg) };
    let mut enc = PbEncoder::new(micropb::heapless::Vec::<u8, 8192>::new());
    env.encode(&mut enc).unwrap();
    let frame = enc.into_writer().to_vec();
    let mut out = vec![0u8; 4096];
    let n = unsafe { lm_player_handle(frame.as_ptr(), frame.len(), 0, 0, out.as_mut_ptr(), out.len()) };
    assert!(n > 0, "handle returned {n}");
    let mut reply = pb::ServerMessage::default();
    reply.decode_from_bytes(&out[..n as usize]).expect("reply decodes");
    reply.r#msg
}

fn submit(src: &str, interval_ms: u32, feed_imu: bool) -> pb::DriverState {
    let c = ledmapper_fx_compiler::compile(src).expect("driver compiles");
    let mut m = pb::SubmitDriver { r#poll_interval_ms: interval_ms, r#feed_imu: feed_imu, ..Default::default() };
    m.r#fxb.extend_from_slice(&c.fxb).unwrap();
    match handle(CMsg::SubmitDriver(m)) {
        Some(SMsg::DriverState(s)) => s,
        other => panic!("submit_driver -> {other:?}"),
    }
}

fn driver_state() -> pb::DriverState {
    match handle(CMsg::GetDriverState(pb::GetDriverState::default())) {
        Some(SMsg::DriverState(s)) => s,
        other => panic!("{other:?}"),
    }
}

fn sensors() -> pb::SensorState {
    match handle(CMsg::GetSensors(pb::GetSensors::default())) {
        Some(SMsg::SensorState(s)) => s,
        other => panic!("{other:?}"),
    }
}

const MPU_DRIVER: &str = include_str!("../../sensor/drivers/mpu6050.fx");

/// A lamp swinging about x then y: (accel, gyro) raw counts at 100 Hz.
fn motion(i: usize) -> ([i16; 3], [i16; 3]) {
    let t = i as f32 * 0.01;
    let wx = (t * 2.0).sin() * 0.8; // rad/s
    let wy = (t * 1.3).cos() * 0.5;
    let k = 32.8 * 180.0 / core::f32::consts::PI;
    let ax = (t * 2.0).cos() * 0.3;
    let ay = (t * 1.3).sin() * 0.2;
    ([(ax * 4096.0) as i16, (ay * 4096.0) as i16, 4096], [(wx * k) as i16, (wy * k) as i16, 7])
}

/// One process-global player: everything in order.
#[test]
fn driver_vm_and_the_mpu6050_ab() {
    assert!(FEATURES.contains(&"drivers"));
    lm_player_init(16);
    let b = Box::leak(Box::new(FakeBus::with(FakeMpu::new(0x68, 0x68))));
    b.devs.push(FakeMpu::new(0x40, 0x00)); // some other device on the bus
    *BUS.lock().unwrap() = Some(b as *mut FakeBus as usize);
    unsafe { lm_drv_set_host(&HOST) };

    // scan_i2c sees both devices.
    match handle(CMsg::ScanI2C(pb::ScanI2c::default())) {
        Some(SMsg::I2CScanResult(r)) => assert_eq!(r.r#addresses.as_slice(), &[0x40, 0x68]),
        o => panic!("{o:?}"),
    }
    // An effect is not a driver; a driver is not an effect.
    let fx = ledmapper_fx_compiler::compile("vec3 shade(Led led) { return vec3(0.0); }").unwrap().fxb;
    let mut m = pb::SubmitDriver::default();
    m.r#fxb.extend_from_slice(&fx).unwrap();
    assert!(matches!(handle(CMsg::SubmitDriver(m)), Some(SMsg::Error(e)) if e.r#code.as_str() == "not_a_driver"));
    let drv = ledmapper_fx_compiler::compile(MPU_DRIVER).unwrap().fxb;
    assert!(!unsafe { lm_fx_load(drv.as_ptr(), drv.len()) }, "a driver is refused as an effect");

    // -- (B) the VM backend feeding the native fusion -------------------------
    let st = submit(MPU_DRIVER, 10, true);
    assert!(st.r#running && st.r#feed_imu);
    assert_eq!(st.r#poll_interval_ms, 10);
    assert!(st.r#heap_bytes > 0);
    // (A) the native path, as a reference hub fed the identical samples at the
    // IMU clock (exactly what the native FIFO drain does).
    let mut native = Hub::new(Config::default());
    native.start_external(0x68, 0x68, 0); // no bus: drive ingest directly
    let mut t = 1_000_000u64;
    const N: usize = 400;
    for i in 0..N {
        let (a, g) = motion(i);
        bus().dev().produce(a, g, 0);
        unsafe { lm_drv_poll(t) };
        native.ingest(&Raw { accel: a, gyro: g, temp: None }, 0.01);
        t += 10_000;
    }
    let vm = sensors();
    assert_eq!(vm.r#status, pb::SensorStatus::Running);
    assert_eq!(vm.r#samples as usize, N);
    let nat = native.snapshot();
    // Same samples, dt 10 ms on both sides (the VM side's dt comes from the poll
    // clock): the fused attitude agrees to float rounding.
    for k in 0..4 {
        assert!((vm.r#quat[k] - nat.quat[k]).abs() < 1e-4, "quat {:?} vs {:?}", vm.r#quat, nat.quat);
    }
    for k in 0..3 {
        assert!((vm.r#accel[k] - nat.accel[k]).abs() < 1e-4);
        assert!((vm.r#gyro[k] - nat.gyro[k]).abs() < 1e-4);
    }
    let ds = driver_state();
    assert_eq!(ds.r#polls as usize, N);
    assert_eq!(ds.r#bus_errors, 0);
    assert_eq!(ds.r#last_poll.as_str(), "ok");
    assert_eq!(ds.r#bus_ops, 6, "6 register reads per sample (native FIFO: ~1 transaction per sample)");
    let names: Vec<&str> = ds.r#exports.iter().map(|e| e.r#name.as_str()).collect();
    assert_eq!(names, ["imu_raw_accel", "imu_raw_gyro", "imu_ok"]);
    println!(
        "A/B: VM driver poll = {} VM instrs, {} bus ops/sample, driver slot {} B heap",
        ds.r#poll_instrs_mean, ds.r#bus_ops, ds.r#heap_bytes
    );

    // -- a plain driver: exports reach an effect uniform through the pool -----
    unsafe { lm_drv_poll(t) };
    let st = submit(
        "export float lamp_temp \"°C\";\nvoid poll() { lamp_temp = float(i2c_read8(64, 117)) + 21.5; }",
        20,
        false,
    );
    assert!(st.r#running && !st.r#feed_imu);
    let effect = "uniform float lamp_temp : 0.0 .. 100.0 = 0.0;\nvec3 shade(Led led) { return vec3(lamp_temp / 100.0); }";
    let fxb = ledmapper_fx_compiler::compile(effect).unwrap().fxb;
    assert!(unsafe { lm_fx_load(fxb.as_ptr(), fxb.len()) });
    unsafe { lm_fx_set_active(true) };
    t += 100_000;
    unsafe { lm_drv_poll(t) }; // reads 0x00 -> 21.5 °C, published as lamp_temp
    assert!(unsafe { lm_fx_update(0.0, 0.033, 0, 1) });
    let mut rgb = [0u8; 3];
    assert!(unsafe { lm_fx_shade(0, 0.0, 0.0, 0.0, rgb.as_mut_ptr()) });
    assert!((rgb[0] as i32 - 55).abs() <= 1, "lamp_temp 21.5 -> {rgb:?}");

    // remove_driver frees it.
    match handle(CMsg::RemoveDriver(pb::RemoveDriver::default())) {
        Some(SMsg::DriverState(s)) => assert!(!s.r#running),
        o => panic!("{o:?}"),
    }
}
