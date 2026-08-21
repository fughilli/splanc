"""Unit tests for the global router + Steiner decomposition (Phase 4).

These exercise the routing primitives directly (no torch, no placement loop), so
the congestion mechanics — capacity, overflow, PathFinder history, and the
inflation-derivation helper — are covered independently of the (slow) end-to-end
feedback test.
"""

import unittest

import numpy as np
from pnr.graph import BoardGraph, BoardOutline, Component, Net, Pad
from pnr.route.feedback import derive_inflation
from pnr.route.global_route import global_route
from pnr.route.steiner import rmst_edges


class SteinerTest(unittest.TestCase):
    def test_empty_and_single(self):
        self.assertEqual(rmst_edges([]), [])
        self.assertEqual(rmst_edges([(0.0, 0.0)]), [])

    def test_spanning_tree_shape(self):
        pts = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0), (2.0, 2.0)]
        edges = rmst_edges(pts)
        self.assertEqual(len(edges), len(pts) - 1)  # a tree over n pts has n-1 edges
        # Connects every node.
        seen = set()
        for a, b in edges:
            seen.add(a)
            seen.add(b)
        self.assertEqual(seen, set(range(len(pts))))

    def test_deterministic(self):
        pts = [(0.0, 0.0), (3.0, 1.0), (1.0, 4.0), (5.0, 5.0), (2.0, 2.0)]
        self.assertEqual(rmst_edges(pts), rmst_edges(list(pts)))

    def test_prefers_short_edges(self):
        # Colinear points: the MST is the chain of unit steps, not long jumps.
        pts = [(0.0, 0.0), (1.0, 0.0), (2.0, 0.0)]
        edges = set(rmst_edges(pts))
        self.assertIn((0, 1), edges)
        self.assertIn((1, 2), edges)
        self.assertNotIn((0, 2), edges)


def _two_pad_net(ref_a, ref_b, ax, bx, y=1.0, net="N"):
    """Two 1-pad components joined by one net, at (ax,y) and (bx,y)."""
    a = Component(
        ref_a, "fp", (ax, y), 0.0, "top", (0.4, 0.4), (0.4, 0.4), pads=[Pad("1", net, (0.0, 0.0))]
    )
    b = Component(
        ref_b, "fp", (bx, y), 0.0, "top", (0.4, 0.4), (0.4, 0.4), pads=[Pad("1", net, (0.0, 0.0))]
    )
    return a, b


class GlobalRouteTest(unittest.TestCase):
    def test_uncongested_board_zero_overflow(self):
        # A few well-separated nets on a roomy board route with no overflow.
        comps, nets = [], []
        for k in range(3):
            a, b = _two_pad_net(
                f"A{k}", f"B{k}", 1.0 + k * 3, 2.0 + k * 3, y=1.0 + k * 3, net=f"N{k}"
            )
            comps += [a, b]
            nets.append(Net(f"N{k}", k + 1, [(a.ref, "1"), (b.ref, "1")]))
        g = BoardGraph("t", comps, nets, BoardOutline(20, 20))
        res = global_route(g, 20, 20, gcell_mm=2.0, layers=2)
        self.assertTrue(res.converged)
        self.assertEqual(res.overflow, 0.0)

    def test_capacity_one_forces_overflow(self):
        # Many nets crossing the SAME narrow channel with capacity 1 must overflow.
        comps, nets = [], []
        for k in range(6):
            a, b = _two_pad_net(f"A{k}", f"B{k}", 0.5, 9.5, y=0.5 + k * 0.1, net=f"N{k}")
            comps += [a, b]
            nets.append(Net(f"N{k}", k + 1, [(a.ref, "1"), (b.ref, "1")]))
        g = BoardGraph("t", comps, nets, BoardOutline(10, 2))
        # track_pitch == gcell so capacity == 1 track per layer; 6 nets share it.
        res = global_route(g, 10, 2, gcell_mm=1.0, layers=1, track_pitch_mm=1.0, max_passes=4)
        self.assertGreater(res.overflow, 0.0)
        self.assertFalse(res.converged)
        # History must have accumulated on the congested edges (PathFinder).
        self.assertGreater(float(res.cell_history.max()), 0.0)

    def test_deterministic(self):
        comps, nets = [], []
        for k in range(4):
            a, b = _two_pad_net(f"A{k}", f"B{k}", 1.0, 8.0, y=1.0 + k, net=f"N{k}")
            comps += [a, b]
            nets.append(Net(f"N{k}", k + 1, [(a.ref, "1"), (b.ref, "1")]))
        g = BoardGraph("t", comps, nets, BoardOutline(10, 6))
        r1 = global_route(g, 10, 6, gcell_mm=1.5, layers=2)
        r2 = global_route(g, 10, 6, gcell_mm=1.5, layers=2)
        self.assertEqual(r1.overflow, r2.overflow)
        self.assertTrue(np.array_equal(r1.cell_overflow, r2.cell_overflow))


class InflationTest(unittest.TestCase):
    def test_congested_movable_parts_inflated(self):
        c = Component("U1", "fp", (2.0, 2.0), 0.0, "top", (1, 1), (1, 1))
        fixed_c = Component("J1", "fp", (8.0, 8.0), 0.0, "top", (1, 1), (1, 1))
        g = BoardGraph("t", [c, fixed_c], [], BoardOutline(10, 10))
        accum = np.zeros((5, 5))
        accum[1, 1] = 4.0  # gcell holding U1 (pos 2,2 @ 2mm gcell -> cell (1,1))
        infl = derive_inflation(g, accum, 2.0, fixed={"J1": (8.0, 8.0)})
        self.assertIn("U1", infl)
        self.assertGreater(infl["U1"], 1.0)
        self.assertNotIn("J1", infl)  # fixed parts never inflated

    def test_no_congestion_no_inflation(self):
        c = Component("U1", "fp", (2.0, 2.0), 0.0, "top", (1, 1), (1, 1))
        g = BoardGraph("t", [c], [], BoardOutline(10, 10))
        self.assertEqual(derive_inflation(g, np.zeros((5, 5)), 2.0, fixed={}), {})


if __name__ == "__main__":
    unittest.main()
