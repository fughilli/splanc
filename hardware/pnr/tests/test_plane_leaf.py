import unittest
import pcbnew as k
from test_native_electrical import board,pad
from pnr.native_electrical import add_track,vec,uid
from pnr.plane_leaf import eligible,plan
class PlaneLeafTest(unittest.TestCase):
 def fixture(self,shared=False):
  b=board();p=pad(b,'RENAMED','7','rail',(6,6),(.2,.2));ts=[add_track(b,'rail',k.F_Cu,(6,6),(7,6),.2),add_track(b,'rail',k.F_Cu,(7,6),(7,8),.2)];v=k.PCB_VIA(b);v.SetPosition(vec((7,8)));v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetViaType(k.VIATYPE_THROUGH);v.SetWidth(600000);v.SetDrill(300000);v.SetNetCode(p.GetNetCode());b.Add(v)
  if shared:pad(b,'CAP','2','rail',(9,8),(.5,.5));add_track(b,'rail',k.F_Cu,(7,8),(9,8),.2)
  b.BuildConnectivity();rules={'fab':{'track_width_mm':.2,'clearance_mm':.15},'net_classes':[{'name':'ground','nets':['rail'],'plane_layer':'In1.Cu','width_mm':.2}]};return b,p,v,ts,rules
 def test_renamed_leaf_shortens_without_mutating_input(self):
  b,p,v,ts,rules=self.fixture();old=[(uid(t),t.GetPosition().x,t.GetPosition().y) for t in b.GetTracks()];leaf=eligible(b,p,rules);self.assertFalse(leaf['shared']);r=plan(b,leaf,rules);self.assertLess(r['length'],leaf['old_length']);self.assertEqual(old,[(uid(t),t.GetPosition().x,t.GetPosition().y) for t in b.GetTracks()]);self.assertEqual(leaf['width'],.2)
 def test_shared_return_keeps_capacitor_branch(self):
  b,p,v,ts,rules=self.fixture(True);leaf=eligible(b,p,rules);self.assertTrue(leaf['shared']);self.assertEqual({uid(t) for t in leaf['tracks']},{uid(t) for t in ts})
 def test_protected_intent_and_locked_objects_reject(self):
  b,p,v,ts,rules=self.fixture();self.assertIsNone(eligible(b,p,rules,[uid(p)]));v.SetLocked(True);self.assertIsNone(eligible(b,p,rules));v.SetLocked(False);ts[0].SetLocked(True);self.assertIsNone(eligible(b,p,rules))
 def test_other_layer_port_rejects(self):
  b,p,v,ts,rules=self.fixture();add_track(b,'rail',k.In2_Cu,(7,8),(9,9),.2);self.assertIsNone(eligible(b,p,rules))
 def test_mixed_width_and_plated_pad_reject(self):
  b,p,v,ts,rules=self.fixture();ts[0].SetWidth(250000);self.assertIsNone(eligible(b,p,rules));ts[0].SetWidth(200000);p.SetAttribute(k.PAD_ATTRIB_PTH);self.assertIsNone(eligible(b,p,rules))
 def test_midleaf_attached_pad_rejects(self):
  b,p,v,ts,rules=self.fixture(True);pad(b,'EXTRA','1','rail',(7,7),(.4,.4));self.assertIsNone(eligible(b,p,rules))
 def test_two_via_array_rejects(self):
  b,p,v,ts,rules=self.fixture();z=k.PCB_VIA(b);z.SetPosition(vec((7,7.5)));z.SetLayerPair(k.F_Cu,k.B_Cu);z.SetWidth(600000);z.SetDrill(300000);z.SetNetCode(p.GetNetCode());b.Add(z);self.assertIsNone(eligible(b,p,rules))
if __name__=='__main__':unittest.main()

class TriggerTest(unittest.TestCase):
 def test_fine_frontier_overrides_empty_coarse_frontier(self):
  from pnr.plane_leaf_repair import endpoint_has_no_escape
  rows=[dict(request='missing',stage='escape_ports',side=0,ports=[]),dict(request='missing',stage='escape_ports',side=1,ports=[]),dict(request='missing',stage='escape_ports',side=1,ports=[{'point':[1,2]}])]
  self.assertEqual(endpoint_has_no_escape(rows),[0])
 def test_restore_only_and_absent_telemetry_are_not_evidence(self):
  from pnr.plane_leaf_repair import endpoint_has_no_escape
  self.assertEqual(endpoint_has_no_escape([]),[])
  self.assertEqual(endpoint_has_no_escape([dict(request='restore-1',stage='escape_ports',side=0,ports=[])]),[])
