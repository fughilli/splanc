/**
 * Capture reproduction bundles — everything needed to replay a mapping run's
 * solves offline, bit-for-bit (docs/design/mapping-solve-paths.md).
 *
 * In debug mode (Settings ▸ Behavior ▸ Developer ▸ Enable Debug Settings)
 * every mapping run that fails, ends degenerate, falls back to the live
 * preview, or disagrees with it writes one of these to IndexedDB
 * (store/captureBundleStore); "Keep successful runs too" logs the rest for
 * comparison. Settings ▸ Debugging lists them with Export / Share.
 *
 * Replay: `bazel run //solver:replay_bundle -- <file>` (the wasm build, bit-
 * for-bit) or `solver_cli --replay <file>` (native, with stage traces).
 *
 * The bundle is self-describing JSON:
 *
 *   problem    the final solve's exact input (detections + IMU in capture
 *              order, ledCount, mapId, createdAt, options incl. warmStart)
 *   interims   the best + the last few live-preview solves: each replays as
 *              problem.detections[0, recordCount) + problem.imu[0, imuCount)
 *              under its own options (the worker accumulated exactly those)
 *   final      the raw solver output (before the app recenters it) + the
 *              solver's diagnostics, or the error it threw
 *   decision   which map the run kept and why (solver/degeneracy.ts)
 *   capture    capture parameters (stride, diffuse, detector, exposure,
 *              brightness, code params, fixture / firmware, duration)
 *   solver     crate version + SHA-256 of the exact wasm build
 *   app/device build + browser/device info
 *   frames     optional downsampled camera frames (opt-in; big)
 */

import type { CodeParams, OutputMap } from "@ledmapper/protocol";

import type { SolveDiag, SolveProblem } from "./agent";
import { assessMap, better, decideFinal, observableLeds, type Assessment, type FinalDecision } from "./degeneracy";
import type { CaptureObservations } from "../store/mapStore";

export const BUNDLE_FORMAT = "splanc-capture-bundle";
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXT = ".splanc-capture.json";

/** One live-preview (interim) solve. */
export interface InterimRecord {
  /** "phone": the wasm interim solve (replayable); "host": a host solver's
   * live map (kept for fallback + comparison only — not replayable here). */
  source: "phone" | "host";
  /** ms since capture start when the solve was requested. */
  tMs: number;
  /** The capture's first `recordCount` detections / `imuCount` IMU samples
   * were in the worker's live session for this solve. */
  recordCount: number;
  imuCount: number;
  ledCount: number;
  mapId: string;
  createdAt: string;
  options: SolveProblem["options"] | null;
  /** Raw solver output (null when the solve threw). */
  map: OutputMap | null;
  diag: SolveDiag | null;
  error: string | null;
  /** Assessment (the solver's own, else assessMap of the map). */
  assessment: Assessment | null;
  /** Set on the record that was the best when the bundle was built. */
  best?: boolean;
}

/** Interim solves kept for fallback + the bundle: the best one so far and
 * the most recent few (chronological, no duplicates). */
export class InterimLog {
  private bestRec: InterimRecord | null = null;
  private recent: InterimRecord[] = [];
  /** All interim solves seen (kept or not). */
  count = 0;

  constructor(private readonly keepLast = 3) {}

  add(rec: InterimRecord): void {
    this.count++;
    if (rec.assessment === null && rec.map !== null) rec.assessment = assessMap(rec.map);
    if (rec.map !== null && rec.assessment !== null) {
      if (this.bestRec === null || this.bestRec.assessment === null || better(rec.assessment, this.bestRec.assessment)) {
        this.bestRec = rec;
      }
    }
    this.recent.push(rec);
    if (this.recent.length > this.keepLast) this.recent.shift();
  }

  /** The best successful interim (non-degenerate first, then most LEDs,
   * then lowest residual), or null when none succeeded. */
  best(): InterimRecord | null {
    return this.bestRec;
  }

  /** Records for the bundle, chronological, `best` flagged on the best. */
  records(): InterimRecord[] {
    const out = [...this.recent];
    if (this.bestRec !== null && !out.includes(this.bestRec)) out.unshift(this.bestRec);
    return out
      .sort((a, b) => a.recordCount - b.recordCount || a.tMs - b.tMs)
      .map((r) => ({ ...r, best: r === this.bestRec }));
  }
}

/** Capture parameters a run used. Mirrors (does not redefine) the capture
 * screen's resolved config + the negotiated code params. */
export interface CaptureParamsSnapshot {
  ledCount: number;
  /** Library map this run supplements (null = a first capture). */
  supplementOf: string | null;
  diffuse: boolean;
  strideSpacing: number;
  anchorDensity: number;
  detector: { threshold: number; downscale: number; flipV: boolean; localContrastGain: number | null };
  /** Pinned via URL params (null = servoed / default). */
  forced: { exposure: number | null; brightness: number | null; symbols: number | null; bitMs: number | null };
  /** Negotiated code (symbols, bit period, …) from startMapping. */
  codeParams: CodeParams | null;
  /** The exposure the servo ended on (0..1), when known. */
  lastExposure: number | null;
  /** The LED brightness the servo ended on (0..1), when known. */
  lastBrightness: number | null;
  stripPrior: boolean;
  liveSolve: boolean;
  /** Where the final solve ran. */
  placement: "phone" | "host";
  captureSource: "native" | "mediastream" | "synthetic" | "unknown";
  durationMs: number;
  frameCount: number;
  truncatedFrames: number;
  fixture: {
    deviceId: string | null;
    name: string | null;
    mac: string | null;
    fwVersion: string | null;
    fwGitCommit: string | null;
    fwGitDirty: boolean | null;
  };
}

export interface DeviceInfo {
  userAgent: string;
  platform: string | null;
  language: string | null;
  hardwareConcurrency: number | null;
  deviceMemoryGb: number | null;
  screen: { w: number; h: number; dpr: number } | null;
}

export function deviceInfo(): DeviceInfo {
  const nav = typeof navigator !== "undefined" ? navigator : null;
  const scr = typeof screen !== "undefined" ? screen : null;
  return {
    userAgent: nav?.userAgent ?? "",
    platform: (nav as { platform?: string } | null)?.platform ?? null,
    language: nav?.language ?? null,
    hardwareConcurrency: nav?.hardwareConcurrency ?? null,
    deviceMemoryGb: (nav as { deviceMemory?: number } | null)?.deviceMemory ?? null,
    screen:
      scr !== null
        ? { w: scr.width, h: scr.height, dpr: typeof devicePixelRatio === "number" ? devicePixelRatio : 1 }
        : null,
  };
}

/** One downsampled camera frame (opt-in). */
export interface BundleFrame {
  tMs: number;
  /** data: URL (JPEG). */
  jpeg: string;
}

export interface CaptureBundle {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  id: string;
  createdAt: string;
  outcome: FinalDecision["outcome"];
  /** One-line summary for the list UI. */
  summary: string;
  decision: FinalDecision;
  app: { version: string | null; gitCommit: string; gitDirty: boolean };
  solver: { version: string | null; wasmSha256: string | null };
  device: DeviceInfo;
  capture: CaptureParamsSnapshot;
  /** The final solve's exact input (null when the run never got to solve). */
  problem: SolveProblem | null;
  interims: InterimRecord[];
  /** Interim solves run during the capture (the bundle keeps a few). */
  interimCount: number;
  final: {
    map: OutputMap | null;
    diag: SolveDiag | null;
    error: string | null;
    assessment: Assessment | null;
    timing: { roundTripMs: number; solveMs: number | null } | null;
  };
  /** Supplemental scans: the joint re-solve / fusion outcome (summary only). */
  supplement: { method: string; registered: boolean; summary: string; jointError: string | null } | null;
  frames: BundleFrame[];
  /** Provenance caveats (e.g. rebuilt from a saved library map). */
  note?: string;
}

export function bundleSummary(b: Pick<CaptureBundle, "outcome" | "decision" | "final" | "capture">): string {
  const a = b.final.assessment;
  const leds = a ? `${a.measured}/${b.capture.ledCount} LEDs` : "no map";
  const why = b.decision.reasons.length > 0 ? ` — ${b.decision.reasons.join(", ")}` : "";
  return `${b.outcome}: ${leds}${why}`;
}

/** Suggested export file name, e.g. splanc-capture-2026-10-21T07-05-12-fallback-degenerate.splanc-capture.json */
export function bundleFileName(b: { createdAt: string; outcome: string; format?: string }): string {
  const stamp = b.createdAt.replace(/\.\d+Z$/, "Z").replace(/[:]/g, "-");
  const kind = b.format === "splanc-localize-bundle" ? "localize" : "capture";
  return `splanc-${kind}-${stamp}-${b.outcome}${BUNDLE_EXT}`;
}

/** Whether a run should be logged (debug mode on). */
export function shouldLogRun(outcome: FinalDecision["outcome"], keepSuccessful: boolean): boolean {
  return keepSuccessful || outcome !== "ok";
}

/** Serialized size estimate (bytes) — what the list shows. */
export function bundleBytes(b: object): number {
  return JSON.stringify(b).length;
}

export interface BundleInputs {
  id: string;
  createdAt: string;
  decision: FinalDecision;
  app: CaptureBundle["app"];
  solver: CaptureBundle["solver"];
  device: DeviceInfo;
  capture: CaptureParamsSnapshot;
  problem: SolveProblem | null;
  interims: InterimLog;
  final: CaptureBundle["final"];
  supplement: CaptureBundle["supplement"];
  frames: BundleFrame[];
  note?: string;
}

export function buildBundle(i: BundleInputs): CaptureBundle {
  const base = {
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    id: i.id,
    createdAt: i.createdAt,
    outcome: i.decision.outcome,
    summary: "",
    decision: i.decision,
    app: i.app,
    solver: i.solver,
    device: i.device,
    capture: i.capture,
    problem: i.problem,
    interims: i.interims.records(),
    interimCount: i.interims.count,
    final: i.final,
    supplement: i.supplement,
    frames: i.frames,
    ...(i.note !== undefined ? { note: i.note } : {}),
  } satisfies CaptureBundle;
  return { ...base, summary: bundleSummary(base) };
}

/** Capture parameters for a run the app didn't record them for. */
export function unknownCaptureParams(ledCount: number): CaptureParamsSnapshot {
  return {
    ledCount,
    supplementOf: null,
    diffuse: false,
    strideSpacing: 1,
    anchorDensity: 3,
    detector: { threshold: Number.NaN, downscale: Number.NaN, flipV: false, localContrastGain: null },
    forced: { exposure: null, brightness: null, symbols: null, bitMs: null },
    codeParams: null,
    lastExposure: null,
    lastBrightness: null,
    stripPrior: false,
    liveSolve: false,
    placement: "phone",
    captureSource: "unknown",
    durationMs: 0,
    frameCount: 0,
    truncatedFrames: 0,
    fixture: { deviceId: null, name: null, mac: null, fwVersion: null, fwGitCommit: null, fwGitDirty: null },
  };
}

/**
 * A bundle rebuilt from a SAVED library map and its raw observations — how a
 * run from before capture bundles existed can still be replayed: every
 * captured map keeps its detections + IMU (FUG-112), including degenerate
 * ones the app saved anyway. The capture parameters, live-preview solves and
 * solver options of the original run weren't kept; `final.map` is the saved
 * (recentered, possibly edited) map, so a replay compares by verdict, not bits.
 */
export function bundleFromSavedMap(
  saved: { name: string; map: OutputMap },
  obs: CaptureObservations,
  meta: Pick<CaptureBundle, "app" | "solver" | "device"> & { id: string; createdAt: string },
): CaptureBundle {
  const assessment = assessMap(saved.map, observableLeds(obs.detections));
  const decision = decideFinal({ map: saved.map, assessment, error: null }, null);
  return buildBundle({
    ...meta,
    decision,
    capture: unknownCaptureParams(obs.ledCount),
    problem: {
      detections: obs.detections,
      imu: obs.imu,
      ledCount: obs.ledCount,
      mapId: saved.map.mapId,
      createdAt: saved.map.createdAt,
    },
    interims: new InterimLog(),
    final: { map: saved.map, diag: null, error: null, assessment, timing: null },
    supplement: null,
    frames: [],
    note:
      `Rebuilt from the saved library map "${saved.name}": capture parameters, live-preview ` +
      "solves and the original solve options were not recorded; final.map is the saved map " +
      "(recentered on its LED centroid, possibly edited), so compare replays by verdict.",
  });
}
