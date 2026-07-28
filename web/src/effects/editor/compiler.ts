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
  // Pending resolvers keyed by request id. Compile resolvers take an FxCompiled,
  // disassemble resolvers take a string — stored untyped and narrowed by the
  // response's `kind`.
  private readonly pending = new Map<number, (r: never) => void>();

  constructor() {
    this.worker = new Worker(new URL("./compile-worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (ev: MessageEvent<CompileResponse>): void => {
      const data = ev.data;
      const resolve = this.pending.get(data.id);
      if (!resolve) return;
      this.pending.delete(data.id);
      if (data.kind === "disassemble") (resolve as (t: string) => void)(data.text);
      else (resolve as (r: FxCompiled) => void)(data.result);
    };
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
  }
}
