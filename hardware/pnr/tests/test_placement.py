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
        cls.placed, cls.report = place(cls.graph, cls.constraints, seed=0, iters=600)

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
        placed2, report2 = place(self.graph, self.constraints, seed=0, iters=600)
        self.assertEqual(placed2.to_json(), self.placed.to_json())
        self.assertEqual(report2.hpwl_placed, self.report.hpwl_placed)


if __name__ == "__main__":
    unittest.main()
