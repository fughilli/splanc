"""SNTP-style clock-sync math — the Python twin of web/src/net/clocksync.ts.

The device answers a time_sync_ping (client t0) with a time_sync_pong carrying
its own t1 (receive) and t2 (send) stamps; the client stamps t3 on receipt.

    offset = ((t1 - t0) + (t2 - t3)) / 2   # add to local time to get device time
    rtt    = (t3 - t0) - (t2 - t1)

Take several samples and keep the minimum-RTT one (least queueing noise). Kept
tiny and pure so the e2e time-sync assertion is unit-testable without hardware.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class SyncSample:
    offset_ms: float
    rtt_ms: float


def sync_sample(t0: float, t1: float, t2: float, t3: float) -> SyncSample:
    return SyncSample(
        offset_ms=((t1 - t0) + (t2 - t3)) / 2.0,
        rtt_ms=(t3 - t0) - (t2 - t1),
    )


def best_sample(samples: list[SyncSample]) -> SyncSample:
    """The minimum-RTT sample — least contaminated by queueing delay."""
    if not samples:
        raise ValueError("no sync samples")
    return min(samples, key=lambda s: s.rtt_ms)


def is_sane(sample: SyncSample, max_rtt_ms: float = 2000.0) -> bool:
    """A round-trip on a healthy LAN is well under a couple of seconds and >= 0."""
    return 0.0 <= sample.rtt_ms <= max_rtt_ms
