/**
 * Capture trace sink — dumps rich per-frame CV data to a trace server
 * (tools/trace_server.py) for offline debugging of detection problems
 * (blooming, misclassification) that can't be seen from the phone.
 *
 * Enabled with `?trace=<url>` on the capture page; the URL is the trace
 * server's POST endpoint (e.g. `https://<laptop>:8444/trace`). Batches
 * frames and flushes on a size/time budget so it never blocks the capture
 * loop. Transport note: from an https origin the trace URL must be https
 * too (mixed content otherwise blocks it), same constraint as the player WS.
 *
 * The batching + payload shaping is pure and unit-tested (trace.test.ts);
 * only `flush()` touches fetch.
 */

import type { Blob } from "../cv/types";

/** One traced blob — the detector's stats fields (detect stats:true) plus
 * the association status the pipeline assigned it. */
export interface TraceBlob {
  u: number;
  v: number;
  area: number;
  intensity: number;
  /** Mean color (bloom-washed toward gray) vs chroma-weighted halo color. */
  r?: number;
  g?: number;
  b?: number;
  cr?: number;
  cg?: number;
  cb?: number;
  peak?: number;
  satFrac?: number;
}

export interface TraceFrame {
  t: number;
  tServer: number;
  frameIndex: number;
  /** The LED output brightness in effect this frame (the servo's current
   * value, 1 = full) — so a trace shows what the brightness servo did. */
  brightness: number;
  blobs: TraceBlob[];
  scene?: { meanLuma: number; p95Luma: number; clipFrac: number } | undefined;
  /** A small color thumbnail (base64 PNG-ish payload) on periodic frames. */
  thumb?: { w: number; h: number; rgbaB64: string } | undefined;
}

export interface TraceHeader {
  sessionId: string;
  startedAt: string;
  ledCount: number;
  wsUrl: string;
  userAgent: string;
  codeParams: unknown;
}

/** One drained get_frame_timing batch: the player's monotonic-clock times for
 * the mapping-pattern frames it rendered, forwarded so pattern-generator
 * stutter (uneven tMonoMs spacing) can be seen offline. `tPhone` is the phone
 * clock when the batch was drained, for correlating the two clock domains. */
export interface TraceTiming {
  tPhone: number;
  patternClockEpoch: number | null;
  bitPeriodMs: number;
  cycleFrames: number;
  dropped: number;
  ticks: { seq: number; tMonoMs: number }[];
}

/** Keep only the fields worth tracing (drops bbox etc.). */
export function toTraceBlob(b: Blob): TraceBlob {
  const t: TraceBlob = { u: b.u, v: b.v, area: b.area, intensity: b.intensity };
  if (b.r !== undefined) {
    t.r = round3(b.r);
    t.g = round3(b.g!);
    t.b = round3(b.b!);
  }
  if (b.cr !== undefined) {
    t.cr = round3(b.cr);
    t.cg = round3(b.cg!);
    t.cb = round3(b.cb!);
    t.peak = round3(b.peak!);
    t.satFrac = round3(b.satFrac!);
  }
  return t;
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000;
}

/** base64 of raw RGBA bytes (the trace server reconstructs the image). */
export function rgbaToB64(rgba: Uint8Array): string {
  let s = "";
  for (let i = 0; i < rgba.length; i++) s += String.fromCharCode(rgba[i]!);
  return typeof btoa === "function" ? btoa(s) : Buffer.from(s, "binary").toString("base64");
}

export class TraceSink {
  private buf: TraceFrame[] = [];
  private timing: TraceTiming[] = [];
  private header: TraceHeader | null = null;
  private posting = false;

  /** @param flushEvery flush once this many frames have queued. */
  constructor(
    private readonly url: string,
    private readonly flushEvery = 30,
    private readonly fetchFn: typeof fetch = globalThis.fetch?.bind(globalThis),
  ) {}

  begin(header: TraceHeader): void {
    this.header = header;
  }

  /** Queue a frame; returns true when a flush is due (caller awaits flush()). */
  push(frame: TraceFrame): boolean {
    this.buf.push(frame);
    return this.buf.length >= this.flushEvery;
  }

  /** Queue a drained frame-timing batch; it rides the next flush. */
  pushTiming(timing: TraceTiming): void {
    this.timing.push(timing);
  }

  get pending(): number {
    return this.buf.length + this.timing.length;
  }

  private warned = false;

  /** POST the queued frames (with the header on the first flush). Best-effort:
   * a failed POST drops the batch rather than stalling the capture. NOTE: no
   * `keepalive` — the Fetch spec caps keepalive bodies at 64 KB and a batch
   * with base64 thumbnails blows past that (silent throw); the page isn't
   * unloading mid-capture, so a plain fetch is correct anyway. */
  async flush(): Promise<void> {
    if ((this.buf.length === 0 && this.timing.length === 0) || this.posting || !this.fetchFn) return;
    this.posting = true;
    const frames = this.buf;
    this.buf = [];
    const timing = this.timing;
    this.timing = [];
    const header = this.header;
    this.header = null; // header rides only the first batch
    try {
      await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ header, frames, timing }),
      });
    } catch (e) {
      // best-effort — the capture must not stall on a trace hiccup — but
      // surface the FIRST failure so a mistyped/untrusted trace URL is
      // visible in the console (the usual cause: the self-signed trace-server
      // cert wasn't accepted on the phone, so the cross-origin POST is
      // rejected before it leaves).
      if (!this.warned) {
        this.warned = true;
        console.warn(`trace POST to ${this.url} failed (first of possibly many):`, e);
      }
    } finally {
      this.posting = false;
    }
  }
}
