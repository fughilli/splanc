"""R2 tests — the routing grid + obstacle + pin-access model (pure, no pcbnew)."""

import os
import unittest

from pnr.graph import BoardGraph, BoardOutline, Component, Net, Pad
from pnr.route.detail.grid import RouteGrid

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "testdata", "splanc_dev")


def _pad(name, net, ox, oy, w=0.4, h=0.4):
    return Pad(name=name, net=net, offset=(ox, oy), size=(w, h))


class GridBasicsTest(unittest.TestCase):
    def test_dims_and_mapping(self):
        g = RouteGrid(10.0, 6.0, pitch=0.5)
        self.assertEqual((g.nx, g.ny), (20, 12))
        self.assertEqual(g.nlayers, 2)
        self.assertEqual(g.cell_of(0.0, 0.0), (0, 0))
        self.assertEqual(g.cell_of(9.99, 5.99), (19, 11))
        cx, cy = g.center_of(0, 0)
        self.assertAlmostEqual(cx, 0.25)
        self.assertAlmostEqual(cy, 0.25)

    def test_side_layer(self):
        g = RouteGrid(10, 10, 0.5)
        self.assertEqual(g.side_layer("top"), 0)
        self.assertEqual(g.side_layer("bottom"), 1)  # last index

    def test_pad_ownership_and_passability(self):
        g = RouteGrid(10, 10, 0.5)
        from pnr.route.detail.grid import Rect

        g.add_pad(0, "A", Rect(5.0, 5.0, 0.4, 0.4))
        i, j = g.cell_of(5.0, 5.0)
        # own net passes, other net does not
        self.assertTrue(g.passable(0, i, j, "A"))
        self.assertFalse(g.passable(0, i, j, "B"))
        # free cell passes for anyone
        self.assertTrue(g.passable(0, 0, 0, "B"))
        # other layer's cell is free (pad is on layer 0)
        self.assertTrue(g.passable(1, i, j, "B"))

    def test_overlapping_pad_halos_do_not_erase_foreign_clearance(self):
        from pnr.route.detail.grid import Rect
        for order in (("A", "B"), ("B", "A")):
            g = RouteGrid(10, 10, .1, clearance=.15, track_width=.2, via_radius=.3)
            pads = {"A": Rect(5, 5, .25, .8), "B": Rect(5.4, 5, .25, .8)}
            for net in order:
                g.add_pad(0, net, pads[net])
            i, j = g.cell_of(5.2, 5)
            for net in order:
                self.assertFalse(g.passable(0, i, j, net))
                self.assertFalse(g.via_passable(0, i, j, net))

    def test_block_region_never_routable(self):
        g = RouteGrid(10, 10, 0.5)
        from pnr.route.detail.grid import Rect

        g.block_region(Rect(2.0, 2.0, 1.0, 1.0))
        i, j = g.cell_of(2.0, 2.0)
        self.assertFalse(g.passable(0, i, j, "A"))
        self.assertFalse(g.passable(1, i, j, "A"))

    def test_out_of_bounds(self):
        g = RouteGrid(10, 10, 0.5)
        self.assertFalse(g.passable(0, -1, 0, "A"))
        self.assertFalse(g.passable(0, 999, 0, "A"))


class GridFromGraphTest(unittest.TestCase):
    def _two_pad_graph(self):
        a = Component(
            "U1", "fp", (2.0, 5.0), 0.0, "top", (1, 1), (1, 1), pads=[_pad("1", "N", 0, 0)]
        )
        b = Component(
            "U2", "fp", (8.0, 5.0), 0.0, "top", (1, 1), (1, 1), pads=[_pad("1", "N", 0, 0)]
        )
        return BoardGraph(
            "t", [a, b], [Net("N", 1, [("U1", "1"), ("U2", "1")])], BoardOutline(10, 10)
        )

    def test_access_points(self):
        g = RouteGrid.from_graph(self._two_pad_graph(), 10, 10, pitch=0.5)
        cells = g.net_access(self._two_pad_graph(), "N")
        self.assertEqual(len(cells), 2)
        self.assertEqual(cells[0].layer, 0)
        # the two pads map to different cells
        self.assertNotEqual((cells[0].i, cells[0].j), (cells[1].i, cells[1].j))

    def test_bottom_pad_on_last_layer(self):
        c = Component(
            "U1", "fp", (5, 5), 0.0, "bottom", (1, 1), (1, 1), pads=[_pad("1", "N", 0, 0)]
        )
        g = RouteGrid.from_graph(BoardGraph("t", [c], [], BoardOutline(10, 10)), 10, 10, pitch=0.5)
        i, j = g.cell_of(5, 5)
        self.assertEqual(g.pad_net.get((1, i, j)), "N")  # layer 1 = bottom
        self.assertIsNone(g.pad_net.get((0, i, j)))


class GridFixtureTest(unittest.TestCase):
    def test_builds_on_real_placed_board(self):
        # Use the frozen (ingested) graph — it now carries pad sizes.
        with open(os.path.join(FIXTURE, "graph.json"), encoding="utf-8") as fh:
            graph = BoardGraph.from_json(fh.read())
        w, h = graph.outline.width, graph.outline.height
        g = RouteGrid.from_graph(graph, w, h, pitch=0.25)
        # Every net's pads resolve to access cells.
        total = sum(len(g.net_access(graph, n.name)) for n in graph.nets)
        self.assertGreater(total, 300)  # ~338 pads
        # Pads are recorded as owned cells.
        self.assertGreater(len(g.pad_net), 300)


class SourceArrayReservationTest(unittest.TestCase):
    def test_future_current_bank_blocks_signals_on_every_crossed_layer(self):
        from pnr.graph import BoardGraph,BoardOutline,Component,Pad
        from pnr.route.detail.router import _mark_source_arrays
        from pnr.plane_intent import array_geometry
        from test_plane_access_intent import FAB
        pads=[Pad(str(i),'return',(1,y),(.7,.5)) for i,y in enumerate((-1,0,1),1)]
        comp=Component('RENAMED','power',(5,5),0,'top',(3,3),(3,3),pads=pads)
        graph=BoardGraph('test',[comp],[],BoardOutline(12,12))
        intent=dict(kind='power_array',ref=comp.ref,pads=['1','2','3'],net='return',surface='F.Cu',rms_current_a=5,peak_current_a=16,max_array_span_mm=3)
        rules=dict(plane_access_intents=[intent],plane_access_fab=FAB)
        grid=RouteGrid(12,12,.1,layers=('F.Cu','In1.Cu','In2.Cu','B.Cu'))
        _mark_source_arrays(grid,graph,rules)
        plan=array_geometry([((6,5+y),(.7,.5)) for y in (-1,0,1)],(5,5),intent,FAB)
        for point,diameter,drill in plan['vias']:
            i,j=grid.cell_of(*point)
            for layer in range(4):
                self.assertFalse(grid.passable(layer,i,j,'signal'))
                self.assertFalse(grid.via_passable(layer,i,j,'signal'))
        self.assertTrue(grid.passable(0,*grid.cell_of(2,2),'signal'))


if __name__ == "__main__":
    unittest.main()
