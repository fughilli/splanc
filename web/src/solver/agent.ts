/**
 * SolverAgent — main-thread handle on the wasm VIO solver worker.
 *
 * `init()` loads the wasm bundle in the worker and times the canned
 * placement benchmark (the same solve the host timed for
 * welcome.solverBenchMs). `solve()` runs a full reconstruction off the main
 * thread, streaming solve_status-shaped progress snapshots.
 *
 * Everything is best-effort: a device without module-worker/wasm support
 * yields `benchMs === null`, and chooseSolvePlacement() then routes the
 * final solve to the host — the classic flow.
 */

import type { DetectionRecord, ImuSample, OutputMap, SolveLed } from "@ledmapper/protocol";

import { assetUrl } from "../assetBase";
import type { Assessment } from "./degeneracy";

/** Problem JSON for the Rust solver (solver/src/types.rs). */
export interface SolveProblem {
  detections: DetectionRecord[];
  imu: ImuSample[];
  ledCount: number;
  mapId: string;
  createdAt: string;
  /** reconstruct_vio options (solver/src/types.rs ProblemOptions) — e.g. a
   * cheaper budget for the interim solves that drive the live overlay. */
  options?: {
    maxKeyframes?: number;
    maxNfev?: number;
    rejectOutliers?: boolean;
    minViews?: number;
    /** Strip prior (solver/src/strip.rs): ids are wired in order, so
     * consecutive LEDs are pinned within one pitch, chain-breaking LEDs are
     * demoted, and interior unmapped runs are placed between their neighbours
     * (emitted with nViews = 0, confidence = 0 — see geom/inferred). */
    stripPrior?: boolean;
    /** Known LED pitch, meters (unset = estimated from the solve). */
    stripSpacingM?: number;
    /** Fractional slack on the pitch bound (default 0.25). */
    stripTolerance?: number;
    /** Solver state of an earlier (interim) solve of this capture: the final
     * solve also starts from it and keeps the better start, so it can't come
     * back worse than the live preview (solver/src/pipeline.rs). */
    warmStart?: WarmState;
    /** Cold-start scale guard (default on). Off only to replay a capture the
     * way the solver handled it before the guard existed. */
    initScaleGuard?: boolean;
  };
}

/** A solved VIO state, un-leveled (solver/src/types.rs WarmState). */
export interface WarmState {
  frameTimesS: number[];
  quats: [number, number, number, number][];
  positions: [number, number, number][];
  velocities: [number, number, number][];
  gravity: [number, number, number];
  gyroBias: [number, number, number];
  accelBias: [number, number, number];
  ledIds: number[];
  ledPositions: [number, number, number][];
}

/** One optimizer stage of a solve (solver/src/pipeline.rs StageTrace). */
export interface StageTrace {
  stage: string;
  frames: number;
  observations: number;
  leds: number;
  solved: number;
  rmsPx: number;
  reanchorScale: number;
  scaleRelStdErr: number | null;
  spreadM: number;
  initScale?: number;
  initScaleFallback?: boolean;
  degenerate?: string[];
}

/** What a solve did beside its map (solver/src/pipeline.rs SolveDiagnostics). */
export interface SolveDiag {
  trace: StageTrace[];
  /** Which initial solve the pipeline continued from. */
  start: "cold" | "warm";
  warmStartError?: string;
  assessment: Assessment;
  state: WarmState;
}

/** An interim solve during capture. The worker keeps the capture's records
 * between live solves, so each call carries only what arrived since the
 * previous one (solver/worker.js): `reset` starts a new capture. */
export interface LiveSolveRequest {
  reset: boolean;
  detections: DetectionRecord[];
  imu: ImuSample[];
  ledCount: number;
  mapId: string;
  createdAt: string;
  options?: SolveProblem["options"];
}

/** The worker's own per-solve costs (ms); absent from an older worker. */
export interface WorkerSolveTiming {
  serializeMs: number;
  solveMs: number;
  parseMs: number;
}

/** Where one solve's time went, for the capture perf counters. */
export interface SolveStats {
  /** Waiting behind an earlier queued solve. */
  queueMs: number;
  /** Main thread: postMessage (structured clone of the request). */
  postMs: number;
  /** Posted → result received. */
  roundTripMs: number;
  worker: WorkerSolveTiming | null;
}

/** One progress snapshot — the shape of §7 solve_status content. */
export interface SolveSnapshot {
  progress: number;
  rmsPx: number;
  leds: SolveLed[];
  trajectory: [number, number, number][];
}

type WorkerMsg =
  | { kind: "ready"; version: string; wasmSha256?: string | null }
  | { kind: "bench"; ms: number; rms: number }
  | { kind: "progress"; snap: SolveSnapshot }
  | { kind: "map"; map: OutputMap; diag?: SolveDiag | null; timing?: WorkerSolveTiming }
  | { kind: "error"; message: string };

/** A solve's result: the map, the solver's diagnostics (null from a wasm build
 * without them) and where the time went. */
export interface SolveResult {
  map: OutputMap;
  diag: SolveDiag | null;
  stats: SolveStats;
}

export class SolverAgent {
  private worker: Worker | null = null;
  /** Phone score on the canned benchmark (ms); null = wasm unavailable. */
  benchMs: number | null = null;
  /** The solver crate version and the SHA-256 of the exact wasm build (null
   * when crypto.subtle is unavailable) — recorded in capture bundles. */
  version: string | null = null;
  wasmSha256: string | null = null;

  /** Load the wasm solver and run the placement benchmark (~a second on a
   * modern phone). Resolves to true when the solver is usable. */
  async init(baseUrl = assetUrl("solver")): Promise<boolean> {
    let worker: Worker;
    try {
      // The worker is a plain module file served WITH the wasm bundle from
      // /solver/ (//solver:solver_web via the server's --solver-dir), not a
      // vite-bundled asset — the whole solver deployment lives in one
      // runfiles directory and the app references it by URL alone.
      worker = new Worker(`${baseUrl}/worker.js`, { type: "module" });
    } catch {
      return false;
    }
    this.worker = worker;
    try {
      // Timeouts because a failed worker-script load never replies at all.
      const ready = (await this.command({ cmd: "init", baseUrl }, "ready", 20_000)) as {
        kind: "ready";
        version: string;
        wasmSha256?: string | null;
      };
      this.version = ready.version;
      this.wasmSha256 = ready.wasmSha256 ?? null;
      const bench = (await this.command({ cmd: "benchmark" }, "bench", 120_000)) as {
        kind: "bench";
        ms: number;
      };
      this.benchMs = bench.ms;
      return true;
    } catch {
      worker.terminate();
      this.worker = null;
      return false;
    }
  }

  get available(): boolean {
    return this.worker !== null && this.benchMs !== null;
  }

  /** Tail of the solve queue: the worker runs one solve at a time and its
   * replies carry no request id, so overlapping solves (a live interim solve
   * still running when the user hits Stop) must be serialized here. */
  private queue: Promise<unknown> = Promise.resolve();

  /** Solve a full problem in the worker; progress streams to `onProgress`.
   * Calls are queued: each starts after the previous one has finished. */
  solve(problem: SolveProblem, onProgress?: (snap: SolveSnapshot) => void): Promise<OutputMap> {
    return this.enqueue({ cmd: "solve", problem }, onProgress).then((r) => r.map);
  }

  /** Same as solve(), with the solver's diagnostics and where the time went. */
  solveWithStats(problem: SolveProblem, onProgress?: (snap: SolveSnapshot) => void): Promise<SolveResult> {
    return this.enqueue({ cmd: "solve", problem }, onProgress);
  }

  /** An interim solve on the worker-held live session (no progress stream). */
  solveLive(req: LiveSolveRequest): Promise<SolveResult> {
    return this.enqueue({ cmd: "solve", live: { ...req, progress: false } });
  }

  private enqueue(msg: object, onProgress?: (snap: SolveSnapshot) => void): Promise<SolveResult> {
    const queuedAt = performance.now();
    const go = () => this.solveNow(msg, queuedAt, onProgress);
    const run = this.queue.then(go, go);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private solveNow(
    cmd: object,
    queuedAt: number,
    onProgress?: (snap: SolveSnapshot) => void,
  ): Promise<SolveResult> {
    const worker = this.worker;
    if (worker === null) return Promise.reject(new Error("solver not initialized"));
    return new Promise((resolve, reject) => {
      let postedAt = 0;
      let postMs = 0;
      const onMsg = (ev: MessageEvent): void => {
        const msg = ev.data as WorkerMsg;
        if (msg.kind === "progress") {
          onProgress?.(msg.snap);
          return;
        }
        worker.removeEventListener("message", onMsg);
        if (msg.kind === "map") {
          resolve({
            map: msg.map,
            diag: msg.diag ?? null,
            stats: {
              queueMs: postedAt - queuedAt,
              postMs,
              roundTripMs: performance.now() - postedAt,
              worker: msg.timing ?? null,
            },
          });
        } else reject(new Error(msg.kind === "error" ? msg.message : `unexpected ${msg.kind}`));
      };
      worker.addEventListener("message", onMsg);
      postedAt = performance.now();
      worker.postMessage(cmd);
      postMs = performance.now() - postedAt;
    });
  }

  private command(cmd: object, expect: string, timeoutMs: number): Promise<WorkerMsg> {
    const worker = this.worker;
    if (worker === null) return Promise.reject(new Error("no worker"));
    return new Promise((resolve, reject) => {
      const cleanup = (): void => {
        clearTimeout(timer);
        worker.removeEventListener("message", onMsg);
        worker.removeEventListener("error", onErr);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`solver worker timed out waiting for ${expect}`));
      }, timeoutMs);
      const onErr = (): void => {
        cleanup();
        reject(new Error("solver worker failed to load"));
      };
      const onMsg = (ev: MessageEvent): void => {
        const msg = ev.data as WorkerMsg;
        if (msg.kind === "progress") return;
        cleanup();
        if (msg.kind === expect) resolve(msg);
        else reject(new Error(msg.kind === "error" ? msg.message : `unexpected ${msg.kind}`));
      };
      worker.addEventListener("message", onMsg);
      worker.addEventListener("error", onErr);
      worker.postMessage(cmd);
    });
  }
}
