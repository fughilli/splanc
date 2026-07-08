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

import logging
import uuid
from datetime import datetime, timezone
from typing import Iterable, List, Mapping, Optional, Sequence, Tuple

import numpy as np

from ledmapper_protocol import LedEntry, OutputMap, OutputMapStats

from .api import _confidence, _consensus_filter
from .triangulate import max_parallax_deg
from .vio import FrameObservations, GRAVITY, ImuSample, ProgressCb, VioResult, solve_vio

_log = logging.getLogger(__name__)


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


def keep_dominant_segment(
    frames: List[FrameObservations], gap_split_s: float = 3.0
) -> Tuple[List[FrameObservations], int]:
    """Split the observation timeline on gaps longer than ``gap_split_s`` and
    keep the segment with the most observations.

    Rationale: across an observation gap the solver has only IMU dead
    reckoning, whose drift grows quadratically — a multi-second gap makes the
    segments effectively independent, and the forced stitch shows up as
    trajectory discontinuities at the seam and a warped map (measured on the
    2026-07-08 trace: a 17 s gap produced multi-cm path jumps). A short
    stray prefix/suffix carries far less information than the damage it does.

    Returns (kept frames, dropped observation count).
    """
    if len(frames) < 2:
        return frames, 0
    segments: List[List[FrameObservations]] = [[frames[0]]]
    for prev, cur in zip(frames, frames[1:]):
        if cur.t - prev.t > gap_split_s:
            segments.append([])
        segments[-1].append(cur)
    if len(segments) == 1:
        return frames, 0
    best = max(segments, key=lambda seg: sum(len(f.obs) for f in seg))
    dropped = sum(len(f.obs) for seg in segments if seg is not best for f in seg)
    return best, dropped


def reject_outlier_observations(
    frames: List[FrameObservations],
    result: VioResult,
    *,
    outlier_sigma: float = 4.0,
    floor_px: float = 3.0,
) -> Tuple[List[FrameObservations], int]:
    """Per-observation rejection against the solved TRAJECTORY (not the
    solved LED points), in two per-LED stages:

    1. CONSENSUS (api._consensus_filter with the solved poses): a coasting
       track stuck on a reflection emits a time-contiguous, internally
       near-consistent cluster of wrong observations; mode-seeking picks the
       cluster that agrees on one 3D point. Engages only for LEDs whose
       bundle looks contaminated.
    2. RE-TRIANGULATE + MAD prune: residuals are measured against a fresh
       DLT triangulation of each LED's surviving observations — NOT against
       the (still biased) solved LED position, which would evict the good
       majority of a contaminated LED (measured: 58 of 64 good views lost).
       Global MAD threshold (``outlier_sigma × 1.4826·MAD``, floored) over
       those residuals prunes the leftovers.

    A robust loss alone cannot substitute: it BOUNDS outlier influence at a
    constant, so the estimate stays biased however many good views arrive
    (observed live: led 0 stuck at ~100 px rms).

    Returns (filtered frames, dropped observation count).
    """
    from .camera import quat_to_rotmat  # noqa: F401  (api helpers use it)
    from .triangulate import rays_from_observations, triangulate_point

    def reproj_errs(obs_list: List[dict], x: np.ndarray) -> np.ndarray:
        rot = np.stack([quat_to_rotmat(o["q"]) for o in obs_list])
        ps = np.asarray([o["p"] for o in obs_list])
        ks = np.asarray([o["K"] for o in obs_list])
        uvs = np.asarray([[o["u"], o["v"]] for o in obs_list])
        xc = np.einsum("nji,nj->ni", rot, x - ps)
        depth = -xc[:, 2]
        safe = np.where(np.abs(depth) < 1e-12, 1e-12, depth)
        u = ks[:, 2] + ks[:, 0] * xc[:, 0] / safe
        v = ks[:, 3] - ks[:, 1] * xc[:, 1] / safe
        e = np.hypot(u - uvs[:, 0], v - uvs[:, 1])
        e[depth <= 0] = np.inf
        return e

    by_led: dict = {}
    total = 0
    for fi, fr in enumerate(frames):
        for oi, (led, u, v) in enumerate(fr.obs):
            total += 1
            by_led.setdefault(led, []).append(
                {
                    "u": u,
                    "v": v,
                    "K": list(result.intrinsics) if result.intrinsics is not None else list(fr.k),
                    "p": [float(c) for c in result.positions[fi]],
                    "q": [float(c) for c in result.quats[fi]],
                    "_key": (fi, oi),
                }
            )

    # Session-adaptive gates: scale off the GLOBAL median residual against
    # the solved LED positions. The median is robust to a contaminated
    # minority and captures the session's SYSTEMATIC noise floor (rolling
    # shutter, timing jitter) — fixed constants failed both ways: the classic
    # 40 px engage gate (tuned for WebXR pose noise) let a coherent ~60 px
    # reflection cluster pass as healthy, while a fixed 8 px gate gutted a
    # session whose honest floor was ~5 px.
    all_errs: List[float] = []
    for led, obs_list in by_led.items():
        x_solved = result.led_positions.get(led)
        if x_solved is None:
            continue
        all_errs.extend(float(e) for e in reproj_errs(obs_list, x_solved) if np.isfinite(e))
    global_med = float(np.median(all_errs)) if all_errs else 1.0
    engage_p90_px = max(4.0 * global_med, 8.0)
    inlier_px = max(3.0 * global_med, 6.0)
    floor = max(floor_px, 2.0 * global_med)

    keyed_errs: List[Tuple[Tuple[int, int], float]] = []
    for led, obs_list in by_led.items():
        survivors = _consensus_filter(
            obs_list, min_views=2, engage_p90_px=engage_p90_px, inlier_px=inlier_px
        )
        if len(survivors) < 2:
            continue  # keys absent -> observations dropped
        try:
            origins, dirs = rays_from_observations(survivors)
            x = triangulate_point(origins, dirs)
            errs = reproj_errs(survivors, x)
        except (ValueError, np.linalg.LinAlgError):
            errs = np.zeros(len(survivors))  # can't judge: keep, next round decides
        for o, e in zip(survivors, errs):
            keyed_errs.append((o["_key"], float(e)))

    if not keyed_errs:
        return frames, 0
    arr = np.array([e for _k, e in keyed_errs])
    finite = arr[np.isfinite(arr)]
    med = float(np.median(finite)) if len(finite) else 0.0
    mad = float(np.median(np.abs(finite - med))) if len(finite) else 0.0
    threshold = max(outlier_sigma * 1.4826 * mad, floor)
    # Safety valve: a threshold that wants to reject more than a quarter of
    # the session says the STATISTICS are broken (a poorly converged first
    # solve, a systematic error we mis-modeled), not that 25%+ of the data
    # is junk — cap the round at the worst quartile and let the next
    # iteration re-judge against the improved solve.
    if len(finite) and float(np.mean(arr > threshold)) > 0.25:
        threshold = float(np.percentile(finite, 75.0))
    keep_keys = {k for k, e in keyed_errs if e <= threshold}

    kept: List[FrameObservations] = []
    dropped = 0
    for fi, fr in enumerate(frames):
        obs = [o for oi, o in enumerate(fr.obs) if (fi, oi) in keep_keys]
        dropped += len(fr.obs) - len(obs)
        if obs:
            kept.append(FrameObservations(t=fr.t, k=fr.k, obs=obs))
    return kept, dropped


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
    max_nfev: int = 60,
    px_sigma: float = 1.0,
    # Default OFF: fx trades ~1:1 against metric scale with weak
    # observability (measured — vio_test's fx/scale probe), so a floating K
    # is a scale-drift channel. The client supplies a calibrated K (a WebXR
    # session's cached intrinsics) or an explicit ?fx=; refinement remains
    # available for calibration studies.
    refine_intrinsics: bool = False,
    min_views: int = 2,
    progress_cb: Optional[ProgressCb] = None,
    gap_split_s: float = 3.0,
    reject_outliers: bool = True,
    outlier_sigma: float = 4.0,
) -> OutputMap:
    """Solve LED positions (and, internally, the camera trajectory) from
    pose-less detection records + the session IMU stream.

    ``progress_cb`` (optional) receives throttled optimizer snapshots — see
    vio.ProgressCb; called from the solver thread."""
    frames = frames_from_records(detections, max_keyframes=max_keyframes)
    imu = imu_from_wire(imu_samples)
    # Dead-reckoning-only stretches make observation segments effectively
    # independent — keep the dominant one instead of stitching across.
    frames, gap_dropped = keep_dominant_segment(frames, gap_split_s=gap_split_s)
    if gap_dropped:
        _log.info("vio: dropped %d observations outside the dominant segment", gap_dropped)
        # Trim the IMU to the kept span: samples outside it are dead weight,
        # and the rotation seeds anchor gravity on the accel average around
        # the FIRST frame — 20 s of pre-segment walking data in that window
        # produced a bad attitude seed and a collapsed solve on the
        # 2026-07-08 gap session. (A small lead-in keeps preintegrate()'s
        # held-rate semantics at the first interval intact.)
        t0, t1 = frames[0].t - 0.25, frames[-1].t + 0.05
        imu = [s for s in imu if t0 <= s.t <= t1]
        _log.info(
            "vio: kept segment %.2f..%.2f s with %d IMU samples", frames[0].t, frames[-1].t, len(imu)
        )
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

    # Outlier prune + re-solve: mislabeled dense-stream samples bias LED
    # estimates through the robust loss forever; one MAD-thresholded rejection
    # round against the first solution removes them (design doc §8.3 step 3,
    # applied to the joint problem).
    if reject_outliers:
        # Iterate: the first solve's estimate is dragged by the outliers, so
        # one round's threshold can miss borderline ones — re-prune against
        # each cleaner solution until the prune goes quiet (≤3 rounds). Keep
        # the best (most LEDs, then lowest rms) state seen: a round that
        # makes things WORSE (over-prune, degenerate re-solve) is rolled
        # back, so rejection can only improve on the plain solve.
        def score(res):
            return (len(res.led_positions), -res.rms_reproj_px)

        best_result, best_frames = result, frames
        for _round in range(3):
            kept, outliers_dropped = reject_outlier_observations(
                frames, result, outlier_sigma=outlier_sigma
            )
            if outliers_dropped == 0 or len(kept) < 8:
                break
            _log.info("vio: rejected %d outlier observations; re-solving", outliers_dropped)
            frames = kept
            # Warm-started re-solve. The FIRST one gets a real budget — a
            # de-contaminated LED may need to travel centimeters from its
            # biased warm-start position; later rounds only settle the tail.
            first_resolve = _round == 0
            result = solve_vio(
                frames,
                imu,
                px_sigma=px_sigma,
                max_nfev=max(30, max_nfev // 2) if first_resolve else max(15, max_nfev // 4),
                refine_intrinsics=refine_intrinsics,
                progress_cb=progress_cb,
                warm_start=result,
                # Near the optimum a tight ftol makes TRF burn a Jacobian per
                # micro-step; the prune loop only needs "settled".
                ftol=1e-5 if first_resolve else 1e-4,
            )
            if score(result) > score(best_result):
                best_result, best_frames = result, frames
        if score(best_result) > score(result):
            _log.info(
                "vio: rejection round regressed (%d leds @ %.1f px); keeping best (%d leds @ %.1f px)",
                len(result.led_positions), result.rms_reproj_px,
                len(best_result.led_positions), best_result.rms_reproj_px,
            )
            result, frames = best_result, best_frames
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
