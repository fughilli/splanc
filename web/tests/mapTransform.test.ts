/**
 * Map transform math (geom/mapTransform.ts): recenter, autoscale-to-unit-box,
 * and translate/rotate/scale over a map + its topology.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import type { OutputMap, Topology, Vec3 } from "@ledmapper/protocol";
import {
  autoscaleToUnitBox,
  mapBounds,
  recenterToCentroid,
  transformMap,
} from "../src/geom/mapTransform";

function led(id: number, xyz: Vec3) {
  return { id, xyz, confidence: 1, nViews: 3, rmsReprojPx: 0.5, parallaxDeg: 20 };
}
function map(pts: Vec3[]): OutputMap {
  return {
    mapId: "m",
    createdAt: "2026-07-23T00:00:00Z",
    units: "meters",
    frame: "gravity_leveled",
    ledCount: pts.length,
    leds: pts.map((p, i) => led(i, p)),
    unmapped: [],
    trajectory: [[10, 10, 10]],
    stats: { rmsReprojPxGlobal: 0.5, medianParallaxDeg: 20 },
  };
}
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test("recenterToCentroid puts the LED centroid at the origin", () => {
  // Centroid of these is (2, 3, 4).
  const m = map([
    [1, 2, 3],
    [3, 4, 5],
  ]);
  const { map: out } = recenterToCentroid(m);
  const b = mapBounds(out)!;
  assert.ok(close(b.centroid[0], 0) && close(b.centroid[1], 0) && close(b.centroid[2], 0));
  // Trajectory rides along in the same frame: (10,10,10) - (2,3,4) = (8,7,6).
  assert.deepEqual(out.trajectory, [[8, 7, 6]]);
});

test("autoscaleToUnitBox centers the bbox and scales its largest side to 1", () => {
  const m = map([
    [0, 0, 0],
    [4, 2, 0], // bbox 4x2x0, center (2,1,0), maxDim 4
  ]);
  const { map: out } = autoscaleToUnitBox(m);
  const b = mapBounds(out)!;
  assert.ok(close(b.center[0], 0) && close(b.center[1], 0) && close(b.center[2], 0));
  assert.ok(close(b.maxDim, 1));
});

test("translate shifts points and leaves topology lengths invariant", () => {
  const m = map([[0, 0, 0]]);
  const topo: Topology = {
    mapId: "m",
    branchPoints: [{ id: 0, xyz: [1, 0, 0] }],
    segments: [{ id: 0, a: 0, b: -1, polyline: [[0, 0, 0]], length: 2 }],
    associations: [{ ledId: 0, segmentId: 0, footArclength: 0.5, dPerp: 0.1 }],
  };
  const { map: om, topology: ot } = transformMap(m, topo, { translate: [1, 2, 3] });
  assert.deepEqual(om.leds[0]!.xyz, [1, 2, 3]);
  assert.deepEqual(ot!.branchPoints[0]!.xyz, [2, 2, 3]);
  assert.equal(ot!.segments[0]!.length, 2); // unchanged by translation
  assert.equal(ot!.associations[0]!.footArclength, 0.5);
});

test("scale about a pivot scales distances and length-valued topology fields", () => {
  const m = map([[2, 0, 0]]);
  const topo: Topology = {
    mapId: "m",
    branchPoints: [],
    segments: [{ id: 0, a: -1, b: -1, polyline: [], length: 2 }],
    associations: [{ ledId: 0, segmentId: 0, footArclength: 0.5, dPerp: 0.1 }],
  };
  const { map: om, topology: ot } = transformMap(m, topo, { scale: 2, pivot: [0, 0, 0] });
  assert.deepEqual(om.leds[0]!.xyz, [4, 0, 0]);
  assert.equal(ot!.segments[0]!.length, 4);
  assert.ok(close(ot!.associations[0]!.footArclength, 1) && close(ot!.associations[0]!.dPerp, 0.2));
});

test("rotate about the up (Y) axis by 90° maps +X to -Z", () => {
  const m = map([[1, 0, 0]]);
  const { map: out } = transformMap(m, undefined, { rot: { axis: "y", deg: 90 }, pivot: [0, 0, 0] });
  const [x, y, z] = out.leds[0]!.xyz;
  assert.ok(close(x, 0) && close(y, 0) && close(z, -1), `got ${x},${y},${z}`);
});
