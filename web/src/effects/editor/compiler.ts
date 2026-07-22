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

export class FxCompilerWorker {
  private readonly worker: Worker;
  private nextId = 1;
  private readonly pending = new Map<number, (r: FxCompiled) => void>();

  constructor() {
    this.worker = new Worker(new URL("./compile-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<CompileResponse>): void => {
      const { id, result } = ev.data;
      const resolve = this.pending.get(id);
      if (resolve) {
        this.pending.delete(id);
        resolve(result);
      }
    };
  }

  /** Compile source off-thread. Resolves with {ok, bytecode, uniforms,
   * diagnostics}; never rejects — compiler errors come back as diagnostics. */
  compile(src: string): Promise<FxCompiled> {
    const id = this.nextId++;
    const req: CompileRequest = { id, src };
    return new Promise<FxCompiled>((resolve) => {
      this.pending.set(id, resolve);
      this.worker.postMessage(req);
    });
  }

  dispose(): void {
    this.worker.terminate();
    this.pending.clear();
  }
}
