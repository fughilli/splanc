/**
 * plot_fixture's scene: one or more fixtures' LED maps (every LED in output
 * order, unmapped ones interpolated exactly as export_map does —
 * web/src/geom/mapExport.ts exportRows), placed by their room poses, coloured by
 * index / confidence / segment / channel / fixture or an effect frame, plus the
 * numeric summary the agent reads alongside the image.
 */

import type { MappingBundle } from "../../web/src/net/proto";
import { exportRows } from "../../web/src/geom/mapExport";
import type { Pose } from "./config";
import { category, confidenceColor, plotScene, ramp, type PlotPoint, type PlotResult, type RGB, type Vec3 } from "./plot";
import { applyPose, bbox } from "./room";

export type ColorBy = "index" | "confidence" | "segment" | "channel" | "fixture" | "effect";

export interface SceneFixture {
  name: string;
  bundle: MappingBundle;
  /** Per-channel LED counts (hardware config); absent = one channel. */
  channels?: number[];
  /** Room pose; absent = the fixture's own map frame. */
  pose?: Pose;
  posed?: boolean;
  /** An effect frame: colour by LED id (map ids). */
  effect?: Map<number, RGB>;
}

const r3 = (v: number) => +v.toFixed(3);

/** Build the plot points + summary for `fixtures`, coloured by `colorBy`. */
export function buildScene(fixtures: SceneFixture[], colorBy: ColorBy) {
  const points: PlotPoint[] = [];
  const summary: Record<string, unknown>[] = [];
  let chain = 0;
  fixtures.forEach((f, fi) => {
    const map = f.bundle.map;
    if (!map) {
      summary.push({ name: f.name, error: "no stored map" });
      return;
    }
    const rows = exportRows(map, { topology: f.bundle.topology ?? null, channels: f.channels ?? null });
    const n = rows.length;
    const segIds = [...new Set(rows.map((r) => r.segment).filter((s) => s >= 0))].sort((a, b) => a - b);
    const pts: Vec3[] = [];
    let lastChannel = -1;
    for (const row of rows) {
      const xyz = (f.pose ? applyPose(f.pose, row.xyz as Vec3) : row.xyz) as Vec3;
      pts.push(xyz);
      if (row.channel !== lastChannel) {
        chain++;
        lastChannel = row.channel;
      }
      let color: RGB;
      switch (colorBy) {
        case "confidence":
          color = row.mapped ? confidenceColor(row.confidence) : [150, 150, 160];
          break;
        case "segment":
          color = category(row.segment < 0 ? -1 : segIds.indexOf(row.segment));
          break;
        case "channel":
          color = category(row.channel);
          break;
        case "fixture":
          color = category(fi);
          break;
        case "effect":
          color = f.effect?.get(row.index) ?? [0, 0, 0];
          break;
        default:
          color = ramp(n > 1 ? row.index / (n - 1) : 0);
      }
      points.push({ xyz, color, mapped: row.mapped, index: row.index, fixture: fi, chain });
    }
    const box = bbox(pts);
    const mapped = rows.filter((r) => r.mapped).length;
    const channels = new Map<number, number>();
    for (const r of rows) channels.set(r.channel, (channels.get(r.channel) ?? 0) + 1);
    summary.push({
      name: f.name,
      led_count: n,
      mapped,
      interpolated: n - mapped,
      ...(n - mapped > 0 ? { interpolated_ids: idRanges(rows.filter((r) => !r.mapped).map((r) => r.index)) } : {}),
      channels: [...channels.entries()].map(([channel, leds]) => ({ channel, leds })),
      segments: segIds.length,
      ...(f.pose ? { pose: { ...f.pose, posed: f.posed ?? true } } : {}),
      bounding_box_m: box
        ? { min: box.min.map(r3), max: box.max.map(r3), size: box.max.map((m, k) => r3(m - box.min[k]!)) }
        : null,
    });
  });
  const legend = legendFor(colorBy, fixtures, points);
  return { points, summary, legend };
}

function legendFor(colorBy: ColorBy, fixtures: SceneFixture[], points: PlotPoint[]): { color: RGB; label: string }[] {
  const hollow = points.some((p) => !p.mapped);
  const tail = hollow ? [{ color: [150, 150, 160] as RGB, label: "RING = INTERPOLATED" }] : [];
  switch (colorBy) {
    case "confidence":
      return [
        { color: confidenceColor(0), label: "CONF 0" },
        { color: confidenceColor(0.5), label: "0.5" },
        { color: confidenceColor(1), label: "1" },
        ...tail,
      ];
    case "fixture":
      return [...fixtures.map((f, i) => ({ color: category(i), label: f.name })), ...tail];
    case "channel":
      return [...[...new Set(points.map((p) => p.chain))].slice(0, 6).map((_, i) => ({ color: category(i), label: `CH ${i}` })), ...tail];
    case "segment":
      return [{ color: category(-1), label: "NO SEGMENT" }, { color: category(0), label: "SEGMENTS: ONE COLOUR EACH" }, ...tail];
    case "effect":
      return [{ color: [120, 126, 140], label: "OUTLINE = LED POSITION" }, ...tail];
    default:
      return [
        { color: ramp(0), label: "INDEX 0" },
        { color: ramp(0.5), label: "MID" },
        { color: ramp(1), label: "LAST" },
        ...tail,
      ];
  }
}

/** "0-3,7,9-12" */
function idRanges(ids: number[]): string {
  const out: string[] = [];
  for (let i = 0; i < ids.length; ) {
    let j = i;
    while (j + 1 < ids.length && ids[j + 1] === ids[j]! + 1) j++;
    out.push(i === j ? `${ids[i]}` : `${ids[i]}-${ids[j]}`);
    i = j + 1;
  }
  return out.join(",");
}

/** Largest PNG plot_fixture returns (base64 grows it by 4/3; the relay/bridge
 * frames and MCP hosts are comfortable well below 1 MB). */
export const MAX_PLOT_BYTES = 512 * 1024;

/** Render, shrinking the image until the PNG fits MAX_PLOT_BYTES. */
export function renderScene(
  points: PlotPoint[],
  opts: Parameters<typeof plotScene>[1],
): PlotResult & { shrunk: boolean } {
  let size = opts.size ?? 768;
  for (;;) {
    const r = plotScene(points, { ...opts, size });
    if (r.png.length <= MAX_PLOT_BYTES || size <= 384) return { ...r, shrunk: size !== (opts.size ?? 768) };
    size = Math.max(384, Math.floor(size * 0.75));
  }
}
