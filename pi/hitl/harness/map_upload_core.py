"""Pure logic for the HITL large-map-upload test (FUG-74): the sharded-upload
window plan the harness sends, plus synthetic map/topology fixtures big enough to
reproduce the failure. No hardware, no network — split out from hitl_map_upload.py
so the chunking contract (which MUST match web/src/net/client.ts `sendChunked`
and the firmware's reassembly in firmware/player_app) is unit-tested without a
rig, the way the tests/ dir pins device/app/harness parity.

FUG-74: a whole ~15 KB submit_map is one TLS record the C6 can't allocate on its
fragmented heap, so the connection dropped mid-upload. The app/harness slice the
encoded frame into <=CHUNK_BYTES UploadChunk windows the device acks one at a
time and streams to flash. CHUNK_BYTES must match the client + firmware."""

from __future__ import annotations

from typing import Any

# Must match web/src/net/client.ts CHUNK_BYTES, and stay well under the device's
# single-frame ceiling (firmware kRxCap) so each window is one small TLS record.
CHUNK_BYTES = 4096


def needs_chunking(frame_len: int, chunk_bytes: int = CHUNK_BYTES) -> bool:
    """Whether a frame is large enough that the client shards it; a frame that
    already fits one window goes as a single submit_map/submit_topology."""
    return frame_len > chunk_bytes


def window_plan(frame_len: int, chunk_bytes: int = CHUNK_BYTES) -> list[tuple[int, int, int, bool]]:
    """The (seq, off, end, last) windows covering [0, frame_len), exactly as
    sendChunked slices the encoded frame: dense seq from 0, each span
    <= chunk_bytes, and only the final window flagged `last`."""
    windows: list[tuple[int, int, int, bool]] = []
    seq = 0
    off = 0
    while off < frame_len:
        end = min(off + chunk_bytes, frame_len)
        windows.append((seq, off, end, end >= frame_len))
        off = end
        seq += 1
    return windows


def reassemble(payloads: list[bytes]) -> bytes:
    """What the device does with the window payloads: concatenate them in seq
    order back into the original frame (the opaque-slice contract)."""
    return b"".join(payloads)


def synth_output_map(n_leds: int, map_id: str = "__fug74") -> dict[str, Any]:
    """A synthetic submit_map flat dict carrying the FULL LedEntry fields (not
    just id+xyz), so the encoded frame is ~60 B/LED — at the firmware's 256-LED
    cap that's ~15 KB, the single-record size that OOMed FUG-74. Any n_leds past
    ~70 exceeds CHUNK_BYTES and exercises the multi-window sharded path."""
    denom = max(1, n_leds - 1)
    leds = [
        {
            "id": i,
            "xyz": [i / denom, (i % 7) / 7.0, -i / denom],
            "confidence": 0.9,
            "n_views": 12,
            "rms_reproj_px": 0.5,
            "parallax_deg": 21.0,
        }
        for i in range(n_leds)
    ]
    return {
        "type": "submit_map",
        "map": {
            "map_id": map_id,
            "created_at": "2026-01-01T00:00:00Z",
            "units": "meters",
            "frame": "gravity_leveled",
            "led_count": n_leds,
            "leds": leds,
        },
    }


def synth_topology(
    n_leds: int,
    map_id: str = "__fug74",
    n_segments: int = 12,
    pts_per_seg: int = 20,
    n_branch: int = 12,
) -> dict[str, Any]:
    """A synthetic submit_topology flat dict shaped like a real solver's output
    for an `n_leds` scan: one association per LED across `n_segments` segments,
    each carrying a `pts_per_seg` polyline, plus `n_branch` branch points. A few
    KB — also past CHUNK_BYTES, so both uploads shard. `polyline` uses the flat
    [[x,y,z], ...] shape proto_wire reshapes into repeated Vec3."""
    branch_points = [{"id": i, "xyz": [i * 0.01, 0.1, -i * 0.01]} for i in range(n_branch)]
    segments = []
    for s in range(n_segments):
        polyline = [[p / pts_per_seg, 0.02 * s, -(p / pts_per_seg)] for p in range(pts_per_seg)]
        segments.append(
            {
                "id": s,
                "a": s,
                "b": s + 1 if s + 1 < n_segments else -1,
                "length": 1.0,
                "polyline": polyline,
            }
        )
    associations = [
        {
            "led_id": i,
            "segment_id": i % max(1, n_segments),
            "foot_arclength": i * 0.001,
            "d_perp": 0.003,
        }
        for i in range(n_leds)
    ]
    return {
        "type": "submit_topology",
        "topology": {
            "map_id": map_id,
            "branch_points": branch_points,
            "segments": segments,
            "associations": associations,
        },
    }
