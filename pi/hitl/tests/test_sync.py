"""Unit tests for the SNTP clock-sync math (parity with clocksync.ts)."""

from sync import SyncSample, best_sample, is_sane, sync_sample


def test_sync_sample_offset_and_rtt():
    # Server clock is +100ms; a symmetric 20ms round trip.
    # t0=0 (send), t1=110 (recv @ server = 10 local + 100 offset), t2=110, t3=20.
    s = sync_sample(0, 110, 110, 20)
    assert s.offset_ms == 100
    assert s.rtt_ms == 20


def test_sync_sample_zero_offset():
    s = sync_sample(0, 5, 5, 10)
    assert s.offset_ms == 0
    assert s.rtt_ms == 10


def test_best_sample_picks_min_rtt():
    a = SyncSample(offset_ms=100, rtt_ms=50)
    b = SyncSample(offset_ms=101, rtt_ms=8)
    c = SyncSample(offset_ms=99, rtt_ms=30)
    assert best_sample([a, b, c]) is b


def test_best_sample_empty_raises():
    try:
        best_sample([])
    except ValueError:
        return
    raise AssertionError("expected ValueError on empty samples")


def test_is_sane():
    assert is_sane(SyncSample(offset_ms=100, rtt_ms=15))
    assert is_sane(SyncSample(offset_ms=-100000, rtt_ms=0))  # offset can be large
    assert not is_sane(SyncSample(offset_ms=0, rtt_ms=-1))  # negative rtt = clock ran backward
    assert not is_sane(SyncSample(offset_ms=0, rtt_ms=9999))  # implausible for a LAN
