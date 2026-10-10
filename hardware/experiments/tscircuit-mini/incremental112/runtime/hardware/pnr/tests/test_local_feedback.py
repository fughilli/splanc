import unittest
from types import SimpleNamespace
from pnr.route.detail.grid import RouteGrid, Cell
from pnr.route.detail.escape import trapped_access_sites
from pnr.route.feedback import detail_congestion
from pnr.graph import Component, Pad, BoardGraph, Net


class LocalFeedbackTest(unittest.TestCase):
    def test_deferred_power_is_not_signal_congestion_or_complete_board(self):
        from pnr.constraints import compile_constraints
        from pnr.route.feedback import route_and_place
        parts=[Component(ref,'test',(x,3),0,'top',(1,1),(1,1),pads=[Pad('1','rail',(0,0),(.5,.5))]) for ref,x in [('A',2),('B',10)]]
        graph=BoardGraph('deferred',parts,[Net('rail',1,[('A','1'),('B','1')])])
        constraints=compile_constraints({'board':{'outline':{'w':12,'h':6}},'fixed':{'A':{'at':[2,3]},'B':{'at':[10,3]}}},graph.refs)
        rules={'electrical_fab':{'outer_copper_oz':1},'fab':{'track_width_mm':.2,'clearance_mm':.15},'net_classes':[{'nets':['rail'],'width_mm':.5}]}
        placed,report=route_and_place(graph,constraints,iters=1,max_rounds=1,detail_rules=rules,detail_iters=1)
        self.assertEqual(report.deferred_nets,['rail'])
        self.assertEqual(report.final_overflow,0)
        self.assertFalse(report.detail_result.fully_routed)
        self.assertEqual(detail_congestion(report.detail_result,placed,12,6,1).sum(),0)

    def test_exhausted_escape_reports_only_its_cell(self):
        grid = RouteGrid(10, 10, 0.1, layers=("F.Cu",))
        grid.blocked[:] = True
        grid.blocked[0, 20, 20] = False
        sites = trapped_access_sites(grid, {"n": [Cell(0, 20, 20)]}, ["n"])
        self.assertEqual(sites, {"n": [grid.center_of(20, 20)]})
        board = SimpleNamespace(
            result=SimpleNamespace(unrouted=["n"]), failure_sites=sites
        )
        result = detail_congestion(board, SimpleNamespace(components=[]), 10, 10, 1)
        self.assertEqual(result.sum(), 1)
        self.assertEqual(result[2, 2], 1)

    def test_local_evidence_replaces_long_net_bbox(self):
        graph = SimpleNamespace(
            components=[
                Component(
                    "U" + str(i),
                    "test",
                    (x, x),
                    0,
                    "top",
                    (1, 1),
                    (1, 1),
                    pads=[Pad("1", "n", (0, 0), (0.2, 0.2))],
                )
                for i, x in enumerate((2, 8))
            ]
        )
        board = SimpleNamespace(result=SimpleNamespace(unrouted=["n"]))
        self.assertGreater(detail_congestion(board, graph, 10, 10, 1).sum(), 1)
        board.failure_sites = {"n": [(2.05, 2.05)]}
        result = detail_congestion(board, graph, 10, 10, 1)
        self.assertEqual(result.sum(), 1)
        self.assertEqual(result[8, 8], 0)

    def test_partial_edge_cell_stays_in_board_frame(self):
        grid = RouteGrid(1, 1, 0.3, layers=("F.Cu",))
        grid.blocked[:] = True
        grid.blocked[0, 3, 3] = False
        sites = trapped_access_sites(grid, {"n": [Cell(0, 3, 3)]}, ["n"])
        self.assertLess(sites["n"][0][0], 1)
        self.assertLess(sites["n"][0][1], 1)

    def test_open_neighborhood_and_budget_are_inconclusive(self):
        grid = RouteGrid(10, 10, 0.1, layers=("F.Cu",))
        for budget in (1, 256):
            self.assertEqual(
                trapped_access_sites(
                    grid, {"n": [Cell(0, 20, 20)]}, ["n"], budget=budget
                ),
                {},
            )

    def test_available_via_prevents_false_trap(self):
        grid = RouteGrid(10, 10, 0.1, layers=("F.Cu", "B.Cu"))
        grid.blocked[0] = True
        grid.blocked[0, 20, 20] = False
        self.assertEqual(
            trapped_access_sites(grid, {"n": [Cell(0, 20, 20)]}, ["n"]), {}
        )

    def test_stale_native_coordinates_are_rejected(self):
        board = SimpleNamespace(
            result=SimpleNamespace(unrouted=["n"]), failure_sites={"n": [(80, 50)]}
        )
        with self.assertRaises(ValueError):
            detail_congestion(board, SimpleNamespace(components=[]), 70, 55, 1)


if __name__ == "__main__":
    unittest.main()
