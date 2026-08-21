"""Color-order helpers for the hardware-config logic-analyzer test (pure, no I/O).

FUG-123 makes the WS2812 wire color order configurable (set_hardware_config). The
only way to VERIFY it is to look at the actual bytes on the DIN line — a logic
analyzer. This module computes what the rig's decoder should read back for a given
CONFIGURED order, so the on-hardware test (hitl_hardware_config.py) reads:

    set_hardware_config(color_order=order)     # over the player WebSocket
    drive(counting_message(R/G/B blocks))      # logical primaries
    got = capture(dut)                          # the analyzer decodes the wire
    want = expected_decoded_pixels(order, blocks, n)
    assert not diff_structure(want, got)

Why the prediction is well-defined: the rig's WS2812 decoder assumes a FIXED wire
order and knows nothing about the firmware's configured order — and the sibling
led_capture test already proves that, under the DEFAULT firmware order (GRB), the
decoder reads back the logical primaries unchanged. So the decoder's fixed
convention IS "wire is GRB": it maps wire bytes (b0,b1,b2) -> RGB (b1,b0,b2).

For a firmware configured to wire order `O` (a permutation of "RGB"), a logical
pixel L=(Lr,Lg,Lb) is emitted as wire bytes w[i] = L[perm(O)[i]] (perm(O)[i] is the
index in "RGB" of O's i-th char). The analyzer then decodes that wire as GRB:

    decoded = (w[1], w[0], w[2]) = (L[perm[1]], L[perm[0]], L[perm[2]])

which collapses to the identity for O == "GRB" (as the led_capture test observes),
and to a predictable permutation otherwise. The pure contract here is unit-tested
off hardware in //pi/hitl/tests:hitl_test (test_hardware_config_pattern.py).
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

Block = Tuple[int, int, Tuple[int, int, int]]
Pixel = Tuple[int, int, int]

# The six wire color orders (permutations of "RGB"); "GRB" is the WS2812B default.
COLOR_ORDERS: List[str] = ["RGB", "RBG", "GRB", "GBR", "BRG", "BGR"]

# The analyzer's fixed decode convention: it reads the wire as GRB, i.e. RGB byte i
# comes from wire byte DECODE_SRC[i]. (Proven by led_capture passing under default
# GRB firmware — decoded == logical there.)
_DECODE_SRC = (1, 0, 2)


def perm(order: str) -> Tuple[int, int, int]:
    """Source permutation for wire order `order`: wire byte i carries logical
    channel perm[i] (R=0, G=1, B=2). E.g. "GRB" -> (1, 0, 2)."""
    order = order.upper()
    if sorted(order) != ["B", "G", "R"]:
        raise ValueError(f"not a permutation of RGB: {order!r}")
    idx = {"R": 0, "G": 1, "B": 2}
    return (idx[order[0]], idx[order[1]], idx[order[2]])


def la_decoded(order: str, logical: Sequence[int]) -> Pixel:
    """The (r,g,b) the analyzer decodes when the firmware is configured to wire
    order `order` and asked to show logical color `logical`."""
    p = perm(order)
    # wire[i] = logical[p[i]]; analyzer decodes RGB[i] = wire[_DECODE_SRC[i]].
    wire = (logical[p[0]], logical[p[1]], logical[p[2]])
    return (wire[_DECODE_SRC[0]], wire[_DECODE_SRC[1]], wire[_DECODE_SRC[2]])


def expected_decoded_pixels(order: str, blocks: Sequence[Block], n: int) -> List[Pixel]:
    """The n pixels the analyzer should decode from the wire when the firmware is
    configured to wire order `order` and driven with `blocks` (logical colors).

    Same block semantics as led_pattern.expected_pixels (later blocks overwrite,
    painting past the strip end is clipped), but each block's LOGICAL color is
    mapped through the configured order + the analyzer's fixed decode."""
    out: List[Pixel] = [(0, 0, 0)] * n
    for start, count, color in blocks:
        decoded = la_decoded(order, (int(color[0]), int(color[1]), int(color[2])))
        for i in range(start, min(start + count, n)):
            if 0 <= i < n:
                out[i] = decoded
    return out
