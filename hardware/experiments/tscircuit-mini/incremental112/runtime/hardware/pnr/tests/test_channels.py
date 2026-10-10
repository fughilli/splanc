"""Routing pressure must track nets and rules, not just footprint density."""
import unittest

from pnr.graph import BoardGraph, Component, Pad, Net
from pnr.place.channels import ChannelModel
from pnr.place.legalize import legalize, refine_channels
from pnr.place.metrics import overlap_pairs


def example():
    a = Component('A', 'qfn', (5, 5), 0, 'top', (2, 3), (2, 3),
                  pads=[Pad(str(i), 'n'+str(i), (1, i*.5-.75), (.2, .2)) for i in range(4)])
    b = Component('B', 'body', (7.5, 5), 0, 'top', (2, 3), (2, 3),
                  pads=[Pad('1', '', (-1, 0), (.2, 2))])
    return BoardGraph('test', [a,b], [Net('n'+str(i),i,[('A',str(i)),('C',str(i))]) for i in range(4)])


class ChannelTests(unittest.TestCase):
    def test_legalizer_recovers_an_unplaceable_global_orientation(self):
        a=Component('A','body',(2,1),90,'top',(4,2),(4,2))
        result=legalize(BoardGraph('turn',[a],[]),4,2,fixed={},keepouts=[],
            grid_mm=.25,clearance=0,allow_rotation=True)
        self.assertEqual(result.component('A').rot%180,0)
        self.assertFalse(overlap_pairs(result))

    def test_group_packer_reserves_the_only_legal_site(self):
        a=Component('A','body',(1,1),0,'top',(2,2),(2,2))
        b=Component('B','body',(1,1),0,'top',(2,2),(2,2))
        graph=BoardGraph('packing',[a,b],[])
        placed=legalize(graph,4,2,fixed={},keepouts=[],clearance=0,grid_mm=1,
            group_limits={'A':[(2,1,1)],'B':[(0,1,1.5)]})
        self.assertEqual(placed.component('B').pos,(1,1))
        self.assertEqual(placed.component('A').pos,(3,1))
        self.assertFalse(overlap_pairs(placed))

    def test_track_count_width_and_spacing(self):
        model = ChannelModel(example(), {'default_clearance_mm':.15})
        self.assertAlmostEqual(model.demand({'n0','n1','n2','n3'}), 1.55)
        self.assertAlmostEqual(model.demand({'n0'}), .5)

    def test_width_classes_and_usb_pair(self):
        model = ChannelModel(example(), {'default_clearance_mm': .15,
            'net_classes':[{'nets':['power'], 'width_mm':1.5}],
            'diff_pairs':[{'p':'dp','n':'dn','width_mm':.2,'gap_mm':.25}]})
        self.assertAlmostEqual(model.demand({'power','n0'}), 2.15)
        self.assertAlmostEqual(model.demand({'dp','dn'}), .95)

    def test_duplicate_pads_do_not_add_tracks(self):
        graph = example()
        baseline = ChannelModel(graph, {}).report(graph)
        graph.components[0].pads.append(Pad('copy','n0',(1,.25),(.2,.2)))
        self.assertEqual(ChannelModel(graph, {}).report(graph), baseline)

    def test_direct_local_net_does_not_require_longitudinal_channel(self):
        graph = example()
        for net in graph.nets:
            net.pins = [('A','1'),('B','1')]
        self.assertEqual(ChannelModel(graph, {}).report(graph)['channels'], [])

    def test_plane_needs_via_corridor(self):
        model = ChannelModel(example(), {'default_clearance_mm':.15,
            'net_classes':[{'nets':['ground'], 'plane_layer':'In1.Cu'}]})
        self.assertAlmostEqual(model.demand({'ground'}), .9)

    def test_shared_external_net_still_needs_one_escape(self):
        graph = example()
        for pad in graph.component('A').pads:
            pad.net = 'n0'
        graph.component('B').pads[0].net = 'n0'
        graph.nets[0].pins.append(('B','1'))
        channels = ChannelModel(graph, {'default_clearance_mm': .15}).report(graph)['channels']
        self.assertEqual(len(channels), 1)
        self.assertEqual(channels[0]['nets'], ['n0'])
        self.assertAlmostEqual(channels[0]['required_mm'], .5)

    def test_rotated_rows_and_opposite_sides(self):
        graph = example()
        initial = ChannelModel(graph, {}).report(graph)['shortage_score']
        for c in graph.components:
            c.pos = (10-c.pos[1], c.pos[0])
            c.rot = 90
        self.assertAlmostEqual(ChannelModel(graph, {}).report(graph)['shortage_score'], initial)
        graph.components[1].side = 'bottom'
        self.assertEqual(ChannelModel(graph, {}).report(graph)['channels'], [])

    def test_fixed_shortage_is_visible(self):
        graph = example()
        report = ChannelModel(graph, {}).report(graph, {'A','B'})
        self.assertTrue(report['channels'][0]['both_fixed'])

    def test_partial_row_does_not_count_unobstructed_pads(self):
        graph = example()
        graph.component('B').pads[0].size = (.2,.2)
        self.assertEqual(ChannelModel(graph, {}).report(graph)['channels'], [])

    def test_pressure_changes_legal_placement(self):
        graph = example()
        model = ChannelModel(graph, {})
        options = dict(fixed={'A':(5,5)}, keepouts=[], grid_mm=.1)
        old = legalize(graph, 15, 15, **options)
        new = legalize(graph, 15, 15, channel_model=model, **options)
        self.assertLess(model.report(new)['shortage_score'], model.report(old)['shortage_score'])
        self.assertEqual(overlap_pairs(new), [])
        self.assertEqual(new.component('A').pos, (5,5))

    def test_checkpoint_refinement_is_bounded_and_preserves_clear_parts(self):
        import math
        graph = example()
        graph.components.append(Component('Z','body',(12,12),0,'top',(1,1),(1,1)))
        model = ChannelModel(graph, {})
        new = refine_channels(graph, 15, 15, fixed={'A':(5,5)}, keepouts=[],
                              channel_model=model, max_move_mm=2)
        self.assertLess(model.report(new)['shortage_score'], model.report(graph)['shortage_score'])
        self.assertEqual(new.component('Z').pos, (12,12))
        self.assertEqual(new.component('A').pos, (5,5))
        self.assertEqual(graph.component('B').pos, (7.5,5))
        self.assertLessEqual(math.dist(new.component('B').pos, (7.5,5)), 2)
        self.assertEqual(overlap_pairs(new), [])


if __name__ == '__main__':
    unittest.main()
