"""Pure analysis for the canned-ramp HITL run (docs/design/ramps.md).

The DUTs run a solid `tint * gain` effect (ab_demo/kpSolid.fx) with an identity
colour correction, so every LED's wire byte is gain * 255: a ramp_uniforms of
`gain` shows up on the logic analyzer as the brightness of each WS2812 frame over
time. From those (wire time, brightness) samples this module

  - fits where the ramp started (from its mid-level crossing and the ease's
    inverse), then scores every in-ramp frame against the expected curve
    (max / RMS error, in 0..1 brightness units);
  - measures the duration from the 10% and 90% crossings (independent of the
    fitted start);
  - gives the two-fixture skew as the difference of the mid-level crossings on
    ONE analyzer capture (one sample clock);
  - checks a ramp a live set cut off mid-way (it never reaches the target and
    holds the live value).

Frame times are the analyzer's; the render->wire latency is a constant that the
fitted start absorbs. Pure (no I/O): unit-tested in //pi/hitl/tests.
"""

from __future__ import annotations

import math
import statistics
from dataclasses import dataclass
from typing import Callable, Dict, List, Optional, Sequence, Tuple

Series = List[Tuple[float, float]]


def ease(name: str, u: float) -> float:
    """The firmware's eases (firmware/ramp, within 2/65536 of these)."""
    t = min(1.0, max(0.0, u))
    if name == "linear":
        return t
    if name == "ease_in":
        return t * t * t
    if name == "ease_out":
        return 1 - (1 - t) ** 3
    if name == "smoothstep":
        return t * t * (3 - 2 * t)
    if name == "ease":
        return 4 * t * t * t if t < 0.5 else 1 - (2 - 2 * t) ** 3 / 2
    raise ValueError(f"unknown ease {name!r}")


def ease_inv(name: str, y: float) -> float:
    """u with ease(u) == y (bisection; every ease is monotonic)."""
    lo, hi = 0.0, 1.0
    for _ in range(60):
        mid = (lo + hi) / 2
        if ease(name, mid) < y:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def brightness(frames: Sequence[Tuple[float, Sequence[Sequence[int]]]], leds: int = 0) -> Series:
    """(t_s, 0..1) per frame: the median over the first `leds` LEDs (all when 0) of
    each LED's brightest channel / 255. Frames without pixels are skipped."""
    out: Series = []
    for t, px in frames:
        use = px[:leds] if leds else px
        if not use:
            continue
        out.append((t, statistics.median(max(p) for p in use) / 255.0))
    out.sort()
    return out


def crossing(series: Series, level: float, after: float = -math.inf) -> Optional[float]:
    """The first time (linearly interpolated between frames) the series rises
    through `level` at or after `after`; None if it never does."""
    prev = None
    for t, v in series:
        if t < after:
            prev = (t, v)
            continue
        if prev is not None and prev[1] < level <= v:
            (t0, v0) = prev
            return t0 + (t - t0) * (level - v0) / (v - v0) if v != v0 else t
        prev = (t, v)
    return None


@dataclass
class Fit:
    start_s: float
    duration_s: float
    max_err: float
    rms_err: float
    n: int
    mid_s: float


def fit_ramp(
    series: Series, ease_name: str, dur_s: float, lo: float = 0.0, hi: float = 1.0
) -> Optional[Fit]:
    """Fit a lo->hi ramp of `ease_name` over `dur_s`: start from the mid-level
    crossing, duration from the 10/90% crossings, errors over the in-ramp frames.
    None when the series never crosses the middle."""
    span = hi - lo
    mid = crossing(series, lo + 0.5 * span)
    if mid is None:
        return None
    start = mid - ease_inv(ease_name, 0.5) * dur_s
    t10 = crossing(series, lo + 0.1 * span, start - 0.5 * dur_s)
    t90 = crossing(series, lo + 0.9 * span, start - 0.5 * dur_s)
    if t10 is not None and t90 is not None:
        du = ease_inv(ease_name, 0.9) - ease_inv(ease_name, 0.1)
        measured = (t90 - t10) / du
    else:
        measured = float("nan")
    errs = []
    for t, v in series:
        u = (t - start) / dur_s
        if 0.0 <= u <= 1.0:
            errs.append(v - (lo + span * ease(ease_name, u)))
    if not errs:
        return Fit(start, measured, float("nan"), float("nan"), 0, mid)
    return Fit(
        start_s=start,
        duration_s=measured,
        max_err=max(abs(e) for e in errs),
        rms_err=math.sqrt(statistics.fmean(e * e for e in errs)),
        n=len(errs),
        mid_s=mid,
    )


def skew_ms(a: Series, b: Series, level: float = 0.5) -> Optional[float]:
    """b's mid-level crossing minus a's (ms), both on one analyzer clock."""
    ta, tb = crossing(a, level), crossing(b, level)
    if ta is None or tb is None:
        return None
    return (tb - ta) * 1000.0


@dataclass
class Cut:
    peak: float
    final: float
    held: bool
    rose_after: bool


def cut_ramp(series: Series, live: float, hold_s: float = 0.8, tol: float = 0.03) -> Cut:
    """A ramp a live set cut off: the peak before the cut, the value it settles at
    over the last `hold_s` of the capture (should be `live`), and whether it rose
    again after settling (it must not: the ramp is gone)."""
    if not series:
        return Cut(float("nan"), float("nan"), False, False)
    end = series[-1][0]
    tail = [v for t, v in series if t >= end - hold_s]
    final = statistics.median(tail) if tail else float("nan")
    peak = max(v for _, v in series)
    # After the series first comes within tol of `live` following its peak, does it rise again?
    t_peak = max(series, key=lambda x: x[1])[0]
    settled = [(t, v) for t, v in series if t > t_peak and abs(v - live) <= tol]
    rose = False
    if settled:
        t_set = settled[0][0]
        rose = any(v > live + tol for t, v in series if t > t_set)
    return Cut(peak=peak, final=final, held=abs(final - live) <= tol, rose_after=rose)


def synth(
    ease_name: str,
    dur_s: float,
    start_s: float,
    fps: float,
    seconds: float,
    lo=0.0,
    hi=1.0,
    latency_s: float = 0.0,
    quant: bool = True,
    phase: float = 0.0,
    override: Optional[Callable[[float], Optional[float]]] = None,
) -> Series:
    """A synthetic capture (for the unit tests and a dry run): frames at `fps`,
    each showing the value the device rendered `latency_s` earlier."""
    out: Series = []
    t = phase / fps
    while t < seconds:
        r = t - latency_s
        v = (
            lo + (hi - lo) * ease(ease_name, (r - start_s) / dur_s)
            if dur_s > 0
            else (hi if r >= start_s else lo)
        )
        if override is not None:
            o = override(r)
            if o is not None:
                v = o
        if quant:
            v = round(v * 255) / 255
        out.append((t, v))
        t += 1.0 / fps
    return out


def summary(fit: Optional[Fit]) -> Dict[str, object]:
    if fit is None:
        return {"fit": None}
    return {
        "duration_ms": round(fit.duration_s * 1000, 1),
        "max_err": round(fit.max_err, 4),
        "rms_err": round(fit.rms_err, 4),
        "frames": fit.n,
    }
