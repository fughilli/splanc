/**
 * The demo's state and what it streams to the lamp: a port of the desktop demo's
 * `--p4` live mode (app.py send_plane / send_params / p4_look) plus the hot-spots game.
 *
 * Everything here is in the WORLD frame (lhd's, +Z up): the P4 tracks itself, and the
 * effects move the shapes into the lamp's map frame every render frame.
 *
 * Modes and the effect each runs:
 *   plane    tracker_demo_pose: /pick -1, /shape 0, /plane n d    (a plane at the stylus tip,
 *            perpendicular to the stylus)
 *   sphere   tracker_demo_pose: /pick -1, /shape 1, /sphere c r   (a sphere round the tip)
 *   outline  tracker_demo_pose: /pick -2 (the faint outline; idle)
 *   spots    hot_spots_pose:    /spot0..3, /color0..3, /radius, /range
 *   flashlight  flashlight_pose: /origin, /dir, /width (rad), /color, /decay,
 *            /stylus_ok, /stylus_seq, /stale_after (a port of flashlight.py; see
 *            flashlight.ts)
 * `follow` off holds the shape where it is (the stylus can go away); the stylus
 * button then grabs and carries it (grab.ts).
 */

import type { LhStation, Vec3 } from "./lh/types";
import { axisWorld, planeFromPointNormal, tipWorld, type Pose } from "./frames";
import { messageTyped } from "./osc";
import { PARAM_KEEPALIVE_S } from "./streamer";
import { beamColor, decaySent, initialBeam, STALE_S, type BeamState } from "./flashlight";

export type Mode = "plane" | "sphere" | "outline" | "spots" | "flashlight";
export type EffectKey = "tracker_demo" | "hot_spots" | "flashlight";

/** The effect ids the page deploys under (stable, so a redeploy replaces in place). */
export const EFFECT_IDS: Record<EffectKey, string> = {
  tracker_demo: "p4demo-tracker",
  hot_spots: "p4demo-hot-spots",
  flashlight: "p4demo-flashlight",
};

export function effectFor(mode: Mode): EffectKey {
  return mode === "spots" ? "hot_spots" : mode === "flashlight" ? "flashlight" : "tracker_demo";
}

/** tracker_demo_pose's /pick: -1 shows the live shape, -2 the faint outline. */
export const LOOK_SHAPE = -1;
export const LOOK_OUTLINE = -2;

export const SPOT_COUNT = 4;
export const DEFAULT_SPOT_COLORS: Vec3[] = [
  [1, 0, 0],
  [0, 1, 0],
  [0, 0.2, 1],
  [1, 0.7, 0],
];

export interface Spot {
  pos: Vec3 | null; // null: not placed (sent with colour 0, i.e. off)
  color: Vec3;
}

export interface DemoState {
  mode: Mode;
  follow: boolean;
  /** half-thickness, m (tracker_demo_pose `width`, 0.002..0.1). */
  width: number;
  /** soft falloff beyond width, m (0..0.2). */
  halo: number;
  glow: Vec3;
  /** sphere radius, m. */
  radius: number;
  plane: { n: Vec3; d: number };
  sphere: { c: Vec3; r: number };
  spots: Spot[];
  /** hot spots: inside this (m) it's a hit. */
  spotRadius: number;
  /** hot spots: a spot starts to show this far away (m). */
  spotRange: number;
  /** The flashlight beam (flashlight mode). */
  beam: BeamState;
}

export function initialState(): DemoState {
  return {
    mode: "plane", // start LIVE: the desktop demo starting idle confused people
    follow: true,
    width: 0.01,
    halo: 0.03,
    glow: [1, 0.4, 0.1],
    radius: 0.08,
    plane: { n: [0, 0, 1], d: 1 },
    sphere: { c: [0, 0, 1], r: 0.08 },
    spots: DEFAULT_SPOT_COLORS.map((c) => ({ pos: null, color: [...c] as Vec3 })),
    spotRadius: 0.05,
    spotRange: 0.4,
    beam: initialBeam(),
  };
}

/** Move the shapes to a new stylus pose (when following). Returns whether they moved. */
export function followStylus(s: DemoState, stylus: Pose, tipS: Vec3 | null): boolean {
  if (!s.follow) return false;
  const tip = tipWorld(stylus, tipS ?? [0, 0, 0]);
  const axis = axisWorld(stylus, tipS);
  s.plane = planeFromPointNormal(tip, axis);
  s.sphere = { c: tip, r: s.radius };
  return true;
}

export interface OscValue {
  values: number[];
  /** Re-send period (s); undefined = the streamer's default keep-alive (the shape). */
  keepalive?: number;
}

/** Every address the demo streams, for clearing what a mode doesn't use. */
export const ALL_ADDRESSES = [
  "/pick", "/shape", "/plane", "/sphere", "/width", "/halo", "/glow",
  ...Array.from({ length: SPOT_COUNT }, (_, i) => `/spot${i}`),
  ...Array.from({ length: SPOT_COUNT }, (_, i) => `/color${i}`),
  "/radius", "/range",
  "/origin", "/dir", "/color", "/decay", "/stylus_ok", "/stylus_seq", "/stale_after",
];

/** What the streamer should hold for this state (app.py p4_look + send_plane +
 * send_params, and the hot-spots uniforms). Addresses not in the map are cleared. */
export function oscFor(s: DemoState): Map<string, OscValue> {
  const out = new Map<string, OscValue>();
  const k = PARAM_KEEPALIVE_S;
  if (s.mode === "spots") {
    s.spots.forEach((sp, i) => {
      out.set(`/spot${i}`, { values: sp.pos ? [...sp.pos] : [0, 0, -10], keepalive: k });
      out.set(`/color${i}`, { values: sp.pos ? [...sp.color] : [0, 0, 0], keepalive: k });
    });
    out.set("/radius", { values: [s.spotRadius], keepalive: k });
    out.set("/range", { values: [s.spotRange], keepalive: k });
    return out;
  }
  if (s.mode === "flashlight") {
    const b = s.beam;
    out.set("/origin", { values: [...b.origin] });
    out.set("/dir", { values: [...b.dir] });
    out.set("/stylus_seq", { values: [b.seq] });
    out.set("/stylus_ok", { values: [b.ok ? 1 : 0] });
    out.set("/width", { values: [b.width], keepalive: k });
    out.set("/color", { values: [...beamColor(b)], keepalive: k });
    out.set("/decay", { values: [decaySent(b)], keepalive: k });
    // The effect's own heartbeat timeout, the same threshold as the page's.
    out.set("/stale_after", { values: [STALE_S], keepalive: k });
    return out;
  }
  if (s.mode === "outline") {
    out.set("/pick", { values: [LOOK_OUTLINE], keepalive: k });
    return out;
  }
  out.set("/pick", { values: [LOOK_SHAPE], keepalive: k });
  out.set("/shape", { values: [s.mode === "sphere" ? 1 : 0], keepalive: k });
  if (s.mode === "sphere") out.set("/sphere", { values: [...s.sphere.c, s.radius] });
  else out.set("/plane", { values: [...s.plane.n, s.plane.d] });
  out.set("/width", { values: [s.width], keepalive: k });
  out.set("/halo", { values: [s.halo], keepalive: k });
  out.set("/glow", { values: [...s.glow], keepalive: k });
  return out;
}

/** The subset of OscStreamer the demo drives. */
export interface StreamerLike {
  set(address: string, values: number[], opts?: { keepalive?: number }): void;
  clear(...addresses: string[]): void;
  has(address: string): boolean;
}

/** Bring the streamer to `oscFor(s)`: set what the mode uses, clear the rest. */
export function syncStreamer(st: StreamerLike, s: DemoState): void {
  const want = oscFor(s);
  const drop = ALL_ADDRESSES.filter((a) => !want.has(a) && st.has(a));
  if (drop.length) st.clear(...drop);
  for (const [a, v] of want) st.set(a, v.values, v.keepalive !== undefined ? { keepalive: v.keepalive } : {});
}

/** One `/lh/station ,iffffff f` per station (app.py _p4_station_sync): id, then world <-
 * station as x y z qw qx qy qz. Each goes as its own datagram: the P4 tracker module
 * only claims single messages, never bundles. */
export function stationMessages(stations: LhStation[]): Uint8Array[] {
  return stations.map((st) => messageTyped("/lh/station", { i: st.id }, ...st.pos, ...st.quat));
}

/** Parse a CSS #rrggbb colour into 0..1 floats. */
export function hexToRgb(hex: string): Vec3 {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [1, 1, 1];
  const n = parseInt(m[1]!, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: Vec3): string {
  const h = (x: number): string =>
    Math.round(Math.min(1, Math.max(0, x)) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
}
