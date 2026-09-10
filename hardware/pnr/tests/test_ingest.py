"""Phase 1 acceptance — ingestion of the resolved splanc_dev board.

The fixture ``testdata/splanc_dev/graph.json`` is the frozen output of
``pnr.ingest`` run (under the KiCad ``pcbnew`` python) on the committed
``splanc_dev.kicad_pcb``. These tests assert the ingested graph has the expected
shape and that the pure SVG renderer works off it — with no KiCad needed. When
``pcbnew`` *is* importable (e.g. a dev box or a CI lane with the KiCad toolchain),
an extra test re-extracts from the ``.kicad_pcb`` and checks it matches the frozen
graph, so the bridge is exercised end-to-end there.
"""

import os
import unittest

from pnr.graph import BoardGraph
from pnr.ingest import build_graph, dump_svg

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "testdata", "splanc_dev")

# The resolved splanc_dev board, as frozen (atopile row placement, 79 parts).
EXPECT_COMPONENTS = 79
EXPECT_NETS = 71
EXPECT_PADS = 338


def _frozen_graph() -> BoardGraph:
    with open(os.path.join(FIXTURE, "graph.json"), encoding="utf-8") as fh:
        return BoardGraph.from_json(fh.read())


class FrozenGraphTest(unittest.TestCase):
    def test_expected_counts(self):
        g = _frozen_graph()
        self.assertEqual(g.name, "splanc_dev")
        self.assertEqual(len(g.components), EXPECT_COMPONENTS)
        self.assertEqual(len(g.nets), EXPECT_NETS)
        self.assertEqual(g.pad_count, EXPECT_PADS)

    def test_graph_is_well_formed(self):
        g = _frozen_graph()
        # Every pad's net (when set) names a real net; every net pin names a
        # real component. This is the invariant the placer relies on.
        net_names = {n.name for n in g.nets}
        refs = set(g.refs)
        for c in g.components:
            self.assertTrue(c.footprint)
            self.assertIn(c.side, ("top", "bottom"))
            for p in c.pads:
                if p.net:
                    self.assertIn(p.net, net_names)
        for n in g.nets:
            self.assertGreaterEqual(n.degree, 1)
            for ref, _pad in n.pins:
                self.assertIn(ref, refs)

    def test_has_outline(self):
        g = _frozen_graph()
        self.assertIsNotNone(g.outline)
        self.assertGreater(g.outline.width, 0)
        self.assertGreater(g.outline.height, 0)


class SvgRenderTest(unittest.TestCase):
    def test_dump_svg_off_graph(self):
        g = _frozen_graph()
        svg = dump_svg(g)
        self.assertTrue(svg.startswith("<svg"))
        self.assertIn("</svg>", svg)
        # A ratsnest line per multi-pin net and a courtyard rect per component.
        self.assertIn("<line", svg)
        self.assertGreaterEqual(svg.count("<rect"), EXPECT_COMPONENTS)


@unittest.skipUnless(
    __import__("importlib").util.find_spec("pcbnew") is not None,
    "pcbnew (KiCad python) not available in this interpreter",
)
class LiveExtractionTest(unittest.TestCase):
    """Re-extract from the .kicad_pcb and confirm it matches the frozen graph."""

    def test_offset_body_is_bounded_about_origin_at_any_rotation(self):
        import pcbnew
        from pnr.ingest import _phys_bbox_mm
        board = pcbnew.BOARD()
        fp = pcbnew.FOOTPRINT(board)
        board.Add(fp)
        fp.SetPosition(pcbnew.VECTOR2I(30000000, 40000000))
        pad = pcbnew.PAD(fp)
        pad.SetShape(pcbnew.PAD_SHAPE_RECT)
        pad.SetSize(pcbnew.VECTOR2I(2000000, 4000000))
        fp.Add(pad)
        pad.SetPosition(pcbnew.VECTOR2I(35000000, 41000000))
        baseline = _phys_bbox_mm(fp)
        self.assertGreaterEqual(baseline[0], 12)
        self.assertGreaterEqual(baseline[1], 6)
        for rotation in (90, 180, 270):
            fp.SetOrientationDegrees(rotation)
            measured = _phys_bbox_mm(fp)
            self.assertAlmostEqual(measured[0], baseline[0], places=5)
            self.assertAlmostEqual(measured[1], baseline[1], places=5)

    def test_live_matches_frozen(self):
        import pcbnew

        board = pcbnew.LoadBoard(os.path.join(FIXTURE, "splanc_dev.kicad_pcb"))
        live = build_graph(board, name="splanc_dev")
        frozen = _frozen_graph()
        self.assertEqual(len(live.components), len(frozen.components))
        self.assertEqual(len(live.nets), len(frozen.nets))
        self.assertEqual(live.pad_count, frozen.pad_count)
        self.assertEqual(set(live.refs), set(frozen.refs))


if __name__ == "__main__":
    unittest.main()
