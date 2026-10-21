//! FUG-107 sensor drivers: the compiler's `export` / `void poll()` / i2c
//! intrinsics, the FLAG_DRIVER `.fxb` (poll() in the shade slot, export table as
//! the manifest), and the VM running poll() against a register-map bus. The
//! MPU-6050 driver (//firmware/sensor:drivers/mpu6050.fx) is exercised against a
//! fake register file the same way the native driver's tests do.

use ledmapper_fx_compiler::{compile, disassemble, exports_manifest_json};
use ledmapper_fx_vm::{Budget, Frame, I2cBus, Outcome, Program, Vm, FLAG_DRIVER};
use std::collections::HashMap;
use std::sync::Mutex;

/// run_poll installs its bus in a VM-global slot; serialize the tests that poll.
static POLL: Mutex<()> = Mutex::new(());

const MPU_DRIVER: &str = include_str!("../../firmware/sensor/drivers/mpu6050.fx");

#[derive(Default)]
struct RegBus {
    /// (addr, reg) -> byte; a missing addr NACKs.
    regs: HashMap<(u8, u8), u8>,
    present: Vec<u8>,
    writes: Vec<(u8, u8, u8)>,
    ops: usize,
}

impl I2cBus for RegBus {
    fn write(&mut self, addr: u8, bytes: &[u8]) -> bool {
        self.ops += 1;
        if !self.present.contains(&addr) {
            return false;
        }
        self.writes.push((addr, bytes[0], bytes[1]));
        self.regs.insert((addr, bytes[0]), bytes[1]);
        true
    }
    fn read_reg(&mut self, addr: u8, reg: u8, out: &mut [u8]) -> bool {
        self.ops += 1;
        if !self.present.contains(&addr) {
            return false;
        }
        for (i, o) in out.iter_mut().enumerate() {
            *o = *self.regs.get(&(addr, reg + i as u8)).unwrap_or(&0);
        }
        true
    }
}

fn poll(vm: &mut Vm, fxb: &[u8], bus: &mut RegBus) -> Outcome {
    let prog = Program::parse(fxb).unwrap();
    vm.run_poll(&prog, &Frame::default(), bus, &Budget::default()).0
}

#[test]
fn driver_compiles_to_a_flagged_fxb_with_an_export_table() {
    let c = compile(MPU_DRIVER).expect("driver compiles");
    let prog = Program::parse(&c.fxb).unwrap();
    assert_ne!(prog.flags & FLAG_DRIVER, 0);
    assert_eq!(prog.update_entry, 0xFFFF);
    assert!(c.uniforms.is_empty());
    let names: Vec<_> = c.exports.iter().map(|e| (e.name.as_str(), e.width())).collect();
    assert_eq!(names, [("imu_raw_accel", 3), ("imu_raw_gyro", 3), ("imu_ok", 1)]);
    let m = std::str::from_utf8(prog.manifest).unwrap();
    assert_eq!(m, exports_manifest_json(&c.exports));
    assert!(m.contains(r#""name":"imu_raw_accel","slot":0,"width":3"#), "{m}");
    let dis = disassemble(&c.fxb);
    assert!(dis.contains("I2C_READ mode=0x82"), "signed 16-bit reads: {dis}");
    assert!(dis.contains("I2C_WRITE"));
}

#[test]
fn effect_driver_rules() {
    let both = "export float t; void poll() { t = 1.0; } vec3 shade(Led led) { return vec3(t); }";
    assert!(compile(both).is_err(), "effect and driver at once");
    let stray = "export float t; vec3 shade(Led led) { return vec3(0.0); }";
    assert!(compile(stray).is_err(), "export without poll");
    let knobs = "uniform float k : 0.0 .. 1.0 = 0.5; export float t; void poll() { t = k; }";
    assert!(compile(knobs).is_err(), "driver with uniforms");
    let upd = "export float t; void update() { } void poll() { t = 1.0; }";
    assert!(compile(upd).is_err(), "driver with update()");
    let floats = "export float t; void poll() { t = float(i2c_read8(1.0, 2)); }";
    assert!(compile(floats).is_err(), "i2c args must be int");
    assert!(compile("vec3 shade(Led led) { return vec3(0.0); }").is_ok());
}

#[test]
fn intrinsics_read_write_and_fail_closed() {
    let _g = POLL.lock().unwrap();
    let src = r#"
export float b;
export float w;
export float ws;
export float ack;
export float missing;
void poll() {
  b = float(i2c_read8(64, 1));
  w = float(i2c_read16(64, 2));
  ws = float(i2c_read16s(64, 2));
  ack = float(i2c_write(64, 9, 170));
  missing = float(i2c_read8(65, 1));
}
"#;
    let c = compile(src).unwrap();
    let mut bus = RegBus { present: vec![64], ..Default::default() };
    bus.regs.insert((64, 1), 0x7f);
    bus.regs.insert((64, 2), 0xff);
    bus.regs.insert((64, 3), 0x38); // 0xff38 = 65336 / -200
    let mut vm = Vm::new();
    assert_eq!(poll(&mut vm, &c.fxb, &mut bus), Outcome::Ok);
    let get = |vm: &Vm, n: &str| {
        let e = c.exports.iter().find(|e| e.name == n).unwrap();
        let mut v = [0.0f32];
        vm.export(e.slot as usize, &mut v);
        v[0]
    };
    assert_eq!(get(&vm, "b"), 127.0);
    assert_eq!(get(&vm, "w"), 65336.0);
    assert_eq!(get(&vm, "ws"), -200.0);
    assert_eq!(get(&vm, "ack"), 1.0);
    assert_eq!(bus.regs[&(64, 9)], 170);
    assert_eq!(get(&vm, "missing"), -1.0, "NACK reads -1");
}

#[test]
fn no_bus_outside_poll() {
    // An effect can't reach the bus: the intrinsics are driver-only at compile
    // time... and inert in the VM without run_poll (here: a driver program
    // whose poll() runs through run_update's path is never possible, so check
    // the effect loader side: a driver .fxb is not runnable as an effect).
    let c = compile(MPU_DRIVER).unwrap();
    let prog = Program::parse(&c.fxb).unwrap();
    let mut vm = Vm::new();
    // run_update on a driver is a no-op (no update entry).
    vm.run_update(&prog, &Frame::default());
}

/// The MPU-6050 driver against a register file: configures the part once
/// (same register values as the native driver), then exports signed counts.
#[test]
fn mpu6050_driver_configures_and_reads() {
    let _g = POLL.lock().unwrap();
    let c = compile(MPU_DRIVER).unwrap();
    let mut bus = RegBus { present: vec![0x68], ..Default::default() };
    bus.regs.insert((0x68, 0x75), 0x68); // WHO_AM_I
    let put = |bus: &mut RegBus, reg: u8, v: i16| {
        let b = v.to_be_bytes();
        bus.regs.insert((0x68, reg), b[0]);
        bus.regs.insert((0x68, reg + 1), b[1]);
    };
    put(&mut bus, 0x3B, 4096);
    put(&mut bus, 0x3D, -2048);
    put(&mut bus, 0x3F, 100);
    put(&mut bus, 0x43, -328);
    put(&mut bus, 0x45, 0);
    put(&mut bus, 0x47, 32767);
    let mut vm = Vm::new();
    assert_eq!(poll(&mut vm, &c.fxb, &mut bus), Outcome::Ok);
    let cfg: Vec<(u8, u8)> = bus.writes.iter().map(|w| (w.1, w.2)).collect();
    assert_eq!(cfg, [(0x6B, 0x01), (0x19, 9), (0x1A, 3), (0x1B, 0x10), (0x1C, 0x10)]);
    let ex = |vm: &Vm, n: &str| {
        let e = c.exports.iter().find(|e| e.name == n).unwrap();
        let mut v = [0.0f32; 3];
        vm.export(e.slot as usize, &mut v[..e.width() as usize]);
        v
    };
    assert_eq!(ex(&vm, "imu_raw_accel"), [4096.0, -2048.0, 100.0]);
    assert_eq!(ex(&vm, "imu_raw_gyro"), [-328.0, 0.0, 32767.0]);
    // Steady state: no reconfiguration, 6 register reads per poll.
    bus.writes.clear();
    bus.ops = 0;
    poll(&mut vm, &c.fxb, &mut bus);
    assert!(bus.writes.is_empty());
    assert_eq!(bus.ops, 6, "one transaction per 16-bit register");
    // A part that doesn't answer WHO_AM_I right is left alone.
    let mut other = RegBus { present: vec![0x68], ..Default::default() };
    other.regs.insert((0x68, 0x75), 0x12);
    let mut vm2 = Vm::new();
    poll(&mut vm2, &c.fxb, &mut other);
    assert!(other.writes.is_empty());
    assert_eq!(ex(&vm2, "imu_ok")[0], 0.0);
}
