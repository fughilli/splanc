#!/usr/bin/env python3
"""Generate a synthetic MappingBundle (.binpb) for testing effects/topology.

A 3-arm "Y" fixture: 30 LEDs on three straight arms meeting at ONE branch point
(a degree-3 junction), so it exercises junction-aware effects (pulse split,
flood at a fork) and the topology data model. Deterministic (no jitter) so the
file + any test over it are stable.

Emits ledmapper.v1.MappingBundle wire bytes directly (proto3, hand-encoded — no
protobuf runtime needed). Validate with:

  bazel run //tools/toolchains:protoc -- --decode=ledmapper.v1.MappingBundle \
    -I shared/protocol/proto shared/protocol/proto/ledmapper.proto \
    < testdata/synthetic_y_junction.binpb

Output: testdata/synthetic_y_junction.binpb
"""

import math
import struct
import pathlib

# ---- minimal proto3 wire encoder ------------------------------------------


def _varint(n: int) -> bytes:
    # int32 negatives are sign-extended to 64 bits on the wire.
    if n < 0:
        n += 1 << 64
    out = bytearray()
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out.append(b | 0x80)
        else:
            out.append(b)
            return bytes(out)


def _tag(field: int, wt: int) -> bytes:
    return _varint((field << 3) | wt)


def f_varint(field: int, n: int) -> bytes:
    return _tag(field, 0) + _varint(n)


def f_double(field: int, x: float) -> bytes:
    return _tag(field, 1) + struct.pack("<d", x)


def f_string(field: int, s: str) -> bytes:
    b = s.encode("utf-8")
    return _tag(field, 2) + _varint(len(b)) + b


def f_packed_double(field: int, xs) -> bytes:
    payload = b"".join(struct.pack("<d", x) for x in xs)
    return _tag(field, 2) + _varint(len(payload)) + payload


def f_msg(field: int, msg: bytes) -> bytes:
    return _tag(field, 2) + _varint(len(msg)) + msg


# ---- message builders ------------------------------------------------------


def led_entry(led_id, xyz):
    return (
        f_varint(1, led_id)
        + f_packed_double(2, xyz)
        + f_double(3, 1.0)       # confidence
        + f_varint(4, 3)         # n_views
        + f_double(5, 0.2)       # rms_reproj_px
        + f_double(6, 25.0)      # parallax_deg
    )


def vec3(xyz):
    return f_packed_double(1, xyz)


def branch_point(bp_id, xyz):
    return f_varint(1, bp_id) + f_packed_double(2, xyz)


def segment(seg_id, a, b, polyline, length):
    out = f_varint(1, seg_id) + f_varint(2, a) + f_varint(3, b)
    for p in polyline:
        out += f_msg(4, vec3(p))
    out += f_double(5, length)
    return out


def association(led_id, seg_id, arclen):
    return f_varint(1, led_id) + f_varint(2, seg_id) + f_double(3, arclen)


# ---- geometry: 3-arm Y in the XY plane, junction at the origin -------------

SPACING = 0.05  # meters between adjacent LEDs (typical strip pitch)
ARMS = [
    # (direction unit vector, led count)
    ((1.0, 0.0, 0.0), 10),
    ((math.cos(math.radians(120)), math.sin(math.radians(120)), 0.0), 12),
    ((math.cos(math.radians(240)), math.sin(math.radians(240)), 0.0), 8),
]

leds = []
segments = []
associations = []
led_id = 0
for seg_id, (d, count) in enumerate(ARMS):
    polyline = [(0.0, 0.0, 0.0)]  # start at the junction
    for k in range(1, count + 1):
        pos = (d[0] * SPACING * k, d[1] * SPACING * k, d[2] * SPACING * k)
        leds.append(led_entry(led_id, pos))
        associations.append(association(led_id, seg_id, SPACING * k))
        polyline.append(pos)
        led_id += 1
    segments.append(segment(seg_id, 0, -1, polyline, SPACING * count))

led_count = led_id  # 30

out_map = (
    f_string(1, "synthetic-y-junction")
    + f_string(2, "2026-07-22T00:00:00Z")
    + f_string(3, "meters")
    + f_string(4, "gravity_leveled")
    + f_varint(5, led_count)
    + b"".join(f_msg(6, m) for m in leds)
)

topology = (
    f_string(1, "synthetic-y-junction")
    + f_msg(2, branch_point(0, (0.0, 0.0, 0.0)))
    + b"".join(f_msg(3, s) for s in segments)
    + b"".join(f_msg(4, a) for a in associations)
)

bundle = f_msg(1, out_map) + f_msg(2, topology)

repo = pathlib.Path(__file__).resolve().parent.parent
dest = repo / "testdata" / "synthetic_y_junction.binpb"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_bytes(bundle)
print(f"wrote {dest} ({len(bundle)} bytes): {led_count} LEDs, 1 branch point, "
      f"{len(segments)} segments")
