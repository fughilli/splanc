"""Native regressions for generic coupled layer transitions."""
import unittest
import pcbnew as k
from test_native_electrical import board,pad,FAB
from pnr.native_electrical import Oracle,pair_layer_bridge,pair_via_geometry
from pnr.route.detail.coupled import path_metrics

class PairBridgeTest(unittest.TestCase):
    def setup_bridge(self):
        b=board();terms={'p':((3,5.4),(15,5.4)),'n':((3,4.6),(15,4.6))}
        for net,(a,z) in terms.items():
            pad(b,'SOURCE',net,net,a,(.2,.2));pad(b,'TARGET',net,net,z,(.2,.2))
        r=dict(fab={'clearance_mm':.15,'via_diameter_mm':.7,'via_drill_mm':.35},electrical_fab=FAB)
        pair=dict(p='p',n='n',width_mm=.2,gap_mm=.2,skew_mm=.1,max_uncoupled_mm=2)
        return b,terms,r,pair

    def test_matched_bridge_uses_fabrication_dimensions_and_barrel_lengths(self):
        b,terms,r,pair=self.setup_bridge()
        plan=pair_layer_bridge(b,pair,terms,r,Oracle(b,r),(1,1,19,19),.2,{})
        self.assertEqual(plan['status'],'routed')
        self.assertEqual((plan['via_diameter_mm'],plan['via_drill_mm']),(.7,.35))
        self.assertEqual(len(plan['pair_vias']),4)
        measured=[]
        for net in ('p','n'):
            tracks=[(la,a,z) for nn,la,a,z,w in plan['pair_tracks'] if nn==net]
            vias=[(pt,[k.F_Cu,k.B_Cu]) for nn,pt in plan['pair_vias'] if nn==net]
            metric=path_metrics(tracks,vias,(terms[net][0],k.F_Cu),(terms[net][1],k.F_Cu),layer_heights={k.F_Cu:0,k.B_Cu:1.6})
            self.assertTrue(metric['valid']);self.assertAlmostEqual(metric['length_mm'],plan['lengths'][net],places=5)
            self.assertGreater(metric['length_mm'],15.2);measured.append(metric['length_mm'])
        self.assertLess(abs(measured[0]-measured[1]),pair['skew_mm'])

    def test_reuses_existing_source_pair_without_duplicate_vias(self):
        b,terms,r,pair=self.setup_bridge();o=Oracle(b,r)
        first=pair_layer_bridge(b,pair,terms,r,o,(1,1,19,19),.2,{})
        old=first['bridge_target'];reuse=dict(sites=old['sites'],paths={n:[] for n in ('p','n')},lengths={n:0 for n in ('p','n')},reuse=True)
        for net,pt in old['sites'].items():o.reserve_via(net,pt,.7,.35)
        next_terms={net:(terms[net][1],(8,terms[net][1][1]+8)) for net in ('p','n')}
        plan=pair_layer_bridge(b,pair,next_terms,r,o,(1,1,19,19),.2,{},reuse_source=reuse)
        self.assertEqual(plan['status'],'routed')
        self.assertEqual(len(plan['pair_vias']),2)
        self.assertTrue(all(pt not in old['sites'].values() for net,pt in plan['pair_vias']))

    def test_invalid_via_geometry_is_not_silently_defaulted(self):
        with self.assertRaises(ValueError):pair_via_geometry({'fab':{'via_diameter_mm':.3,'via_drill_mm':.3}})
        self.assertEqual(pair_via_geometry({'electrical_fab':{'via_diameter_mm':.8,'via_drill_mm':.4}}),(.8,.4))

if __name__=='__main__':unittest.main()
