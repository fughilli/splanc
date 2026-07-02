/**
 * M6 track stage: maintain stable identities for blobs across frames so a
 * whole temporal-code cycle can be attributed to one physical LED (§8.1
 * decode note — this is the correspondence the code itself can't provide).
 *
 * Nearest-neighbor matching against constant-velocity predictions. The
 * defining requirement: a track must SURVIVE the frames where its LED is off
 * (its 0-bits and the ALL_OFF sync frame) — so unmatched tracks "coast" on
 * their predicted position, recording an `on: false` sample, and are only
 * killed after `maxCoastMs` without a real match (default ≳ one full cycle
 * plus slack, so an LED that is dark for most of its code word survives).
 */

import type { Blob, FrameMeta } from "./types";

export interface TrackSample {
  tCaptureMs: number;
  /** Matched this frame (LED visibly on at this track's position). */
  on: boolean;
  /** Position: measured when on, predicted while coasting. */
  u: number;
  v: number;
  intensity: number;
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

  constructor(blob: Blob, meta: FrameMeta) {
    this.u = blob.u;
    this.v = blob.v;
    this.lastSeenMs = meta.tCaptureMs;
    this.lastStepMs = meta.tCaptureMs;
    this.record(true, blob.u, blob.v, blob.intensity, meta);
  }

  predict(tMs: number): { u: number; v: number } {
    const dt = tMs - this.lastStepMs;
    return { u: this.u + this.velU * dt, v: this.v + this.velV * dt };
  }

  record(on: boolean, u: number, v: number, intensity: number, meta: FrameMeta): void {
    this.samples.push({ tCaptureMs: meta.tCaptureMs, on, u, v, intensity, meta });
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
  tracks: Track[] = [];

  constructor(opts: TrackerOptions = {}) {
    this.gatePx = opts.gatePx ?? 60;
    this.maxCoastMs = opts.maxCoastMs ?? 2500;
    this.velocityBlend = opts.velocityBlend ?? 0.3;
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
    const predictions = this.tracks.map((tr) => tr.predict(t));
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
    let matched = 0;
    for (const c of cands) {
      if (trackTaken[c.ti] || blobTaken[c.bi]) continue;
      trackTaken[c.ti] = 1;
      blobTaken[c.bi] = 1;
      matched++;
      const tr = this.tracks[c.ti]!;
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
      tr.record(true, b.u, b.v, b.intensity, meta);
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
    return matched;
  }
}
