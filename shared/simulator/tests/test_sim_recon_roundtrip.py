"""M9 → M3 acceptance (design doc §9 Phase 2).

The simulator's detection-log mode feeds the reconstruction. The headline
acceptance criterion: a **zero-noise** detection log reconstructs to **< 1 mm
RMS**. We also check determinism (fixed seed) and a nominal-noise scenario.
"""

from __future__ import annotations

import numpy as np
import pytest
from reconstruction import reconstruct
from simulator import NOMINAL, NONE, generate_log

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-11")


def _errors_mm(out, truth):
    """Per-LED position error (mm) for solved LEDs, plus the solved id set."""
    by_id = {e.id: np.array(e.xyz) for e in out.leds}
    errs = {i: np.linalg.norm(by_id[i] - truth[i]) * 1000.0 for i in by_id}
    return errs, set(by_id)


def _span(truth):
    return float(np.linalg.norm(truth.max(axis=0) - truth.min(axis=0)))


FIXTURES = [("line", 32), ("grid", 36), ("cube", 27), ("helix", 40)]


@pytest.mark.parametrize(("fixture", "leds"), FIXTURES, ids=[f for f, _ in FIXTURES])
def test_zero_noise_under_1mm_rms(fixture, leds):
    log, truth = generate_log(fixture, leds, noise=NONE, seed=0)
    out = reconstruct(log["detections"], led_count=log["ledCount"])

    errs, solved = _errors_mm(out, truth)
    # Every LED is solved at zero noise.
    assert solved == set(range(leds)), f"unsolved: {set(range(leds)) - solved}"
    rms_mm = float(np.sqrt(np.mean(np.square(list(errs.values())))))
    max_mm = max(errs.values())
    assert rms_mm < 1.0, f"{fixture}: RMS {rms_mm:.4f} mm exceeds 1 mm"
    assert max_mm < 1.0, f"{fixture}: max {max_mm:.4f} mm exceeds 1 mm"
    # A clean solve should be reported as high-confidence.
    assert min(e.confidence for e in out.leds) > 0.9


def test_deterministic_with_fixed_seed():
    a, _ = generate_log("cube", 27, noise=NOMINAL, seed=7)
    b, _ = generate_log("cube", 27, noise=NOMINAL, seed=7)
    assert a == b
    c, _ = generate_log("cube", 27, noise=NOMINAL, seed=8)
    assert a != c  # a different seed changes the noise realization


def test_nominal_noise_within_one_percent_span():
    # §9 Phase 2: at nominal noise, RMS ≤ 1% of fixture span, ≥ 99% solved.
    leds = 64
    log, truth = generate_log("cube", leds, noise=NOMINAL, seed=0)
    out = reconstruct(log["detections"], led_count=log["ledCount"])
    errs, solved = _errors_mm(out, truth)

    solved_frac = len(solved) / leds
    assert solved_frac >= 0.99, f"only {solved_frac:.0%} solved"
    rms_m = float(np.sqrt(np.mean(np.square(list(errs.values()))))) / 1000.0
    span = _span(truth)
    assert rms_m <= 0.01 * span, f"RMS {rms_m * 1000:.2f} mm > 1% of span ({span * 10:.2f} mm)"
    # Confidence must remain informative (non-zero) under realistic pose noise,
    # not collapse to 0 just because fixed-pose BA inflates reprojection error.
    assert np.median([e.confidence for e in out.leds]) > 0.2
