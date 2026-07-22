"""Reconstruction pipeline (M3, design doc §8.3).

`reconstruct()` turns a list of :class:`DetectionRecord`-shaped observations into
an :class:`OutputMap` (design doc §7.5):

  DLT triangulation init → sparse bundle adjustment (Huber) → outlier rejection
  → re-solve → per-LED quality metrics.

The result is a protocol ``OutputMap`` instance, so it is validated against the
M10 contract by construction.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Iterable, List, Mapping, Optional, Sequence

import numpy as np
from ledmapper_protocol import LedEntry, OutputMap, OutputMapStats

from .bundle import bundle_adjust
from .camera import quat_to_rotmat
from .triangulate import max_parallax_deg, rays_from_observations, triangulate_point

# Consensus pre-filter thresholds (see _consensus_filter): engage only on
# clearly contaminated bundles, accept observations within the inlier radius.
_CONSENSUS_ENGAGE_P90_PX = 40.0
_CONSENSUS_INLIER_PX = 12.0
_CONSENSUS_MAX_SEEDS = 10


def _as_obs(detection: Mapping) -> dict:
    """Normalize a DetectionRecord (dict or pydantic) into a flat obs dict."""
    if hasattr(detection, "model_dump"):
        detection = detection.model_dump()
    pose = detection["pose"]
    if pose is None:
        # Pose-less records come from the WebXR-free capture path and can
        # only be solved by the visual-inertial reconstructor
        # (vio_api.reconstruct_vio) — this solver TRUSTS poses by design.
        raise ValueError("detection record has no pose; use reconstruct_vio for pose-less sessions")
    return {
        "ledId": int(detection["ledId"]),
        "u": float(detection["u"]),
        "v": float(detection["v"]),
        "K": [float(c) for c in detection["K"]],
        "p": [float(c) for c in pose["p"]],
        "q": [float(c) for c in pose["q"]],
    }


def _group_by_led(detections: Iterable[Mapping]) -> dict:
    groups: dict = {}
    for d in detections:
        obs = _as_obs(d)
        groups.setdefault(obs["ledId"], []).append(obs)
    return groups


def _consensus_filter(
    obs_list: List[dict],
    min_views: int,
    engage_p90_px: float = _CONSENSUS_ENGAGE_P90_PX,
    inlier_px: float = _CONSENSUS_INLIER_PX,
) -> List[dict]:
    """RANSAC-style consensus pre-filter for ONE LED's observations.

    Anything that blinks the LED's code decodes as the LED — reflections, and
    (in dark scenes) exposure-pump artifacts — so an observation set can be
    dominated by points that are mutually inconsistent with any single 3D
    position. MAD outlier rejection assumes a good median and fails once bad
    views are the majority; consensus is mode-seeking instead: triangulate
    2-view candidates from spread-out observation pairs and keep the largest
    set of observations that agree (reprojection ≤ inlier radius) on one point.

    Engages only when the naive bundle looks contaminated (p90 DLT residual
    above ``_CONSENSUS_ENGAGE_P90_PX``); healthy-but-noisy bundles pass
    through untouched. Known limitation: if a single mirror reflection
    genuinely outnumbers direct sightings, the reflection wins — consensus
    picks the biggest mode, not the truest one.
    """
    n = len(obs_list)
    if n < 4:
        return obs_list
    origins, dirs = rays_from_observations(obs_list)
    rot = np.stack([quat_to_rotmat(o["q"]) for o in obs_list])  # cam->world
    ps = np.asarray([o["p"] for o in obs_list])
    ks = np.asarray([o["K"] for o in obs_list])
    uvs = np.asarray([[o["u"], o["v"]] for o in obs_list])

    def residuals(x: np.ndarray) -> np.ndarray:
        xc = np.einsum("nji,nj->ni", rot, x - ps)  # R^T (x - p), per obs
        depth = -xc[:, 2]
        safe = np.where(np.abs(depth) < 1e-12, 1e-12, depth)
        u = ks[:, 2] + ks[:, 0] * xc[:, 0] / safe
        v = ks[:, 3] - ks[:, 1] * xc[:, 1] / safe
        r = np.hypot(u - uvs[:, 0], v - uvs[:, 1])
        r[depth <= 0] = np.inf
        return r

    try:
        r_all = residuals(triangulate_point(origins, dirs))
        if np.all(np.isfinite(r_all)) and np.percentile(r_all, 90) <= engage_p90_px:
            return obs_list
    except (ValueError, np.linalg.LinAlgError):
        pass

    seeds = np.unique(np.linspace(0, n - 1, min(_CONSENSUS_MAX_SEEDS, n)).astype(int))
    best: Optional[np.ndarray] = None
    for ai in range(len(seeds)):
        for bi in range(ai + 1, len(seeds)):
            a, b = int(seeds[ai]), int(seeds[bi])
            if float(np.dot(dirs[a], dirs[b])) > 0.99995:
                continue  # near-parallel pair: depth unconstrained
            try:
                x = triangulate_point(origins[[a, b]], dirs[[a, b]])
            except (ValueError, np.linalg.LinAlgError):
                continue
            if not np.all(np.isfinite(x)):
                continue
            inliers = residuals(x) <= inlier_px
            if best is None or int(inliers.sum()) > int(best.sum()):
                best = inliers
    if best is not None and int(best.sum()) >= max(min_views, 3):
        return [obs_list[i] for i in np.flatnonzero(best)]
    return obs_list


def _confidence(parallax_deg: float, n_views: int, rms_px: float) -> float:
    """Heuristic trust score in [0, 1] from parallax, view count, and fit.

    Parallax gates hardest (depth is unobservable without it). The reprojection
    term uses a *smooth* rolloff with a forgiving scale: with camera poses held
    fixed (design doc §8.3), VIO/pose noise inflates the reprojection residual
    well beyond the true centroid error, so a tight pixel ceiling would wrongly
    zero out well-localized LEDs.
    """
    par_score = float(np.clip(parallax_deg / 15.0, 0.0, 1.0))
    view_score = float(np.clip(n_views / 8.0, 0.0, 1.0))
    rms_score = 1.0 / (1.0 + (rms_px / 4.0) ** 2)
    conf = par_score * (0.4 + 0.6 * rms_score) * (0.5 + 0.5 * view_score)
    return float(np.clip(conf, 0.0, 1.0))


def reconstruct(
    detections: Sequence[Mapping],
    *,
    led_count: Optional[int] = None,
    huber_delta: float = 1.5,
    min_views: int = 2,
    min_parallax_deg: float = 5.0,
    outlier_sigma: float = 3.0,
    outlier_floor_px: float = 1.0,
    map_id: Optional[str] = None,
    created_at: Optional[str] = None,
    initial_points: Optional[Mapping[int, Sequence[float]]] = None,
) -> OutputMap:
    """Reconstruct 3D LED positions from detection records.

    Args:
        detections: DetectionRecord-shaped mappings (or pydantic models).
        led_count: total LEDs in the fixture; used to populate ``unmapped`` with
            never-seen ids. Defaults to ``max(ledId) + 1`` over the detections.
        huber_delta: robust loss scale in pixels (design doc §12).
        min_views: minimum observations to attempt a solve.
        min_parallax_deg: below this an LED is solved but flagged low-confidence.
        outlier_sigma: drop observations whose reprojection residual exceeds
            ``outlier_sigma ×`` the robust σ (MAD) before re-solving.
        outlier_floor_px: never reject observations below this residual, so a
            near-perfect fit (tiny σ) doesn't reject good observations as noise.
        initial_points: warm start — known ``ledId → xyz`` estimates (e.g. the
            previous interim solve). Seeded LEDs skip DLT init and the bundle
            adjustment converges in a couple of iterations when the map has
            barely moved, which is what keeps the continuous solver cheap.
    """
    groups = _group_by_led(detections)
    all_ids = sorted(groups.keys())
    if led_count is None:
        led_count = (max(all_ids) + 1) if all_ids else 0

    # --- Triangulation init over LEDs with enough views -------------------
    active_ids: List[int] = []
    points0: List[np.ndarray] = []
    led_dirs: dict = {}
    unmapped: set = set()

    for led_id in all_ids:
        obs = groups[led_id]
        if len(obs) < min_views:
            unmapped.add(led_id)
            continue
        # Mode-seeking pre-filter: reflections/artifacts share the LED's code,
        # so the per-LED set can be majority-bad — beyond what the MAD-based
        # rejection below (which needs a good median) can recover from.
        obs = _consensus_filter(obs, min_views)
        groups[led_id] = obs
        if len(obs) < min_views:
            unmapped.add(led_id)
            continue
        origins, dirs = rays_from_observations(obs)
        seed = initial_points.get(led_id) if initial_points else None
        if seed is not None and np.all(np.isfinite(seed)):
            x0 = np.asarray(seed, dtype=float)
        else:
            try:
                x0 = triangulate_point(origins, dirs)
            except (ValueError, np.linalg.LinAlgError):
                unmapped.add(led_id)
                continue
            if not np.all(np.isfinite(x0)):
                unmapped.add(led_id)
                continue
        active_ids.append(led_id)
        points0.append(x0)
        led_dirs[led_id] = dirs

    if not active_ids:
        return _build_map(
            [], unmapped, led_count, map_id, created_at, global_rms=0.0, median_par=0.0
        )

    # --- Build flat observation arrays for bundle adjustment --------------
    idx_of = {led_id: i for i, led_id in enumerate(active_ids)}

    def _flatten(ids: Sequence[int]):
        pidx, op, oq, ok, ouv = [], [], [], [], []
        for led_id in ids:
            i = idx_of[led_id]
            for obs in groups[led_id]:
                pidx.append(i)
                op.append(obs["p"])
                oq.append(obs["q"])
                ok.append(obs["K"])
                ouv.append([obs["u"], obs["v"]])
        return (
            np.asarray(pidx, dtype=int),
            np.asarray(op, dtype=float),
            np.asarray(oq, dtype=float),
            np.asarray(ok, dtype=float),
            np.asarray(ouv, dtype=float),
        )

    point_idx, obs_p, obs_q, obs_k, obs_uv = _flatten(active_ids)
    points = np.asarray(points0, dtype=float)

    # --- First solve ------------------------------------------------------
    points, repro = bundle_adjust(
        points, point_idx, obs_p, obs_q, obs_k, obs_uv, huber_delta=huber_delta
    )

    # --- Outlier rejection then re-solve (design doc §8.3 step 3) ---------
    resid = repro.residuals_per_obs(points)
    med = float(np.median(resid))
    mad = float(np.median(np.abs(resid - med)))
    sigma = 1.4826 * mad
    threshold = max(outlier_sigma * sigma, outlier_floor_px)
    if not np.all(resid <= threshold):
        # Keep only inlier observations, per LED. The flat residual vector is in
        # the same order _flatten() produced it (LED-major, then per-obs), so we
        # walk it in lockstep.
        kept_groups = {led_id: [] for led_id in active_ids}
        flat_pos = 0
        for led_id in active_ids:
            for obs in groups[led_id]:
                if resid[flat_pos] <= threshold:
                    kept_groups[led_id].append(obs)
                flat_pos += 1

        survivors = [lid for lid in active_ids if len(kept_groups[lid]) >= min_views]
        for led_id in active_ids:
            if led_id not in survivors:
                unmapped.add(led_id)

        if survivors:
            # Re-solve on inliers only, warm-started from the first BA's
            # points — they are better inits than re-triangulating from
            # scratch, and the re-solve then converges in a few iterations.
            prev_points = {lid: points[idx_of[lid]] for lid in survivors}
            active_ids = survivors
            groups = kept_groups
            idx_of = {led_id: i for i, led_id in enumerate(active_ids)}
            led_dirs = {lid: rays_from_observations(groups[lid])[1] for lid in active_ids}
            points = np.asarray([prev_points[lid] for lid in active_ids], dtype=float)
            point_idx, obs_p, obs_q, obs_k, obs_uv = _flatten(active_ids)
            points, repro = bundle_adjust(
                points, point_idx, obs_p, obs_q, obs_k, obs_uv, huber_delta=huber_delta
            )
            resid = repro.residuals_per_obs(points)
        else:
            active_ids = []

    # --- Per-LED quality + map assembly ----------------------------------
    if not active_ids:
        return _build_map(
            [], unmapped, led_count, map_id, created_at, global_rms=0.0, median_par=0.0
        )

    # Per-LED residual RMS from the flat residual vector.
    led_entries: List[LedEntry] = []
    parallaxes: List[float] = []
    sq_by_led: dict = {lid: [] for lid in active_ids}
    for flat_pos, i in enumerate(point_idx):
        sq_by_led[active_ids[i]].append(resid[flat_pos] ** 2)

    for i, led_id in enumerate(active_ids):
        n_views = len(groups[led_id])
        rms = float(np.sqrt(np.mean(sq_by_led[led_id]))) if sq_by_led[led_id] else 0.0
        parallax = max_parallax_deg(led_dirs[led_id])
        parallaxes.append(parallax)
        conf = _confidence(parallax, n_views, rms)
        if parallax < min_parallax_deg:
            conf = min(conf, 0.25)  # explicit low-confidence flag (design doc §12)
        led_entries.append(
            LedEntry(
                id=led_id,
                xyz=(float(points[i, 0]), float(points[i, 1]), float(points[i, 2])),
                confidence=conf,
                nViews=n_views,
                rmsReprojPx=rms,
                parallaxDeg=parallax,
            )
        )

    global_rms = float(np.sqrt(np.mean(resid**2))) if resid.size else 0.0
    median_par = float(np.median(parallaxes)) if parallaxes else 0.0
    return _build_map(led_entries, unmapped, led_count, map_id, created_at, global_rms, median_par)


def _build_map(
    led_entries: List[LedEntry],
    unmapped: set,
    led_count: int,
    map_id: Optional[str],
    created_at: Optional[str],
    global_rms: float,
    median_par: float,
) -> OutputMap:
    mapped_ids = {e.id for e in led_entries}
    # Any id in [0, led_count) that wasn't solved is unmapped (design doc §7.5).
    full_unmapped = set(unmapped) | (set(range(led_count)) - mapped_ids)
    full_unmapped -= mapped_ids
    return OutputMap(
        mapId=map_id or str(uuid.uuid4()),
        createdAt=created_at or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        units="meters",
        frame="webxr_session_ref",
        ledCount=led_count,
        leds=sorted(led_entries, key=lambda e: e.id),
        unmapped=sorted(full_unmapped),
        stats=OutputMapStats(rmsReprojPxGlobal=global_rms, medianParallaxDeg=median_par),
    )
