import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  formatAddress,
  identifyScan,
  KNOWN_SENSORS,
  sensorByPart,
  sensorsAtAddress,
} from "../src/hardware/sensorDb";

test("sensorsAtAddress returns every module sharing an address", () => {
  // 0x48 is shared by TMP102 and ADS1115 (and more) — both must surface.
  const parts = sensorsAtAddress(0x48).map((s) => s.part);
  assert.ok(parts.includes("TMP102"), parts.join(","));
  assert.ok(parts.includes("ADS1115"), parts.join(","));
  // Ascending by part name (deterministic UI order).
  assert.deepEqual([...parts].sort(), parts);
});

test("sensorsAtAddress is empty for an unknown address", () => {
  assert.deepEqual(sensorsAtAddress(0x08), []);
});

test("identifyScan dedups, sorts, and attaches candidates", () => {
  const matches = identifyScan([0x68, 0x48, 0x68, 0x08]);
  assert.deepEqual(
    matches.map((m) => m.address),
    [0x08, 0x48, 0x68],
  );
  // 0x08 is unknown → empty candidates (user must identify).
  assert.deepEqual(matches[0]!.candidates, []);
  // 0x68 → the MPU IMUs.
  const imuParts = matches[2]!.candidates.map((c) => c.part);
  assert.ok(imuParts.includes("MPU6050"), imuParts.join(","));
});

test("formatAddress renders uppercase 0x with two digits", () => {
  assert.equal(formatAddress(0x4a), "0x4A");
  assert.equal(formatAddress(0x8), "0x08");
});

test("sensorByPart is case-insensitive and exact", () => {
  assert.equal(sensorByPart("bme280")?.part, "BME280");
  assert.equal(sensorByPart("  MPU6050 ")?.part, "MPU6050");
  assert.equal(sensorByPart("nope"), undefined);
});

test("every known sensor is well-formed", () => {
  for (const s of KNOWN_SENSORS) {
    assert.ok(s.part.length > 0, "part");
    assert.ok(s.addresses.length > 0, `${s.part} addresses`);
    assert.ok(s.measures.length > 0, `${s.part} measures`);
    for (const a of s.addresses) {
      // Valid 7-bit I2C address range.
      assert.ok(a >= 0x08 && a <= 0x77, `${s.part} addr ${a}`);
    }
  }
});
