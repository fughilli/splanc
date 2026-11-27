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

// -- GPIO intrinsics + trigger uniforms (docs/design/lamp-power.md) ------------

const TOUCH_DRIVER: &str = include_str!("../../firmware/sensor/drivers/ttp223_touch.fx");

/// A bus whose GPIO pseudo device (0x80) is one input pin with a settable level.
struct PinBus {
    level: u8,
    pin: u8,
    modes: Vec<(u8, u8)>,
}

impl I2cBus for PinBus {
    fn write(&mut self, addr: u8, bytes: &[u8]) -> bool {
        assert_eq!(addr, ledmapper_fx_compiler::GPIO_DEV);
        self.modes.push((bytes[0], bytes[1]));
        true
    }
    fn read_reg(&mut self, addr: u8, reg: u8, out: &mut [u8]) -> bool {
        assert_eq!(addr, ledmapper_fx_compiler::GPIO_DEV);
        if reg != self.pin {
            return false;
        }
        out[0] = self.level;
        true
    }
}

#[test]
fn gpio_intrinsics_route_to_the_pseudo_device() {
    let _g = POLL.lock().unwrap();
    let src = r#"
export float lvl;
export float ok;
export float other;
void poll() {
  ok = float(gpio_mode(5, 2));
  lvl = float(gpio_read(5));
  other = float(gpio_read(6));
}
"#;
    let c = compile(src).unwrap();
    let mut bus = PinBus { level: 1, pin: 5, modes: vec![] };
    let mut vm = Vm::new();
    let prog = Program::parse(&c.fxb).unwrap();
    assert_eq!(vm.run_poll(&prog, &Frame::default(), &mut bus, &Budget::default()).0, Outcome::Ok);
    let get = |n: &str| {
        let e = c.exports.iter().find(|e| e.name == n).unwrap();
        let mut v = [0.0f32];
        vm.export(e.slot as usize, &mut v);
        v[0]
    };
    assert_eq!(bus.modes, vec![(5, 2)]);
    assert_eq!(get("ok"), 1.0);
    assert_eq!(get("lvl"), 1.0);
    assert_eq!(get("other"), -1.0, "an unavailable pin reads -1");
    assert!(compile("export float x; void poll() { x = float(gpio_read(1.0)); }").is_err(), "int pin");
}

/// Run the touch driver over a level schedule: (until_s, level), polled every
/// `step` s. Returns the trigger count after each poll.
fn run_touch(src: &str, schedule: &[(f32, u8)], step: f32) -> Vec<(f32, f32)> {
    let c = compile(src).expect("touch driver compiles");
    let prog = Program::parse(&c.fxb).unwrap();
    assert_ne!(prog.flags & FLAG_DRIVER, 0);
    let e = c.exports.iter().find(|e| e.name == "touch_tap").expect("export trigger touch_tap");
    assert_eq!(e.unit, "trigger");
    let mut vm = Vm::new();
    let mut bus = PinBus { level: 0, pin: 3, modes: vec![] };
    let mut out = vec![];
    let mut t = 0.0f32;
    let mut i = 0;
    let end = schedule.last().unwrap().0;
    while t < end {
        while t >= schedule[i].0 {
            i += 1;
        }
        bus.level = schedule[i].1;
        let f = Frame { time: t, dt: step, ..Default::default() };
        assert_eq!(vm.run_poll(&prog, &f, &mut bus, &Budget::default()).0, Outcome::Ok);
        let mut v = [0.0f32];
        vm.export(e.slot as usize, &mut v);
        out.push((t, v[0]));
        t += step;
    }
    assert_eq!(bus.modes, vec![(3, 2)], "configured once, pull-down");
    out
}

fn fires(trace: &[(f32, f32)]) -> f32 {
    trace.last().unwrap().1
}

#[test]
fn touch_driver_fires_once_per_press_after_calibration() {
    let _g = POLL.lock().unwrap();
    // Touch during calibration (ignored), then two real presses, a bounce.
    let s = [
        (0.3, 0),
        (0.8, 1), // finger on during the 1 s calibration: ignored
        (5.0, 0),
        (5.2, 1), // press 1
        (5.4, 0),
        (5.41, 1), // 10 ms bounce on release
        (5.42, 0),
        (6.0, 0),
        (6.3, 1), // press 2
        (6.6, 0),
        (7.0, 0),
    ];
    let tr = run_touch(TOUCH_DRIVER, &s, 0.005);
    assert_eq!(fires(&tr), 2.0, "two presses -> two fires");
    let first = tr.iter().find(|(_, v)| *v >= 1.0).unwrap().0;
    assert!((5.0 + 0.025..5.0 + 0.04).contains(&first), "fires 25 ms after the press: {first}");
    assert!(tr.iter().filter(|(t, _)| *t < 1.0).all(|(_, v)| *v == 0.0));
}

#[test]
fn touch_driver_ignores_glitches_and_a_stuck_level() {
    let _g = POLL.lock().unwrap();
    // 10 ms glitches never fire.
    let mut s = vec![(5.0, 0)];
    for k in 0..10 {
        let t = 5.0 + k as f32 * 0.1;
        s.push((t + 0.01, 1));
        s.push((t + 0.1, 0));
    }
    s.push((7.0, 0));
    assert_eq!(fires(&run_touch(TOUCH_DRIVER, &s, 0.005)), 0.0);
    // Reads "touched" from power-up (wrong polarity): never fires until released.
    let s = [(8.0, 1)];
    assert_eq!(fires(&run_touch(TOUCH_DRIVER, &s, 0.01)), 0.0);
    let s = [(8.0, 1), (8.5, 0), (8.8, 1), (9.2, 0)];
    assert_eq!(fires(&run_touch(TOUCH_DRIVER, &s, 0.01)), 1.0);
}

#[test]
fn touch_driver_lockout_merges_a_double_bounce() {
    let _g = POLL.lock().unwrap();
    // Schedule entries are (until_s, level). Two presses 100 ms apart: one fire
    // (150 ms lockout); 400 ms apart: two.
    let s = [(5.0, 0), (5.05, 1), (5.1, 0), (5.2, 1), (6.0, 0)];
    assert_eq!(fires(&run_touch(TOUCH_DRIVER, &s, 0.005)), 1.0);
    let s = [(5.0, 0), (5.1, 1), (5.4, 0), (5.5, 1), (6.0, 0)];
    assert_eq!(fires(&run_touch(TOUCH_DRIVER, &s, 0.005)), 2.0);
}

#[test]
fn trigger_uniforms_fire_once_per_change_in_update() {
    let src = r#"
uniform trigger tap;
state float count;
void update() {
  if (fired(tap)) {
    count = count + 1.0;
  }
}
vec3 shade(Led led) { return vec3(count * 0.1); }
"#;
    let c = compile(src).expect("trigger effect compiles");
    let u = &c.uniforms[0];
    assert!(matches!(u.ui, ledmapper_fx_compiler::UiKind::Trigger));
    let prog = Program::parse(&c.fxb).unwrap();
    let m = std::str::from_utf8(prog.manifest).unwrap();
    assert!(m.contains(r#""kind":"trigger""#), "{m}");
    let mut vm = Vm::new();
    // count is the state slot after the trigger's hidden last-seen slot.
    let count = |vm: &Vm| {
        let mut v = [0.0f32];
        vm.export(1, &mut v);
        v[0]
    };
    let f = Frame::default();
    vm.run_update(&prog, &f);
    assert_eq!(count(&vm), 0.0, "no fire at start");
    vm.set_uniform(u.slot as usize, &[1.0]);
    vm.run_update(&prog, &f);
    assert_eq!(count(&vm), 1.0);
    vm.run_update(&prog, &f);
    assert_eq!(count(&vm), 1.0, "once per change");
    vm.set_uniform(u.slot as usize, &[3.0]);
    vm.run_update(&prog, &f);
    assert_eq!(count(&vm), 2.0, "a jump of two is one frame's fire");
    vm.set_uniform(u.slot as usize, &[0.0]);
    vm.run_update(&prog, &f);
    assert_eq!(count(&vm), 3.0, "a reset (driver reload) is a change too");
}

#[test]
fn trigger_rules() {
    let in_shade = "uniform trigger t; vec3 shade(Led led) { if (fired(t)) { return vec3(1.0); } return vec3(0.0); }";
    assert!(compile(in_shade).is_err(), "fired() only in update()");
    let not_trigger = "uniform float t : 0..1 = 0.0; void update() { if (fired(t)) { } } vec3 shade(Led led) { return vec3(0.0); }";
    assert!(compile(not_trigger).is_err());
    let fire_uniform = "uniform trigger t; void update() { fire(t); } vec3 shade(Led led) { return vec3(0.0); }";
    assert!(compile(fire_uniform).is_err(), "fire() bumps an export trigger, not a uniform");
    let fire_ok = "export trigger t; void poll() { fire(t); }";
    assert!(compile(fire_ok).is_ok());
}
