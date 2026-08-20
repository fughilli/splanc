"""Unit tests for the min-free-heap gate's pure logic (heap_floor_core, FUG-132).

The heap measurement itself is the device's (PerfReport.heap_min_free); here we
pin the field extraction, the inclusive floor verdict, and the summary line the
driver logs — the pieces that decide PASS/FAIL off a decoded report."""

from heap_floor_core import (
    DEFAULT_MIN_HEAP_FREE,
    heap_min_free,
    summarize,
    verdict,
)


def test_heap_min_free_reads_camelcase_and_snake_case():
    # The §7 wire codec emits camelCase; accept the proto snake_case too.
    assert heap_min_free({"heapMinFree": 31000}) == 31000
    assert heap_min_free({"heap_min_free": 31000}) == 31000


def test_heap_min_free_missing_is_none():
    # proto3 drops zeros, but a live device never reports 0 min-free; a missing
    # field means no usable report — the driver treats None as a hard error.
    assert heap_min_free({"effectId": "__heapfloor"}) is None


def test_verdict_is_inclusive_at_the_floor():
    assert verdict(DEFAULT_MIN_HEAP_FREE, DEFAULT_MIN_HEAP_FREE)  # exactly at floor passes
    assert verdict(40 * 1024, 30 * 1024)
    assert not verdict(2724, 30 * 1024)  # the FUG-132 regression low-water mark


def test_default_floor_clears_a_fresh_tls_session():
    # ~28 KB handshake + margin; must sit above the ~17 KB TLS record buffer.
    assert DEFAULT_MIN_HEAP_FREE >= 28 * 1024


def test_summarize_renders_kb_and_effect():
    line = summarize(
        {"heapMinFree": 30720, "heapFree": 51200, "effectId": "__heapfloor"}, 30 * 1024
    )
    assert "heap_min_free=30.0 KB" in line
    assert "heap_free=50.0 KB" in line
    assert "floor=30.0 KB" in line
    assert "__heapfloor" in line


def test_summarize_tolerates_a_report_missing_heap():
    line = summarize({}, 30 * 1024)
    assert "heap_min_free=n/a" in line
    assert "heap_free=n/a" in line
