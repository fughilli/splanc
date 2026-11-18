"""Unit tests for the layout guard's geometry (no browser)."""

import unittest

from layout_guard import find_violations


def el(i, x, y, w, h, **kw):
    return {
        "id": str(i),
        "x": x,
        "y": y,
        "w": w,
        "h": h,
        "label": f"e{i}",
        "ancestors": [],
        "joined": None,
        **kw,
    }


class FindViolations(unittest.TestCase):
    def test_spaced_row_passes(self):
        self.assertEqual(find_violations([el(1, 0, 0, 100, 40), el(2, 112, 0, 100, 40)], 390), [])

    def test_exactly_min_gap_passes(self):
        self.assertEqual(find_violations([el(1, 0, 0, 100, 40), el(2, 108, 0, 100, 40)]), [])

    def test_crammed_row_fails(self):
        v = find_violations([el(1, 0, 0, 100, 40), el(2, 104, 0, 100, 40)])
        self.assertEqual([x.kind for x in v], ["gap"])

    def test_touching_buttons_fail(self):
        v = find_violations([el(1, 0, 0, 100, 40), el(2, 100, 0, 100, 40)])
        self.assertEqual([x.kind for x in v], ["gap"])

    def test_stacked_too_close_fails(self):
        v = find_violations([el(1, 0, 0, 300, 40), el(2, 0, 44, 300, 40)])
        self.assertEqual([x.kind for x in v], ["gap"])

    def test_overlap_fails(self):
        v = find_violations([el(1, 0, 0, 100, 40), el(2, 50, 10, 100, 40)])
        self.assertEqual([x.kind for x in v], ["overlap"])

    def test_diagonal_neighbours_far_enough_pass(self):
        self.assertEqual(find_violations([el(1, 0, 0, 100, 40), el(2, 104, 52, 100, 40)]), [])

    def test_joined_control_is_exempt(self):
        a, b = el(1, 0, 0, 60, 30, joined="g1"), el(2, 60, 0, 60, 30, joined="g1")
        self.assertEqual(find_violations([a, b]), [])
        # ...but not from a control outside the group.
        c = el(3, 122, 0, 60, 30)
        self.assertEqual([x.kind for x in find_violations([a, b, c])], ["gap"])

    def test_nested_control_is_exempt(self):
        card = el(1, 0, 0, 300, 120)
        inner = el(2, 10, 10, 40, 30, ancestors=["1"])
        self.assertEqual(find_violations([card, inner]), [])

    def test_offscreen_fails(self):
        v = find_violations([el(1, 300, 0, 120, 40)], 390)
        self.assertEqual([x.kind for x in v], ["offscreen"])

    def test_joined_control_offscreen_still_fails(self):
        v = find_violations(
            [el(1, 0, 0, 200, 30, joined="g"), el(2, 200, 0, 260, 30, joined="g")], 390
        )
        self.assertEqual([x.kind for x in v], ["offscreen"])

    def test_subpixel_slack(self):
        self.assertEqual(find_violations([el(1, 0, 0, 100, 40), el(2, 107.6, 0, 100, 40)]), [])


if __name__ == "__main__":
    unittest.main()
