"""Known-pattern helpers for LED-driver correctness capture (pure, no I/O).

For a correctness test the rig drives the ESP32-C6 DUT to display a static
color-block pattern (`set_counting_pattern`, protocol §7.9) and the rig's shared
logic analyzer captures the WS2812 DIN. These helpers build the command and
compute the pixels the analyzer SHOULD decode, so a test reads:

    drive(counting_message(blocks))            # over the player WebSocket
    got = capture(dut)                          # via `hitl-capture` / the daemon
    assert not diff_pixels(expected_pixels(blocks, n), got)

Assert STRUCTURE, not exact bytes. The counting/calibration pattern is written to
the FastLED buffer RAW — the firmware bypasses its color-correction LUT + software
brightness for it on purpose (main.cpp cc_apply vs the counting-probe branch), and
the redundant FastLED-global brightness scale was removed, so on current firmware a
full-scale calibration pattern reaches the wire at its exact values. We still compare
lit-channel signatures (which channels are on), not raw values, so the check stays
robust to the software brightness control (which dims CONTENT paths via g_brightness)
and any per-channel correction — and to older firmware that still dimmed the wire
(255 showed up as ~160). Use pure primaries/off for the blocks so each LED's signature
is unambiguous. (diff_pixels is for synthesized traces where you control the bytes.)
"""

from __future__ import annotations

from typing import List, Sequence, Tuple

# (start, count, (r, g, b)) with r,g,b in 0..255.
Block = Tuple[int, int, Tuple[int, int, int]]
Pixel = Tuple[int, int, int]


def counting_message(
    blocks: Sequence[Block], channel: int = 0, color_order: str | None = None
) -> dict:
    """A set_counting_pattern flat message ready for proto_wire.encode_client.

    The wire carries rgb in [0,1]; we scale the 0..255 block colors down so the
    caller thinks in bytes (matching what the analyzer decodes back).

    color_order selects the WS2812 wire order the probe emits. The firmware default
    (color_order unset) is IDENTITY/raw — logical RGB straight to the wire — which a
    GRB-assuming analyzer reads back R/G-swapped. Pass "GRB" (the WS2812B order the
    analyzer decodes and real content uses) so logical primaries decode back as
    themselves; the color-order test drives the other orders explicitly.
    """
    m = {
        "type": "set_counting_pattern",
        "blocks": [
            {"start": s, "count": c, "rgb": [r / 255.0, g / 255.0, b / 255.0]}
            for (s, c, (r, g, b)) in blocks
        ],
        "channel": channel,
    }
    if color_order is not None:
        m["color_order"] = color_order
    return m


def expected_pixels(blocks: Sequence[Block], n: int) -> List[Pixel]:
    """The n pixels the analyzer should decode from the wire.

    Each block paints [start, start+count) with its color; uncovered LEDs are off.
    Later blocks overwrite earlier ones, and painting past the strip end is clipped
    (that overrun IS the counting probe on the firmware side, but the wire only
    carries the physical LEDs).
    """
    out: List[Pixel] = [(0, 0, 0)] * n
    for start, count, color in blocks:
        c = (int(color[0]), int(color[1]), int(color[2]))
        for i in range(start, min(start + count, n)):
            if 0 <= i < n:
                out[i] = c
    return out


def channel_sig(px: Sequence[int]) -> Tuple[bool, bool, bool]:
    """Which of R/G/B are lit — the pattern's structure independent of intensity."""
    return (px[0] > 0, px[1] > 0, px[2] > 0)


def diff_structure(
    expected: Sequence[Pixel], got: Sequence[Pixel]
) -> List[Tuple[int, Pixel, object]]:
    """Positions where the lit-channel structure differs.

    The firmware applies WS2812 color-correction/gamma + brightness before the
    RMT push, so full-scale 255 reaches the wire scaled down (e.g. 160). A
    correctness capture should therefore assert the pattern's STRUCTURE — which
    LEDs are lit and in which channel(s) — not exact 8-bit values. For the
    pure-primary/off blocks we drive, the channel signature captures the pattern
    fully. (Use diff_pixels for exact-value checks, e.g. synthesized traces.)
    """
    diffs: List[Tuple[int, Pixel, object]] = []
    for i, e in enumerate(expected):
        g = got[i] if i < len(got) else None
        if g is None or channel_sig(g) != channel_sig(e):
            diffs.append((i, e, g if g is None else tuple(g)))
    return diffs


def diff_structure_aligned(
    expected: Sequence[Pixel], got: Sequence[Pixel]
) -> Tuple[List[Tuple[int, Pixel, object]], int]:
    """diff_structure, but tolerant of where the pattern sits in the capture.

    The DUT drives a long strip (NUM_LEDS, e.g. 256) with only the pattern's LEDs
    lit; the analyzer decodes one or more whole frames, and which decoded index the
    lit block lands on depends on where the software trigger aligned to the frame —
    it is NOT reliably 0. A fixed got[:n] comparison is therefore a coin flip (see
    WORKLOG 2026-08-17). We instead slide `expected` across `got` and report the
    best-matching offset, so the assert tracks the pattern's STRUCTURE regardless of
    frame alignment. Returns (diffs_at_best_offset, best_offset); empty diffs = a
    clean structural match somewhere in the capture.
    """
    n = len(expected)
    if n == 0 or len(got) < n:
        return diff_structure(expected, got), 0
    best_diffs = None
    best_off = 0
    for off in range(0, len(got) - n + 1):
        diffs = diff_structure(expected, got[off : off + n])
        if not diffs:
            return [], off  # perfect structural match — done
        if best_diffs is None or len(diffs) < len(best_diffs):
            best_diffs, best_off = diffs, off
    return (best_diffs or []), best_off


def best_structural_capture(
    capture_fn,
    expected: Sequence[Pixel],
    attempts: int = 4,
    on_retry=None,
) -> Tuple[List[Pixel], List[Tuple[int, Pixel, object]], int]:
    """Re-capture until the decode structurally matches `expected`.

    `diff_structure_aligned` already slides `expected` across a capture to tolerate
    where the lit block landed, but it needs ONE untorn window to exist: if the
    analyzer's software trigger armed across a repaint seam the decoded frame is
    torn (a garbage pixel at the seam, e.g. a red↔blue boundary decoding as
    `(1,0,254)`), and NO offset matches — a coin-flip red (FUG-140). The pattern is
    static on the wire, so a fresh capture re-arms at a new phase and clears the
    tear; a *real* mismatch (miswire / wrong order) fails every attempt. Call
    `capture_fn()` up to `attempts` times, returning the first clean
    `(got, [], off)`, else the fewest-diff `(got, diffs, off)` seen. `on_retry(attempt,
    diffs, off)` is invoked after each non-clean attempt (except the last) for logging.
    """
    attempts = max(1, attempts)
    best: Tuple[List[Pixel], List[Tuple[int, Pixel, object]], int] | None = None
    for attempt in range(1, attempts + 1):
        got = list(capture_fn())
        diffs, off = diff_structure_aligned(expected, got)
        if not diffs:
            return got, [], off
        if best is None or len(diffs) < len(best[1]):
            best = (got, diffs, off)
        if on_retry is not None and attempt < attempts:
            on_retry(attempt, diffs, off)
    return best  # type: ignore[return-value]  # attempts>=1 => best is set


def diff_pixels(expected: Sequence[Pixel], got: Sequence[Pixel]) -> List[Tuple[int, Pixel, object]]:
    """Positions where the captured pixels differ from expected.

    Returns (index, expected, got-or-None) triples; empty means a match. A shorter
    `got` (analyzer saw fewer LEDs than driven) surfaces as trailing None entries.
    """
    diffs: List[Tuple[int, Pixel, object]] = []
    for i, e in enumerate(expected):
        g = got[i] if i < len(got) else None
        if g is None or tuple(g) != tuple(e):
            diffs.append((i, e, g if g is None else tuple(g)))
    return diffs


def diff_pixels_aligned(
    a: Sequence[Pixel], b: Sequence[Pixel], n: int
) -> Tuple[List[Tuple[int, Pixel, object]], int]:
    """Exact-byte diff of two captures of the SAME static n-pixel frame at unknown
    phase — the JIT-off vs JIT-on differential (FUG-134).

    Both captures are the wire of one static effect (`jit_bench.fx`): the DUT keeps
    re-pushing an identical n-LED frame, so each capture is that frame repeated at
    an arbitrary starting phase (the software trigger arms mid-frame — see
    diff_structure_aligned). We take one WHOLE frame from `a` (skipping a possibly
    partial leading frame when the capture is long enough) and slide it across `b`,
    reporting the best EXACT-byte offset. Empty diffs = the two are byte-identical
    somewhere, i.e. the JIT rendered bit-identically to the interpreter.

    This is an exact (not structural) compare on purpose: both passes run the
    identical firmware content path (color-correction + brightness), so the ONLY
    variable is the JIT — any surviving pixel difference is a real
    codegen/W^X/i-cache divergence, not a brightness/correction artifact.

    Returns (diffs_at_best_offset, best_offset). With too few pixels to hold a full
    frame it falls back to a head-to-head compare so the caller still gets a diff.
    """
    if n <= 0 or len(a) < n or len(b) < n:
        return diff_pixels(list(a[:n]), list(b[:n])), 0
    # Anchor on a whole frame from the middle of `a` when we have >=2 frames, so a
    # torn leading pixel (trigger caught mid-transmission) can't skew the compare.
    start = n if len(a) >= 2 * n else 0
    ref = a[start : start + n]
    best_diffs: List[Tuple[int, Pixel, object]] | None = None
    best_off = 0
    for off in range(0, len(b) - n + 1):
        diffs = diff_pixels(ref, b[off : off + n])
        if not diffs:
            return [], off  # exact match somewhere — done
        if best_diffs is None or len(diffs) < len(best_diffs):
            best_diffs, best_off = diffs, off
    return (best_diffs or []), best_off
