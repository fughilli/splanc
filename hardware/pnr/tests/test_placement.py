"""Phase 2 acceptance — placement MVP on the splanc_dev fixture (design §9.2).

Asserts the placer reflows the atopile row into a legal, compact layout:
**0 courtyard overlaps, 0 hard-constraint violations, all parts inside the
outline, and HPWL <= the ato-row baseline** — deterministically under a fixed
seed.
"""

import os
import unittest

import yaml
from pnr.constraints import compile_constraints
from pnr.graph import BoardGraph
from pnr.place import place
from pnr.place.geometry import courtyard_rect, outline_size

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "testdata", "splanc_dev")


def _load():
    with open(os.path.join(FIXTURE, "graph.json"), encoding="utf-8") as fh:
        graph = BoardGraph.from_json(fh.read())
    with open(os.path.join(FIXTURE, "constraints.yaml"), encoding="utf-8") as fh:
        constraints = compile_constraints(yaml.safe_load(fh), graph.refs)
    return graph, constraints


class PlacementAcceptanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph, cls.constraints = _load()
        # Phase 2 semantics: position-only (orientation is the Phase 3 test).
        cls.placed, cls.report = place(cls.graph, cls.constraints, seed=0, iters=600, orient=False)

    def test_no_courtyard_overlaps(self):
        self.assertEqual(self.report.overlaps, [], self.report.summary())

    def test_no_hard_constraint_violations(self):
        self.assertEqual(self.report.fixed_misplaced, [])
        self.assertEqual(self.report.keepout, [])
        self.assertTrue(self.report.legal, self.report.summary())

    def test_all_parts_inside_outline(self):
        self.assertEqual(self.report.outside_outline, [])
        w, h = outline_size(self.graph, self.constraints)
        for c in self.placed.components:
            self.assertTrue(courtyard_rect(c).inside(w, h), f"{c.ref} outside {w}x{h}")

    def test_hpwl_beats_ato_row_baseline(self):
        # The design's regression gate: never worse than the incoming row.
        self.assertLessEqual(self.report.hpwl_placed, self.report.hpwl_baseline)
        # And it should be dramatically better (row spans the whole strip).
        self.assertGreater(self.report.hpwl_improvement, 0.5, self.report.summary())

    def test_fixed_parts_at_resolved_pose(self):
        # USB1 fixed at the south edge, U5 at the north edge.
        w, h = outline_size(self.graph, self.constraints)
        usb = self.placed.component("USB1")
        u5 = self.placed.component("U5")
        self.assertAlmostEqual(usb.pos[1], courtyard_rect(usb).h / 2, places=2)
        self.assertAlmostEqual(u5.pos[1], h - courtyard_rect(u5).h / 2, places=2)

    def test_deterministic(self):
        placed2, report2 = place(self.graph, self.constraints, seed=0, iters=600, orient=False)
        self.assertEqual(placed2.to_json(), self.placed.to_json())
        self.assertEqual(report2.hpwl_placed, self.report.hpwl_placed)


class HardGroupTest(unittest.TestCase):
    def test_legalizer_preserves_radius_even_with_distant_target(self):
        import numpy as np
        from pnr.place.legalize import _place_part
        occ = np.zeros((20, 20), dtype=bool)
        row, col = _place_part(occ, 1.0, 1, 1, (18, 18), [(5, 5, 2)])
        self.assertLessEqual((col + .5 - 5)**2 + (row + .5 - 5)**2, 4)

    def test_full_group_region_fails_instead_of_scattering(self):
        import numpy as np
        from pnr.place.legalize import _place_part, LegalizationError
        occ = np.zeros((20, 20), dtype=bool)
        occ[2:9, 2:9] = True
        with self.assertRaises(LegalizationError):
            _place_part(occ, 1.0, 1, 1, (18, 18), [(5, 5, 2)])

    def test_overlapping_groups_are_intersected(self):
        import numpy as np
        from pnr.place.legalize import _place_part
        limits = [(5, 5, 2), (8, 5, 2)]
        row, col = _place_part(np.zeros((20,20), dtype=bool), 1, 1, 1,
                               (18,18), limits)
        for ax, ay, radius in limits:
            self.assertLessEqual((col+.5-ax)**2+(row+.5-ay)**2, radius**2)

    def test_hard_group_requires_fixed_anchor_and_radius(self):
        from pnr.constraints import ConstraintError
        for radius in (None, True, 0, -1, float('nan'), float('inf')):
            with self.assertRaises(ConstraintError):
                compile_constraints({'fixed': {'U1': {'at': [5, 5]}},
                    'group': [{'members': ['C1'], 'anchor': 'U1',
                               'radius_mm': radius, 'hard': True}]}, ['U1', 'C1'])
        with self.assertRaises(ConstraintError):
            compile_constraints({'group': [{'members': ['C1'], 'anchor': 'U1',
                'radius_mm': 2, 'hard': True}]}, ['U1', 'C1'])

    def test_independent_metrics_detect_scattered_group(self):
        from pnr.graph import Component, BoardOutline
        from pnr.place.metrics import hard_violations
        from pnr.place.geometry import hard_group_limits, resolve_fixed_poses
        from pnr.place.legalize import legalize
        g = BoardGraph(name='group', components=[
            Component('U1', '', (5,5), 0, 'top', (2,2), (2,2)),
            Component('C1', '', (18,18), 0, 'top', (1,1), (1,1))],
            nets=[], outline=BoardOutline(width=20,height=20))
        c = compile_constraints({'board': {'outline': {'w':20,'h':20}},
            'fixed': {'U1': {'at':[5,5]}},
            'group': [{'members':['C1'], 'anchor':'U1', 'radius_mm':3,
                       'hard': True}]}, g.refs)
        self.assertEqual(hard_violations(g,c)['group_outside'], ['C1'])
        poses = resolve_fixed_poses(g,c)
        placed = legalize(g,20,20,fixed=poses,keepouts=[],
                         group_limits=hard_group_limits(c,poses))
        self.assertEqual(hard_violations(placed,c)['group_outside'], [])
        self.assertEqual(hard_violations(placed,c)['overlaps'], [])


if __name__ == "__main__":
    unittest.main()
