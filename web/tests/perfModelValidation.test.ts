/**
 * Held-out validation of the effect performance model against the REAL ESP32-C6
 * (PR-27, the risk control for RISK-2 "the performance model gives false
 * confidence"). testdata/device-bench-esp32c6.json is a measurement bundle
 * captured on a C6 over the HITL rig (pi/hitl/harness/fx_bench.py): `fit`
 * programs calibrate the per-opcode cost table, `heldout` programs (named
 * `*.heldout.fx`) are real effects the fit never sees.
 *
 * deviceProfileHardware.test.ts already gates the held-out RMS. This suite pins
 * the properties that make that number trustworthy and keep the user from being
 * told an effect fits when it does not:
 *   - the held-out set is genuinely held out (disjoint, and it cannot move the fit);
 *   - the uncertainty band the estimator reports covers what the hardware measured;
 *   - the calibrated verdict never calls an effect that overran on the C6 "green";
 *   - the worst single held-out misprediction is bounded, not just the RMS;
 *   - calibrating against the device never does worse than the shipped seed model;
 *   - the profile manager shows the held-out error next to the in-sample residual.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { installFakeDom, textOf, asFake } from "./fakeDom";
import {
  buildDeviceProfile,
  parseDeviceBundle,
  type DeviceBenchmarkBundle,
  type DeviceSample,
} from "../src/effects/deviceProfile";
import { estimateFrameTime } from "../src/effects/costModel";
import { validateCostModel, type HeldoutSample } from "../src/effects/profileValidation";
import { defaultProfile, profileToStored, validateProfile } from "../src/effects/executionProfile";
import { defaultCostTable, type StoredCostTable } from "../src/store/costTableStore";
import type { Router } from "../src/ui/app/router";
import bundleJson from "./testdata/device-bench-esp32c6.json";
import hostProfileJson from "./testdata/semihost-profile.json";

/** Same tolerance as deviceProfileHardware.test.ts (the RMS gate). */
const TOLERANCE = 0.13;
/** Worst-case bound for any ONE held-out effect (golden today: ~16%, neg2M). */
const MAX_SINGLE_ERROR = 0.2;

function golden(): DeviceBenchmarkBundle {
  return parseDeviceBundle(JSON.stringify(bundleJson));
}

/** Total measured frame time (frame + transmit) of a sample, ms. */
function measuredMs(s: DeviceSample, cpuHz: number): number {
  return ((s.measuredFrameCycles + s.measuredShowCycles) / cpuHz) * 1000;
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

test("held-out programs are disjoint from the fit and cannot move the fitted model [rr:PR-27]", () => {
  const bundle = golden();
  assert.ok(bundle.heldout.length >= 3, "expected a held-out spread of real effects");

  // Disjoint by name and by the exact bytecode that ran.
  const fitLabels = new Set(bundle.fit.map((s) => s.label));
  const fitCode = new Set(bundle.fit.map((s) => hex(s.fxb)));
  for (const h of bundle.heldout) {
    assert.ok(!fitLabels.has(h.label), `${h.label} is both fitted and held out`);
    assert.ok(!fitCode.has(hex(h.fxb)), `${h.label}'s bytecode is also a fit program`);
  }

  // Tripling every held-out measurement must leave the fitted table untouched
  // (the held-out set only SCORES the model) while the validation sees it.
  const base = buildDeviceProfile(bundle, TOLERANCE);
  const skewed = buildDeviceProfile(
    {
      ...bundle,
      heldout: bundle.heldout.map((s) => ({
        ...s,
        measuredFrameCycles: s.measuredFrameCycles * 3,
        measuredShowCycles: s.measuredShowCycles * 3,
      })),
    },
    TOLERANCE,
  );
  assert.deepEqual(skewed.table.costs, base.table.costs, "held-out data leaked into the cost fit");
  assert.deepEqual(skewed.table.fixed, base.table.fixed, "held-out data leaked into the overhead fit");
  assert.equal(skewed.table.residualError, base.table.residualError);
  assert.ok(
    skewed.validation.rmsError > base.validation.rmsError + 0.3,
    "the validation must score against the held-out measurements",
  );
  assert.equal(skewed.validation.passed, false);
});

test("every held-out effect's measured C6 frame time lies inside the calibrated model's error band [rr:PR-27]", () => {
  const bundle = golden();
  const { table } = buildDeviceProfile(bundle, TOLERANCE);
  for (const h of bundle.heldout) {
    const est = estimateFrameTime({ bytecode: h.fxb, ledCount: h.ledCount, table });
    const ms = measuredMs(h, bundle.cpuHz);
    assert.ok(
      est.errorBand.lowMs <= ms && ms <= est.errorBand.highMs,
      `${h.label}: measured ${ms.toFixed(2)} ms outside the reported band ` +
        `${est.errorBand.lowMs.toFixed(2)}–${est.errorBand.highMs.toFixed(2)} ms (false confidence)`,
    );
  }
});

test("the calibrated verdict never calls a held-out effect that overran on the C6 green [rr:PR-27]", () => {
  const bundle = golden();
  const { table } = buildDeviceProfile(bundle, TOLERANCE);
  let overran = 0;
  let fit = 0;
  for (const h of bundle.heldout) {
    const est = estimateFrameTime({ bytecode: h.fxb, ledCount: h.ledCount, table });
    const over = measuredMs(h, bundle.cpuHz) > est.budgetMs;
    if (over) {
      overran++;
      assert.notEqual(
        est.confidence,
        "green",
        `${h.label} overran the budget on the C6 but was shown green`,
      );
    } else {
      fit++;
      assert.notEqual(est.confidence, "red", `${h.label} fit the budget on the C6 but was shown red`);
    }
  }
  // The golden holds both kinds, so both directions of the check are exercised.
  assert.ok(
    overran >= 1 && fit >= 1,
    `need over- and under-budget held-out effects (${overran}/${fit})`,
  );
});

test("no single held-out effect is mispredicted by more than 20% [rr:PR-27]", () => {
  const bundle = golden();
  const { validation } = buildDeviceProfile(bundle, TOLERANCE);
  const offenders = validation.samples
    .filter((s) => s.absRelError > MAX_SINGLE_ERROR)
    .map((s) => `${s.label} ${(s.relError * 100).toFixed(1)}%`);
  assert.deepEqual(offenders, [], "held-out effects outside the per-effect error bound");
  assert.ok(validation.maxAbsError <= MAX_SINGLE_ERROR);
  assert.equal(validation.samples.length, bundle.heldout.length, "every held-out effect is scored");
});

test("calibrating against the device predicts held-out effects at least as well as the shipped seed [rr:PR-27]", () => {
  const bundle = golden();
  const { validation: calibrated } = buildDeviceProfile(bundle, TOLERANCE);
  const samples: HeldoutSample[] = bundle.heldout.map((h) => ({
    label: h.label,
    bytecode: h.fxb,
    ledCount: h.ledCount,
    measuredMs: measuredMs(h, bundle.cpuHz),
  }));
  const seed = validateCostModel(defaultCostTable(bundle.soc, bundle.cpuHz), samples, TOLERANCE);
  assert.ok(
    calibrated.rmsError <= seed.rmsError,
    `calibrated held-out RMS ${calibrated.rmsError} must not exceed the seed's ${seed.rmsError}`,
  );
  assert.ok(calibrated.passed, "the calibrated model meets the held-out tolerance");
});

test("the profile manager shows each profile's held-out error beside its fit residual [rr:PR-27]", async () => {
  const dom = installFakeDom();
  try {
    const { PerfProfilesScreen } = await import("../src/ui/screens/perfProfiles");
    const { costTableStore } = await import("../src/store/costTableStore");

    const bundle = { ...golden(), deviceLabel: "C6 bench", deviceKey: "AA:BB:CC:00:11:22" };
    const { profile } = buildDeviceProfile(bundle, TOLERANCE);
    const device = profileToStored(profile, 1);
    const host = profileToStored(validateProfile(hostProfileJson), 1);
    const seed = profileToStored(defaultProfile(), 1);
    const realList = costTableStore.list;
    costTableStore.list = async (): Promise<StoredCostTable[]> => [seed, host, device];
    try {
      const screen = PerfProfilesScreen({ navigate() {} } as unknown as Router);
      screen.onMount?.();
      await new Promise((r) => setImmediate(r));

      const rows = asFake(screen.el).querySelectorAll(".perf-profiles > .k-card");
      assert.equal(rows.length, 3);
      const readouts = (row: unknown): Record<string, string> =>
        Object.fromEntries(
          asFake(row)
            .querySelectorAll(".perf-readout")
            .map((r) => [
              textOf(r.querySelector(".perf-readout-label")),
              textOf(r.querySelector(".perf-readout-val")),
            ]),
        );

      // The authoritative device calibration is listed first, with BOTH numbers.
      assert.match(textOf(rows[0]!.querySelector(".perf-effect")), /C6 bench/);
      assert.equal(textOf(rows[0]!.querySelector(".perf-badge")), "device");
      const dev = readouts(rows[0]);
      assert.equal(dev["validated"], `±${Math.round(profile.measuredError! * 100)}% (held-out)`);
      assert.equal(dev["fit residual"], `±${Math.round(profile.residualError * 100)}%`);
      assert.equal(dev["device"], "AA:BB:CC:00:11:22");
      // Unvalidated seeds never claim a held-out accuracy.
      assert.equal(readouts(rows[1])["validated"], "—");
      assert.equal(textOf(rows[1]!.querySelector(".perf-badge")), "host");
      assert.equal(readouts(rows[2])["validated"], "—");
      assert.equal(textOf(rows[2]!.querySelector(".perf-badge")), "default");
    } finally {
      costTableStore.list = realList;
    }
  } finally {
    dom.uninstall();
  }
});
