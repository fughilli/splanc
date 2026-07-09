"""Simulation studio core (transport-free, design doc §10.1).

Ties together the real pipeline pieces so the studio debugs the *actual*
algorithm, not a reimplementation:

  - M9 `make_fixture` builds ground-truth LED geometry;
  - the shared M3 camera model (`look_at_quat` + `project`) synthesizes a capture
    from a camera pose (same convention as WebXR / the simulator, so the data is
    in-distribution);
  - M9 `NoiseModel` injects the same degradations the simulator uses;
  - M3 `reconstruct` solves; we then score each solved LED against ground truth.

`StudioSession` holds one in-progress scene + its accumulated captures, mirroring
how the real server holds one capture session. Everything here is pure Python
(numpy), so it is unit-tested with no HTTP and no browser.
"""

from __future__ import annotations

import math
import time
from typing import Dict, List, Optional, Sequence

import numpy as np

from reconstruction import look_at_quat, project
from reconstruction.api import reconstruct
from simulator import NoiseModel, make_fixture
from simulator.degrade import perturb_pixel, perturb_pose

FIXTURES = ["line", "grid", "cube", "helix"]


def intrinsics_from_fov(hfov_deg: float, img_w: int, img_h: int) -> List[float]:
    """Pinhole ``K = [fx, fy, cx, cy]`` from a horizontal FOV (square pixels)."""
    fx = (img_w / 2.0) / math.tan(math.radians(hfov_deg) / 2.0)
    return [fx, fx, img_w / 2.0, img_h / 2.0]


class Station:
    """One synthetic camera capture and the detections it produced."""

    def __init__(self, eye, target, pose_p, pose_q, k, visible_ids):
        self.eye = [float(c) for c in eye]
        self.target = [float(c) for c in target]
        self.pose_p = [float(c) for c in pose_p]
        self.pose_q = [float(c) for c in pose_q]
        self.k = [float(c) for c in k]
        self.visible_ids = list(visible_ids)


class StudioSession:
    def __init__(self):
        self.fixture: Optional[str] = None
        self.scale: float = 1.0
        self.points: np.ndarray = np.zeros((0, 3))
        self.stations: List[Station] = []
        self.detections: List[dict] = []

    # -- scene ------------------------------------------------------------

    def set_scene(self, fixture: str, leds: int, scale: float = 1.0) -> dict:
        if fixture not in FIXTURES:
            raise ValueError(f"unknown fixture {fixture!r}; choose from {FIXTURES}")
        if leds < 1:
            raise ValueError("leds must be ≥ 1")
        self.fixture = fixture
        self.scale = float(scale)
        self.points = make_fixture(fixture, leds, scale)
        self.stations = []
        self.detections = []
        return self.scene_info()

    def scene_info(self) -> dict:
        pts = self.points
        if len(pts) == 0:
            return {"fixture": self.fixture, "ledCount": 0, "leds": []}
        centroid = pts.mean(axis=0)
        span = float(np.linalg.norm(pts.max(axis=0) - pts.min(axis=0)))
        return {
            "fixture": self.fixture,
            "scale": self.scale,
            "ledCount": int(len(pts)),
            "leds": pts.tolist(),
            "centroid": centroid.tolist(),
            "span": span,
            "suggestedRadius": max(span * 2.0, span + 0.5),
        }

    # -- capture ----------------------------------------------------------

    def capture(
        self,
        eye: Sequence[float],
        target: Sequence[float],
        *,
        hfov_deg: float = 70.0,
        img_w: int = 1280,
        img_h: int = 720,
        noise: Optional[NoiseModel] = None,
        seed: int = 0,
    ) -> dict:
        """Synthesize a capture from a camera at ``eye`` looking at ``target``.

        Projects every ground-truth LED through the pinhole model, keeps the ones
        in front of the camera and inside the frame, optionally degrades them, and
        appends the resulting detections to the session.
        """
        if len(self.points) == 0:
            raise RuntimeError("no scene; call set_scene first")
        noise = noise or NoiseModel()
        rng = np.random.default_rng(seed)

        q = look_at_quat(np.asarray(eye, float), np.asarray(target, float))
        k = intrinsics_from_fov(hfov_deg, img_w, img_h)
        uv, depth = project(eye, q, k, self.points)

        # One reported (noisy) pose per station, shared by its LEDs — exactly the
        # simulator's model (the pixel came from the true pose, the device reports
        # a noisy one).
        p_rep, q_rep = perturb_pose(np.asarray(eye, float), q, noise, rng)

        added: List[dict] = []
        viz_points = []  # (ledId, u, v) for front-end overlay
        for i in range(len(self.points)):
            d = float(depth[i])
            if d <= 0:
                continue
            u, v = float(uv[i, 0]), float(uv[i, 1])
            if not (0.0 <= u < img_w and 0.0 <= v < img_h):
                continue
            viz_points.append([i, u, v])
            if noise.dropout_prob > 0.0 and rng.random() < noise.dropout_prob:
                continue
            nu, nv = perturb_pixel(u, v, noise, rng)
            added.append(
                {
                    "ledId": i,
                    "tCaptureMs": 0.0,
                    "u": nu,
                    "v": nv,
                    "imgW": img_w,
                    "imgH": img_h,
                    "K": list(k),
                    "pose": {"p": list(p_rep), "q": list(q_rep)},
                    "confidence": 1.0,
                }
            )

        self.detections.extend(added)
        station = Station(eye, target, p_rep, q_rep, k, [d["ledId"] for d in added])
        self.stations.append(station)
        return {
            "stationIndex": len(self.stations) - 1,
            "visible": len(viz_points),
            "added": len(added),
            "totalViews": len(self.stations),
            "totalDetections": len(self.detections),
            "pose": {"p": station.pose_p, "q": station.pose_q},
            "k": station.k,
            "uv": viz_points,
        }

    def reset_captures(self) -> None:
        self.stations = []
        self.detections = []

    # -- solve ------------------------------------------------------------

    def solve(
        self,
        *,
        min_views: int = 2,
        min_parallax_deg: float = 5.0,
        huber_delta: float = 1.5,
    ) -> dict:
        """Run M3 reconstruction on the accumulated captures and score vs truth."""
        if not self.detections:
            raise RuntimeError("no detections; capture some views first")
        led_count = int(len(self.points))
        t0 = time.perf_counter()
        omap = reconstruct(
            self.detections,
            led_count=led_count,
            min_views=min_views,
            min_parallax_deg=min_parallax_deg,
            huber_delta=huber_delta,
        )
        solve_ms = (time.perf_counter() - t0) * 1000.0

        # Ground-truth error per solved LED — the whole point of the studio.
        errors: Dict[int, float] = {}
        for e in omap.leds:
            gt = self.points[e.id]
            errors[e.id] = float(np.linalg.norm(np.asarray(e.xyz) - gt))
        err_vals = list(errors.values())

        return {
            "map": omap.model_dump(),
            "errorsByLed": {str(k): v for k, v in errors.items()},
            "solvedCount": len(omap.leds),
            "unmappedCount": len(omap.unmapped),
            "ledCount": led_count,
            "meanErrorM": float(np.mean(err_vals)) if err_vals else 0.0,
            "medianErrorM": float(np.median(err_vals)) if err_vals else 0.0,
            "maxErrorM": float(np.max(err_vals)) if err_vals else 0.0,
            "solveMs": solve_ms,
        }

    # -- introspection ----------------------------------------------------

    def state(self) -> dict:
        return {
            "fixture": self.fixture,
            "ledCount": int(len(self.points)),
            "views": len(self.stations),
            "detections": len(self.detections),
        }


def noise_from_dict(d: Optional[dict]) -> NoiseModel:
    """Build a NoiseModel from a JSON-ish dict (all keys optional)."""
    d = d or {}
    return NoiseModel(
        pixel_noise_px=float(d.get("pixelNoisePx", 0.0)),
        pose_noise_deg=float(d.get("poseNoiseDeg", 0.0)),
        pose_noise_pos_m=float(d.get("poseNoisePosM", 0.0)),
        dropout_prob=float(d.get("dropoutProb", 0.0)),
    )
