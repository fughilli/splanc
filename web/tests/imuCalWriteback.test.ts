/** Calibrate IMU write-back (sensor-core.md §7.3): write + read-back
 * confirmation, the per-device pending store, the push on reconnect, and a
 * disconnect in the middle of the write. */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PendingImuCalStore,
  deviceKeyOf,
  mountMatches,
  pushPendingImuCal,
  writeAndVerify,
  type KeyValueStorage,
  type MountClient,
  type MountReadback,
  type PendingImuCal,
} from "../src/capture/imuCalWriteback";
import { pushPendingOnConnect } from "../src/capture/imuCalReconnect";
import { axisAngle } from "../src/geom/imuExtrinsic";

class MemStorage implements KeyValueStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** A fake fixture: set_sensor_mount is posted to a mailbox and applied
 * `applyAfter` get_sensors later (like the sensor task's next poll), stored as
 * f32 with whole-second timestamps, and survives "reboots". */
class FakeFixture implements MountClient {
  isConnected = true;
  applyAfter = 1;
  /** Drop the link when the next set_sensor_mount arrives: before it is posted
   * ("before") or after it is posted but before the reply ("after"). */
  dropOnWrite: "before" | "after" | null = null;
  refuse = false;
  writes = 0;
  private pending: { q: number[]; poses: number; yaw: boolean; at: number } | null = null;
  private countdown = 0;
  mount: MountReadback = {
    status: "SENSOR_STATUS_RUNNING",
    mountQuat: [1, 0, 0, 0],
    mountExtrinsic: false,
    mountYawResolved: false,
    mountPoses: 1,
    mountCalibratedAtMs: 0,
    calibrationSeq: 0,
  };

  async setSensorMount(quat: number[], meta: { residualDeg: number; poses: number; yawResolved: boolean; atMs?: number }) {
    if (!this.isConnected) throw new Error("not connected");
    if (this.refuse) throw Object.assign(new Error("bad_mount"), { code: "bad_mount" });
    this.writes++;
    if (this.dropOnWrite === "before") {
      this.isConnected = false;
      this.dropOnWrite = null;
      throw new Error("socket closed");
    }
    const before = { ...this.mount };
    this.pending = { q: quat.map((v) => Math.fround(v)), poses: meta.poses, yaw: meta.yawResolved, at: Math.floor((meta.atMs ?? 0) / 1000) * 1000 };
    this.countdown = this.applyAfter;
    if (this.dropOnWrite === "after") {
      this.applyNow();
      this.isConnected = false;
      this.dropOnWrite = null;
      throw new Error("socket closed");
    }
    return before;
  }

  private applyNow() {
    if (!this.pending) return;
    this.mount = {
      ...this.mount,
      mountQuat: this.pending.q,
      mountExtrinsic: true,
      mountYawResolved: this.pending.yaw,
      mountPoses: this.pending.poses,
      mountCalibratedAtMs: this.pending.at,
      calibrationSeq: (this.mount.calibrationSeq ?? 0) + 1,
    };
    this.pending = null;
  }

  async getSensors() {
    if (!this.isConnected) throw new Error("not connected");
    if (this.pending && --this.countdown < 0) this.applyNow();
    return { ...this.mount };
  }
}

const cal = (over: Partial<PendingImuCal> = {}): PendingImuCal => ({
  deviceKey: "8C:FD:49:10:3A:86",
  mapId: "m-lamp",
  q: axisAngle([0.3, -1, 0.5], 2.0),
  residualDeg: 0.6,
  poses: 3,
  yawResolved: true,
  atMs: 1_792_000_123_456,
  ...over,
});
const fast = { sleep: async () => undefined, pollMs: 0 };

test("device keys are the welcome MAC, normalized", () => {
  assert.equal(deviceKeyOf(" 8c:fd:49:10:3a:86 "), "8C:FD:49:10:3A:86");
  assert.equal(deviceKeyOf(undefined), "");
});

test("write is confirmed only by a matching read-back", async () => {
  const dev = new FakeFixture();
  dev.applyAfter = 2; // the reply is the state BEFORE; it lands a couple of polls later
  const out = await writeAndVerify(dev, cal(), fast);
  assert.deepEqual(out, { kind: "confirmed", wrote: true });
  assert.ok(mountMatches(dev.mount, cal()));
  // Already there: confirmed without writing again.
  const again = await writeAndVerify(dev, cal(), fast);
  assert.deepEqual(again, { kind: "confirmed", wrote: false });
  assert.equal(dev.writes, 1);
});

test("a read-back that never matches is a mismatch, not a success", async () => {
  const dev = new FakeFixture();
  dev.applyAfter = 1e9; // the sensor task never applies it
  let t = 0;
  const out = await writeAndVerify(dev, cal(), { ...fast, now: () => (t += 500), verifyTimeoutMs: 2000 });
  assert.equal(out.kind, "mismatch");
  dev.refuse = true;
  assert.equal((await writeAndVerify(dev, cal(), fast)).kind, "mismatch", "a server error reply is a refusal");
});

test("mountMatches checks the rotation, yaw flag, pose count and timestamp", () => {
  const c = cal();
  const ok: MountReadback = {
    mountQuat: c.q.map((v) => -v), // q and -q are the same rotation
    mountExtrinsic: true,
    mountYawResolved: true,
    mountPoses: 3,
    mountCalibratedAtMs: 1_792_000_123_000,
  };
  assert.ok(mountMatches(ok, c));
  assert.ok(!mountMatches({ ...ok, mountYawResolved: false }, c), "yaw un-resolved (e.g. a new map)");
  assert.ok(!mountMatches({ ...ok, mountPoses: 1 }, c));
  assert.ok(!mountMatches({ ...ok, mountCalibratedAtMs: 1_000 }, c), "an older calibration");
  assert.ok(!mountMatches({ ...ok, mountQuat: axisAngle([0, 1, 0], 0.1) }, c));
});

test("pending store: per device, survives a reload, cleared only for the same solve", () => {
  const mem = new MemStorage();
  const a = new PendingImuCalStore(mem);
  a.put(cal());
  a.put(cal({ deviceKey: "AA:BB:CC:00:00:01", mapId: "m-other" }));
  const b = new PendingImuCalStore(mem); // the app restarted
  assert.equal(b.all().length, 2);
  assert.equal(b.get("8C:FD:49:10:3A:86")?.mapId, "m-lamp");
  b.clear("8C:FD:49:10:3A:86", 1); // a different (older) solve: kept
  assert.ok(b.get("8C:FD:49:10:3A:86"));
  b.clear("8C:FD:49:10:3A:86", cal().atMs);
  assert.equal(b.get("8C:FD:49:10:3A:86"), null);
  assert.ok(b.get("AA:BB:CC:00:00:01"));
  // Broken storage never throws.
  const broken = new PendingImuCalStore({
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => undefined,
  });
  broken.put(cal());
  assert.equal(broken.get(cal().deviceKey), null);
});

test("disconnect mid-write (before it reached the device): pending, pushed on reconnect", async () => {
  const store = new PendingImuCalStore(new MemStorage());
  const dev = new FakeFixture();
  const c = cal();
  store.put(c); // the screen records it BEFORE writing
  dev.dropOnWrite = "before";
  const out = await writeAndVerify(dev, c, fast);
  assert.equal(out.kind, "failed");
  assert.ok(store.get(c.deviceKey), "still pending");
  assert.ok(!dev.mount.mountExtrinsic);
  // Still offline: a push attempt fails and keeps it.
  assert.equal((await pushPendingImuCal(dev, store, c.deviceKey, fast)).kind, "failed");
  assert.ok(store.get(c.deviceKey));
  // Reconnect.
  dev.isConnected = true;
  const r = await pushPendingImuCal(dev, store, c.deviceKey, fast);
  assert.equal(r.kind, "confirmed");
  assert.equal(store.get(c.deviceKey), null, "cleared once confirmed");
  assert.ok(mountMatches(dev.mount, c));
});

test("disconnect after the device took it (reply lost): reconnect confirms without re-sending", async () => {
  const store = new PendingImuCalStore(new MemStorage());
  const dev = new FakeFixture();
  const c = cal();
  store.put(c);
  dev.dropOnWrite = "after";
  assert.equal((await writeAndVerify(dev, c, fast)).kind, "failed");
  assert.equal(dev.writes, 1);
  dev.isConnected = true; // ...it rebooted and came back: NVS kept the mount
  const r = await pushPendingImuCal(dev, store, c.deviceKey, fast);
  assert.deepEqual(r.kind === "confirmed" && r.wrote, false);
  assert.equal(dev.writes, 1, "nothing re-sent");
  assert.equal(store.get(c.deviceKey), null);
});

test("a pending calibration for another map is dropped, not pushed", async () => {
  const store = new PendingImuCalStore(new MemStorage());
  const dev = new FakeFixture();
  store.put(cal());
  const r = await pushPendingImuCal(dev, store, cal().deviceKey, { ...fast, deviceMapId: async () => "m-new" });
  assert.equal(r.kind, "stale");
  assert.equal(dev.writes, 0);
  assert.equal(store.get(cal().deviceKey), null);
  // Unknown map id (probe failed): pushed.
  store.put(cal());
  const r2 = await pushPendingImuCal(dev, store, cal().deviceKey, {
    ...fast,
    deviceMapId: async () => {
      throw new Error("busy");
    },
  });
  assert.equal(r2.kind, "confirmed");
});

test("pushPendingOnConnect: only for that device, only with imu_extrinsic, once per connection", async () => {
  const store = new PendingImuCalStore(new MemStorage());
  store.put(cal());
  const dev = Object.assign(new FakeFixture(), {
    welcome: { mac: "aa:bb:cc:00:00:09", features: ["imu_extrinsic"] } as { mac?: string; features?: string[] },
  });
  assert.equal(await pushPendingOnConnect(dev, { store }), "none", "another device: nothing to push");
  dev.welcome = { mac: "8c:fd:49:10:3a:86", features: [] };
  assert.equal(await pushPendingOnConnect(dev, { store }), "unsupported");
  assert.ok(store.get(cal().deviceKey), "kept for a firmware that can take it");
  dev.welcome = { mac: "8c:fd:49:10:3a:86", features: ["imu_extrinsic"] };
  const notes: string[] = [];
  const [a, b] = await Promise.all([
    pushPendingOnConnect(dev, { store, notify: (t) => notes.push(t) }),
    pushPendingOnConnect(dev, { store }),
  ]);
  assert.deepEqual([a, b].sort(), ["busy", "confirmed"]);
  assert.equal(dev.writes, 1);
  assert.equal(notes.length, 1);
  assert.equal(store.get(cal().deviceKey), null);
  // The app moved on to another device before the delay elapsed: skipped.
  store.put(cal({ atMs: cal().atMs + 5000 }));
  assert.equal(await pushPendingOnConnect(dev, { store, isCurrent: () => false }), "gone");
});
