/**
 * Lighthouse in the browser (web/src/p4demo/lh, //web/lh_wasm): a recorded session
 * (a Watchman dongle, 15 s: still, calibrated from scratch, then tracked) replayed
 * through the wasm build of lh_device + lh_kernel, checked against lhd's output on
 * the same recording (tests/testdata/lh/session_lhd.json, see its "generator").
 *
 * Tolerances: the wasm runs the same f64 kernel source as lhd, with the same libm,
 * on IEEE doubles, and its handshake / report / clock bookkeeping mirrors lhd's
 * DeviceManager; so the replay should agree with lhd number for number. The
 * reference is rounded to 12 significant digits, so poses are compared to 1e-9
 * (m, quaternion units, s): any real divergence (a dropped report, a different
 * clock tick, an f32 path) moves them by orders of magnitude more.
 *
 * Two levels:
 * - the engine (DirectEngine over the Node build of the wasm): lhd's replay
 *   semantics exactly (recorded GET answers per report id, every device);
 * - createWebHidTracking over a fake navigator.hid that plays the recording back
 *   as WebHID would (every recorded GET in order, NAKs as rejected promises, input
 *   reports as events stamped with their recorded arrival): the async handshake,
 *   the report path, status, poses, stations, calibration export / storage.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import Module from "node:module";
import { resolve } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { DirectEngine, type LhEngine, type LhEvent, type LhWasmModule } from "../src/p4demo/lh/engine";
import { STORAGE_KEY, parseCalibration, type StorageLike } from "../src/p4demo/lh/calibration";
import { createWebHidTracking, type HidDeviceLike, type HidInputReportEventLike, type HidLike } from "../src/p4demo/lh/webhid";
import type { LhPose, LhStation, LhStatus } from "../src/p4demo/lh/types";
import reference from "./testdata/lh/session_lhd.json";

const TOL = 1e-9;

function runfile(rel: string): string {
  const candidates = [resolve(rel), resolve(__dirname, "../..", rel), resolve(__dirname, "../../..", rel)];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error(`missing ${rel} (looked in ${candidates.join(", ")})`);
  return hit;
}

/** The wasm-bindgen Node glue is CommonJS, but the nearest package.json (the repo's)
 * says "type": "module": compile it as CommonJS explicitly. */
function requireCjs(path: string): unknown {
  const m = new Module(path) as Module & { _compile(code: string, filename: string): void };
  m.filename = path;
  m.paths = [];
  m._compile(readFileSync(path, "utf8"), path);
  return m.exports;
}

const wasm = requireCjs(runfile("web/lh_wasm/lh_wasm_node_pkg/lh_wasm_node_pkg.js")) as LhWasmModule;

// ------------------------------------------------------------------ the recording

interface Feat {
  op: "GET" | "SET";
  rtn: number;
  data: Uint8Array;
}
interface Line {
  dev: string;
  kind: "feat" | "in";
  feat?: Feat;
  hostUs?: number;
  data?: Uint8Array;
}

function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/** lhd / vive_web recording lines (@lighthouse transport/src/replay.rs). */
function readRecording(): Line[] {
  const text = gunzipSync(readFileSync(runfile("web/tests/testdata/lh/session.rec.gz"))).toString("utf8");
  const lines: Line[] = [];
  for (const l of text.split("\n")) {
    const p = l.trim().split(/\s+/) as [string, string, string, string, string, string, string];
    if (p.length !== 7) continue;
    if (p[2] === "HIDFEAT") {
      lines.push({ dev: p[1], kind: "feat", feat: { op: p[3] as "GET" | "SET", rtn: Number(p[5]), data: unhex(p[6]) } });
    } else if (p[2] === "HIDIN") {
      lines.push({ dev: p[1], kind: "in", hostUs: Number(p[4]), data: unhex(p[6]) });
    }
  }
  return lines;
}

const recording = readRecording();
const DEVICES = [...new Set(recording.map((l) => l.dev))];

// ------------------------------------------------------------------ comparisons

type PoseRow = number[]; // t, px, py, pz, qw, qx, qy, qz

function closeRows(got: PoseRow[], want: PoseRow[], what: string): void {
  assert.equal(got.length, want.length, `${what}: pose count`);
  let worst = 0;
  let at = -1;
  for (let i = 0; i < want.length; i++) {
    for (let k = 0; k < 8; k++) {
      const d = Math.abs(got[i]![k]! - want[i]![k]!);
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
  }
  assert.ok(worst <= TOL, `${what}: worst difference ${worst} at pose ${at}: ${JSON.stringify(got[at])} vs ${JSON.stringify(want[at])}`);
}

function poseRow(e: LhEvent): PoseRow {
  const p = e.p as number[];
  const q = e.q as number[];
  return [e.t as number, ...p, ...q];
}

interface RefRun {
  poses: PoseRow[];
  calibrated: Array<{ reason: string; stations: Array<{ id: number; p: number[]; q: number[] }> }>;
  tracking: Array<{ state: string }>;
}

// ------------------------------------------------------------------ engine level

/** lhd --replay: each device handshaken at its first line (GETs answered from the
 * recorded successes per report id, in order: ReplayTransport), then its reports. */
async function replayEngine(hostClock: boolean): Promise<LhEvent[]> {
  const engine: LhEngine = new DirectEngine(wasm, { hostClock, stream: hostClock });
  const events: LhEvent[] = [];
  engine.onEvents((e) => events.push(...e));
  const gets = new Map<string, Uint8Array[]>();
  for (const l of recording) {
    if (l.kind === "feat" && l.feat!.op === "GET" && l.feat!.rtn > 0) {
      const key = `${l.dev}/${l.feat!.data[0]}`;
      if (!gets.has(key)) gets.set(key, []);
      gets.get(key)!.push(l.feat!.data.subarray(0, l.feat!.rtn));
    }
  }
  const handles = new Map<string, number>();
  for (const l of recording) {
    if (!handles.has(l.dev)) {
      const h = await engine.call<number>("add_device", 0x28de, 0x2101);
      assert.ok(h > 0);
      handles.set(l.dev, h);
      for (let steps = 0; ; steps++) {
        assert.ok(steps < 10_000, "handshake doesn't end");
        const step = JSON.parse(await engine.call<string>("handshake", h));
        if (step.step === "ready") break;
        assert.equal(step.step, "pending", JSON.stringify(step));
        const q = gets.get(`${l.dev}/${step.get}`) ?? [];
        const a = q.shift();
        await engine.call("handshake_answer", h, step.get, a ? 0 : 2, a ?? new Uint8Array(0));
      }
    }
    if (l.kind === "in") engine.send("report", handles.get(l.dev)!, 0, l.data!, l.hostUs!);
  }
  engine.dispose();
  return events;
}

function checkRun(events: LhEvent[], ref: RefRun, what: string): void {
  const poses = events.filter((e) => e.type === "pose").map(poseRow);
  closeRows(poses, ref.poses, what);
  const cal = events.filter((e) => e.type === "calibrated");
  assert.equal(cal.length, ref.calibrated.length, `${what}: calibrations`);
  cal.forEach((c, i) => {
    const want = ref.calibrated[i]!;
    assert.equal(c.reason, want.reason);
    const st = c.stations as Array<{ id: number; pose: number[] }>;
    assert.deepEqual(
      st.map((s) => s.id),
      want.stations.map((s) => s.id),
    );
    st.forEach((s, k) => {
      const w = [...want.stations[k]!.p, ...want.stations[k]!.q];
      s.pose.forEach((x, j) => assert.ok(Math.abs(x - w[j]!) <= TOL, `${what}: station ${s.id} pose[${j}] ${x} vs ${w[j]}`));
    });
  });
  assert.deepEqual(
    events.filter((e) => e.type === "tracking").map((e) => e.state),
    ref.tracking.map((t) => t.state),
  );
}

test("engine replay matches lhd (default: no host clock)", async () => {
  const ref = (reference as unknown as { default: RefRun }).default;
  assert.ok(ref.poses.length > 400 && ref.calibrated.length === 1, "fixture sanity");
  checkRun(await replayEngine(false), ref, "default");
});

test("engine replay matches lhd --host-clock --stream-sweeps", async () => {
  const ref = (reference as unknown as { hostClockStream: RefRun }).hostClockStream;
  const events = await replayEngine(true);
  checkRun(events, ref, "host clock");
  // Every pose is on the host clock once mapped, and after its light.
  const poses = events.filter((e) => e.type === "pose");
  assert.ok(poses.every((p) => typeof p.host_us === "number"));
  assert.ok(poses.every((p) => (p.light_us as number) <= (p.host_us as number)));
  // Health (lh_health, as the P4): this session sees one station ~2.9 m away, so the
  // position sigma sits around 2.5 cm, past the 2 cm "usable" limit: mostly uncertain
  // (1), locked (4) while it dips under, acquiring (2) right after the first solve.
  const hist = [0, 0, 0, 0, 0];
  for (const p of poses) hist[p.health as number]! += 1;
  assert.ok(hist[1]! > poses.length / 2 && hist[4]! > 10 && hist[2]! > 0, JSON.stringify(hist));
  // Locked means the position sigma is under 2 cm.
  for (const p of poses) if (p.health === 4) assert.ok((p.sigma as number) <= 0.02, `locked at sigma ${p.sigma}`);
});

// ------------------------------------------------------------------ WebHID level

class MemStorage implements StorageLike {
  m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.m.set(k, v);
  }
  removeItem(k: string): void {
    this.m.delete(k);
  }
}

/** A Watchman dongle answering as the recorded one did: the k-th GET gets the k-th
 * recorded GET (a failed one as a rejected promise: the dongle NAKed), SETs are
 * checked against the recorded ones. Reports are played by `play`. */
class FakeDongle implements HidDeviceLike {
  readonly vendorId = 0x28de;
  readonly productId = 0x2101;
  readonly collections = [{ featureReports: [{}] }];
  opened = false;
  readonly gets: Feat[];
  private sets: Feat[];
  setsSeen = 0;
  getsSeen = 0;
  private listeners = new Set<(ev: HidInputReportEventLike) => void>();

  constructor(
    readonly productName: string,
    lines: Line[],
  ) {
    const feats = lines.filter((l) => l.kind === "feat").map((l) => l.feat!);
    this.gets = feats.filter((f) => f.op === "GET");
    this.sets = feats.filter((f) => f.op === "SET");
  }

  async open(): Promise<void> {
    this.opened = true;
  }
  async close(): Promise<void> {
    this.opened = false;
  }
  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    const want = this.sets[this.setsSeen++];
    assert.ok(want, `${this.productName}: unrecorded SET ${reportId}`);
    const got = new Uint8Array([reportId, ...new Uint8Array(data as ArrayBuffer)]);
    assert.deepEqual([...got], [...want.data.subarray(0, got.length)], `${this.productName}: SET ${this.setsSeen}`);
  }
  async receiveFeatureReport(reportId: number): Promise<DataView> {
    const g = this.gets[this.getsSeen++];
    if (!g) throw new DOMException("not recorded", "NotAllowedError");
    // A failed GET is recorded as -1 with just the id: the request it answered.
    assert.equal(g.data[0], reportId, `${this.productName}: GET #${this.getsSeen} asked ${reportId}, recorded ${g.data[0]}`);
    if (g.rtn <= 0) throw new DOMException("Failed to receive the feature report.", "NotAllowedError");
    const b = g.data.slice(0, g.rtn); // Chrome: the report id first
    return new DataView(b.buffer);
  }
  addEventListener(_t: "inputreport", l: (ev: HidInputReportEventLike) => void): void {
    this.listeners.add(l);
  }
  removeEventListener(_t: "inputreport", l: (ev: HidInputReportEventLike) => void): void {
    this.listeners.delete(l);
  }
  emit(data: Uint8Array, timeStamp: number): void {
    const ev = { reportId: data[0]!, data: new DataView(data.slice(1).buffer), timeStamp };
    for (const l of this.listeners) l(ev);
  }
}

class FakeHid implements HidLike {
  constructor(readonly devices: HidDeviceLike[]) {}
  async requestDevice(): Promise<HidDeviceLike[]> {
    return this.devices;
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100_000; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for ${what}`);
}

async function replayWebHid(storage: MemStorage) {
  const dongles = DEVICES.map((name) => new FakeDongle(name, recording.filter((l) => l.dev === name)));
  let nowMs = 0;
  const tracking = createWebHidTracking({
    hid: new FakeHid(dongles),
    loadEngine: async (o) => new DirectEngine(wasm, o),
    storage,
    now: () => nowMs,
    sleep: async () => undefined,
    tickMs: 0,
    batchReports: false,
  });
  const statuses: LhStatus[] = [];
  const poses: LhPose[] = [];
  const stationLists: LhStation[][] = [];
  tracking.onStatus((s) => statuses.push(s));
  tracking.onPose((p) => poses.push(p));
  tracking.onStations((s) => stationLists.push(s));
  await tracking.connect();
  // Every dongle through its recorded handshake, and configured.
  await until(() => dongles.every((d) => d.getsSeen === d.gets.length), "the handshakes");
  await until(() => statuses.some((s) => s.state === "calibrating" || s.state === "lost" || s.state === "tracking"), "configured");
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r));
  const byName = new Map(dongles.map((d) => [d.productName, d]));
  for (const l of recording) {
    if (l.kind !== "in") continue;
    nowMs = l.hostUs! / 1000;
    byName.get(l.dev)!.emit(l.data!, nowMs);
  }
  return { tracking, statuses, poses, stationLists, dongles };
}

test("WebHID tracking over a replayed dongle matches lhd --host-clock --stream-sweeps", async () => {
  const ref = (reference as unknown as { hostClockStream: RefRun }).hostClockStream;
  const storage = new MemStorage();
  const { tracking, statuses, poses, stationLists, dongles } = await replayWebHid(storage);

  // The async handshake asked exactly what lhd asked (NAKs and retries included).
  for (const d of dongles) assert.equal(d.setsSeen, 3, `${d.productName} startup SETs`);

  const rows = poses.map((p) => [0, ...p.pos, ...p.quat]);
  closeRows(
    rows,
    ref.poses.map((r) => [0, ...r.slice(1)]),
    "webhid",
  );
  // Pose times are on the page clock (the reports' timeStamps), increasing.
  const first = recording.find((l) => l.kind === "in")!.hostUs! / 1000;
  const last = [...recording].reverse().find((l) => l.kind === "in")!.hostUs! / 1000;
  assert.ok(poses.every((p, i) => p.t >= first - 50 && p.t <= last + 1 && (i === 0 || p.t >= poses[i - 1]!.t - 1e-6)));
  // `ok` = locked or coasting (see the engine test for this session's health).
  const ok = poses.filter((p) => p.ok).length;
  assert.ok(ok > 10 && ok < poses.length / 2, `ok ${ok} of ${poses.length}`);

  const states = statuses.map((s) => s.state);
  assert.deepEqual(states.slice(0, 2), ["disconnected", "connecting"]);
  assert.ok(states.includes("calibrating"), states.join(","));
  assert.equal(states[states.length - 1], "tracking", states.join(","));
  assert.ok(states.indexOf("calibrating") < states.lastIndexOf("tracking"));

  // Stations: the calibration lhd made, kept in storage in lhd's format.
  const want = ref.calibrated[0]!.stations;
  assert.equal(stationLists.length, 1);
  assert.deepEqual(
    tracking.stations().map((s) => s.id),
    want.map((s) => s.id),
  );
  tracking.stations().forEach((s, i) => {
    [...s.pos, ...s.quat].forEach((x, j) => assert.ok(Math.abs(x - [...want[i]!.p, ...want[i]!.q][j]!) <= TOL));
  });
  const exported = parseCalibration(tracking.exportCalibration());
  assert.equal(exported.stations.length, want.length);
  assert.equal(exported.stations[0]!.cov.length, 36);
  assert.equal(exported.stations[0]!.cal?.length, 2);
  assert.equal(storage.getItem(STORAGE_KEY), tracking.exportCalibration());
  await tracking.disconnect();
  assert.equal(statuses[statuses.length - 1]!.state, "disconnected");
});

test("a stored calibration is used on the next connect (no recalibration)", async () => {
  const storage = new MemStorage();
  const first = await replayWebHid(storage);
  await first.tracking.disconnect();
  const saved = storage.getItem(STORAGE_KEY);
  assert.ok(saved);

  const second = await replayWebHid(storage);
  // Stations known from the start: never "calibrating", and the kernel didn't solve
  // the stations again from the first still scene (no new "calibrated").
  assert.ok(second.tracking.stations().length > 0);
  assert.ok(!second.statuses.some((s) => s.state === "calibrating"), second.statuses.map((s) => s.state).join(","));
  assert.equal(second.stationLists.length, 0);
  assert.ok(second.poses.length > 0);
  // Tracking starts sooner than calibrating from scratch did.
  const t0 = (r: { poses: LhPose[] }) => r.poses.find((p) => p.ok)!.t;
  assert.ok(t0(second) < t0(first), `${t0(second)} vs ${t0(first)}`);
  await second.tracking.disconnect();
});

test("import / export / recalibrate", async () => {
  const storage = new MemStorage();
  const t = createWebHidTracking({ hid: new FakeHid([]), storage, tickMs: 0, loadEngine: async (o) => new DirectEngine(wasm, o) });
  assert.deepEqual(JSON.parse(t.exportCalibration()), { version: 1, stations: [] });
  const lhdFile = {
    version: 1,
    stations: [
      {
        id: 699579721,
        mode: 1,
        pose: [1, 2, 3, 1, 0, 0, 0],
        cov: Array.from({ length: 36 }, (_, i) => (i % 7 === 0 ? 1e-6 : 0)),
        cal: [
          [0.01, 0, 0, 0, 0],
          [0.02, 0, 0, 0, 0],
        ],
        rms: 0.0004,
        up_error: 0.01,
      },
    ],
  };
  const seen: LhStation[][] = [];
  t.onStations((s) => seen.push(s));
  t.importCalibration(JSON.stringify(lhdFile));
  assert.deepEqual(t.stations(), [{ id: 699579721, pos: [1, 2, 3], quat: [1, 0, 0, 0] }]);
  assert.equal(seen.length, 1);
  assert.deepEqual(JSON.parse(t.exportCalibration()), lhdFile);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)!), lhdFile);
  assert.throws(() => t.importCalibration('{"stations":[{"id":1,"pose":[1,2]}]}'), /pose needs 7/);
  t.recalibrate();
  assert.deepEqual(t.stations(), []);
  assert.equal(storage.getItem(STORAGE_KEY), null);
});

test("no WebHID: a clear status, and connect rejects", async () => {
  const t = createWebHidTracking({ hid: null, storage: null });
  let status: LhStatus | null = null;
  t.onStatus((s) => (status = s));
  assert.equal(status!.state, "disconnected");
  assert.match(status!.detail ?? "", /WebHID/);
  assert.match(status!.detail ?? "", /Android/);
  await assert.rejects(t.connect(), /WebHID/);
});
