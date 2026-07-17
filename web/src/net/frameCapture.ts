/**
 * Full-resolution frame capture for OFFLINE replay of the whole CV pipeline
 * (detector → CCL → tracker → decoder), so the blob detector can be tuned in
 * software against real captures — the per-frame trace only carries detected
 * blobs, which is not enough to re-run detection.
 *
 * The frame is the detector's byte-exact input (DetectorGL.grabFrame reads it
 * back from the same texture the threshold pass samples). It's LOSSLESS but
 * gzip-compressed on the way out — LED scenes are mostly dark, so deflate
 * shrinks them a lot — and uploaded as a binary body to the trace server's
 * `/frame` endpoint, keyed by the same `seq` the frame's metadata carries in
 * the trace stream. Uploads are fire-and-forget and bounded: if the encoder or
 * network can't keep up, whole frames are dropped (and counted) rather than
 * stalling the capture loop.
 *
 * The gzip + framing is pure and unit-tested; only `upload()` touches fetch.
 */

/** gzip a byte buffer via the platform CompressionStream. */
export async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream("gzip");
  const writer = cs.writable.getWriter();
  void writer.write(bytes as unknown as BufferSource);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = cs.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) chunks.push(value);
  }
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/** Derive the `/frame` upload endpoint from the trace `/trace` URL. */
export function frameUrlFromTraceUrl(traceUrl: string): string {
  return traceUrl.replace(/\/trace\/?$/, "/frame");
}

export class FrameSink {
  private readonly queue: { seq: number; w: number; h: number; rgba: Uint8Array }[] = [];
  private ramBytes = 0;
  private draining = 0;
  private dropped = 0;
  private sent = 0;
  private warned = false;
  private closed = false;

  /**
   * @param concurrency  background gzip+upload workers (overlap CPU + network).
   * @param ramCapBytes  safety valve: frames buffered beyond this are dropped
   *   (counted + warned) rather than risking an OOM. Normally the drain keeps
   *   up and the queue stays tiny, so this is rarely hit.
   */
  constructor(
    private readonly url: string,
    private readonly session: string,
    private readonly concurrency = 3,
    private readonly ramCapBytes = 1_000_000_000,
    private readonly fetchFn: typeof fetch = globalThis.fetch?.bind(globalThis),
  ) {}

  /** Frames dropped to the RAM cap (should stay 0; surfaced in the HUD). */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Frames fully compressed + uploaded. */
  get sentCount(): number {
    return this.sent;
  }

  /** Frames buffered in RAM, awaiting compression + upload (backpressure). */
  get queuedCount(): number {
    return this.queue.length;
  }

  /** Approximate RAM held by the buffered frames, in MB. */
  get ramMB(): number {
    return Math.round(this.ramBytes / 1e6);
  }

  /**
   * Cache one full-res RGBA frame in RAM and kick the background drain. Never
   * blocks the capture loop: the reused buffer is snapshotted synchronously,
   * then gzip + upload happen in the background (and keep going after the
   * capture ends — see finish()), so no frame is dropped for I/O backpressure.
   * The only drop path is the RAM safety cap.
   */
  capture(seq: number, w: number, h: number, rgba: Uint8Array): void {
    if (!this.fetchFn || this.closed) return;
    if (this.ramBytes + rgba.length > this.ramCapBytes) {
      this.dropped++;
      if (!this.warned) {
        this.warned = true;
        console.warn(`frame RAM cap (${this.ramMB} MB) hit — dropping to avoid OOM`);
      }
      return;
    }
    const snapshot = rgba.slice(); // the detector reuses the buffer next frame
    this.queue.push({ seq, w, h, rgba: snapshot });
    this.ramBytes += snapshot.length;
    this.pump();
  }

  private pump(): void {
    while (this.draining < this.concurrency && this.queue.length > 0) {
      this.draining++;
      void this.drainWorker();
    }
  }

  private async drainWorker(): Promise<void> {
    for (;;) {
      const item = this.queue.shift();
      if (!item) break;
      this.ramBytes -= item.rgba.length;
      try {
        const body = await gzip(item.rgba);
        const url =
          `${this.url}?session=${encodeURIComponent(this.session)}` +
          `&seq=${item.seq}&w=${item.w}&h=${item.h}`;
        await this.fetchFn!(url, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: body as unknown as BodyInit,
        });
        this.sent++;
      } catch (e) {
        if (!this.warned) {
          this.warned = true;
          console.warn(`frame upload to ${this.url} failed (first of possibly many):`, e);
        }
      }
    }
    this.draining--;
  }

  /**
   * Resolve once the RAM queue is fully drained (all frames compressed +
   * uploaded). Call after the capture stops; the drain keeps running in the
   * background so the ENTIRE session lands even though full-res frames outrun
   * the live upload bandwidth. `onProgress(remaining)` is polled for a HUD.
   */
  async finish(onProgress: (remaining: number) => void = () => undefined): Promise<void> {
    this.closed = true;
    while (this.queue.length > 0 || this.draining > 0) {
      onProgress(this.queue.length + this.draining);
      await new Promise((r) => setTimeout(r, 150));
    }
    onProgress(0);
  }
}
