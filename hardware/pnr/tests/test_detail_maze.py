"""R4 tests — the multi-layer PathFinder maze router (pure, no pcbnew)."""

import unittest

from pnr.route.detail.grid import Cell, RouteGrid
from pnr.route.detail.maze import route


def _connected(rn, a, b):
    """True if cells ``a`` and ``b`` are in one connected component of the routed
    tree (edges = in-plane adjacency — orthogonal or 45° diagonal — or a via at the
    same i,j)."""
    cells = set(rn.cells)
    if a not in cells or b not in cells:
        return False
    seen = {a}
    stack = [a]
    steps = ((1, 0), (-1, 0), (0, 1), (0, -1), (1, 1), (1, -1), (-1, 1), (-1, -1))
    while stack:
        c = stack.pop()
        if c == b:
            return True
        for di, dj in steps:
            nb = Cell(c.layer, c.i + di, c.j + dj)
            if nb in cells and nb not in seen:
                seen.add(nb)
                stack.append(nb)
        for la in range(8):  # via: same i,j other layer
            nb = Cell(la, c.i, c.j)
            if la != c.layer and nb in cells and nb not in seen:
                seen.add(nb)
                stack.append(nb)
    return b in seen


def _no_shared_cells(res):
    """DRC invariant: no grid cell is occupied by two different nets."""
    used = {}
    for name, rn in res.nets.items():
        for c in rn.cells:
            if c in used and used[c] != name:
                return False
            used[c] = name
    return True


class TwoPinTest(unittest.TestCase):
    def test_same_layer_connects(self):
        g = RouteGrid(6, 6, 1.0)
        res = route(g, {"N": [Cell(0, 0, 0), Cell(0, 5, 5)]})
        self.assertTrue(res.fully_routed, res.summary())
        rn = res.nets["N"]
        self.assertTrue(_connected(rn, Cell(0, 0, 0), Cell(0, 5, 5)))
        self.assertEqual(rn.vias, [])  # same layer, no via needed

    def test_via_when_pins_on_different_layers(self):
        g = RouteGrid(6, 6, 1.0)
        res = route(g, {"N": [Cell(0, 2, 2), Cell(1, 2, 2)]})
        self.assertTrue(res.fully_routed)
        self.assertEqual(res.nets["N"].vias, [(2, 2)])  # one via at the shared column

    def test_routes_around_obstacle(self):
        g = RouteGrid(6, 3, 1.0)
        # Wall on both layers at column 3, gap only at row 0.
        g.blocked[:, :, 3] = True
        g.blocked[:, 0, 3] = False
        res = route(g, {"N": [Cell(0, 0, 1), Cell(0, 5, 1)]})
        self.assertTrue(res.fully_routed, res.summary())
        # the path must dip through the row-0 gap
        self.assertIn(Cell(0, 3, 0), set(res.nets["N"].cells))


class NegotiationTest(unittest.TestCase):
    def test_two_crossing_nets_negotiate(self):
        g = RouteGrid(5, 5, 1.0)
        acc = {
            "A": [Cell(0, 0, 2), Cell(0, 4, 2)],  # horizontal across the middle
            "B": [Cell(0, 2, 0), Cell(0, 2, 4)],  # vertical — would cross A at (2,2)
        }
        res = route(g, acc)
        self.assertTrue(res.fully_routed, res.summary())
        self.assertTrue(_no_shared_cells(res))  # DRC-clean: no cell shared
        # one of them had to via to the other layer to cross
        self.assertGreater(len(res.nets["A"].vias) + len(res.nets["B"].vias), 0)

    def test_deterministic(self):
        g = RouteGrid(5, 5, 1.0)
        acc = {"A": [Cell(0, 0, 2), Cell(0, 4, 2)], "B": [Cell(0, 2, 0), Cell(0, 2, 4)]}
        r1 = route(g, acc)
        r2 = route(g, acc)
        self.assertEqual(
            {n: rn.cells for n, rn in r1.nets.items()},
            {n: rn.cells for n, rn in r2.nets.items()},
        )

    def test_other_net_pad_blocks(self):
        # A pad of net B sits between A's two pins on layer 0; A must go around/via.
        from pnr.route.detail.grid import Rect

        g = RouteGrid(6, 3, 1.0)
        g.add_pad(0, "B", Rect(3.0, 1.5, 0.9, 2.9))  # blocks column 3, layer 0
        res = route(g, {"A": [Cell(0, 0, 1), Cell(0, 5, 1)]})
        self.assertTrue(res.fully_routed, res.summary())
        # A never uses a B-owned cell
        self.assertTrue(all(g.passable(c.layer, c.i, c.j, "A") for c in res.nets["A"].cells))


if __name__ == "__main__":
    unittest.main()
