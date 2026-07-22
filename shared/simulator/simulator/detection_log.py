"""Detection-log generator (M9 detection-log mode, design doc §6/§10.1).

Given a fixture and a virtual walk, project every true LED into every camera
station and emit DetectionRecord-shaped observations — the same contract the CV
pipeline (M6) would produce — so the reconstruction (M3) can be exercised with
no phone and no hardware. Deterministic given a seed.
"""

from __future__ import annotations

from typing import Tuple

import numpy as np
from reconstruction import project

from .degrade import NoiseModel, perturb_pixel, perturb_pose
from .fixtures import make_fixture
from .walk import arc_walk

DEFAULT_IMG_W = 1280
DEFAULT_IMG_H = 720


def _default_k(img_w: int, img_h: int) -> list:
    # ~70° horizontal FOV at 1280px.
    f = 900.0
    return [f, f, img_w / 2.0, img_h / 2.0]


def generate_log(
    fixture: str = "line",
    leds: int = 64,
    *,
    noise: NoiseModel = NoiseModel(),
    views: int = 60,
    arc_degrees: float = 120.0,
    scale: float = 1.0,
    img_w: int = DEFAULT_IMG_W,
    img_h: int = DEFAULT_IMG_H,
    seed: int = 0,
) -> Tuple[dict, np.ndarray]:
    """Build a detection log and return ``(log, truth_points)``.

    ``log`` is ``{"ledCount", "fixture", "detections": [...]}`` ready to feed to
    ``reconstruction``. ``truth_points`` is the ground-truth ``(N, 3)`` array for
    error evaluation (not part of the wire contract).
    """
    points = make_fixture(fixture, leds, scale)
    poses = arc_walk(points, views=views, arc_degrees=arc_degrees)
    k = _default_k(img_w, img_h)
    rng = np.random.default_rng(seed)

    detections = []
    for p_true, q_true in poses:
        uv, depth = project(p_true, q_true, k, points)  # (N, 2), (N,)
        # One reported (noisy) pose per camera station, shared by its LEDs.
        p_rep, q_rep = perturb_pose(p_true, q_true, noise, rng)
        for led_id in range(len(points)):
            d = depth[led_id]
            if d <= 0:
                continue  # behind the camera
            u, v = float(uv[led_id, 0]), float(uv[led_id, 1])
            if not (0.0 <= u < img_w and 0.0 <= v < img_h):
                continue  # outside the frame
            if noise.dropout_prob > 0.0 and rng.random() < noise.dropout_prob:
                continue
            u, v = perturb_pixel(u, v, noise, rng)
            detections.append(
                {
                    "ledId": led_id,
                    "tCaptureMs": 0.0,
                    "u": u,
                    "v": v,
                    "imgW": img_w,
                    "imgH": img_h,
                    "K": list(k),
                    "pose": {"p": [float(c) for c in p_rep], "q": [float(c) for c in q_rep]},
                    "confidence": 1.0,
                }
            )

    log = {"ledCount": leds, "fixture": fixture, "detections": detections}
    return log, points
