/**
 * Multi-device estimation tests (FUG-11): estimate one program across a
 * heterogeneous fleet and surface the binding device.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { estimateAcrossDevices, describeFleet, type DeviceTarget } from "../src/effects/multiDevice";
import { defaultCostTable } from "../src/store/costTableStore";

function trivialFxb(): Uint8Array {
  const code = [6, 3, 23, 3, 3, 0, 0, 0, 33, 3];
  const h: number[] = [0x46, 0x58, 0x42, 0x31, 1, 0, 0, 0];
  const p16 = (v: number): void => {
    h.push(v & 0xff, (v >> 8) & 0xff);
  };
  p16(0);
  p16(0);
  p16(code.length);
  p16(0xffff);
  p16(0);
  return new Uint8Array([...h, ...code]);
}

test("estimates across a fleet and picks the binding device", () => {
  const fxb = trivialFxb();
  // Two devices: a fast 240 MHz board with few LEDs vs a slow 80 MHz board with
  // many LEDs. The slow, LED-heavy one should bind.
  const fast = defaultCostTable("esp32s3", 240_000_000);
  const slow = defaultCostTable("esp32c3", 80_000_000);
  const targets: DeviceTarget[] = [
    { key: "dev-fast", label: "Stage-left", table: fast, ledCount: 64, calibrated: true },
    { key: "dev-slow", label: "Stage-right", table: slow, ledCount: 256, calibrated: false },
  ];
  const fleet = estimateAcrossDevices(fxb, targets);
  assert.equal(fleet.devices.length, 2);
  assert.ok(fleet.binding);
  assert.equal(fleet.binding!.target.key, "dev-slow", "slow+256LED binds");
  // binding device has the highest budget fraction.
  for (const d of fleet.devices) {
    assert.ok(fleet.binding!.budget.fraction >= d.budget.fraction);
  }
});

test("allFit reflects whether every device fits", () => {
  const fxb = trivialFxb();
  const ok = defaultCostTable("esp32c6", 160_000_000);
  const fleet = estimateAcrossDevices(fxb, [
    { key: "a", label: "A", table: ok, ledCount: 32 },
  ]);
  assert.equal(typeof fleet.allFit, "boolean");
});

test("describeFleet renders per-device budgets + binding marker", () => {
  const fxb = trivialFxb();
  const t = defaultCostTable("esp32c6", 160_000_000);
  const fleet = estimateAcrossDevices(fxb, [
    { key: "a", label: "Alpha", table: t, ledCount: 64, calibrated: true },
    { key: "b", label: "Beta", table: t, ledCount: 256, calibrated: false },
  ]);
  const text = describeFleet(fleet);
  assert.match(text, /2 device targets/);
  assert.match(text, /Alpha/);
  assert.match(text, /Beta/);
  assert.match(text, /binding/);
  assert.match(text, /calibrated|uncalibrated/);
});

test("describeFleet handles the empty fleet", () => {
  const fleet = estimateAcrossDevices(trivialFxb(), []);
  assert.equal(fleet.binding, null);
  assert.match(describeFleet(fleet), /No device targets/);
});
