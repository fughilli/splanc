/**
 * The motion-sensor tools through the bridge (docs/design/sensor-core.md):
 * read_sensors (absent / running, shaped degrees + vectors, a short series),
 * calibrate_sensors waiting for the device to apply the action, and the feature
 * gate (firmware without "sensors" -> a clear tool error). Skipped as a whole
 * when this bundle's protocol predates the sensor arms.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, before, beforeEach, test } from "node:test";

import { loadFxHost } from "../src/fxhost";
import { DeviceSession, DRIVERS_IN_PROTO, SENSORS_IN_PROTO } from "../src/session";
import { nodeSocketFactory } from "../src/socket";
import { FakePlayer, TEST_CERT_SHA256 } from "./fakePlayer";

const skip = SENSORS_IN_PROTO ? false : "this bundle's protocol has no sensor arms yet";

let player: FakePlayer;

async function connect(features: string[]): Promise<DeviceSession> {
  const s = new DeviceSession({
    url: `wss://${player.host}/ws`,
    socketFactory: nodeSocketFactory({ pinSha256: TEST_CERT_SHA256 }),
    features,
  });
  await s.connect();
  return s;
}

before(async () => {
  await loadFxHost(process.env["AGENT_WASM_ROOT"] ?? "wasm");
});

beforeEach(async () => {
  player = new FakePlayer();
  await player.start();
});

afterEach(async () => {
  await player.stop();
});

// Lamp tipped 30° about x: down = (0, -sin30, -cos30) in the sensor's z-up frame.
const RUNNING = {
  status: "SENSOR_STATUS_RUNNING",
  part: "MPU-6050",
  i2cAddress: 0x68,
  whoAmI: 0x68,
  sdaGpio: 6,
  sclGpio: 7,
  accel: [0, 4.903, 8.493],
  gyro: [0, 0, 0],
  quat: [Math.cos(Math.PI / 12), Math.sin(Math.PI / 12), 0, 0],
  gravity: [0, -0.5, -0.866],
  linearAccel: [0, 0, 0],
  shake: 0.1,
  tapCount: 3,
  shakeCount: 1,
  atRest: true,
  sampleRateHz: 100,
  samples: 1234,
  fifo: true,
  calibrationSeq: 0,
};

test("absent sensor reads as absent, with the probed pins", { skip }, async () => {
  const s = await connect(["sensors"]);
  const r = await s.readSensors();
  assert.deepEqual(r, { status: "absent", pins: { sda: 6, scl: 7, int: 21 } });
  s.close();
});

test("running sensor: euler degrees, tilt, vectors, counters", { skip }, async () => {
  player.sensor = { ...RUNNING };
  const s = await connect(["sensors"]);
  const r = await s.readSensors();
  assert.equal(r["status"], "running");
  assert.equal(r["part"], "MPU-6050");
  assert.equal(r["i2c_address"], "0x68");
  const e = r["euler_deg"] as { roll: number; pitch: number; yaw: number };
  assert.ok(Math.abs(e.roll - 30) < 0.2 && Math.abs(e.pitch) < 0.2 && Math.abs(e.yaw) < 0.2, JSON.stringify(e));
  assert.ok(Math.abs((r["tilt_deg"] as number) - 30) < 0.2);
  assert.equal(r["taps"], 3);
  const series = await s.readSensorSeries(3, 20);
  assert.equal(series.length, 3);
  assert.ok((series[2]!["t_ms"] as number) >= 30);
  s.close();
});

test("calibrate_sensors waits for the device to apply it", { skip }, async () => {
  player.sensor = { ...RUNNING };
  const s = await connect(["sensors"]);
  const r = await s.calibrateSensors("level");
  assert.equal(r["action"], "level");
  assert.equal(r["result"], "ok");
  assert.equal((r["state"] as Record<string, unknown>)["calibrated"], true);
  const sent = player.received.find((m) => m.type === "calibrate_sensors");
  assert.equal(sent?.["action"], "ACTION_LEVEL");
  s.close();
});

test("firmware without the feature gets a clear error", { skip }, async () => {
  const s = await connect([]);
  await assert.rejects(s.readSensors(), /no sensor core/);
  s.close();
});

const skipDrivers = DRIVERS_IN_PROTO ? false : "this bundle's protocol has no driver arms yet";

test("drivers: scan, deploy (compiled here), state, remove", { skip: skipDrivers }, async () => {
  const s = await connect(["drivers"]);
  assert.deepEqual(await s.scanI2c(), { addresses: ["0x40", "0x68"] });
  const src = "export float t;\nvoid poll() { t = float(i2c_read8(64, 0)); }";
  const r = await s.deployDriver(src, 20, false);
  assert.equal(r["running"], true);
  assert.deepEqual(r["exports"], { imu_ok: 1 });
  const sent = player.received.find((m) => m.type === "submit_driver")!;
  assert.equal(sent["pollIntervalMs"], 20);
  assert.ok(String(sent["fxb"]).length > 0, "compiled bytecode went out");
  // A compile error never reaches the device.
  await assert.rejects(s.deployDriver("export float t; void poll() { t = ; }", 10, false), /doesn't compile/);
  assert.equal((await s.driverState())["running"], true);
  assert.deepEqual(await s.removeDriver(), { running: false });
  s.close();
});

test("the MPU-6050 driver source compiles in the agent's toolchain", { skip: skipDrivers }, async () => {
  const p = join(process.cwd(), "../firmware/sensor/drivers/mpu6050.fx");
  let src: string;
  try {
    src = readFileSync(p, "utf8");
  } catch {
    return; // not in this test's runfiles
  }
  const s = await connect(["drivers"]);
  const r = await s.deployDriver(src, 10, true);
  assert.equal(r["running"], true);
  s.close();
});
