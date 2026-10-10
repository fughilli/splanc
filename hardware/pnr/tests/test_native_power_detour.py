import unittest,json
import pcbnew as k
from test_native_electrical import board,pad
from pnr.native_electrical import add_track,uid,xy
from pnr.power_detour import shifted_path,distance_to_segment,propose
from pnr.power_detour_repair import repair_bounds
class DetourTest(unittest.TestCase):
 def test_fixed_endpoints_and_45_degree_shoulders(self):
  p=shifted_path((5,3),(5,8),(3,5),.75)
  self.assertEqual(p,[(5,3),(5.75,3.75),(5.75,7.25),(5,8)])
 def test_opposite_side_pushes_opposite_way(self):
  self.assertLess(shifted_path((5,3),(5,8),(7,5),.5)[1][0],5)
 def test_short_track_is_not_folded_back(self):self.assertIsNone(shifted_path((0,0),(.8,0),(0,1),.5))
 def test_point_projection_and_endpoint_clamp(self):
  self.assertEqual(distance_to_segment((2,2),(0,0),(4,0)),(2,0.5));self.assertEqual(distance_to_segment((5,0),(0,0),(4,0)),(1,1))
 def test_restoration_endpoints_expand_both_axes(self):
  t=dict(source_xy=[70.84,44.5],target_xy=[74.75,50.445]);b=repair_bounds(t,dict(restoration_bounds=[65.41,39.125,76.375,45.625]));self.assertEqual(b,[65.4,39.1,77.75,53.45])
 def fixture(self,mode='power',locked=False):
  b=board()
  for net in ('DATA','OTHER','RENAMED_RAIL'):b.Add(k.NETINFO_ITEM(b,net))
  p=pad(b,'DIFFERENT','3','DATA',(6,6),(.71,.25));pad(b,'N','4','OTHER',(6,5.5),(.71,.25));pad(b,'S','5','OTHER',(6,6.5),(.71,.25));t=add_track(b,'RENAMED_RAIL',k.F_Cu,(7.7,4),(7.7,8),1.5);t.SetLocked(locked);rules={'fab':{'track_width_mm':.2,'clearance_mm':.15},'net_classes':[{'name':'rail','nets':['RENAMED_RAIL'],'width_mm':1.5}]}
  if mode=='plane':rules['net_classes'][0]['plane_layer']='In1.Cu'
  if mode=='pair':rules['diff_pairs']=[{'name':'RENAMED_PAIR','p':'RENAMED_RAIL','n':'MATE'}]
  return b,p,t,rules
 def test_renamed_power_preserves_width_and_input_geometry(self):
  b,p,t,rules=self.fixture();before=[(uid(x),xy(x.GetStart()),xy(x.GetEnd()),x.GetWidth()) for x in b.GetTracks()];r=propose(b,p,rules);self.assertTrue(r['considered']);self.assertTrue(all(x['width_mm']==1.5 and x['net']=='RENAMED_RAIL' for x in r['considered']));self.assertEqual(before,[(uid(x),xy(x.GetStart()),xy(x.GetEnd()),x.GetWidth()) for x in b.GetTracks()])
 def test_locked_power_excluded(self):
  b,p,t,rules=self.fixture(locked=True);self.assertEqual(propose(b,p,rules)['considered'],[])
 def test_plane_copper_excluded(self):
  b,p,t,rules=self.fixture(mode='plane');self.assertEqual(propose(b,p,rules)['considered'],[])
 def test_pair_copper_excluded(self):
  b,p,t,rules=self.fixture(mode='pair');self.assertEqual(propose(b,p,rules)['considered'],[])
class BudgetTest(unittest.TestCase):
 def test_ineligible_pads_do_not_consume_trial_budget(self):
  from pnr.power_detour_repair import DetourBudget
  b=DetourBudget(max_trials=1,max_probes=3);self.assertTrue(b.reserve('a','X.1','s'));b.record({'status':'no_improving_detour'});self.assertTrue(b.available);self.assertFalse(b.reserve('a','X.1','s'));self.assertTrue(b.reserve('b','X.1','s'));b.record({'detour':{'guards_pass':True}});self.assertFalse(b.available)
 def test_distinct_pads_are_not_whole_footprint_cached(self):
  from pnr.power_detour_repair import DetourBudget
  b=DetourBudget();self.assertTrue(b.reserve('a','X.1','s'));self.assertTrue(b.reserve('a','X.2','z'))
if __name__=='__main__':unittest.main()
