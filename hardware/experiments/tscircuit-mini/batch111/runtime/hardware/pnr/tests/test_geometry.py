"""Unit tests for edge-pose overhang + outline-exclusion (connector fixes).

Pure geometry — no torch/pcbnew. Covers the connector edge-overhang parameter
(so a USB-C can protrude a controlled distance past the board edge) and the
outline check excluding intentionally-overhanging fixed parts.
"""

import unittest

from pnr.graph import BoardGraph, BoardOutline, Component
from pnr.place.geometry import Rect, _edge_pose
from pnr.place.metrics import outside_outline

W, H = 60.0, 50.0
CW, CH = 8.0, 4.0  # a connector courtyard


class EdgeOverhangTest(unittest.TestCase):
    def test_flush_by_default(self):
        # South edge, no overhang: courtyard bottom sits on y=0 (cy = h/2).
        _cx, cy = _edge_pose("south", None, CW, CH, W, H)
        self.assertAlmostEqual(cy, CH / 2)

    def test_south_overhang_pushes_past_edge(self):
        # Overhang 1.5 mm: the courtyard extends 1.5 mm below y=0.
        _cx, cy = _edge_pose("south", None, CW, CH, W, H, overhang=1.5)
        self.assertAlmostEqual(cy, CH / 2 - 1.5)
        self.assertLess(cy - CH / 2, 0.0)  # bottom edge is below the board

    def test_north_overhang(self):
        _cx, cy = _edge_pose("north", None, CW, CH, W, H, overhang=1.5)
        self.assertAlmostEqual(cy, H - CH / 2 + 1.5)

    def test_east_west_overhang(self):
        cx_e, _ = _edge_pose("east", None, CW, CH, W, H, overhang=2.0)
        cx_w, _ = _edge_pose("west", None, CW, CH, W, H, overhang=2.0)
        self.assertAlmostEqual(cx_e, W - CW / 2 + 2.0)
        self.assertAlmostEqual(cx_w, CW / 2 - 2.0)

    def test_negative_overhang_insets(self):
        _cx, cy = _edge_pose("south", None, CW, CH, W, H, overhang=-1.0)
        self.assertAlmostEqual(cy, CH / 2 + 1.0)  # pulled inward


class OutlineExcludeTest(unittest.TestCase):
    def _graph(self, usb_cy):
        # USB overhangs south (courtyard partly below y=0); a normal part inside.
        usb = Component("USB1", "fp", (30.0, usb_cy), 0.0, "top", (CW, CH), (CW, CH))
        u1 = Component("U1", "fp", (30.0, 25.0), 0.0, "top", (5, 5), (5, 5))
        return BoardGraph("t", [usb, u1], [], BoardOutline(W, H))

    def test_overhanging_fixed_part_flagged_without_exclude(self):
        g = self._graph(usb_cy=CH / 2 - 1.5)  # overhangs
        self.assertIn("USB1", outside_outline(g, W, H))

    def test_excluded_fixed_part_not_flagged(self):
        g = self._graph(usb_cy=CH / 2 - 1.5)
        self.assertNotIn("USB1", outside_outline(g, W, H, exclude={"USB1"}))
        # a genuinely-out part is still caught even if others are excluded
        self.assertEqual(outside_outline(g, W, H, exclude={"USB1"}), [])

    def test_rect_inside_helper(self):
        self.assertTrue(Rect(30, 25, 5, 5).inside(W, H))
        self.assertFalse(Rect(30, 1, 8, 4).inside(W, H))  # pokes below 0


if __name__ == "__main__":
    unittest.main()
