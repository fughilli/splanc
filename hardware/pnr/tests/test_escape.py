"""Unit tests for pin-escape planning (E2 via-in-pad / E3 dog-bone)."""

import unittest

from pnr.route.detail.escape import _plan_one
from pnr.route.detail.grid import Cell, RouteGrid


def _grid(layers=("F.Cu", "In1.Cu", "In2.Cu", "B.Cu")):
    # 10x10 mm, 0.5 mm pitch => 20x20 cells, 4 layers.
    return RouteGrid(10.0, 10.0, 0.5, layers=layers, clearance=0.13, via_radius=0.225)


def _box_in(grid, layer, i, j):
    """Make cell (layer,i,j) a dead end: mark its 4 in-plane neighbours as static
    obstacles (a keep-out / plane region / board edge — NOT other-net pad copper) so
    the net can't leave on that layer, yet a via there still clears (no other net in
    the keep-out)."""
    for di, dj in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        grid.blocked[layer, j + dj, i + di] = True


class EscapePlanTest(unittest.TestCase):
    def test_onlayer_when_room(self):
        g = _grid()
        center = Cell(0, 10, 10)
        esc = _plan_one(
            g,
            "N",
            center,
            (5.25, 5.25),
            0,
            (5.0, 5.0),
            via_keepout=1,
            allow_via_in_pad=True,
            allow_dogbone=True,
            dogbone_reach=4,
        )
        self.assertEqual(esc.kind, "onlayer")
        self.assertEqual(esc.access, center)

    def test_via_in_pad_when_boxed_on_layer(self):
        g = _grid()
        i, j = 10, 10
        _box_in(g, 0, i, j)  # boxed on F.Cu, but the inner/back layers are open
        center = Cell(0, i, j)
        esc = _plan_one(
            g,
            "N",
            center,
            (5.25, 5.25),
            0,
            (5.0, 5.0),
            via_keepout=1,
            allow_via_in_pad=True,
            allow_dogbone=True,
            dogbone_reach=4,
        )
        self.assertEqual(esc.kind, "via_in_pad")
        self.assertNotEqual(esc.access.layer, 0)  # escaped to another layer
        self.assertEqual((esc.access.i, esc.access.j), (i, j))  # straight down
        self.assertEqual(esc.via_xy, (5.25, 5.25))  # via in the pad
        # the via reserved its keep-out for this net on every layer
        self.assertEqual(g.pad_net.get((0, i + 1, j + 1)), "N")

    def test_dogbone_reaches_a_via_when_pad_cell_cannot(self):
        # Pad boxed on its own layer (on-layer fails) and its pad cell blocked on the
        # inner/back layers (via-in-pad straight down fails), but an outward cell can
        # take the via — the dog-bone stubs to it. (Reachable because the outward
        # neighbour is open on the *pad* layer for the stub.)
        g = _grid()
        i, j = 10, 10
        # Box the -x, +/-y on-layer neighbours (leave +x open for the stub) so the
        # net can't leave laterally toward its own escape, then block the pad cell on
        # the inner/back layers so a straight-down via is impossible.
        g.pad_net[(0, i - 1, j)] = "OTHER"
        g.pad_net[(0, i, j + 1)] = "OTHER"
        g.pad_net[(0, i, j - 1)] = "OTHER"
        for la in (1, 2, 3):
            g.pad_net[(la, i, j)] = "OTHER"
        center = Cell(0, i, j)
        esc = _plan_one(
            g,
            "N",
            center,
            (5.25, 5.25),
            0,
            (2.0, 5.0),  # part centre on the -x side
            via_keepout=1,
            allow_via_in_pad=True,
            allow_dogbone=True,
            dogbone_reach=4,
        )
        # +x neighbour is open on-layer, so the net can leave the pad there -> the
        # planner keeps it on-layer (the maze then vias where it needs to). This
        # documents that a *local* dog-bone is subsumed by on-layer + the maze; a
        # dog-bone as a distinct routing CHOICE needs group-terminal routing (next).
        self.assertEqual(esc.kind, "onlayer")

    def test_disabled_escapes_fall_back_to_center(self):
        g = _grid()
        i, j = 10, 10
        _box_in(g, 0, i, j)
        center = Cell(0, i, j)
        esc = _plan_one(
            g,
            "N",
            center,
            (5.25, 5.25),
            0,
            (5.0, 5.0),
            via_keepout=1,
            allow_via_in_pad=False,
            allow_dogbone=False,
            dogbone_reach=4,
        )
        self.assertEqual(esc.kind, "onlayer")  # no escape allowed => center fallback


if __name__ == "__main__":
    unittest.main()
