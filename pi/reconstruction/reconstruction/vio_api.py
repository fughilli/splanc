"""Visual-inertial reconstruction from wire-format inputs (§7.4 + imu_batch).

The production entry point for the WebXR-free capture path
(docs/vio-exploration.md phase 4): takes DetectionRecord-shaped mappings
whose ``pose`` may be null and the session's ImuSample stream, groups the
records into per-frame observations, runs the joint pose+LED solver
(vio.solve_vio), and assembles a §7.5 OutputMap with the same per-LED quality
conventions the pose-trusting reconstructor uses.

The output map's ``frame`` is ``gravity_leveled``: the solver's gauge is
re-based so -Y is the measured gravity direction — metric and level by
construction, origin/yaw arbitrary.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Iterable, List, Mapping, Optional, Sequence

import numpy as np

from ledmapper_protocol import LedEntry, OutputMap, OutputMapStats

from .api import _confidence
from .triangulate import max_parallax_deg
from .vio import FrameObservations, GRAVITY, ImuSample, ProgressCb, VioResult, solve_vio


def decimate_path(positions: np.ndarray, max_points: int = 240) -> list:
    """Chronological camera centers, evenly strided to a display-sized
    polyline (§7.5 OutputMap.trajectory / solve_status.trajectory)."""
    pts = np.asarray(positions, dtype=float)
    if len(pts) > max_points:
        idx = np.linspace(0, len(pts) - 1, max_points).round().astype(int)
        pts = pts[idx]
    return [[float(c) for c in p] for p in pts]


def _as_plain(rec: Mapping) -> Mapping:
    return rec if isinstance(rec, Mapping) else rec.model_dump()


def frames_from_records(
    detections: Iterable[Mapping],
    *,
    max_keyframes: Optional[int] = None,
) -> List[FrameObservations]:
    """Group §7.4 records into per-frame observation sets by tCaptureMs.

    Records from one pipeline step share their frame's timestamp exactly, so
    grouping needs no tolerance. ``max_keyframes`` evenly strides the frames
    (the live solver's cost bound); all of a kept frame's observations stay.
    """
    by_t: dict = {}
    for rec in detections:
        rec = _as_plain(rec)
        by_t.setdefault(float(rec["tCaptureMs"]), []).append(rec)
    times = sorted(by_t.keys())
    if max_keyframes is not None and len(times) > max_keyframes:
        idx = np.linspace(0, len(times) - 1, max_keyframes).round().astype(int)
        times = [times[i] for i in sorted(set(idx.tolist()))]
    frames = []
    for t in times:
        recs = by_t[t]
        frames.append(
            FrameObservations(
                t=t / 1000.0,
                k=tuple(float(x) for x in recs[0]["K"]),
                obs=[(int(r["ledId"]), float(r["u"]), float(r["v"])) for r in recs],
            )
        )
    return frames


def imu_from_wire(samples: Iterable[Mapping]) -> List[ImuSample]:
    out = [
        ImuSample(
            t=float(s["t"]) / 1000.0,
            gyro=np.asarray(s["gyro"], dtype=float),
            accel=np.asarray(s["accel"], dtype=float),
        )
        for s in (_as_plain(s) for s in samples)
    ]
    out.sort(key=lambda s: s.t)
    return out


def _gravity_leveled(result: VioResult):
    """Rotate the solution so the estimated gravity is exactly -Y."""
    g = result.gravity
    gn = g / (np.linalg.norm(g) + 1e-12)
    target = np.array([0.0, -1.0, 0.0])
    v = np.cross(gn, target)
    s = float(np.linalg.norm(v))
    c = float(np.dot(gn, target))
    if s < 1e-12:
        rot = np.eye(3) if c > 0 else np.diag([1.0, -1.0, -1.0])
    else:
        vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
        rot = np.eye(3) + vx + vx @ vx * ((1 - c) / (s * s))
    return {led: rot @ x for led, x in result.led_positions.items()}, rot


def reconstruct_vio(
    detections: Sequence[Mapping],
    imu_samples: Sequence[Mapping],
    *,
    led_count: Optional[int] = None,
    map_id: Optional[str] = None,
    created_at: Optional[str] = None,
    max_keyframes: Optional[int] = 250,
    max_nfev: int = 80,
    px_sigma: float = 1.0,
    refine_intrinsics: bool = True,
    min_views: int = 2,
    progress_cb: Optional[ProgressCb] = None,
) -> OutputMap:
    """Solve LED positions (and, internally, the camera trajectory) from
    pose-less detection records + the session IMU stream.

    ``progress_cb`` (optional) receives throttled optimizer snapshots — see
    vio.ProgressCb; called from the solver thread."""
    frames = frames_from_records(detections, max_keyframes=max_keyframes)
    imu = imu_from_wire(imu_samples)
    if len(frames) < 8:
        raise ValueError(f"too few observation frames for a VIO solve ({len(frames)})")
    if len(imu) < 30:
        raise ValueError(f"too few IMU samples for a VIO solve ({len(imu)})")

    result = solve_vio(
        frames,
        imu,
        px_sigma=px_sigma,
        max_nfev=max_nfev,
        refine_intrinsics=refine_intrinsics,
        progress_cb=progress_cb,
    )
    leveled, rot = _gravity_leveled(result)

    # Per-LED quality, mirroring api.reconstruct's conventions: view count,
    # reprojection rms (recomputed against the solved trajectory), max
    # parallax over the observing rays, and the shared confidence heuristic.
    from .camera import quat_to_rotmat

    id_frames: dict = {}
    sq_err: dict = {}
    dirs: dict = {}
    if result.intrinsics is not None:
        fx, fy, cx, cy = result.intrinsics
    for fi, fr in enumerate(frames):
        r = quat_to_rotmat(result.quats[fi])
        p = result.positions[fi]
        if result.intrinsics is None:
            fx, fy, cx, cy = fr.k
        for led, u, v in fr.obs:
            x = result.led_positions.get(led)
            if x is None:
                continue
            xc = r.T @ (x - p)
            depth = -xc[2]
            if depth <= 1e-6:
                continue
            uu = cx + fx * xc[0] / depth
            vv = cy - fy * xc[1] / depth
            sq_err.setdefault(led, []).append((uu - u) ** 2 + (vv - v) ** 2)
            id_frames.setdefault(led, 0)
            id_frames[led] += 1
            ray = (x - p) / (np.linalg.norm(x - p) + 1e-12)
            dirs.setdefault(led, []).append(ray)

    entries: List[LedEntry] = []
    parallaxes: List[float] = []
    solved_ids = set()
    for led in sorted(leveled.keys()):
        n_views = id_frames.get(led, 0)
        if n_views < min_views:
            continue
        rms = float(np.sqrt(np.mean(sq_err[led])))
        par = max_parallax_deg(np.asarray(dirs[led]))
        parallaxes.append(par)
        solved_ids.add(led)
        entries.append(
            LedEntry(
                id=led,
                xyz=tuple(float(c) for c in leveled[led]),
                confidence=_confidence(par, n_views, rms),
                nViews=n_views,
                rmsReprojPx=rms,
                parallaxDeg=par,
            )
        )

    if led_count is None:
        led_count = (max(leveled.keys()) + 1) if leveled else 0
    unmapped = sorted(set(range(led_count)) - solved_ids)
    return OutputMap(
        mapId=map_id or str(uuid.uuid4()),
        createdAt=created_at
        or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        units="meters",
        frame="gravity_leveled",
        ledCount=led_count,
        leds=entries,
        unmapped=unmapped,
        trajectory=decimate_path((rot @ result.positions.T).T),
        stats=OutputMapStats(
            rmsReprojPxGlobal=result.rms_reproj_px,
            medianParallaxDeg=float(np.median(parallaxes)) if parallaxes else 0.0,
        ),
    )


def has_pose(rec: Mapping) -> bool:
    rec = _as_plain(rec)
    return rec.get("pose") is not None


def gravity_magnitude_ok(result_g: np.ndarray, tol: float = 0.5) -> bool:
    return abs(float(np.linalg.norm(result_g)) - GRAVITY) < tol
