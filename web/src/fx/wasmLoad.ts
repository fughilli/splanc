/**
 * Retrying loader for the fixed-name wasm-bindgen bundles (/fx-compiler, /fx-vm).
 *
 * Why this exists: a dynamic `import()` that fails once (a flaky phone network,
 * a captive portal, a dropped Wi-Fi hop) is cached as FAILED in the document's
 * (or worker's) module map for its whole lifetime — Chrome answers every later
 * `import()` of the same URL with the same "Failed to fetch dynamically imported
 * module" instantly, without touching the network. The old loaders also cached
 * the rejected promise itself, so one transient failure meant no effect could
 * compile until the app was reloaded.
 *
 * So each attempt after the first imports a cache-busted URL (`?retry=N`, a new
 * module-map key), attempts back off, a load that never failed is cached, and a
 * load that failed is NOT: the next caller (or a background retry) starts over.
 * Status callbacks let the screens say "Downloading the effect compiler…" /
 * "couldn't download, retrying" instead of a bare compile error.
 *
 * Pure (no DOM, no `self`): runs in the compile worker and on the main thread.
 */

/** Where a retrying load stands, for the UI. */
export type WasmLoadPhase = "downloading" | "retrying" | "ready" | "failed";

export interface WasmLoadStatus {
  phase: WasmLoadPhase;
  /** 0-based attempt number of the load this status is about. */
  attempt: number;
  /** "failed": the last attempt's error. */
  error?: string;
  /** "failed": when the background retry fires (ms from now). */
  nextRetryMs?: number;
  /** "ready": the load succeeded only after at least one failed attempt. */
  recovered?: boolean;
}

/** A load that failed every attempt of one round (the bundle could not be
 * downloaded / instantiated). Distinct from a compile error in the user's code. */
export class WasmDownloadError extends Error {
  readonly attempts: number;
  constructor(message: string, attempts: number) {
    super(message);
    this.name = "WasmDownloadError";
    this.attempts = attempts;
  }
}

/** `url` for attempt 0; a cache-busted `url?retry=N` (or `&retry=N`) after, so a
 * failed import's module-map entry is never hit again. */
export function retryUrl(url: string, attempt: number): string {
  if (attempt <= 0) return url;
  return `${url}${url.includes("?") ? "&" : "?"}retry=${attempt}`;
}

export interface RetryingLoaderOptions<T> {
  /** One attempt: import + init the bundle (use {@link retryUrl} with `attempt`). */
  load: (attempt: number) => Promise<T>;
  /** Waits between the attempts of one round (attempts = delays + 1). */
  delaysMs?: readonly number[];
  /** After a failed round, wait this long before retrying in the background
   * (the last entry repeats). Empty = no background retry. */
  backgroundMs?: readonly number[];
  onStatus?: (s: WasmLoadStatus) => void;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface RetryingLoader<T> {
  /** The loaded module: cached once loaded, shared while in flight, retried from
   * scratch (after a failed round) on the next call. Rejects with
   * {@link WasmDownloadError}. */
  get(): Promise<T>;
  /** Start (or join) a load without awaiting it — prefetch. Never rejects. */
  warm(): void;
  /** Whether a load has succeeded. */
  readonly ready: boolean;
  /** Cancel a pending background retry (screen teardown). */
  dispose(): void;
}

export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [500, 1500, 4000];
export const DEFAULT_BACKGROUND_RETRY_MS: readonly number[] = [10_000, 30_000, 60_000];

export function createRetryingLoader<T>(opts: RetryingLoaderOptions<T>): RetryingLoader<T> {
  const delays = opts.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const background = opts.backgroundMs ?? DEFAULT_BACKGROUND_RETRY_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const setTimer = opts.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearTimer = opts.clearTimer ?? ((h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let nextAttempt = 0; // monotonic: every attempt uses a URL no earlier attempt used
  let failures = 0; // failed rounds since the last success (background backoff index)
  let inFlight: Promise<T> | null = null;
  let loaded: Promise<T> | null = null;
  let timer: unknown = null;
  let disposed = false;
  let everFailed = false;

  const status = (s: WasmLoadStatus): void => {
    try {
      opts.onStatus?.(s);
    } catch {
      /* a UI callback must not break the load */
    }
  };

  function round(): Promise<T> {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    return (async (): Promise<T> => {
      let lastErr = "";
      for (let i = 0; i <= delays.length; i++) {
        const attempt = nextAttempt++;
        status({ phase: attempt === 0 ? "downloading" : "retrying", attempt });
        try {
          const mod = await opts.load(attempt);
          loaded = Promise.resolve(mod);
          failures = 0;
          status({ phase: "ready", attempt, ...(everFailed ? { recovered: true } : {}) });
          return mod;
        } catch (e) {
          everFailed = true;
          lastErr = e instanceof Error ? e.message : String(e);
          if (i < delays.length) await sleep(delays[i]!);
        }
      }
      const wait = background.length > 0 ? background[Math.min(failures, background.length - 1)]! : undefined;
      failures++;
      status({ phase: "failed", attempt: nextAttempt - 1, error: lastErr, ...(wait !== undefined ? { nextRetryMs: wait } : {}) });
      if (wait !== undefined && !disposed) {
        timer = setTimer(() => {
          timer = null;
          if (!disposed && inFlight === null && loaded === null) warm();
        }, wait);
      }
      throw new WasmDownloadError(lastErr, delays.length + 1);
    })();
  }

  function get(): Promise<T> {
    if (loaded) return loaded;
    if (inFlight) return inFlight;
    const p = round();
    inFlight = p;
    const clear = (): void => {
      if (inFlight === p) inFlight = null;
    };
    p.then(clear, clear);
    return p;
  }

  function warm(): void {
    get().catch(() => undefined);
  }

  return {
    get,
    warm,
    get ready() {
      return loaded !== null;
    },
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/** The diagnostic message a compile carries when the compiler itself could not
 * be downloaded (FxCompiled.compilerUnavailable). */
export function compilerDownloadMessage(error: string): string {
  return `couldn't download the effect compiler (${error}) — retrying; this is a network problem, not an error in the effect`;
}

/** The one-line status the screens show for a compiler load status, or null when
 * nothing needs saying (a first download that just works stays quiet). */
export function compilerStatusText(s: WasmLoadStatus): string | null {
  switch (s.phase) {
    case "downloading":
      return "Downloading the effect compiler…";
    case "retrying":
      return `Couldn't download the effect compiler — retrying (attempt ${s.attempt + 1})…`;
    case "failed":
      return s.nextRetryMs !== undefined
        ? `Couldn't download the effect compiler — check your connection; retrying in ${Math.round(s.nextRetryMs / 1000)} s.`
        : "Couldn't download the effect compiler — check your connection.";
    case "ready":
      return s.recovered ? "Effect compiler downloaded." : null;
  }
}

/** What an AI tool (set_script) is told when the compile failed because the
 * compiler could not be downloaded: not the script's fault, being retried. */
export function compilerUnavailableToolResult(error: string): string {
  return (
    "NOT a compile error: the effect compiler could not be downloaded to this phone " +
    `(network problem: ${error}). The app is retrying the download in the background. ` +
    "Your script was kept; do not rewrite it. Tell the user it's a connection hiccup " +
    "with downloading the effect compiler and that it is being retried, then call set_script " +
    "again with the same script in a moment."
  );
}
