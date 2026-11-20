"""Synthetic mesh display + camera model, for testing flip_cv and stating its accuracy
(docs/design/mesh-hitl-rig.md §7.5).

DUT model: frames rendered on a grid of the DUT's own epoch (80 fps by default), each
latched to the LEDs at camera time  offset(t) + n * Tr * (1 + drift) + jitter_n + latency.
Frame n shows meshFlipClock.fx evaluated at pattern time n * Tr. Optional: a per-flip
turn-on delay (WS2812 PWM restart), uniform in [0, 1 / pwm_hz).

Camera model: frame j's row r integrates over [s_j + r * line_time, + exposure],
s_j = t0 + j * T * (1 + ppm * 1e-6) + start jitter. Signal = gain * fraction + dark,
with shot noise (full-well scaled), read noise, gamma, saturation and 8-bit
quantisation; optionally MJPEG round trip (OpenCV) for the frame path.
"""

from __future__ import annotations

import dataclasses
from typing import Callable, Sequence

import numpy as np
from flip_cv import PATTERN, RENDER_HZ


@dataclasses.dataclass
class DutModel:
    name: str
    offset: float = 0.0  # s: display time minus camera time origin (the skew knob)
    drift_ppm: float = 0.0
    render_fps: float = 80.0
    jitter: float = 0.0  # s: uniform [0, jitter) added to each frame's latch time
    latency: float = 0.0  # s: constant render->light latency
    pwm_hz: float | None = None  # per-rising-flip delay uniform [0, 1/pwm_hz)
    offset_fn: Callable[[np.ndarray], np.ndarray] | None = None  # extra offset vs time
    events: Sequence[tuple[float, int]] = ()  # (pattern time, ev value) for LED 2

    def frames(self, t0: float, t1: float, rng: np.random.Generator):
        """(latch times, pattern times) of the frames overlapping [t0, t1]."""
        tr = 1.0 / self.render_fps
        scale = 1.0 + self.drift_ppm * 1e-6
        n0 = int(np.floor((t0 - self.offset - 0.1) / (tr * scale))) - 2
        n1 = int(np.ceil((t1 - self.offset + 0.1) / (tr * scale))) + 2
        n = np.arange(n0, n1 + 1)
        pt = n * tr
        lt = self.offset + pt * scale + self.latency
        if self.offset_fn is not None:
            lt = lt + self.offset_fn(lt)
        if self.jitter > 0:
            lt = lt + rng.uniform(0, self.jitter, size=lt.size)
        lt = np.maximum.accumulate(lt)  # frames never latch out of order
        return lt, pt, n

    def led_states(self, n: np.ndarray, led: int) -> np.ndarray:
        """meshFlipClock.fx: m = floor(time * 80 + 0.01); LED 0 on for m mod 5 < 2,
        LED 1 for floor(m / 16) even, LED 2 for floor(m / 128) + ev even."""
        pt = n / self.render_fps
        m = np.floor(pt * RENDER_HZ + 0.01).astype(np.int64)
        P, D = PATTERN[led]
        per, on = int(round(P * RENDER_HZ)), int(round(D * RENDER_HZ))
        k = (m % per) < on
        if led == 2 and self.events:
            ev = np.zeros(n.shape, dtype=bool)
            for t_ev, v in sorted(self.events):
                ev[pt >= t_ev - 1e-9] = bool(v)
            k = k ^ ev
        return k.astype(np.float64)


def on_fraction(
    latch: np.ndarray,
    state: np.ndarray,
    starts: np.ndarray,
    exposure: float,
    rising_delay: np.ndarray | None = None,
) -> np.ndarray:
    """Exact fraction of [s, s + E] the LED is on, for a piecewise-constant state
    that takes value state[k] from latch[k] until latch[k + 1]."""
    lt = latch.astype(np.float64)
    st = state.astype(np.float64)
    if rising_delay is not None:
        # a rising flip lights rising_delay later: insert an off segment
        rise = np.nonzero((st[1:] > st[:-1]))[0] + 1
        d = rising_delay[: rise.size]
        lt2 = np.concatenate([lt, lt[rise] + d])
        st2 = np.concatenate([st, st[rise]])
        st2[rise] = 0.0  # the latch instant itself still shows off
        order = np.argsort(lt2, kind="stable")
        lt, st = lt2[order], st2[order]
    seg = np.diff(lt)
    cum = np.concatenate([[0.0], np.cumsum(st[:-1] * seg)])

    def C(t):
        k = np.clip(np.searchsorted(lt, t, side="right") - 1, 0, lt.size - 1)
        return cum[k] + st[k] * (t - lt[k])

    return (C(starts + exposure) - C(starts)) / exposure


@dataclasses.dataclass
class CameraModel:
    fps: float = 120.0
    exposure: float | None = None  # default: 0.95 / fps
    line_time: float = 0.0
    ppm: float = 0.0
    start_jitter: float = 0.0  # s rms per frame (sensor timing), common to all rows
    full_well: float = 4000.0  # electrons at the on level (per pixel)
    read_noise: float = 4.0  # electrons rms
    gamma: float = 1.0  # sensor-side gamma (1 = linear)
    on_level: float = 200.0  # 8-bit level of a fully-on LED (before gamma)
    dark_level: float = 12.0
    blur_px: float = 1.8  # LED spot sigma
    jpeg_quality: int | None = None

    @property
    def E(self) -> float:
        return self.exposure if self.exposure is not None else 0.95 / self.fps

    def frame_starts(self, duration: float, rng: np.random.Generator, t0: float = 0.0):
        n = int(duration * self.fps)
        T = (1.0 + self.ppm * 1e-6) / self.fps
        s = t0 + np.arange(n) * T
        if self.start_jitter:
            s = s + rng.normal(0, self.start_jitter, size=n)
        return s

    def sensor(self, frac: np.ndarray, area: float, rng: np.random.Generator) -> np.ndarray:
        """ROI-mean level for an on-fraction series (area = pixels in the ROI)."""
        e = frac * self.full_well
        noise = np.sqrt(np.maximum(e, 0) + self.read_noise**2) / np.sqrt(area)
        e = e + rng.normal(0, 1, size=frac.shape) * noise
        lin = np.clip(e / self.full_well, 0, None)
        return self._encode(lin)

    def _encode(self, lin: np.ndarray) -> np.ndarray:
        v = lin * (self.on_level - self.dark_level) / 255.0 + self.dark_level / 255.0
        v = np.clip(v, 0, 1) ** (1.0 / self.gamma)
        return v * 255.0


def series(
    duts: Sequence[DutModel],
    cam: CameraModel,
    duration: float,
    rng: np.random.Generator,
    area: float = 40.0,
    rows: dict | None = None,
    t0: float = 0.0,
    row0: int = 0,
):
    """Fast path: ROI-mean series per (dut, led) without rendering images.
    Returns (frame_start, {(dut, led): series}, truth) where truth[(dut, led)] is the
    list of true flip instants (camera time) with polarity."""
    s = cam.frame_starts(duration, rng, t0)
    out, truth = {}, {}
    for d in duts:
        lt, pt, n = d.frames(s[0] - 1.0, s[-1] + 1.0, rng)
        for led in range(3):
            st = d.led_states(n, led)
            rd = None
            if d.pwm_hz:
                rd = rng.uniform(0, 1.0 / d.pwm_hz, size=lt.size)
            row = (rows or {}).get((d.name, led), row0)
            starts = s + (row - row0) * cam.line_time
            frac = on_fraction(lt, st, starts, cam.E, rd)
            out[(d.name, led)] = cam.sensor(frac, area, rng)
            ch = np.nonzero(np.diff(st))[0] + 1
            tt = lt[ch].copy()
            if rd is not None:
                rise = st[ch] > 0
                rise_idx = np.nonzero(np.diff(st) > 0)[0] + 1
                delays = dict(zip(rise_idx.tolist(), rd[: rise_idx.size].tolist()))
                tt = np.array(
                    [t + (delays.get(int(k), 0.0) if r else 0.0) for t, k, r in zip(tt, ch, rise)]
                )
            truth[(d.name, led)] = list(zip(tt.tolist(), (st[ch] > 0).tolist()))
    return s, out, truth


def render_frames(
    duts: Sequence[DutModel],
    layout: dict,
    cam: CameraModel,
    duration: float,
    rng: np.random.Generator,
    size=(120, 160),
    t0: float = 0.0,
):
    """Full images: layout[(dut, led)] = (x, y) pixel centre of that LED's spot.
    Rolling shutter: each image row integrates at its own offset. Returns
    (frames uint8 [n, h, w], frame_start)."""
    import cv2

    h, w = size
    s = cam.frame_starts(duration, rng, t0)
    img = np.zeros((s.size, h, w), dtype=np.float64)
    yy, xx = np.mgrid[0:h, 0:w]
    for d in duts:
        lt, pt, n = d.frames(s[0] - 1.0, s[-1] + 1.0, rng)
        for led in range(3):
            x0, y0 = layout[(d.name, led)]
            st = d.led_states(n, led)
            spot = np.exp(-((xx - x0) ** 2 + (yy - y0) ** 2) / (2 * cam.blur_px**2))
            rows = np.nonzero(spot.max(axis=1) > 1e-3)[0]
            for r in rows:
                frac = on_fraction(lt, st, s + r * cam.line_time, cam.E)
                img[:, r, :] += frac[:, None] * spot[r][None, :]
    e = np.clip(img, 0, 1.2) * cam.full_well
    e = e + rng.normal(0, 1, size=e.shape) * np.sqrt(np.maximum(e, 0) + cam.read_noise**2)
    v = cam._encode(np.clip(e / cam.full_well, 0, None))
    frames = np.clip(np.round(v), 0, 255).astype(np.uint8)
    if cam.jpeg_quality:
        for j in range(frames.shape[0]):
            ok, buf = cv2.imencode(".jpg", frames[j], [cv2.IMWRITE_JPEG_QUALITY, cam.jpeg_quality])
            frames[j] = cv2.imdecode(buf, cv2.IMREAD_GRAYSCALE)
    return frames, s


def write_mjpeg(path: str, frames: np.ndarray, fps: float, quality: int = 90) -> None:
    """A recorded-video stand-in: an MJPEG AVI like a UVC camera's `-c copy` capture."""
    import cv2

    h, w = frames.shape[1:3]
    vw = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*"MJPG"), fps, (w, h), isColor=True)
    vw.set(cv2.VIDEOWRITER_PROP_QUALITY, quality)
    for f in frames:
        vw.write(cv2.cvtColor(f, cv2.COLOR_GRAY2BGR))
    vw.release()
