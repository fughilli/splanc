/**
 * Rigid + uniform-scale transforms for a solved map (and its topology), plus the
 * "auto-fix" helpers the map editor exposes.
 *
 * Solves come out in a camera-anchored frame (origin ≈ where the camera path
 * ended), which is rarely where you want the fixture's origin. These helpers let
 * us recenter a map on its LED centroid by default (see the capture save path)
 * and let the editor translate / rotate / scale a map after the fact.
 *
 * A transform is applied to every point that lives in the map's frame: LED
 * positions, the camera trajectory, and — when present — the topology's branch
 * points and segment polylines. Scale additionally multiplies the length-valued
 * topology fields (segment length, association foot-arclength / perpendicular
 * offset); rotation and translation leave those invariant.
 */

import type { OutputMap, Topology, Vec3 } from "@ledmapper/protocol";

export interface MapBounds {
  min: Vec3;
  max: Vec3;
  /** Bounding-box center. */
  center: Vec3;
  size: Vec3;
  /** Largest bounding-box dimension (0 for a single point). */
  maxDim: number;
  /** Mean of the LED positions (the "orthocenter" origin default). */
  centroid: Vec3;
}

/** Centroid + bounding box of a map's LEDs. Null when there are no LEDs. */
export function mapBounds(map: OutputMap): MapBounds | null {
  const leds = map.leds;
  if (leds.length === 0) return null;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  const sum: Vec3 = [0, 0, 0];
  for (const l of leds) {
    for (let i = 0; i < 3; i++) {
      const v = l.xyz[i]!;
      if (v < min[i]!) min[i] = v;
      if (v > max[i]!) max[i] = v;
      sum[i]! += v;
    }
  }
  const centroid: Vec3 = [sum[0] / leds.length, sum[1] / leds.length, sum[2] / leds.length];
  const size: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const maxDim = Math.max(size[0], size[1], size[2]);
  return { min, max, center, size, maxDim, centroid };
}

/** A composed transform: rotate then scale about `pivot`, then translate.
 * `scale` may be uniform (a number) or per-axis (a Vec3, for non-uniform stretch). */
export interface MapXform {
  translate?: Vec3;
  scale?: number | Vec3;
  rot?: { axis: "x" | "y" | "z"; deg: number };
  /** Pivot for rotation/scale (default origin). */
  pivot?: Vec3;
}

/** Apply `x` to a map (and its topology), returning fresh, transformed copies. */
export function transformMap(
  map: OutputMap,
  topology: Topology | undefined,
  x: MapXform,
): { map: OutputMap; topology?: Topology } {
  const pivot = x.pivot ?? [0, 0, 0];
  const sc = x.scale ?? 1;
  const sx = typeof sc === "number" ? sc : sc[0];
  const sy = typeof sc === "number" ? sc : sc[1];
  const sz = typeof sc === "number" ? sc : sc[2];
  // Scalar used for the length-valued topology fields. Uniform scale multiplies
  // lengths by `s`; for a non-uniform scale there's no single factor, so use the
  // geometric mean as a reasonable approximation.
  const sLen = typeof sc === "number" ? sc : Math.cbrt(Math.abs(sx * sy * sz)) || 1;
  const t = x.translate ?? [0, 0, 0];
  const rot = x.rot;
  const rad = rot ? (rot.deg * Math.PI) / 180 : 0;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);

  const f = (p: Vec3): Vec3 => {
    let x0 = p[0] - pivot[0];
    let y0 = p[1] - pivot[1];
    let z0 = p[2] - pivot[2];
    if (rot) {
      if (rot.axis === "x") {
        const y1 = y0 * cos - z0 * sin;
        const z1 = y0 * sin + z0 * cos;
        y0 = y1;
        z0 = z1;
      } else if (rot.axis === "y") {
        const x1 = x0 * cos + z0 * sin;
        const z1 = -x0 * sin + z0 * cos;
        x0 = x1;
        z0 = z1;
      } else {
        const x1 = x0 * cos - y0 * sin;
        const y1 = x0 * sin + y0 * cos;
        x0 = x1;
        y0 = y1;
      }
    }
    return [x0 * sx + pivot[0] + t[0], y0 * sy + pivot[1] + t[1], z0 * sz + pivot[2] + t[2]];
  };

  const newMap: OutputMap = { ...map, leds: map.leds.map((l) => ({ ...l, xyz: f(l.xyz) })) };
  if (map.trajectory) newMap.trajectory = map.trajectory.map(f);

  if (!topology) return { map: newMap };
  const newTopo: Topology = {
    ...topology,
    branchPoints: topology.branchPoints.map((b) => ({ ...b, xyz: f(b.xyz) })),
    segments: topology.segments.map((seg) => ({
      ...seg,
      polyline: seg.polyline.map(f),
      length: seg.length * sLen,
    })),
    associations: topology.associations.map((a) => ({
      ...a,
      footArclength: a.footArclength * sLen,
      dPerp: a.dPerp * sLen,
    })),
  };
  return { map: newMap, topology: newTopo };
}

// -- convenience ops the editor / capture path use ---------------------------

/** Recenter so the LED centroid sits at the origin (the default saved frame). */
export function recenterToCentroid(
  map: OutputMap,
  topology?: Topology,
): { map: OutputMap; topology?: Topology } {
  const b = mapBounds(map);
  if (!b) return topology ? { map, topology } : { map };
  return transformMap(map, topology, {
    translate: [-b.centroid[0], -b.centroid[1], -b.centroid[2]],
  });
}

/** Center the bounding box at the origin and scale it to fit a unit box. */
export function autoscaleToUnitBox(
  map: OutputMap,
  topology?: Topology,
): { map: OutputMap; topology?: Topology } {
  const b = mapBounds(map);
  if (!b) return topology ? { map, topology } : { map };
  const s = b.maxDim > 1e-9 ? 1 / b.maxDim : 1;
  return transformMap(map, topology, {
    pivot: b.center,
    scale: s,
    translate: [-b.center[0], -b.center[1], -b.center[2]],
  });
}
