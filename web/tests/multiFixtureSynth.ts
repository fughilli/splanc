/**
 * Synthetic rooms for the multi-fixture localizer tests (not a test file itself):
 * several mapped fixtures at random poses, a handheld phone walking past them,
 * and the per-frame decoded sightings the capture pipeline would produce —
 * pixel noise, decode dropouts, mis-decoded outliers, per-LED map error (the
 * map the solver gets is NOT the truth it was rendered from) and per-map metric
 * scale error.
 */

import type { Intrinsics, Pose, Vec3 } from "@ledmapper/protocol";
import { lookAtQuat, project } from "../src/geom/pinhole";
import type { CaptureView, FixtureModel, RoomPose } from "../src/geom/multiFixture";
import { applyRoomPose } from "../src/geom/multiFixture";

export const K: Intrinsics = [1000, 1000, 640, 360];
export const IMG_W = 1280;
export const IMG_H = 720;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gaussian(rand: () => number): () => number {
  return () => {
    const u = Math.max(1e-12, rand());
    const v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
}

export type Shape = "lamp" | "panel" | "ring" | "strip" | "tree";

/** LED positions of a fixture shape, centred at its centroid, gravity-levelled (+Y up). */
export function shapeLeds(shape: Shape, rand: () => number): Vec3[] {
  const out: Vec3[] = [];
  switch (shape) {
    case "lamp": // helix around a vertical axis
      for (let i = 0; i < 120; i++) {
        const a = i * 0.45;
        out.push([0.12 * Math.cos(a), -0.3 + (0.6 * i) / 119, 0.12 * Math.sin(a)]);
      }
      break;
    case "panel": // vertical 10x6 grid
      for (let r = 0; r < 6; r++) for (let c = 0; c < 10; c++) out.push([(c - 4.5) * 0.05, (r - 2.5) * 0.05, 0]);
      break;
    case "ring": // horizontal ring, slightly wavy
      for (let i = 0; i < 48; i++) {
        const a = (i / 48) * 2 * Math.PI;
        out.push([0.25 * Math.cos(a), 0.03 * Math.sin(3 * a), 0.25 * Math.sin(a)]);
      }
      break;
    case "strip": // straight horizontal strip, 1.2 m
      for (let i = 0; i < 60; i++) out.push([-0.6 + (1.2 * i) / 59, 0, 0]);
      break;
    case "tree": // cone point cloud
      for (let i = 0; i < 150; i++) {
        const h = rand();
        const r = 0.3 * (1 - h) * Math.sqrt(rand());
        const a = rand() * 2 * Math.PI;
        out.push([r * Math.cos(a), -0.4 + 0.8 * h, r * Math.sin(a)]);
      }
      break;
  }
  const c: Vec3 = [0, 0, 0];
  for (const p of out) for (let k = 0; k < 3; k++) c[k] = c[k]! + p[k]! / out.length;
  return out.map((p) => [p[0] - c[0], p[1] - c[1], p[2] - c[2]]);
}

export interface SynthFixture {
  shape: Shape;
  /** TRUE LED positions (map frame, true metres). */
  truth: Vec3[];
  /** True pose in the (truth) room frame for the TRUE map. */
  pose: RoomPose;
  /** The map the solver gets: truth · mapScale + noise. */
  model: FixtureModel;
  mapScale: number;
}

export interface RoomOptions {
  seed: number;
  shapes: Shape[];
  /** Per-LED map error σ, m (default 0.003). */
  mapNoiseM?: number;
  /** Map scale error spread for non-reference fixtures (default 0: exact). */
  scaleErr?: number;
  /** Max tilt of fixtures vs their map's level, deg (default 0 = all level). */
  tiltDeg?: number;
  /** Room extent along x, m (default 3). */
  spreadM?: number;
}

function yawQuat(deg: number): [number, number, number, number] {
  const h = (deg * Math.PI) / 360;
  return [0, Math.sin(h), 0, Math.cos(h)];
}

function quatMul(a: number[], b: number[]): [number, number, number, number] {
  const [ax, ay, az, aw] = a as [number, number, number, number];
  const [bx, by, bz, bw] = b as [number, number, number, number];
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function makeRoom(o: RoomOptions): SynthFixture[] {
  const rand = mulberry32(o.seed);
  const g = gaussian(rand);
  const spread = o.spreadM ?? 3;
  const n = o.shapes.length;
  return o.shapes.map((shape, k) => {
    const truth = shapeLeds(shape, rand);
    const x = n === 1 ? 0 : -spread / 2 + (spread * k) / (n - 1) + (rand() - 0.5) * 0.3;
    const pose: RoomPose = {
      translation: [x, 0.6 + rand() * 1.0, -0.6 + rand() * 0.9],
      rotation: quatMul(yawQuat(-60 + 120 * rand()), [
        ...(() => {
          const t = (((o.tiltDeg ?? 0) * Math.PI) / 180) * (rand() - 0.5) * 2;
          return [Math.sin(t / 2), 0, 0, Math.cos(t / 2)];
        })(),
      ]),
      scale: 1,
    };
    const mapScale = k === 0 ? 1 : 1 + (o.scaleErr ?? 0) * (rand() < 0.5 ? -1 : 1) * (0.5 + 0.5 * rand());
    const sigma = o.mapNoiseM ?? 0.003;
    const leds = new Map<number, Vec3>();
    truth.forEach((p, i) =>
      leds.set(i, [p[0] * mapScale + sigma * g(), p[1] * mapScale + sigma * g(), p[2] * mapScale + sigma * g()]),
    );
    return {
      shape,
      truth,
      pose,
      mapScale,
      model: { id: `fx${k}`, name: `${shape}${k}`, leds, up: [0, 1, 0], scaleRelStdErr: 0.03 },
    };
  });
}

/** The true room pose of a fixture's GIVEN map (the solver's target): truth pose ∘ (1/mapScale). */
export function truthPoseOfModel(f: SynthFixture): RoomPose {
  return { ...f.pose, scale: f.pose.scale / f.mapScale };
}

export interface CaptureSimOptions {
  seed: number;
  frames?: number;
  noisePx?: number;
  /** Probability an in-view LED is not decoded in a frame. */
  dropP?: number;
  /** Probability an in-view LED sighting is a gross outlier (random pixel). */
  outlierP?: number;
  /** Horizontal half-field the camera pans across (fraction of the room); small = partial views. */
  panFrac?: number;
  /** Camera distance from the fixture line, m (default 3). */
  distM?: number;
  /** Camera translation amplitude, m (default 1.2); 0 = tripod (rotation only). */
  walkM?: number;
  /** Vertical camera bob amplitude, m (default 0.25). */
  bobM?: number;
  /** Fixtures (indices) never in view together with any other: skip frames showing them with others. */
  isolate?: number[];
}

export interface CaptureSim {
  views: CaptureView[];
  cameras: Pose[];
}

/** A handheld walk: the camera slides along an arc in front of the fixtures and
 * pans across them, with hand jitter; each frame decodes the visible LEDs. */
export function simulateCapture(room: SynthFixture[], o: CaptureSimOptions): CaptureSim {
  const rand = mulberry32(o.seed);
  const g = gaussian(rand);
  const frames = o.frames ?? 240;
  const noise = o.noisePx ?? 1;
  const dist = o.distM ?? 3;
  const walk = o.walkM ?? 1.2;
  const pan = o.panFrac ?? 1;
  const centers = room.map((f) => f.pose.translation);
  const xs = centers.map((c) => c[0]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const cy = centers.reduce((s, c) => s + c[1], 0) / centers.length;
  const cz = centers.reduce((s, c) => s + c[2], 0) / centers.length;
  const views: CaptureView[] = [];
  const cameras: Pose[] = [];
  for (let f = 0; f < frames; f++) {
    const tau = f / Math.max(1, frames - 1);
    // Serpentine: left->right->left so neighbours overlap repeatedly.
    const s = 0.5 - 0.5 * Math.cos(tau * 2 * Math.PI * 1.5);
    // walkM = 0: a tripod (the camera only pans; no translation at all).
    const tri = walk === 0 ? 0 : 1;
    const eye: Vec3 = [
      (xmin + xmax) / 2 + (s - 0.5) * 2 * walk + tri * 0.05 * g(),
      1.4 + tri * ((o.bobM ?? 0.25) * Math.sin(tau * 7) + 0.03 * g()),
      cz + dist + tri * (0.3 * Math.sin(tau * 5) + 0.03 * g()),
    ];
    const mid = (xmin + xmax) / 2;
    const halfSpan = ((xmax - xmin) / 2) * pan;
    const target: Vec3 = [mid + (s - 0.5) * 2 * Math.max(halfSpan, 0.01) + 0.1 * g(), cy + 0.1 * g(), cz];
    const q = lookAtQuat(eye, target);
    // Hand roll jitter.
    const roll = 0.04 * g();
    const pose: Pose = { p: eye, q: quatMul(q, [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)]) };
    const sightings: CaptureView["sightings"] = [];
    room.forEach((fx, k) => {
      fx.truth.forEach((x, i) => {
        const w = applyRoomPose(fx.pose, x);
        const pr = project(pose, K, w);
        if (pr.depth <= 0.1) return;
        if (pr.u < 0 || pr.u >= IMG_W || pr.v < 0 || pr.v >= IMG_H) return;
        if (rand() < (o.dropP ?? 0.1)) return;
        if (rand() < (o.outlierP ?? 0)) {
          sightings.push({ fixture: k, led: i, u: rand() * IMG_W, v: rand() * IMG_H });
          return;
        }
        sightings.push({ fixture: k, led: i, u: pr.u + noise * g(), v: pr.v + noise * g() });
      });
    });
    if (o.isolate && o.isolate.length) {
      const present = new Set(sightings.map((s) => s.fixture));
      const iso = o.isolate.filter((k) => present.has(k));
      if (iso.length && present.size > 1) {
        // Drop the isolated fixture's sightings from shared frames.
        for (let j = sightings.length - 1; j >= 0; j--) if (iso.includes(sightings[j]!.fixture)) sightings.splice(j, 1);
      }
    }
    views.push({ t: f * 100, K, sightings });
    cameras.push(pose);
  }
  return { views, cameras };
}
