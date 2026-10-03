"""An interrupted capture is still solvable without losing the walk (PR-31).

A real capture is not one clean sweep: the user pauses to step around furniture
(brief decode gaps), or walks away mid-capture and comes back (a long stretch
with no LED observations, bridged only by dead reckoning). The visual-inertial
reconstructor segments the observation timeline before solving
(vio_api.keep_dominant_segment): brief pauses must cost NO observations — that
is the user's work — while a long walk-away gap, which would warp the whole
trajectory if dead-reckoned across, keeps the observation-richest stretch
(wherever it falls in the walk) instead of failing the solve.

Pure timeline logic on FrameObservations, no solver run.
Every test verifies PR-31 only (see requirements/requirements.yaml).
"""

from __future__ import annotations

import pytest
from reconstruction.vio import FrameObservations
from reconstruction.vio_api import keep_dominant_segment

K = (900.0, 900.0, 640.0, 360.0)


def _stretch(t0_s: float, n_frames: int, n_leds: int = 20, dt_s: float = 0.1) -> list:
    """``n_frames`` consecutive frames from ``t0_s``, each seeing ``n_leds`` LEDs."""
    return [
        FrameObservations(
            t=t0_s + i * dt_s, k=K, obs=[(j, 100.0 + j, 200.0) for j in range(n_leds)]
        )
        for i in range(n_frames)
    ]


def _n_obs(frames: list) -> int:
    return sum(len(f.obs) for f in frames)


@pytest.mark.requirements("PR-31")
def test_brief_pauses_in_a_capture_lose_no_observations():
    # Three 5 s stretches separated by a 2.5 s and a 1.5 s pause (stepping
    # around an obstacle): long enough to split the timeline finely, too short
    # to be a walk-away.
    first = _stretch(0.0, 50)
    second = _stretch(first[-1].t + 2.5, 50)
    third = _stretch(second[-1].t + 1.5, 50)
    capture = first + second + third

    kept, dropped = keep_dominant_segment(capture)

    assert dropped == 0
    assert kept == capture


@pytest.mark.requirements("PR-31")
def test_walk_away_mid_capture_keeps_the_richer_later_stretch():
    # A short false start, a 17 s walk-away, then the real capture.
    false_start = _stretch(0.0, 40)
    real_capture = _stretch(false_start[-1].t + 17.0, 120)

    kept, dropped = keep_dominant_segment(false_start + real_capture)

    assert kept == real_capture
    assert dropped == _n_obs(false_start)


@pytest.mark.requirements("PR-31")
def test_walk_away_mid_capture_keeps_the_richer_earlier_stretch():
    # The real capture, then the user wanders off and a few stray frames decode
    # on the way back: the capture already taken must survive the interruption.
    real_capture = _stretch(0.0, 120)
    tail = _stretch(real_capture[-1].t + 17.0, 40)

    kept, dropped = keep_dominant_segment(real_capture + tail)

    assert kept == real_capture
    assert dropped == _n_obs(tail)
