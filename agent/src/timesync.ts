/**
 * The bridge half of the shared time base (docs/design/agent-multi-fixture.md §3).
 * Effects animate on device time, so the same effect on two players drifts apart.
 * The hub estimates each player's clock offset with the protocol's
 * TimeSyncPing/Pong (min-RTT sample of a few rounds — LedMapperClient.syncClock),
 * picks ONE room epoch on its own monotonic clock and hands each player that epoch
 * in the player's clock domain (SetTimeBase, when the firmware advertises
 * `time_base`). The residual skew between two players is bounded by half their
 * sync round trips — at that moment. Crystals drift tens of ppm apart, so the hub
 * then keeps each one there with {@link TimeDiscipline} (below; synced-show.md).
 */

export interface ClockSync {
  /** Add to a hub time (performance.now(), ms) to get the player's time (millis()). */
  offsetMs: number;
  rttMs: number;
  /** When it was measured (hub ms). */
  at: number;
  /** A drift-model prediction ({@link TimeDiscipline.clockFor}), not a measurement. */
  model?: true;
}

/** The room epoch in each player's clock: hubEpoch + that player's offset. */
export function deviceEpochs(hubEpochMs: number, syncs: Map<string, ClockSync>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [id, s] of syncs) out.set(id, Math.round(hubEpochMs + s.offsetMs));
  return out;
}

/** Worst-case skew (ms) between any two of these players after a time-base set:
 * each offset is uncertain by up to half its round trip. */
export function skewBoundMs(syncs: Iterable<ClockSync>): number {
  const halves = [...syncs].map((s) => Math.max(0, s.rttMs) / 2).sort((a, b) => b - a);
  if (halves.length < 2) return halves[0] ?? 0;
  return halves[0]! + halves[1]!;
}

/** A sync goes stale (clocks drift; Wi-Fi latency shifts): re-sync after this. */
export const RESYNC_MS = 60_000;

// -- drift discipline (docs/design/synced-show.md) ------------------------------------
//
// alignTime puts every player on one epoch ONCE; after that each player's effect clock
// runs on its own crystal, and crystals differ by tens of ppm: 0.1-0.3 s apart after an
// hour, far past the ~10 ms a fast effect shows. The discipline keeps re-measuring each
// player that shares a time base, fits its clock offset AND drift rate over a short
// window, and moves the player's epoch to follow: in small bounded steps (a slew — at
// most `maxStepMs` per correction, each a 1-2 ms effect-time step nobody can see), or in
// one step when the error is too big to slew (a reboot, a reconnect, a clock jump).

export interface DriftOptions {
  /** Sample (and correct) each disciplined player this often while in lock (ms). */
  intervalMs: number;
  /** ...and this often while a slew is still under way (ms). */
  slewIntervalMs: number;
  /** Largest epoch change per correction while slewing (ms of effect time). */
  maxStepMs: number;
  /** Errors below this are left alone (the epoch is integer ms). */
  deadbandMs: number;
  /** Errors above this are corrected in one step (re-align) instead of slewed. */
  realignMs: number;
  /** Fit window: samples older than this are dropped (ms). */
  windowMs: number;
  maxSamples: number;
  /** The fit only estimates a drift rate once its samples span this long (ms). */
  minSpanMs: number;
  /** A fitted rate beyond this is clamped (no healthy crystal is that far off). */
  maxPpm: number;
  /** Ping rounds per sample (min-RTT of them). */
  rounds: number;
  sampleTimeoutMs: number;
}

export const DRIFT_DEFAULTS: DriftOptions = {
  intervalMs: 30_000,
  slewIntervalMs: 5_000,
  maxStepMs: 2,
  deadbandMs: 1,
  realignMs: 50,
  windowMs: 10 * 60_000,
  maxSamples: 24,
  minSpanMs: 60_000,
  maxPpm: 500,
  rounds: 4,
  sampleTimeoutMs: 3_000,
};

/** What one sample did to the model. */
export type SampleVerdict = "ok" | "outlier" | "discontinuity";

/**
 * A player's clock offset (player ms - hub ms) as a line over hub time, fitted by
 * weighted least squares to the recent min-RTT samples. Robust to Wi-Fi jitter: a
 * sample whose round trip is well above the window's best is not fitted (queueing
 * delay makes its offset unreliable by up to rtt/2), and the fit weights the rest
 * by 1/rtt². A sample far off the line, by more than its round trip could explain,
 * is a clock discontinuity (the player rebooted, or its clock stepped): the model
 * restarts from it.
 */
export class DriftEstimator {
  private samples: ClockSync[] = [];
  private fit: { t0: number; a: number; b: number; resid: number } | null = null;

  constructor(private readonly o: DriftOptions = DRIFT_DEFAULTS) {}

  get count(): number {
    return this.samples.length;
  }

  /** The smallest round trip in the window (ms; Infinity: no samples). */
  get bestRttMs(): number {
    return this.samples.reduce((m, s) => Math.min(m, s.rttMs), Infinity);
  }

  /** The fitted drift rate in ppm (player clock fast = positive); 0 until the samples
   * span {@link DriftOptions.minSpanMs}. */
  get ppm(): number {
    return (this.fit?.b ?? 0) * 1e6;
  }

  /** When the newest sample was taken (hub ms; -Infinity: none). */
  get lastAt(): number {
    return this.samples.at(-1)?.at ?? -Infinity;
  }

  /** How far the predicted offset may be from the truth (ms): half the best round trip
   * (the asymmetry a sample can't see) plus the fit's residual scatter. */
  get uncertaintyMs(): number {
    if (!this.fit) return Infinity;
    return this.bestRttMs / 2 + this.fit.resid;
  }

  /** The predicted offset at hub time `h` (null: no samples). */
  predict(h: number): number | null {
    return this.fit ? this.fit.a + this.fit.b * (h - this.fit.t0) : null;
  }

  reset(): void {
    this.samples = [];
    this.fit = null;
  }

  add(s: ClockSync): SampleVerdict {
    const pred = this.predict(s.at);
    let verdict: SampleVerdict = "ok";
    if (pred !== null) {
      const off = Math.abs(s.offsetMs - pred) - Math.max(0, s.rttMs) / 2 - this.uncertaintyMs;
      if (off > this.o.realignMs) {
        // Off the line by more than any queueing delay could explain: the clock moved.
        this.samples = [];
        verdict = "discontinuity";
      } else if (s.rttMs > this.rttGate()) verdict = "outlier";
    }
    this.samples.push(s);
    this.samples = this.samples.filter((x) => s.at - x.at <= this.o.windowMs).slice(-this.o.maxSamples);
    this.refit();
    return verdict;
  }

  /** Samples with a round trip above this are kept (for the gate) but not fitted. */
  private rttGate(): number {
    return this.bestRttMs * 1.5 + 2;
  }

  private refit(): void {
    const gate = this.rttGate();
    const use = this.samples.filter((s) => s.rttMs <= gate);
    if (use.length === 0) {
      this.fit = null;
      return;
    }
    const t0 = use.at(-1)!.at;
    const w = use.map((s) => 1 / Math.max(1, s.rttMs) ** 2);
    const W = w.reduce((a, b) => a + b, 0);
    const mx = use.reduce((a, s, i) => a + w[i]! * (s.at - t0), 0) / W;
    const my = use.reduce((a, s, i) => a + w[i]! * s.offsetMs, 0) / W;
    let b = 0;
    const span = use.at(-1)!.at - use[0]!.at;
    if (use.length >= 3 && span >= this.o.minSpanMs) {
      let sxx = 0;
      let sxy = 0;
      use.forEach((s, i) => {
        const dx = s.at - t0 - mx;
        sxx += w[i]! * dx * dx;
        sxy += w[i]! * dx * (s.offsetMs - my);
      });
      b = sxx > 0 ? sxy / sxx : 0;
      const lim = this.o.maxPpm * 1e-6;
      b = Math.max(-lim, Math.min(lim, b));
    }
    const a = my - b * mx; // the line at t0 (the newest fitted sample)
    const resid =
      use.length < 2
        ? 0
        : Math.sqrt(use.reduce((acc, s, i) => acc + w[i]! * (s.offsetMs - (a + b * (s.at - t0))) ** 2, 0) / W);
    this.fit = { t0, a, b, resid };
  }
}

/** How the discipline reaches the players (the hub wires its sessions in). */
export interface DisciplineIo {
  /** A fresh clock sample (min-RTT of `rounds`), or null: no live session / no answer. */
  sample(id: string, rounds: number, timeoutMs: number): Promise<ClockSync | null>;
  /** Give the player this epoch (its clock, ms). False: it couldn't take it. */
  apply(id: string, epochDeviceMs: number): Promise<boolean>;
  now(): number;
  log?: (msg: string) => void;
}

/** One correction (or the lack of one). */
export interface Correction {
  at: number;
  kind: "slew" | "realign" | "hold";
  /** How far the epoch moved (ms; + = later = effect time stepped back). */
  stepMs: number;
  /** The error found before it (applied epoch - wanted epoch, ms). */
  errorMs: number;
}

interface Member {
  hubEpochMs: number;
  /** The epoch the player was last given (its clock, ms). */
  applied: number;
  est: DriftEstimator;
  nextAt: number;
  busy: boolean;
  last: Correction | null;
  /** The error left after the last correction (ms). */
  residualMs: number;
  slews: number;
  realigns: number;
  slewedMs: number;
  failures: number;
}

/** Per-player discipline state (time_sync_status, align_time's `drift`). */
export interface DisciplineStatus {
  id: string;
  offset_ms: number | null;
  drift_ppm: number;
  /** Applied epoch minus the wanted one after the last correction (ms): + = behind. */
  error_ms: number;
  uncertainty_ms: number | null;
  samples: number;
  last_sample_age_s: number | null;
  last_correction: (Omit<Correction, "at"> & { age_s: number }) | null;
  slews: number;
  realigns: number;
  slewed_ms: number;
  failed_samples: number;
}

export class TimeDiscipline {
  readonly o: DriftOptions;
  private readonly members = new Map<string, Member>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  constructor(
    private readonly io: DisciplineIo,
    opts: Partial<DriftOptions> = {},
    /** Run the background loop (tests drive {@link tick} by hand). */
    private readonly autostart = true,
  ) {
    this.o = { ...DRIFT_DEFAULTS, ...opts };
  }

  /** Discipline `id` on `hubEpochMs`, which alignTime just gave it as `epochDeviceMs`
   * (measured with `sync`). Keeps the player's clock model across re-aligns. */
  adopt(id: string, hubEpochMs: number, epochDeviceMs: number, sync?: ClockSync): void {
    const m = this.members.get(id);
    const est = m?.est ?? new DriftEstimator(this.o);
    if (sync && !sync.model && sync.at > est.lastAt) est.add(sync);
    this.members.set(id, {
      hubEpochMs,
      applied: Math.round(epochDeviceMs),
      est,
      nextAt: this.io.now() + this.o.intervalMs,
      busy: false,
      last: m?.last ?? null,
      residualMs: 0,
      slews: m?.slews ?? 0,
      realigns: m?.realigns ?? 0,
      slewedMs: m?.slewedMs ?? 0,
      failures: m?.failures ?? 0,
    });
    if (this.autostart && !this.timer) {
      this.timer = setInterval(() => void this.tick(), Math.min(1_000, this.o.slewIntervalMs));
      this.timer.unref?.();
    }
  }

  drop(id: string): void {
    this.members.delete(id);
  }

  has(id: string): boolean {
    return this.members.has(id);
  }

  /** The model's offset for `id` now, as a sync — when the model is fresh (sampled
   * within two intervals). alignTime uses it instead of a new one-shot sync. */
  clockFor(id: string): ClockSync | null {
    const m = this.members.get(id);
    const now = this.io.now();
    if (!m || now - m.est.lastAt > 2 * this.o.intervalMs) return null;
    const off = m.est.predict(now);
    return off === null ? null : { offsetMs: off, rttMs: m.est.bestRttMs, at: now, model: true };
  }

  /** Correct every player that is due (the background loop calls this every second). */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    const now = this.io.now();
    const due = [...this.members].filter(([, m]) => !m.busy && m.nextAt <= now).map(([id]) => id);
    this.ticking = Promise.all(due.map((id) => this.step(id).catch(() => undefined))).then(() => {
      this.ticking = null;
    });
    return this.ticking;
  }

  /** Sample `id` once and correct its epoch. */
  async step(id: string): Promise<Correction | null> {
    const m = this.members.get(id);
    if (!m || m.busy) return null;
    m.busy = true;
    try {
      const s = await this.io.sample(id, this.o.rounds, this.o.sampleTimeoutMs);
      if (this.members.get(id) !== m) return null; // re-adopted / dropped meanwhile
      if (!s) {
        m.failures++;
        m.nextAt = this.io.now() + this.o.slewIntervalMs;
        return null;
      }
      const verdict = m.est.add(s);
      const now = this.io.now();
      const want = m.hubEpochMs + m.est.predict(now)!;
      const err = m.applied - want;
      let c: Correction = { at: now, kind: "hold", stepMs: 0, errorMs: err };
      if (verdict === "discontinuity" || Math.abs(err) > this.o.realignMs) {
        const to = Math.round(want);
        if (await this.io.apply(id, to)) {
          c = { at: now, kind: "realign", stepMs: to - m.applied, errorMs: err };
          m.applied = to;
          m.realigns++;
          this.io.log?.(`time base: ${id} re-aligned by ${c.stepMs} ms (${verdict})`);
        }
      } else if (Math.abs(err) >= this.o.deadbandMs) {
        const step = -Math.max(-this.o.maxStepMs, Math.min(this.o.maxStepMs, Math.round(err)));
        if (step !== 0 && (await this.io.apply(id, m.applied + step))) {
          c = { at: now, kind: "slew", stepMs: step, errorMs: err };
          m.applied += step;
          m.slews++;
          m.slewedMs += Math.abs(step);
        }
      }
      m.residualMs = m.applied - want;
      if (c.kind !== "hold") m.last = c;
      m.nextAt = now + (Math.abs(m.residualMs) >= this.o.deadbandMs ? this.o.slewIntervalMs : this.o.intervalMs);
      return c;
    } finally {
      m.busy = false;
    }
  }

  status(ids?: Iterable<string>): { players: DisciplineStatus[]; skew_bound_ms: number | null } {
    const now = this.io.now();
    const want = ids ? new Set(ids) : null;
    const players: DisciplineStatus[] = [];
    for (const [id, m] of this.members) {
      if (want && !want.has(id)) continue;
      const off = m.est.predict(now);
      const unc = m.est.uncertaintyMs;
      // The error NOW: the model carries the drift since the last correction.
      const err = off === null ? m.residualMs : m.applied - (m.hubEpochMs + off);
      players.push({
        id,
        offset_ms: off === null ? null : +off.toFixed(2),
        drift_ppm: +m.est.ppm.toFixed(2),
        error_ms: +err.toFixed(2),
        uncertainty_ms: Number.isFinite(unc) ? +unc.toFixed(2) : null,
        samples: m.est.count,
        last_sample_age_s: Number.isFinite(m.est.lastAt) ? +((now - m.est.lastAt) / 1000).toFixed(1) : null,
        last_correction: m.last
          ? { kind: m.last.kind, stepMs: m.last.stepMs, errorMs: +m.last.errorMs.toFixed(2), age_s: +((now - m.last.at) / 1000).toFixed(1) }
          : null,
        slews: m.slews,
        realigns: m.realigns,
        slewed_ms: m.slewedMs,
        failed_samples: m.failures,
      });
    }
    // Two players' effect clocks are at most both errors plus both uncertainties apart.
    const bounds = players.map((p) => Math.abs(p.error_ms) + (p.uncertainty_ms ?? Infinity)).sort((a, b) => b - a);
    const skew = bounds.length === 0 ? null : bounds.length === 1 ? bounds[0]! : bounds[0]! + bounds[1]!;
    return { players, skew_bound_ms: skew === null || !Number.isFinite(skew) ? null : +skew.toFixed(1) };
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.members.clear();
  }
}
