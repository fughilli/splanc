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

/** Problem JSON for the Rust solver (solver/src/types.rs). */
export interface SolveProblem {
  detections: DetectionRecord[];
  imu: ImuSample[];
  ledCount: number;
  mapId: string;
  createdAt: string;
}

/** One progress snapshot — the shape of §7 solve_status content. */
export interface SolveSnapshot {
  progress: number;
  rmsPx: number;
  leds: SolveLed[];
  trajectory: [number, number, number][];
}

type WorkerMsg =
  | { kind: "ready"; version: string }
  | { kind: "bench"; ms: number; rms: number }
  | { kind: "progress"; snap: SolveSnapshot }
  | { kind: "map"; map: OutputMap }
  | { kind: "error"; message: string };

export class SolverAgent {
  private worker: Worker | null = null;
  /** Phone score on the canned benchmark (ms); null = wasm unavailable. */
  benchMs: number | null = null;

  /** Load the wasm solver and run the placement benchmark (~a second on a
   * modern phone). Resolves to true when the solver is usable. */
  async init(baseUrl = "/solver"): Promise<boolean> {
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
      await this.command({ cmd: "init", baseUrl }, "ready", 20_000);
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

  /** Solve a full problem in the worker; progress streams to `onProgress`. */
  solve(problem: SolveProblem, onProgress?: (snap: SolveSnapshot) => void): Promise<OutputMap> {
    const worker = this.worker;
    if (worker === null) return Promise.reject(new Error("solver not initialized"));
    return new Promise<OutputMap>((resolve, reject) => {
      const onMsg = (ev: MessageEvent): void => {
        const msg = ev.data as WorkerMsg;
        if (msg.kind === "progress") {
          onProgress?.(msg.snap);
          return;
        }
        worker.removeEventListener("message", onMsg);
        if (msg.kind === "map") resolve(msg.map);
        else reject(new Error(msg.kind === "error" ? msg.message : `unexpected ${msg.kind}`));
      };
      worker.addEventListener("message", onMsg);
      worker.postMessage({ cmd: "solve", problem });
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
