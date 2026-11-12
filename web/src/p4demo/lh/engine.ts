/**
 * The lighthouse wasm (//web/lh_wasm, wasm.rs `LhTracker`) behind one async
 * interface, run either in this thread ({@link DirectEngine}: tests, and the
 * fallback) or in its worker ({@link WorkerEngine}: the page; /lh-wasm/worker.js).
 *
 * Every call that produces kernel events hands them to `onEvents` (JSON objects,
 * see web/lh_wasm/src/core.rs). `send` is fire-and-forget (reports); `call`
 * resolves with the method's result after its events were delivered.
 */

import { assetUrl } from "../../assetBase";

/** The wasm-bindgen class (web/lh_wasm/src/wasm.rs). */
export interface LhWasmTracker {
  add_device(vid: number, pid: number): number;
  remove_device(handle: number): void;
  handshake(handle: number): string;
  handshake_answer(handle: number, reportId: number, status: number, data: Uint8Array): void;
  report(handle: number, iface: number, data: Uint8Array, hostUs: number): void;
  reports(packed: Uint8Array): void;
  tick(hostUs: number): Uint32Array | number[];
  station_prior(id: number, pose: Float64Array, cov: Float64Array, cal: Float64Array): void;
  recalibrate(): void;
  reset(): void;
  drain(): string;
  free?(): void;
}

export interface LhWasmModule {
  LhTracker: new (hostClock: boolean, stream: boolean) => LhWasmTracker;
}

/** One event out of the kernel glue (core.rs drain_kernel); `type` first. */
export interface LhEvent {
  type: string;
  [k: string]: unknown;
}

export type LhMethod = Exclude<keyof LhWasmTracker, "drain" | "free">;

export interface LhEngine {
  call<T = unknown>(method: LhMethod, ...args: unknown[]): Promise<T>;
  send(method: LhMethod, ...args: unknown[]): void;
  onEvents(cb: (events: LhEvent[]) => void): void;
  dispose(): void;
}

export interface EngineOptions {
  /** Map device clocks onto report arrival times (lhd --host-clock). Default true. */
  hostClock?: boolean;
  /** Stream sweeps into the filter as their reports come (lhd --stream-sweeps). Default true. */
  stream?: boolean;
}

/** The wasm in this thread. */
export class DirectEngine implements LhEngine {
  private readonly t: LhWasmTracker;
  private cb: ((events: LhEvent[]) => void) | null = null;

  constructor(mod: LhWasmModule, opts: EngineOptions = {}) {
    this.t = new mod.LhTracker(opts.hostClock ?? true, opts.stream ?? true);
  }

  private run(method: LhMethod, args: unknown[]): unknown {
    const fn = this.t[method] as unknown as (...a: unknown[]) => unknown;
    let r = fn.apply(this.t, args);
    if (r instanceof Uint32Array) r = Array.from(r);
    const json = this.t.drain();
    if (json !== "[]" && this.cb) this.cb(JSON.parse(json) as LhEvent[]);
    return r;
  }

  call<T = unknown>(method: LhMethod, ...args: unknown[]): Promise<T> {
    try {
      return Promise.resolve(this.run(method, args) as T);
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  send(method: LhMethod, ...args: unknown[]): void {
    this.run(method, args);
  }

  onEvents(cb: (events: LhEvent[]) => void): void {
    this.cb = cb;
  }

  dispose(): void {
    this.t.free?.();
  }
}

type WorkerMsg =
  | { kind: "ready" }
  | { kind: "events"; json: string }
  | { kind: "result"; id: number; result: unknown }
  | { kind: "error"; id?: number; msg: string };

/** The wasm in its worker (/lh-wasm/worker.js). */
export class WorkerEngine implements LhEngine {
  private cb: ((events: LhEvent[]) => void) | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, { ok: (v: unknown) => void; err: (e: Error) => void }>();

  private constructor(private readonly worker: Worker) {
    worker.onmessage = (ev: MessageEvent<WorkerMsg>) => {
      const m = ev.data;
      if (m.kind === "events") {
        this.cb?.(JSON.parse(m.json) as LhEvent[]);
      } else if (m.kind === "result") {
        this.pending.get(m.id)?.ok(m.result);
        this.pending.delete(m.id);
      } else if (m.kind === "error") {
        if (m.id !== undefined && this.pending.has(m.id)) {
          this.pending.get(m.id)!.err(new Error(m.msg));
          this.pending.delete(m.id);
        } else {
          console.warn("lh worker:", m.msg);
        }
      }
    };
  }

  static async create(baseUrl = assetUrl("lh-wasm"), opts: EngineOptions = {}, timeoutMs = 20_000): Promise<WorkerEngine> {
    const worker = new Worker(`${baseUrl}/worker.js`, { type: "module" });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lh worker: no answer (wasm not served?)")), timeoutMs);
      worker.onmessage = (ev: MessageEvent<WorkerMsg>) => {
        clearTimeout(timer);
        if (ev.data.kind === "ready") resolve();
        else reject(new Error(ev.data.kind === "error" ? ev.data.msg : "lh worker: unexpected message"));
      };
      worker.onerror = (e) => {
        clearTimeout(timer);
        reject(new Error(`lh worker: ${e.message || "failed to load"}`));
      };
      worker.postMessage({ cmd: "init", baseUrl, hostClock: opts.hostClock ?? true, stream: opts.stream ?? true });
    }).catch((e) => {
      worker.terminate();
      throw e;
    });
    return new WorkerEngine(worker);
  }

  call<T = unknown>(method: LhMethod, ...args: unknown[]): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((ok, err) => {
      this.pending.set(id, { ok: ok as (v: unknown) => void, err });
      this.worker.postMessage({ id, method, args });
    });
  }

  send(method: LhMethod, ...args: unknown[]): void {
    // A report batch is built for this message alone: hand its buffer over.
    const batch = method === "reports" && args[0] instanceof Uint8Array ? [args[0].buffer as ArrayBuffer] : [];
    this.worker.postMessage({ method, args }, batch);
  }

  onEvents(cb: (events: LhEvent[]) => void): void {
    this.cb = cb;
  }

  dispose(): void {
    this.worker.terminate();
    for (const p of this.pending.values()) p.err(new Error("lh worker: disposed"));
    this.pending.clear();
  }
}

/** The page's engine: the worker, else (no module workers) the wasm in this thread. */
export async function loadBrowserEngine(opts: EngineOptions = {}, baseUrl = assetUrl("lh-wasm")): Promise<LhEngine> {
  try {
    return await WorkerEngine.create(baseUrl, opts);
  } catch (e) {
    console.warn("lh: worker unavailable, running the tracker on the page thread:", e);
    const mod = (await import(/* @vite-ignore */ `${baseUrl}/lh_wasm_pkg.js`)) as LhWasmModule & {
      default(init: { module_or_path: string }): Promise<unknown>;
    };
    await mod.default({ module_or_path: `${baseUrl}/lh_wasm_pkg_bg.wasm` });
    return new DirectEngine(mod, opts);
  }
}
