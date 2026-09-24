"""Phase 3 acceptance — orientation search on the splanc_dev fixture (design §9.3).

The placer now co-optimizes a 90° rotation per movable part (a temperature-
annealed softmax over {0,90,180,270}). Asserts: orientations settle to **legal
discrete angles**, the result stays fully legal, orientation is actually exercised,
and HPWL **improves vs. the position-only Phase 2 placement** — deterministically.
"""

import os
import unittest

import yaml
from pnr.constraints import compile_constraints
from pnr.graph import BoardGraph
from pnr.place import place

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "testdata", "splanc_dev")
LEGAL_ANGLES = {0, 90, 180, 270}


def _load():
    with open(os.path.join(FIXTURE, "graph.json"), encoding="utf-8") as fh:
        graph = BoardGraph.from_json(fh.read())
    with open(os.path.join(FIXTURE, "constraints.yaml"), encoding="utf-8") as fh:
        constraints = compile_constraints(yaml.safe_load(fh), graph.refs)
    return graph, constraints


class OrientationAcceptanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph, cls.constraints = _load()
        cls.placed, cls.report = place(cls.graph, cls.constraints, seed=0, iters=600, orient=True)
        _, cls.report_noorient = place(cls.graph, cls.constraints, seed=0, iters=600, orient=False)

    def test_result_is_legal(self):
        self.assertTrue(self.report.legal, self.report.summary())

    def test_orientations_are_legal_discrete_angles(self):
        for c in self.placed.components:
            self.assertIn(int(round(c.rot)) % 360, LEGAL_ANGLES, c.ref)

    def test_orientation_is_exercised(self):
        # The search should actually rotate parts (not collapse to all-zero).
        self.assertGreater(self.report.rotated, 0, self.report.summary())

    def test_hpwl_improves_vs_position_only(self):
        # Design §9.3: orientation improves HPWL vs. Phase 2 (never worse).
        self.assertLessEqual(
            self.report.hpwl_placed,
            self.report_noorient.hpwl_placed,
            f"oriented {self.report.hpwl_placed:.0f} vs "
            f"position-only {self.report_noorient.hpwl_placed:.0f}",
        )

    def test_deterministic(self):
        placed2, _ = place(self.graph, self.constraints, seed=0, iters=600, orient=True)
        self.assertEqual(placed2.to_json(), self.placed.to_json())


if __name__ == "__main__":
    unittest.main()
