"""An interrupted capture is still solvable without losing the walk (PR-31).

A real capture is not one clean sweep: the user pauses to step around furniture
(brief decode gaps), walks away mid-capture and comes back (a long stretch with
no LED observations, bridged only by dead reckoning), or captures a diffused
fixture in strided phases (a decode-lock dead time after every phase switch).
None of those gaps carries bad data, so the visual-inertial solve must FUSE
every stretch — no observation is discarded for when it was taken. A long gap
only loosens the inertial link across it (interval_sigmas' drift terms); an
IMU dropout removes the link entirely; LEDs seen on both sides still tie the
stretches together, and the bundle adjustment's robust loss + outlier rejection
handle genuinely bad observations.

Each test runs a full reconstruct_vio solve on a synthetic session
(vio_synth) and checks that every record reached the solution (the per-LED
view counts sum to the record count) and that the map is accurate.
Every test verifies PR-31 only (see requirements/requirements.yaml).
"""

from __future__ import annotations

import numpy as np
import pytest
from reconstruction.vio import FrameObservations, ImuSample
from reconstruction.vio_api import reconstruct_vio
from testsupport import vio_synth
from testsupport.vio_synth import (
    K,
    map_rms,
    synth_frames,
    synth_imu,
    to_imu_wire,
    to_records,
    wall_leds,
)


def _solve_all(frames, imu, leds):
    """Solve with nothing subsampled or pruned, so the view counts account for
    every record; return (output map, record count)."""
    records = to_records(frames)
    out = reconstruct_vio(
        records,
        to_imu_wire(imu),
        led_count=len(leds),
        max_keyframes=None,
        reject_outliers=False,
    )
    return out, len(records)


def _assert_fused(out, n_records, leds):
    assert len(out.leds) == len(leds), f"solved only {len(out.leds)}/{len(leds)}"
    used = sum(e.nViews for e in out.leds)
    assert used == n_records, f"solve used {used}/{n_records} observations"
    assert out.stats.rmsReprojPxGlobal < 1.5
    rms = map_rms(out, leds)
    assert rms < 0.005, f"map rms {rms * 1000:.2f} mm"


def _without(frames, windows):
    """Drop every frame inside any (t0, t1) window: decode gaps."""
    return [f for f in frames if not any(t0 <= f.t < t1 for t0, t1 in windows)]


@pytest.fixture
def long_walk(monkeypatch):
    """A 36 s walk (the default session is 12 s) for multi-stretch captures."""
    monkeypatch.setattr(vio_synth, "DURATION", 36.0)


@pytest.mark.requirements("PR-31")
def test_brief_pauses_in_a_capture_lose_no_observations():
    # Two pauses (2.5 s and 1.5 s) stepping around an obstacle.
    leds = wall_leds()
    frames, _times = synth_frames(leds)
    frames = _without(frames, [(3.0, 5.5), (8.0, 9.5)])

    out, n_records = _solve_all(frames, synth_imu(), leds)

    _assert_fused(out, n_records, leds)


@pytest.mark.requirements("PR-31")
def test_walk_away_mid_capture_keeps_both_stretches(long_walk):
    # A 4 s false start, a 17 s walk-away with no decodes (the IMU keeps
    # streaming), then the rest of the capture: both stretches are the user's
    # work and fuse through the LEDs they share.
    leds = wall_leds()
    frames, _times = synth_frames(leds)
    frames = _without(frames, [(4.0, 21.0)])

    out, n_records = _solve_all(frames, synth_imu(), leds)

    _assert_fused(out, n_records, leds)


@pytest.mark.requirements("PR-31")
def test_imu_dropout_across_a_walk_away_keeps_both_stretches():
    # The app was backgrounded during a walk-away: a 12 s gap with NO IMU
    # samples either (and the camera back near where it started). The hole
    # carries no inertial constraint at all — dead-reckoning a held sample
    # across it would fabricate 12 s of motion.
    leds = wall_leds()
    frames, _times = synth_frames(leds)
    imu = synth_imu()
    prefix = [FrameObservations(t=f.t - 14.0, k=f.k, obs=f.obs) for f in frames if f.t < 2.0]
    imu_prefix = [ImuSample(t=s.t - 14.0, gyro=s.gyro, accel=s.accel) for s in imu if s.t < 2.05]

    out, n_records = _solve_all(prefix + list(frames), imu_prefix + list(imu), leds)

    _assert_fused(out, n_records, leds)


@pytest.mark.requirements("PR-31")
def test_leading_stray_records_do_not_derail_the_solve():
    # The 2026-07-08 explosion: TWO stray records at t=0, a 2.6 s decode gap,
    # then the real capture. Pinning that stub frame as the gauge diverged the
    # solve to 469k px; the gauge is now the best-observed frame, so the stub
    # is just two (correct) observations among many.
    leds = wall_leds()
    frames, _times = synth_frames(leds)
    imu = synth_imu()
    stub = [FrameObservations(t=-2.6, k=K, obs=frames[0].obs[:2])]
    imu_prefix = [ImuSample(t=s.t - 2.65, gyro=s.gyro, accel=s.accel) for s in imu if s.t < 2.7]

    out, n_records = _solve_all(stub + list(frames), imu_prefix + list(imu), leds)

    assert len(out.leds) == len(leds)
    assert sum(e.nViews for e in out.leds) == n_records
    assert out.stats.rmsReprojPxGlobal < 1.5


def _stride_lit(led: int, phase: int, spacing: int, anchor: int) -> bool:
    """web/src/code/stride.ts strideLit (S coverage phases + S-1 bridges)."""
    n = 2 * spacing - 1
    ph = phase % n
    if ph < spacing:
        return led % spacing == ph
    j = ph - spacing + 1
    m = led % (anchor * spacing)
    return m == 0 or m == (anchor // 2) * spacing + j


@pytest.mark.requirements("PR-31")
def test_strided_capture_fuses_every_phase_across_decode_gaps(long_walk):
    # Diffuse (strided) capture: each phase lights a sparse LED subset, and
    # every phase switch costs a decode-lock dead time with no observations
    # (the decoder must see a fresh code cycle first). Coverage phases are
    # disjoint; the bridge phases and the IMU link them. Every phase must land
    # in the map — keeping only the richest stretch solved one phase's LEDs.
    leds = wall_leds()
    frames, _times = synth_frames(leds)
    spacing, anchor, obs_s, dead_s = 3, 3, 3.0, 3.5
    strided = []
    for fr in frames:
        phase, into = divmod(fr.t, obs_s + dead_s)
        if into >= obs_s:
            continue  # decode-lock dead time after a phase switch
        obs = [o for o in fr.obs if _stride_lit(o[0], int(phase), spacing, anchor)]
        if obs:
            strided.append(FrameObservations(t=fr.t, k=fr.k, obs=obs))

    out, n_records = _solve_all(strided, synth_imu(), leds)

    _assert_fused(out, n_records, leds)
    assert np.isfinite(out.stats.rmsReprojPxGlobal)
