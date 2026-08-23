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


if __name__ == "__main__":
    unittest.main()
