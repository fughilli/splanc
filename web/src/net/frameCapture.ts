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
  private inFlight = 0;
  private dropped = 0;
  private sent = 0;
  private warned = false;

  /** @param maxInFlight cap on concurrent uploads; excess frames are dropped. */
  constructor(
    private readonly url: string,
    private readonly session: string,
    private readonly maxInFlight = 2,
    private readonly fetchFn: typeof fetch = globalThis.fetch?.bind(globalThis),
  ) {}

  /** Frames skipped because uploads were saturated (surfaced in the HUD). */
  get droppedCount(): number {
    return this.dropped;
  }

  /** Frames successfully uploaded (surfaced in the HUD as capture feedback). */
  get sentCount(): number {
    return this.sent;
  }

  /**
   * Snapshot, gzip and upload one full-res RGBA frame under `seq`. The `rgba`
   * buffer is reused by the caller, so it is COPIED synchronously before the
   * first await. Returns immediately if too many uploads are in flight (the
   * frame is dropped + counted) so the capture loop never blocks on I/O.
   */
  async capture(seq: number, w: number, h: number, rgba: Uint8Array): Promise<void> {
    if (!this.fetchFn) return;
    if (this.inFlight >= this.maxInFlight) {
      this.dropped++;
      return;
    }
    this.inFlight++;
    const snapshot = rgba.slice(); // detector reuses the buffer next frame
    try {
      const body = await gzip(snapshot);
      const url =
        `${this.url}?session=${encodeURIComponent(this.session)}` +
        `&seq=${seq}&w=${w}&h=${h}`;
      await this.fetchFn(url, {
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
    } finally {
      this.inFlight--;
    }
  }
}
