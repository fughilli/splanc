/**
 * Common execution-profile format tests (FUG-11). Validates the portable
 * profile schema, its round-trip, conversion to/from the simulator's CostTable,
 * and — crucially — that the golden profile emitted by the Rust host
 * benchmark (tools/fx_semihost_bench) parses and feeds the simulator, pinning
 * the cross-language contract.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANONICAL_OPCODES,
  costTableToProfile,
  defaultProfile,
  opcodeCoverage,
  parseProfile,
  profileToCostTable,
  profileToStored,
  serializeProfile,
  validateProfile,
  type ExecutionProfile,
} from "../src/effects/executionProfile";
import { estimateFrameTime, DEFAULT_BUDGET_MODEL } from "../src/effects/costModel";
import golden from "./testdata/semihost-profile.json";

test("golden host profile parses and is well-formed", () => {
  const p = validateProfile(golden);
  assert.equal(p.source, "host");
  assert.equal(p.unit, "cycles");
  assert.equal(p.kind, "ledmapper-execution-profile");
  assert.ok(p.cpuHz > 0);
  // the benchmark measures the curated op set (transcendentals ≫ add).
  assert.ok(p.costs["Add"]! > 0);
  assert.ok(p.costs["UnMath"]! > p.costs["Add"]! * 5, "soft-float economics preserved");
  assert.ok(p.costs["BinMath"]! > p.costs["Mul"]!);
  // raw observations retained for re-derivation.
  assert.ok(p.observations.length > 0);
  // budget model present.
  assert.equal(p.budget.fps, 30);
});

test("profile round-trips through serialize/parse", () => {
  const p = validateProfile(golden);
  const again = parseProfile(serializeProfile(p));
  assert.deepEqual(again, p);
});

test("validateProfile rejects malformed inputs", () => {
  const ok = validateProfile(golden) as ExecutionProfile;
  const clone = (): Record<string, unknown> => JSON.parse(JSON.stringify(ok));

  assert.throws(() => validateProfile({ ...clone(), kind: "nope" }), /bad kind/);
  assert.throws(() => validateProfile({ ...clone(), version: 2 }), /unsupported version/);
  assert.throws(() => validateProfile({ ...clone(), source: "moon" }), /bad source/);
  assert.throws(() => validateProfile({ ...clone(), unit: "ms" }), /unsupported unit/);
  const noCosts = clone();
  delete noCosts["costs"];
  assert.throws(() => validateProfile(noCosts), /costs/);
  const badFixed = clone();
  (badFixed["fixed"] as Record<string, unknown>)["show_per_led"] = "x";
  assert.throws(() => validateProfile(badFixed), /show_per_led/);
});

test("profileToCostTable feeds the simulator", () => {
  const p = validateProfile(golden);
  const table = profileToCostTable(p);
  assert.equal(table.soc, p.soc);
  assert.equal(table.budgetMs, 1000 / p.budget.fps);
  assert.deepEqual(table.budget, p.budget);
  assert.equal(table.costs["UnMath"], p.costs["UnMath"]);

  // a trivial one-op shade .fxb (return vec3(pos.x)) estimates without throwing.
  const fxb = buildTrivialFxb();
  const est = estimateFrameTime({ bytecode: fxb, ledCount: 128, table });
  assert.ok(est.totalMs >= 0);
  assert.ok(est.budgetMs > 0);
});

test("costTableToProfile is the inverse of profileToCostTable for cost data", () => {
  const p = validateProfile(golden);
  const table = profileToCostTable(p);
  const p2 = costTableToProfile(table, { source: "device", toolVersion: "test" });
  assert.deepEqual(p2.costs, p.costs);
  assert.deepEqual(p2.fixed, p.fixed);
  assert.deepEqual(p2.budget, p.budget);
  assert.equal(p2.source, "device");
});

test("defaultProfile is a valid default-source profile covering costs", () => {
  const p = defaultProfile();
  assert.equal(p.source, "default");
  assert.doesNotThrow(() => validateProfile(p));
  const cov = opcodeCoverage(p);
  // the shipped default prices most opcodes; nothing outside the canonical set.
  assert.ok(cov.covered.length > 40);
  for (const op of cov.covered) assert.ok((CANONICAL_OPCODES as readonly string[]).includes(op));
});

test("opcodeCoverage reports missing opcodes for a partial (host) profile", () => {
  const p = validateProfile(golden);
  const cov = opcodeCoverage(p);
  // the curated benchmark prices only a handful; the rest ride the fallback.
  assert.ok(cov.covered.includes("Add"));
  assert.ok(cov.missing.length > 0, "host profile is intentionally partial");
  assert.ok(cov.missing.includes("SampleTex"));
});

test("profileToStored maps source to the store's origin", () => {
  assert.equal(profileToStored(validateProfile(golden), 1).origin, "host");
  assert.equal(profileToStored(defaultProfile(), 1).origin, "default");
  const dev = costTableToProfile(profileToCostTable(defaultProfile()), {
    source: "device",
    toolVersion: "t",
  });
  assert.equal(profileToStored(dev, 1).origin, "calibrated");
});

test("budget model defaults are sane", () => {
  assert.ok(DEFAULT_BUDGET_MODEL.cpuAvailableFraction > 0 && DEFAULT_BUDGET_MODEL.cpuAvailableFraction <= 1);
  assert.equal(DEFAULT_BUDGET_MODEL.fps, 30);
});

/** Build a minimal valid `.fxb`: shade() returns vec3(led.pos.x). Mirrors the
 * header layout in costModel.parseFxb / fx_vm Program::parse. */
function buildTrivialFxb(): Uint8Array {
  // code: LoadCtx C_LED_POS(3); Swizzle src3 dst3 [0,0,0]; Ret 3
  const code = [6, 3, 23, 3, 3, 0, 0, 0, 33, 3];
  const header: number[] = [];
  header.push(0x46, 0x58, 0x42, 0x31); // FXB1
  header.push(1, 0, 0, 0); // ver, flags, n_state, n_uniform
  push16(header, 0); // manifest_len
  push16(header, 0); // n_consts
  push16(header, code.length); // code_len
  push16(header, 0xffff); // update_entry (absent)
  push16(header, 0); // shade_entry
  return new Uint8Array([...header, ...code]);
}
function push16(a: number[], v: number): void {
  a.push(v & 0xff, (v >> 8) & 0xff);
}
