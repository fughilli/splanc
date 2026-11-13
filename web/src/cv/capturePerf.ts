/**
 * Performance counters for the capture hot loop and the live solver (FUG-112).
 *
 * The phone runs two CPU-heavy things at once during a capture: the per-frame
 * camera loop on the main thread (detect → decode → overlay), and — against an
 * embedded player — interim wasm solves in the solver worker. The live solve
 * must never slow the capture, and on a phone the two share cores, thermal
 * budget and (for upload/apply) the main thread itself. These counters make
 * that sharing visible:
 *
 *  - every frame's main-thread cost, split into phases, and the camera's frame
 *    interval and dropped frames — each kept SEPARATELY for frames that arrived
 *    while a live solve was running vs while the solver was idle, so the cost
 *    of solving shows up as the difference between the two;
 *  - every solve's queue wait, main-thread upload (postMessage clone), worker
 *    compute (serialize / wasm / parse), and main-thread apply, plus the duty
 *    cycle actually achieved;
 *  - `throughputRatio()`: camera AND IMU throughput during one solve relative
 *    to the idle baseline (the worse of the two) — what LiveSolveScheduler
 *    backs off on. The IMU counts because DeviceMotion events share the main
 *    thread with everything else, and a starved IMU starves the solver's only
 *    measure of metric scale.
 *
 * Pure apart from the injected clock — unit-tested.
 */

/** Rolling window of the last `cap` samples (frames or solves). */
export class RollingStat {
  private readonly buf: number[] = [];
  private next = 0;

  constructor(private readonly cap = 240) {}

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    if (this.buf.length < this.cap) this.buf.push(v);
    else this.buf[this.next] = v;
    this.next = (this.next + 1) % this.cap;
  }

  get count(): number {
    return this.buf.length;
  }

  mean(): number | null {
    if (this.buf.length === 0) return null;
    let s = 0;
    for (const v of this.buf) s += v;
    return s / this.buf.length;
  }

  /** Nearest-rank quantile, q in [0,1]. */
  quantile(q: number): number | null {
    if (this.buf.length === 0) return null;
    const s = [...this.buf].sort((a, b) => a - b);
    const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
    return s[i]!;
  }

  max(): number | null {
    return this.buf.length === 0 ? null : Math.max(...this.buf);
  }
}

/** One frame's main-thread work, ms. `prepMs` is the capture source's own
 * per-frame work before the callback (texture upload / native unpack). */
export interface FrameTiming {
  tCaptureMs: number;
  /** Camera frame sequence number when the source has one (rVFC
   * presentedFrames); gaps count as dropped frames exactly. Otherwise drops
   * are estimated from capture-time gaps. */
  seq?: number | undefined;
  prepMs?: number | undefined;
  /** Capture instant → start of the frame handler. Grows when the main thread
   * can't keep up and frames back up in the event queue (the native bridge
   * queues rather than drops). */
  latencyMs?: number | undefined;
  detectMs: number;
  decodeMs: number;
  overlayMs: number;
  totalMs: number;
}

/** Per-solve costs, ms. Worker fields are null when the worker didn't report
 * them (an older solver deployment). */
export interface SolveTiming {
  records: number;
  /** Records actually shipped to the worker for this solve (the delta). */
  uploadedRecords: number;
  queueMs: number;
  /** Main thread: building + postMessage (structured clone) of the request. */
  postMs: number;
  /** Post → result received on the main thread. */
  roundTripMs: number;
  workerSerializeMs: number | null;
  workerSolveMs: number | null;
  workerParseMs: number | null;
  /** Main thread: folding the result into the overlay (union, upload to GL). */
  applyMs: number;
  ok: boolean;
}

interface LoopStats {
  frames: number;
  dropped: number;
  interval: RollingStat;
  total: RollingStat;
  detect: RollingStat;
  decode: RollingStat;
  overlay: RollingStat;
  prep: RollingStat;
  latency: RollingStat;
}

function loopStats(): LoopStats {
  return {
    frames: 0,
    dropped: 0,
    interval: new RollingStat(),
    total: new RollingStat(),
    detect: new RollingStat(),
    decode: new RollingStat(),
    overlay: new RollingStat(),
    prep: new RollingStat(),
    latency: new RollingStat(),
  };
}

export interface LoopSnapshot {
  frames: number;
  dropped: number;
  fps: number | null;
  totalMsP50: number | null;
  totalMsP95: number | null;
  totalMsMax: number | null;
  detectMsP95: number | null;
  decodeMsP95: number | null;
  overlayMsP95: number | null;
  prepMsP95: number | null;
  latencyMsP95: number | null;
}

export interface CapturePerfSnapshot {
  elapsedMs: number;
  idle: LoopSnapshot;
  solving: LoopSnapshot;
  solves: number;
  solveFailures: number;
  /** Fraction of capture wall time with a live solve in flight. */
  solveDuty: number;
  lastSolve: SolveTiming | null;
  solveRoundTripMsP95: number | null;
  solveWorkerMsP95: number | null;
  /** Main-thread ms per solve (post + apply), p95: the solver's direct
   * hot-loop cost. */
  solveMainThreadMsP95: number | null;
  /** Last solve's throughput vs the idle baseline (1 = no slowdown): the
   * worse of camera and IMU. */
  lastThroughputRatio: number | null;
  /** IMU sample rate (Hz) with the solver idle / while a solve ran, and the
   * share of capture time inside gaps over 100 ms (dropped DeviceMotion). */
  imu: { idleHz: number | null; solvingHz: number | null; gapFrac: number; samples: number };
}

function snapLoop(s: LoopStats): LoopSnapshot {
  const iv = s.interval.quantile(0.5);
  return {
    frames: s.frames,
    dropped: s.dropped,
    fps: iv !== null && iv > 0 ? 1000 / iv : null,
    totalMsP50: s.total.quantile(0.5),
    totalMsP95: s.total.quantile(0.95),
    totalMsMax: s.total.max(),
    detectMsP95: s.detect.quantile(0.95),
    decodeMsP95: s.decode.quantile(0.95),
    overlayMsP95: s.overlay.quantile(0.95),
    prepMsP95: s.prep.quantile(0.95),
    latencyMsP95: s.latency.quantile(0.95),
  };
}

/** An IMU gap longer than this is a dropped stretch of DeviceMotion events. */
const IMU_GAP_MS = 100;

function hz(dt: RollingStat): number | null {
  const m = dt.count >= 5 ? dt.quantile(0.5) : null;
  return m !== null && m > 0 ? 1000 / m : null;
}

/** A capture-time gap this many times the nominal interval counts as drops. */
const DROP_GAP_FACTOR = 1.5;

export class CapturePerf {
  private readonly idle = loopStats();
  private readonly solving = loopStats();
  private readonly startMs: number;
  private lastT: number | null = null;
  private lastSeq: number | null = null;
  // Solve accounting.
  private inFlightSince: number | null = null;
  private busyMs = 0;
  private solveFrames = 0;
  private solveDropped = 0;
  private solves = 0;
  private solveFailures = 0;
  private lastSolve: SolveTiming | null = null;
  private lastRatio: number | null = null;
  // IMU accounting.
  private lastImuT: number | null = null;
  private readonly imuIdleDt = new RollingStat(256);
  private readonly imuSolvingDt = new RollingStat(256);
  private imuSamples = 0;
  private imuGapMs = 0;
  private imuFirstT: number | null = null;
  private solveImu = 0;
  private readonly roundTrip = new RollingStat(64);
  private readonly workerMs = new RollingStat(64);
  private readonly mainMs = new RollingStat(64);

  constructor(private readonly now: () => number = () => performance.now()) {
    this.startMs = now();
  }

  /** Whether a live solve is running now (frames are attributed to it). */
  get solveInFlight(): boolean {
    return this.inFlightSince !== null;
  }

  /** Record one delivered frame. */
  frame(f: FrameTiming): void {
    const s = this.inFlightSince !== null ? this.solving : this.idle;
    s.frames++;
    let dropped = 0;
    if (this.lastT !== null) {
      const dt = f.tCaptureMs - this.lastT;
      if (dt > 0) {
        if (f.seq !== undefined && this.lastSeq !== null) {
          dropped = Math.max(0, f.seq - this.lastSeq - 1);
          // Per-frame interval: spread a gap over the frames it spans.
          s.interval.push(dt / (dropped + 1));
        } else {
          const nominal = this.nominalIntervalMs();
          if (nominal !== null && dt > DROP_GAP_FACTOR * nominal) {
            dropped = Math.max(0, Math.round(dt / nominal) - 1);
          }
          // A gap with drops says nothing about the camera's frame rate.
          if (dropped === 0) s.interval.push(dt);
        }
      }
    }
    this.lastT = f.tCaptureMs;
    this.lastSeq = f.seq ?? null;
    s.dropped += dropped;
    s.total.push(f.totalMs);
    s.detect.push(f.detectMs);
    s.decode.push(f.decodeMs);
    s.overlay.push(f.overlayMs);
    if (f.prepMs !== undefined) s.prep.push(f.prepMs);
    if (f.latencyMs !== undefined) s.latency.push(f.latencyMs);
    if (this.inFlightSince !== null) {
      this.solveFrames += 1 + dropped;
      this.solveDropped += dropped;
    }
  }

  /** Record one IMU sample (its event time, ms). */
  imuSample(tMs: number): void {
    this.imuSamples++;
    if (this.imuFirstT === null) this.imuFirstT = tMs;
    if (this.lastImuT !== null) {
      const dt = tMs - this.lastImuT;
      if (dt > 0) {
        (this.inFlightSince !== null ? this.imuSolvingDt : this.imuIdleDt).push(dt);
        if (dt > IMU_GAP_MS) this.imuGapMs += dt;
      }
    }
    this.lastImuT = tMs;
    if (this.inFlightSince !== null) this.solveImu++;
  }

  /** Median frame interval with the solver idle (falls back to all frames). */
  private nominalIntervalMs(): number | null {
    return this.idle.interval.count >= 5 ? this.idle.interval.quantile(0.5) : this.solving.interval.quantile(0.5);
  }

  /** A live solve was posted to the worker. */
  solveBegin(): void {
    if (this.inFlightSince !== null) return;
    this.inFlightSince = this.now();
    this.solveFrames = 0;
    this.solveDropped = 0;
    this.solveImu = 0;
  }

  /**
   * The live solve finished (ok or not). Returns the camera throughput during
   * it relative to the idle baseline: delivered frames / expected frames,
   * where expected counts the drops too, so 1 = no frames lost and 0.8 = a
   * fifth of the camera frames were lost while it ran. Null without a baseline
   * or with too few frames to tell.
   */
  solveEnd(t: SolveTiming): number | null {
    const since = this.inFlightSince;
    this.inFlightSince = null;
    const solveMs = since !== null ? this.now() - since : 0;
    if (since !== null) this.busyMs += solveMs;
    this.solves++;
    if (!t.ok) this.solveFailures++;
    this.lastSolve = t;
    this.roundTrip.push(t.roundTripMs);
    if (t.workerSolveMs !== null) {
      this.workerMs.push((t.workerSerializeMs ?? 0) + t.workerSolveMs + (t.workerParseMs ?? 0));
    }
    this.mainMs.push(t.postMs + t.applyMs);
    const expected = this.solveFrames;
    const camera = expected >= 4 ? (expected - this.solveDropped) / expected : null;
    // IMU: samples received during the solve vs the idle rate's expectation.
    const idleDt = this.imuIdleDt.count >= 20 ? this.imuIdleDt.quantile(0.5) : null;
    const imuExpected = idleDt !== null && idleDt > 0 ? solveMs / idleDt : 0;
    const imu = imuExpected >= 10 ? Math.min(1, this.solveImu / imuExpected) : null;
    this.lastRatio = camera === null ? imu : imu === null ? camera : Math.min(camera, imu);
    return this.lastRatio;
  }

  snapshot(): CapturePerfSnapshot {
    const now = this.now();
    const elapsed = Math.max(1, now - this.startMs);
    const busy = this.busyMs + (this.inFlightSince !== null ? now - this.inFlightSince : 0);
    return {
      elapsedMs: elapsed,
      idle: snapLoop(this.idle),
      solving: snapLoop(this.solving),
      solves: this.solves,
      solveFailures: this.solveFailures,
      solveDuty: busy / elapsed,
      lastSolve: this.lastSolve,
      solveRoundTripMsP95: this.roundTrip.quantile(0.95),
      solveWorkerMsP95: this.workerMs.quantile(0.95),
      solveMainThreadMsP95: this.mainMs.quantile(0.95),
      lastThroughputRatio: this.lastRatio,
      imu: {
        idleHz: hz(this.imuIdleDt),
        solvingHz: hz(this.imuSolvingDt),
        gapFrac:
          this.imuFirstT !== null && this.lastImuT !== null && this.lastImuT > this.imuFirstT
            ? this.imuGapMs / (this.lastImuT - this.imuFirstT)
            : 0,
        samples: this.imuSamples,
      },
    };
  }
}

const f0 = (x: number | null): string => (x === null ? "–" : x.toFixed(0));
const f1 = (x: number | null): string => (x === null ? "–" : x.toFixed(1));

/** One compact line for the HUD / device console. */
export function formatPerfLine(s: CapturePerfSnapshot): string {
  const loop = (name: string, l: LoopSnapshot): string =>
    `${name} ${f1(l.fps)}fps p95 ${f1(l.totalMsP95)}ms drop ${l.dropped}/${l.frames + l.dropped}`;
  let line = `perf ${loop("idle", s.idle)}`;
  if (s.solves > 0 || s.solving.frames > 0) {
    line += ` | solving ${loop("", s.solving).trimStart()}`;
    const ls = s.lastSolve;
    line +=
      ` | solve n=${s.solves} duty ${Math.round(s.solveDuty * 100)}%` +
      (ls
        ? ` last ${f0(ls.roundTripMs)}ms (wasm ${f0(ls.workerSolveMs)} post ${f1(ls.postMs)} ` +
          `apply ${f1(ls.applyMs)}) ${ls.records}rec`
        : "") +
      (s.lastThroughputRatio !== null ? ` thr ${Math.round(s.lastThroughputRatio * 100)}%` : "");
  }
  // The IMU is the solve's only measure of metric scale: show when it starves.
  if (s.imu.samples > 0) {
    line += ` | imu ${f0(s.imu.idleHz)}Hz` + (s.imu.solvingHz !== null ? `/${f0(s.imu.solvingHz)}Hz` : "");
    if (s.imu.gapFrac >= 0.01) line += ` gaps ${Math.round(s.imu.gapFrac * 100)}%`;
  }
  return line;
}

/** Phase breakdown for the console (p95 ms, idle vs solving). */
export function formatPhaseLine(s: CapturePerfSnapshot): string {
  const ph = (l: LoopSnapshot): string =>
    `prep ${f1(l.prepMsP95)} detect ${f1(l.detectMsP95)} decode ${f1(l.decodeMsP95)} ` +
    `overlay ${f1(l.overlayMsP95)} max ${f1(l.totalMsMax)} latency ${f1(l.latencyMsP95)}`;
  return `phases p95 idle[${ph(s.idle)}] solving[${ph(s.solving)}] solveMain p95 ${f1(s.solveMainThreadMsP95)}ms`;
}
