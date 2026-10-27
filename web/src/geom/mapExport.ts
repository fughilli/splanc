/**
 * Map export for other show / mapping software: one row per LED in OUTPUT
 * order (the LED's global output index), serialized as
 *
 *  - CSV shaped as a TouchDesigner "Points DAT": header
 *    `index,P(0),P(1),P(2),…`, so a Table DAT loading the file feeds a DAT to
 *    SOP directly (one SOP point per row, point number = `index`, the extra
 *    columns become point attributes). No comment lines: a Table DAT would load
 *    them as rows. Positions are METRES.
 *  - Chromatik (LX Studio) `.lxf` JSON fixture: one `points` component per
 *    output channel, coords in output order, so the fixture's point index is
 *    the LED's output index. A top-level `scale` transform driven by a `scale`
 *    fixture parameter (default 100 = centimetres, editable in Chromatik).
 *
 * Unmapped LEDs (in `map.unmapped`, or simply absent from `map.leds` — sparse
 * ids) still get a row so indices stay contiguous: `mapped = 0` and a position
 * linearly interpolated by index between the nearest mapped neighbours, clamped
 * at the strip ends — the same fill the firmware renders them at (#255). With
 * no mapped LED at all every position is the origin.
 *
 * Arclength: `arclength` is the distance ALONG THE STRIP, metres — the running
 * sum of LED-to-LED distances in output order (over the interpolated positions
 * too), restarting at 0 on each output channel (each channel is its own
 * physical strip). It is monotonic and ends near the strip's physical length
 * whatever the topology looks like. The topology's own coordinate — the LED's
 * foot point along its `segment` — is the separate `segment_arclength` column:
 * the two only agree for a single straight-run segment that follows the strip
 * (a coil / tube topology is its centreline, which can be far shorter; #396).
 *
 * Axes: Splanc maps are gravity-levelled, right-handed, +Y up (the WebXR
 * convention) — the same as TouchDesigner and Chromatik, so the default export
 * is unchanged. `up: "z"` rewrites to right-handed +Z up (Blender-style):
 * (x, y, z) → (x, −z, y).
 *
 * Pure (no DOM): the app's Export sheet and the agent bridge's `export_map`
 * tool share it.
 */

import type { OutputMap, Topology, Vec3 } from "@ledmapper/protocol";

export type UpAxis = "y" | "z";

export interface MapExportOptions {
  /** Fixture / map name: the `.lxf` label. */
  name?: string;
  /** LED → segment associations (the stored topology), for the segment columns. */
  topology?: Topology | null;
  /** Per-channel LED counts in channel order (the device's hardware config).
   * Channels form one global index space: channel 0's LEDs first. Ignored
   * unless it covers the map exactly (see channelLayoutFor); absent = one
   * channel holding every LED. */
  channels?: readonly number[] | null;
  /** CSV only: output up axis (default "y", Splanc's own). */
  up?: UpAxis;
}

export interface ExportRow {
  /** Global output index (the LED id). */
  index: number;
  /** Position, metres, in the requested up-axis convention. */
  xyz: Vec3;
  /** False when the solve didn't place this LED (position is interpolated). */
  mapped: boolean;
  /** Solve confidence in [0, 1]; 0 for unmapped LEDs. */
  confidence: number;
  /** Output channel, and the LED's index within that channel. */
  channel: number;
  channelIndex: number;
  /** Topology segment id, or -1 when there is no topology / association. */
  segment: number;
  /** Distance along the strip from the channel's first LED, metres: the
   * cumulative LED-to-LED distance in output order (see the module doc). */
  arclength: number;
  /** Arclength of the LED's foot point along `segment`, metres (0 when none). */
  segmentArclength: number;
}

/** CSV header — a TouchDesigner Points DAT (DAT to SOP) layout. */
export const CSV_COLUMNS = [
  "index",
  "P(0)",
  "P(1)",
  "P(2)",
  "mapped",
  "confidence",
  "channel",
  "channel_index",
  "segment",
  "arclength",
  "segment_arclength",
] as const;

/** LED count the export covers: the map's count, widened to any larger id. */
export function exportLedCount(map: OutputMap): number {
  let n = Math.max(0, map.ledCount | 0);
  for (const l of map.leds) n = Math.max(n, l.id + 1);
  return n;
}

/** `counts` when it is a usable channel layout for an `n`-LED map (every count
 * >= 0, summing to exactly n), else null (= treat as one channel). Trailing
 * zero-LED channels are dropped. */
export function channelLayoutFor(n: number, counts: readonly number[] | null | undefined): number[] | null {
  if (!counts || counts.length === 0) return null;
  const c = counts.map((x) => Math.max(0, Math.floor(x || 0)));
  while (c.length > 1 && c[c.length - 1] === 0) c.pop();
  const sum = c.reduce((s, x) => s + x, 0);
  return sum === n && n > 0 ? c : null;
}

function dist3(a: Vec3, b: Vec3): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
}

function toUp(p: Vec3, up: UpAxis): Vec3 {
  return up === "z" ? [p[0], -p[2], p[1]] : [p[0], p[1], p[2]];
}

/** Every LED's export row, in output order. */
export function exportRows(map: OutputMap, opts: MapExportOptions = {}): ExportRow[] {
  const n = exportLedCount(map);
  const up = opts.up ?? "y";
  const unmapped = new Set(map.unmapped);
  const pos: (Vec3 | null)[] = new Array<Vec3 | null>(n).fill(null);
  const conf = new Float64Array(n);
  for (const l of map.leds) {
    if (l.id < 0 || l.id >= n || unmapped.has(l.id)) continue;
    pos[l.id] = l.xyz;
    conf[l.id] = l.confidence;
  }

  // Interpolate the gaps by index between mapped neighbours (clamped at ends).
  const filled: Vec3[] = new Array<Vec3>(n);
  let prev = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && pos[i] === null) continue;
    const a = prev >= 0 ? pos[prev]! : null;
    const b = i < n ? pos[i]! : null;
    for (let k = prev + 1; k < i; k++) {
      if (a && b) {
        const t = (k - prev) / (i - prev);
        filled[k] = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
      } else {
        filled[k] = a ?? b ?? [0, 0, 0];
      }
    }
    if (b) filled[i] = b;
    prev = i;
  }

  const assoc = new Map<number, { segment: number; arclength: number }>();
  for (const a of opts.topology?.associations ?? []) {
    assoc.set(a.ledId, { segment: a.segmentId, arclength: a.footArclength });
  }

  const layout = channelLayoutFor(n, opts.channels) ?? [n];
  const rows: ExportRow[] = [];
  let index = 0;
  layout.forEach((count, channel) => {
    let along = 0;
    for (let j = 0; j < count; j++, index++) {
      const s = assoc.get(index);
      if (j > 0) along += dist3(filled[index - 1]!, filled[index]!);
      rows.push({
        index,
        xyz: toUp(filled[index]!, up),
        mapped: pos[index] !== null,
        confidence: pos[index] !== null ? conf[index]! : 0,
        channel,
        channelIndex: j,
        segment: s?.segment ?? -1,
        arclength: along,
        segmentArclength: s?.arclength ?? 0,
      });
    }
  });
  return rows;
}

/** Fixed-point with trailing zeros trimmed ("-0" → "0"). */
function num(v: number, digits: number): string {
  const s = v.toFixed(digits).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

/** The map as TouchDesigner-ready CSV (see the module doc). No trailing
 * newline: a Table DAT would otherwise grow an empty last row. */
export function mapToCsv(map: OutputMap, opts: MapExportOptions = {}): string {
  const lines: string[] = [CSV_COLUMNS.join(",")];
  for (const r of exportRows(map, opts)) {
    lines.push(
      [
        r.index,
        num(r.xyz[0], 5),
        num(r.xyz[1], 5),
        num(r.xyz[2], 5),
        r.mapped ? 1 : 0,
        num(r.confidence, 3),
        r.channel,
        r.channelIndex,
        r.segment,
        num(r.arclength, 5),
        num(r.segmentArclength, 5),
      ].join(","),
    );
  }
  return lines.join("\n");
}

/** Compact id list: [1,2,3,7,9,10] → "1-3,7,9-10". */
export function idRanges(ids: readonly number[]): string {
  const s = [...new Set(ids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(i === j ? `${s[i]}` : `${s[i]}-${s[j]}`);
    i = j + 1;
  }
  return out.join(",");
}

/** Default `.lxf` scale: Chromatik units per metre (100 = centimetres, which
 * suits Chromatik's default 5-unit point size). */
export const LXF_DEFAULT_SCALE = 100;

/** The map as a Chromatik `.lxf` fixture (JSON). Always Chromatik's +Y up
 * (Splanc's own); `opts.up` is ignored. */
export function mapToLxf(map: OutputMap, opts: MapExportOptions = {}): string {
  const rows = exportRows(map, { ...opts, up: "y" });
  const layout = channelLayoutFor(rows.length, opts.channels);
  const components: Record<string, unknown>[] = [];
  const perChannel = new Map<number, ExportRow[]>();
  for (const r of rows) {
    const list = perChannel.get(r.channel);
    if (list) list.push(r);
    else perChannel.set(r.channel, [r]);
  }
  for (const [channel, rs] of perChannel) {
    components.push({
      type: "points",
      ...(layout ? { id: `channel${channel}` } : {}),
      coords: rs.map((r) => ({ x: Number(num(r.xyz[0], 5)), y: Number(num(r.xyz[1], 5)), z: Number(num(r.xyz[2], 5)) })),
    });
  }
  const unmapped = rows.filter((r) => !r.mapped).map((r) => r.index);
  // Meta values pass through Chromatik's $variable substitution: keep '$' out.
  const clean = (s: string) => s.replace(/\$/g, "");
  const label = clean((opts.name ?? "").trim()) || "Splanc fixture";
  const fixture = {
    label,
    tags: ["splanc"],
    parameters: {
      scale: {
        type: "float",
        default: LXF_DEFAULT_SCALE,
        min: 0.001,
        max: 100000,
        label: "Scale",
        description: "Model units per metre (100 = centimetres, 39.37 = inches, 1 = metres)",
      },
    },
    transforms: [{ scale: "$scale" }],
    components,
    meta: {
      source: "splanc",
      mapId: clean(map.mapId),
      units: "metres x scale",
      ledCount: String(rows.length),
      ...(layout ? { channels: layout.join(",") } : {}),
      unmapped: idRanges(unmapped),
    },
  };
  return JSON.stringify(fixture, null, 2);
}

/** `<fixture-name>-<YYYY-MM-DD>.<ext>`, filesystem-safe. */
export function exportFileName(name: string, ext: string, date: Date = new Date()): string {
  const slug =
    name
      .trim()
      .replace(/[^\w.-]+/g, "_")
      .replace(/^[_.]+|[_.]+$/g, "") || "map";
  const pad = (v: number) => String(v).padStart(2, "0");
  const d = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${slug}-${d}.${ext}`;
}
