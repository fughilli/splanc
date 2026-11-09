/**
 * Scripted hardware seams for tests that mount the real capture screen
 * (ui/screens/capture.ts): the camera source, the GPU detector and the hue-code
 * decoder (swapped on their module exports), and the wasm solver worker (a
 * stub `Worker` that solves one LED per decoded id). Shared by
 * captureDeviceDrop.test.ts and captureNavigation.test.ts.
 */

import type { CodeParams, DetectionRecord, OutputMap } from "@ledmapper/protocol";
import type { SolveProblem } from "../src/solver/agent";
import type { CaptureFrame } from "../src/xr/capture";

export const LEDS = 8;
export const CODE_PARAMS: CodeParams = {
  ledCount: LEDS,
  bits: 8,
  encoding: "hue",
  symbols: 2,
  bitPeriodMs: 100,
  syncPattern: "on_off",
  cycleFrames: 10,
};

/** Camera source stand-in (replaces MediaStreamCaptureSource): the test pushes
 * frames into whatever handler the screen registered last. */
export class ScriptedCamera {
  static current: ScriptedCamera | null = null;
  readonly video = document.createElement("video");
  readonly gl = {};
  registrations = 0;
  private handler: ((f: CaptureFrame) => void) | null = null;
  constructor() {
    ScriptedCamera.current = this;
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  onFrame(cb: (f: CaptureFrame) => void): void {
    this.handler = cb;
    this.registrations++;
  }
  onEnd(): void {}
  async setExposure(): Promise<void> {}
  emit(tCaptureMs: number): void {
    this.handler?.({
      texture: null,
      pose: { p: [0, 0, 0], q: [0, 0, 0, 1] },
      K: [900, 900, 640, 360],
      imgW: 1280,
      imgH: 720,
      tCaptureMs,
    });
  }
}

/** GPU detector stand-in (replaces DetectorGL): no blobs, a dim scene. */
export class QuietDetector {
  threshold = 0.6;
  readonly downscale = 2;
  detectFrame(): [] {
    return [];
  }
  measureFrame(): { meanLuma: number; p95Luma: number; clipFrac: number } {
    return { meanLuma: 0.05, p95Luma: 0.2, clipFrac: 0 };
  }
}

/** Decoder stand-in (replaces CvPipeline): every frame decodes one LED, round
 * robin, and hands the record to the screen exactly like the real pipeline. */
export class ScriptedDecoder {
  static decoded: DetectionRecord[] = [];
  lastBlobStatus: never[] = [];
  readonly stats = { uniqueIds: new Set<number>(), tracks: 0, alignShiftMs: 0, marginEma: 0.5 };
  private sink: ((records: DetectionRecord[]) => void) | null = null;
  constructor(private readonly params: CodeParams) {}
  onDetections(cb: (records: DetectionRecord[]) => void): void {
    this.sink = cb;
  }
  updateSolved(): void {}
  step(
    _blobs: unknown,
    meta: { tCaptureMs: number; K: [number, number, number, number]; imgW: number; imgH: number },
  ): DetectionRecord[] {
    const ledId = ScriptedDecoder.decoded.length % this.params.ledCount;
    const rec: DetectionRecord = {
      ledId,
      tCaptureMs: meta.tCaptureMs,
      u: 100 + ledId,
      v: 200,
      imgW: meta.imgW,
      imgH: meta.imgH,
      K: meta.K,
      pose: null,
      confidence: 1,
    };
    ScriptedDecoder.decoded.push(rec);
    this.stats.uniqueIds.add(ledId);
    this.sink?.([rec]);
    return [rec];
  }
}

/** The wasm solver worker, stubbed: benchmark at `benchMs`, and "solve" one LED
 * per decoded id (recording every problem it was handed). */
export class SolverWorkerStub extends EventTarget {
  static benchMs = 100;
  static problems: SolveProblem[] = [];
  postMessage(msg: { cmd: string; problem?: SolveProblem }): void {
    queueMicrotask(() => {
      if (msg.cmd === "init") this.reply({ kind: "ready", version: "stub" });
      else if (msg.cmd === "benchmark") this.reply({ kind: "bench", ms: SolverWorkerStub.benchMs, rms: 0 });
      else if (msg.cmd === "solve" && msg.problem) {
        SolverWorkerStub.problems.push(msg.problem);
        this.reply({ kind: "map", map: solvedFrom(msg.problem) });
      }
    });
  }
  terminate(): void {}
  private reply(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
}

export function solvedFrom(problem: SolveProblem): OutputMap {
  const ids = [...new Set(problem.detections.map((d) => d.ledId))].sort((a, b) => a - b);
  return {
    mapId: problem.mapId,
    createdAt: problem.createdAt,
    units: "meters",
    frame: "gravity_leveled",
    ledCount: problem.ledCount,
    leds: ids.map((id) => ({
      id,
      xyz: [id * 0.1, 0.5, 0] as [number, number, number],
      confidence: 0.9,
      nViews: 3,
      rmsReprojPx: 0.5,
      parallaxDeg: 20,
    })),
    unmapped: [],
    stats: { rmsReprojPxGlobal: 0.5, medianParallaxDeg: 20 },
  };
}

/** Swap the seams in (call once, after installFakeDom, before importing the
 * capture screen). */
export async function installCaptureSeams(): Promise<void> {
  const g = globalThis as unknown as Record<string, unknown>;
  g["DeviceMotionEvent"] = class {}; // ImuRecorder feature-detects iOS permission on it
  g["Worker"] = SolverWorkerStub; // the wasm solver's module worker
  const swap = (mod: unknown, name: string, impl: unknown): void => {
    (mod as Record<string, unknown>)[name] = impl;
  };
  swap(await import("../src/xr/mediaStreamCapture"), "MediaStreamCaptureSource", ScriptedCamera);
  swap(await import("../src/cv/detect"), "DetectorGL", QuietDetector);
  swap(await import("../src/cv/pipeline"), "CvPipeline", ScriptedDecoder);
}

export const turn = (): Promise<void> => new Promise((r) => setImmediate(r));

export async function until(what: string, cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (cond()) return;
    await turn();
  }
  throw new Error(`timed out waiting for ${what}`);
}
