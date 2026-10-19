"""The time-base skew analysis (time_base_skew_core): the binary-clock decode, the
per-device offset, the skew, and the epoch conversion the HITL run relies on."""

import math
import random

from time_base_skew_core import (
    BITS,
    TICK_S,
    WRAP_S,
    decode_ticks,
    device_epoch,
    device_offset,
    skew,
)


def frames(effect_start_s, latency_s=0.002, fps=30.3, seconds=20.0, seed=0, jitter=0.0003):
    """Captured frames of a device whose effect time is (wire_t - latency) -
    effect_start: LED k shows bit k of floor(time / TICK_S)."""
    rnd = random.Random(seed)
    t = rnd.random() / fps
    out = []
    while t < seconds:
        render = t - latency_s - rnd.uniform(0, jitter)
        ticks = math.floor((render - effect_start_s) / TICK_S) % (1 << BITS)
        px = [(255, 255, 255) if (ticks >> k) & 1 else (0, 0, 0) for k in range(BITS)]
        out.append((t, px))
        t += 1.0 / fps
    return out


def test_decode_reads_the_bits():
    px = [(0, 0, 0)] * BITS
    px[0] = px[3] = (200, 180, 190)
    assert decode_ticks(px) == 9
    assert decode_ticks(px[:5]) is None


def test_skew_recovers_a_12_ms_offset_without_frame_quantization_bias():
    # B's effect second starts 12 ms later in wire time; both run the same 30.3 fps
    # frame clock (phase-locked would bias an edge method — not this one).
    s = skew(frames(0.0, seed=1), frames(0.012, seed=2))
    assert s.n_a > 500 and s.n_b > 500
    assert abs(s.skew_ms - 12.0) < 2.5, s.skew_ms
    assert s.spread_a_ms < 3.0


def test_in_sync_reads_near_zero_and_latency_cancels():
    s = skew(frames(0.0, latency_s=0.003, seed=3), frames(0.0, latency_s=0.003, seed=4))
    assert abs(s.skew_ms) < 2.5


def test_the_tick_wrap_does_not_corrupt_the_offset():
    # Capture straddling a counter wrap (16.384 s): offset stays one number.
    fr = frames(-(WRAP_S - 2.0), seconds=6.0, seed=5)
    off = device_offset(fr)
    assert abs(((off - (-(WRAP_S - 2.0)) + WRAP_S / 2) % WRAP_S) - WRAP_S / 2 - 0.002) < 0.005


def test_skew_wraps_to_the_short_way_round():
    s = skew(frames(0.0, seed=6), frames(WRAP_S - 0.010, seed=7))  # 10 ms EARLY
    assert abs(s.skew_ms + 10.0) < 2.5, s.skew_ms


def test_no_decodable_frames_is_nan():
    s = skew([(0.0, [(0, 0, 0)] * 3)], frames(0.0))
    assert math.isnan(s.skew_ms)


def test_device_epoch_applies_the_clock_offset():
    assert device_epoch(1_000_000.0, -250.4) == 999_750
    assert TICK_S * (1 << BITS) == WRAP_S
