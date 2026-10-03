"""Reconstruction at installation scale (PR-12: tolerate larger installations).

The solver batches every LED into one vectorized per-LED Levenberg-Marquardt
solve (the block-diagonal structure of a fixed-pose problem), which is what
keeps a big fixture tractable. These tests run a design-scale installation — a
1024-LED strip wound on a cone, the server's default code-book size and the
two-channel firmware ceiling — through the real M3 pipeline and pin that every
LED comes back where it is, so nothing in the batched solve (indexing, scatter
reductions, outlier bookkeeping) silently breaks past small-fixture sizes.

Every test verifies PR-12 only (see requirements/requirements.yaml).
"""

from __future__ import annotations

import numpy as np
import pytest
from reconstruction import look_at_quat, project, reconstruct

K = [900.0, 900.0, 640.0, 360.0]
DESIGN_SCALE_LEDS = 1024


def _wound_strip(n: int) -> np.ndarray:
    """``n`` LEDs along a strip wound six times around a cone (a tree-like
    installation, ~1.6 m tall)."""
    t = np.linspace(0.0, 1.0, n)
    ang = t * 6.0 * 2.0 * np.pi
    r = 0.6 * (1.0 - t) + 0.05
    return np.stack([r * np.cos(ang), 1.6 * t - 0.8, r * np.sin(ang)], axis=1)


def _ring_capture(points: np.ndarray, n_views: int, noise_px: float, seed: int = 0) -> list:
    """Posed detections from ``n_views`` viewpoints on a ring around the fixture."""
    rng = np.random.default_rng(seed)
    center = points.mean(axis=0)
    detections = []
    for view, a in enumerate(np.linspace(0.0, 2.0 * np.pi, n_views, endpoint=False)):
        eye = np.array([3.0 * np.sin(a), 0.4, 3.0 * np.cos(a)])
        q = look_at_quat(eye, center)
        for led_id, x in enumerate(points):
            uv, depth = project(eye, q, K, x)
            if depth <= 0:
                continue
            detections.append(
                {
                    "ledId": led_id,
                    "tCaptureMs": float(view),
                    "u": float(uv[0] + rng.normal(0.0, noise_px)),
                    "v": float(uv[1] + rng.normal(0.0, noise_px)),
                    "imgW": 1280,
                    "imgH": 720,
                    "K": list(K),
                    "pose": {"p": [float(c) for c in eye], "q": [float(c) for c in q]},
                    "confidence": 1.0,
                }
            )
    return detections


def _errors_mm(out, truth: np.ndarray) -> np.ndarray:
    return np.array([np.linalg.norm(np.asarray(e.xyz) - truth[e.id]) * 1000.0 for e in out.leds])


@pytest.mark.requirements("PR-12")
def test_design_scale_installation_reconstructs_every_led():
    truth = _wound_strip(DESIGN_SCALE_LEDS)
    out = reconstruct(_ring_capture(truth, n_views=10, noise_px=0.0), led_count=DESIGN_SCALE_LEDS)

    assert out.ledCount == DESIGN_SCALE_LEDS
    assert out.unmapped == []
    assert [e.id for e in out.leds] == list(range(DESIGN_SCALE_LEDS))
    assert _errors_mm(out, truth).max() < 1.0
    assert out.stats.rmsReprojPxGlobal < 1e-3


@pytest.mark.requirements("PR-12")
def test_design_scale_installation_under_pixel_noise_stays_millimetre_accurate():
    truth = _wound_strip(DESIGN_SCALE_LEDS)
    out = reconstruct(
        _ring_capture(truth, n_views=12, noise_px=0.5, seed=7), led_count=DESIGN_SCALE_LEDS
    )

    assert out.unmapped == []
    errs = _errors_mm(out, truth)
    assert len(errs) == DESIGN_SCALE_LEDS
    assert np.median(errs) < 2.0
    assert errs.max() < 5.0
