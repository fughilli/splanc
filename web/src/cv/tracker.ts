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

import type { DetectionRecord, Vec3 } from "@ledmapper/protocol";
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
   * hue decoder classifies symbols from these. */
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
  /**
   * Adaptive gate: a blob is only matched within this fraction of ITS
   * nearest-neighbour distance in the frame (capped by `gatePx`). On dense
   * fixtures (LEDs ~13 px apart) a fixed 40 px gate reached ~3 neighbours, so
   * a track grabbed the LED next door whenever the phone moved. 0 disables.
   */
  gateSpacingFrac?: number;
  /** Floor for the adaptive gate (detector centroid noise). */
  minGatePx?: number;
  /**
   * Ambiguity rejection: a match is refused when another blob is nearly as
   * close to the track's prediction (best ≥ ratio × second-best). The track
   * coasts instead of guessing — a coin-flip match is how a wrong id lands on
   * a neighbour's position. 1 disables.
   */
  ambiguityRatio?: number;
  /**
   * Global image-motion compensation: estimate the frame's common 2D shift
   * (the camera turning moves every LED together) by voting over
   * prediction→blob offsets, and add it to every prediction. Handles motion
   * the per-track constant-velocity model can't — a jerk or a change of
   * direction — so the adaptive gate can be tight without losing tracks.
   */
  globalMotion?: boolean;
  /**
   * Local consistency: refuse a match whose residual differs from the median
   * of its neighbours' (within a few pitches) by more than this fraction of
   * the LED spacing. 0 disables.
   */
  localConsistencyFrac?: number;
}

/** Per-frame association telemetry (capture guidance, perf HUD). */
export interface TrackerFrameStats {
  /** Median blob nearest-neighbour distance this frame (px), null if < 2 blobs. */
  spacingPx: number | null;
  /** Global shift applied on top of the per-track predictions (px): the
   * image motion the tracks did NOT predict. */
  shiftPx: number;
  /** Established tracks (seen in the previous frame) considered this frame. */
  live: number;
  /** Of those, matched to a blob. */
  matched: number;
  /** Of those, refused as ambiguous. */
  ambiguous: number;
  /** Matches refused by the local-consistency check (a hop to a neighbour). */
  inconsistent: number;
}

let nextTrackId = 1;

/** A global shift must out-vote the zero shift by this factor (see estimateShift). */
const SHIFT_MARGIN = 1.5;
/** Local-consistency neighbourhood: radius in LED pitches, and the fewest
 * matched neighbours that make a verdict. */
const LOCAL_RADIUS_PITCHES = 3;
const LOCAL_MIN_NEIGHBOURS = 4;

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
  /** The id this track's most recent decodes agree on, and how many in a row
   * (the decoder's confirmation; `ledId` is only set once confirmed). */
  pendingId: number | null = null;
  pendingCount = 0;
  /** Records made while `pendingId` awaited confirmation: released once it
   * is confirmed, discarded if a disagreeing decode replaces it. */
  held: DetectionRecord[] = [];
  /** The same for the pipeline's dense (per-frame) records. */
  heldDense: DetectionRecord[] = [];

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
  private readonly gateSpacingFrac: number;
  private readonly minGatePx: number;
  private readonly ambiguityRatio: number;
  private readonly globalMotion: boolean;
  private readonly localConsistencyFrac: number;
  private solved: Map<number, Vec3> | null = null;
  /** Capture time of the previous step (common-velocity bookkeeping). */
  private prevT: number | null = null;
  tracks: Track[] = [];
  /**
   * Per-blob association from the most recent step, aligned with that step's
   * blobs array: the pre-existing track the blob matched (whose prediction —
   * reprojected when identified+solved — gated it in), or null when the blob
   * matched nothing and spawned a fresh track. UI feedback for the 2D stage.
   */
  lastAssignment: (Track | null)[] = [];
  /** Association telemetry for the most recent step. */
  lastStats: TrackerFrameStats = { spacingPx: null, shiftPx: 0, live: 0, matched: 0, ambiguous: 0, inconsistent: 0 };

  constructor(opts: TrackerOptions = {}) {
    // 60 px was ~3× the observed inter-LED spacing (median 22 px, p90 34 px in
    // the 2026-07-17 64/64 trace), so a coasting track could grab a neighbour's
    // blob when its own merged away — the "gap" failure. The gate sits around
    // the velocity PREDICTION, so it only needs to cover prediction error, not
    // full motion; 40 px comfortably does that while no longer reaching past
    // the immediate neighbour. Conservative interim value — see
    // docs/blob-detection-playbook.md; the fuller fix is hue in the association
    // cost, tuned against captured frames.
    this.gatePx = opts.gatePx ?? 40;
    this.maxCoastMs = opts.maxCoastMs ?? 2500;
    this.velocityBlend = opts.velocityBlend ?? 0.3;
    this.gateSpacingFrac = opts.gateSpacingFrac ?? 0.6;
    this.minGatePx = opts.minGatePx ?? 3;
    this.ambiguityRatio = opts.ambiguityRatio ?? 0.7;
    this.globalMotion = opts.globalMotion ?? true;
    this.localConsistencyFrac = opts.localConsistencyFrac ?? 0.45;
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

  /** Pose-aware prediction when identified + solved + posed; constant
   * velocity otherwise (incl. the pose-less WebXR-free capture path). */
  private predictTrack(tr: Track, meta: FrameMeta, common: { u: number; v: number } | null): { u: number; v: number } {
    if (tr.ledId !== null && this.solved !== null && meta.pose !== null) {
      const xyz = this.solved.get(tr.ledId);
      if (xyz !== undefined) {
        const pr = project(meta.pose, meta.K, xyz);
        if (pr.depth > 0) return { u: pr.u, v: pr.v };
      }
    }
    if (common !== null) {
      const dt = meta.tCaptureMs - tr.lastStepMs;
      return { u: tr.u + common.u * dt, v: tr.v + common.v * dt };
    }
    return tr.predict(meta.tCaptureMs);
  }

  /**
   * The image's common velocity (px/ms): the median over tracks matched in
   * the previous frame. With global motion on, every track is predicted with
   * it rather than its own: one track's velocity is a noisy EMA that goes
   * stale while it coasts, and a stale prediction drifting toward a
   * neighbour is exactly how a track whose blob dropped out grabs the LED
   * next door. Null without enough tracks to agree on.
   */
  private commonVelocity(): { u: number; v: number } | null {
    if (!this.globalMotion || this.prevT === null) return null;
    const us: number[] = [];
    const vs: number[] = [];
    for (const tr of this.tracks) {
      if (tr.lastSeenMs !== this.prevT || tr.samples.length < 2) continue;
      us.push(tr.velU);
      vs.push(tr.velV);
    }
    if (us.length < 3) return null;
    return { u: median(us)!, v: median(vs)! };
  }

  /** Ingest one frame's blobs. Returns the number of matched tracks. */
  step(blobs: readonly Blob[], meta: FrameMeta): number {
    const t = meta.tCaptureMs;
    const nT = this.tracks.length;
    const nB = blobs.length;
    const grid = new BlobGrid(blobs, Math.max(8, this.gatePx));

    // Local spacing: each blob's nearest-neighbour distance this frame.
    const nn = new Float64Array(nB).fill(Infinity);
    for (let bi = 0; bi < nB; bi++) {
      const b = blobs[bi]!;
      grid.forNear(b.u, b.v, (bj, d2) => {
        if (bj !== bi && d2 < nn[bi]! * nn[bi]!) nn[bi] = Math.sqrt(d2);
      });
    }
    const spacingPx = median(Array.from(nn).filter(Number.isFinite));
    const gateFor = (bi: number): number => {
      if (this.gateSpacingFrac <= 0 || !Number.isFinite(nn[bi]!)) return this.gatePx;
      return Math.min(this.gatePx, Math.max(this.minGatePx, this.gateSpacingFrac * nn[bi]!));
    };

    const common = this.commonVelocity();
    const predictions = this.tracks.map((tr) => this.predictTrack(tr, meta, common));
    const shift = this.globalMotion ? this.estimateShift(predictions, blobs, grid, spacingPx) : { du: 0, dv: 0 };
    for (const p of predictions) {
      p.u += shift.du;
      p.v += shift.dv;
    }

    // All candidate (track, blob) pairs within the (per-blob) gate,
    // best-first greedy — minus tracks whose best match is ambiguous.
    interface Cand {
      d2: number;
      ti: number;
      bi: number;
    }
    const cands: Cand[] = [];
    const ambiguousTrack = new Uint8Array(nT);
    const contested = new Uint8Array(nB);
    for (let ti = 0; ti < nT; ti++) {
      const pred = predictions[ti]!;
      let best = Infinity;
      let second = Infinity;
      let bestBi = -1;
      grid.forNear(pred.u, pred.v, (bi, d2) => {
        if (d2 < best) {
          second = best;
          best = d2;
          bestBi = bi;
        } else if (d2 < second) second = d2;
      });
      if (bestBi < 0) continue;
      const g = gateFor(bestBi);
      if (best > g * g) continue;
      // Squared distances: best ≥ ratio² × second ⇔ dist ≥ ratio × dist.
      if (this.ambiguityRatio < 1 && best >= this.ambiguityRatio * this.ambiguityRatio * second) {
        ambiguousTrack[ti] = 1;
        // Neither candidate may found a duplicate track while this one is
        // undecided: it is (one of) them.
        grid.forNear(pred.u, pred.v, (bi, d2) => {
          if (d2 <= second) contested[bi] = 1;
        });
        continue;
      }
      cands.push({ d2: best, ti, bi: bestBi });
      // Lower-ranked alternatives stay eligible for when the best is taken.
      grid.forNear(pred.u, pred.v, (bi, d2) => {
        if (bi === bestBi) return;
        const gb = gateFor(bi);
        if (d2 <= gb * gb) cands.push({ d2, ti, bi });
      });
    }
    cands.sort((a, b) => a.d2 - b.d2);

    const trackTaken = new Uint8Array(nT);
    const blobTaken = new Uint8Array(nB);
    const pairBlob = new Int32Array(nT).fill(-1);
    for (const c of cands) {
      if (trackTaken[c.ti] || blobTaken[c.bi]) continue;
      trackTaken[c.ti] = 1;
      blobTaken[c.bi] = 1;
      pairBlob[c.ti] = c.bi;
    }

    // Local consistency: neighbouring LEDs move together (one rigid fixture,
    // one camera), so a match whose residual disagrees with its neighbours'
    // by a good fraction of a pitch is a track that hopped onto the LED next
    // door. Refuse it: the track coasts on its neighbours' correction, which
    // is also what re-aims unmatched tracks under motion the global shift
    // can't express (roll, parallax between faces at different depths).
    const localCorr: ({ u: number; v: number } | null)[] = new Array(nT).fill(null);
    let inconsistent = 0;
    if (this.localConsistencyFrac > 0 && spacingPx !== null) {
      const radius = LOCAL_RADIUS_PITCHES * spacingPx;
      const at: Blob[] = [];
      const atTi: number[] = [];
      for (let ti = 0; ti < nT; ti++) {
        if (pairBlob[ti]! < 0) continue;
        at.push({ u: predictions[ti]!.u, v: predictions[ti]!.v, intensity: 0, area: 0 });
        atTi.push(ti);
      }
      const near = new BlobGrid(at, Math.max(8, radius));
      const resU = (ti: number): number => blobs[pairBlob[ti]!]!.u - predictions[ti]!.u;
      const resV = (ti: number): number => blobs[pairBlob[ti]!]!.v - predictions[ti]!.v;
      const neighbourhood = (ti: number): { u: number; v: number } | null => {
        const p = predictions[ti]!;
        const us: number[] = [];
        const vs: number[] = [];
        near.forNear(p.u, p.v, (k, d2) => {
          const tj = atTi[k]!;
          if (tj === ti || d2 > radius * radius) return;
          us.push(resU(tj));
          vs.push(resV(tj));
        });
        return us.length >= LOCAL_MIN_NEIGHBOURS ? { u: median(us)!, v: median(vs)! } : null;
      };
      const limit = this.localConsistencyFrac * spacingPx;
      const refused: number[] = [];
      for (let ti = 0; ti < nT; ti++) {
        const m = neighbourhood(ti);
        localCorr[ti] = m;
        if (m === null || pairBlob[ti]! < 0) continue;
        if (Math.hypot(resU(ti) - m.u, resV(ti) - m.v) > limit) refused.push(ti);
      }
      // Refuse after scoring every track, so one refusal can't change the
      // neighbourhood another was judged against.
      for (const ti of refused) {
        const bi = pairBlob[ti]!;
        pairBlob[ti] = -1;
        trackTaken[ti] = 0;
        blobTaken[bi] = 0;
        contested[bi] = 1;
        inconsistent++;
      }
    }

    const assignment: (Track | null)[] = new Array(nB).fill(null);
    let matched = 0;
    for (let ti = 0; ti < nT; ti++) {
      const bi = pairBlob[ti]!;
      if (bi < 0) continue;
      matched++;
      const tr = this.tracks[ti]!;
      assignment[bi] = tr;
      const b = blobs[bi]!;
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

    // Unmatched tracks coast on their prediction (plus their neighbours'
    // correction, when they have one); stale ones die.
    const survivors: Track[] = [];
    for (let ti = 0; ti < nT; ti++) {
      const tr = this.tracks[ti]!;
      if (!trackTaken[ti]) {
        if (t - tr.lastSeenMs > this.maxCoastMs) continue; // dead
        const pred = predictions[ti]!;
        const corr = localCorr[ti];
        if (corr != null) {
          pred.u += corr.u;
          pred.v += corr.v;
        }
        tr.u = pred.u;
        tr.v = pred.v;
        tr.lastStepMs = t;
        tr.record(false, pred.u, pred.v, 0, meta);
      }
      survivors.push(tr);
    }

    // Unmatched blobs found new tracks — except where an established track
    // went unmatched within a pitch of it this frame: that blob is most
    // likely the track's own LED after a jump the prediction missed. A
    // duplicate founded there would split the LED's code cycle between two
    // tracks (neither decodes) and compete with the original for identity;
    // left alone, the original re-acquires once the motion settles.
    const claimR = spacingPx ?? this.gatePx;
    const orphans = new BlobGrid(
      this.tracks.length === 0
        ? []
        : predictions.filter((_, ti) => !trackTaken[ti] && this.tracks[ti]!.samples.length >= 2).map((p) => ({ u: p.u, v: p.v, intensity: 0, area: 0 })),
      Math.max(8, claimR),
    );
    for (let bi = 0; bi < blobs.length; bi++) {
      if (blobTaken[bi] || contested[bi]) continue;
      let claimed = false;
      orphans.forNear(blobs[bi]!.u, blobs[bi]!.v, (_, d2) => {
        if (d2 <= claimR * claimR) claimed = true;
      });
      if (!claimed) survivors.push(new Track(blobs[bi]!, meta));
    }

    let live = 0;
    let liveMatched = 0;
    let liveAmbiguous = 0;
    for (let ti = 0; ti < nT; ti++) {
      const tr = this.tracks[ti]!;
      if (tr.samples.length < 2) continue; // founded last frame: no history yet
      live++;
      if (trackTaken[ti]) liveMatched++;
      else if (ambiguousTrack[ti]) liveAmbiguous++;
    }
    this.tracks = survivors;
    this.lastAssignment = assignment;
    this.prevT = t;
    this.lastStats = {
      spacingPx,
      shiftPx: Math.hypot(shift.du, shift.dv),
      live,
      matched: liveMatched,
      ambiguous: liveAmbiguous,
      inconsistent,
    };
    return matched;
  }

  /**
   * The frame's common image shift relative to the per-track predictions:
   * every (prediction, nearby blob) offset votes in a 2D histogram whose bins
   * are a fraction of the LED spacing; the fullest bin (ties: the smaller
   * shift — on a periodic grid a one-pitch shift scores as well as the
   * truth) is refined by its members' mean. Needs a quorum, else no shift.
   */
  private estimateShift(
    predictions: readonly { u: number; v: number }[],
    blobs: readonly Blob[],
    grid: BlobGrid,
    spacingPx: number | null,
  ): { du: number; dv: number } {
    const none = { du: 0, dv: 0 };
    if (predictions.length < 3 || blobs.length < 3 || spacingPx === null) return none;
    // Offsets from each prediction to every blob near it. The true shift is
    // one tight cluster (every track agrees); offsets to NEIGHBOURS scatter
    // over ~a pitch in every direction, so they form no comparable peak.
    const r2 = this.gatePx * this.gatePx;
    const offs: number[] = [];
    for (const p of predictions) {
      grid.forNear(p.u, p.v, (bi, d2) => {
        if (d2 > r2) return;
        offs.push(blobs[bi]!.u - p.u, blobs[bi]!.v - p.v);
      });
    }
    const bin = Math.max(1, 0.25 * spacingPx);
    const votes = new Map<number, number>();
    const key = (i: number, j: number): number => (i + 4096) * 8192 + (j + 4096);
    for (let k = 0; k < offs.length; k += 2) {
      const kk = key(Math.round(offs[k]! / bin), Math.round(offs[k + 1]! / bin));
      votes.set(kk, (votes.get(kk) ?? 0) + 1);
    }
    let bestK = key(0, 0);
    let bestN = votes.get(bestK) ?? 0;
    for (const [k, n] of votes) {
      if (n > bestN) {
        bestN = n;
        bestK = k;
      }
    }
    // Mean-shift from the peak: average the offsets within a third of a
    // pitch, twice — sub-bin accuracy, and immune to the bin grid.
    let du = (Math.floor(bestK / 8192) - 4096) * bin;
    let dv = ((bestK % 8192) - 4096) * bin;
    const near2 = (spacingPx / 3) ** 2;
    const support = (cu: number, cv: number): { n: number; su: number; sv: number } => {
      let n = 0;
      let su = 0;
      let sv = 0;
      for (let k = 0; k < offs.length; k += 2) {
        const a = offs[k]! - cu;
        const b = offs[k + 1]! - cv;
        if (a * a + b * b <= near2) {
          n++;
          su += offs[k]!;
          sv += offs[k + 1]!;
        }
      }
      return { n, su, sv };
    };
    let sup = support(du, dv);
    for (let it = 0; it < 2 && sup.n > 0; it++) {
      du = sup.su / sup.n;
      dv = sup.sv / sup.n;
      sup = support(du, dv);
    }
    const quorum = Math.max(3, 0.3 * Math.min(predictions.length, blobs.length));
    if (sup.n < quorum) return none;
    // The tracks' own predictions are the prior: a shift of half a pitch or
    // more must CLEARLY out-vote "no extra shift". On a periodic layout (a
    // strip, a ring) a one-pitch shift scores within a few votes of the
    // truth, and adopting it would move every track onto its neighbour at
    // once. Smaller shifts can't alias onto a neighbour.
    if (Math.hypot(du, dv) >= 0.5 * spacingPx && sup.n < SHIFT_MARGIN * support(0, 0).n) return none;
    return { du, dv };
  }

}

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  xs.sort((a, b) => a - b);
  const m = xs.length >> 1;
  return xs.length % 2 ? xs[m]! : (xs[m - 1]! + xs[m]!) / 2;
}

/** Uniform-grid spatial index over one frame's blobs: radius queries in O(k). */
class BlobGrid {
  private readonly cells = new Map<number, number[]>();
  constructor(
    private readonly blobs: readonly Blob[],
    private readonly cell: number,
  ) {
    for (let i = 0; i < blobs.length; i++) {
      const k = this.key(Math.floor(blobs[i]!.u / cell), Math.floor(blobs[i]!.v / cell));
      const c = this.cells.get(k);
      if (c === undefined) this.cells.set(k, [i]);
      else c.push(i);
    }
  }
  private key(i: number, j: number): number {
    return (i + 32768) * 65536 + (j + 32768);
  }
  /** Visit every blob within one cell (≥ the radius it was built for) of (u, v). */
  forNear(u: number, v: number, fn: (bi: number, d2: number) => void): void {
    const ci = Math.floor(u / this.cell);
    const cj = Math.floor(v / this.cell);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        const c = this.cells.get(this.key(i, j));
        if (c === undefined) continue;
        for (const bi of c) {
          const b = this.blobs[bi]!;
          const du = b.u - u;
          const dv = b.v - v;
          fn(bi, du * du + dv * dv);
        }
      }
    }
  }
}
