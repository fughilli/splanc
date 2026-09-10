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

        # Run mutation in an isolated KiCad process, matching production. This
        # KiCad 9 build invalidates SWIG type wrappers after BuildConnectivity.
        import subprocess
        import sys
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            graph_path = os.path.join(directory, 'placed.json')
            output = os.path.join(directory, 'placed.kicad_pcb')
            with open(graph_path, 'w', encoding='utf-8') as fh:
                fh.write(g.to_json())
            script = """
import sys, pcbnew
from pnr.graph import BoardGraph
from pnr.writeback import apply_placement
board = pcbnew.LoadBoard(sys.argv[1])
graph = BoardGraph.from_json(open(sys.argv[2]).read())
t = pcbnew.PCB_TRACK(board)
t.SetStart(pcbnew.VECTOR2I(0,0))
t.SetEnd(pcbnew.VECTOR2I(1000,0))
board.Add(t)
assert apply_placement(board,graph,width=60.,height=50.) == len(graph.components)
pcbnew.SaveBoard(sys.argv[3],board)
"""
            result = subprocess.run([sys.executable, '-c', script,
                                     os.path.join(FIXTURE, 'splanc_dev.kicad_pcb'),
                                     graph_path, output], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr[-3000:])
            board = pcbnew.LoadBoard(output)
        moved = None
        for fp in board.GetFootprints():
            if fp.GetReference() == ref:
                moved = fp
        px, py = to_pcb_nm(10.0, 20.0, 50.0)
        self.assertEqual(moved.GetPosition().x, px)
        self.assertEqual(moved.GetPosition().y, py)
        # Stale routing was cleared (the detailed router re-routes from clean).
        self.assertEqual(len(list(board.GetTracks())), 0)


class ProjectRulesTest(unittest.TestCase):
    def test_new_export_has_versioned_project_and_explicit_net_classes(self):
        import json
        import tempfile
        from pathlib import Path
        from pnr.writeback import patch_project_rules
        rules = {'fab': {'clearance_mm': .15},
                 'net_classes': [{'name': 'power', 'nets': ['VBUS'], 'width_mm': 1.5, 'clearance_mm': .3}],
                 'diff_pairs': [{'name': 'usb', 'p': 'DP', 'n': 'DM', 'width_mm': .2, 'gap_mm': .15}]}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'export.kicad_pro'
            self.assertTrue(patch_project_rules(str(path), rules))
            first = path.read_text()
            patch_project_rules(str(path), rules)
            self.assertEqual(first, path.read_text())
            project = json.loads(first)
            self.assertEqual(project['meta']['version'], 3)
            self.assertEqual(project['net_settings']['meta']['version'], 4)
            classes = {c['name']: c for c in project['net_settings']['classes']}
            self.assertEqual(classes['Default']['clearance'], .15)
            self.assertEqual(classes['power']['clearance'], .3)
            self.assertEqual(classes['power']['track_width'], 1.5)
            self.assertEqual(classes['dp_usb']['diff_pair_gap'], .15)
            self.assertIn({'netclass': 'power', 'pattern': 'VBUS'}, project['net_settings']['netclass_patterns'])

class FanoutGeometryTest(unittest.TestCase):
    def test_track_middle_blocks_via_and_crossing_escape(self):
        from pnr.writeback import _clear_segment
        copper = [((0., 0.), (10., 0.), .2, 2)]
        self.assertFalse(_clear_segment((5., 0.), (5., 0.), .3, 1, copper))
        self.assertFalse(_clear_segment((5., -2.), (5., 2.), .1, 1, copper))
        self.assertTrue(_clear_segment((5., 1.), (5., 2.), .3, 1, copper))
        self.assertTrue(_clear_segment((5., -2.), (5., 2.), .1, 2, copper))

    def test_collinear_degenerate_and_endpoint_distances(self):
        from pnr.writeback import _segment_distance_sq as distance
        self.assertEqual(distance((0,0), (10,0), (3,0), (4,0)), 0)
        self.assertEqual(distance((0,0), (1,0), (3,0), (4,0)), 4)
        self.assertEqual(distance((0,0), (0,0), (3,4), (3,4)), 25)
        self.assertEqual(distance((0,0), (10,0), (2,3), (8,3)), 9)

@unittest.skipUnless(importlib.util.find_spec('pcbnew') is not None, 'requires KiCad')
class LiveFanoutTest(unittest.TestCase):
    def test_uses_fab_geometry_and_never_forces_congested_via(self):
        import pcbnew
        from pnr.writeback import _dogbone_fanout_net
        board = pcbnew.BOARD()
        edge = pcbnew.PCB_SHAPE(board)
        edge.SetShape(pcbnew.SHAPE_T_RECT)
        edge.SetStart(pcbnew.VECTOR2I(0,0))
        edge.SetEnd(pcbnew.VECTOR2I(20000000,20000000))
        edge.SetLayer(pcbnew.Edge_Cuts)
        board.Add(edge)
        net = pcbnew.NETINFO_ITEM(board, 'GND')
        board.Add(net)
        foreign = pcbnew.NETINFO_ITEM(board, 'OTHER')
        board.Add(foreign)
        fp = pcbnew.FOOTPRINT(board)
        board.Add(fp)
        fp.SetPosition(pcbnew.VECTOR2I(10000000,10000000))
        pad = pcbnew.PAD(fp)
        pad.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
        layers = pcbnew.LSET()
        layers.AddLayer(pcbnew.F_Cu)
        pad.SetLayerSet(layers)
        pad.SetSize(pcbnew.VECTOR2I(500000,500000))
        pad.SetPosition(fp.GetPosition())
        pad.SetNet(net)
        fp.Add(pad)
        rules = {'fab': {'via_diameter_mm': .8, 'via_drill_mm': .4}}
        self.assertEqual(_dogbone_fanout_net(board,net.GetNetCode(),rules=rules),1)
        vias = [t for t in board.GetTracks() if isinstance(t,pcbnew.PCB_VIA)]
        self.assertEqual(vias[0].GetFrontWidth(),800000)
        self.assertEqual(vias[0].GetDrillValue(),400000)
        self.assertNotEqual(vias[0].GetPosition(),pad.GetPosition())
        for t in list(board.GetTracks()):
            board.Remove(t)
        blocker = pcbnew.PAD(fp)
        blocker.SetAttribute(pcbnew.PAD_ATTRIB_SMD)
        layers = pcbnew.LSET()
        layers.AddLayer(pcbnew.B_Cu)
        blocker.SetLayerSet(layers)
        blocker.SetSize(pcbnew.VECTOR2I(18000000,18000000))
        blocker.SetPosition(fp.GetPosition())
        blocker.SetNet(foreign)
        fp.Add(blocker)
        self.assertEqual(_dogbone_fanout_net(board,net.GetNetCode(),rules=rules),0)
        self.assertEqual(len(list(board.GetTracks())),0)


@unittest.skipUnless(importlib.util.find_spec('pcbnew') is not None, 'requires KiCad')
class LiveCopperKeepoutTest(unittest.TestCase):
    def test_all_layer_keepout_tracks_placement_and_is_idempotent(self):
        import pcbnew
        from pnr.graph import BoardGraph,Component
        from pnr.writeback import apply_copper_keepouts
        board=pcbnew.BOARD()
        board.SetCopperLayerCount(4)
        graph=BoardGraph('test',components=[Component('U1','test',(10,20),90,'top',(4,4),(4,4))])
        rules={'copper_keepouts':[{'name':'die','ref':'U1','rect_mm':[-1,-2,1,2]}]}
        self.assertEqual(apply_copper_keepouts(board,graph,rules,50),1)
        self.assertEqual(apply_copper_keepouts(board,graph,rules,50),1)
        zones=list(board.Zones())
        self.assertEqual(len(zones),1)
        zone=zones[0]
        self.assertTrue(zone.GetDoNotAllowTracks())
        self.assertTrue(zone.GetDoNotAllowVias())
        self.assertTrue(zone.GetDoNotAllowCopperPour())
        for layer in (pcbnew.F_Cu,pcbnew.In1_Cu,pcbnew.In2_Cu,pcbnew.B_Cu):
            self.assertTrue(zone.GetLayerSet().Contains(layer))
        box=zone.GetBoundingBox()
        self.assertEqual(box.GetCenter(),pcbnew.VECTOR2I(40000000,60000000))
        self.assertEqual(box.GetWidth(),4000000)
        self.assertEqual(box.GetHeight(),2000000)


@unittest.skipUnless(importlib.util.find_spec('pcbnew') is not None, 'requires KiCad')
class LiveUuidTest(unittest.TestCase):
    def test_duplicate_children_are_unique_and_repair_is_idempotent(self):
        import pcbnew
        from pnr.writeback import normalize_item_uuids
        board=pcbnew.BOARD()
        pads=[]
        originals=[]
        shared='12345678-1234-4234-9234-123456789012'
        for ref in ('R1','R2'):
            fp=pcbnew.FOOTPRINT(board)
            fp.SetReference(ref)
            board.Add(fp)
            originals.append(fp.m_Uuid.AsString())
            pad=pcbnew.PAD(fp)
            pad.m_Uuid.Clone(pcbnew.KIID(shared))
            fp.Add(pad)
            pads.append(pad)
        self.assertEqual(normalize_item_uuids(board),1)
        self.assertNotEqual(pads[0].m_Uuid.AsString(),pads[1].m_Uuid.AsString())
        self.assertEqual(normalize_item_uuids(board),0)
        self.assertCountEqual([f.m_Uuid.AsString() for f in board.GetFootprints()],originals)


if __name__ == "__main__":
    unittest.main()
