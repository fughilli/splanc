/**
 * Real-hardware validation (FUG-11 review): proves the cost estimator + fitted
 * model predict the execution cost of a HELD-OUT program on the ACTUAL C6 within
 * tolerance — the thing the review asked for, pinned in CI with no hardware.
 *
 * testdata/device-bench-esp32c6.json is a REAL measurement bundle captured on an
 * ESP32-C6 over the HITL rig (pi/hitl/harness/fx_bench.py: reserve → flash →
 * ImprovBLE-provision → tunnel → per-program submit_map + submit_effect +
 * set_perf(FULL) → cycle-accurate PerfReport). It is NOT synthetic — the host VM
 * has far too much compute to stand in for the FPU-less C6.
 *
 * We fit the per-opcode cost model on the isolation programs and validate it on
 * the held-out program (a sin/mul mix at 200 LEDs the fit never saw). The gate:
 * the held-out prediction tracks the measured hardware cost within the model's
 * 15% tolerance. If a VM/opcode/precision change breaks that, this fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeviceBundle, buildDeviceProfile } from "../src/effects/deviceProfile";
import bundleJson from "./testdata/device-bench-esp32c6.json";

test("fitted model predicts held-out cost on the real C6 within tolerance", () => {
  const bundle = parseDeviceBundle(JSON.stringify(bundleJson));
  assert.equal(bundle.soc, "esp32c6");
  assert.ok(bundle.fit.length >= 10, "expected the full isolation set");
  assert.ok(bundle.heldout.length >= 1, "expected a held-out program");

  const { profile, validation } = buildDeviceProfile(bundle);

  // Authoritative provenance — a device measurement, not the host smoke test.
  assert.equal(profile.source, "device");
  assert.equal(profile.deviceKey, "esp32c6-f0f5bd2ce686");

  // The raw measurement shows the FPU-less C6 pays far more for a transcendental
  // than for a cheap ALU op AT THE SAME instruction count — exactly why the host
  // VM (where sin ≈ add) can't stand in for it. (We assert on the measured cycles
  // rather than the fitted per-opcode costs, which the least-squares decomposition
  // can distribute in non-obvious ways.)
  const sinM = bundle.fit.find((s) => s.label === "sinM");
  const addM = bundle.fit.find((s) => s.label === "addM");
  assert.ok(sinM && addM, "expected the sinM + addM isolation programs");
  assert.ok(
    sinM!.measuredFrameCycles > 2 * addM!.measuredFrameCycles,
    `sin should dominate add on real hardware (sinM ${sinM!.measuredFrameCycles} vs addM ${addM!.measuredFrameCycles})`,
  );

  // The gate: held-out predicted-vs-measured RMS is within the model tolerance.
  assert.ok(
    validation.samples.length >= 1 && validation.rmsError <= validation.tolerance,
    `held-out RMS ${(validation.rmsError * 100).toFixed(1)}% must be <= tolerance ${(
      validation.tolerance * 100
    ).toFixed(0)}% (predicted vs measured on real hardware)`,
  );
  assert.equal(validation.passed, true);

  // measuredError is stamped from the held-out validation (the trustworthy
  // accuracy signal), not the in-sample fit residual.
  assert.equal(typeof profile.measuredError, "number");
});
