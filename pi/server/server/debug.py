"""Solver diagnostics (dev-only HTTP surface, not part of the §7 contract).

Built to study why a solve does or doesn't converge, one LED at a time:
``led_report`` turns the raw observations of a single LED into the quantities
a human (or agent) inspects qualitatively —

  * every observation with its back-projected ray, camera speed at capture,
    and reprojection residual against BOTH the DLT-triangulated point and the
    latest live-solved point;
  * ray-bundle geometry: parallax spread, mean ray↔point miss distance;
  * residual↔camera-speed correlation — the smoking gun for camera-to-pose
    latency (pose sampled at display time, image exposed earlier: residuals
    grow with motion);
  * the continuous solver's per-LED history (does the estimate converge,
    wander, or jump — jumps suggest mis-identified detections mixing in).

Wired to ``GET /debug/led/{id}`` and ``GET /debug/session`` in app.py. Reads
the active session, falling back to the most recently persisted session log.
"""

from __future__ import annotations

import math
from typing import List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ledmapper_protocol import OutputMap

from reconstruction.api import _as_obs
from reconstruction.camera import project
from reconstruction.triangulate import max_parallax_deg, rays_from_observations, triangulate_point

# Keep report payloads bounded however long the walk was.
MAX_OBS_IN_REPORT = 240


def _speeds_mps(obs: Sequence[dict], times_ms: Sequence[float]) -> List[float]:
    """Finite-difference camera speed at each observation, m/s."""
    n = len(obs)
    if n < 2:
        return [0.0] * n
    speeds = [0.0] * n
    for i in range(n):
        j = max(0, i - 1)
        k = min(n - 1, i + 1)
        dt = (times_ms[k] - times_ms[j]) / 1000.0
        if dt <= 0:
            continue
        a = np.asarray(obs[j]["p"])
        b = np.asarray(obs[k]["p"])
        speeds[i] = float(np.linalg.norm(b - a) / dt)
    return speeds


def _residuals_px(obs: Sequence[dict], xyz: Optional[np.ndarray]) -> List[Optional[float]]:
    if xyz is None:
        return [None] * len(obs)
    out: List[Optional[float]] = []
    for o in obs:
        uv, depth = project(o["p"], o["q"], o["K"], xyz)
        if depth <= 0:
            out.append(None)
            continue
        out.append(float(math.hypot(uv[0] - o["u"], uv[1] - o["v"])))
    return out


def _pearson(xs: List[float], ys: List[float]) -> Optional[float]:
    pairs = [(x, y) for x, y in zip(xs, ys) if y is not None]
    if len(pairs) < 3:
        return None
    x = np.asarray([p[0] for p in pairs])
    y = np.asarray([p[1] for p in pairs])
    if float(np.std(x)) < 1e-9 or float(np.std(y)) < 1e-9:
        return None
    return float(np.corrcoef(x, y)[0, 1])


def _stats(values: List[Optional[float]]) -> Optional[dict]:
    vals = [v for v in values if v is not None]
    if not vals:
        return None
    arr = np.asarray(vals)
    return {
        "mean": float(arr.mean()),
        "p50": float(np.percentile(arr, 50)),
        "p90": float(np.percentile(arr, 90)),
        "max": float(arr.max()),
    }


def _decimate_indices(n: int, cap: int) -> List[int]:
    if n <= cap:
        return list(range(n))
    step = (n - 1) / (cap - 1)
    return [round(i * step) for i in range(cap)]


def led_report(
    detections: Sequence[Mapping],
    led_id: int,
    live_map: Optional[OutputMap],
    history: Sequence[Tuple[float, int, OutputMap]],
) -> dict:
    """Full diagnostic report for one LED. See module docstring."""
    mine = [d for d in detections if _led_of(d) == led_id]
    times = [_t_of(d) for d in mine]
    order = np.argsort(times) if mine else []
    mine = [mine[i] for i in order]
    times = [times[i] for i in order]
    obs = [_as_obs(d) for d in mine]

    report: dict = {
        "ledId": led_id,
        "nObservations": len(obs),
        "timeSpanMs": (times[-1] - times[0]) if len(times) >= 2 else 0.0,
    }
    if not obs:
        report["note"] = "no observations of this LED in the session"
        return report

    # -- ray geometry ------------------------------------------------------
    origins, dirs = rays_from_observations(obs)
    tri: Optional[np.ndarray] = None
    if len(obs) >= 2:
        try:
            tri = triangulate_point(origins, dirs)
            if not np.all(np.isfinite(tri)):
                tri = None
        except (ValueError, np.linalg.LinAlgError):
            tri = None

    live_entry = None
    live_xyz: Optional[np.ndarray] = None
    if live_map is not None:
        for e in live_map.leds:
            if e.id == led_id:
                live_entry = {
                    "xyz": list(e.xyz),
                    "confidence": e.confidence,
                    "nViews": e.nViews,
                    "rmsReprojPx": e.rmsReprojPx,
                    "parallaxDeg": e.parallaxDeg,
                }
                live_xyz = np.asarray(e.xyz)
                break

    speeds = _speeds_mps(obs, times)
    resid_tri = _residuals_px(obs, tri)
    resid_live = _residuals_px(obs, live_xyz)

    # Ray↔point miss distance: how far each ray passes from the DLT point.
    miss_m: List[Optional[float]] = [None] * len(obs)
    if tri is not None:
        for i, (o, d) in enumerate(zip(origins, dirs)):
            to_p = tri - o
            miss_m[i] = float(np.linalg.norm(to_p - np.dot(to_p, d) * d))

    keep = _decimate_indices(len(obs), MAX_OBS_IN_REPORT)
    report["observations"] = [
        {
            "t": times[i],
            "u": obs[i]["u"],
            "v": obs[i]["v"],
            "confidence": float(mine[i]["confidence"]) if isinstance(mine[i], Mapping) else float(mine[i].confidence),
            "p": obs[i]["p"],
            "q": obs[i]["q"],
            "K": obs[i]["K"],
            "speedMps": speeds[i],
            "rayOrigin": origins[i].tolist(),
            "rayDir": dirs[i].tolist(),
            "residualTriPx": resid_tri[i],
            "residualLivePx": resid_live[i],
            "rayMissM": miss_m[i],
        }
        for i in keep
    ]
    if len(keep) < len(obs):
        report["observationsDecimated"] = f"{len(obs)} -> {len(keep)} (even stride)"

    ps = np.asarray([o["p"] for o in obs])
    report["pose"] = {
        "pathLenM": float(np.sum(np.linalg.norm(np.diff(ps, axis=0), axis=1))) if len(ps) > 1 else 0.0,
        "bboxM": [ps.min(axis=0).tolist(), ps.max(axis=0).tolist()],
        "meanSpeedMps": float(np.mean(speeds)),
        "maxSpeedMps": float(np.max(speeds)),
    }
    unit = dirs / np.linalg.norm(dirs, axis=1, keepdims=True)
    cos = np.clip(unit @ unit.T, -1.0, 1.0)
    iu = np.triu_indices(len(obs), k=1)
    pair_angles = np.degrees(np.arccos(cos[iu])) if iu[0].size else np.zeros(0)
    report["geometry"] = {
        "triangulated": tri.tolist() if tri is not None else None,
        "maxParallaxDeg": max_parallax_deg(dirs),
        "medianPairwiseParallaxDeg": float(np.median(pair_angles)) if pair_angles.size else 0.0,
        "rayMissM": _stats(miss_m),
        "residualTriPx": _stats(resid_tri),
        "residualLivePx": _stats(resid_live),
        # Positive correlation = residuals grow when the camera moves faster:
        # the classic signature of image↔pose latency.
        "residualTriVsSpeedCorr": _pearson(speeds, resid_tri),
    }
    report["live"] = live_entry

    # -- continuous-solver history for this LED -----------------------------
    hist = []
    for t_ms, n_det, m in history:
        for e in m.leds:
            if e.id == led_id:
                hist.append(
                    {"t": t_ms, "nDetections": n_det, "xyz": list(e.xyz),
                     "confidence": e.confidence, "rmsReprojPx": e.rmsReprojPx,
                     "parallaxDeg": e.parallaxDeg}
                )
                break
    report["solveHistory"] = hist
    if len(hist) >= 2:
        xyzs = np.asarray([h["xyz"] for h in hist])
        steps = np.linalg.norm(np.diff(xyzs, axis=0), axis=1)
        report["solveJitter"] = {
            "stdM": xyzs.std(axis=0).tolist(),
            "meanStepM": float(steps.mean()),
            "maxStepM": float(steps.max()),
            "lastStepM": float(steps[-1]),
        }
    return report


def session_overview(detections: Sequence[Mapping], led_count: Optional[int]) -> dict:
    """Coarse whole-session summary: who was seen, how much, from where."""
    by_led: dict = {}
    ps = []
    t0 = math.inf
    t1 = -math.inf
    for d in detections:
        by_led[_led_of(d)] = by_led.get(_led_of(d), 0) + 1
        o = _as_obs(d)
        ps.append(o["p"])
        t = _t_of(d)
        t0 = min(t0, t)
        t1 = max(t1, t)
    ps_arr = np.asarray(ps) if ps else np.zeros((0, 3))
    counts = sorted(by_led.items())
    return {
        "ledCount": led_count,
        "nDetections": len(detections),
        "ledsSeen": len(by_led),
        "timeSpanMs": (t1 - t0) if ps else 0.0,
        "posePathLenM": float(np.sum(np.linalg.norm(np.diff(ps_arr, axis=0), axis=1))) if len(ps_arr) > 1 else 0.0,
        "poseBboxM": [ps_arr.min(axis=0).tolist(), ps_arr.max(axis=0).tolist()] if len(ps_arr) else None,
        "viewsPerLed": {str(k): v for k, v in counts},
    }


def _led_of(d: Mapping) -> int:
    return int(d["ledId"]) if isinstance(d, Mapping) else int(d.ledId)


def _t_of(d: Mapping) -> float:
    return float(d["tCaptureMs"]) if isinstance(d, Mapping) else float(d.tCaptureMs)
