"""Pure-logic tests for the HITL large-map-upload harness (FUG-74): the
sharded-upload window plan and the synthetic fixtures, with no hardware. Pins the
chunking contract that must not drift from web/src/net/client.ts `sendChunked`
and the firmware's reassembly — each window <= CHUNK_BYTES, dense seq, exactly
one `last`, and the payloads reassemble to the original frame byte-for-byte."""

import pytest
from map_upload_core import (
    CHUNK_BYTES,
    needs_chunking,
    reassemble,
    synth_output_map,
    synth_topology,
    window_plan,
)

# Traceability: PR(s) this suite verifies (see requirements/requirements.yaml).
pytestmark = pytest.mark.requirements("PR-13")


def _slice(frame: bytes) -> list[bytes]:
    return [frame[off:end] for (_seq, off, end, _last) in window_plan(len(frame))]


def test_window_plan_shards_a_large_frame():
    n = 3 * CHUNK_BYTES + 123
    plan = window_plan(n)
    assert len(plan) == 4  # ceil((3*4096+123)/4096)
    seqs = [w[0] for w in plan]
    assert seqs == [0, 1, 2, 3]  # dense, from 0
    assert [w[3] for w in plan] == [False, False, False, True]  # only the last
    assert all(end - off <= CHUNK_BYTES for (_s, off, end, _l) in plan)
    # windows tile [0, n) with no gaps or overlaps
    assert plan[0][1] == 0 and plan[-1][2] == n
    for a, b in zip(plan, plan[1:]):
        assert a[2] == b[1]


def test_window_plan_reassembles_byte_identically():
    for n in (
        1,
        CHUNK_BYTES - 1,
        CHUNK_BYTES,
        CHUNK_BYTES + 1,
        5 * CHUNK_BYTES,
        5 * CHUNK_BYTES + 7,
    ):
        frame = bytes((i * 31 + 7) & 0xFF for i in range(n))
        assert reassemble(_slice(frame)) == frame


def test_window_plan_exact_multiple_has_no_empty_tail():
    plan = window_plan(2 * CHUNK_BYTES)
    assert len(plan) == 2
    assert plan[-1] == (1, CHUNK_BYTES, 2 * CHUNK_BYTES, True)


def test_window_plan_empty_frame_is_no_windows():
    assert window_plan(0) == []


def test_needs_chunking_threshold():
    assert not needs_chunking(0)
    assert not needs_chunking(CHUNK_BYTES)  # exactly one window -> single frame
    assert needs_chunking(CHUNK_BYTES + 1)


def test_synth_output_map_shape():
    m = synth_output_map(150, map_id="__t")
    assert m["type"] == "submit_map"
    assert m["map"]["map_id"] == "__t"
    assert m["map"]["led_count"] == 150
    assert len(m["map"]["leds"]) == 150
    led = m["map"]["leds"][149]
    assert led["id"] == 149
    assert len(led["xyz"]) == 3
    # full LedEntry fields present so the encoded frame reaches the ~90 B/LED
    # size that reproduces the OOM (not just id+xyz).
    assert {"confidence", "n_views", "rms_reproj_px", "parallax_deg"} <= set(led)


def test_synth_topology_shape():
    t = synth_topology(150, map_id="__t", n_segments=12, pts_per_seg=20, n_branch=12)
    assert t["type"] == "submit_topology"
    assert t["topology"]["map_id"] == "__t"
    assert len(t["topology"]["branch_points"]) == 12
    assert len(t["topology"]["segments"]) == 12
    assert len(t["topology"]["associations"]) == 150
    seg = t["topology"]["segments"][0]
    assert len(seg["polyline"]) == 20
    assert len(seg["polyline"][0]) == 3  # flat [x,y,z]; proto_wire reshapes to Vec3
