/** FUG-112 — pure helpers behind the registered projection overlay. */

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Vec3 } from "@ledmapper/protocol";
import type { BlobStatus } from "../src/cv/pipeline";
import {
  buildCorrespondences,
  classifyRegistration,
} from "../src/ui/projectionOverlay";
import type { PnpResult } from "../src/geom/pnp";

function blob(u: number, v: number, ledId: number | null): BlobStatus {
  return { u, v, area: 20, matched: ledId !== null, ledId };
}

test("buildCorrespondences pairs decoded+solved blobs only", () => {
  const solved = new Map<number, Vec3>([
    [1, [0, 0, 0]],
    [2, [1, 0, 0]],
  ]);
  const blobs: BlobStatus[] = [
    blob(10, 10, 1), // decoded + solved -> kept
    blob(20, 20, 2), // decoded + solved -> kept
    blob(30, 30, 3), // decoded but NOT solved -> dropped
    blob(40, 40, null), // undecoded -> dropped
  ];
  const corrs = buildCorrespondences(blobs, solved);
  assert.equal(corrs.length, 2);
  assert.deepEqual(corrs[0], { xyz: [0, 0, 0], u: 10, v: 10 });
  assert.deepEqual(corrs[1], { xyz: [1, 0, 0], u: 20, v: 20 });
});

test("classifyRegistration: a good lock is 'locked'", () => {
  const res: PnpResult = { pose: { p: [0, 0, 0], q: [0, 0, 0, 1] }, rmsPx: 1.2, inliers: 18, total: 20, ok: true };
  const r = classifyRegistration(res, 20, false);
  assert.equal(r.tone, "locked");
  assert.match(r.label, /Registered/);
  assert.equal(r.inliers, 18);
});

test("classifyRegistration: coasting on grace is 'weak'", () => {
  const res: PnpResult = { pose: { p: [0, 0, 0], q: [0, 0, 0, 1] }, rmsPx: 9, inliers: 3, total: 20, ok: false };
  const r = classifyRegistration(res, 20, true);
  assert.equal(r.tone, "weak");
});

test("classifyRegistration: too few known LEDs -> lost with the right hint", () => {
  const r = classifyRegistration(null, 2, false);
  assert.equal(r.tone, "lost");
  assert.match(r.label, /few known LEDs/);
});

test("classifyRegistration: enough LEDs but no lock -> 'fixture may have moved'", () => {
  const res: PnpResult = { pose: { p: [0, 0, 0], q: [0, 0, 0, 1] }, rmsPx: 40, inliers: 2, total: 15, ok: false };
  const r = classifyRegistration(res, 15, false);
  assert.equal(r.tone, "lost");
  assert.match(r.label, /may have moved/);
});
