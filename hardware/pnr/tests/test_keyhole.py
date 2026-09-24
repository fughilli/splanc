import unittest
from pnr.route.detail.keyhole import (
    route,
    relax,
    length,
    octilinear,
    align_parallel,
    acceptable,
)


class KeyholeTest(unittest.TestCase):
    def test_maze_and_relaxation_preserve_clearance(self):
        # Wall with one .4 mm channel, supplied in already inflated centerline space.
        def clear(a, b):
            for i in range(101):
                t = i / 100
                x = a[0] + t * (b[0] - a[0])
                y = a[1] + t * (b[1] - a[1])
                if 1.9 <= x <= 2.1 and not 2.3 < y < 2.7:
                    return False
            return True

        r = route([(0, 0)], [(4, 0)], (-0.5, -0.5, 4.5, 3), clear, pitch=0.1)
        self.assertEqual(r.status, "routed")
        self.assertEqual(r.path[0], (0, 0))
        self.assertEqual(r.path[-1], (4, 0))
        self.assertTrue(
            all(clear(a, b) and octilinear(a, b) for a, b in zip(r.path, r.path[1:]))
        )
        self.assertLessEqual(length(r.path), r.raw_length + 1e-8)

    def test_terminal_is_not_snapped_out_of_obstacle(self):
        def clear(a, b):
            return min(a[0], b[0]) > 0.05

        r = route([(0, 0)], [(2, 0)], (-1, -1, 3, 1), clear)
        self.assertEqual(r.status, "terminal_escape_blocked")

    def test_exact_axis_escape_from_off_grid_fine_pitch_pad(self):
        def clear(a, b):
            for i in range(201):
                t = i / 200
                x, y = a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])
                if y < 0.6 and not 0.04 <= x <= 0.06:
                    return False
                if 1 <= y <= 1.2 and x < 1:
                    return False
            return True

        result = route([(0.05, 0)], [(2, 2)], (0, 0, 3, 3), clear, pitch=0.1)
        self.assertEqual(result.status, "routed")
        self.assertEqual(result.path[0], (0.05, 0))
        self.assertTrue(all(clear(a, b) for a, b in zip(result.path, result.path[1:])))

    def test_all_island_anchors_are_used(self):
        def clear(a, b):
            return min(a[1], b[1]) > 1

        r = route([(0, 0), (0, 2)], [(2, 2)], (-1, -1, 3, 3), clear)
        self.assertEqual(r.status, "routed")
        self.assertEqual(r.path[0], (0, 2))

    def test_relax_keeps_endpoints_and_removes_kinks(self):
        path = [(0, 0), (1, 0), (1.5, 0.5), (2, 0.5), (2.5, 0), (4, 0)]
        self.assertEqual(relax(path, lambda a, b: True), [(0, 0), (4, 0)])

    def test_parallel_alignment_preserves_anchors(self):
        path = [(0, 1), (1, 0.5), (3, 0.5), (4, 1)]
        q = align_parallel(
            path,
            [((0, 0), (4, 0))],
            0.35,
            lambda a, b: min(a[1], b[1]) >= 0.35,
            length_slack=0.5,
        )
        self.assertEqual(q[0], path[0])
        self.assertEqual(q[-1], path[-1])
        self.assertTrue(
            any(
                abs(a[1] - 0.35) < 1e-8 and abs(b[1] - 0.35) < 1e-8
                for a, b in zip(q, q[1:])
            )
        )
        self.assertTrue(all(octilinear(a, b) for a, b in zip(q, q[1:])))

    def test_alignment_cannot_cross_obstacle(self):
        path = [(0, 1), (1, 0.5), (3, 0.5), (4, 1)]
        self.assertEqual(
            align_parallel(
                path, [((0, 0), (4, 0))], 0.35, lambda a, b: min(a[1], b[1]) >= 0.49
            ),
            path,
        )

    def test_trapped_target_does_not_exhaust_board_search(self):
        # A rectangular wall isolates the single target; starts span a trunk.
        def clear(a, b):
            return (max(abs(a[0] - 5), abs(a[1] - 5)) < 0.15) == (
                max(abs(b[0] - 5), abs(b[1] - 5)) < 0.15
            )

        r = route(
            [(0, y) for y in range(10)],
            [(5, 5)],
            (0, 0, 10, 10),
            clear,
            pitch=0.1,
            max_expansions=500,
        )
        self.assertEqual(r.status, "no_channel_at_pitch")
        self.assertLess(r.expanded, 100)

    def test_native_gate_rejects_new_short_despite_fewer_opens(self):
        before = {"unconnected_items": [{}, {}], "violations": []}
        after = {
            "unconnected_items": [{}],
            "violations": [{"type": "shorting_items", "items": [{"uuid": "new"}]}],
        }
        self.assertFalse(acceptable(before, after))
        after["violations"] = []
        self.assertTrue(acceptable(before, after))
        self.assertFalse(acceptable(after, after))

    def test_native_gate_detects_replacement_violation(self):
        before = {
            "unconnected_items": [{}, {}],
            "violations": [{"type": "clearance", "items": [{"uuid": "old"}]}],
        }
        after = {
            "unconnected_items": [{}],
            "violations": [{"type": "clearance", "items": [{"uuid": "new"}]}],
        }
        self.assertFalse(acceptable(before, after))

    def test_budget_is_distinct_from_geometric_failure(self):
        def clear(a, b):
            return not (a[0] < 1 < b[0] or b[0] < 1 < a[0])

        r = route([(0, 0)], [(2, 0)], (-1, -1, 3, 1), clear, max_expansions=1)
        self.assertEqual(r.status, "search_budget")


class BoundsTest(unittest.TestCase):
 def test_direct_fast_path_obeys_regional_bounds(self):
  self.assertNotEqual(route([(5,5)],[(6,5)],(0,0,1,1),lambda a,b:True).status,'routed')
 def test_outside_island_anchor_cannot_win_shortcut(self):
  r=route([(0,0),(1.01,.5)],[(1,.5)],(0,0,1,1),lambda a,b:True)
  self.assertEqual(r.status,'routed');self.assertEqual(r.path[0],(0,0))
  self.assertTrue(all(0<=x<=1 and 0<=y<=1 for x,y in r.path))

if __name__ == "__main__":
    unittest.main()
