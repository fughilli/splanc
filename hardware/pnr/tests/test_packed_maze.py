import os, random, unittest
from unittest.mock import patch
from pnr.route.detail.grid import Cell, RouteGrid
from pnr.route.detail.maze import _astar, route
from pnr.route.detail.packed_maze import astar

class PackedMazeTest(unittest.TestCase):

    def parity(self, grid, sources, targets, **kwargs):
        args = (grid, sources, targets, 'N', kwargs.pop('occ', {}), kwargs.pop('history', {}), 3.0, 0.6)
        with patch.dict(os.environ, {'PNR_PACKED_MAZE': '0'}):
            expected = _astar(*args, **kwargs)
        self.assertEqual(astar(*args, **kwargs), expected)
        return expected

    def test_seeded_obstacles_prices_halos_and_drills(self):
        for seed in range(60):
            with self.subTest(seed=seed):
                rng = random.Random(seed)
                grid = RouteGrid(9, 8, 1, layers=('F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'))
                grid.routing_track_halos = {'N': seed % 2}
                grid.routing_via_keepout = seed % 3
                cells = [Cell(la, i, j) for la in range(4) for i in range(9) for j in range(8)]
                for c in rng.sample(cells, 30):
                    grid.blocked[c.layer, c.j, c.i] = True
                for c in rng.sample(cells, 20):
                    grid.via_blocked[c.layer, c.j, c.i] = True
                for c in rng.sample(cells, 18):
                    grid.pad_net[c.layer, c.i, c.j] = 'OTHER'
                for c in rng.sample(cells, 18):
                    grid.via_halo[c.layer, c.i, c.j] = 'OTHER'
                grid.source_drills = [((4.5, 4.5), 0.3)]
                grid.escape_vias = [('N', (3.5, 5.5))]
                grid.via_spacing = 1.2
                self.parity(grid, {Cell(0, 0, 0), Cell(3, 0, 1)}, {Cell(0, 8, 7), Cell(3, 7, 7)}, blocked=set(rng.sample(cells, 10)), occ={c: rng.randrange(3) for c in rng.sample(cells, 30)}, history={c: rng.random() * 3 for c in rng.sample(cells, 25)}, soft={c: rng.random() * 4 for c in rng.sample(cells, 25)}, diagonal=seed % 3 != 0, drill_sites=((5.5, 5.5),))

    def test_outside_coordinates_never_alias_an_edge(self):
        grid = RouteGrid(3, 3, 1)
        grid.routing_via_keepout = 1
        outside = {Cell(0, -1, 1), Cell(1, 3, 0), Cell(1, 1, -1)}
        self.parity(grid, {Cell(0, 2, 0)}, {Cell(1, 2, 0)}, blocked=outside, soft={c: 1000 for c in outside}, occ={c: 1000 for c in outside}, history={c: 1000 for c in outside})
        grid.routing_track_halos = {'N': 1}
        self.parity(grid, {Cell(0, 0, 0)}, {Cell(1, 2, 2)}, blocked=outside)

    def test_plated_transition_and_nonlanding_layer(self):
        grid = RouteGrid(1, 1, 1, layers=('F.Cu', 'In1.Cu', 'In2.Cu', 'B.Cu'))
        grid.plated_ports = [('N', (0.5, 0.5), 0.5)]
        grid.source_drills = [((0.5, 0.5), 0.3)]
        self.assertIsNotNone(self.parity(grid, {Cell(0, 0, 0)}, {Cell(3, 0, 0)}))
        grid.via_halo[1, 0, 0] = 'OTHER'
        self.assertIsNone(self.parity(grid, {Cell(0, 0, 0)}, {Cell(3, 0, 0)}))

    def test_cache_does_not_survive_geometry_change(self):
        grid = RouteGrid(5, 5, 1)
        sources, targets = ({Cell(0, 0, 0)}, {Cell(1, 4, 4)})
        self.parity(grid, sources, targets)
        grid.blocked[:, :, 2] = True
        grid.via_blocked[:, :, 2] = True
        self.assertIsNone(self.parity(grid, sources, targets))

    def test_complete_negotiation_output_matches(self):
        grid = RouteGrid(8, 8, 1)
        access = {'A': [Cell(0, 0, 3), Cell(0, 7, 3)], 'B': [Cell(0, 3, 0), Cell(0, 3, 7)], 'C': [Cell(1, 0, 0), Cell(0, 7, 7), Cell(1, 7, 0)]}
        with patch.dict(os.environ, {'PNR_PACKED_MAZE': '0', 'PNR_SINGLE_TRACK_WORKERS': '1'}):
            reference = route(grid, access, max_iters=3, rrr_rounds=2)
        with patch.dict(os.environ, {'PNR_PACKED_MAZE': '1', 'PNR_SINGLE_TRACK_WORKERS': '1'}):
            packed = route(grid, access, max_iters=3, rrr_rounds=2)
        self.assertEqual(packed, reference)

    def test_parallel_conflicts_reroute_serially(self):
        from pnr.route.detail import maze
        for mode in ['0', '1']:
            grid = RouteGrid(7, 7, 1)
            access = {'A': [Cell(0, 0, 3), Cell(0, 6, 3)], 'B': [Cell(0, 3, 0), Cell(0, 3, 6)]}

            class SnapshotPool:
                workers = 2

                def configure(self):
                    return 2

                def batch(self, nets, access, occ, history, via_cost, pres_fac, blocked=None):
                    return [maze._route_one(grid, access[n], n, dict(occ), dict(history), via_cost, pres_fac, blocked=blocked) for n in nets]
            with patch.dict(os.environ, {'PNR_PACKED_MAZE': mode}), patch('pnr.live.emit') as emit:
                result = maze._route_impl(grid, access, max_iters=3, rrr_rounds=2, _pool=SnapshotPool())
            self.assertTrue(result.fully_routed)
            self.assertTrue(any((call.args[0] == 'parallel_grid_retry' for call in emit.call_args_list)))
            used = set()
            for net, rn in result.nets.items():
                edges = [(Cell(layer, *a), Cell(layer, *b)) for layer, a, b in rn.segments]
                edges.extend(((Cell(0, i, j), Cell(1, i, j)) for i, j in rn.vias))
                footprint = maze._footprint(grid, rn.cells, 1, edges=edges, net=net)
                self.assertFalse(used & footprint)
                used.update(footprint)
if __name__ == '__main__':
    unittest.main()
