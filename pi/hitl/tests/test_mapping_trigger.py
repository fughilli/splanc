"""Pure-logic tests for the mapping-sequence-trigger HITL check (FUG-62): the
frame_timing → triggered/not-triggered verdict, with no hardware. Pins the exact
distinction the on-hardware guard relies on — a latched capture that shows ZERO
frames (the masking bug) must read as NOT triggered."""

import pytest
from mapping_trigger_core import (
    frame_ticks_in,
    pattern_epoch_of,
    pattern_triggered,
    total_frame_ticks,
)

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-36")


def _ft(epoch=0, ticks=0, dropped=0):
    """A decoded frame_timing reply (camelCase, as proto_wire.decode_server emits)."""
    return {
        "patternClockEpochMs": epoch,
        "ticks": [{"seq": i, "tUs": i * 1000} for i in range(ticks)],
        "dropped": dropped,
    }


def test_frame_ticks_counts_ticks_plus_dropped():
    assert frame_ticks_in(_ft(ticks=4, dropped=2)) == 6


def test_frame_ticks_missing_keys_read_as_zero():
    # proto3 drops zero-valued scalars and empty repeateds, so a quiet reply is
    # just {"type": "frame_timing"} — must not KeyError.
    assert frame_ticks_in({}) == 0
    assert pattern_epoch_of({}) == 0


def test_pattern_epoch_reads_camelcase():
    assert pattern_epoch_of(_ft(epoch=12345)) == 12345


def test_total_frame_ticks_sums_across_polls():
    reports = [_ft(epoch=100, ticks=2), _ft(epoch=100, ticks=0, dropped=3), _ft(epoch=100, ticks=1)]
    assert total_frame_ticks(reports) == 6


def test_triggered_when_epoch_and_enough_frames():
    reports = [_ft(epoch=100, ticks=2), _ft(epoch=100, ticks=2)]
    assert pattern_triggered(reports) is True


def test_not_triggered_when_capture_latched_but_no_frames_shown():
    # THE FUG-62 bug: start_mapping latched a capture (nonzero epoch) but a
    # masking effect kept every frame off the strip. Must read as NOT triggered.
    reports = [_ft(epoch=100, ticks=0), _ft(epoch=100, ticks=0)]
    assert pattern_triggered(reports) is False


def test_not_triggered_at_baseline_no_capture():
    reports = [_ft(epoch=0, ticks=0)]
    assert pattern_triggered(reports) is False


def test_dropped_frames_alone_count_as_shown():
    # A poll that overflowed the ring (all dropped, none drained) still proves the
    # pattern rendered — as long as the epoch says a capture is active.
    reports = [_ft(epoch=100, ticks=0, dropped=5)]
    assert pattern_triggered(reports) is True


def test_min_ticks_threshold_is_respected():
    reports = [_ft(epoch=100, ticks=2)]
    assert pattern_triggered(reports, min_ticks=2) is True
    assert pattern_triggered(reports, min_ticks=3) is False
