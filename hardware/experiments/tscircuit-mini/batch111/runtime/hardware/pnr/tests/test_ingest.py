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
import importlib.util
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


@unittest.skipUnless(importlib.util.find_spec('pcbnew'), 'requires native KiCad')
class BodyAttributeTest(unittest.TestCase):
    def test_native_smd_attribute_is_preserved(self):
        import pcbnew
        from pnr.ingest import _component, _Frame
        # Reuse a native board frame; the attribute must not be inferred from pads.
        b=pcbnew.LoadBoard(os.path.join(FIXTURE,'splanc_dev.kicad_pcb'))
        from pnr.ingest import _board_frame
        frame,_=_board_frame(b)
        fp=next(iter(b.GetFootprints()))
        fp.SetAttributes(pcbnew.FP_SMD)
        self.assertTrue(_component(fp,frame).smd_body)
        fp.SetAttributes(pcbnew.FP_THROUGH_HOLE)
        self.assertFalse(_component(fp,frame).smd_body)

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

    def test_outline_frame_excludes_drawing_stroke(self):
        import pcbnew
        from pnr.ingest import _board_frame
        board = pcbnew.BOARD()
        points = [(30,30), (100,30), (100,85), (30,85)]
        for start, end in zip(points, points[1:]+points[:1]):
            edge = pcbnew.PCB_SHAPE(board)
            edge.SetShape(pcbnew.SHAPE_T_SEGMENT)
            edge.SetLayer(pcbnew.Edge_Cuts)
            edge.SetStart(pcbnew.VECTOR2I(*(int(x*1e6) for x in start)))
            edge.SetEnd(pcbnew.VECTOR2I(*(int(x*1e6) for x in end)))
            edge.SetWidth(150000)
            board.Add(edge)
        frame, outline = _board_frame(board)
        self.assertEqual((outline.width, outline.height), (70,55))
        self.assertEqual(frame.point(34000000,81000000), (4,4))

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

    def test_asymmetric_custom_pad_envelope_contains_offset_copper(self):
        import pcbnew as k
        from pnr.ingest import _component,_Frame
        board=k.BOARD();fp=k.FOOTPRINT(board);board.Add(fp)
        fp.SetPosition(k.VECTOR2I(30000000,40000000))
        pad=k.PAD(fp);pad.SetShape(k.PAD_SHAPE_CUSTOM)
        pad.SetSize(k.VECTOR2I(10000,10000));fp.Add(pad)
        pad.SetPosition(fp.GetPosition())
        polygon=k.SHAPE_POLY_SET();polygon.NewOutline()
        for x,y in [(300000,-500000),(700000,-500000),(700000,500000),(300000,500000)]:
            polygon.Append(k.VECTOR2I(x,y))
        pad.AddPrimitivePoly(k.F_Cu,polygon,0,True)
        for rotation in (0,90,180,270):
            fp.SetOrientationDegrees(rotation)
            graph=_component(fp,_Frame(0,0))
            self.assertGreaterEqual(graph.pads[0].size[0],1.4)
            self.assertGreaterEqual(graph.pads[0].size[1],1.0)

    def test_individual_pad_rotation_survives_footprint_rotation(self):
        import pcbnew as k
        from pnr.ingest import _component,_Frame
        board=k.BOARD();fp=k.FOOTPRINT(board);board.Add(fp)
        fp.SetPosition(k.VECTOR2I(30000000,40000000))
        for name, angle in [('1',0),('2',90)]:
            pad=k.PAD(fp);pad.SetNumber(name);pad.SetShape(k.PAD_SHAPE_RECT)
            pad.SetAttribute(k.PAD_ATTRIB_SMD);pad.SetDrillSize(k.VECTOR2I(0,0))
            pad.SetSize(k.VECTOR2I(200000,800000));fp.Add(pad)
            pad.SetPosition(fp.GetPosition());pad.SetOrientationDegrees(angle)
        for rotation in (0,90,180,270):
            fp.SetOrientationDegrees(rotation)
            graph=_component(fp,_Frame(0,0))
            modeled={p.name:p.size for p in graph.pads}
            for pad in fp.Pads():
                box=pad.GetBoundingBox();w,h=modeled[pad.GetNumber()]
                if rotation % 180 == 90:w,h=h,w
                self.assertAlmostEqual(w,box.GetWidth()/1e6,places=5)
                self.assertAlmostEqual(h,box.GetHeight()/1e6,places=5)

    def test_placement_envelope_covers_silk_beyond_declared_courtyard(self):
        import pcbnew as k
        from pnr.ingest import _component,_Frame
        board=k.BOARD();fp=k.FOOTPRINT(board);board.Add(fp)
        fp.SetPosition(k.VECTOR2I(30000000,40000000))
        for layer,offset in [(k.F_CrtYd,500000),(k.F_SilkS,1500000),(k.F_Fab,10000000)]:
            shape=k.PCB_SHAPE(fp);shape.SetShape(k.SHAPE_T_RECT);shape.SetLayer(layer)
            shape.SetStart(k.VECTOR2I(30000000-offset,40000000-offset))
            shape.SetEnd(k.VECTOR2I(30000000+offset,40000000+offset))
            shape.SetWidth(100000);fp.Add(shape)
        for angle in (0,90,180,270):
            fp.SetOrientationDegrees(angle);g=_component(fp,_Frame(0,0))
            self.assertGreaterEqual(min(g.courtyard),3.1)
            self.assertLess(max(g.courtyard),4.)

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
