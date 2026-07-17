/**
 * Camera exposure-constraint planning (xr/exposureControl.ts): the pure
 * capability → constraints mapping that locks the camera exposure DOWN so the
 * sensor stops blowing the LEDs to white (auto-exposure defeats LED dimming in
 * the dark). No DOM/getUserMedia here — just the constraint arithmetic.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  type ExposureCapabilities,
  type ExposurePlan,
  planExposure,
} from "../src/xr/exposureControl";

/** The first `advanced` constraint of a plan (asserting it exists). */
function adv(plan: ExposurePlan | null): Record<string, unknown> {
  assert.ok(plan, "expected a plan");
  const list = plan.constraints.advanced as Record<string, unknown>[] | undefined;
  assert.ok(list && list[0], "expected an advanced constraint");
  return list[0];
}

test("prefers a manual exposure lock and pins ISO to its minimum", () => {
  const caps: ExposureCapabilities = {
    exposureMode: ["continuous", "manual"],
    exposureTime: { min: 5, max: 1000 },
    iso: { min: 100, max: 3200 },
    exposureCompensation: { min: -3, max: 3 },
  };
  const a = adv(planExposure(caps, 0));
  assert.equal(a["exposureMode"], "manual");
  assert.equal(a["exposureTime"], 5); // target 0 → minimum exposure
  assert.equal(a["iso"], 100); // gain held at the floor
});

test("target interpolates linearly across the exposureTime range", () => {
  const caps: ExposureCapabilities = {
    exposureMode: ["manual"],
    exposureTime: { min: 0, max: 1000 },
  };
  assert.equal(adv(planExposure(caps, 0))["exposureTime"], 0);
  assert.equal(adv(planExposure(caps, 0.25))["exposureTime"], 250);
  assert.equal(adv(planExposure(caps, 1))["exposureTime"], 1000);
});

test("maxExposureMs (Nyquist) caps the manual exposure range", () => {
  const caps: ExposureCapabilities = { exposureMode: ["manual"], exposureTime: { min: 5, max: 10000 } };
  // exposureTime is in 100µs units, so a 35ms cap = 350 units. target=1 lands
  // at the cap, not the camera's 10000.
  assert.equal(adv(planExposure(caps, 1, 35))["exposureTime"], 350);
  assert.equal(adv(planExposure(caps, 0, 35))["exposureTime"], 5); // the min is unchanged
  assert.equal(adv(planExposure(caps, 1))["exposureTime"], 10000); // uncapped, for contrast
});

test("maxExposureMs never forces below the camera minimum", () => {
  const caps: ExposureCapabilities = { exposureMode: ["manual"], exposureTime: { min: 50, max: 10000 } };
  // 1ms cap = 10 units < min 50 → clamp to the min (can't expose shorter).
  assert.equal(adv(planExposure(caps, 1, 1))["exposureTime"], 50);
});

test("maxExposureMs does not touch the compensation fallback", () => {
  const caps: ExposureCapabilities = {
    exposureMode: ["continuous"],
    exposureCompensation: { min: -3, max: 3 },
  };
  assert.equal(adv(planExposure(caps, 1, 35))["exposureCompensation"], 3);
});

test("target is clamped to [0,1]", () => {
  const caps: ExposureCapabilities = {
    exposureMode: ["manual"],
    exposureTime: { min: 10, max: 20 },
  };
  assert.equal(adv(planExposure(caps, -5))["exposureTime"], 10);
  assert.equal(adv(planExposure(caps, 5))["exposureTime"], 20);
});

test("falls back to exposure compensation when manual is unavailable", () => {
  const caps: ExposureCapabilities = {
    exposureMode: ["continuous"],
    exposureCompensation: { min: -3, max: 3 },
  };
  const a = adv(planExposure(caps, 0));
  assert.equal(a["exposureCompensation"], -3); // target 0 → most-negative bias
  assert.equal(a["exposureMode"], undefined); // no mode forced in the fallback
});

test("manual needs BOTH the mode and a time range, else it falls back", () => {
  // exposureMode advertises manual but there's no exposureTime range to set.
  const caps: ExposureCapabilities = {
    exposureMode: ["manual"],
    exposureCompensation: { min: -2, max: 2 },
  };
  const a = adv(planExposure(caps, 0.5));
  assert.equal(a["exposureCompensation"], 0); // midpoint of [-2, 2]
  assert.equal(a["exposureTime"], undefined);
});

test("returns null when the camera exposes no exposure controls", () => {
  assert.equal(planExposure({}, 0), null);
  assert.equal(planExposure({ exposureMode: ["continuous"] }, 0), null);
});
