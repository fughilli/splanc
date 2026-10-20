"""Pure analysis for the shared-time-base skew measurement (multi-fixture §3).

Two DUTs run the same "binary clock" effect after the host set one room epoch on
both via set_time_base: LED k shows bit k of floor(time / TICK_S), so every
rendered frame carries the device's own effect time (TICK_S resolution, wrapping
every 2**BITS ticks). The shared logic analyzer captures both WS2812 wires in ONE
capture (one sample clock), so each frame yields (wire time, device effect time).

A device's offset is the trimmed mean of (wire_time - effect_time): its render->wire latency is
a constant, so that cancels between two DUTs on the same firmware, and the skew is
offset_B - offset_A. Reading time out of the content (rather than timing an edge)
avoids the frame-quantization bias of an edge method, where a 30 fps frame clock
can phase-lock to a 1 s toggle. Pure (no I/O): unit-tested in //pi/hitl/tests.
"""

from __future__ import annotations

import statistics
from dataclasses import dataclass
from typing import Iterable, List, Optional, Sequence, Tuple

BITS = 12
TICK_S = 0.004  # 4 ms per tick -> 16.384 s wrap
WRAP_S = TICK_S * (1 << BITS)

# A LED counts as lit when its brightest channel exceeds this (0..255): full-scale
# white vs black, so any mid threshold survives color correction / brightness.
LIT_THRESHOLD = 64

# The effect both DUTs run is ab_demo/timeBaseClock.fx (LED k = bit k of the tick count).


def decode_ticks(pixels: Sequence[Sequence[int]]) -> Optional[int]:
    """The tick count a frame shows (LED k = bit k), or None if it's too short."""
    if len(pixels) < BITS:
        return None
    return sum((1 << k) for k in range(BITS) if max(pixels[k]) > LIT_THRESHOLD)


def device_offset(frames: Iterable[Tuple[float, Sequence[Sequence[int]]]]) -> Optional[float]:
    """Trimmed-mean (wire_time_s - effect_time_s) over the decodable frames, wrapped to be
    consistent across the tick counter's wrap; None without any decodable frame."""
    raw: List[float] = []
    for t, px in frames:
        ticks = decode_ticks(px)
        if ticks is not None:
            raw.append(t - ticks * TICK_S)
    if not raw:
        return None
    ref = raw[0]
    # Bring every sample within half a wrap of the first (the counter wraps every
    # WRAP_S, which shifts wire-effect by a multiple of WRAP_S).
    unwrapped = sorted(ref + ((v - ref + WRAP_S / 2) % WRAP_S) - WRAP_S / 2 for v in raw)
    # A 10% trimmed MEAN, not the median: render instants sit at only a few phases
    # within a tick (a ~33 ms frame vs a 4 ms tick), so the median snaps to one phase
    # (up to a tick of bias) while the mean centres them; trimming drops mis-decodes.
    cut = len(unwrapped) // 10
    core = unwrapped[cut : len(unwrapped) - cut] or unwrapped
    return statistics.fmean(core)


@dataclass
class Skew:
    """offset_B - offset_A (ms), plus each device's per-frame spread (ms) and counts."""

    skew_ms: float
    spread_a_ms: float
    spread_b_ms: float
    n_a: int
    n_b: int


def skew(
    frames_a: Sequence[Tuple[float, Sequence[Sequence[int]]]],
    frames_b: Sequence[Tuple[float, Sequence[Sequence[int]]]],
) -> Skew:
    oa, ob = device_offset(frames_a), device_offset(frames_b)
    if oa is None or ob is None:
        return Skew(float("nan"), float("nan"), float("nan"), 0, 0)
    d = ((ob - oa + WRAP_S / 2) % WRAP_S) - WRAP_S / 2

    def spread(frames, off):
        vals = []
        for t, px in frames:
            ticks = decode_ticks(px)
            if ticks is None:
                continue
            v = t - ticks * TICK_S - off
            vals.append(((v + WRAP_S / 2) % WRAP_S) - WRAP_S / 2)
        return statistics.pstdev(vals) * 1000.0 if len(vals) > 1 else 0.0

    count = lambda fr: sum(1 for _, px in fr if decode_ticks(px) is not None)  # noqa: E731
    return Skew(
        skew_ms=d * 1000.0,
        spread_a_ms=spread(frames_a, oa),
        spread_b_ms=spread(frames_b, ob),
        n_a=count(frames_a),
        n_b=count(frames_b),
    )


def device_epoch(host_epoch_ms: float, offset_ms: float) -> int:
    """A host-clock epoch converted to a device's clock: device = host + offset,
    where offset = device_clock - host_clock from the min-RTT time-sync sample."""
    return int(round(host_epoch_ms + offset_ms))
