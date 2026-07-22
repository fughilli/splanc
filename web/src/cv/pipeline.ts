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
  /**
   * WebXR-free capture mode (docs/vio-exploration.md): emit DENSE records —
   * one per identified blob per sampled frame, pose from the frame meta
   * (null on that path) — instead of the per-(track, cycle) anchor records.
   * The server's visual-inertial solver wants every sighting: its pose
   * variables live at frame times, so per-cycle anchors would starve it
   * (~10× fewer constraints). Ids still come from the decoder; the decoder
   * also keeps running for HUD stats and track labeling.
   */
  denseRecords?: boolean;
  /** Emit dense records every Nth frame (default 3 ≈ 10 Hz at 30 fps —
   * matches the solver's keyframe rate; full rate just burns bandwidth). */
  denseStride?: number;
}

/** Per-frame 2D-stage feedback: one entry per detected blob (see step()). */
export interface BlobStatus {
  u: number;
  v: number;
  /** Blob area in image px² (outline radius for the UI). */
  area: number;
  /** Matched a pre-existing track this frame (vs spawning a fresh one). */
  matched: boolean;
  /** The matched track's decoded LED id, when it has one. */
  ledId: number | null;
}

export class CvPipeline {
  readonly tracker: Tracker;
  readonly decoder: Decoder;
  /** 2D-stage feedback for the frame most recently passed to step(). */
  lastBlobStatus: BlobStatus[] = [];
  private cb: ((records: DetectionRecord[]) => void) | null = null;
  private readonly toServerTime: (tLocalMs: number) => number;
  private readonly dense: boolean;
  private readonly denseStride: number;
  private frameIndex = 0;

  constructor(
    readonly params: CodeParams,
    epochMs: number,
    toServerTime: (tLocalMs: number) => number,
    opts: PipelineOptions = {},
  ) {
    this.toServerTime = toServerTime;
    this.dense = opts.denseRecords ?? false;
    this.denseStride = Math.max(1, opts.denseStride ?? 3);
    // Every LED is lit every frame under the hue carrier, so coasting only
    // bridges occlusion / frame exit — but keep the generous default: a
    // track that survives a full cycle re-acquires its identity instantly.
    const coast = opts.tracker?.maxCoastMs ?? 1.25 * cycleMs(params);
    this.tracker = new Tracker({ ...opts.tracker, maxCoastMs: coast });
    this.decoder = new Decoder(params, epochMs, toServerTime, opts.decoder);
  }

  onDetections(cb: (records: DetectionRecord[]) => void): void {
    this.cb = cb;
  }

  /**
   * Feed the continuous solver's latest solved LEDs back into the tracker:
   * identified tracks then coast by reprojection through the frame pose
   * (pose-corrected temporal inertia) instead of 2D constant velocity.
   */
  updateSolved(leds: Iterable<{ id: number; xyz: [number, number, number] }>): void {
    this.tracker.setSolvedPositions(leds);
  }

  /** Ingest one frame. Returns records if a cycle completed on this frame. */
  step(blobs: readonly Blob[], meta: FrameMeta): DetectionRecord[] {
    this.tracker.step(blobs, meta);
    this.lastBlobStatus = blobs.map((b, i) => {
      const tr = this.tracker.lastAssignment[i] ?? null;
      return { u: b.u, v: b.v, area: b.area, matched: tr !== null, ledId: tr?.ledId ?? null };
    });
    // The saturated-GREEN census is the global delimiter signal the
    // decoder's self-clocking alignment keys on (ALL_OFF renders green;
    // no data symbol is green — yellow has r≈g, cyan is unused).
    let greens = 0;
    for (const b of blobs) {
      const r = b.r ?? 0;
      const g = b.g ?? 0;
      const bl = b.b ?? 0;
      const mx = Math.max(r, g, bl);
      if (mx > 0 && (mx - Math.min(r, g, bl)) / mx >= 0.45 && g > 1.4 * r && g > 1.4 * bl) {
        greens++;
      }
    }
    const records = this.decoder.step(this.tracker.tracks, meta.tCaptureMs, greens);
    if (this.dense) {
      // Dense mode: per-frame samples of every identified blob replace the
      // per-cycle anchor records on the wire (decoder records still label
      // tracks and feed stats). Brightest-per-id mirrors the decoder's
      // reflection dedup at frame granularity.
      if (this.frameIndex % this.denseStride === 0) {
        const best = new Map<number, { rec: DetectionRecord; intensity: number }>();
        for (let i = 0; i < blobs.length; i++) {
          const tr = this.tracker.lastAssignment[i] ?? null;
          if (tr === null || tr.ledId === null) continue;
          const b = blobs[i]!;
          const prev = best.get(tr.ledId);
          if (prev !== undefined && prev.intensity >= b.intensity) continue;
          best.set(tr.ledId, {
            intensity: b.intensity,
            rec: {
              ledId: tr.ledId,
              tCaptureMs: meta.tCaptureMs,
              u: b.u,
              v: b.v,
              imgW: meta.imgW,
              imgH: meta.imgH,
              K: meta.K,
              pose: meta.pose,
              confidence: tr.ledConfidence ?? 0.5,
            },
          });
        }
        if (best.size > 0) this.cb?.([...best.values()].map((e) => e.rec));
      }
      this.frameIndex++;
    } else if (records.length > 0) {
      this.cb?.(records);
    }

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
