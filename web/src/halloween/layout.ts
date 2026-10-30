/**
 * Synthetic "curtain + rope" layout for the Halloween installs (and any fixture
 * built the same way): an LED curtain on channel 0 and an LED rope on channel 1.
 *
 * A curtain draped over pumpkins is too lumpy to capture well, and effects look
 * better on the curtain's LOGICAL grid than on its physical drape anyway (a
 * column of LEDs reads as a column even when the fabric folds). So instead of a
 * camera capture, the owner types in how the curtain is wired and this builds
 * the map from the grid, saves it like any other map, and pushes it to the device.
 *
 * Index space (matches Hardware Setup: channel 0's LEDs first, then channel 1's):
 *   - LEDs [0, cols*rows)            the curtain, in wiring order (CH0)
 *   - LEDs [cols*rows, + rope.count) the rope, first LED first (CH1)
 *
 * Coordinates (metres, y up, frame "gravity_leveled"):
 *   - Curtain: x = column * colSpacing (column 0 on the viewer's left), y =
 *     height above the bottom row (row 0 = the top row), z = 0 exactly.
 *   - Rope: laid along the curtain's bottom edge (y = 0), spanning the curtain's
 *     width left to right, in FRONT of it: z >= ROPE_Z (an arc bulges further out).
 *
 * How an effect tells them apart: `led.pos.z > 0.1` is the rope (see
 * ROPE_Z_THRESHOLD). Because the rope stays inside the curtain's x/y footprint,
 * `led.uv` (the map's x/y box normalized to 0..1) is exactly the curtain grid:
 * uv.x = column across (0 left .. 1 right), uv.y = height (0 bottom .. 1 top);
 * on the rope uv.x runs along the rope and uv.y is 0.
 */

import type { LedEntry, OutputMap, Vec3 } from "@ledmapper/protocol";

/** The corner where the curtain's FIRST LED (the data input) is, seen from the front. */
export type Corner = "top-left" | "top-right" | "bottom-left" | "bottom-right";

export const CORNERS: { value: Corner; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
];

export interface CurtainSpec {
  /** LEDs across (columns). */
  cols: number;
  /** LEDs down (rows). */
  rows: number;
  /** Where LED 0 is. */
  origin: Corner;
  /** Which way each run of LEDs goes: "columns" = vertical strands hanging
   * down (the usual LED curtain), "rows" = horizontal runs. */
  runs: "columns" | "rows";
  /** "serpentine" = each run doubles back (zig-zag); "linear" = every run starts
   * from the same side (row-major / column-major). */
  wiring: "serpentine" | "linear";
  /** Metres between columns / between rows. */
  colSpacing: number;
  rowSpacing: number;
}

export interface RopeSpec {
  /** LEDs on the rope (0 = no rope). */
  count: number;
  /** A straight line along the curtain's foot, or a gentle arc in front of it. */
  shape: "line" | "arc";
}

export interface CurtainRopeSpec {
  curtain: CurtainSpec;
  rope: RopeSpec;
}

/** The rope's distance in front of the curtain plane (metres). */
export const ROPE_Z = 0.3;
/** `led.pos.z` above this is the rope; the curtain is at z = 0. */
export const ROPE_Z_THRESHOLD = 0.1;
/** Extra bulge of the arc at its middle, as a fraction of the rope's span. */
const ARC_BULGE = 0.25;
/** Rope LED pitch used only when the curtain has no width (one column). */
const ROPE_PITCH = 0.05;

export const DEFAULT_SPEC: CurtainRopeSpec = {
  curtain: {
    cols: 20,
    rows: 20,
    origin: "top-left",
    runs: "columns",
    wiring: "serpentine",
    colSpacing: 0.1,
    rowSpacing: 0.1,
  },
  rope: { count: 120, shape: "arc" },
};

function posInt(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/** Grid cell of curtain LED `i` (wiring order). Row 0 is the TOP row, column 0
 * the viewer's LEFT column, whatever the origin corner. */
export function curtainCell(c: CurtainSpec, i: number): { col: number; row: number } {
  const cols = Math.max(1, posInt(c.cols));
  const rows = Math.max(1, posInt(c.rows));
  // Walk in "run" coordinates: `run` = which strand, `k` = position along it.
  const runLen = c.runs === "columns" ? rows : cols;
  const run = Math.floor(i / runLen);
  let k = i % runLen;
  if (c.wiring === "serpentine" && run % 2 === 1) k = runLen - 1 - k;
  // Origin-relative cell, then flip into top-left-relative.
  let col = c.runs === "columns" ? run : k;
  let row = c.runs === "columns" ? k : run;
  if (c.origin === "top-right" || c.origin === "bottom-right") col = cols - 1 - col;
  if (c.origin === "bottom-left" || c.origin === "bottom-right") row = rows - 1 - row;
  return { col, row };
}

/** Positions of the curtain (wiring order) then the rope. */
export function layoutPositions(spec: CurtainRopeSpec): Vec3[] {
  const c = spec.curtain;
  const cols = Math.max(1, posInt(c.cols));
  const rows = Math.max(1, posInt(c.rows));
  const sx = c.colSpacing > 0 ? c.colSpacing : 0.1;
  const sy = c.rowSpacing > 0 ? c.rowSpacing : 0.1;
  const pts: Vec3[] = [];
  for (let i = 0; i < cols * rows; i++) {
    const { col, row } = curtainCell(c, i);
    pts.push([col * sx, (rows - 1 - row) * sy, 0]);
  }
  const n = posInt(spec.rope.count);
  const width = (cols - 1) * sx;
  const span = width > 0 ? width : Math.max(1, n - 1) * ROPE_PITCH;
  for (let j = 0; j < n; j++) {
    const t = n > 1 ? j / (n - 1) : 0.5;
    const z = spec.rope.shape === "arc" ? ROPE_Z + ARC_BULGE * span * Math.sin(Math.PI * t) : ROPE_Z;
    pts.push([t * span, 0, z]);
  }
  return pts;
}

/** Channel split of a spec: how many LEDs each channel must be set to. */
export function channelCounts(spec: CurtainRopeSpec): { ch0: number; ch1: number } {
  return {
    ch0: Math.max(1, posInt(spec.curtain.cols)) * Math.max(1, posInt(spec.curtain.rows)),
    ch1: posInt(spec.rope.count),
  };
}

/** A short human name, e.g. "Curtain 20×15 + rope 120". */
export function layoutName(spec: CurtainRopeSpec): string {
  const { cols, rows } = spec.curtain;
  const rope = posInt(spec.rope.count);
  return `Curtain ${posInt(cols)}×${posInt(rows)}` + (rope > 0 ? ` + rope ${rope}` : "");
}

/** Build the map (ids = strip indices across both channels, every LED mapped). */
export function generateCurtainRopeMap(spec: CurtainRopeSpec, now: Date = new Date()): OutputMap {
  const leds: LedEntry[] = layoutPositions(spec).map((xyz, id) => ({
    id,
    xyz,
    confidence: 1,
    nViews: 0,
    rmsReprojPx: 0,
    parallaxDeg: 0,
  }));
  // Short: the firmware keeps map ids in 64-byte strings.
  const c = spec.curtain;
  const mapId = `curtain-${posInt(c.cols)}x${posInt(c.rows)}r${posInt(spec.rope.count)}-${now.getTime().toString(36)}`;
  return {
    mapId,
    createdAt: now.toISOString(),
    units: "meters",
    frame: "gravity_leveled",
    ledCount: leds.length,
    leds,
    unmapped: [],
    stats: { rmsReprojPxGlobal: 0, medianParallaxDeg: 0 },
  };
}

/** Suggest a curtain W×H for `count` LEDs on CH0: the factor pair closest to
 * square-ish (wider than tall), or null when count is 0. */
export function suggestGrid(count: number): { cols: number; rows: number } | null {
  const n = posInt(count);
  if (n === 0) return null;
  let best = { cols: n, rows: 1 };
  for (let r = 1; r * r <= n; r++) {
    if (n % r === 0) best = { cols: n / r, rows: r };
  }
  return best;
}
