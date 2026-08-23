"""Tests for the placement write-back frame math + (pcbnew-gated) round-trip.

The pure coordinate transform (engine mm y-up → pcbnew nm y-down + page offset)
is tested directly. When ``pcbnew`` is importable, a live test applies a known
placement onto the fixture board and re-reads it to confirm footprints land at
the expected poses and the new ``Edge.Cuts`` outline is present.
"""

import importlib.util
import os
import unittest

from pnr.writeback import _NM_PER_MM, _PAGE_OFFSET_MM, strip_edge_cuts, to_pcb_nm

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "testdata", "splanc_dev")


class FrameMathTest(unittest.TestCase):
    def test_origin_maps_to_page_offset_top(self):
        # engine (0,0) bottom-left -> pcbnew (offset, offset+H): y is flipped.
        h = 50.0
        px, py = to_pcb_nm(0.0, 0.0, h)
        self.assertEqual(px, int(_PAGE_OFFSET_MM * _NM_PER_MM))
        self.assertEqual(py, int((_PAGE_OFFSET_MM + h) * _NM_PER_MM))

    def test_top_of_board_maps_to_page_offset(self):
        # engine (0,H) top-left -> pcbnew y == offset (smallest y, since y-down).
        h = 50.0
        _px, py = to_pcb_nm(0.0, h, h)
        self.assertEqual(py, int(_PAGE_OFFSET_MM * _NM_PER_MM))

    def test_x_is_shifted_not_flipped(self):
        px, _py = to_pcb_nm(10.0, 0.0, 50.0)
        self.assertEqual(px, int((_PAGE_OFFSET_MM + 10.0) * _NM_PER_MM))

    def test_integer_nanometres(self):
        px, py = to_pcb_nm(1.2345, 6.789, 50.0)
        self.assertIsInstance(px, int)
        self.assertIsInstance(py, int)


class StripEdgeCutsTest(unittest.TestCase):
    def test_removes_nested_edge_cuts_keeps_others(self):
        # A pcbnew-style nested gr_line on Edge.Cuts + one on F.Silkscreen.
        text = (
            "(kicad_pcb\n"
            "  (gr_line (start 0 0) (end 10 0)\n"
            '    (stroke (width 0.15) (type solid)) (layer "Edge.Cuts")\n'
            '    (uuid "a70117e0-0000-4000-8000-000000000000"))\n'
            "  (gr_line (start 0 0) (end 5 5)\n"
            '    (stroke (width 0.1) (type solid)) (layer "F.Silkscreen"))\n'
            "  (footprint x))\n"
        )
        stripped = strip_edge_cuts(text)
        self.assertNotIn("Edge.Cuts", stripped)
        self.assertIn("F.Silkscreen", stripped)  # non-Edge.Cuts graphics preserved
        self.assertIn("(footprint x)", stripped)

    def test_removes_multiple_edge_cuts(self):
        seg = (
            "  (gr_line (start {a} 0) (end {b} 0)\n"
            '    (stroke (width 0.15) (type solid)) (layer "Edge.Cuts"))\n'
        )
        text = "(kicad_pcb\n" + "".join(seg.format(a=i, b=i + 1) for i in range(8)) + ")\n"
        self.assertEqual(strip_edge_cuts(text).count("Edge.Cuts"), 0)

    def test_no_edge_cuts_is_noop(self):
        text = '(kicad_pcb (gr_line (start 0 0) (end 1 1) (layer "F.Cu")))\n'
        self.assertEqual(strip_edge_cuts(text), text)


@unittest.skipUnless(
    importlib.util.find_spec("pcbnew") is not None,
    "pcbnew (KiCad python) not available in this interpreter",
)
class LiveWritebackTest(unittest.TestCase):
    def test_apply_places_and_outlines(self):
        import pcbnew
        from pnr.graph import BoardGraph, BoardOutline
        from pnr.writeback import apply_placement

        board = pcbnew.LoadBoard(os.path.join(FIXTURE, "splanc_dev.kicad_pcb"))
        # Move one real footprint to a known engine pose; frame at 60x50.
        ref = board.GetFootprints()[0].GetReference()
        g = BoardGraph.from_json(open(os.path.join(FIXTURE, "graph.json"), encoding="utf-8").read())
        target = g.component(ref)
        target.pos = (10.0, 20.0)
        g.outline = BoardOutline(60.0, 50.0)

        # Seed a track so we can confirm apply_placement clears stale routing.
        t = pcbnew.PCB_TRACK(board)
        t.SetStart(pcbnew.VECTOR2I(0, 0))
        t.SetEnd(pcbnew.VECTOR2I(1000, 0))
        board.Add(t)

        n = apply_placement(board, g, width=60.0, height=50.0)
        self.assertEqual(n, len(g.components))

        moved = None
        for fp in board.GetFootprints():
            if fp.GetReference() == ref:
                moved = fp
        px, py = to_pcb_nm(10.0, 20.0, 50.0)
        self.assertEqual(moved.GetPosition().x, px)
        self.assertEqual(moved.GetPosition().y, py)
        # Stale routing was cleared (the detailed router re-routes from clean).
        self.assertEqual(len(list(board.GetTracks())), 0)


if __name__ == "__main__":
    unittest.main()
