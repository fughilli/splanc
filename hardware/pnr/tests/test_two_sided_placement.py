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


if __name__ == '__main__':
    unittest.main()
