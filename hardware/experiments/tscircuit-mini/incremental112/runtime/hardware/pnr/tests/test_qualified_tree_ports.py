import unittest
import pcbnew as k
from test_native_electrical import board,pad,FAB
from pnr.native_electrical import add_track,qualified_tree_pads,uid
from pnr.electrical import compile_policy,net_policy,terminal_policy

class QualifiedTreePortsTest(unittest.TestCase):
    def fixture(self,thin=False,grazing=False,other_layer=False):
        b=board();p=pad(b,'LOAD','1','rail',(5,5),(.4,.4))
        records=[dict(ref='SUPPLY',pads=['1'],net='rail',scope='net',rms_current_a=4,peak_current_a=5,source={}),dict(ref='LOAD',pads=['1'],net='rail',scope='terminal',rms_current_a=4,peak_current_a=5,neck_max_length_mm=.5,source={})]
        rules=compile_policy({'fab':{'track_width_mm':.2},'net_classes':[{'nets':['rail'],'width_mm':1.5}]},records,dict(FAB,neck_loss_budget_w=.01,neck_peak_drop_v=.005))
        width=terminal_policy('LOAD',['1'],'rail',rules)['outer_width_mm']
        add_track(b,'rail',k.F_Cu,(5,5),(5.3,5),.4)
        add_track(b,'rail',k.F_Cu,(5.3,5),(6,5),width)
        if grazing:
            add_track(b,'rail',k.F_Cu,(6,5.8),(7,5.8),width);anchor=add_track(b,'rail',k.F_Cu,(7,5.8),(8,5.8),1.5)
        else:
            add_track(b,'rail',k.B_Cu if other_layer else k.F_Cu,(6,5),(7,5),.2 if thin else width)
            anchor=add_track(b,'rail',k.F_Cu,(7,5),(8,5),1.5)
        return b,p,rules,anchor
    def ports(self,b,p,rules,anchor,excluded=()):
        return qualified_tree_pads(b,'rail',k.F_Cu,net_policy('rail',rules),rules,[anchor],excluded)
    def test_reuses_source_sized_lead_already_connected_to_trunk(self):
        b,p,r,a=self.fixture();self.assertEqual([uid(q) for q in self.ports(b,p,r,a)],[uid(p)])
    def test_does_not_reuse_thin_sense_link_in_middle(self):
        b,p,r,a=self.fixture(thin=True);self.assertEqual(self.ports(b,p,r,a),[])
    def test_grazing_track_intersection_is_not_full_current_path(self):
        b,p,r,a=self.fixture(grazing=True);self.assertEqual(self.ports(b,p,r,a),[])
    def test_no_unproven_other_layer_shortcut(self):
        b,p,r,a=self.fixture(other_layer=True);self.assertEqual(self.ports(b,p,r,a),[])
    def test_lower_current_annotation_cannot_qualify_root(self):
        b,p,r,a=self.fixture();r['current_intents'][1]['rms_current_a']=.01;self.assertEqual(self.ports(b,p,r,a),[])
    def test_excludes_source_component_already_being_routed(self):
        b,p,r,a=self.fixture();self.assertEqual(self.ports(b,p,r,a,[uid(p)]),[])

if __name__=='__main__':unittest.main()
