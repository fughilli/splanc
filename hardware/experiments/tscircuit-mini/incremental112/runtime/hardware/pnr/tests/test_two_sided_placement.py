"""Bottom test copper shares XY with SMD parts, but never through-hole bodies."""
import unittest
from pnr.graph import BoardGraph, Component, Pad
from pnr.place.legalize import legalize
from pnr.place.metrics import overlap_pairs
from pnr.place.geometry import set_component_side, pin_positions


def part(ref, side, through=False):
    return Component(ref, 'test', (5, 5), 0, side, (4, 4), (4, 4),
                     pads=[Pad('1', 'GND', (0, 0), (1, 1), through)])


class TwoSidedPlacementTest(unittest.TestCase):
    def test_flip_updates_asymmetric_pad_coordinates_and_round_trips(self):
        c = part('TP1', 'top')
        c.pads[0].offset = (1, 2)
        set_component_side(c, 'bottom')
        self.assertEqual(pin_positions(c), [('1', (6.0, 3.0))])
        set_component_side(c, 'bottom')  # Same-side assignment must not mirror again.
        self.assertEqual(c.pads[0].offset, (1, -2))
        set_component_side(c, 'top')
        self.assertEqual(c.pads[0].offset, (1, 2))

    def test_fresh_source_fixed_side_applied_before_placement(self):
        from pnr.constraints import compile_constraints
        from pnr.place.placer import place
        a,b=part('U1','top'),part('TP1','top')
        b.pads[0].offset=(1,2)
        g=BoardGraph('fresh',[a,b],[])
        rules=compile_constraints({'board':{'outline':{'w':10,'h':10}},
            'fixed':{'U1':{'at':[5,5],'side':'top'},'TP1':{'at':[5,5],'side':'bottom'}}},g.refs)
        result,report=place(g,rules,iters=1)
        self.assertTrue(report.legal,report.summary())
        self.assertEqual(result.component('TP1').side,'bottom')
        self.assertEqual(result.component('TP1').pads[0].offset,(1,-2))
        self.assertEqual(g.component('TP1').side,'top')

    def test_global_spreading_does_not_repel_opposite_surface_smd(self):
        from pnr.constraints import compile_constraints
        from pnr.graph import Net
        from pnr.place.model import global_place
        a,b=part('U1','top'),part('TP1','bottom')
        g=BoardGraph('test',[a,b],[Net('GND',1,[('U1','1'),('TP1','1')])])
        c=compile_constraints({'board':{'outline':{'w':15,'h':15}},
                              'fixed':{'TP1':{'at':[5,5],'side':'bottom'}}},g.refs)
        positions,_=global_place(g,c,15,15,iters=150,orient=False,w_spread=10)
        self.assertLess(abs(positions['U1'][0]-5)+abs(positions['U1'][1]-5), .2)
        a.pads[0].through_hole=True
        positions,_=global_place(g,c,15,15,iters=150,orient=False,w_spread=10)
        self.assertGreater(abs(positions['U1'][0]-5)+abs(positions['U1'][1]-5), 3)

    def test_opposite_smd_can_share_position(self):
        g = BoardGraph('test', [part('U1', 'top'), part('TP1', 'bottom')])
        result = legalize(g, 10, 10, fixed={'U1': (5, 5)}, keepouts=[], grid_mm=.2)
        self.assertEqual(overlap_pairs(result), [])
        self.assertLess(abs(result.component('TP1').pos[0] - 5), .3)
        self.assertLess(abs(result.component('TP1').pos[1] - 5), .3)

    def test_same_side_overlap_still_detected(self):
        self.assertEqual(overlap_pairs(BoardGraph('test', [part('U1','top'),part('U2','top')])), [('U1','U2')])

    def test_through_hole_blocks_both_sides(self):
        g = BoardGraph('test', [part('J1','top',True),part('TP1','bottom')])
        self.assertEqual(overlap_pairs(g), [('J1','TP1')])
        result = legalize(g, 15, 15, fixed={'J1': (5,5)},keepouts=[],grid_mm=.2)
        self.assertEqual(overlap_pairs(result), [])

    def test_movable_through_hole_avoids_bottom_part(self):
        g = BoardGraph('test', [part('J1','top',True),part('TP1','bottom')])
        result = legalize(g, 15, 15, fixed={'TP1': (5,5)},keepouts=[],grid_mm=.2)
        self.assertEqual(overlap_pairs(result), [])



class SurfaceBodyHoleTest(unittest.TestCase):
    def test_smd_body_reserves_actual_holes_on_opposite_side(self):
        a=part('U1','top',True);a.smd_body=True;a.courtyard=(10,10)
        b=part('TP1','bottom');b.courtyard=(1,1);b.pos=(8,5)
        g=BoardGraph('test',[a,b])
        self.assertEqual(overlap_pairs(g),[])
        b.pos=(5,5)
        self.assertEqual(overlap_pairs(g),[('U1','TP1')])
        b.pos=(8,5)
        clone=BoardGraph.from_json(g.to_json())
        self.assertTrue(clone.component('U1').smd_body)
        result=legalize(clone,15,15,fixed={'U1':(5,5)},keepouts=[],grid_mm=.2)
        self.assertEqual(overlap_pairs(result),[])
        self.assertLess(abs(result.component('TP1').pos[0]-8),.3)
        self.assertLess(abs(result.component('TP1').pos[1]-5),.3)

if __name__ == '__main__':
    unittest.main()
