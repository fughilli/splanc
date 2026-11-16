/**
 * Capture-loop profiling harness for large staggered-pilot walls (hue code v2
 * phase 2, PR #501): the owner's 2000-LED virtual wall froze the capture
 * screen. No phone, no camera: a planar wall of `ledCount` LEDs (the virtual
 * wall's grid, pi/player_rs `wall --leds N`) seen by a hand-held camera (slow
 * sway + jitter, 30 fps, 1280×720). Each frame integrates every LED's colour
 * over the exposure window, adds the white-balance cast and shot noise
 * (tests/linkSim.ts's photometric constants) and feeds the blobs through the
 * PRODUCTION pipeline exactly as the capture screen runs it (CvPipeline, dense
 * records, the shared ChannelQuality), timing each stage per frame:
 *
 *   tracker  — Tracker.step (association)
 *   decode   — the CodeDecoder's step (StaggerDecoder for a staggered code)
 *   other    — the rest of CvPipeline.step (blob status, dense records, prune)
 *   extra    — optional: the capture screen's own per-frame work, timed by
 *              name (web/tests/wallPerf_browser.mjs times the real canvas
 *              overlay in headless Chromium, CPU-throttled like a phone)
 *
 * Every record is scored against the truth, so a speed-up that changes the
 * decode shows up as different good/wrong/coverage numbers. The frame
 * generator is not timed. Drive it from web/tests/wallPerf_sim.test.ts (a
 * small regression run) or out of band (docs in /workspace/.claude/phase2).
 */

import type { CodeParams, DetectionRecord } from "@ledmapper/protocol";
import { colorForFrame, isStaggered } from "../src/code/gray";
import { frameIndexAt } from "../src/code/timing";
import { ChannelQuality } from "../src/cv/channelQuality";
import { CvPipeline } from "../src/cv/pipeline";
import type { Blob } from "../src/cv/types";
import { codeParams } from "./linkSim";

export interface WallPerfOptions {
  ledCount: number;
  symbols?: 2 | 4;
  bitPeriodMs?: number;
  /** "stagger_pilot" (default) or "on_off" (v1). */
  sync?: string;
  durationMs?: number;
  fps?: number;
  seed?: number;
  /** Fraction of the image width the wall spans (default 0.9). */
  fill?: number;
  /** Probability a blob is missed in a frame (detector dropout). */
  dropoutP?: number;
  /**
   * Extra per-frame stages to time (the capture screen's own work around the
   * pipeline: overlay drawing, the blob-population monitor, ...): name -> fn,
   * called after the pipeline step with this frame's blobs. Timed into
   * `stages[name]`; "page" is pipeline + every extra stage.
   */
  extra?: Record<string, (pl: CvPipeline, frame: number, blobs: readonly Blob[]) => void>;
}

export interface StageStats {
  mean: number;
  p50: number;
  p95: number;
  max: number;
}

export interface WallPerfResult {
  ledCount: number;
  params: CodeParams;
  frames: number;
  /** Per-frame ms per stage, over frames after the first two cycles (warm). */
  stages: Record<string, StageStats>;
  records: number;
  correct: number;
  wrong: number;
  /** Correct records per LED per second of capture. */
  goodPerLedPerS: number;
  wrongPct: number;
  /** Distinct correctly-identified ids / LEDs that were ever visible. */
  coverage: number;
  /** Tracks with a confirmed id at the end / visible LEDs (the "marked recognized" overlay). */
  labelled: number;
  meanBlobs: number;
  /** Order-sensitive hash of every record (id, time, position): equal digests
   * = a byte-identical decode, the check an optimisation must pass. */
  digest: string;
}

const IMG_W = 1280;
const IMG_H = 720;
const K: [number, number, number, number] = [1000, 1000, IMG_W / 2, IMG_H / 2];
const CLOCK_OFFSET = 500;
const EPOCH = 10_000;
const LATENCY_MS = 140;
const EXPOSURE_MS = 8;
const SUBSAMPLES = 2;
const LEVEL = 0.75;
const VEIL = 0.03;
const NOISE_FLOOR = 0.015;
const SHOT_NOISE = 0.03;
const CAST = [1.0, 0.85, 0.7];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function stats(xs: number[]): StageStats {
  if (xs.length === 0) return { mean: 0, p50: 0, p95: 0, max: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const q = (f: number): number => s[Math.min(s.length - 1, Math.floor(f * s.length))]!;
  return { mean: xs.reduce((t, x) => t + x, 0) / xs.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1]! };
}

/** The wall's grid: `n` LEDs row-major in a 16:9-ish block (pixel coordinates
 * at the reference camera pose, centred). */
export function wallGrid(n: number, fill = 0.9): { u: Float64Array; v: Float64Array; pitch: number } {
  const cols = Math.ceil(Math.sqrt((n * 16) / 9));
  const rows = Math.ceil(n / cols);
  const pitch = Math.min((fill * IMG_W) / cols, (fill * IMG_H) / rows);
  const u = new Float64Array(n);
  const v = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const c = i % cols;
    const r = Math.floor(i / cols);
    u[i] = IMG_W / 2 + (c - (cols - 1) / 2) * pitch;
    v[i] = IMG_H / 2 + (r - (rows - 1) / 2) * pitch;
  }
  return { u, v, pitch };
}

export function runWallPerf(o: WallPerfOptions): WallPerfResult {
  const n = o.ledCount;
  const sync = o.sync ?? "stagger_pilot";
  const params = codeParams(n, o.symbols ?? 2, o.bitPeriodMs ?? 100, 1, sync);
  const durationMs = o.durationMs ?? 20_000;
  const fps = o.fps ?? 30;
  const rand = mulberry32(o.seed ?? 11);
  const gauss = (): number => (rand() + rand() + rand() + rand() - 2) * Math.SQRT2;
  const grid = wallGrid(n, o.fill);
  const C = params.cycleFrames;
  // Colour table: LED i in global cycle frame f (the generator is not timed).
  const table = new Float32Array(n * C * 3);
  for (let i = 0; i < n; i++) {
    for (let f = 0; f < C; f++) {
      const c = colorForFrame(i, f, params);
      table.set(c, (i * C + f) * 3);
    }
  }

  // Truth per frame (held records are released cycles later, so keep them all).
  const truthByFrame = new Map<number, Map<string, number>>();
  const key = (u: number, v: number): string => `${u}|${v}`;
  let correct = 0;
  let wrong = 0;
  let records = 0;
  const goodIds = new Set<number>();
  const visible = new Set<number>();
  const pl = new CvPipeline(params, EPOCH, (t) => t + CLOCK_OFFSET, {
    denseRecords: true,
    decoder: { quality: new ChannelQuality() },
  });
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const mix = (x: number): void => {
    h1 = Math.imul(h1 ^ (x | 0), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (x | 0), 0x5bd1e995) >>> 0;
  };
  pl.onDetections((rs: DetectionRecord[]) => {
    for (const r of rs) {
      records++;
      mix(r.ledId);
      mix(Math.round(r.tCaptureMs * 1000));
      mix(Math.round(r.u * 1000));
      mix(Math.round(r.confidence * 1e6));
      const id = truthByFrame.get(r.tCaptureMs)?.get(key(r.u, r.v));
      if (id === r.ledId) {
        correct++;
        goodIds.add(id);
      } else wrong++;
    }
  });

  // Stage timers (wrapping the pipeline's own stage objects).
  let tTrack = 0;
  let tDecode = 0;
  const tracker = pl.tracker;
  const trackStep = tracker.step.bind(tracker);
  tracker.step = ((...a: Parameters<typeof tracker.step>) => {
    const t0 = performance.now();
    trackStep(...a);
    tTrack += performance.now() - t0;
  }) as typeof tracker.step;
  const dec = pl.decoder;
  const decStep = dec.step.bind(dec);
  dec.step = ((...a: Parameters<typeof dec.step>) => {
    const t0 = performance.now();
    const r = decStep(...a);
    tDecode += performance.now() - t0;
    return r;
  }) as typeof dec.step;

  // "startup" = the pipeline over the first two cycles (every LED's first
  // decodes land there), excluded from the steady-state stages.
  const per: Record<string, number[]> = { tracker: [], decode: [], other: [], pipeline: [], startup: [] };
  const extra = Object.entries(o.extra ?? {});
  for (const [k] of extra) per[k] = [];
  if (extra.length > 0) per.page = [];
  const warmMs = 2 * C * params.bitPeriodMs;
  let frames = 0;
  let blobSum = 0;
  for (let t = 0; t < durationMs; t += 1000 / fps) {
    // Hand-held: a slow sway (≈ ±1.5 pitch at 0.3 Hz) plus jitter.
    const du = 1.5 * grid.pitch * Math.sin(2 * Math.PI * 0.3 * (t / 1000)) + 0.15 * grid.pitch * gauss();
    const dv = 0.8 * grid.pitch * Math.sin(2 * Math.PI * 0.21 * (t / 1000) + 1) + 0.15 * grid.pitch * gauss();
    const tCapture = t + LATENCY_MS;
    const truth = new Map<string, number>();
    truthByFrame.set(tCapture, truth);
    const blobs: Blob[] = [];
    const fs: number[] = [];
    for (let k = 0; k < SUBSAMPLES; k++) {
      fs.push(frameIndexAt(t - EXPOSURE_MS * ((k + 0.5) / SUBSAMPLES) + CLOCK_OFFSET, EPOCH, params));
    }
    for (let i = 0; i < n; i++) {
      if (o.dropoutP !== undefined && rand() < o.dropoutP) continue;
      const u = grid.u[i]! + du;
      const v = grid.v[i]! + dv;
      if (u < 0 || u >= IMG_W || v < 0 || v >= IMG_H) continue;
      const ch = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        let x = 0;
        for (const f of fs) x += table[(i * C + f) * 3 + c]! / SUBSAMPLES;
        const raw = LEVEL * x * CAST[c]! + VEIL;
        const sigma = NOISE_FLOOR + SHOT_NOISE / Math.sqrt(Math.max(0.05, raw));
        ch[c] = Math.min(1, Math.max(0, raw + 0.5 * sigma * gauss()));
      }
      if (Math.max(ch[0]!, ch[1]!, ch[2]!) - VEIL < 0.12) continue;
      visible.add(i);
      blobs.push({ u, v, intensity: (ch[0]! + ch[1]! + ch[2]!) / 3, area: 20, r: ch[0]!, g: ch[1]!, b: ch[2]! });
      truth.set(key(u, v), i);
    }
    blobSum += blobs.length;
    tTrack = 0;
    tDecode = 0;
    const t0 = performance.now();
    pl.step(blobs, { tCaptureMs: tCapture, pose: null, K, imgW: IMG_W, imgH: IMG_H });
    const total = performance.now() - t0;
    const warm = t >= warmMs;
    let page = total;
    for (const [k, fn] of extra) {
      const t1 = performance.now();
      fn(pl, frames, blobs);
      const dt = performance.now() - t1;
      page += dt;
      if (warm) per[k]!.push(dt);
    }
    frames++;
    if (warm) {
      per.tracker!.push(tTrack);
      per.decode!.push(tDecode);
      per.other!.push(total - tTrack - tDecode);
      per.pipeline!.push(total);
      if (extra.length > 0) per.page!.push(page);
    } else per.startup!.push(total);
  }
  let labelled = 0;
  for (const tr of pl.tracker.tracks) if (tr.ledId !== null) labelled++;
  const stages: Record<string, StageStats> = {};
  for (const [k, xs] of Object.entries(per)) stages[k] = stats(xs);
  return {
    ledCount: n,
    params,
    frames,
    stages,
    records,
    correct,
    wrong,
    goodPerLedPerS: correct / n / (durationMs / 1000),
    wrongPct: records > 0 ? (100 * wrong) / records : 0,
    coverage: visible.size > 0 ? goodIds.size / visible.size : 0,
    labelled: visible.size > 0 ? labelled / visible.size : 0,
    meanBlobs: blobSum / Math.max(1, frames),
    digest: `${h1.toString(16)}${h2.toString(16)}`,
  };
}

/** One-line summary (ms/frame mean · p95 per stage, then accuracy). */
export function formatWallPerf(r: WallPerfResult): string {
  const s = (k: string): string => `${r.stages[k]!.mean.toFixed(2)}/${r.stages[k]!.p95.toFixed(2)}`;
  return (
    `${r.ledCount} LEDs ${isStaggered(r.params) ? "pilot" : "v1"} C=${r.params.cycleFrames}: ` +
    `tracker ${s("tracker")} decode ${s("decode")} other ${s("other")} pipeline ${s("pipeline")} ` +
    `startup ${s("startup")} ms (mean/p95) · ` +
    `good ${r.goodPerLedPerS.toFixed(2)}/LED/s wrong ${r.wrongPct.toFixed(2)}% cov ${(100 * r.coverage).toFixed(1)}% ` +
    `labelled ${(100 * r.labelled).toFixed(1)}% blobs ${r.meanBlobs.toFixed(0)} digest ${r.digest}`
  );
}
