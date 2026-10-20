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
    frames_by_channel,
    percentile,
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


def _timing_frames(fr, channel, rate=12_000_000):
    """(start_s, pixels) frames as the analyzer's timing op lists them."""
    out = []
    for i, (t, px) in enumerate(fr):
        out.append(
            {
                "index": i,
                "channel": channel,
                "start_sample": int(round(t * rate)),
                "start_us": round(t * 1e6, 3),
                "pixels": [{"r": r, "g": g, "b": b} for r, g, b in px],
            }
        )
    return out


def test_frames_by_channel_splits_a_two_channel_capture():
    # The broker's multi-channel layout: top level mirrors the primary (D6), and
    # `channels` carries every channel's block, frames tagged, on one clock.
    a, b = frames(0.0, seed=8, seconds=3.0), frames(0.009, seed=9, seconds=3.0)
    d6, d7 = _timing_frames(a, "D6"), _timing_frames(b, "D7")
    res = {
        "unit": "c6-003f08",
        "frames": d6,
        "channels": [
            {"channel": "D6", "frames": d6, "frames_listed": len(d6)},
            {"channel": "D7", "frames": d7, "frames_listed": len(d7)},
        ],
    }
    by = frames_by_channel(res)
    assert sorted(by) == ["D6", "D7"]
    assert len(by["D6"]) == len(a) and len(by["D7"]) == len(b)
    assert abs(by["D7"][3][0] - b[3][0]) < 1e-6 and by["D7"][3][1] == list(b[3][1])
    s = skew(by["D6"], by["D7"])
    assert abs(s.skew_ms - 9.0) < 2.5, s.skew_ms
    assert len(s.per_frame_ms) == s.n_b
    assert abs(percentile(s.per_frame_ms, 50) - 9.0) < 3.0


def test_frames_by_channel_single_channel_and_untagged():
    fr = frames(0.0, seconds=1.0)
    assert sorted(frames_by_channel({"frames": _timing_frames(fr, "D6")})) == ["D6"]
    # A broker predating the channel tag: one bucket named "None" (the harness
    # then reports the two-channel capture as unavailable).
    untagged = [dict(f, channel=None) for f in _timing_frames(fr, "D6")]
    assert sorted(frames_by_channel({"frames": untagged})) == ["None"]


def test_per_frame_distribution_wraps_around_the_skew():
    # A large baseline skew near half the wrap must not split the distribution.
    s = skew(frames(0.0, seed=10), frames(WRAP_S / 2 - 0.050, seed=11))
    assert all(abs(v - s.skew_ms) < 10.0 for v in s.per_frame_ms)
    assert percentile([], 50) != percentile([], 50)  # NaN
    assert percentile([3.0, 1.0, 2.0], 50) == 2.0
