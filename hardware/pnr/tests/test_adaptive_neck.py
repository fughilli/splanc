import unittest
import pcbnew as k
from test_native_electrical import board,pad,vec,FAB
from pnr.native_electrical import Oracle,power_plan,add_track
from pnr.pad_entry import rectangular_custom_land,witness,neck_witness,snapshot
from pnr.electrical import compile_policy,net_policy
class AdaptiveNeckTest(unittest.TestCase):
 def test_rectangular_custom_land_gets_full_contact_not_anchor_graze(self):
  b=board();p=pad(b,'A','1','rail',(5,5),(.01,.01));p.SetShape(k.PAD_SHAPE_CUSTOM);poly=k.SHAPE_POLY_SET();poly.NewOutline()
  for pt in [(-.18,-.56),(.18,-.56),(.18,.56),(-.18,.56)]:poly.Append(vec(pt))
  p.AddPrimitivePoly(k.F_Cu,poly,0,True);self.assertIsNotNone(rectangular_custom_land(p,k.F_Cu))
  t=add_track(b,'rail',k.F_Cu,(5.12,5),(6,5),.65);self.assertTrue(witness(p,t,.65))
  t.SetStart(vec((5.4,5)));self.assertFalse(witness(p,t,.65))
  self.assertFalse(witness(p,t,1.5))
 def test_custom_land_rotation_is_geometric_and_unsupported_shapes_stay_conservative(self):
  b=board();p=pad(b,'A','1','rail',(5,5),(.01,.01));p.SetShape(k.PAD_SHAPE_CUSTOM);poly=k.SHAPE_POLY_SET();poly.NewOutline()
  for pt in [(-.18,-.56),(.18,-.56),(.18,.56),(-.18,.56)]:poly.Append(vec(pt))
  p.AddPrimitivePoly(k.F_Cu,poly,0,True);p.SetOrientationDegrees(90)
  self.assertIsNotNone(rectangular_custom_land(p,k.F_Cu));p.SetOrientationDegrees(45);self.assertIsNone(rectangular_custom_land(p,k.F_Cu))
 def test_actual_power_plan_can_use_wider_than_pad_authorized_neck(self):
  b=board();a=pad(b,'A','1','rail',(5,5),(.6,.22));z=pad(b,'Z','1','rail',(12,5),(2,2))
  # A foreign land blocks a full width disk; a .65mm escape remains clear.
  pad(b,'BLOCK','1','other',(4.16,5),(.53,2))
  fab=dict(FAB,neck_loss_budget_w=.01,neck_peak_drop_v=.005)
  records=[dict(ref='A',pads=['1'],net='rail',scope='net',rms_current_a=5,peak_current_a=5,source={}),dict(ref='A',pads=['1'],net='rail',scope='terminal',rms_current_a=5,peak_current_a=5,neck_max_length_mm=.5,source={})]
  r=compile_policy(dict(fab={'track_width_mm':.2,'clearance_mm':.15},net_classes=[dict(name='power',nets=['rail'],width_mm=1.5)]),records,fab)
  b.BuildConnectivity();result=power_plan(b,'rail',a,z,r,Oracle(b,r),(1,1,19,19),.25)
  self.assertEqual(result['status'],'routed');self.assertIn('neck',result);self.assertGreater(result['neck']['width_mm'],.22);self.assertLessEqual(result['neck']['loss_w'],.01)
  keep=[add_track(b,'rail',*t) for t in result['tracks']];b.BuildConnectivity();self.assertTrue(all(snapshot(b,r).values()))
  self.assertEqual(net_policy('rail',r)['outer_width_mm'],1.5)
if __name__=='__main__':unittest.main()
