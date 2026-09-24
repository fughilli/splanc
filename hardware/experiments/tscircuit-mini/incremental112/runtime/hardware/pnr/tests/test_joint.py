import math
import time
import unittest
from unittest.mock import patch
from pnr.route.detail.joint import solve_joint_region, conflicts, conflict
from pnr.route.detail.layered import route_layers, solve_layered_region
from pnr.route.detail.regional import Request


class JointTest(unittest.TestCase):
    def test_conflicting_independent_routes_are_negotiated(self):
        requests = [
            Request("a", "a", [(0, 0)], [(4, 0)]),
            Request("b", "b", [(2, -1)], [(2, 1)]),
        ]
        result = solve_joint_region(
            requests,
            (-1, -2, 5, 2),
            lambda *a: True,
            lambda *a: True,
            pitch=0.2,
            max_orders=16,
            max_expansions=2000,
        )
        self.assertEqual(result.status, "routed")
        self.assertFalse(conflicts(requests, result.paths))
        self.assertTrue(any(a["stage"] == "replan" for a in result.attempts))
        for r in requests:
            self.assertEqual(result.paths[r.name][0][:2], r.sources[0])
            self.assertEqual(result.paths[r.name][-1][:2], r.targets[0])

    def test_unresolvable_conflicts_never_return_partial_paths(self):
        requests = [
            Request("a", "a", [(0, 0)], [(4, 0)]),
            Request("b", "b", [(2, -1)], [(2, 1)]),
        ]
        result = solve_joint_region(
            requests,
            (-1, -2, 5, 2),
            lambda r, la, a, b: la == 0
            and all(abs(p[1] if r.net == "a" else p[0] - 2) < 0.01 for p in (a, b)),
            lambda *a: False,
            pitch=0.2,
            max_expansions=200,
        )
        self.assertNotEqual(result.status, "routed")
        self.assertFalse(result.paths)

    def test_holes_and_layer_conflicts(self):
        a = Request("a", "a", [], [])
        b = Request("b", "b", [], [])
        via = ("via", None, (1, 1), (1, 1))
        track = ("track", 2, (0, 1), (2, 1))
        self.assertTrue(conflict(a, via, b, track))
        self.assertFalse(conflict(a, ("track", 0, (0, 1), (2, 1)), b, track))
        self.assertTrue(conflict(a, via, a, ("via", None, (1.4, 1), (1.4, 1))))
        self.assertFalse(conflict(a, via, a, via))

    def test_deadline_returns_no_path_before_geometry(self):
        def forbidden(*args):
            self.fail("expired search must not query geometry")

        r = route_layers(
            [(0, 0)],
            [(2, 0)],
            (-1, -1, 3, 1),
            forbidden,
            forbidden,
            deadline=time.monotonic() - 1,
        )
        self.assertEqual(r.status, "time_budget")
        self.assertFalse(r.path)

    def test_time_limit_during_search_discards_transaction(self):
        ticks = iter(range(100000))
        r = Request("a", "a", [(0, 0)], [(4, 0)])
        with patch(
            "pnr.route.detail.layered.time.monotonic", side_effect=lambda: next(ticks)
        ):
            result = solve_layered_region(
                [r], (-1, -1, 5, 1), lambda *a: True, lambda *a: True, max_seconds=3
            )
        self.assertEqual(result.status, "time_budget")
        self.assertFalse(result.paths)


if __name__ == "__main__":
    unittest.main()
