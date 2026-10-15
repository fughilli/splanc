/** FUG-112 — the overlay draws base ∪ live solve, live, with provenance. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";
import { applySimilarity, type Similarity } from "../src/geom/fit";
import { liveUnion, stabilizeFrame } from "../src/geom/liveUnion";

function pos(id: number): Vec3 {
  return [(id % 4) * 0.1, Math.floor(id / 4) * 0.1, ((id * 7) % 5) * 0.012];
}
function led(id: number, confidence: number, xyz: Vec3 = pos(id)): LedEntry {
  return { id, xyz, confidence, nViews: 8, rmsReprojPx: 1, parallaxDeg: 20 };
}
function mapOf(leds: LedEntry[]): OutputMap {
  return {
    mapId: "m",
    createdAt: "",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: 32,
    leds,
    unmapped: [],
    stats: { rmsReprojPxGlobal: 1, medianParallaxDeg: 20 },
  };
}
function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}
// An exact rotation (35° about Z): the live solve's own gauge.
const CO = Math.cos((35 * Math.PI) / 180);
const SI = Math.sin((35 * Math.PI) / 180);
const DISGUISE: Similarity = { c: 1.3, R: [CO, -SI, 0, SI, CO, 0, 0, 0, 1], d: [1, -2, 0.5] };
const disguise = (m: OutputMap, t: Similarity = DISGUISE): OutputMap => ({
  ...m,
  leds: m.leds.map((l) => ({ ...l, xyz: applySimilarity(t, l.xyz) })),
});
const near = (a: Vec3, b: Vec3, tol = 1e-3): boolean => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol;

test("first-time capture: every live-solved LED is drawn as 'this scan' with a σ", () => {
  const live = mapOf(range(0, 7).map((id) => led(id, 0.9)));
  const u = liveUnion(null, live);
  assert.equal(u.leds.length, 8);
  assert.ok(u.leds.every((l) => l.provenance === "scan"));
  assert.ok(u.leds.every((l) => Number.isFinite(l.sigmaM) && l.sigmaM > 0));
  assert.ok(u.spacingM !== null && Math.abs(u.spacingM - 0.1) < 0.02);
  // Nothing solved yet -> nothing to draw (and no crash).
  assert.equal(liveUnion(null, null).leds.length, 0);
});

test("successive live solves are kept in ONE display frame (no re-gauge jumps)", () => {
  const first = mapOf(range(0, 7).map((id) => led(id, 0.9)));
  const u1 = liveUnion(null, first);
  // The next solve sees more LEDs but in a different gauge.
  const second = disguise(mapOf(range(0, 11).map((id) => led(id, 0.9))));
  const u2 = liveUnion(null, second, u1.map);
  assert.equal(u2.frameReset, false);
  for (const l of u2.leds) assert.ok(near(l.xyz, pos(l.id)), `id ${l.id} at ${l.xyz}`);
  // Nothing in common -> can't carry the frame; the caller drops its lock.
  const unrelated = mapOf(range(20, 27).map((id) => led(id, 0.9)));
  assert.equal(stabilizeFrame(u2.map, unrelated).reset, true);
});

test("supplement before registration: the base map alone, flagged as base", () => {
  const prior = mapOf(range(0, 11).map((id) => led(id, 0.9)));
  const u0 = liveUnion(prior, null);
  assert.equal(u0.leds.length, 12);
  assert.ok(u0.leds.every((l) => l.provenance === "base"));
  // The live solve so far shares only 2 LEDs with the base -> can't register.
  const live = disguise(mapOf([10, 11, 20, 21].map((id) => led(id, 0.9))));
  const u1 = liveUnion(prior, live);
  assert.equal(u1.registered, false);
  assert.equal(u1.leds.length, 12);
  assert.match(u1.note, /not registered yet/);
});

test("supplement: the overlay shows the UNION — base, new and re-solved LEDs", () => {
  // Base: 0..11; LEDs 8..11 were weak in the base capture (and slightly off).
  const prior = mapOf(
    range(0, 11).map((id) => (id >= 8 ? led(id, 0.3, [pos(id)[0] + 0.004, pos(id)[1], pos(id)[2]]) : led(id, 0.95))),
  );
  // Live supplemental solve (own gauge): sees 4..15 — anchors 4..7, weak 8..11,
  // and new 12..15.
  const live = disguise(mapOf(range(4, 15).map((id) => led(id, 0.9))));
  const u = liveUnion(prior, live);
  assert.ok(u.registered);
  const byId = new Map(u.leds.map((l) => [l.id, l]));
  assert.equal(byId.size, 16, "base ∪ live");
  for (const id of range(0, 7)) assert.equal(byId.get(id)!.provenance, "base");
  for (const id of range(8, 11)) assert.equal(byId.get(id)!.provenance, "updated");
  for (const id of range(12, 15)) assert.equal(byId.get(id)!.provenance, "scan");
  // Base LEDs the live solve never saw are still drawn, unmoved.
  assert.ok(near(byId.get(0)!.xyz, pos(0), 1e-9));
  // New LEDs land in the base frame.
  assert.ok(near(byId.get(13)!.xyz, pos(13)));
  assert.match(u.note, /\+4 new · 4 re-solved/);
});
