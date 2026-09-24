import unittest
import pcbnew as k
from test_native_electrical import board,pad,FAB
from pnr.native_electrical import add_track
from pnr.pad_entry import neck_witness
from pnr.electrical import compile_policy

class LandNeckTest(unittest.TestCase):
 def setup_neck(self,origin=(5.8,5),angle=0):
  b=board();p=pad(b,'A','1','rail',(5,5),(2,.4));p.SetOrientationDegrees(angle)
  a,z=(origin,(origin[0]+.3,origin[1])) if not angle else (origin,(origin[0],origin[1]-.3))
  t=add_track(b,'rail',k.F_Cu,a,z,.4);feed=add_track(b,'rail',k.F_Cu,z,(z[0]+2,z[1]),1.5)
  record=dict(ref='A',pads=['1'],net='rail',scope='terminal',rms_current_a=4,peak_current_a=5,neck_max_length_mm=.5,source={})
  rules=compile_policy(dict(fab={'track_width_mm':.2},net_classes=[]),[record],dict(FAB,neck_loss_budget_w=.01,neck_peak_drop_v=.005))
  return b,p,t,feed,rules
 def test_full_land_entry_away_from_center(self):
  b,p,t,feed,r=self.setup_neck();self.assertTrue(neck_witness(p,t,1.5,[t,feed],r))
 def test_rotated_full_land_entry(self):
  b,p,t,feed,r=self.setup_neck((5,4.2),90);self.assertTrue(neck_witness(p,t,1.5,[t,feed],r))
 def test_corner_graze_is_not_a_land_entry(self):
  b,p,t,feed,r=self.setup_neck((5.95,5));self.assertFalse(neck_witness(p,t,1.5,[t,feed],r))
 def test_missing_full_current_feed(self):
  b,p,t,feed,r=self.setup_neck();feed.SetWidth(300000);self.assertFalse(neck_witness(p,t,1.5,[t,feed],r))
 def test_missing_source_authorization(self):
  b,p,t,feed,r=self.setup_neck();r['current_intents']=[];self.assertFalse(neck_witness(p,t,1.5,[t,feed],r))
 def test_loss_budget_not_waived(self):
  b,p,t,feed,r=self.setup_neck();r['electrical_fab']['neck_loss_budget_w']=.001;self.assertFalse(neck_witness(p,t,1.5,[t,feed],r))
if __name__=='__main__':unittest.main()
