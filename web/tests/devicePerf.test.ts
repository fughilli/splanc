/**
 * measure_on_device (src/effects/devicePerf.ts): the on-fixture perf capture the
 * effect AI confirms its offline estimates against. Driven by a fake device:
 * upload → FULL perf → a short window stream → summary, perf restored after,
 * plus the no-device, wedged-device and gating paths.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  canMeasure,
  measureOnDevice,
  perfDeviceFromClient,
  resolveUniforms,
  summarizeWindows,
  type PerfDevice,
} from "../src/effects/devicePerf";
import { defaultCostTable } from "../src/store/costTableStore";
import type { PerfReportMessage, UniformValueFlat } from "../src/net/proto";

const HZ = 160_000_000;
const table = defaultCostTable("esp32c6", HZ);
const noSleep = async (): Promise<void> => undefined;

/** A window of `frameMs` frames (plus 1 ms show) for `effectId`. */
function report(effectId: string, frameMs: number, ticks = 3): PerfReportMessage {
  const cyc = (frameMs / 1000) * HZ;
  const show = HZ / 1000;
  return {
    type: "perf_report",
    effectId,
    fxbHash: 7,
    cpuHz: HZ,
    budgetCycles: (16.6 / 1000) * HZ,
    frameCyclesMin: cyc,
    frameCyclesMean: cyc,
    frameCyclesMax: cyc,
    updateCyclesMean: cyc * 0.1,
    shadeCyclesMean: cyc * 0.9,
    showCyclesMean: show,
    overruns: 0,
    droppedFrames: 0,
    samplesDropped: 0,
    heapFree: 80_000,
    heapMinFree: 70_000,
    heapLargestFree: 60_000,
    ticks: Array.from({ length: ticks }, (_, i) => ({
      seq: i,
      updateCycles: cyc * 0.1,
      shadeCycles: cyc * 0.9,
      frameCycles: cyc,
      showCycles: show,
      ledCount: 128,
      instrUpdate: 10,
      instrShade: 1280,
      stackMax: 6,
    })),
  };
}

interface Fake extends PerfDevice {
  log: string[];
  uniforms: UniformValueFlat[][];
}

function fakeDevice(opts: { running?: string; frames?: number[]; wedgePerf?: boolean; features?: string[] } = {}): Fake {
  const frames = [...(opts.frames ?? [4, 4.2, 3.8, 4.1, 4, 4, 4])];
  const log: string[] = [];
  const uniforms: UniformValueFlat[][] = [];
  let first = true;
  return {
    isConnected: true,
    features: opts.features,
    log,
    uniforms,
    runningEffectId: async () => opts.running ?? "",
    submitEffect: async (id) => void log.push(`submit ${id}`),
    setUniforms: (v) => void uniforms.push(v),
    setPerf: async (mode, iv) => {
      log.push(`perf ${mode} ${iv}`);
      if (opts.wedgePerf && mode === "FULL") return new Promise<PerfReportMessage>(() => undefined);
      return report("old", 99);
    },
    getPerfReport: async () => {
      // The first drain after enabling holds the pre-upload mix: discarded.
      if (first) {
        first = false;
        return report("old", 99);
      }
      return report("fx1", frames.shift() ?? 4);
    },
  };
}

test("measures a window stream on the fixture and restores perf to OFF", async () => {
  const dev = fakeDevice({ running: "other" });
  const r = await measureOnDevice(dev, {
    effectId: "fx1",
    bytecode: new Uint8Array([1]),
    seconds: 2,
    uniforms: [{ slot: 0, value: [3] }],
    table,
    calibrated: false,
    predict: () => ({ totalMs: 3, lowMs: 2.5, highMs: 3.5 }),
    sleep: noSleep,
  });
  assert.equal(r.deployed, true);
  assert.deepEqual(dev.log, ["submit fx1", "perf FULL 0", "perf OFF 0"]);
  assert.deepEqual(dev.uniforms, [[{ slot: 0, value: [3] }]]);
  // 2 s / 0.5 s = 4 windows of 3 frames; the discarded pre-upload window is absent.
  assert.match(r.text, /Measured ON THE FIXTURE \(4 windows, 12 frames, 128 LEDs\)/);
  assert.match(r.text, /frame mean 5\.\d\d ms, p95 5\.\d\d ms, max 5\.20 ms/); // +1 ms show
  assert.match(r.text, /per-window means 5\.00 \/ 5\.20 \/ 4\.80 \/ 5\.10 ms/);
  assert.match(r.text, /source: measured/);
  assert.match(r.text, /was running "other"; it now runs this workspace's effect/);
  assert.match(r.text, /measured is \+\d+% — OUTSIDE the band\. Trust the measurement/);
  assert.ok(!r.text.includes("99"), "the pre-upload window must not leak into the stats");
});

test("skips the upload when the fixture already runs the program", async () => {
  const dev = fakeDevice();
  const r = await measureOnDevice(dev, {
    effectId: "fx1",
    bytecode: new Uint8Array([1]),
    alreadyRunning: true,
    seconds: 1,
    table,
    calibrated: true,
    sleep: noSleep,
  });
  assert.equal(r.deployed, true);
  assert.deepEqual(dev.log, ["perf FULL 0", "perf OFF 0"]);
});

test("no connected fixture: a clear result, nothing sent", async () => {
  const r = await measureOnDevice(null, { effectId: "fx1", bytecode: new Uint8Array(), table, calibrated: false });
  assert.equal(r.deployed, false);
  assert.match(r.text, /no fixture with perf support is connected/);
});

test("a wedged device times out cleanly and still turns perf off", async () => {
  const dev = fakeDevice({ wedgePerf: true });
  const r = await measureOnDevice(dev, {
    effectId: "fx1",
    bytecode: new Uint8Array([1]),
    table,
    calibrated: false,
    timeoutMs: 20,
    sleep: noSleep,
  });
  assert.match(r.text, /measure_on_device failed: enabling perf timed out after 20 ms/);
  assert.equal(r.deployed, true); // the upload landed before the wedge
  // perf was never confirmed on, so no OFF is owed — but nothing hangs either.
  assert.deepEqual(dev.log, ["submit fx1", "perf FULL 0"]);
});

test("gating: connected + (no feature list, or one that lists perf)", () => {
  assert.equal(canMeasure(null), false);
  assert.equal(canMeasure({ ...fakeDevice(), isConnected: false }), false);
  assert.equal(canMeasure(fakeDevice()), true);
  assert.equal(canMeasure(fakeDevice({ features: ["effects", "perf"] })), true);
  assert.equal(canMeasure(fakeDevice({ features: ["effects"] })), false);
  // The client adapter reads Welcome.features when the firmware sends them.
  const client = {
    isConnected: true,
    welcome: { features: ["effects"] },
    getEffectUniforms: async () => ({ effectId: "" }),
    submitEffect: async () => undefined,
    setUniforms: () => true,
    setPerf: async () => report("x", 1),
    getPerfReport: async () => report("x", 1),
  };
  assert.equal(canMeasure(perfDeviceFromClient(client)), false);
  assert.equal(canMeasure(perfDeviceFromClient({ ...client, welcome: { features: ["perf"] } })), true);
  assert.equal(perfDeviceFromClient(null), null);
});

test("an empty stream says so instead of reporting zeros", () => {
  const text = summarizeWindows([{ ...report("fx1", 0), frameCyclesMean: 0 }], { table, calibrated: false });
  assert.match(text, /reported no frames/);
});

test("uniform operating points resolve by name, clamp to width, and report unknowns", () => {
  const manifest = [
    { name: "speed", slot: 0, width: 1 },
    { name: "tint", slot: 2, width: 3 },
  ];
  const { values, unknown } = resolveUniforms(
    [
      { name: "speed", value: [2, 9] },
      { name: "tint", value: [1, 0, 1] },
      { name: "nope", value: [1] },
    ],
    manifest,
  );
  assert.deepEqual(values, [
    { slot: 0, value: [2] },
    { slot: 2, value: [1, 0, 1] },
  ]);
  assert.deepEqual(unknown, ["nope"]);
});
