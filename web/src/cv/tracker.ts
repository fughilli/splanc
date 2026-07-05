/**
 * M6 track stage: maintain stable identities for blobs across frames so a
 * whole temporal-code cycle can be attributed to one physical LED (§8.1
 * decode note — this is the correspondence the code itself can't provide).
 *
 * Nearest-neighbor matching against per-frame predictions. The defining
 * requirement: a track must SURVIVE the frames where its LED is off (its
 * 0-bits and the ALL_OFF sync frame) — so unmatched tracks "coast" on their
 * predicted position, recording an `on: false` sample, and are only killed
 * after `maxCoastMs` without a real match (default ≳ one full cycle plus
 * slack, so an LED that is dark for most of its code word survives).
 *
 * Prediction is pose-aware when it can be: once a track's LED has been
 * decoded AND solved by the continuous solver (setSolvedPositions), its
 * position is predicted by REPROJECTING the solved 3D point through the
 * current frame's pose — which exactly corrects the apparent image motion
 * induced by the camera moving (parallax), something 2D constant velocity
 * cannot. So an identified LED that blinks out (dark bits, brief occlusion,
 * or even leaving the frame) re-acquires the same identity when it reappears,
 * however far the camera has swung in between. Unidentified/unsolved tracks
 * fall back to constant-velocity coasting.
 */

import type { Vec3 } from "@ledmapper/protocol";
import { project } from "../geom/pinhole";
import type { Blob, FrameMeta } from "./types";

export interface TrackSample {
  tCaptureMs: number;
  /** Matched this frame (LED visibly on at this track's position). */
  on: boolean;
  /** Position: measured when on, predicted while coasting. */
  u: number;
  v: number;
  intensity: number;
  /** Mean blob color when matched, [0, 1] each (0 while coasting) — the
   * gray-hue decoder reads bit values from these. */
  r: number;
  g: number;
  b: number;
  meta: FrameMeta;
}

export interface TrackerOptions {
  /** Max px between prediction and blob to accept a match. */
  gatePx?: number;
  /** Kill a track after this long without a real match. */
  maxCoastMs?: number;
  /** EMA factor for velocity updates (0..1, weight of the new estimate). */
  velocityBlend?: number;
}

let nextTrackId = 1;

export class Track {
  readonly id = nextTrackId++;
  u: number;
  v: number;
  /** px per ms. */
  velU = 0;
  velV = 0;
  lastSeenMs: number;
  lastStepMs: number;
  samples: TrackSample[] = [];
  /** Most recent LED id the decoder attributed to this track (null until a cycle decodes). */
  ledId: number | null = null;
  /** Decode confidence of that attribution, in [0, 1]. */
  ledConfidence = 0;

  constructor(blob: Blob, meta: FrameMeta) {
    this.u = blob.u;
    this.v = blob.v;
    this.lastSeenMs = meta.tCaptureMs;
    this.lastStepMs = meta.tCaptureMs;
    this.record(true, blob.u, blob.v, blob.intensity, meta, blob.r, blob.g, blob.b);
  }

  predict(tMs: number): { u: number; v: number } {
    const dt = tMs - this.lastStepMs;
    return { u: this.u + this.velU * dt, v: this.v + this.velV * dt };
  }

  record(
    on: boolean,
    u: number,
    v: number,
    intensity: number,
    meta: FrameMeta,
    r = 0,
    g = 0,
    b = 0,
  ): void {
    this.samples.push({ tCaptureMs: meta.tCaptureMs, on, u, v, intensity, r, g, b, meta });
  }

  /** Drop samples older than `tMs` (the decoder consumes by whole cycles). */
  pruneBefore(tMs: number): void {
    let firstKept = 0;
    while (firstKept < this.samples.length && this.samples[firstKept]!.tCaptureMs < tMs) firstKept++;
    if (firstKept > 0) this.samples.splice(0, firstKept);
  }
}

export class Tracker {
  private readonly gatePx: number;
  private readonly maxCoastMs: number;
  private readonly velocityBlend: number;
  private solved: Map<number, Vec3> | null = null;
  tracks: Track[] = [];
  /**
   * Per-blob association from the most recent step, aligned with that step's
   * blobs array: the pre-existing track the blob matched (whose prediction —
   * reprojected when identified+solved — gated it in), or null when the blob
   * matched nothing and spawned a fresh track. UI feedback for the 2D stage.
   */
  lastAssignment: (Track | null)[] = [];

  constructor(opts: TrackerOptions = {}) {
    this.gatePx = opts.gatePx ?? 60;
    this.maxCoastMs = opts.maxCoastMs ?? 2500;
    this.velocityBlend = opts.velocityBlend ?? 0.3;
  }

  /**
   * Feed the latest live-solved 3D positions (continuous solver output).
   * Identified tracks then coast by reprojection through the frame pose.
   */
  setSolvedPositions(leds: Iterable<{ id: number; xyz: Vec3 }>): void {
    const map = new Map<number, Vec3>();
    for (const l of leds) map.set(l.id, l.xyz);
    this.solved = map.size > 0 ? map : null;
  }

  /** Pose-aware prediction when identified + solved; constant velocity otherwise. */
  private predictTrack(tr: Track, meta: FrameMeta): { u: number; v: number } {
    if (tr.ledId !== null && this.solved !== null) {
      const xyz = this.solved.get(tr.ledId);
      if (xyz !== undefined) {
        const pr = project(meta.pose, meta.K, xyz);
        if (pr.depth > 0) return { u: pr.u, v: pr.v };
      }
    }
    return tr.predict(meta.tCaptureMs);
  }

  /** Ingest one frame's blobs. Returns the number of matched tracks. */
  step(blobs: readonly Blob[], meta: FrameMeta): number {
    const t = meta.tCaptureMs;

    // All candidate (track, blob) pairs within the gate, best-first greedy.
    interface Cand {
      d2: number;
      ti: number;
      bi: number;
    }
    const cands: Cand[] = [];
    const gate2 = this.gatePx * this.gatePx;
    const predictions = this.tracks.map((tr) => this.predictTrack(tr, meta));
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const pred = predictions[ti]!;
      for (let bi = 0; bi < blobs.length; bi++) {
        const b = blobs[bi]!;
        const du = b.u - pred.u;
        const dv = b.v - pred.v;
        const d2 = du * du + dv * dv;
        if (d2 <= gate2) cands.push({ d2, ti, bi });
      }
    }
    cands.sort((a, b) => a.d2 - b.d2);

    const trackTaken = new Uint8Array(this.tracks.length);
    const blobTaken = new Uint8Array(blobs.length);
    const assignment: (Track | null)[] = new Array(blobs.length).fill(null);
    let matched = 0;
    for (const c of cands) {
      if (trackTaken[c.ti] || blobTaken[c.bi]) continue;
      trackTaken[c.ti] = 1;
      blobTaken[c.bi] = 1;
      matched++;
      const tr = this.tracks[c.ti]!;
      assignment[c.bi] = tr;
      const b = blobs[c.bi]!;
      const dt = t - tr.lastSeenMs;
      if (dt > 0) {
        const instU = (b.u - tr.u) / dt;
        const instV = (b.v - tr.v) / dt;
        tr.velU = tr.velU * (1 - this.velocityBlend) + instU * this.velocityBlend;
        tr.velV = tr.velV * (1 - this.velocityBlend) + instV * this.velocityBlend;
      }
      tr.u = b.u;
      tr.v = b.v;
      tr.lastSeenMs = t;
      tr.lastStepMs = t;
      tr.record(true, b.u, b.v, b.intensity, meta, b.r, b.g, b.b);
    }

    // Unmatched tracks coast on their prediction; stale ones die.
    const survivors: Track[] = [];
    for (let ti = 0; ti < this.tracks.length; ti++) {
      const tr = this.tracks[ti]!;
      if (!trackTaken[ti]) {
        if (t - tr.lastSeenMs > this.maxCoastMs) continue; // dead
        const pred = predictions[ti]!;
        tr.u = pred.u;
        tr.v = pred.v;
        tr.lastStepMs = t;
        tr.record(false, pred.u, pred.v, 0, meta);
      }
      survivors.push(tr);
    }

    // Unmatched blobs found new tracks.
    for (let bi = 0; bi < blobs.length; bi++) {
      if (!blobTaken[bi]) survivors.push(new Track(blobs[bi]!, meta));
    }

    this.tracks = survivors;
    this.lastAssignment = assignment;
    return matched;
  }
}
