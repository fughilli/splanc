"""Installation-scale sharded uploads in the HITL map-upload harness (PR-12).

test_map_upload.py pins the chunking contract on synthetic byte strings. This
suite runs the harness's REAL fixtures (map_upload_core.synth_output_map /
synth_topology, what the on-hardware hitl_map_upload test sends) through the
real wire encoding at installation sizes up to the design scale (1024 LEDs
across two channels), and pins the scale-aware behaviour the large-map upload
relies on: a small installation still goes as one frame, a big one shards into
windows that each fit the per-record budget, the window count grows with the
installation, the tighter netstack budget (HITL_CHUNK_BYTES) shrinks every
window, and the reassembled windows decode back to the whole installation.

Frames are encoded the way server.proto_wire.encode_client does it (the oneof
arm named by "type"; polylines carried as repeated Vec3), via the generated
ledmapper.v1 bindings the harness already depends on.

Every test verifies PR-12 only (see requirements/requirements.yaml).
"""

from __future__ import annotations

import importlib
import math

import map_upload_core
import pytest
from google.protobuf import json_format
from ledmapper_pb2 import ClientMessage
from map_upload_core import (
    CHUNK_BYTES,
    needs_chunking,
    reassemble,
    synth_output_map,
    synth_topology,
    window_plan,
)


def _encode(flat: dict) -> bytes:
    """Encode a flat submit_* dict to a ClientMessage frame (proto_wire's shape)."""
    body = {k: v for k, v in flat.items() if k != "type"}
    topo = body.get("topology")
    if topo is not None:
        body = {
            **body,
            "topology": {
                **topo,
                "segments": [
                    {**s, "polyline": [{"v": p} for p in s["polyline"]]} for s in topo["segments"]
                ],
            },
        }
    msg = ClientMessage()
    json_format.ParseDict(body, getattr(msg, flat["type"]))
    return msg.SerializeToString()


def _shard(frame: bytes, chunk_bytes: int = CHUNK_BYTES) -> list:
    return [frame[off:end] for (_seq, off, end, _last) in window_plan(len(frame), chunk_bytes)]


@pytest.mark.requirements("PR-12")
@pytest.mark.parametrize("n_leds", [150, 512, 1024])
def test_installation_map_shards_into_bounded_windows_that_reassemble_whole(n_leds):
    frame = _encode(synth_output_map(n_leds, map_id="__scale"))
    assert needs_chunking(len(frame))

    windows = _shard(frame)
    assert len(windows) == math.ceil(len(frame) / CHUNK_BYTES)
    assert all(0 < len(w) <= CHUNK_BYTES for w in windows)

    decoded = ClientMessage.FromString(reassemble(windows))
    assert decoded.WhichOneof("msg") == "submit_map"
    m = decoded.submit_map.map
    assert (m.map_id, m.led_count, len(m.leds)) == ("__scale", n_leds, n_leds)
    assert [led.id for led in m.leds] == list(range(n_leds))


@pytest.mark.requirements("PR-12")
def test_upload_size_tracks_the_installation():
    # A small installation's map is a single frame; past that the window count
    # grows with the LED count (the 1024-LED map needs ~2x the 512-LED windows).
    small = _encode(synth_output_map(8))
    assert not needs_chunking(len(small))
    assert len(window_plan(len(small))) == 1

    counts = [
        len(window_plan(len(_encode(synth_output_map(n))))) for n in (64, 128, 256, 512, 1024)
    ]
    assert counts == sorted(counts) and counts[0] < counts[-1]
    assert counts[-1] >= 2 * counts[-2] - 1


@pytest.mark.requirements("PR-12")
def test_installation_topology_shards_and_keeps_every_association():
    flat = synth_topology(1024, map_id="__scale", n_segments=24, pts_per_seg=32, n_branch=24)
    frame = _encode(flat)
    windows = _shard(frame)
    assert len(windows) > 1 and all(len(w) <= CHUNK_BYTES for w in windows)

    topo = ClientMessage.FromString(reassemble(windows)).submit_topology.topology
    assert topo.map_id == "__scale"
    assert len(topo.associations) == 1024
    assert sorted(a.led_id for a in topo.associations) == list(range(1024))
    assert len(topo.segments) == 24 and all(len(s.polyline) == 32 for s in topo.segments)
    assert len(topo.branch_points) == 24


@pytest.mark.requirements("PR-12")
def test_tighter_per_record_budget_shrinks_every_window(monkeypatch):
    # The heapless-netstack build decrypts each TLS record in one contiguous
    # buffer, so its runs set HITL_CHUNK_BYTES=1024 (see map_upload_core).
    frame = _encode(synth_output_map(512))
    wss_windows = len(window_plan(len(frame), 4096))
    monkeypatch.setenv("HITL_CHUNK_BYTES", "1024")
    try:
        tight = importlib.reload(map_upload_core)
        assert tight.CHUNK_BYTES == 1024
        plan = tight.window_plan(len(frame))
        assert all(end - off <= 1024 for (_seq, off, end, _last) in plan)
        assert len(plan) >= 4 * wss_windows - 3
        assert tight.reassemble([frame[off:end] for (_s, off, end, _l) in plan]) == frame
    finally:
        monkeypatch.undo()  # restore the caller's env before rebuilding the module
        importlib.reload(map_upload_core)
