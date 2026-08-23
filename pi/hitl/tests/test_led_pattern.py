"""Unit tests for the LED counting-pattern helpers (pure; wire parity).

These pin the pixels the correctness capture expects against the pattern it drives
(led_pattern.expected_pixels vs counting_message) with no hardware, so the
drive/decode contract can't silently drift. The on-hardware capture+assert loop is
//pi/hitl/harness:led_capture (manual+hitl)."""

from led_pattern import (
    best_structural_capture,
    counting_message,
    diff_pixels,
    diff_pixels_aligned,
    diff_structure_aligned,
    expected_pixels,
)


def test_counting_message_shape():
    m = counting_message([(0, 2, (255, 0, 0))], channel=0)
    assert m["type"] == "set_counting_pattern"
    assert m["channel"] == 0
    assert m["blocks"] == [{"start": 0, "count": 2, "rgb": [1.0, 0.0, 0.0]}]
    # color_order is omitted by default (firmware uses its raw/identity probe order)…
    assert "color_order" not in m
    # …and included when given, so led_capture can drive an explicit wire order.
    assert counting_message([(0, 1, (1, 2, 3))], color_order="GRB")["color_order"] == "GRB"


def test_expected_pixels_paints_and_clears():
    px = expected_pixels([(0, 2, (255, 0, 0)), (3, 1, (0, 255, 0))], 5)
    assert px == [(255, 0, 0), (255, 0, 0), (0, 0, 0), (0, 255, 0), (0, 0, 0)]


def test_expected_pixels_clips_past_end():
    assert expected_pixels([(0, 10, (0, 0, 255))], 3) == [(0, 0, 255)] * 3


def test_later_block_overwrites_earlier():
    assert expected_pixels([(0, 3, (255, 0, 0)), (1, 1, (0, 255, 0))], 3) == [
        (255, 0, 0),
        (0, 255, 0),
        (255, 0, 0),
    ]


def test_diff_pixels_match_and_mismatch():
    assert diff_pixels([(1, 2, 3)], [(1, 2, 3)]) == []
    # A short capture surfaces the missing tail as None.
    assert diff_pixels([(1, 2, 3), (4, 5, 6)], [(1, 2, 3)]) == [(1, (4, 5, 6), None)]
    # A wrong pixel is reported with both values.
    assert diff_pixels([(1, 2, 3)], [(9, 9, 9)]) == [(0, (1, 2, 3), (9, 9, 9))]


def test_aligned_matches_pattern_offset_in_long_frame():
    # Reproduces the real hitl-rig-2/D7 capture: NUM_LEDS=256 strip, the 8-lit
    # counting pattern brightness-scaled to 160 (FastLED.setBrightness), landing at
    # a NON-zero decoded offset because the software trigger didn't align to frame
    # pixel 0. A got[:8] check fails; alignment finds it. (WORKLOG 2026-08-17.)
    want = expected_pixels([(0, 2, (255, 0, 0)), (2, 2, (0, 255, 0)), (4, 4, (0, 0, 255))], 8)
    pat = [(160, 0, 0), (160, 0, 0), (0, 160, 0), (0, 160, 0)] + [(0, 0, 160)] * 4
    got = [(0, 0, 0)] * 61 + pat + [(0, 0, 0)] * (256 - 61 - 8)  # one 256-px frame
    diffs, off = diff_structure_aligned(want, got)
    assert diffs == []  # structural match despite 160-scaling and the offset
    assert off == 61
    # A naive fixed-offset compare would have failed on the leading black pixels.
    from led_pattern import diff_structure

    assert diff_structure(want, got) != []


def test_aligned_reports_best_offset_on_true_mismatch():
    # A genuinely wrong pattern (blue where red is expected) still fails, at the
    # least-bad offset — alignment tolerance must not mask real structure errors.
    want = expected_pixels([(0, 4, (255, 0, 0))], 4)
    got = [(0, 0, 0)] * 10 + [(0, 0, 160)] * 4 + [(0, 0, 0)] * 10
    diffs, _ = diff_structure_aligned(want, got)
    assert diffs  # blue-lit != red-lit structure


# -- torn-frame re-capture (FUG-140): best_structural_capture ----------------


def _capture_seq(*frames):
    """A capture_fn that yields each given frame in turn (one per attempt)."""
    it = iter(frames)
    return lambda: next(it)


def test_recapture_returns_first_clean_frame():
    # A torn frame first (a garbage seam pixel where red is expected → no offset
    # matches), then a clean one: the helper must re-capture and pass on the clean
    # frame. Mirrors the FUG-140 flake: `diff_structure_aligned` alone would fail.
    want = expected_pixels([(0, 2, (255, 0, 0)), (2, 2, (0, 255, 0)), (4, 4, (0, 0, 255))], 8)
    clean = (
        [(0, 0, 0)] * 20
        + [
            (160, 0, 0),
            (160, 0, 0),
            (0, 160, 0),
            (0, 160, 0),
            (0, 0, 160),
            (0, 0, 160),
            (0, 0, 160),
            (0, 0, 160),
        ]
        + [(0, 0, 0)] * 20
    )
    torn = list(clean)
    torn[21] = (1, 0, 254)  # a torn seam pixel — breaks every 8-window over the block
    torn[24] = (200, 0, 0)  # blue expected here, decoded as red (frame straddle)
    # Sanity: the torn frame alone has no clean structural offset.
    assert diff_structure_aligned(want, torn)[0]
    got, diffs, _ = best_structural_capture(_capture_seq(torn, clean), want, attempts=4)
    assert diffs == []
    assert got == clean  # re-captured past the torn frame


def test_recapture_returns_best_effort_when_never_clean():
    # A real fault (all captures torn/wrong) must still fail — retries don't mask it —
    # and return the fewest-diff attempt for reporting.
    want = expected_pixels([(0, 4, (255, 0, 0))], 4)
    worse = [(0, 0, 160)] * 4  # all blue: 4 structural diffs vs red
    better = [(160, 0, 0), (160, 0, 0), (0, 0, 160), (0, 0, 160)]  # 2 diffs
    got, diffs, _ = best_structural_capture(_capture_seq(worse, better, worse), want, attempts=3)
    assert diffs  # still a failure — a real fault is not retried away
    assert len(diffs) == 2 and got == better  # kept the least-bad attempt


def test_recapture_calls_on_retry_between_attempts():
    want = expected_pixels([(0, 2, (255, 0, 0))], 2)
    torn = [(1, 0, 254), (0, 0, 160)]
    clean = [(160, 0, 0), (160, 0, 0)]
    seen = []
    best_structural_capture(
        _capture_seq(torn, clean), want, attempts=4, on_retry=lambda a, d, o: seen.append(a)
    )
    assert seen == [1]  # one retry notice before the clean second capture; none after


# -- JIT-verify differential (FUG-134): diff_pixels_aligned ------------------


def _frame(n):
    # A distinct per-LED frame — like jit_bench's per-LED output, every LED lit.
    return [(i * 7 % 256, 0x20, 0x50) for i in range(n)]


def test_jit_aligned_identical_captures_pass_at_any_phase():
    # Two captures of the SAME static frame, each starting at a different phase and
    # spanning several frames — the JIT-on vs JIT-off happy path. An exact match
    # must be found regardless of where each capture's software trigger armed.
    n = 8
    frame = _frame(n)
    tiled = frame * 4
    a = tiled[3 : 3 + 2 * n + 2]  # phase 3, >=2 frames
    b = tiled[5 : 5 + 2 * n + 2]  # phase 5
    diffs, off = diff_pixels_aligned(a, b, n)
    assert diffs == []
    assert b[off : off + n] == a[n : 2 * n]  # matched a whole mid-frame of `a`


def test_jit_aligned_flags_a_single_divergent_pixel():
    # One wrong pixel in the JIT-on capture (a codegen divergence) must fail — the
    # compare is EXACT bytes, not structure, so even a 1-LSB difference is caught.
    n = 8
    frame = _frame(n)
    a = frame * 3
    bad = list(frame)
    bad[2] = (bad[2][0] ^ 0x01, bad[2][1], bad[2][2])  # flip one bit
    b = bad * 3
    diffs, _ = diff_pixels_aligned(a, b, n)
    assert diffs  # not bit-identical -> real JIT/interpreter divergence


def test_jit_aligned_short_capture_falls_back_to_head_compare():
    # Fewer than a full frame captured: fall back to a head-to-head diff so the
    # caller still gets a signal rather than a bogus empty (matched-nothing) pass.
    n = 8
    frame = _frame(n)
    # Equal short heads -> the compared prefix matches (empty diff).
    assert diff_pixels_aligned(frame[:3], frame[:3], n) == ([], 0)
    # Differing short heads still surface a diff via the fallback path.
    diffs, off = diff_pixels_aligned(frame[:3], [(0, 0, 0)] * 3, n)
    assert off == 0 and diffs
