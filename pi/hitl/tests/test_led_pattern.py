"""Unit tests for the LED counting-pattern helpers (pure; wire parity).

These pin the pixels the correctness capture expects against the pattern it drives
(led_pattern.expected_pixels vs counting_message) with no hardware, so the
drive/decode contract can't silently drift. The on-hardware capture+assert loop is
//pi/hitl/harness:led_capture (manual+hitl)."""

from led_pattern import counting_message, diff_pixels, expected_pixels


def test_counting_message_shape():
    m = counting_message([(0, 2, (255, 0, 0))], channel=0)
    assert m["type"] == "set_counting_pattern"
    assert m["channel"] == 0
    assert m["blocks"] == [{"start": 0, "count": 2, "rgb": [1.0, 0.0, 0.0]}]


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
