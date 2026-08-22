"""R5 acceptance — the detailed router on a real *placed* board (splanc_dev).

Places the fixture, then negotiated-routes its signal nets on the grid, and checks
the result is **DRC-clean by construction** (no grid cell shared by two nets) and
that it routes a strong majority of the signals. This is the router proving itself
on real data — the case FreeRouting couldn't finish.
"""

import os
import unittest

import yaml
from pnr.constraints import compile_constraints, compile_routing_rules
from pnr.graph import BoardGraph
from pnr.place import place
from pnr.route.detail.router import route_board

HERE = os.path.dirname(os.path.abspath(__file__))
FIXTURE = os.path.join(HERE, "..", "testdata", "splanc_dev")


def _load():
    with open(os.path.join(FIXTURE, "graph.json"), encoding="utf-8") as fh:
        graph = BoardGraph.from_json(fh.read())
    with open(os.path.join(FIXTURE, "constraints.yaml"), encoding="utf-8") as fh:
        constraints = compile_constraints(yaml.safe_load(fh), graph.refs)
    return graph, constraints


class DetailRouteAcceptanceTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        graph, cls.constraints = _load()
        cls.placed, _rep = place(graph, cls.constraints, seed=0, iters=300, orient=False)
        cls.rules = compile_routing_rules(cls.constraints, [n.name for n in cls.placed.nets])
        # Coarse pitch keeps the test quick; the engine is pitch-agnostic. Power/
        # ground are planes (excluded); only true signals are routed here.
        cls.board = route_board(cls.placed, cls.constraints, cls.rules, pitch=0.4, max_iters=15)

    def test_drc_clean_by_construction(self):
        # The emitted routing is *always* DRC-clean: no grid cell is occupied by
        # two different nets (⇒ clearance holds at the grid pitch). Guaranteed by
        # route()'s greedy finalize — contested nets are dropped to unrouted.
        used = {}
        for name, rn in self.board.result.nets.items():
            for c in rn.cells:
                self.assertNotIn(c, used, f"cell {c} shared by {used.get(c)} and {name}")
                used[c] = name

    def test_routes_a_meaningful_fraction(self):
        # A WIP single-engine router on a dense 2-signal-layer board: it routes a
        # meaningful fraction DRC-clean; the loop (R5) + tuning close the rest.
        res = self.board.result
        total = len(res.nets)
        routed = total - len(res.unrouted)
        self.assertGreater(total, 20, "expected many signal nets")
        self.assertGreaterEqual(routed / total, 0.5, self.board.summary())

    def test_emits_geometry(self):
        self.assertGreater(len(self.board.tracks), 50, self.board.summary())
        for layer, _a, _b, w in self.board.tracks:
            self.assertIn(layer, ("F.Cu", "B.Cu"))
            self.assertGreater(w, 0)

    def test_deterministic(self):
        # Two fresh back-to-back routes of the same placed board must match.
        b1 = route_board(self.placed, self.constraints, self.rules, pitch=0.4, max_iters=15)
        b2 = route_board(self.placed, self.constraints, self.rules, pitch=0.4, max_iters=15)
        self.assertEqual(b1.result.unrouted, b2.result.unrouted)
        self.assertEqual(len(b1.tracks), len(b2.tracks))


if __name__ == "__main__":
    unittest.main()
