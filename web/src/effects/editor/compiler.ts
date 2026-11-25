/**
 * Main-thread handle to the compiler Web Worker (compile-worker.ts). Wraps the
 * postMessage round-trip in a small async API so the editor can `await
 * compile(src)` without ever blocking the UI/preview thread — the compiler runs
 * off-thread per docs/design/effects-compiler.md (DECISION: background thread).
 *
 * Vite bundles the worker from its TS source via `new URL(..., import.meta.url)`
 * — this module is browser-only (import.meta), so it's excluded from the CJS
 * unit-test build like src/solver/spawn.ts.
 */

import type { FxCompiled } from "../../fx/preview";
import type { CompileRequest, CompileResponse } from "./compile-worker";
import type { WasmLoadStatus } from "../../fx/wasmLoad";
import type { WatchCompile } from "../../fx/watch";

export class FxCompilerWorker {
  private readonly worker: Worker;
  private nextId = 1;
  // Pending resolvers keyed by request id. Compile resolvers take an FxCompiled,
  // disassemble resolvers take a string — stored untyped and narrowed by the
  // response's `kind`.
  private readonly pending = new Map<number, (r: never) => void>();
  private readonly statusListeners = new Set<(s: WasmLoadStatus) => void>();
  /** The compiler download's latest status (null before the worker reported one). */
  lastStatus: WasmLoadStatus | null = null;

  constructor() {
    this.worker = new Worker(new URL("./compile-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<CompileResponse>): void => {
      const data = ev.data;
      if (data.kind === "status") {
        this.lastStatus = data.status;
        for (const fn of this.statusListeners) fn(data.status);
        return;
      }
      const resolve = this.pending.get(data.id);
      if (!resolve) return;
      this.pending.delete(data.id);
      if (data.kind === "disassemble") (resolve as (t: string) => void)(data.text);
      else if (data.kind === "watch") (resolve as (r: WatchCompile) => void)({ result: data.result, watches: data.watches });
      else (resolve as (r: FxCompiled) => void)(data.result);
    };
  }

  /** Follow the compiler bundle's download (downloading / retrying / failed /
   * ready) to tell the user what's going on. Returns an unsubscribe. */
  onStatus(fn: (s: WasmLoadStatus) => void): () => void {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  /** Start downloading the compiler now (screen open), so the first compile
   * doesn't wait on it — and a flaky network is retried before it matters. */
  warm(): void {
    const req: CompileRequest = { id: this.nextId++, kind: "warm" };
    this.worker.postMessage(req);
  }

  /** Compile source off-thread. Resolves with {ok, bytecode, uniforms,
   * diagnostics}; never rejects — compiler errors come back as diagnostics. */
  compile(src: string): Promise<FxCompiled> {
    const id = this.nextId++;
    const req: CompileRequest = { id, src };
    return new Promise<FxCompiled>((resolve) => {
      this.pending.set(id, resolve as (r: never) => void);
      this.worker.postMessage(req);
    });
  }

  /** The Watch pane's host build of `src` watching `ranges` (flat UTF-16
   * start/end pairs). Never rejects. */
  compileWatch(src: string, ranges: Uint32Array): Promise<WatchCompile> {
    const id = this.nextId++;
    const req: CompileRequest = { id, kind: "watch", src, ranges };
    return new Promise<WatchCompile>((resolve) => {
      this.pending.set(id, resolve as (r: never) => void);
      this.worker.postMessage(req);
    });
  }

  /** Disassemble compiled `.fxb` bytecode off-thread to a readable op listing.
   * Never rejects — failures come back as a `; ...` error line. */
  disassemble(fxb: Uint8Array): Promise<string> {
    const id = this.nextId++;
    const req: CompileRequest = { id, kind: "disassemble", fxb };
    return new Promise<string>((resolve) => {
      this.pending.set(id, resolve as (r: never) => void);
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
    this.statusListeners.clear();
  }
}
