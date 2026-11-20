"""Display flip timing from an overhead camera (docs/design/mesh-hitl-rig.md §7).

Every DUT strip shows `meshFlipClock.fx`: a three-scale clock on its own effect time
(LED 0: on 25 ms of every 62.5 ms; LED 1: 200 of 400 ms; LED 2: 1.6 of 3.2 s). The
camera integrates light over an exposure window per frame (per row, on a rolling
shutter). A frame whose window holds a flip sees a partial level x in (0, 1), and the
flip instant follows from it exactly:

    rising:  t = s + E * (1 - x)        falling:  t = s + E * x

where s is the row's exposure start and E the exposure. That gives one timestamp per
flip, to a fraction of the exposure, however slow the camera. With E close to the
frame period almost every flip lands inside some exposure.

Per LED, each flip carries the pattern time modulo the LED's period (a rising edge is
pattern time 0, a falling one the on-time). So `t - pattern_time` is the DUT's
display offset modulo the period; a robust line fit over a window gives the offset
and drift. The slow LEDs unwrap the fast one, so offsets between DUTs are absolute
within +-1.6 s.

Camera timing errors common to all ROIs (frame start jitter, exposure-length error,
the clock offset) cancel in skews between DUTs. What does not cancel, and what the
calibration in §7.4 removes: the rolling-shutter row offset (line_time * row), the
camera's response non-linearity, and per-LED latency differences.

Pure numpy (+ OpenCV for connected components); the CLI analyses a recorded video.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import sys
from typing import Iterable, Sequence

import numpy as np

# The pattern (meshFlipClock.fx), per LED: (period, on-time) in seconds. LED i is on
# while (pattern time mod period) < on-time, so it rises at 0 and falls at on-time.
# LED 0's 25 / 37.5 ms split puts its flips on both parities of the 80 fps render
# grid, so a camera commensurate with the grid (120 fps: 25 ms = 3 frames) still sees
# flips at two exposure phases 4.17 ms apart, and at most one can sit in a gap (§7.3).
PATTERN = ((0.0625, 0.025), (0.4, 0.2), (3.2, 1.6))
RENDER_HZ = 80.0  # the pattern's frame index: floor(time * 80 + 0.01)

# Fraction thresholds: a sample is "partial" (it saw a flip) inside (LO, HI).
PARTIAL_LO = 0.03
PARTIAL_HI = 0.97


@dataclasses.dataclass
class Camera:
    """Timing model of one capture. Frame j's row r integrates light over
    [frame_start[j] + r * line_time, ... + exposure]."""

    exposure: float  # s
    line_time: float = 0.0  # s per row (0 = global shutter)
    row0: int = 0  # the row frame_start refers to


@dataclasses.dataclass
class Roi:
    name: str
    ys: np.ndarray  # pixel rows
    xs: np.ndarray  # pixel cols
    row: float  # the row used for the shutter offset (centroid)

    @property
    def area(self) -> int:
        return int(self.ys.size)


@dataclasses.dataclass
class Flip:
    t: float  # camera time of the flip (s)
    rising: bool
    kind: str  # "partial" | "gap" | "edge" (boundary, no partial frame)
    sigma: float  # 1-sigma timing uncertainty from the sample model (s)
    frame: int


@dataclasses.dataclass
class Offset:
    """A DUT LED's display offset against camera time at t_ref, modulo 2h."""

    phase: float  # (t_cam - pattern_time) mod 2h at t_ref (s)
    drift: float  # d(offset)/dt (s/s): DUT clock rate vs camera clock
    rms: float  # residual RMS of the flips about the fit (s): jitter + noise
    sigma: float  # standard error of `phase` (s)
    n: int
    period: float
    t_ref: float
    residuals: np.ndarray  # per-flip residuals (s), in flip order
    flip_times: np.ndarray
    partial_frac: float = 1.0  # share of flips timestamped by a partial frame

    @property
    def trusted(self) -> bool:
        """Enough flips were timestamped inside an exposure. A camera whose frame
        period is commensurate with the 12.5 ms render grid sees flips at only a few
        exposure phases; with a short exposure they can all sit in the inter-frame
        gap (§7.3), and the offset is then known only to the gap length."""
        return self.partial_frac >= 0.25 and self.n >= 8


# ---------------------------------------------------------------------------- ROIs


def detect_rois(frames: np.ndarray, min_area: int = 6, rel_thresh: float = 0.35) -> list[Roi]:
    """Blobs of pixels whose brightness swings over the capture (the blinking LEDs).

    The idea of web/src/cv/diffuseDetect.ts (difference against the background,
    threshold, connected components), applied to the temporal range image: a
    flashing LED has a large range, ambient light and static highlights do not."""
    import cv2  # local: keeps the pure-numpy paths importable without OpenCV

    stack = np.asarray(frames, dtype=np.float32)
    lo = np.percentile(stack, 5, axis=0)
    hi = np.percentile(stack, 95, axis=0)
    rng = hi - lo
    thr = rel_thresh * float(rng.max())
    mask = (rng > thr).astype(np.uint8)
    n, labels, stats, cents = cv2.connectedComponentsWithStats(mask, connectivity=8)
    rois = []
    for k in range(1, n):
        if stats[k, cv2.CC_STAT_AREA] < min_area:
            continue
        ys, xs = np.nonzero(labels == k)
        rois.append(Roi(name=f"roi{len(rois)}", ys=ys, xs=xs, row=float(cents[k][1])))
    rois.sort(key=lambda r: (round(r.row / 8.0), float(np.mean(r.xs))))
    for i, r in enumerate(rois):
        r.name = f"roi{i}"
    return rois


def roi_from_box(name: str, x0: int, y0: int, x1: int, y1: int) -> Roi:
    ys, xs = np.mgrid[y0:y1, x0:x1]
    return Roi(name=name, ys=ys.ravel(), xs=xs.ravel(), row=(y0 + y1 - 1) / 2.0)


def extract_series(
    frames: np.ndarray, rois: Sequence[Roi], dark: np.ndarray | None = None
) -> np.ndarray:
    """Mean ROI brightness per frame: an (n_rois, n_frames) array."""
    stack = np.asarray(frames, dtype=np.float32)
    if dark is not None:
        stack = stack - dark[None].astype(np.float32)
    out = np.empty((len(rois), stack.shape[0]), dtype=np.float64)
    for i, r in enumerate(rois):
        out[i] = stack[:, r.ys, r.xs].mean(axis=1)
    return out


# ------------------------------------------------------------------ levels, flips


def levels(series: np.ndarray, band: float = 0.08, iters: int = 3) -> tuple[float, float]:
    """Off and on plateau levels: the medians of the samples in the bottom and top
    `band` of the range. Not a 2-means split: with a long exposure and a 25 ms flip
    period, partial samples can be as common as plateau ones (at 60 fps every third
    frame is a 50 % partial), and a split would put them in a plateau."""
    s = np.asarray(series, dtype=np.float64)
    lo, hi = float(np.percentile(s, 1)), float(np.percentile(s, 99))
    for _ in range(iters):
        span = hi - lo
        if span <= 0:
            break
        a = s[s <= lo + band * span]
        b = s[s >= hi - band * span]
        if a.size == 0 or b.size == 0:
            break
        lo, hi = float(np.median(a)), float(np.median(b))
    return lo, hi


def normalise(
    series: np.ndarray, response: "Response | None" = None, lohi: tuple[float, float] | None = None
) -> tuple[np.ndarray, float]:
    """Fraction-on per frame, and the noise sigma of a plateau sample (in x units).

    `lohi` are measured plateau levels (a calibration phase with the LEDs held on
    and off, §7.4). Without them the levels come from the series itself, which needs
    plateau frames: true at >= 100 fps for LED 0, not at 60 fps, where a 25 ms flip
    period leaves LED 0 no fully-on frame at some phases."""
    s = np.asarray(series, dtype=np.float64)
    if response is not None:
        s = response.linearise(s)
        if lohi is not None:
            lohi = (
                float(response.linearise(np.array([lohi[0]]))[0]),
                float(response.linearise(np.array([lohi[1]]))[0]),
            )
    lo, hi = lohi if lohi is not None else levels(s)
    span = hi - lo
    if span <= 0:
        return np.zeros_like(s), 1.0
    x = (s - lo) / span
    sig = 0.01
    sigs = []
    for p in (x[x < 0.15], x[x > 0.85]):
        if p.size > 8:
            sigs.append(float(1.4826 * np.median(np.abs(p - np.median(p)))))
    if sigs:
        sig = max(sigs)  # the on plateau carries shot noise, the off one only read noise
    return x, max(sig, 1e-4)


@dataclasses.dataclass
class Response:
    """Camera response (sensor value -> linear light), from an exposure sweep:
    pairs of (relative exposure, mean level) of a steady-on LED (calibrate.py §7.4)."""

    level: np.ndarray  # increasing sensor levels
    light: np.ndarray  # linear light, same length

    @staticmethod
    def from_sweep(rel_exposure: Sequence[float], level: Sequence[float]) -> "Response":
        e = np.asarray(rel_exposure, dtype=np.float64)
        lv = np.asarray(level, dtype=np.float64)
        order = np.argsort(lv)
        return Response(level=lv[order], light=e[order])

    def linearise(self, s: np.ndarray) -> np.ndarray:
        return np.interp(s, self.level, self.light)


def find_flips(
    x: np.ndarray,
    frame_start: np.ndarray,
    cam: Camera,
    row: float,
    noise: float = 0.01,
    min_run: int = 1,
) -> list[Flip]:
    """Flip instants of one ROI. `frame_start[j]` is the exposure start of row
    cam.row0 in frame j (camera clock, s); the ROI's row adds (row - row0) * line_time.

    A state change between two plateau frames j0 < j1 is one flip: inside j0 < j < j1
    there is (normally) one partial frame that timestamps it. With none, the flip lay
    in the inter-exposure gap (kind "gap", timestamped at the gap middle) or exactly
    on a boundary."""
    x = np.asarray(x, dtype=np.float64)
    fs = np.asarray(frame_start, dtype=np.float64) + (row - cam.row0) * cam.line_time
    E = cam.exposure
    state = np.full(x.shape, -1, dtype=np.int8)
    state[x <= PARTIAL_LO] = 0
    state[x >= PARTIAL_HI] = 1
    flips: list[Flip] = []
    last_j, last_s = None, None
    for j in range(x.size):
        s = int(state[j])
        if s < 0:
            continue
        if last_s is not None and s != last_s:
            rising = s == 1
            between = list(range(last_j + 1, j))
            if len(between) == 1:
                k = between[0]
                xk = min(max(x[k], 0.0), 1.0)
                t = fs[k] + (E * (1.0 - xk) if rising else E * xk)
                flips.append(Flip(t, rising, "partial", E * noise, k))
            elif not between:
                # no partial frame between the plateaus: the flip sat near an
                # exposure edge (either plateau frame then still carries a small
                # share of it) or in the inter-exposure gap
                end = fs[last_j] + E
                start = fs[j]
                gap = max(start - end, 0.0)
                xa = min(max(x[last_j], 0.0), 1.0)
                xb = min(max(x[j], 0.0), 1.0)
                if rising:
                    ta, tb = fs[last_j] + E * (1.0 - xa), fs[j] + E * (1.0 - xb)
                    share_a, share_b = xa, 1.0 - xb
                else:
                    ta, tb = fs[last_j] + E * xa, fs[j] + E * xb
                    share_a, share_b = 1.0 - xa, xb
                if max(share_a, share_b) > 5.0 * noise or gap <= 1e-6:
                    t = ta if share_a > share_b else tb
                    flips.append(Flip(t, rising, "edge", E * noise, j))
                else:
                    flips.append(Flip(0.5 * (end + start), rising, "gap", gap / math.sqrt(12.0), j))
            else:
                # several partial frames: a slow edge or a glitch. Use the one with
                # the clearest mid level, flagged by a larger sigma.
                k = min(between, key=lambda q: abs(x[q] - 0.5))
                xk = min(max(x[k], 0.0), 1.0)
                t = fs[k] + (E * (1.0 - xk) if rising else E * xk)
                flips.append(Flip(t, rising, "partial", E * max(noise, 0.05), k))
        last_j, last_s = j, s
    return flips


# ------------------------------------------------------------------------ offsets


def _huber_line(t: np.ndarray, y: np.ndarray, w0: np.ndarray, k: float = 2.5, iters: int = 12):
    """y ~ a + b * t by IRLS with Huber weights; returns a, b, residuals, weights."""
    w = w0.copy()
    a = float(np.median(y))
    b = 0.0
    for _ in range(iters):
        W = w.sum()
        tm = (w * t).sum() / W
        ym = (w * y).sum() / W
        var = (w * (t - tm) ** 2).sum()
        b = float((w * (t - tm) * (y - ym)).sum() / var) if var > 0 else 0.0
        a = float(ym - b * tm)
        r = y - (a + b * t)
        mad = 1.4826 * float(np.median(np.abs(r))) + 1e-9
        c = k * mad
        hub = np.where(np.abs(r) <= c, 1.0, c / np.maximum(np.abs(r), 1e-12))
        w = w0 * hub
    return a, b, y - (a + b * t), w


def fit_offset(
    flips: Sequence[Flip],
    led: tuple[float, float],
    t_ref: float | None = None,
    fit_drift: bool = True,
) -> Offset | None:
    """Display offset of one LED (period, on-time): (t_cam - pattern_time) mod period,
    at t_ref. A rising flip is pattern time 0, a falling one the on-time."""
    if len(flips) < 2:
        return None
    partial_frac = sum(f.kind != "gap" for f in flips) / len(flips)
    fl = [f for f in flips if f.kind != "gap"]
    if len(fl) < 2:
        fl = list(flips)
    P, D = led
    t = np.array([f.t for f in fl])
    theta = np.array([0.0 if f.rising else D for f in fl])
    sig = np.array([max(f.sigma, 1e-6) for f in fl])
    r = np.mod(t - theta, P)
    # unwrap around the circular mean so a cluster near 0/P doesn't split
    ang = 2 * np.pi * r / P
    c = math.atan2(float(np.sin(ang).mean()), float(np.cos(ang).mean())) * P / (2 * np.pi)
    r = np.mod(r - c + P / 2, P) - P / 2 + c
    if t_ref is None:
        t_ref = float(np.median(t))
    tt = t - t_ref
    w0 = 1.0 / sig**2
    if fit_drift and len(fl) >= 4 and np.ptp(tt) > 0:
        a, b, res, w = _huber_line(tt, r, w0)
    else:
        a, b, res, w = _huber_line(np.zeros_like(tt), r, w0)
        b = 0.0
    keep = w > 0.5 * w0  # inliers for the uncertainty
    rms = float(np.sqrt(np.mean(res[keep] ** 2))) if keep.any() else float("nan")
    n = int(keep.sum())
    se = rms / math.sqrt(max(n, 1))
    return Offset(
        phase=float(np.mod(a, P)),
        drift=float(b),
        rms=rms,
        sigma=se,
        n=n,
        period=P,
        t_ref=t_ref,
        residuals=res,
        flip_times=t,
        partial_frac=partial_frac,
    )


def wrap(d: float, period: float) -> float:
    return (d + period / 2.0) % period - period / 2.0


def unwrap_skew(deltas: Sequence[float], periods: Sequence[float]) -> float:
    """Combine per-LED offset differences (each known mod its period) into one,
    coarse to fine: the slow LED fixes the multiple of the fast LED's period."""
    pairs = sorted(zip(periods, deltas), reverse=True)
    P, d = pairs[0]
    est = wrap(d, P)
    for P, d in pairs[1:]:
        est = d + P * round((est - d) / P)
    return est


@dataclasses.dataclass
class DutPhase:
    name: str
    offsets: list  # Offset per LED (None if that LED had no flips)

    def phase_mod(self, i: int) -> float | None:
        o = self.offsets[i]
        return None if o is None else o.phase


def skew(a: DutPhase, b: DutPhase, pattern: Sequence[tuple[float, float]] = PATTERN) -> float:
    """Display offset of a minus b (s), unwrapped over the LED scales present."""
    ps, ds = [], []
    for i, (P, _) in enumerate(pattern):
        if a.offsets[i] is None or b.offsets[i] is None:
            continue
        ps.append(P)
        ds.append(wrap(a.offsets[i].phase - b.offsets[i].phase, P))
    if not ps:
        raise ValueError("no common LED scale")
    return unwrap_skew(ds, ps)


def per_flip_skews(
    fa: Sequence[Flip], fb: Sequence[Flip], mean_skew: float, tol: float
) -> np.ndarray:
    """Match each flip of a to b's flip of the same polarity nearest t - mean_skew;
    returns t_a - t_b per matched flip (the per-transition skew distribution)."""
    tb = {
        True: np.array([f.t for f in fb if f.rising]),
        False: np.array([f.t for f in fb if not f.rising]),
    }
    out = []
    for f in fa:
        arr = tb[f.rising]
        if arr.size == 0:
            continue
        k = int(np.argmin(np.abs(arr - (f.t - mean_skew))))
        d = f.t - arr[k]
        if abs(d - mean_skew) <= tol:
            out.append(d)
    return np.asarray(out)


# ------------------------------------------------------------- windowed analysis


@dataclasses.dataclass
class Strip:
    """The three LED ROIs of one strip (index = LED index in the pattern)."""

    dut: str
    leds: list  # Roi per LED (len 3)


def analyse(
    frames: np.ndarray | None,
    frame_start: np.ndarray,
    cam: Camera,
    strips: Sequence[Strip],
    series: dict | None = None,
    window: float | None = None,
    response: Response | None = None,
    pattern: Sequence[tuple[float, float]] = PATTERN,
    lohi: dict | None = None,
) -> dict:
    """Whole-capture (or windowed) flip-timing analysis.

    Returns {"duts": {dut: [Offset per LED]}, "flips": {dut: [flips of LED 0]},
    "skew_s": {"a-b": s}, "windows": [...]} with the first strip as the reference."""
    fs = np.asarray(frame_start, dtype=np.float64)
    if series is None:
        rois = [r for s in strips for r in s.leds]
        sr = extract_series(frames, rois)
        series = {}
        k = 0
        for s in strips:
            for i in range(len(s.leds)):
                series[(s.dut, i)] = sr[k]
                k += 1
    flips: dict = {}
    for s in strips:
        for i, roi in enumerate(s.leds):
            x, noise = normalise(series[(s.dut, i)], response, (lohi or {}).get((s.dut, i)))
            flips[(s.dut, i)] = find_flips(x, fs, cam, roi.row, noise)
    edges = [fs[0], fs[-1] + cam.exposure]
    if window:
        n = max(1, int((edges[1] - edges[0]) // window))
        bounds = [(edges[0] + k * window, edges[0] + (k + 1) * window) for k in range(n)]
    else:
        bounds = [tuple(edges)]
    ref = strips[0].dut
    windows = []
    for lo, hi in bounds:
        t_ref = 0.5 * (lo + hi)
        phases = {}
        for s in strips:
            offs = []
            for i, led in enumerate(pattern):
                fl = [f for f in flips[(s.dut, i)] if lo <= f.t < hi]
                offs.append(fit_offset(fl, led, t_ref))
            phases[s.dut] = DutPhase(s.dut, offs)
        sk = {}
        for s in strips[1:]:
            try:
                sk[s.dut] = skew(phases[s.dut], phases[ref], pattern)
            except ValueError:
                sk[s.dut] = None
        windows.append({"t0": lo, "t1": hi, "phases": phases, "skew_s": sk})
    return {"ref": ref, "flips": flips, "windows": windows}


# ----------------------------------------------------------------------- the CLI


def _load_video(path: str):
    import cv2

    cap = cv2.VideoCapture(path)
    frames = []
    while True:
        ok, img = cap.read()
        if not ok:
            break
        if img.ndim == 3:
            img = img[:, :, 1]  # green: the pattern colour, and the Bayer-densest
        frames.append(img)
    cap.release()
    return np.asarray(frames)


def main(argv: Iterable[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("video")
    ap.add_argument(
        "--meta", required=True, help="JSON: frame_start[], exposure, line_time, strips"
    )
    ap.add_argument("--window", type=float, default=None)
    args = ap.parse_args(list(argv) if argv is not None else None)
    meta = json.load(open(args.meta))
    frames = _load_video(args.video)
    cam = Camera(meta["exposure"], meta.get("line_time", 0.0), meta.get("row0", 0))
    fs = np.asarray(meta["frame_start"], dtype=np.float64)[: len(frames)]
    strips = [
        Strip(s["dut"], [roi_from_box(f"{s['dut']}.{i}", *b) for i, b in enumerate(s["boxes"])])
        for s in meta["strips"]
    ]
    res = analyse(frames[: len(fs)], fs, cam, strips, window=args.window)
    out = []
    for w in res["windows"]:
        out.append(
            {
                "t0": w["t0"],
                "t1": w["t1"],
                "skew_ms": {k: (None if v is None else v * 1e3) for k, v in w["skew_s"].items()},
            }
        )
    json.dump({"ref": res["ref"], "windows": out}, sys.stdout, indent=1)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
