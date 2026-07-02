/**
 * M6 — the transport-free CV pipeline: blobs in, DetectionRecords out.
 *
 * `CvPipeline` glues track → decode. It deliberately takes *blobs* (not
 * textures): the GPU detect stage (detect.ts) needs a browser/WebGL context,
 * while everything from here down is pure TypeScript — which is what lets the
 * synthetic Phase-3-style tests (tests/pipeline_synthetic.test.ts) drive the
 * production track/decode code with no browser at all.
 */

import type { CodeParams, DetectionRecord } from "@ledmapper/protocol";
import { cycleMs } from "../code/timing";
import { Decoder, type DecoderOptions } from "./decoder";
import { Tracker, type TrackerOptions } from "./tracker";
import type { Blob, FrameMeta } from "./types";

export interface PipelineOptions {
  tracker?: TrackerOptions;
  decoder?: DecoderOptions;
}

export class CvPipeline {
  readonly tracker: Tracker;
  readonly decoder: Decoder;
  private cb: ((records: DetectionRecord[]) => void) | null = null;
  private readonly toServerTime: (tLocalMs: number) => number;

  constructor(
    readonly params: CodeParams,
    epochMs: number,
    toServerTime: (tLocalMs: number) => number,
    opts: PipelineOptions = {},
  ) {
    this.toServerTime = toServerTime;
    // Tracks must outlive the dark stretches of a code word: an LED can be
    // off for the ALL_OFF frame plus every 0-bit — worst case all data bits.
    const coast = opts.tracker?.maxCoastMs ?? 1.25 * cycleMs(params);
    this.tracker = new Tracker({ ...opts.tracker, maxCoastMs: coast });
    this.decoder = new Decoder(params, epochMs, toServerTime, opts.decoder);
  }

  onDetections(cb: (records: DetectionRecord[]) => void): void {
    this.cb = cb;
  }

  /** Ingest one frame. Returns records if a cycle completed on this frame. */
  step(blobs: readonly Blob[], meta: FrameMeta): DetectionRecord[] {
    const matched = this.tracker.step(blobs, meta);
    const records = this.decoder.step(this.tracker.tracks, matched, meta.tCaptureMs);
    if (records.length > 0) this.cb?.(records);

    // Bound memory: drop samples older than the last two cycles.
    const lastCycle = this.decoder.lastCycle;
    if (lastCycle !== null) {
      const cutoffServer = this.decoder.cycleStartServerMs(lastCycle - 1);
      // Convert back to local time via the current (constant) offset.
      const offset = this.toServerTime(0);
      for (const t of this.tracker.tracks) t.pruneBefore(cutoffServer - offset);
    }
    return records;
  }

  get stats() {
    return {
      tracks: this.tracker.tracks.length,
      ...this.decoder.stats,
    };
  }
}
