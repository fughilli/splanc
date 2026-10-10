import unittest
from pnr.route.detail.regional import preserves_connections
from pnr.route.detail.regional import (
    Request,
    solve_region,
    segment_distance,
    needs_connection,
)


class RegionalTest(unittest.TestCase):
    def test_unchanged_islands_do_not_need_redundant_repairs(self):
        r = Request("restore", "signal", [(1, 1)], [(1.05, 1)])
        components = {
            ("signal", (1, 1)): {"via", "track"},
            ("signal", (1.05, 1)): {"via", "track"},
        }
        self.assertFalse(needs_connection(r, components))
        components["signal", (1.05, 1)] = {"separate-island"}
        self.assertTrue(needs_connection(r, components))
        self.assertTrue(needs_connection(r, {}))
        self.assertTrue(
            needs_connection(
                Request("other", "other-net", r.sources, r.targets), components
            )
        )

    def test_conflict_order_repairs_both_nets(self):
        requests = [
            Request("a", "a", [(0, 0)], [(4, 0)]),
            Request("b", "b", [(2, -0.3)], [(2, 2)]),
        ]

        def clear(r, a, b):
            return r.net != "b" or all(1.5 <= p[0] <= 2.5 for p in (a, b))

        failed = solve_region(
            requests,
            (-1, -1, 5, 3),
            clear,
            max_orders=1,
            max_expansions=3000,
            reserve_terminals=False,
        )
        self.assertFalse(failed.paths)  # no partial transaction leaks
        result = solve_region(
            requests,
            (-1, -1, 5, 3),
            clear,
            max_orders=4,
            max_expansions=3000,
            reserve_terminals=False,
        )
        self.assertEqual(result.status, "routed")
        self.assertGreater(len(result.attempts), 1)
        for r in requests:
            self.assertEqual(result.paths[r.name][0], r.sources[0])
            self.assertEqual(result.paths[r.name][-1], r.targets[0])
        for a, b in zip(result.paths["a"], result.paths["a"][1:]):
            for c, d in zip(result.paths["b"], result.paths["b"][1:]):
                self.assertGreaterEqual(segment_distance(a, b, c, d), 0.351 - 1e-8)

    def test_actual_widths_and_clearance(self):
        r = [
            Request("a", "a", [(0, 0)], [(2, 0)], width=0.5),
            Request("b", "b", [(0, 0.5)], [(2, 0.5)], width=0.5),
        ]
        result = solve_region(r, (0, 0, 2, 0.5), lambda *a: True, max_expansions=100)
        self.assertNotEqual(result.status, "routed")
        self.assertFalse(result.paths)

    def test_same_net_branch_can_join(self):
        r = [
            Request("a", "n", [(0, 0)], [(2, 0)]),
            Request("b", "n", [(1, 0)], [(1, 1)]),
        ]
        self.assertEqual(
            solve_region(r, (0, 0, 2, 1), lambda *a: True).status, "routed"
        )

    def test_connectivity_gate_catches_tradeoff_between_nets(self):
        self.assertFalse(
            preserves_connections(
                [["a", "b"], ["c"], ["d"]], [["a"], ["b"], ["c", "d"]]
            )
        )
        self.assertTrue(preserves_connections([["a", "b"], ["c"]], [["a", "b", "c"]]))

    def test_pending_terminal_is_reserved_before_its_route(self):
        r = [
            Request("a", "a", [(0, 0)], [(4, 0)]),
            Request("b", "b", [(2, 0.3)], [(2, 2)]),
        ]
        result = solve_region(r, (-1, -1, 5, 3), lambda *a: True, max_orders=1)
        self.assertEqual(result.status, "routed")
        self.assertTrue(
            all(
                segment_distance(a, b, (2, 0.3), (2, 0.3)) >= 0.351 - 1e-8
                for a, b in zip(result.paths["a"], result.paths["a"][1:])
            )
        )

    def test_distance_crossing_collinear_and_points(self):
        self.assertEqual(segment_distance((0, 0), (2, 2), (0, 2), (2, 0)), 0)
        self.assertEqual(segment_distance((0, 0), (2, 0), (1, 0), (3, 0)), 0)
        self.assertEqual(segment_distance((0, 0), (0, 0), (1, 0), (2, 0)), 1)


if __name__ == "__main__":
    unittest.main()
