"""Phase 4 acceptance — the place↔route feedback loop (design §6/§9.4).

Asserts, on the ``splanc_dev`` fixture, that the lookahead global-route overflow
**reaches 0** within the pass cap and that the loop **terminates** (converges, no
oscillation) — deterministically under a fixed seed. Also checks the overflow
trajectory is non-increasing, i.e. the PathFinder-history damping (§6) works.
"""

import os
import unittest

import yaml
from pnr.constraints import compile_constraints
from pnr.graph import BoardGraph
from pnr.route.feedback import route_and_place

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "testdata", "splanc_dev")


def _load():
    with open(os.path.join(FIXTURE, "graph.json"), encoding="utf-8") as fh:
        graph = BoardGraph.from_json(fh.read())
    with open(os.path.join(FIXTURE, "constraints.yaml"), encoding="utf-8") as fh:
        constraints = compile_constraints(yaml.safe_load(fh), graph.refs)
    return graph, constraints


class RouteFeedbackAcceptanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.graph, cls.constraints = _load()
        cls.placed, cls.report = route_and_place(
            cls.graph, cls.constraints, seed=0, iters=400, max_rounds=6
        )

    def test_loop_terminates(self):
        # It must not run to the round cap without deciding — it converges.
        self.assertTrue(self.report.converged, self.report.summary())
        self.assertLessEqual(self.report.rounds, 6)

    def test_overflow_reaches_zero(self):
        self.assertEqual(self.report.final_overflow, 0.0, self.report.summary())

    def test_overflow_non_increasing(self):
        # The damping (accumulated history → inflation) must not let overflow rise.
        self.assertTrue(self.report.monotone_nonincreasing, self.report.summary())

    def test_placement_still_legal(self):
        # Routing feedback must not break placement legality.
        self.assertTrue(self.report.placement.legal, self.report.placement.summary())

    def test_deterministic(self):
        placed2, report2 = route_and_place(
            self.graph, self.constraints, seed=0, iters=400, max_rounds=6
        )
        self.assertEqual(placed2.to_json(), self.placed.to_json())
        self.assertEqual(report2.overflow_history, self.report.overflow_history)


if __name__ == "__main__":
    unittest.main()
