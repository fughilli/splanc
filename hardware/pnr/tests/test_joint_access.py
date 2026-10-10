"""Joint access: scarce exits, geometry qualifications and honest budget reports."""
import copy
import unittest
from dataclasses import dataclass

from pnr.graph import BoardGraph, Component, Pad
from pnr.place.geometry import Rect
from pnr.route.detail.grid import Cell, RouteGrid
from pnr.route.detail.escape import plan_escapes
from pnr.route.detail.joint_access import select_joint
from pnr.route.detail.joint_escape import enumerate_access, options_conflict, _make_option


@dataclass(frozen=True)
class Option:
    cost: float
    resource: str


class JointSelectionTest(unittest.TestCase):
    def test_revises_cheaper_choice_to_preserve_another_terminals_only_exit(self):
        options = {"A": [Option(0, "left"), Option(2, "right")],
                   "B": [Option(1, "left")]}
        result = select_joint(options, lambda a, b: a.resource == b.resource)
        self.assertTrue(result.complete)
        self.assertEqual(result.selected, {"A": 1, "B": 0})

    def test_backtracks_when_equal_sized_domains_have_joint_conflict(self):
        options = {"A": [Option(0, "A0"), Option(1, "A1")],
                   "B": [Option(0, "B0"), Option(1, "B1")],
                   "C": [Option(0, "C0"), Option(1, "C1")]}
        clashes = {frozenset(p) for p in [("A0", "B1"), ("A0", "C1"), ("B0", "C0")]}
        result = select_joint(options, lambda a, b: frozenset((a.resource, b.resource)) in clashes)
        self.assertTrue(result.complete)
        self.assertEqual(result.selected["A"], 1)
        self.assertTrue(result.clusters[0]["optimal_in_candidate_set"])

    def test_budget_and_infeasibility_are_different(self):
        options = {"A": [Option(0, "x")], "B": [Option(0, "x")]}
        conflict = lambda a, b: a.resource == b.resource
        bounded = select_joint(options, conflict, max_states=0)
        exhausted = select_joint(options, conflict, max_states=100)
        self.assertEqual(set(bounded.unresolved.values()), {"search_budget"})
        self.assertEqual(set(exhausted.unresolved.values()), {"candidate_set_conflict"})
        self.assertEqual(len(exhausted.selected), 1)

    def test_distant_components_get_independent_budgets(self):
        options = {str(i): [Option(1, str(i))] for i in range(50)}
        result = select_joint(options, lambda a, b: False, max_cluster_size=2)
        self.assertTrue(result.complete)
        self.assertEqual(len(result.clusters), 50)

    def test_missing_options_and_oversized_components_are_explicit(self):
        options = {"A": [], "B": [Option(0, "x")], "C": [Option(0, "x")]}
        result = select_joint(options, lambda a, b: a.resource == b.resource, max_cluster_size=1)
        self.assertEqual(result.unresolved["A"], "no_generated_option")
        self.assertIn("cluster_size_limit", result.unresolved.values())

    def test_input_order_does_not_change_solution(self):
        options = {"B": [Option(0, "x")], "A": [Option(0, "x"), Option(1, "y")]}
        a = select_joint(options, lambda a, b: a.resource == b.resource).report()
        b = select_joint(dict(reversed(list(options.items()))), lambda a, b: a.resource == b.resource).report()
        self.assertEqual(a, b)


class JointGeometryTest(unittest.TestCase):
    def grid(self, layers=("F.Cu", "B.Cu")):
        return RouteGrid(10, 10, .25, layers=layers, track_width=.15, clearance=.13, via_radius=.225)

    def test_candidate_generation_never_mutates_the_grid(self):
        grid = self.grid()
        pad_net = dict(grid.pad_net)
        options = enumerate_access(grid, "A", (5.1, 5.1), 0, max_options=8)
        self.assertTrue(options)
        self.assertEqual(grid.pad_net, pad_net)
        self.assertEqual(grid.escape_segments, [])
        self.assertEqual(grid.escape_vias, [])
        self.assertLessEqual(len(options), 8)
        for option in options:
            self.assertEqual(option.escape.pad_xy, (5.1, 5.1))
            self.assertEqual(option.segments[0][1], (5.1, 5.1))

    def test_width_qualification_does_not_squeeze_power_through_signal_slot(self):
        grid = self.grid()
        # Vertical slit 0.50 mm wide. A 0.15 mm route fits with 0.13 clearance;
        # a 0.5 mm source-class route cannot fit, even at the pad-centre branch.
        grid.pad_rectangles.extend([(0, "WALL", Rect(4.525, 5.125, .7, 4)),
                                    (0, "WALL", Rect(5.725, 5.125, .7, 4))])
        narrow = enumerate_access(grid, "A", (5.125, 5.125), 0, allow_via_in_pad=False,
                                  max_options=8)
        grid.net_widths["A"] = .5
        wide = enumerate_access(grid, "A", (5.125, 5.125), 0, allow_via_in_pad=False,
                                allow_dogbone=False, max_options=8)
        self.assertTrue(narrow)
        self.assertFalse(wide)

    def test_crossing_choices_are_reassigned_jointly(self):
        grid = self.grid(("F.Cu",))
        make = lambda net, a, b, access: _make_option(grid, net, a, 0, Cell(0, *access),
                       ((0, a, b, .15),), (), "surface", 1)
        a_cross = make("A", (3, 4), (5, 4), (20, 16))
        a_clear = make("A", (3, 4), (2, 4), (8, 16))
        b_only = make("B", (4, 3), (4, 5), (16, 20))
        # Make the crossing escape locally cheaper so correctness requires a joint choice.
        a_cross.cost = 0; a_clear.cost = 2
        result = select_joint({"A": [a_cross, a_clear], "B": [b_only]},
                              lambda a, b: options_conflict(grid, a, b))
        self.assertEqual(result.selected, {"A": 1, "B": 0})

    def test_same_net_drill_spacing_is_still_a_conflict(self):
        grid = self.grid()
        a = _make_option(grid, "N", (5, 5), 0, Cell(1, 20, 20), (), ((5, 5),), "new", 1)
        b = _make_option(grid, "N", (5.2, 5), 0, Cell(1, 21, 20), (), ((5.2, 5),), "new", 1)
        self.assertTrue(options_conflict(grid, a, b))
        b.vias = a.vias
        self.assertFalse(options_conflict(grid, a, b))

    def test_through_pad_reuses_plating_without_new_via(self):
        grid = self.grid()
        options = enumerate_access(grid, "A", (5.1, 5.1), 0, through_hole=True)
        self.assertTrue(any(c.escape.access.layer == 1 for c in options))
        self.assertTrue(all(not c.vias for c in options))

    def test_existing_same_net_via_access_does_not_duplicate_drill(self):
        grid = self.grid()
        grid.escape_vias.append(("A", (5.5, 5.1)))
        options = enumerate_access(grid, "A", (5.1, 5.1), 0,
                                   allow_via_in_pad=False, max_options=16)
        reused = [c for c in options if c.escape.access.layer == 1 and not c.vias]
        self.assertTrue(reused)
        self.assertTrue(any(any(a == (5.5, 5.1) or b == (5.5, 5.1)
                               for _, a, b, _ in c.segments) for c in reused))

    def test_source_pth_and_slot_drills_block_new_same_net_vias(self):
        graph = BoardGraph("drills", [Component("J1", "", (5,5), 0, "top", (3,3), (3,3),
              pads=[Pad("1", "A", (0,0), (1.7,1.7), True, (.9,.9), True, .85),
                    Pad("2", "", (2,0), (1.5,.8), True, (1.5,.8), False)])])
        graph = BoardGraph.from_json(graph.to_json())
        self.assertEqual(graph.components[0].pads[0].drill_size, (.9,.9))
        self.assertFalse(graph.components[0].pads[1].plated)
        grid = RouteGrid.from_graph(graph, 10, 10, pitch=.25)
        grid.via_drill_radius = .15; grid.hole_clearance = .25
        for point in [(5,5), (5.125,5.125), (5.8,5), (7,5), (7.9,5)]:
            self.assertFalse(grid.hole_site_clear(point))
        self.assertTrue(grid.hole_site_clear((5,6)))

    def test_plated_transition_requires_same_net_and_source_land_width(self):
        graph = BoardGraph("pth", [Component("J1", "", (5,5), 0, "top", (3,3), (3,3),
                  pads=[Pad("1", "A", (0,0), (1.7,1.7), True, (.9,.9), True, .85)])])
        grid = RouteGrid.from_graph(graph, 10, 10, pitch=.25)
        self.assertEqual(grid.plated_transition("A", 20, 20), (5,5))
        self.assertIsNone(grid.plated_transition("OTHER", 20, 20))
        self.assertIsNone(grid.plated_transition("A", 23, 20))
        grid.net_widths["A"] = 1.5
        self.assertIsNone(grid.plated_transition("A", 20, 20))
        graph.components[0].pads[0].plated = False
        grid = RouteGrid.from_graph(graph, 10, 10, pitch=.25)
        self.assertIsNone(grid.plated_transition("A", 20, 20))

    def test_no_net_pad_uses_track_and_via_clearance_without_double_inflation(self):
        # SOT-23 pitch: 0.95 mm; adjacent pad height 0.6 mm. The INPUT centre
        # has 0.65 mm to NC copper, enough for this 0.25 mm centre branch.
        graph = BoardGraph("nc-neighbor", [Component("U1", "test", (5,5), 0, "top", (3,3), (3,3),
            pads=[Pad("1", "", (0,-.95), (1.4,.6)), Pad("2", "INPUT", (0,0), (1.4,.6))])])
        grid = RouteGrid.from_graph(graph, 10, 10, pitch=.25, clearance=.2, track_width=.25, via_radius=.3)
        self.assertTrue(any(owner == "" for _, owner, _ in grid.pad_rectangles))
        self.assertFalse(grid.passable(0, *grid.cell_of(5,4.05), "INPUT"))
        choices = enumerate_access(grid, "INPUT", (5,5), 0, allow_via_in_pad=False)
        self.assertTrue(choices)
        for choice in choices:
            for la, a, b, width in choice.segments:
                # Every selected path is still explicitly checked against NC copper.
                from pnr.route.detail.joint_escape import _segment_clear
                self.assertTrue(_segment_clear(grid, "INPUT", la, a, b, width))

    def test_unqualified_terminal_is_not_emitted_as_a_center_stub(self):
        grid = self.grid()
        grid.blocked[:] = True
        graph = BoardGraph("blocked", [Component("J1", "test", (5,5), 0, "top", (1,1), (1,1),
                              pads=[Pad("1", "A", (0,0), (.2,.2))])])
        plan = plan_escapes(grid, graph, {"A"}, via_keepout=1)
        self.assertEqual(plan.blocked_nets, {"A"})
        self.assertEqual(plan.escapes[0].kind, "blocked")
        self.assertEqual(grid.escape_segments, [])
        self.assertEqual(set(plan.diagnostics["unresolved"].values()), {"no_generated_option"})

    def test_reproduces_dense_four_terminal_legacy_failure(self):
        points = [("J1", "A", (5.7201163494459255, 5.495151813451739)),
                  ("J2", "B", (5.682091247140831, 4.751116206340525)),
                  ("J3", "C", (5.308875530643758, 4.730129607287397)),
                  ("J4", "D", (5.591736266697231, 5.1218426953204075))]
        graph = BoardGraph("dense-access", [Component(ref, "", xy, 0, "top", (.3,.3), (.3,.3),
                              pads=[Pad("1", net, (0,0), (.2,.2))]) for ref, net, xy in points])
        grid = RouteGrid.from_graph(graph, 12, 10, pitch=.35, clearance=.13, track_width=.15)
        old_grid = copy.deepcopy(grid)
        old = plan_escapes(old_grid, graph, set("ABCD"), via_keepout=1, joint=False)
        self.assertEqual(sum(not old_grid.passable(e.access.layer,e.access.i,e.access.j,e.net)
                             for e in old.escapes), 1)
        plan = plan_escapes(grid, graph, set("ABCD"), via_keepout=1)
        self.assertTrue(plan.diagnostics["complete"])
        self.assertEqual(len(plan.escapes), 4)
        for escape in plan.escapes:
            self.assertTrue(grid.passable(escape.access.layer,escape.access.i,escape.access.j,escape.net))

    def test_joint_commit_keeps_every_selected_access_passable(self):
        graph = BoardGraph("two", [Component(ref, "test", xy, 0, "top", (1,1), (1,1),
                              pads=[Pad("1", net, (0,0), (.2,.2))])
                              for ref, net, xy in [("J1", "A", (4.9,5)), ("J2", "B", (5.5,5))]])
        grid = RouteGrid.from_graph(graph, 10, 10, pitch=.35, clearance=.13, track_width=.15)
        plan = plan_escapes(grid, graph, {"A", "B"}, via_keepout=1)
        self.assertFalse(plan.blocked_nets)
        for escape in plan.escapes:
            self.assertTrue(grid.passable(escape.access.layer, escape.access.i, escape.access.j, escape.net))


if __name__ == "__main__":
    unittest.main()
