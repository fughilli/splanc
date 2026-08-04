/**
 * Device-profile builder tests (FUG-11): turn a raw HITL measurement bundle
 * into a validated `device` ExecutionProfile, and confirm held-out validation
 * catches a wrong model. Measured cycles are generated from the default table
 * via the estimator so the fit sees self-consistent data.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDeviceProfile,
  parseDeviceBundle,
  serializeDeviceBundle,
  type DeviceBenchmarkBundle,
  type DeviceSample,
} from "../src/effects/deviceProfile";
import { estimateFrameTime } from "../src/effects/costModel";
import { defaultCostTable } from "../src/store/costTableStore";
import { validateProfile } from "../src/effects/executionProfile";

const CPU_HZ = 160_000_000;

// -- tiny .fxb assembler (shade = chain of one op over pos.x) ---------------
const Op = { LoadCtx: 6, Mul: 9, Add: 7, PushConst: 0, UnMath: 13, Swizzle: 23, Ret: 33 };
const C_LED_POS = 3;

function fxbShade(stepBytes: number[], reps: number, consts: number[]): Uint8Array {
  const code: number[] = [Op.LoadCtx, C_LED_POS, Op.Swizzle, 3, 1, 0];
  for (let i = 0; i < reps; i++) code.push(...stepBytes);
  code.push(Op.Swizzle, 1, 3, 0, 0, 0, Op.Ret, 3);
  const h: number[] = [0x46, 0x58, 0x42, 0x31, 1, 0, 0, 0];
  const p16 = (v: number): void => {
    h.push(v & 0xff, (v >> 8) & 0xff);
  };
  p16(0); // manifest
  p16(consts.length); // n_consts
  p16(code.length); // code_len
  p16(0xffff); // update entry absent
  p16(0); // shade entry
  const cbytes: number[] = [];
  for (const c of consts) {
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, c, true);
    for (let i = 0; i < 4; i++) cbytes.push(dv.getUint8(i));
  }
  return new Uint8Array([...h, ...cbytes, ...code]);
}

const mulChain = (reps: number): Uint8Array =>
  fxbShade([Op.PushConst, 0, 0, Op.Mul, 1], reps, [1.001]);
const addChain = (reps: number): Uint8Array =>
  fxbShade([Op.PushConst, 0, 0, Op.Add, 1], reps, [1.001]);
const sinChain = (reps: number): Uint8Array => fxbShade([Op.UnMath, 0 /*sin*/, 1], reps, []);

/** A measured sample for a program under the default table (self-consistent). */
function sample(label: string, fxb: Uint8Array, ledCount: number, bias = 1): DeviceSample {
  const est = estimateFrameTime({ bytecode: fxb, ledCount, table: defaultCostTable() });
  const measuredFrameCycles = ((est.phaseSplit.updateMs + est.phaseSplit.shadeMs) / 1000) * CPU_HZ * bias;
  const measuredShowCycles = (est.phaseSplit.showMs / 1000) * CPU_HZ;
  return { label, fxb, ledCount, measuredFrameCycles, measuredShowCycles };
}

function baseBundle(heldoutBias = 1): DeviceBenchmarkBundle {
  return {
    soc: "esp32c6",
    cpuHz: CPU_HZ,
    deviceKey: "AA:BB:CC:DD:EE:01",
    deviceLabel: "rig-01",
    firmwareBuild: "test-fw",
    timestamp: "2026-08-04T00:00:00.000Z",
    fit: [
      sample("mul x8 @128", mulChain(8), 128),
      sample("mul x16 @128", mulChain(16), 128),
      sample("add x8 @128", addChain(8), 128),
      sample("add x16 @128", addChain(16), 128),
      sample("sin x8 @128", sinChain(8), 128),
      sample("mul x8 @256", mulChain(8), 256),
      sample("mul x8 @16", mulChain(8), 16),
    ],
    heldout: [
      sample("mixed @128", mulChain(6), 128, heldoutBias),
      sample("mixed @200", addChain(10), 200, heldoutBias),
    ],
  };
}

test("buildDeviceProfile produces a validated device profile", () => {
  const { profile, validation, table } = buildDeviceProfile(baseBundle(1));
  assert.equal(profile.source, "device");
  assert.equal(profile.deviceKey, "AA:BB:CC:DD:EE:01");
  assert.equal(profile.firmwareBuild, "test-fw");
  assert.equal(profile.deviceLabel, "rig-01");
  // it's a complete, valid profile.
  assert.doesNotThrow(() => validateProfile(profile));
  // fitted opcodes present + budget carried.
  assert.ok(table.costs["Mul"]! > 0);
  assert.ok(profile.budget.fps === 30);
  // held-out validation ran and stamped measuredError.
  assert.equal(validation.samples.length, 2);
  assert.equal(typeof profile.measuredError, "number");
  // self-consistent data → the model predicts held-out well.
  assert.ok(profile.measuredError! < 0.2, `measuredError small, got ${profile.measuredError}`);
  assert.ok(validation.r2 > 0.5, `R² should be high, got ${validation.r2}`);
  // observations retained for every measured program.
  assert.equal(profile.observations.length, 7 + 2);
});

test("measuredError is the held-out validation RMS, and the profile is per-device keyed", () => {
  const { profile, validation } = buildDeviceProfile(baseBundle(1));
  // measuredError is exactly the (clamped) held-out RMS error.
  assert.ok(Math.abs(profile.measuredError! - Math.min(1, validation.rmsError)) < 1e-9);
  // every held-out sample carries its predicted vs measured.
  for (const s of validation.samples) {
    assert.ok(s.predictedMs > 0 && s.measuredMs > 0);
  }
  // a bundle with NO held-out set leaves measuredError unset (nothing validated).
  const noHeldout = { ...baseBundle(1), heldout: [] as DeviceSample[] };
  const { profile: p2 } = buildDeviceProfile(noHeldout);
  assert.equal(p2.measuredError, undefined);
});

test("device bundle round-trips through JSON (base64 bytecode)", () => {
  const bundle = baseBundle(1);
  const again = parseDeviceBundle(serializeDeviceBundle(bundle));
  assert.equal(again.fit.length, bundle.fit.length);
  assert.equal(again.deviceKey, bundle.deviceKey);
  assert.deepEqual(Array.from(again.fit[0]!.fxb), Array.from(bundle.fit[0]!.fxb));
  // and it still builds a profile.
  const { profile } = buildDeviceProfile(again);
  assert.equal(profile.source, "device");
});
