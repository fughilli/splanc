/**
 * Moving-camera mapping-link simulator (#448): the software stand-in for the
 * moving-camera HITL rig (pi/hitl/phone/MOVING_CAMERA_RIG.md) until it exists.
 *
 * A camera orbits a known 3D fixture (a helix of LEDs on a cylinder, the
 * back half occluded by the fixture body) with optional hand-shake, while
 * the ambient light varies. Each camera frame integrates the LED hue code
 * over its EXPOSURE WINDOW — so a long exposure averages two symbols across
 * a frame transition and a moving camera smears the blob (motion blur dilutes
 * the peak below the detector floor) — adds an ambient white veil
 * (desaturates hue), clips each channel at the sensor ceiling (hue collapse
 * when over-exposed) and adds shot noise that grows as the signal falls.
 * The resulting blob stream drives the PRODUCTION track/decode pipeline
 * (cv/pipeline.ts, dense records as the capture page runs it) and the
 * PRODUCTION negotiation functions (cv/exposure.ts: recommendConfig,
 * planReconfigure, planSymbolSwitch, planExposureServo — with the capture
 * page's two-tick confirmation and pipeline rebuild on configure), so a
 * policy change is measured end to end.
 *
 * Every blob carries its true LED id, so every emitted record is checked
 * exactly: the LinkTelemetry it produces has a truth block (correct /
 * incorrect ids), which real captures only get from a surveyed fixture.
 *
 * The photometric model is deliberately simple (documented constants, not a
 * calibrated sensor model): use it to COMPARE policies against a baseline,
 * not to predict absolute capture times. The real-rig phase calibrates it.
 */

import type { CodeParams, DetectionRecord, Pose, Vec3 } from "@ledmapper/protocol";
import { colorForFrame, DATA_FRAME_OFFSET, dataFrames, expectedBits } from "../src/code/gray";
import { frameIndexAt } from "../src/code/timing";
import {
  BIT_PERIOD_MAX_MS,
  BIT_PERIOD_MIN_MS,
  MIN_FRAMES_PER_BIT,
  planExposureServo,
  planReconfigure,
  planSymbolSwitch,
  recommendConfig,
  SYMBOL_DOWNGRADE_MARGIN,
  SYMBOL_UPGRADE_MARGIN,
} from "../src/cv/exposure";
import { LinkTelemetry, type LinkTelemetrySnapshot } from "../src/cv/linkTelemetry";
import { CvPipeline } from "../src/cv/pipeline";
import type { Blob } from "../src/cv/types";
import { lookAtQuat, project } from "../src/geom/pinhole";

export interface LinkScenario {
  name: string;
  ledCount: number;
  durationMs: number;
  /** Nominal camera rate; drops to `lowLightFps` while ambient < lowLightAmbient
   * (auto-exposure lengthening the frame — the shutter-speed proxy). */
  fps: number;
  lowLightFps?: number;
  lowLightAmbient?: number;
  /** Orbit: angular speed about the fixture axis, radius, start angle. */
  orbitDegPerS: number;
  radiusM: number;
  /** Hand-shake: sinusoidal yaw/pitch wobble amplitude (deg) and frequency (Hz). */
  shakeDeg?: number;
  shakeHz?: number;
  /** Ambient white veil vs time, [0, 1] at the reference exposure. */
  ambient: (tMs: number) => number;
  /** Camera → frame-callback latency (absorbed by the decoder's alignment). */
  latencyMs?: number;
  /** Probability a frame is dropped by the camera pipeline. */
  dropP?: number;
  seed?: number;
}

export interface LinkPolicy {
  name: string;
  /** 'auto' = recommendConfig at start + planSymbolSwitch mid-capture. */
  symbols: "auto" | 2 | 4;
  /** 'auto' = recommendConfig + planReconfigure; a number pins it. */
  bitPeriodMs: "auto" | number;
  /** Camera exposure: 'servo' = planExposureServo over [1 ms, bit/2]
   * starting at `exposureStart`; a number pins it (ms). */
  exposure: "servo" | number;
  exposureStart?: number;
  /** Mid-capture alphabet-switch margin band (planSymbolSwitch). */
  downgradeMargin?: number;
  upgradeMargin?: number;
  /** Scene-luma gate on the 2 → 4 upgrade (default HUE4_MIN_MEAN_LUMA). */
  upgradeMinLuma?: number;
  brightness?: number;
}

export const BASELINE_POLICY: LinkPolicy = {
  name: "baseline",
  symbols: "auto",
  bitPeriodMs: "auto",
  exposure: "servo",
  exposureStart: 0.25,
  downgradeMargin: SYMBOL_DOWNGRADE_MARGIN,
  upgradeMargin: SYMBOL_UPGRADE_MARGIN,
};

/** Fixed photometric constants (see the module note). */
const REF_EXPOSURE_MS = 8;
const LED_GAIN = 0.9; // full-brightness LED channel level at REF_EXPOSURE_MS
const BLOB_RADIUS_PX = 3; // unblurred blob radius; blur spreads light over more
const DETECT_FLOOR = 0.12; // peak below this: the detector misses the blob
const NOISE_FLOOR = 0.015;
const SHOT_NOISE = 0.03;
const CAST: Vec3 = [1.0, 0.85, 0.7]; // white-balance cast the decode must cancel
const SUBSAMPLES = 4; // exposure-window integration steps
const IMG_W = 1280;
const IMG_H = 720;
const K: [number, number, number, number] = [900, 900, IMG_W / 2, IMG_H / 2];
const CLOCK_OFFSET = 500;
const EPOCH0 = 10_000;
const CONFIGURE_LATENCY_MS = 150;

/** Helix of `n` LEDs on a cylinder (radius 0.15 m, 0.8 m tall, 6 turns),
 * with outward normals — the "known fixture" the rig orbits. */
export function helixFixture(n: number): { pos: Vec3[]; normal: Vec3[] } {
  const pos: Vec3[] = [];
  const normal: Vec3[] = [];
  const turns = 6;
  for (let i = 0; i < n; i++) {
    const f = n > 1 ? i / (n - 1) : 0;
    const a = f * turns * 2 * Math.PI;
    pos.push([0.15 * Math.cos(a), -0.4 + 0.8 * f, 0.15 * Math.sin(a)]);
    normal.push([Math.cos(a), 0, Math.sin(a)]);
  }
  return { pos, normal };
}

export function codeParams(ledCount: number, symbols: 2 | 4, bitPeriodMs: number, brightness?: number): CodeParams {
  const p: CodeParams = {
    ledCount,
    bits: 0,
    encoding: "hue",
    symbols,
    bitPeriodMs,
    syncPattern: "on_off",
    cycleFrames: 0,
    fec: "secded",
    ...(brightness !== undefined ? { brightness } : {}),
  };
  p.bits = expectedBits(p);
  p.cycleFrames = DATA_FRAME_OFFSET + dataFrames(p);
  return p;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rotateY(v: Vec3, a: number): Vec3 {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [c * v[0] + s * v[2], v[1], -s * v[0] + c * v[2]];
}

/** Camera pose at local time t: orbit + look-at + shake (a wobbling target). */
function poseAt(sc: LinkScenario, tMs: number): Pose {
  const ang = ((sc.orbitDegPerS * tMs) / 1000) * (Math.PI / 180);
  const eye: Vec3 = [sc.radiusM * Math.sin(ang), 0.1, sc.radiusM * Math.cos(ang)];
  const sh = ((sc.shakeDeg ?? 0) * Math.PI) / 180;
  const hz = sc.shakeHz ?? 2;
  const w = 2 * Math.PI * hz * (tMs / 1000);
  // Shake as a small look-at offset perpendicular-ish to the view.
  const off = sc.radiusM * Math.tan(sh);
  const tgtBase: Vec3 = [off * Math.sin(w), off * Math.sin(1.7 * w + 1), 0];
  const target = rotateY(tgtBase, ang);
  return { p: eye, q: lookAtQuat(eye, target) };
}

/** The code the LEDs are driving at local time t (configure takes effect
 * at its scheduled instant, with a fresh epoch). */
interface CodeEpoch {
  fromLocalMs: number;
  params: CodeParams;
  epochServer: number;
}

export interface LinkSimResult {
  telemetry: LinkTelemetrySnapshot;
  /** LED ids that were visible (unoccluded, in frame, bright enough) at least once. */
  visibleIds: number;
  records: number;
}

export function runLinkSim(sc: LinkScenario, policy: LinkPolicy): LinkSimResult {
  const rand = mulberry32(sc.seed ?? 7);
  const gauss = (): number => (rand() + rand() + rand() + rand() - 2) * Math.SQRT2;
  const fx = helixFixture(sc.ledCount);
  const latency = sc.latencyMs ?? 30;
  const brightness = policy.brightness ?? 1;
  const fpsAt = (t: number): number =>
    sc.lowLightFps !== undefined && sc.ambient(t) < (sc.lowLightAmbient ?? 0.05) ? sc.lowLightFps : sc.fps;

  // --- pre-capture probe: what recommendConfig would see ---
  const probeInterval = 1000 / fpsAt(0);
  const sceneAt = (t: number, expMs: number): { meanLuma: number; clipFrac: number } => {
    const veil = sc.ambient(t) * (expMs / REF_EXPOSURE_MS);
    return { meanLuma: Math.min(1, 0.03 + 0.9 * veil), clipFrac: Math.min(1, Math.max(0, veil - 0.9) * 0.3) };
  };
  const servoMaxMs = (bit: number, interval: number): number => Math.min(bit / 2, interval);
  const expFromFrac = (frac: number, bit: number, interval: number): number =>
    1 + frac * Math.max(0, servoMaxMs(bit, interval) - 1);
  let expFrac = policy.exposureStart ?? 0.25;
  const rec = recommendConfig({
    frameIntervalMs: probeInterval,
    ...sceneAt(0, typeof policy.exposure === "number" ? policy.exposure : expFromFrac(expFrac, 200, probeInterval)),
  });
  let symbols: 2 | 4 = policy.symbols === "auto" ? rec.symbols : policy.symbols;
  let bitMs = policy.bitPeriodMs === "auto" ? rec.bitPeriodMs : policy.bitPeriodMs;
  const band = {
    downgrade: policy.downgradeMargin ?? SYMBOL_DOWNGRADE_MARGIN,
    upgrade: policy.upgradeMargin ?? SYMBOL_UPGRADE_MARGIN,
    ...(policy.upgradeMinLuma !== undefined ? { upgradeMinLuma: policy.upgradeMinLuma } : {}),
  };

  const epochs: CodeEpoch[] = [
    { fromLocalMs: -Infinity, params: codeParams(sc.ledCount, symbols, bitMs, brightness), epochServer: EPOCH0 },
  ];
  const ledCodeAt = (tLocal: number): CodeEpoch => {
    for (let i = epochs.length - 1; i >= 0; i--) if (tLocal >= epochs[i]!.fromLocalMs) return epochs[i]!;
    return epochs[0]!;
  };

  // Truth for the frame being stepped: blob (u,v) → LED id. Dense records
  // carry their blob's exact (u, v) and the frame's tCaptureMs.
  let frameTruth = new Map<string, number>();
  const key = (t: number, u: number, v: number): string => `${t}|${u}|${v}`;
  const tel = new LinkTelemetry(0, {
    source: "sim",
    truth: (r: DetectionRecord) => frameTruth.get(key(r.tCaptureMs, r.u, r.v)) ?? null,
  });
  let records = 0;
  const makePipeline = (e: CodeEpoch): CvPipeline => {
    const pl = new CvPipeline(e.params, e.epochServer, (t) => t + CLOCK_OFFSET, { denseRecords: true });
    pl.onDetections((rs) => {
      records += rs.length;
      tel.recordsEmitted(rs);
    });
    return pl;
  };
  let pipeline = makePipeline(epochs[0]!);
  tel.config(0, epochs[0]!.params, "start", probeInterval);
  tel.attachDecoder(pipeline.decoder.stats);
  let pendingSwitch: { atLocal: number; e: CodeEpoch } | null = null;

  const seen = new Set<number>();
  let pendingBit: number | null = null;
  let pendingSym: 2 | 4 | null = null;
  let nextTick = 2000;
  // Recent frame times for the cadence proxy + blob-population signals.
  const recentT: number[] = [];
  let popSat = 0;
  let popGray = 0;
  let popI = 0;
  let popN = 0;
  let blobCountSum = 0;
  let frames = 0;

  let tTrue = 0;
  while (tTrue < sc.durationMs) {
    const interval = 1000 / fpsAt(tTrue);
    const tFrame = tTrue;
    tTrue += interval * (1 + 0.04 * gauss() * 0.25);
    const dropped = rand() < (sc.dropP ?? 0);

    // Apply a scheduled configure (LEDs + phone switch together, as the
    // capture page rebuilds its pipeline on the configure reply).
    if (pendingSwitch !== null && tFrame >= pendingSwitch.atLocal) {
      epochs.push(pendingSwitch.e);
      pipeline = makePipeline(pendingSwitch.e);
      tel.attachDecoder(pipeline.decoder.stats);
      tel.config(tFrame, pendingSwitch.e.params, "reconfigure", median(diffs(recentT)) ?? interval);
      pendingSwitch = null;
    }
    if (dropped) continue;

    const cur = ledCodeAt(tFrame);
    const expMs =
      typeof policy.exposure === "number"
        ? Math.min(policy.exposure, interval)
        : expFromFrac(expFrac, cur.params.bitPeriodMs, interval);
    const ambient = sc.ambient(tFrame);
    const veil = ambient * (expMs / REF_EXPOSURE_MS) * 0.6;
    const ledLevel = LED_GAIN * brightness * (expMs / REF_EXPOSURE_MS);
    const framePose = poseAt(sc, tFrame);
    const camCenter = framePose.p;
    const tCaptureMs = tFrame + latency;
    frameTruth = new Map();
    const blobs: Blob[] = [];

    for (let id = 0; id < sc.ledCount; id++) {
      const pos = fx.pos[id]!;
      const n = fx.normal[id]!;
      const toCam: Vec3 = [camCenter[0] - pos[0], camCenter[1] - pos[1], camCenter[2] - pos[2]];
      const dist = Math.hypot(toCam[0], toCam[1], toCam[2]);
      if ((n[0] * toCam[0] + n[1] * toCam[1] + n[2] * toCam[2]) / dist < 0.2) continue; // occluded
      let su = 0;
      let sv = 0;
      let u0 = 0;
      let v0 = 0;
      let u1 = 0;
      let v1 = 0;
      const col: [number, number, number] = [0, 0, 0];
      let ok = true;
      for (let k = 0; k < SUBSAMPLES; k++) {
        // Exposure window [tFrame - expMs, tFrame]: the frame's light.
        const tk = tFrame - expMs * ((k + 0.5) / SUBSAMPLES);
        const pr = project(poseAt(sc, tk), K, pos);
        if (pr.depth <= 0) {
          ok = false;
          break;
        }
        su += pr.u;
        sv += pr.v;
        if (k === 0) {
          u0 = pr.u;
          v0 = pr.v;
        }
        if (k === SUBSAMPLES - 1) {
          u1 = pr.u;
          v1 = pr.v;
        }
        const e = ledCodeAt(tk);
        const fi = frameIndexAt(tk + CLOCK_OFFSET, e.epochServer, e.params);
        const c = colorForFrame(id, fi, e.params);
        col[0] += c[0] / SUBSAMPLES;
        col[1] += c[1] / SUBSAMPLES;
        col[2] += c[2] / SUBSAMPLES;
      }
      if (!ok) continue;
      const u = su / SUBSAMPLES;
      const v = sv / SUBSAMPLES;
      if (u < 0 || u >= IMG_W || v < 0 || v >= IMG_H) continue;
      // Motion blur: light spread over the streak lowers the peak.
      const blurPx = Math.hypot(u1 - u0, v1 - v0) * (SUBSAMPLES / Math.max(1, SUBSAMPLES - 1));
      const dilute = 1 / (1 + blurPx / (2 * BLOB_RADIUS_PX));
      const level = ledLevel * dilute * (1.2 / Math.max(0.5, dist));
      const ch: number[] = [0, 0, 0];
      let sat = 0;
      for (let c = 0; c < 3; c++) {
        const raw = level * col[c]! * CAST[c]! + veil;
        const sigma = NOISE_FLOOR + SHOT_NOISE / Math.sqrt(Math.max(0.05, raw));
        const val = raw + sigma * gauss() * 0.5;
        if (val >= 1) sat++;
        ch[c] = Math.min(1, Math.max(0, val));
      }
      const peak = Math.max(ch[0]!, ch[1]!, ch[2]!);
      if (peak - veil < DETECT_FLOOR) continue; // under the detector floor
      seen.add(id);
      const blob: Blob = {
        u,
        v,
        intensity: (ch[0]! + ch[1]! + ch[2]!) / 3,
        area: Math.PI * BLOB_RADIUS_PX * BLOB_RADIUS_PX + 2 * BLOB_RADIUS_PX * blurPx,
        r: ch[0]!,
        g: ch[1]!,
        b: ch[2]!,
        satFrac: sat / 3,
      };
      blobs.push(blob);
      frameTruth.set(key(tCaptureMs, u, v), id);
      const mx = peak;
      const mn = Math.min(ch[0]!, ch[1]!, ch[2]!);
      popSat += sat / 3;
      if (mx === 0 || (mx - mn) / mx < 0.25) popGray++;
      popI += blob.intensity;
      popN++;
    }
    blobCountSum += blobs.length;
    frames++;
    tel.frame(tCaptureMs);
    pipeline.step(blobs, { tCaptureMs, pose: framePose, K, imgW: IMG_W, imgH: IMG_H });
    recentT.push(tCaptureMs);
    if (recentT.length > 60) recentT.shift();

    // --- the capture page's 2 s exposure tick ---
    if (tFrame >= nextTick) {
      nextTick += 2000;
      const fi = median(diffs(recentT)) ?? interval;
      const scene = sceneAt(tFrame, expMs);
      const blobCount = frames > 0 ? blobCountSum / frames : 0;
      const pop = popN > 0 ? { satFrac: popSat / popN, grayFrac: popGray / popN, medianIntensity: popI / popN } : null;
      tel.exposure(tCaptureMs, {
        exposure: policy.exposure === "servo" ? expFrac : null,
        brightness,
        threshold: null,
        frameIntervalMs: fi,
        meanLuma: scene.meanLuma,
        clipFrac: scene.clipFrac,
        blobCount,
        marginEma: pipeline.stats.marginEma,
      });
      if (policy.exposure === "servo" && pop !== null) {
        const next = planExposureServo(expFrac, { blobCount, ledCount: sc.ledCount, ...pop });
        if (next !== null) expFrac = next;
      }
      popSat = popGray = popI = popN = 0;
      blobCountSum = 0;
      frames = 0;
      if (pendingSwitch === null) {
        const curP = pipeline.params;
        const wantBit = policy.bitPeriodMs === "auto" ? planReconfigure(curP.bitPeriodMs, fi) : null;
        const wantSym =
          policy.symbols === "auto"
            ? planSymbolSwitch(curP.symbols as 2 | 4, scene, pipeline.stats.marginEma, band)
            : null;
        const confirmed = (wantBit !== null && wantBit === pendingBit) || (wantSym !== null && wantSym === pendingSym);
        if (confirmed) {
          bitMs = wantBit ?? curP.bitPeriodMs;
          symbols = wantSym ?? (curP.symbols as 2 | 4);
          const at = tFrame + CONFIGURE_LATENCY_MS;
          pendingSwitch = {
            atLocal: at,
            e: {
              fromLocalMs: at,
              params: codeParams(sc.ledCount, symbols, Math.min(BIT_PERIOD_MAX_MS, Math.max(BIT_PERIOD_MIN_MS, bitMs)), brightness),
              epochServer: at + CLOCK_OFFSET,
            },
          };
          pendingBit = pendingSym = null;
        } else {
          pendingBit = wantBit;
          pendingSym = wantSym;
        }
      }
    }
  }
  return { telemetry: tel.snapshot(sc.durationMs + latency), visibleIds: seen.size, records };
}

function diffs(xs: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < xs.length; i++) out.push(xs[i]! - xs[i - 1]!);
  return out;
}

function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

/** The standard scenario suite the benchmark runs (seeded, deterministic). */
export function standardScenarios(ledCount = 120): LinkScenario[] {
  return [
    // Held (near-)still facing the fixture: every visible LED is in view from
    // the start, so time-to-coverage measures the LINK, not the trajectory.
    { name: "hold-lit", ledCount, durationMs: 20_000, fps: 30, orbitDegPerS: 0, radiusM: 1.2, shakeDeg: 0.3, ambient: () => 0.25 },
    { name: "hold-dark", ledCount, durationMs: 20_000, fps: 30, orbitDegPerS: 0, radiusM: 1.2, shakeDeg: 0.3, ambient: () => 0.02 },
    { name: "orbit-lit", ledCount, durationMs: 60_000, fps: 30, orbitDegPerS: 12, radiusM: 1.2, shakeDeg: 0.3, ambient: () => 0.25 },
    { name: "orbit-dark", ledCount, durationMs: 60_000, fps: 30, orbitDegPerS: 12, radiusM: 1.2, shakeDeg: 0.3, ambient: () => 0.02 },
    {
      name: "orbit-fast-shaky",
      ledCount,
      durationMs: 60_000,
      fps: 30,
      orbitDegPerS: 30,
      radiusM: 1.0,
      shakeDeg: 0.6,
      shakeHz: 2,
      ambient: () => 0.2,
    },
    {
      name: "ambient-ramp",
      ledCount,
      durationMs: 60_000,
      fps: 30,
      lowLightFps: 15,
      lowLightAmbient: 0.04,
      orbitDegPerS: 12,
      radiusM: 1.2,
      shakeDeg: 0.4,
      // Lights dim to dark mid-run, then come back bright.
      ambient: (t) => (t < 20_000 ? 0.3 : t < 40_000 ? 0.02 : 0.6),
    },
    {
      name: "bright-veil",
      ledCount,
      durationMs: 60_000,
      fps: 30,
      orbitDegPerS: 12,
      radiusM: 1.2,
      shakeDeg: 0.3,
      ambient: () => 0.9,
    },
  ];
}

export { MIN_FRAMES_PER_BIT };
