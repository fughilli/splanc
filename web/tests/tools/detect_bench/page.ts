/**
 * Browser bench for the production diffuse detector (cv/detect.ts DetectorGL in
 * adaptive mode): see README.md. Two jobs, both on the 40 diffuse_rope suite
 * frames (web/tests/testdata/diffuse_rope):
 *
 *  - PARITY: each frame goes through the WebGL path and through the CPU reference
 *    (cv/diffuseDetect.ts); both are scored against the suite's truth with the
 *    suite's own scorer, and their blobs are matched one-to-one.
 *  - TIMING: the frames are fed at the camera rate (paceMs, 60 fps by default) and
 *    every frame's main-thread cost is recorded, split into GPU submit, readback
 *    wait/copy, and CCL. Dropped = a frame whose handler overran the frame period.
 *
 * Results land in window.__benchResult (the CDP runner, run.mjs, reads it) and
 * on the page as text (for an on-device run with no DevTools attached).
 */

import * as detectMod from "../../../src/cv/detect";
import { DetectorGL } from "../../../src/cv/detect";
import { adaptiveDiffuseReduce } from "../../../src/cv/diffuseDetect";
import { AdaptiveDiffuseGL } from "../../../src/cv/diffuseDetectGL";
import type { Blob } from "../../../src/cv/types";
import { emptyScore, hue4Line, ropeBlobs, scoreFrame, scoreLine, summarize, type RopeTruth } from "../../diffuseRopeScore";

interface BenchOpts {
  /** Paced frames to time (after warm-up). */
  frames?: number;
  /** Frame period, ms (16.67 = 60 fps). 0 = back-to-back. */
  paceMs?: number;
  /** Run the CPU reference + blob parity (slow on a phone: ~40 x 0.3 s). */
  parity?: boolean;
  /** Synthetic main-thread work per frame after detection, ms (the decoder,
   * tracker and overlay share the thread in the real capture loop). */
  otherWorkMs?: number;
  /** Where the dataset is served from. */
  data?: string;
  /** Per-pass GPU timing via finish() (debug). */
  passProfile?: boolean;
  /** Force the synchronous detect() even where DetectPipeline exists. */
  sync?: boolean;
  /** Detection downscale (the low-end tiers run 3 or 4; default 2). */
  downscale?: number;
}

interface PerFrame {
  totalMs: number;
  submitMs: number;
  readMs: number;
  cclMs: number;
  /** Frames between submit and result (0 = synchronous). */
  lagFrames: number;
}

const out = document.getElementById("out") as HTMLPreElement;
const log = (s: string): void => {
  out.textContent += s + "\n";
  console.log(s);
};

async function inflate(buf: ArrayBuffer): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate");
  const stream = new Blob([buf]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Quantile (nearest rank). */
function q(a: number[], p: number): number {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))]! : NaN;
}

/** Wraps the GL entry points the detector waits in, so a frame's time splits
 * into submit / readback / CCL without instrumenting the detector itself. */
function instrument(gl: WebGL2RenderingContext): { readMs: number } {
  const acc = { readMs: 0 };
  const g = gl as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of ["readPixels", "getBufferSubData", "clientWaitSync", "finish"]) {
    const orig = g[name]!.bind(gl);
    g[name] = (...a: unknown[]) => {
      const t = performance.now();
      const r = orig(...a);
      acc.readMs += performance.now() - t;
      return r;
    };
  }
  return acc;
}

async function runBench(opts: BenchOpts = {}): Promise<unknown> {
  const nFrames = opts.frames ?? 300;
  const paceMs = opts.paceMs ?? 1000 / 60;
  log(`pace: ${paceMs.toFixed(2)} ms`);
  const data = opts.data ?? "/data";
  out.textContent = "";
  const truth = (await (await fetch(`${data}/truth.json`)).json()) as RopeTruth;
  const W = truth.crop.w / 2;
  const H = truth.crop.h / 2;
  const imgW = truth.crop.w;
  const imgH = truth.crop.h;
  log(`loading ${truth.frames.length} frames (${imgW}x${imgH} camera, ${W}x${H} detection)…`);
  const rgb8: Uint8Array[] = [];
  for (const f of truth.frames) rgb8.push(await inflate(await (await fetch(`${data}/${f.file}`)).arrayBuffer()));

  const canvas = document.getElementById("c") as HTMLCanvasElement;
  const gl = canvas.getContext("webgl2", { antialias: false, depth: false, preserveDrawingBuffer: false })!;
  const renderer = (() => {
    const e = gl.getExtension("WEBGL_debug_renderer_info");
    return e ? String(gl.getParameter(e.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
  })();
  log(`renderer: ${renderer}`);
  const prof = instrument(gl);
  // Time inside the GL detector (everything but CCL) on the synchronous path.
  const glRun = { ms: 0 };
  const proto = AdaptiveDiffuseGL.prototype as unknown as { run: (...a: unknown[]) => unknown };
  const origRun = proto.run;
  proto.run = function (this: unknown, ...a: unknown[]) {
    const t = performance.now();
    const r = origRun.apply(this, a);
    glRun.ms += performance.now() - t;
    return r;
  };

  // Camera textures: each reduced suite frame nearest-upsampled 2x, so the
  // detector's 2x2 LINEAR reduce reproduces the reduced pixel exactly and the GL
  // path sees the same input as the CPU reference.
  const textures = rgb8.map((px) => {
    const up = new Uint8Array(imgW * imgH * 4);
    for (let y = 0; y < imgH; y++) {
      const sy = y >> 1;
      for (let x = 0; x < imgW; x++) {
        const s = (sy * W + (x >> 1)) * 3;
        const o = (y * imgW + x) * 4;
        up[o] = px[s]!;
        up[o + 1] = px[s + 1]!;
        up[o + 2] = px[s + 2]!;
        up[o + 3] = 255;
      }
    }
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imgW, imgH, 0, gl.RGBA, gl.UNSIGNED_BYTE, up);
    return t;
  });

  const det = new DetectorGL(gl, { threshold: 0.18, downscale: 2, flipV: false, localContrast: { gain: 1 }, diffuseMode: "adaptive" });
  if (opts.downscale !== undefined && opts.downscale !== 2) {
    const d = det as unknown as { setDownscale?: (n: number) => void };
    if (!d.setDownscale) throw new Error("this checkout has no DetectorGL.setDownscale");
    d.setDownscale(opts.downscale);
  }
  log(`downscale: ${det.downscale}`);
  if (!det.adaptiveActive) throw new Error("adaptive detector unavailable on this context (EXT_color_buffer_float?)");
  // The pipelined API (DetectPipeline) when this checkout has it, unless ?sync=1.
  type Pipe = {
    submit(f: { texture: WebGLTexture; imgW: number; imgH: number }, tag: number, o?: { measure?: boolean }): boolean;
    collect(all?: boolean): { tag: number; blobs: Blob[]; latencyMs: number }[];
    shed: number;
  };
  const PipeCtor = (detectMod as unknown as { DetectPipeline?: new (gl: WebGL2RenderingContext, d: DetectorGL) => Pipe }).DetectPipeline;
  const pipe = PipeCtor && !opts.sync ? new PipeCtor(gl, det) : null;
  const pipelined = pipe !== null;
  log(`detector: ${pipelined ? "pipelined (DetectPipeline submit/collect)" : "synchronous detect()"}`);

  /** Run one frame through the detector to completion (parity: no pipelining). */
  const detectNow = (i: number): Blob[] => det.detect(textures[i]!, imgW, imgH);

  const result: Record<string, unknown> = { renderer, pipelined, userAgent: navigator.userAgent };

  if (opts.parity !== false) {
    log("parity: GL vs CPU reference on every frame…");
    const sGl = emptyScore();
    const sRef = emptyScore();
    let pairs = 0;
    let unmatchedGl = 0;
    let unmatchedRef = 0;
    let maxDpos = 0;
    let maxDcol = 0;
    const dpos: number[] = [];
    for (let i = 0; i < truth.frames.length; i++) {
      const f = truth.frames[i]!;
      // The GL path thresholds with a RECENT frame's noise floor: settle it on
      // this frame first (what a steady camera stream does).
      let gb: Blob[] = [];
      for (let k = 0; k < 6; k++) gb = detectNow(i);
      const rgb = new Float32Array(W * H * 3);
      const px = rgb8[i]!;
      for (let j = 0; j < rgb.length; j++) rgb[j] = px[j]! / 255;
      const rb = ropeBlobs(truth, adaptiveDiffuseReduce(rgb, W, H).detect);
      scoreFrame(truth, f, gb, sGl);
      scoreFrame(truth, f, rb, sRef);
      // One-to-one blob match within 1 px.
      const used = new Set<number>();
      for (const a of rb) {
        let best = -1;
        let bd = 1;
        gb.forEach((b, j) => {
          if (used.has(j)) return;
          const d = Math.hypot(a.u - b.u, a.v - b.v);
          if (d < bd) {
            bd = d;
            best = j;
          }
        });
        if (best < 0) {
          unmatchedRef++;
          continue;
        }
        used.add(best);
        pairs++;
        const b = gb[best]!;
        dpos.push(bd);
        maxDpos = Math.max(maxDpos, bd);
        maxDcol = Math.max(maxDcol, Math.abs(a.r! - b.r!), Math.abs(a.g! - b.g!), Math.abs(a.b! - b.b!));
      }
      unmatchedGl += gb.length - used.size;
    }
    log(scoreLine("GL ", sGl));
    log(scoreLine("ref", sRef));
    log(`hue4 GL:  ${hue4Line(sGl)}`);
    log(`hue4 ref: ${hue4Line(sRef)}`);
    log(
      `blob parity: ${pairs} matched, ${unmatchedRef} ref-only, ${unmatchedGl} GL-only, ` +
        `p95 |Δpos| ${q(dpos, 0.95).toFixed(3)} px (max ${maxDpos.toFixed(3)}), max |Δcolor| ${maxDcol.toFixed(3)}`,
    );
    result.parity = {
      gl: { ...summarize(sGl), hits: sGl.hits, detectable: sGl.detectable, hue4: Object.fromEntries(sGl.hue4) },
      ref: { ...summarize(sRef), hits: sRef.hits, detectable: sRef.detectable, hue4: Object.fromEntries(sRef.hue4) },
      pairs,
      unmatchedRef,
      unmatchedGl,
      p95Dpos: q(dpos, 0.95),
      maxDpos,
      maxDcol,
    };
  }

  if (opts.passProfile) {
    // Per-pass GPU cost: finish() around every draw (debug only — serialises the GPU).
    const pr = AdaptiveDiffuseGL.prototype as unknown as { draw: (...a: unknown[]) => unknown };
    const origDraw = pr.draw;
    const per = new Map<string, number[]>();
    // finish() doesn't wait for the GPU in Chrome; a 1-pixel readback does.
    const px = new Float32Array(4);
    const px8 = new Uint8Array(4);
    const sync = (): void => {
      const fmt = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_FORMAT) as number;
      const type = gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) as number;
      if (type === gl.UNSIGNED_BYTE) gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px8);
      else gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, px);
      void fmt;
    };
    pr.draw = function (this: unknown, ...a: unknown[]) {
      sync();
      const t = performance.now();
      const r = origDraw.apply(this, a);
      sync();
      const k = String(a[3]);
      (per.get(k) ?? per.set(k, []).get(k)!).push(performance.now() - t);
      return r;
    };
    for (let n = 0; n < 40; n++) detectNow(n % textures.length);
    pr.draw = origDraw;
    const rows = [...per].map(([k, v]) => [k, v.reduce((a, b) => a + b, 0) / 40] as const);
    for (const [k, ms] of rows) log(`  pass ${k.padEnd(10)} ${ms.toFixed(2)} ms/frame`);
    result.passes = Object.fromEntries(rows);
  }

  log(`timing: ${nFrames} frames paced at ${paceMs.toFixed(2)} ms…`);
  const frames: PerFrame[] = [];
  const busy = (ms: number): void => {
    const t = performance.now() + ms;
    while (performance.now() < t) {
      /* spin */
    }
  };
  const warm = 30;
  let next = performance.now();
  let dropped = 0;
  let delivered = 0;
  const latencies: number[] = [];
  let submitMsAcc = 0;
  const submitted: number[] = [];
  for (let n = 0; n < nFrames + warm; n++) {
    // Wait for the frame's slot (a camera delivers on its own clock: a frame
    // whose slot passed while we were busy is a dropped frame).
    next += paceMs;
    const wait = next - performance.now();
    if (paceMs > 0) {
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      else {
        const skip = Math.ceil(-wait / paceMs);
        if (n >= warm) dropped += skip;
        next += skip * paceMs;
      }
    }
    const i = n % textures.length;
    prof.readMs = 0;
    const t0 = performance.now();
    let cclMs = 0;
    let lag = 0;
    if (pipe !== null) {
      pipe.submit({ texture: textures[i]!, imgW, imgH }, n, { measure: n % 6 === 0 });
      submitted.push(n);
      const tSub = performance.now();
      const done = pipe.collect();
      for (const d of done) {
        lag = Math.max(lag, n - d.tag);
        if (n >= warm) latencies.push(d.latencyMs);
      }
      if (n >= warm) delivered += done.length;
      cclMs = performance.now() - tSub - prof.readMs;
      submitMsAcc = tSub - t0;
    } else {
      glRun.ms = 0;
      detectNow(i);
      cclMs = performance.now() - t0 - glRun.ms;
    }
    const t1 = performance.now();
    if (opts.otherWorkMs) busy(opts.otherWorkMs);
    if (n < warm) continue;
    const totalMs = t1 - t0;
    frames.push({ totalMs, submitMs: pipe !== null ? submitMsAcc : totalMs - prof.readMs - cclMs, readMs: prof.readMs, cclMs, lagFrames: lag });
  }
  const col = (k: keyof PerFrame): { p50: number; p95: number; max: number } => {
    const a = frames.map((f) => f[k]);
    return { p50: q(a, 0.5), p95: q(a, 0.95), max: Math.max(...a) };
  };
  const shed = pipe?.shed ?? 0;
  pipe?.collect(true);
  const timing = {
    frames: frames.length,
    // Frames whose blobs came back (pipelined: minus those the GPU-behind
    // check shed; synchronous: every handled frame).
    delivered: pipe !== null ? delivered : frames.length,
    shed,
    paceMs,
    dropped,
    // Lost camera frames = missed slots (main thread busy) + shed (GPU behind).
    dropFrac: (dropped + shed) / (frames.length + dropped),
    total: col("totalMs"),
    submit: col("submitMs"),
    read: col("readMs"),
    ccl: col("cclMs"),
    lag: col("lagFrames"),
    overBudget: frames.filter((f) => f.totalMs > paceMs).length / frames.length,
    // Pipelined: submit -> blobs delivered (GPU time + the wait for the next frame).
    latency: latencies.length ? { p50: q(latencies, 0.5), p95: q(latencies, 0.95), max: Math.max(...latencies) } : null,
  };
  const fmt = (x: { p50: number; p95: number; max: number }): string => `p50 ${x.p50.toFixed(2)} p95 ${x.p95.toFixed(2)} max ${x.max.toFixed(2)}`;
  log(`detect total ${fmt(timing.total)} ms`);
  if (timing.latency) log(`  result latency ${fmt(timing.latency)} ms`);
  log(`  submit ${fmt(timing.submit)} | read ${fmt(timing.read)} | ccl ${fmt(timing.ccl)}`);
  log(
    `  over budget ${(timing.overBudget * 100).toFixed(1)}% · missed slots ${dropped} · GPU-shed ${shed} · lost ${(timing.dropFrac * 100).toFixed(1)}% · lag p95 ${timing.lag.p95} frames`,
  );
  result.timing = timing;
  (window as unknown as { __benchResult: unknown }).__benchResult = result;
  return result;
}

(window as unknown as { runBench: typeof runBench }).runBench = runBench;
const qs = new URLSearchParams(location.search);
const go = (): void => {
  runBench({
    parity: qs.get("parity") !== "0",
    sync: qs.get("sync") === "1",
    ...(qs.has("frames") ? { frames: Number(qs.get("frames")) } : {}),
    ...(qs.has("ds") ? { downscale: Number(qs.get("ds")) } : {}),
    ...(qs.has("other") ? { otherWorkMs: Number(qs.get("other")) } : {}),
  }).catch((e) => log(`ERROR ${e instanceof Error ? e.stack : e}`));
};
document.getElementById("go")!.addEventListener("click", go);
if (qs.get("auto") === "1") go();
