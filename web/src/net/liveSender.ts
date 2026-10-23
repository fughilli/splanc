/**
 * Latest-wins, one-in-flight sender — the pacing primitive behind real-time
 * control (docs/design/live-control.md).
 *
 * A knob, fader or MIDI CC produces updates far faster than a heap-tight C6
 * can take them (a Twister pushes ~100 Hz per encoder; the device drains a few
 * dozen messages a second while a heavy effect renders). Writing every update
 * to the socket queues them in the OS send buffer, where they stay — and the
 * lag grows for as long as the performer keeps turning. This sender bounds the
 * backlog at ONE batch:
 *
 * - **Latest wins per key.** `push(k, v)` replaces any pending value for `k`.
 * - **A bounded number of batches in flight** (`maxInFlight`, default 1). Each
 *   batch's `send` returns a promise that settles when the device has taken it
 *   (its reply/ack); once `maxInFlight` are unacknowledged nothing else goes out
 *   until one settles, or until `ackTimeoutMs` passes (an ack lost to a full
 *   device window, or a firmware that never answers). More than one lets the
 *   round trip drop out of the send cadence on a slow path, while the backlog
 *   stays bounded at `maxInFlight` small batches.
 * - **Rate cap.** Consecutive sends are at least `minIntervalMs()` apart (the
 *   device's render period: more often than a frame is never visible).
 * - **Transport gate.** `canSend()` (e.g. the socket's bufferedAmount is low)
 *   holds the batch while bulk traffic is still leaving.
 *
 * Generic over the key/value type and the transport so other live streams (a
 * texture/video frame stream, a bridge mux) can reuse it.
 */

export type LiveTimer = (fn: () => void, ms: number) => void;

export interface LatestWinsOptions {
  /** Minimum ms between batch sends (re-read before every send). Default 0. */
  minIntervalMs?: () => number;
  /** Give up waiting on a batch's ack after this long (re-read per batch). Default 250 ms. */
  ackTimeoutMs?: number | (() => number);
  /** Unacknowledged batches allowed at once (re-read before every send). Default 1. */
  maxInFlight?: () => number;
  /** Transport gate: false holds the batch (re-polled every `pollMs`). */
  canSend?: () => boolean;
  /** Re-poll period while `canSend()` is false. Default 8 ms. */
  pollMs?: number;
  now?: () => number;
  schedule?: LiveTimer;
}

/** What a batch send reports: a promise settling on the device's ack, or null
 * when nothing could be written (socket down) — the batch is then dropped. */
export type BatchSend<K, V> = (batch: Map<K, V>) => Promise<unknown> | null;

export class LatestWinsSender<K, V> {
  private pending = new Map<K, V>();
  private inFlight = 0;
  private live = new Set<number>(); // ids of the batches still in flight
  private flightId = 0;
  private timerArmed = false;
  private lastSendAt = -Infinity;
  private idle: Array<() => void> = [];
  private readonly minInterval: () => number;
  private readonly ackTimeoutMs: () => number;
  private readonly maxInFlight: () => number;
  private readonly canSend: () => boolean;
  private readonly pollMs: number;
  private readonly now: () => number;
  private readonly schedule: LiveTimer;

  /** Counters for diagnostics/tests. */
  readonly stats = { pushes: 0, batches: 0, coalesced: 0, timeouts: 0, dropped: 0 };

  constructor(
    private readonly send: BatchSend<K, V>,
    opts: LatestWinsOptions = {},
  ) {
    this.minInterval = opts.minIntervalMs ?? (() => 0);
    const ato = opts.ackTimeoutMs ?? 250;
    this.ackTimeoutMs = typeof ato === "function" ? ato : () => ato;
    this.maxInFlight = opts.maxInFlight ?? (() => 1);
    this.canSend = opts.canSend ?? (() => true);
    this.pollMs = opts.pollMs ?? 8;
    this.now = opts.now ?? (() => Date.now());
    this.schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  }

  /** Queue `value` for `key`, replacing any value still pending for it. */
  push(key: K, value: V): void {
    this.stats.pushes++;
    if (this.pending.has(key)) this.stats.coalesced++;
    this.pending.set(key, value);
    this.pump();
  }

  /** A pending value (not yet sent) for `key`, if any. */
  peek(key: K): V | undefined {
    return this.pending.get(key);
  }

  /** Forget the pending values whose key matches (they no longer apply). */
  discard(match: (key: K) => boolean): void {
    for (const k of [...this.pending.keys()]) if (match(k)) this.pending.delete(k);
    this.maybeIdle();
  }

  /** Forget everything pending (e.g. the socket closed). An in-flight batch
   * still settles normally. */
  clear(): void {
    this.pending.clear();
    this.maybeIdle();
  }

  /** True while a batch is in flight or values are pending. */
  get busy(): boolean {
    return this.inFlight > 0 || this.pending.size > 0;
  }

  /** Batches sent and not yet acknowledged (or timed out). */
  get unacked(): number {
    return this.inFlight;
  }

  /** Resolves once nothing is pending or in flight (immediately if idle). */
  settled(): Promise<void> {
    if (!this.busy) return Promise.resolve();
    return new Promise((r) => this.idle.push(r));
  }

  /** Try to send now; re-arms itself while gated. Safe to call any time. */
  pump(): void {
    if (this.inFlight >= Math.max(1, this.maxInFlight()) || this.timerArmed) return;
    if (this.pending.size === 0) {
      this.maybeIdle();
      return;
    }
    const wait = this.lastSendAt + this.minInterval() - this.now();
    if (wait > 0) {
      this.arm(wait);
      return;
    }
    if (!this.canSend()) {
      this.arm(this.pollMs);
      return;
    }
    const batch = this.pending;
    this.pending = new Map();
    this.lastSendAt = this.now();
    let p: Promise<unknown> | null;
    try {
      p = this.send(batch);
    } catch {
      p = null;
    }
    if (p === null) {
      this.stats.dropped += batch.size;
      this.maybeIdle();
      return;
    }
    this.stats.batches++;
    this.inFlight++;
    const id = ++this.flightId;
    this.live.add(id);
    const done = (timedOut: boolean): void => {
      if (!this.live.delete(id)) return; // already settled (ack, or its timeout)
      if (timedOut) this.stats.timeouts++;
      this.inFlight--;
      this.pump();
    };
    p.then(
      () => done(false),
      () => done(false),
    );
    this.schedule(() => done(true), this.ackTimeoutMs());
  }

  private arm(ms: number): void {
    this.timerArmed = true;
    this.schedule(() => {
      this.timerArmed = false;
      this.pump();
    }, ms);
  }

  private maybeIdle(): void {
    if (this.busy) return;
    const w = this.idle;
    this.idle = [];
    for (const r of w) r();
  }
}
