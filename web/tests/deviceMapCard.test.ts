/**
 * The Maps tab's "On <device>" card logic (src/store/deviceMap.ts): what the
 * connected device holds, whether this phone already has it, and getting it
 * here: Save, Preview and Calibrate IMU (which needs a library copy, so a
 * fresh install pulls the device's map first).
 *
 * Drives the production LedMapperClient (through appState.connect) against a
 * simulated player speaking the protobuf wire (tests/deviceFakes.ts), with an
 * in-memory library that dedupes by map id like mapStore. Timers are mocked;
 * replies are microtasks drained by settle().
 */

import assert from "node:assert/strict";
import { after, afterEach, beforeEach, mock, test } from "node:test";
import type { OutputMap, Topology } from "@ledmapper/protocol";
import { installFakeDom } from "./fakeDom";

const dom = installFakeDom();
mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
after(() => mock.timers.reset());

import { encodeMappingBundle, type MappingBundle } from "../src/net/proto";
import {
  DeviceMapService,
  deviceCalibrationRoute,
  deviceImuReady,
  ledCounts,
  parseBundleHeader,
  type DeviceMapLibrary,
  type LocalMapRef,
} from "../src/store/deviceMap";
import { appState } from "../src/ui/app/state";
import { FakeLan, settle, type FakePlayer } from "./deviceFakes";

// -- fixtures --------------------------------------------------------------------

function outputMap(mapId: string, leds: number, unmapped: number[] = [], createdAt = ""): OutputMap {
  return {
    mapId,
    createdAt,
    units: "meters",
    frame: "gravity_leveled",
    ledCount: leds,
    leds: Array.from({ length: leds }, (_, i) => i)
      .filter((i) => !unmapped.includes(i))
      .map((i) => ({ id: i, xyz: [i * 0.05, 0.2, 0], confidence: 0, nViews: 0, rmsReprojPx: 0, parallaxDeg: 0 })),
    unmapped,
    trajectory: [],
    stats: { rmsReprojPxGlobal: 0, medianParallaxDeg: 0, warnings: [] },
  } as unknown as OutputMap;
}

const topology = (mapId: string): Topology => ({ mapId, branchPoints: [], segments: [], associations: [] });

function bundleBytes(mapId: string, leds: number, unmapped: number[] = [], createdAt = ""): Uint8Array {
  return encodeMappingBundle({ map: outputMap(mapId, leds, unmapped, createdAt), topology: topology(mapId) });
}

/** An in-memory library with mapStore's dedupe-by-map-id. */
class MemoryLibrary implements DeviceMapLibrary {
  readonly maps = new Map<string, { ref: LocalMapRef; mapId: string }>();
  imports = 0;
  private next = 1;
  add(mapId: string, name = `local ${mapId}`): string {
    const id = `m${this.next++}`;
    this.maps.set(id, { ref: { id, name }, mapId });
    return id;
  }
  async findByMapId(mapId: string): Promise<LocalMapRef | undefined> {
    for (const m of this.maps.values()) if (m.mapId === mapId) return m.ref;
    return undefined;
  }
  async importBundleObject(bundle: MappingBundle): Promise<string> {
    this.imports++;
    const hit = await this.findByMapId(bundle.map.mapId);
    return hit ? hit.id : this.add(bundle.map.mapId, "pulled");
  }
}

const FEATURES = ["effects", "stored_map", "sensors", "imu_extrinsic"];

let lan: FakeLan;
let restoreWs: () => void = () => undefined;
let lib: MemoryLibrary;
let svc: DeviceMapService;

beforeEach(() => {
  dom.document.hidden = true; // park the background liveness prober
  localStorage.clear();
  lan = new FakeLan();
  restoreWs = lan.install();
  lib = new MemoryLibrary();
  svc = new DeviceMapService(lib, { autoPullMaxBytes: 4096 });
});

afterEach(async () => {
  appState.disconnect();
  await settle();
  restoreWs();
  localStorage.clear();
});

async function connect(setup: (p: FakePlayer) => void, host = "10.0.0.90"): Promise<FakePlayer> {
  const player = lan.add(host, { mac: "AA:BB:CC:00:00:90", deviceName: "Porch Light" });
  player.features = FEATURES;
  setup(player);
  appState.connect(`wss://${host}/ws`);
  await settle();
  assert.equal(appState.status.state, "connected");
  return player;
}

/** Await `p`, draining the fake socket's microtask replies as it goes. */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  const out = p.finally(() => {
    done = true;
  });
  out.catch(() => undefined); // observed below; don't flag it as unhandled meanwhile
  for (let i = 0; i < 400 && !done; i++) await settle(1);
  return out;
}

// -- the bundle header ------------------------------------------------------------

test("the map id, LED count and date come from the first bytes of the stored bundle", () => {
  const bytes = bundleBytes("map-abc", 120, [], "2026-10-02T09:30:00Z");
  const h = parseBundleHeader(bytes.subarray(0, 96));
  assert.deepEqual(h, {
    mapId: "map-abc",
    createdAt: "2026-10-02T09:30:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: 120,
  });
});

test("a prefix cut inside the header keeps what it could read; a non-bundle is rejected", () => {
  const bytes = bundleBytes("a-much-longer-map-identifier-0123456789", 9);
  const h = parseBundleHeader(bytes.subarray(0, 12));
  assert.equal(h?.mapId, "", "the truncated id is not guessed");
  assert.equal(parseBundleHeader(new Uint8Array([0x12, 0x00])), null);
  assert.equal(parseBundleHeader(new Uint8Array()), null);
});

test("mapped vs interpolated counts the LEDs the solve placed", () => {
  assert.deepEqual(ledCounts(outputMap("x", 10, [3, 4])), { mapped: 8, interpolated: 2 });
});

// -- card states ---------------------------------------------------------------------

test("no device connected: no card", async () => {
  assert.deepEqual(await svc.probe(null), { kind: "hidden" });
});

test("a device with nothing stored: 'no map on this device yet'", async () => {
  await connect((p) => (p.storedMap = null));
  const st = await drive(svc.probe(appState.client));
  assert.deepEqual(st, { kind: "none", deviceName: "Porch Light" });
});

test("firmware without the stored-map dump: unsupported, without asking the device", async () => {
  const p = await connect((p) => (p.features = ["effects"]));
  const st = await drive(svc.probe(appState.client));
  assert.equal(st.kind, "unsupported");
  assert.equal(p.count("get_stored_map"), 0);
});

test("old firmware with no feature list that answers 'unsupported' reads as unsupported", async () => {
  await connect((p) => {
    p.features = null;
    p.storedMap = "unsupported";
  });
  assert.equal((await drive(svc.probe(appState.client))).kind, "unsupported");
});

test("a map this phone already has: saved, matched by id with ONE small request", async () => {
  const local = lib.add("cap-1", "Porch arch");
  const p = await connect((p) => (p.storedMap = bundleBytes("cap-1", 300)));
  const st = await drive(svc.probe(appState.client));
  assert.equal(st.kind, "saved");
  if (st.kind !== "saved") return;
  assert.equal(st.local.id, local);
  assert.equal(st.info.ledCount, 300);
  assert.equal(st.info.deviceName, "Porch Light");
  const reqs = p.received.filter((m) => m.type === "get_stored_map");
  assert.equal(reqs.length, 1, "nothing pulled for a map that's already here");
  assert.equal(reqs[0]!["offset"] ?? 0, 0);
  assert.ok(Number(reqs[0]!["maxLen"]) <= 256, "only the header window");
});

test("a small map not on this phone: unsaved, pulled once for counts, cached across visits", async () => {
  const bytes = bundleBytes("dev-9", 40, [7, 8, 9]);
  const p = await connect((p) => (p.storedMap = bytes));
  const st = await drive(svc.probe(appState.client));
  assert.equal(st.kind, "unsaved");
  if (st.kind !== "unsaved") return;
  assert.ok(st.bundle, "small enough to pull for the summary");
  assert.equal(st.info.mapped, 37);
  assert.equal(st.info.interpolated, 3);
  assert.equal(st.info.totalLen, bytes.length);
  const afterFirst = p.count("get_stored_map");

  const again = await drive(svc.probe(appState.client));
  assert.equal(again.kind, "unsaved");
  assert.equal(p.count("get_stored_map") - afterFirst, 1, "a revisit costs one header request");
});

test("a large map is summarized from the header only and pulled on demand", async () => {
  const bytes = bundleBytes("big-1", 400);
  assert.ok(bytes.length > 4096);
  const p = await connect((p) => (p.storedMap = bytes));
  const st = await drive(svc.probe(appState.client));
  assert.equal(st.kind, "unsaved");
  if (st.kind !== "unsaved") return;
  assert.equal(st.bundle, undefined);
  assert.equal(st.info.ledCount, 400);
  assert.equal(st.info.mapped, undefined);
  assert.equal(p.count("get_stored_map"), 1);

  // Preview pulls it into memory, without saving.
  const pulled = await drive(svc.pull(appState.client!));
  assert.equal(pulled.bundle.map.leds.length, 400);
  assert.equal(svc.lastPulled()?.info.mapId, "big-1");
  assert.equal(lib.imports, 0, "preview saves nothing");
});

test("a device read that fails for another reason is an error the card can retry", async () => {
  await connect((p) => (p.storedMap = null));
  const client = appState.client!;
  const real = client.peekStoredMap.bind(client);
  client.peekStoredMap = () => Promise.reject(new Error("socket closed"));
  const st = await drive(svc.probe(client));
  assert.deepEqual(st, { kind: "error", deviceName: "Porch Light", message: "socket closed" });
  client.peekStoredMap = real;
});

// -- save / dedupe ------------------------------------------------------------------

test("Save reuses the bundle already pulled for the card and lands one library entry", async () => {
  const p = await connect((p) => (p.storedMap = bundleBytes("dev-2", 30)));
  await drive(svc.probe(appState.client));
  const pullsBefore = p.count("get_stored_map");
  const id = await drive(svc.save(appState.client!));
  assert.equal(p.count("get_stored_map") - pullsBefore, 1, "only the header is re-read");
  const again = await drive(svc.save(appState.client!));
  assert.equal(again, id, "saving the same device map twice keeps one entry");
  assert.equal(lib.maps.size, 1);
  const st = await drive(svc.probe(appState.client));
  assert.equal(st.kind, "saved");
});

test("a re-pushed (edited) map under the same id and size isn't served from a stale cache", async () => {
  const p = await connect((p) => (p.storedMap = bundleBytes("dev-3", 20)));
  await drive(svc.probe(appState.client));
  // Same id, same length, different header bytes (another LED count).
  p.storedMap = bundleBytes("dev-3", 21);
  const st = await drive(svc.probe(appState.client));
  assert.equal(st.kind, "unsaved");
  if (st.kind === "unsaved") assert.equal(st.bundle?.map.ledCount, 21);
});

// -- Calibrate IMU from the device ----------------------------------------------------

test("Calibrate IMU on a fresh install pulls + saves the device's map, then opens the calibrate flow", async () => {
  const p = await connect((p) => {
    p.storedMap = bundleBytes("dev-imu", 50);
    p.sensorStatus = "SENSOR_STATUS_RUNNING";
  });
  assert.equal(await drive(deviceImuReady(appState.client)), true);
  const route = await drive(deviceCalibrationRoute(svc, appState.client!));
  const saved = await lib.findByMapId("dev-imu");
  assert.ok(saved, "the device's map is in the library now");
  assert.equal(route, `/capture?calibrate=${saved.id}`);
  assert.ok(p.count("get_stored_map") > 1, "it pulled the whole map");
});

test("Calibrate IMU for a map already here opens it without pulling", async () => {
  const local = lib.add("dev-imu2");
  const p = await connect((p) => {
    p.storedMap = bundleBytes("dev-imu2", 500);
    p.sensorStatus = "SENSOR_STATUS_RUNNING";
  });
  const route = await drive(deviceCalibrationRoute(svc, appState.client!));
  assert.equal(route, `/capture?calibrate=${local}`);
  assert.equal(p.count("get_stored_map"), 1);
  assert.equal(lib.imports, 0);
});

test("Calibrate IMU is offered only when the device serves the extrinsic calibration and its IMU runs", async () => {
  const p = await connect((p) => {
    p.storedMap = bundleBytes("dev-x", 5);
    p.sensorStatus = "SENSOR_STATUS_ABSENT";
  });
  assert.equal(await drive(deviceImuReady(appState.client)), false, "no running sensor");
  p.sensorStatus = "SENSOR_STATUS_RUNNING";
  assert.equal(await drive(deviceImuReady(appState.client)), true);
  assert.equal(await deviceImuReady({ welcome: { features: ["sensors"] }, getSensors: async () => ({ status: "SENSOR_STATUS_RUNNING" }) }), false, "older firmware without imu_extrinsic");
  assert.equal(await deviceImuReady(null), false);
});

test("a device with no map can't be calibrated against: the error says so", async () => {
  await connect((p) => {
    p.storedMap = null;
    p.sensorStatus = "SENSOR_STATUS_RUNNING";
  });
  await assert.rejects(drive(deviceCalibrationRoute(svc, appState.client!)), (e: { code?: string }) => e.code === "no_map");
});
