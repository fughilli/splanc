/**
 * Resumable, checkpointed model download (FUG-87 follow-up).
 *
 * Model weights are hundreds of MB to a few GB. wllama's built-in downloader
 * fetches the whole GGUF in one shot and DELETES the partial on any failure — so
 * backgrounding the app (locking the phone) aborts the fetch and forces a full
 * re-download. This module instead streams the file into the Origin Private File
 * System (OPFS) and CHECKPOINTS as it goes: the partial file's size on disk IS
 * the resume point. On the next attempt it issues an HTTP Range request from that
 * offset (with `If-Range` on the stored ETag so a changed file restarts cleanly),
 * so a lock/background costs only the in-flight bytes, not the whole download.
 *
 * A bounded retry-with-resume loop makes this automatic: when a fetch dies
 * (network drop, or the JS suspend that a background/lock causes), the loop —
 * which resumes when the page is foregrounded again — retries from the checkpoint.
 * True "download while the screen is locked" is NOT possible from a page (it needs
 * the Chromium-only Background Fetch API); this makes locking non-destructive.
 *
 * The pure planning helpers are unit-tested; the OPFS/network runtime is
 * browser-only (validated on-device). Callers fall back to the provider's own
 * downloader when OPFS isn't available (isResumableDownloadSupported()).
 */

// -- pure helpers (unit-tested) ----------------------------------------------

/** A stable, filesystem-safe key for a URL (hash + a readable filename tail). */
export function keyFor(url: string): string {
  let h = 5381;
  for (let i = 0; i < url.length; i++) h = ((h << 5) + h + url.charCodeAt(i)) >>> 0;
  const tail = (url.split("/").pop() || "model").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-48);
  return `${h.toString(16)}_${tail}`;
}

/** The `Range` header value to resume from `from` bytes. */
export function rangeHeader(from: number): string {
  return `bytes=${from}-`;
}

/** Total size from a `Content-Range` header ("bytes 0-99/12345" → 12345). */
export function parseContentRangeTotal(header: string | null): number | null {
  if (!header) return null;
  const m = /\/(\d+)\s*$/.exec(header);
  return m ? parseInt(m[1]!, 10) : null;
}

export type ResumeAction = "resume" | "restart" | "complete" | "error";

/** Decide what a Range request's status means for our partial file.
 *   206 Partial Content        → resume (append at `from`)
 *   200 OK                     → server ignored Range / If-Range mismatch → restart
 *   416 Range Not Satisfiable  → the file is already fully downloaded → complete
 *   anything else              → error (surfaced / retried by the caller) */
export function actionForStatus(status: number, from: number): ResumeAction {
  if (status === 206) return "resume";
  if (status === 200) return "restart";
  if (status === 416) return from > 0 ? "complete" : "error";
  return "error";
}

/** Backoff (ms) for retry attempt N (1-based), capped. */
export function backoffMs(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), 15_000);
}

// -- OPFS runtime (browser-only) ---------------------------------------------

/** Progress of a resumable download (absolute bytes; total may be unknown). */
export interface DownloadProgress {
  loaded: number;
  total: number | null;
}

interface Meta {
  url: string;
  etag: string;
  total: number;
  complete: boolean;
}

const DIR = "ai-models";
const MAX_RETRIES = 8;

/** True when OPFS + writable streams are available (else callers fall back). */
export function isResumableDownloadSupported(): boolean {
  return (
    typeof navigator !== "undefined" &&
    !!navigator.storage?.getDirectory &&
    typeof FileSystemWritableFileStream !== "undefined"
  );
}

async function modelDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(DIR, { create: true });
}

async function dataHandle(url: string, create: boolean): Promise<FileSystemFileHandle> {
  return (await modelDir()).getFileHandle(`${keyFor(url)}.gguf`, { create });
}

async function readMeta(url: string): Promise<Meta | null> {
  try {
    const fh = await (await modelDir()).getFileHandle(`${keyFor(url)}.json`);
    return JSON.parse(await (await fh.getFile()).text()) as Meta;
  } catch {
    return null;
  }
}

async function writeMeta(url: string, meta: Meta): Promise<void> {
  const fh = await (await modelDir()).getFileHandle(`${keyFor(url)}.json`, { create: true });
  const w = await fh.createWritable();
  await w.write(JSON.stringify(meta));
  await w.close();
}

/** Bytes already on disk for `url` (the resume checkpoint). */
export async function cachedBytes(url: string): Promise<number> {
  try {
    return (await (await dataHandle(url, false)).getFile()).size;
  } catch {
    return 0;
  }
}

/** Whether `url` is fully downloaded (complete flag + size matches). */
export async function isModelCached(url: string): Promise<boolean> {
  const meta = await readMeta(url);
  if (!meta?.complete) return false;
  const size = await cachedBytes(url);
  return meta.total > 0 ? size >= meta.total : size > 0;
}

/** The fully-downloaded file for `url`, or null if not complete. */
export async function cachedModelFile(url: string): Promise<File | null> {
  if (!(await isModelCached(url))) return null;
  return (await dataHandle(url, false)).getFile();
}

/** Delete a model's cached (partial or complete) bytes + metadata. */
export async function deleteCachedModel(url: string): Promise<void> {
  const dir = await modelDir();
  for (const name of [`${keyFor(url)}.gguf`, `${keyFor(url)}.json`]) {
    try {
      await dir.removeEntry(name);
    } catch {
      // not present — fine
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

/**
 * Download `url` to the OPFS cache, resuming from the on-disk checkpoint. Retries
 * transient failures (incl. the fetch death a background/lock causes) from the
 * checkpoint. Returns the completed File. Respects `signal` for user-cancel.
 */
export async function downloadModelResumable(
  url: string,
  opts: {
    onProgress?: ((p: DownloadProgress) => void) | undefined;
    signal?: AbortSignal | undefined;
  } = {},
): Promise<File> {
  const { onProgress, signal } = opts;
  const existing = await cachedModelFile(url);
  if (existing) return existing;

  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    const from = await cachedBytes(url);
    const meta = await readMeta(url);
    const headers: Record<string, string> = {};
    if (from > 0) {
      headers["Range"] = rangeHeader(from);
      if (meta?.etag) headers["If-Range"] = meta.etag;
    }

    let resp: Response;
    try {
      resp = await fetch(url, { headers, signal: signal ?? null });
    } catch (e) {
      if (signal?.aborted || ++attempt > MAX_RETRIES) throw e;
      await sleep(backoffMs(attempt), signal);
      continue;
    }

    const action = from > 0 ? actionForStatus(resp.status, from) : resp.ok ? "restart" : "error";
    if (action === "complete") {
      await writeMeta(url, { url, etag: meta?.etag ?? "", total: from, complete: true });
      return (await cachedModelFile(url)) ?? (await dataHandle(url, false)).getFile();
    }
    if (action === "error" || !resp.ok || !resp.body) {
      // 4xx (other than 416) is not retryable; 5xx / no-body → retry from checkpoint.
      if ((resp.status >= 400 && resp.status < 500) || ++attempt > MAX_RETRIES) {
        throw new Error(`download failed: HTTP ${resp.status} for ${url}`);
      }
      await sleep(backoffMs(attempt), signal);
      continue;
    }

    const restart = action === "restart"; // 200: start over (Range ignored / file changed)
    const etag = resp.headers.get("etag") ?? meta?.etag ?? "";
    const total = restart
      ? Number(resp.headers.get("content-length")) || null
      : (parseContentRangeTotal(resp.headers.get("content-range")) ?? meta?.total ?? null);
    await writeMeta(url, { url, etag, total: total ?? 0, complete: false });

    const startAt = restart ? 0 : from;
    const w = await (await dataHandle(url, true)).createWritable({ keepExistingData: !restart });
    let pos = startAt;
    try {
      if (!restart) await w.seek(startAt);
      const reader = resp.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (signal?.aborted) throw new DOMException("aborted", "AbortError");
        await w.write(value);
        pos += value.byteLength;
        onProgress?.({ loaded: pos, total });
      }
      await w.close();
    } catch (e) {
      try {
        await w.close();
      } catch {
        /* ignore */
      }
      if (signal?.aborted) throw e;
      // Made progress → reset the attempt counter so a long download isn't capped
      // by transient drops; otherwise count it toward the retry ceiling.
      if (pos > startAt) attempt = 0;
      else attempt++;
      if (attempt > MAX_RETRIES) throw e;
      await sleep(backoffMs(Math.max(1, attempt)), signal);
      continue;
    }

    const size = await cachedBytes(url);
    if (total === null || size >= total) {
      await writeMeta(url, { url, etag, total: size, complete: true });
      return (await cachedModelFile(url)) ?? (await dataHandle(url, false)).getFile();
    }
    // The connection closed early (short read) — loop to resume the remainder.
    attempt = 0;
  }
}
