/**
 * SNTP-style clock sync (design doc §7.3): the phone/wall estimates the offset
 * between its monotonic clock and the server clock so a capture time can be
 * mapped onto the pattern clock (§8.2).
 *
 *   offset = ((t1 - t0) + (t2 - t3)) / 2
 *   rtt    = (t3 - t0) - (t2 - t1)
 *
 * Repeat a few times, keep the minimum-RTT sample (least queueing noise).
 * Pure computation here; the transport loop lives in `client.ts`.
 */

export interface SyncSample {
  /** Add to a local (client) time to get server time, in ms. */
  offsetMs: number;
  /** Round-trip time of the sample, in ms. */
  rttMs: number;
}

/** One sample from the four SNTP timestamps (t0,t3 client clock; t1,t2 server). */
export function syncSample(t0: number, t1: number, t2: number, t3: number): SyncSample {
  return {
    offsetMs: ((t1 - t0) + (t2 - t3)) / 2,
    rttMs: (t3 - t0) - (t2 - t1),
  };
}

/** The minimum-RTT sample — the least contaminated by queueing delay. */
export function bestSample(samples: readonly SyncSample[]): SyncSample {
  if (samples.length === 0) throw new Error("no sync samples");
  return samples.reduce((best, s) => (s.rttMs < best.rttMs ? s : best));
}

/** Converts local monotonic times to server times using a sync result. */
export class ServerClock {
  constructor(
    private sample: SyncSample,
    private readonly nowFn: () => number = () => performance.now(),
  ) {}

  get offsetMs(): number {
    return this.sample.offsetMs;
  }

  get rttMs(): number {
    return this.sample.rttMs;
  }

  update(sample: SyncSample): void {
    this.sample = sample;
  }

  toServerTime(tLocalMs: number): number {
    return tLocalMs + this.sample.offsetMs;
  }

  nowServerMs(): number {
    return this.toServerTime(this.nowFn());
  }
}
