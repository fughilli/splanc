/**
 * The drift discipline (timesync.ts, docs/design/synced-show.md) against simulated
 * players: crystals tens of ppm apart, Wi-Fi round trips with heavy-tailed jitter,
 * a reboot mid-show. Effect time on a player is (its clock - its epoch); the shared
 * time is (hub clock - room epoch). The discipline must keep every player's effect
 * time within a few ms of the shared one for hours, moving epochs only in small
 * steps — except a re-align after a clock discontinuity.
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DRIFT_DEFAULTS,
  DriftEstimator,
  TimeDiscipline,
  type ClockSync,
  type Correction,
} from "../src/timesync";

/** A deterministic PRNG (mulberry32), so a failure reproduces. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A simulated player: its clock runs `ppm` fast from `offsetMs` (device ms at hub 0). */
class SimPlayer {
  epoch: number | null = null;
  readonly epochs: number[] = [];
  constructor(
    public ppm: number,
    public offsetMs: number,
    private readonly rand: () => number,
    /** One-way latency floor and mean extra (exponential) jitter, ms. */
    public baseMs = 3,
    public jitterMs = 4,
    /** Chance a one-way trip is stuck behind a retransmit (100-300 ms). */
    public spikeP = 0.05,
  ) {}

  clock(h: number): number {
    return this.offsetMs + h * (1 + this.ppm * 1e-6);
  }

  private leg(): number {
    const spike = this.rand() < this.spikeP ? 100 + 200 * this.rand() : 0;
    return this.baseMs + -Math.log(1 - this.rand()) * this.jitterMs + spike;
  }

  /** One ping/pong at hub time h (NTP math, as LedMapperClient.syncClock). */
  ping(h: number): { offsetMs: number; rttMs: number; t3: number } {
    const f = this.leg();
    const b = this.leg();
    const t1 = this.clock(h + f);
    const t2 = t1 + 0.2;
    const t3 = h + f + 0.2 + b;
    return { offsetMs: (t1 - h + (t2 - t3)) / 2, rttMs: t3 - h - (t2 - t1), t3 };
  }

  sample(h: number, rounds: number): ClockSync {
    let best: { offsetMs: number; rttMs: number; t3: number } | null = null;
    let t = h;
    for (let i = 0; i < rounds; i++) {
      const p = this.ping(t);
      if (!best || p.rttMs < best.rttMs) best = p;
      t = p.t3;
    }
    return { offsetMs: best!.offsetMs, rttMs: best!.rttMs, at: best!.t3 - best!.rttMs / 2 };
  }

  /** Effect time (ms) at hub time h; null without a time base. */
  effectMs(h: number): number | null {
    return this.epoch === null ? null : this.clock(h) - this.epoch;
  }

  reboot(h: number): void {
    // millis() restarts from ~0 and the runtime-only time base is gone.
    this.offsetMs = -h * (1 + this.ppm * 1e-6) + 1_500;
    this.epoch = null;
  }
}

interface Show {
  now: number;
  players: Map<string, SimPlayer>;
  disc: TimeDiscipline;
  corrections: Map<string, Correction[]>;
  hubEpoch: number;
}

function show(specs: { ppm: number; offsetMs: number }[], seed = 1, opts = {}): Show {
  const rand = rng(seed);
  const players = new Map(specs.map((s, i) => [`p${i}`, new SimPlayer(s.ppm, s.offsetMs, rand)]));
  const sh: Show = { now: 0, players, disc: null as unknown as TimeDiscipline, corrections: new Map(), hubEpoch: 0 };
  sh.disc = new TimeDiscipline(
    {
      now: () => sh.now,
      sample: async (id, rounds) => players.get(id)!.sample(sh.now, rounds),
      apply: async (id, epoch) => {
        const p = players.get(id)!;
        p.epoch = epoch;
        p.epochs.push(epoch);
        return true;
      },
    },
    opts,
    false,
  );
  return sh;
}

/** alignTime: one sample each, epoch = room epoch in each player's clock. */
function align(sh: Show): void {
  sh.hubEpoch = sh.now;
  for (const [id, p] of sh.players) {
    const s = p.sample(sh.now, 6);
    const e = Math.round(sh.hubEpoch + s.offsetMs);
    p.epoch = e;
    p.epochs.push(e);
    sh.disc.adopt(id, sh.hubEpoch, e, s);
  }
}

/** Worst |effect time - shared time| over the players (ms). */
function worstError(sh: Show): number {
  let worst = 0;
  for (const p of sh.players.values()) {
    const e = p.effectMs(sh.now);
    if (e === null) return Infinity;
    worst = Math.max(worst, Math.abs(e - (sh.now - sh.hubEpoch)));
  }
  return worst;
}

/** Run the show for `ms` of hub time, ticking the discipline every second. Returns
 * the worst error seen after `settleMs`. */
async function run(sh: Show, ms: number, settleMs = 0, each?: (sh: Show) => void): Promise<number> {
  const end = sh.now + ms;
  const settle = sh.now + settleMs;
  let worst = 0;
  while (sh.now < end) {
    sh.now += 1_000;
    each?.(sh);
    await sh.disc.tick();
    if (sh.now >= settle) worst = Math.max(worst, worstError(sh));
  }
  return worst;
}

/** Largest epoch move between consecutive applies, per player. */
function maxStep(p: SimPlayer, from = 1): number {
  let m = 0;
  for (let i = from; i < p.epochs.length; i++) m = Math.max(m, Math.abs(p.epochs[i]! - p.epochs[i - 1]!));
  return m;
}

const TEN = [-80, -45, -30, -12, 0, 8, 20, 35, 50, 75].map((ppm, i) => ({ ppm, offsetMs: 1e6 * (i + 1) + 0.37 * i }));

describe("drift estimator", () => {
  test("fits offset and rate through jittery round trips", () => {
    const rand = rng(7);
    const p = new SimPlayer(42, 123_456, rand, 3, 6, 0.1);
    const est = new DriftEstimator();
    for (let h = 0; h <= 10 * 60_000; h += 30_000) est.add(p.sample(h, 4));
    assert.ok(Math.abs(est.ppm - 42) < 8, `ppm ${est.ppm}`);
    const h = 10 * 60_000;
    const truth = p.clock(h) - h;
    assert.ok(Math.abs(est.predict(h)! - truth) < 3, `offset err ${est.predict(h)! - truth}`);
  });

  test("a round trip stuck behind a retransmit is not fitted", () => {
    const est = new DriftEstimator();
    for (let i = 0; i < 5; i++) est.add({ offsetMs: 1000, rttMs: 6, at: i * 30_000 });
    // A pong delayed 150 ms on the way back: offset off by -75 ms, RTT 156.
    assert.equal(est.add({ offsetMs: 925, rttMs: 156, at: 150_000 }), "outlier");
    assert.ok(Math.abs(est.predict(150_000)! - 1000) < 0.01);
  });

  test("a jump the round trip can't explain is a discontinuity: the model restarts", () => {
    const est = new DriftEstimator();
    for (let i = 0; i < 5; i++) est.add({ offsetMs: 1000 + i * 0.003 * 30, rttMs: 6, at: i * 30_000 });
    assert.equal(est.add({ offsetMs: -5_000_000, rttMs: 8, at: 150_000 }), "discontinuity");
    assert.equal(est.count, 1);
    assert.equal(est.ppm, 0);
    assert.equal(est.predict(150_000), -5_000_000);
  });

  test("the rate is clamped to a plausible crystal", () => {
    const est = new DriftEstimator();
    for (let i = 0; i < 6; i++) est.add({ offsetMs: i * 30, rttMs: 5, at: i * 30_000 }); // 1000 ppm
    assert.equal(est.ppm, DRIFT_DEFAULTS.maxPpm);
  });
});

describe("drift discipline", () => {
  test("ten players, ±80 ppm, jittery Wi-Fi: in step for three hours, ≤2 ms steps", async () => {
    const sh = show(TEN, 3);
    align(sh);
    // Uncorrected, ±80 ppm is ~0.3 s/hour per player.
    const worst = await run(sh, 3 * 3_600_000, 10 * 60_000);
    assert.ok(worst < 10, `worst error ${worst.toFixed(2)} ms`);
    for (const [id, p] of sh.players) {
      assert.ok(maxStep(p) <= DRIFT_DEFAULTS.maxStepMs, `${id} stepped ${maxStep(p)} ms`);
    }
    const st = sh.disc.status();
    assert.equal(st.players.length, 10);
    for (const row of st.players) {
      const ppm = sh.players.get(row.id)!.ppm;
      assert.ok(Math.abs(row.drift_ppm - ppm) < 5, `${row.id}: fitted ${row.drift_ppm} ppm, true ${ppm}`);
      assert.equal(row.realigns, 0);
    }
    assert.ok(st.skew_bound_ms !== null && st.skew_bound_ms < 20, `skew bound ${st.skew_bound_ms}`);
    // The bound holds: every pair is within it.
    const errs = [...sh.players.values()].map((p) => p.effectMs(sh.now)! - (sh.now - sh.hubEpoch));
    assert.ok(Math.max(...errs) - Math.min(...errs) <= st.skew_bound_ms!);
  });

  test("without the discipline the same show drifts apart", async () => {
    const sh = show(TEN, 3);
    align(sh);
    sh.disc.stop();
    const worst = await run(sh, 3_600_000);
    assert.ok(worst > 200, `worst ${worst}`);
  });

  test("a reboot mid-show re-aligns at once; the others never jump", async () => {
    const sh = show(TEN.slice(0, 4), 5);
    align(sh);
    await run(sh, 20 * 60_000);
    const victim = sh.players.get("p2")!;
    const before = new Map([...sh.players].map(([id, p]) => [id, p.epochs.length]));
    victim.reboot(sh.now);
    // The player answers again with no time base: effect time is its own until re-aligned.
    let backAt = -1;
    await run(sh, 5 * 60_000, 0, (s) => {
      if (backAt < 0 && victim.epoch !== null) backAt = s.now;
    });
    assert.ok(backAt > 0 && backAt - (sh.now - 5 * 60_000) <= DRIFT_DEFAULTS.intervalMs + 1_000, `back at ${backAt}`);
    assert.ok(worstError(sh) < 10, `after reboot ${worstError(sh)}`);
    const st = sh.disc.status().players.find((p) => p.id === "p2")!;
    assert.equal(st.realigns, 1);
    for (const [id, p] of sh.players) if (id !== "p2") assert.ok(maxStep(p, before.get(id)!) <= 2, id);
  });

  test("a small step error (e.g. a stale sync) is slewed out, not jumped", async () => {
    const sh = show([{ ppm: 0, offsetMs: 5000 }, { ppm: 0, offsetMs: -7000 }], 9);
    align(sh);
    // Knock p1's applied epoch 30 ms off (below the re-align threshold).
    const p1 = sh.players.get("p1")!;
    p1.epoch! += 30;
    sh.disc.adopt("p1", sh.hubEpoch, p1.epoch!);
    await run(sh, 3 * 60_000);
    assert.ok(worstError(sh) < 3, `left ${worstError(sh)}`);
    assert.ok(maxStep(p1, 2) <= 2);
    // ≥15 steps of ≤2 ms, at the slew cadence (5 s) rather than the lock one (30 s).
    const slews = p1.epochs.length - 1;
    assert.ok(slews >= 15, `slews ${slews}`);
    assert.equal(sh.disc.status().players.find((p) => p.id === "p1")!.realigns, 0);
  });

  test("a big error (> 50 ms) is re-aligned in one step", async () => {
    const sh = show([{ ppm: 10, offsetMs: 5000 }], 11);
    align(sh);
    const p0 = sh.players.get("p0")!;
    p0.epoch! += 400; // e.g. alignTime raced a reconnect
    sh.disc.adopt("p0", sh.hubEpoch, p0.epoch!);
    await run(sh, 31_000);
    assert.ok(worstError(sh) < 5);
    assert.equal(sh.disc.status().players[0]!.realigns, 1);
  });

  test("a player that stops answering is retried; the others carry on", async () => {
    const sh = show(TEN.slice(0, 2), 13);
    let mute = false;
    const disc = new TimeDiscipline(
      {
        now: () => sh.now,
        sample: async (id, r) => (mute && id === "p0" ? null : sh.players.get(id)!.sample(sh.now, r)),
        apply: async (id, e) => {
          sh.players.get(id)!.epoch = e;
          return true;
        },
      },
      {},
      false,
    );
    sh.disc = disc;
    align(sh);
    mute = true;
    await run(sh, 2 * 60_000);
    const st = disc.status();
    assert.ok(st.players.find((p) => p.id === "p0")!.failed_samples >= 10);
    assert.ok(st.players.find((p) => p.id === "p1")!.samples >= 4);
  });

  test("clockFor: a fresh model stands in for a new sync, a stale one doesn't", async () => {
    const sh = show([{ ppm: 30, offsetMs: 777 }], 17);
    align(sh);
    await run(sh, 5 * 60_000);
    const c = sh.disc.clockFor("p0")!;
    assert.equal(c.model, true);
    assert.ok(Math.abs(c.offsetMs - (sh.players.get("p0")!.clock(sh.now) - sh.now)) < 3);
    sh.now += 5 * 60_000;
    assert.equal(sh.disc.clockFor("p0"), null);
    assert.equal(sh.disc.clockFor("nobody"), null);
  });
});
