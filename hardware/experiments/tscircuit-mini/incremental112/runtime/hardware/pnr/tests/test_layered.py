import unittest
import math
from pnr.route.detail.layered import solve_layered_region
from pnr.route.detail.regional import Request
from pnr.route.detail.layered import (
    route_layers,
    primitives,
    copper_conflict,
    via_conflict,
)


class LayeredTest(unittest.TestCase):
    def test_layer_bridge_preserves_terminals_and_hole_spacing(self):
        def clear(la, a, b):
            return la != 0 or max(a[0], b[0]) < 1.9 or min(a[0], b[0]) > 2.1

        result = route_layers(
            [(0, 0)],
            [(4, 0)],
            (-1, -1, 5, 1),
            clear,
            lambda p: p[0] < 1.5 or p[0] > 2.5,
            pitch=0.2,
            max_expansions=30000,
        )
        self.assertEqual(result.status, "routed")
        self.assertEqual(result.path[0], (0, 0, 0))
        self.assertEqual(result.path[-1], (4, 0, 0))
        vias = [a for kind, la, a, b in primitives(result.path) if kind == "via"]
        self.assertEqual(len(vias), 2)
        self.assertGreaterEqual(math.dist(*vias), 0.501)
        for kind, la, a, b in primitives(result.path):
            if kind == "track":
                self.assertTrue(clear(la, a, b))

    def test_existing_inner_access_needs_only_one_transition(self):
        r = route_layers(
            [(0, 0)],
            [(4, 0)],
            (-1, -1, 5, 1),
            lambda *a: True,
            lambda p: 1 < p[0] < 3,
            pitch=0.2,
            terminal_layers=lambda p: (1,) if p == (0, 0) else (0,),
        )
        self.assertEqual(r.status, "routed")
        self.assertEqual(r.path[0], (0, 0, 1))
        self.assertEqual(r.path[-1], (4, 0, 0))
        self.assertEqual(sum(kind == "via" for kind, la, a, b in primitives(r.path)), 1)

    def test_forced_alternative_does_not_return_planar_route(self):
        r = route_layers(
            [(0, 0)],
            [(4, 0)],
            (-1, -1, 5, 1),
            lambda *a: True,
            lambda p: True,
            pitch=0.2,
            force_layered=True,
        )
        self.assertEqual(r.status, "routed")
        self.assertEqual(sum(kind == "via" for kind, la, a, b in primitives(r.path)), 2)

    def test_port_decomposition_respects_transition_budget(self):
        clear = (
            lambda la, a, b: la != 0 or max(a[0], b[0]) < 1.9 or min(a[0], b[0]) > 2.1
        )
        result = route_layers(
            [(0, 0)],
            [(4, 0)],
            (-1, -1, 5, 1),
            clear,
            lambda p: True,
            pitch=0.2,
            max_vias=1,
            max_expansions=1000,
        )
        self.assertFalse(result.path)

    def test_source_escape_window_selects_first_via(self):
        clear = (
            lambda la, a, b: la != 0 or max(a[0], b[0]) < 1.9 or min(a[0], b[0]) > 2.1
        )
        window = lambda p: 0.3 <= p[0] <= 0.9 and 0.5 <= p[1] <= 0.9
        result = route_layers(
            [(0, 0)],
            [(4, 0)],
            (-1, -1, 5, 1),
            clear,
            lambda p: True,
            pitch=0.2,
            first_via_allowed=window,
        )
        self.assertEqual(result.status, "routed")
        vias = [a for kind, la, a, b in primitives(result.path) if kind == "via"]
        self.assertEqual(len(vias), 2)
        self.assertTrue(window(vias[0]))

    def test_three_vias_cross_complementary_layer_barriers(self):
        def clear(la, a, b):
            if la == 0:
                return max(a[0], b[0]) < 0.9 or min(a[0], b[0]) > 5.1
            wall = 2 if la == 1 else 4
            return max(a[0], b[0]) < wall - 0.1 or min(a[0], b[0]) > wall + 0.1

        result = route_layers(
            [(0, 0)],
            [(6, 0)],
            (-1, -1, 7, 1),
            clear,
            lambda p: p[0] < 0.8 or p[0] > 5.2 or 2.5 < p[0] < 3.5,
            pitch=0.2,
            max_vias=3,
            max_expansions=10000,
        )
        self.assertEqual(result.status, "routed")
        vias = [a for kind, la, a, b in primitives(result.path) if kind == "via"]
        self.assertEqual(len(vias), 3)
        for i, a in enumerate(vias):
            for b in vias[i + 1 :]:
                self.assertGreaterEqual(math.dist(a, b), 0.501)
        for kind, la, a, b in primitives(result.path):
            if kind == "track":
                self.assertTrue(clear(la, a, b))

    def test_two_nets_cross_on_different_layers(self):
        requests = [
            Request("a", "a", [(0, 0)], [(4, 0)]),
            Request("b", "b", [(2, -1)], [(2, 1)]),
        ]

        def clear(r, la, a, b):
            return r.net != "b" or la != 0 or all(1.5 <= p[0] <= 2.5 for p in (a, b))

        result = solve_layered_region(
            requests,
            (-1, -2, 5, 2),
            clear,
            lambda r, p: abs(p[1]) >= 0.7,
            pitch=0.2,
            max_expansions=5000,
        )
        self.assertEqual(result.status, "routed")
        self.assertEqual(set(result.paths), {"a", "b"})
        self.assertTrue(
            any(kind == "via" for kind, la, a, b in primitives(result.paths["b"]))
        )
        for kind, la, a, b in primitives(result.paths["a"]):
            if kind == "track":
                self.assertFalse(
                    copper_conflict(a, b, la, result.paths["b"], 0.2, 0.2, 0.151)
                )

    def test_through_via_obstructs_every_layer(self):
        p = [(1, 1, 0), (1, 1, 1)]
        self.assertTrue(copper_conflict((0, 1), (2, 1), 2, p, 0.2, 0.2, 0.15))
        self.assertFalse(copper_conflict((0, 2), (2, 2), 2, p, 0.2, 0.2, 0.15))

    def test_same_net_holes_still_need_clearance(self):
        p = [(1, 1, 0), (1, 1, 1)]
        self.assertTrue(via_conflict((1.4, 1), p, 0.2, 0.15, same_net=True))
        self.assertFalse(via_conflict((1, 1), p, 0.2, 0.15, same_net=True))

    def test_no_legal_vias_does_not_bypass_wall(self):
        clear = (
            lambda la, a, b: la != 0 or max(a[0], b[0]) < 1.9 or min(a[0], b[0]) > 2.1
        )
        r = route_layers(
            [(0, 0)],
            [(4, 0)],
            (-1, -1, 5, 1),
            clear,
            lambda p: False,
            pitch=0.2,
            max_expansions=3000,
        )
        self.assertFalse(r.path)



import unittest
from pnr.route.detail.layered import route_escape_ports,primitives
class BacksidePortsTest(unittest.TestCase):
 def test_backside_terminals_escape_to_front_bridge(self):
  def clear(layer,a,b):return layer!=1 or max(a[0],b[0])<1.9 or min(a[0],b[0])>2.1
  r=route_escape_ports([(0.,0.)],[(4.,0.)],(-1.,-1.,5.,1.),clear,lambda p:p[0]<1.5 or p[0]>2.5,lambda p:(1,),pitch=.2,layers=2,budget=300,max_vias=2)
  self.assertEqual(r.status,'routed');self.assertEqual(r.path[0],(0.,0.,1));self.assertEqual(r.path[-1],(4.,0.,1))
  self.assertEqual(sum(kind=='via' for kind,_,_,_ in primitives(r.path)),2)
  self.assertTrue(all(clear(la,a,b) for kind,la,a,b in primitives(r.path) if kind=='track'))


if __name__ == "__main__":
    unittest.main()
