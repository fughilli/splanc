/**
 * Real-hardware validation (FUG-11 review): proves the cost estimator + fitted
 * model predict the execution cost of a HELD-OUT program on the ACTUAL C6 within
 * tolerance — the thing the review asked for, pinned in CI with no hardware.
 *
 * testdata/device-bench-esp32c6.json is the UNIFIED golden: a REAL measurement
 * bundle captured on an ESP32-C6 over the HITL rig (pi/hitl/harness/fx_bench.py:
 * reserve → flash → ImprovBLE-provision → tunnel → per-program submit_map +
 * submit_effect + set_perf(FULL) → cycle-accurate PerfReport), plus an
 * `fxBenchMargins` block the HITL frame-cycle check reads (parseDeviceBundle
 * ignores it here). It is NOT synthetic — the host VM has far too much compute to
 * stand in for the FPU-less C6. The SAME file backs the on-hardware fx_bench
 * golden check, so the two tests can't drift.
 *
 * We fit the per-opcode cost model on the fit programs and validate it on a
 * held-out spread of real effects the fit never saw (incl. lavalamp). The gate:
 * the held-out RMS tracks the measured hardware cost within tolerance. The linear
 * sum-of-op-costs model tops out ~10% RMS here (it over-predicts the cheapest
 * real effects); tightening toward 5% needs a richer cost model (tracked
 * separately). If a VM/opcode/precision change regresses prediction, this fails.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDeviceBundle, buildDeviceProfile } from "../src/effects/deviceProfile";
import bundleJson from "./testdata/device-bench-esp32c6.json";

// The tightest tolerance the current linear model meets on this golden's held-out
// spread (measured RMS ~9.9%), with headroom for golden regen / noise.
const TOLERANCE = 0.13;

test("fitted model predicts held-out cost on the real C6 within tolerance", () => {
  const bundle = parseDeviceBundle(JSON.stringify(bundleJson));
  assert.equal(bundle.soc, "esp32c6");
  assert.ok(bundle.fit.length >= 10, "expected the full isolation set");
  assert.ok(bundle.heldout.length >= 3, "expected a held-out spread of real effects");

  const { profile, validation } = buildDeviceProfile(bundle, TOLERANCE);

  // Authoritative provenance — a device measurement, not the host smoke test.
  assert.equal(profile.source, "device");
  assert.equal(profile.deviceKey, bundle.deviceKey);

  // The raw measurement shows the FPU-less C6 pays more for a transcendental than
  // for a cheap ALU op AT THE SAME instruction count — exactly why the host VM
  // (where sin ≈ add) can't stand in for it. We compare the per-op SLOPE (the
  // M→2M delta, which cancels the shared fixed per-frame/per-LED overhead) rather
  // than the raw frame totals: `sin` is now LUT-accelerated on the device, so its
  // frame total is closer to `add`'s, but per invocation it still costs ~2× — and
  // the slope is what the least-squares fit actually keys on.
  const cyc = (label: string) => bundle.fit.find((s) => s.label === label)?.measuredFrameCycles;
  const [sinM, sin2M, addM, add2M] = [cyc("sinM"), cyc("sin2M"), cyc("addM"), cyc("add2M")];
  assert.ok(
    sinM && sin2M && addM && add2M,
    "expected the sinM/sin2M + addM/add2M isolation programs",
  );
  const sinCost = sin2M! - sinM!; // per-M-reps cost, fixed overhead cancelled
  const addCost = add2M! - addM!;
  assert.ok(
    sinCost > 1.5 * addCost,
    `sin should cost more per op than add on real hardware (sin slope ${sinCost} vs add slope ${addCost})`,
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
