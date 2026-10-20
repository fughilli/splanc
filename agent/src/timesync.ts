/**
 * The bridge half of the shared time base (docs/design/agent-multi-fixture.md §3).
 * Effects animate on device time, so the same effect on two players drifts apart.
 * The hub estimates each player's clock offset with the protocol's
 * TimeSyncPing/Pong (min-RTT sample of a few rounds — LedMapperClient.syncClock),
 * picks ONE room epoch on its own monotonic clock and hands each player that epoch
 * in the player's clock domain (SetTimeBase, when the firmware advertises
 * `time_base`). The residual skew between two players is bounded by half their
 * sync round trips.
 */

export interface ClockSync {
  /** Add to a hub time (performance.now(), ms) to get the player's time (millis()). */
  offsetMs: number;
  rttMs: number;
  /** When it was measured (hub ms). */
  at: number;
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
