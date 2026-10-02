/**
 * Calibrating the effect performance model (PR-27, the risk control for RISK-2
 * "the performance model gives false confidence"): the least-squares fit
 * (calibrationFit.ts), the presence-aware merge into the shipped table
 * (deviceProfile.ts / calibration.ts), and the in-browser calibration flow
 * (calibration.ts runCalibration) that measures every benchmark on a connected
 * board.
 *
 * Measurements come from a synthetic "device" with a KNOWN per-opcode cost table,
 * so the suite can check the fit recovers the truth exactly — something the
 * real-hardware golden (deviceProfileHardware / perfModelValidation) cannot pin.
 * The device stand-in derives each frame's cycles from the same abstract-
 * interpreter op counts the calibration uses; the benchmark bytecode is
 * hand-assembled (the compiler wasm is not available under node), with
 * fx/preview's compileScript replaced for the duration of the flow tests.
 */

import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import * as preview from "../src/fx/preview";
import { runCalibration, type CalibDevice, type CalibProgress } from "../src/effects/calibration";
import { fitCosts, presentFeatures, type BenchSample } from "../src/effects/calibrationFit";
import {
  BENCHMARKS,
  FITTED_OPCODES,
  benchmarksForTier,
  type Benchmark,
} from "../src/effects/calibrationBenchmarks";
import {
  BIN_MATH_NAMES,
  OPCODE_NAMES,
  UN_MATH_NAMES,
  costFor,
  parseFxb,
  walkEntry,
  type FixedOverhead,
} from "../src/effects/costModel";
import { buildDeviceProfile, type DeviceSample } from "../src/effects/deviceProfile";
import { DEFAULT_COSTS } from "../src/store/costTableStore";
import type { PerfReportMessage } from "../src/net/proto";

const CODE: Record<string, number> = Object.fromEntries(OPCODE_NAMES.map((n, i) => [n, i]));

/** The synthetic board's TRUE per-opcode costs: distinct for every fitted
 * feature and far from DEFAULT_COSTS, plus the structural ops the chains use. */
const TRUE_COSTS: Record<string, number> = {
  ...Object.fromEntries(FITTED_OPCODES.map((op, i) => [op, 140 + 37 * i])),
  LoadCtx: 5,
  Ret: 9,
};
const TRUE_FIXED: FixedOverhead = {
  update_fixed: 1800,
  shade_fixed: 95,
  show_fixed: 41_000,
  show_per_led: 530,
};
const TRUE_FALLBACK = 8;

/** Lane weight the abstract interpreter gives one application of `feature`. */
function lanesOf(feature: string): number {
  const vec3 = ["Clamp", "Mix", "Smoothstep", "Normalize", "Dot", "Length", "Distance"];
  return vec3.includes(feature) ? 3 : 1;
}

/** Encode one application of a fitted feature, operand layout per fx_vm. */
function opBytes(feature: string): number[] {
  const [name, fn] = feature.split(":") as [string, string | undefined];
  const code = CODE[name]!;
  if (name === "UnMath") return [code, (UN_MATH_NAMES as readonly string[]).indexOf(fn!), 1];
  if (name === "BinMath") return [code, (BIN_MATH_NAMES as readonly string[]).indexOf(fn!), 1];
  if (["Hash1", "Hash3", "Hsv2Rgb"].includes(name)) return [code];
  if (name === "Palette") return [code, 0];
  return [code, lanesOf(name)];
}

/** A `.fxb` whose shade() is `led.pos` then `reps` applications of `feature`. */
function chainFxb(feature: string | null, reps: number): Uint8Array {
  const code: number[] = [CODE["LoadCtx"]!, 3];
  if (feature !== null) for (let i = 0; i < reps; i++) code.push(...opBytes(feature));
  code.push(CODE["Ret"]!, 3);
  const h = [0x46, 0x58, 0x42, 0x31, 1, 0, 0, 0];
  const p16 = (v: number): void => void h.push(v & 0xff, (v >> 8) & 0xff);
  p16(0); // manifest_len
  p16(0); // n_consts
  p16(code.length);
  p16(0xffff); // no update()
  p16(0); // shade at 0
  return new Uint8Array([...h, ...code]);
}

/** The synthetic board's true (frame, show) cycles for a program at `leds`. */
function trueCycles(fxb: Uint8Array, leds: number): { frame: number; show: number } {
  const hdr = parseFxb(fxb);
  const hist = walkEntry(hdr.code, hdr.shadeEntry).max;
  let perLed = TRUE_FIXED.shade_fixed;
  for (const [op, n] of Object.entries(hist)) perLed += n * costFor(TRUE_COSTS, op, TRUE_FALLBACK);
  return {
    frame: TRUE_FIXED.update_fixed + leds * perLed,
    show: TRUE_FIXED.show_fixed + leds * TRUE_FIXED.show_per_led,
  };
}

/** Rep count of an isolation benchmark (the M / 2M two-point design). */
const repsOf = (b: Benchmark): number => (b.id.endsWith("2M") ? 64 : 32);

function relErr(got: number, want: number): number {
  return Math.abs(got - want) / want;
}

// -- the fit -----------------------------------------------------------------

/** Fit rows for the real benchmark design (overhead + sweeps + M/2M per op). */
function syntheticSamples(noise = 0): BenchSample[] {
  const rows: BenchSample[] = [];
  let k = 0;
  const push = (label: string, opCounts: Record<string, number>, leds: number): void => {
    let frame = TRUE_FIXED.update_fixed + leds * TRUE_FIXED.shade_fixed;
    for (const [op, n] of Object.entries(opCounts)) frame += n * TRUE_COSTS[op]!;
    const wobble = noise === 0 ? 1 : 1 + (k++ % 2 === 0 ? noise : -noise);
    rows.push({
      label,
      opCounts,
      updateRuns: 1,
      shadeRuns: leds,
      ledCount: leds,
      measuredFrameCycles: frame * wobble,
      measuredShowCycles: TRUE_FIXED.show_fixed + leds * TRUE_FIXED.show_per_led,
      bytecodeHash: 0,
    });
  };
  push("empty", {}, 128);
  push("sweep16", {}, 16);
  push("sweep256", {}, 256);
  for (const op of FITTED_OPCODES) {
    for (const reps of [32, 64]) push(`${op} x${reps}`, { [op]: reps * lanesOf(op) * 128 }, 128);
  }
  return rows;
}

test("the fit recovers every fitted opcode's true cost and the fixed overheads [rr:PR-27]", () => {
  const fit = fitCosts(syntheticSamples(), FITTED_OPCODES);
  for (const op of FITTED_OPCODES) {
    assert.ok(
      relErr(fit.costs[op]!, TRUE_COSTS[op]!) < 1e-3,
      `${op}: fitted ${fit.costs[op]} vs true ${TRUE_COSTS[op]}`,
    );
  }
  for (const k of Object.keys(TRUE_FIXED) as (keyof FixedOverhead)[]) {
    assert.ok(
      relErr(fit.fixed[k], TRUE_FIXED[k]) < 1e-3,
      `${k}: fitted ${fit.fixed[k]} vs true ${TRUE_FIXED[k]}`,
    );
  }
  assert.ok(
    fit.residualError < 1e-3,
    `a model that explains the data has ~0 residual (${fit.residualError})`,
  );
});

test("the fit residual reports measurements the model cannot explain [rr:PR-27]", () => {
  // ±10% scatter on the frames that the linear model can't reproduce: the
  // residual — which widens every estimate's error band — must expose it, never
  // report the clean ~0 of a model that explains the data.
  const clean = fitCosts(syntheticSamples(), FITTED_OPCODES).residualError;
  const noisy = fitCosts(syntheticSamples(0.1), FITTED_OPCODES);
  assert.ok(noisy.residualError > 0.05, `residual ${noisy.residualError} hides a 10% misfit`);
  assert.ok(noisy.residualError > 100 * clean, "a misfit must read far worse than a clean fit");
  // Costs stay finite and non-negative even when the data disagrees.
  for (const op of FITTED_OPCODES) assert.ok(Number.isFinite(noisy.costs[op]!) && noisy.costs[op]! >= 0);
});

test("a run only overrides the opcodes it measured; the rest keep their seeded cost [rr:PR-27]", () => {
  // A partial device run: overhead + LED sweep + sin chains only.
  const sample = (label: string, fxb: Uint8Array, leds: number): DeviceSample => {
    const c = trueCycles(fxb, leds);
    return { label, fxb, ledCount: leds, measuredFrameCycles: c.frame, measuredShowCycles: c.show };
  };
  const bundle = {
    soc: "esp32c6",
    cpuHz: 160_000_000,
    fit: [
      sample("empty", chainFxb(null, 0), 128),
      sample("sweep16", chainFxb(null, 0), 16),
      sample("sweep256", chainFxb(null, 0), 256),
      sample("sinM", chainFxb("UnMath:sin", 32), 128),
      sample("sin2M", chainFxb("UnMath:sin", 64), 128),
    ],
    heldout: [],
  };
  const samples = bundle.fit.map((s) => {
    const hdr = parseFxb(s.fxb);
    const hist = walkEntry(hdr.code, hdr.shadeEntry).max;
    const opCounts = Object.fromEntries(Object.entries(hist).map(([k, v]) => [k, v * s.ledCount]));
    return { opCounts } as BenchSample;
  });
  assert.deepEqual(presentFeatures(samples, FITTED_OPCODES), ["UnMath:sin"]);

  const { table } = buildDeviceProfile(bundle);
  assert.ok(
    relErr(table.costs["UnMath:sin"]!, TRUE_COSTS["UnMath:sin"]!) < 1e-3,
    "the measured op is fitted",
  );
  for (const op of FITTED_OPCODES) {
    if (op === "UnMath:sin") continue;
    assert.equal(table.costs[op], DEFAULT_COSTS[op], `${op} unmeasured but its seeded cost changed`);
  }
});

// -- the in-browser calibration flow ------------------------------------------

/** A connected board that answers set_perf/get_perf_report from TRUE costs. The
 * window MEAN is inflated by interrupts (WiFi/BLE/TLS only ever ADD cycles); the
 * window MINIMUM is the clean frame. `blind` benches report an empty window. */
class SyntheticBoard implements CalibDevice {
  readonly cpuHz = 120_000_000;
  readonly perfCalls: [string, number][] = [];
  readonly submitted: { id: string; activate: boolean }[] = [];
  private current: { fxb: Uint8Array; leds: number; id: string } | null = null;

  constructor(private readonly blind: Set<string> = new Set()) {}

  async submitEffect(effectId: string, fxb: Uint8Array, activate: boolean): Promise<unknown> {
    const bench = BENCHMARKS.find((b) => `__calib_${b.id}` === effectId);
    assert.ok(bench, `unexpected effect ${effectId}`);
    this.submitted.push({ id: effectId, activate });
    this.current = { fxb, leds: bench.ledCount, id: bench.id };
    return {};
  }
  async setPerf(mode: "OFF" | "BASIC" | "FULL", intervalMs: number): Promise<PerfReportMessage> {
    this.perfCalls.push([mode, intervalMs]);
    return this.report();
  }
  async getPerfReport(): Promise<PerfReportMessage> {
    return this.report();
  }

  private report(): PerfReportMessage {
    const empty = this.current === null || this.blind.has(this.current.id);
    const leds = this.current?.leds ?? 0;
    const c = empty ? { frame: 0, show: 0 } : trueCycles(this.current!.fxb, leds);
    const noisyMean = c.frame === 0 ? 0 : Math.round(c.frame * 1.35 + 25_000);
    return {
      type: "perf_report",
      effectId: this.current?.id ?? "",
      fxbHash: 0,
      cpuHz: this.cpuHz,
      budgetCycles: this.cpuHz / 30,
      frameCyclesMin: empty ? 0xffffffff : c.frame,
      frameCyclesMean: noisyMean,
      frameCyclesMax: noisyMean * 2,
      updateCyclesMean: 0,
      shadeCyclesMean: noisyMean,
      showCyclesMean: c.show,
      overruns: 0,
      droppedFrames: 0,
      samplesDropped: 0,
      heapFree: 100_000,
      heapMinFree: 90_000,
      heapLargestFree: 60_000,
      ticks: empty
        ? []
        : [
            {
              seq: 1,
              updateCycles: 0,
              shadeCycles: noisyMean,
              frameCycles: noisyMean,
              showCycles: c.show,
              ledCount: leds,
              instrUpdate: 0,
              instrShade: leds * 10,
              stackMax: 4,
            },
          ],
    };
  }
}

/** Stand in for the compiler wasm: hand-assembled bytecode per benchmark. */
function stubCompiler(t: TestContext): void {
  t.mock.method(preview, "compileScript", async (src: string): Promise<preview.FxCompiled> => {
    const bench = BENCHMARKS.find((b) => b.source === src);
    assert.ok(bench, "calibration compiled a source that is not a benchmark");
    return {
      ok: true,
      bytecode: chainFxb(bench.targetOp, bench.targetOp === null ? 0 : repsOf(bench)),
      uniforms: [],
      diagnostics: [],
    };
  });
}

test("in-browser calibration fits every opcode from the interrupt-free window minimum [rr:PR-27]", async (t) => {
  stubCompiler(t);
  const board = new SyntheticBoard();
  const progress: CalibProgress[] = [];
  const result = await runCalibration(board, {
    deviceLabel: "bench C6",
    firmwareBuild: "fw-test",
    settleMs: 0,
    onProgress: (p) => progress.push(p),
  });

  // Default = the FULL suite: every benchmark is uploaded + activated, measured
  // in FULL mode, and instrumentation is switched OFF again at the end.
  assert.deepEqual(
    board.submitted.map((s) => s.id),
    BENCHMARKS.map((b) => `__calib_${b.id}`),
  );
  assert.ok(board.submitted.every((s) => s.activate));
  assert.equal(board.perfCalls.filter(([m]) => m === "FULL").length, BENCHMARKS.length);
  assert.deepEqual(board.perfCalls.at(-1), ["OFF", 0]);

  // Fitted from the window MINIMUM: the true cost, not the IRQ-inflated mean.
  const { table } = result;
  for (const op of FITTED_OPCODES) {
    assert.ok(
      relErr(table.costs[op]!, TRUE_COSTS[op]!) < 0.01,
      `${op}: fitted ${table.costs[op]} vs true ${TRUE_COSTS[op]}`,
    );
  }
  assert.ok(relErr(table.fixedOverhead.show_per_led, TRUE_FIXED.show_per_led) < 0.01);
  assert.ok(table.residualError < 0.01, `clean data fits with ~0 residual (${table.residualError})`);

  // Provenance: a calibrated record keyed to the clock the board reported.
  assert.equal(table.origin, "calibrated");
  assert.equal(result.cpuHz, board.cpuHz);
  assert.equal(table.cpuHz, board.cpuHz);
  assert.equal(table.id, `esp32c6@${board.cpuHz}#1`);
  assert.equal(table.deviceLabel, "bench C6");
  assert.equal(table.firmwareBuild, "fw-test");
  // One re-derivable observation per benchmark: clean frame + transmit cycles.
  assert.equal(table.observations.length, BENCHMARKS.length);
  const sin = BENCHMARKS.find((b) => b.id === "sinM")!;
  const obs = table.observations.find((o) => o.label === sin.label)!;
  const c = trueCycles(chainFxb("UnMath:sin", 32), sin.ledCount);
  assert.equal(obs.measured, c.frame + c.show);
  // Progress walks every benchmark, then the fit.
  assert.deepEqual(progress.at(-1), {
    step: BENCHMARKS.length,
    total: BENCHMARKS.length,
    label: "fitting model…",
  });
});

test("a quick or partial calibration never prices an unmeasured opcode as free [rr:PR-27]", async (t) => {
  stubCompiler(t);
  // The core tier skips the cheap float ALU; the board also returns an EMPTY
  // window for both sqrt benchmarks (e.g. a dropped stream).
  const board = new SyntheticBoard(new Set(["sqrtfM", "sqrtf2M"]));
  const core = benchmarksForTier("core");
  const { table } = await runCalibration(board, { deviceLabel: "c6", settleMs: 0, tier: "core" });

  assert.equal(board.submitted.length, core.length, "only the core tier is uploaded");
  const measured = new Set(core.map((b) => b.targetOp).filter((op): op is string => op !== null));
  measured.delete("UnMath:sqrt");
  for (const op of FITTED_OPCODES) {
    if (measured.has(op)) {
      assert.ok(relErr(table.costs[op]!, TRUE_COSTS[op]!) < 0.01, `${op} measured but not fitted`);
    } else {
      assert.equal(table.costs[op], DEFAULT_COSTS[op], `${op} unmeasured but its seed changed`);
    }
  }
  assert.ok(
    ["Add", "Mul", "UnMath:abs"].every((op) => !measured.has(op)),
    "the core tier leaves the cheap ops to the seed",
  );
  // The dropped windows leave no observation behind.
  assert.equal(table.observations.length, core.length - 2);
  assert.ok(!table.observations.some((o) => o.label.startsWith("UnMath:sqrt")));
});
