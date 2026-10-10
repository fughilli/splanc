import unittest
import pcbnew as k
from test_native_electrical import board,pad,FAB
from pnr.electrical import compile_policy
from pnr.native_electrical import Oracle,power_plan,add_track
from pnr.pad_entry import snapshot

class PowerTreeRootsTest(unittest.TestCase):
 def fixture(self,sense_root=False):
  b=board();a=pad(b,'A','1','rail',(5,5),(.4,2));x=pad(b,'X','1','rail',(8,5),(.4,.4));z=pad(b,'Z','1','rail',(14,5),(2,2))
  # X is the nearest disconnected power terminal, but it has no full-width exit.
  for i,(dx,dy) in enumerate(((.6,0),(-.6,0),(0,.6),(0,-.6))):pad(b,'B'+str(i),'1','other',(8+dx,5+dy),(.4,.4))
  pad(b,'LEFT','1','other',(4.16,5),(.53,2))
  records=[dict(ref='A',pads=['1'],net='rail',scope='net',rms_current_a=4,peak_current_a=5,source={}),dict(ref='A',pads=['1'],net='rail',scope='terminal',rms_current_a=4,peak_current_a=5,neck_max_length_mm=.5,source={})]
  if sense_root:records.append(dict(ref='Z',pads=['1'],net='rail',scope='terminal',rms_current_a=.01,peak_current_a=.01,source={}))
  r=compile_policy(dict(fab={'track_width_mm':.2,'clearance_mm':.15},net_classes=[dict(name='power',nets=['rail'],width_mm=1.5)]),records,dict(FAB,neck_loss_budget_w=.01,neck_peak_drop_v=.005));b.BuildConnectivity();return b,a,x,z,r
 def test_other_full_current_pad_can_root_tree_with_qualified_landing(self):
  b,a,x,z,r=self.fixture();p=power_plan(b,'rail',a,x,r,Oracle(b,r),(1,1,19,19),.25)
  self.assertEqual(p['status'],'routed');self.assertIn('root_landing',p);self.assertGreaterEqual(p['root_landing'][3],1.5)
  for t in p['tracks']:add_track(b,'rail',*t)
  self.assertEqual(p['banks'],[]);b.BuildConnectivity();self.assertTrue(all(snapshot(b,r).values()))
  connected={t.m_Uuid.AsString() for t in b.GetConnectivity().GetConnectedItems(a)}
  self.assertIn(z.m_Uuid.AsString(),connected);self.assertNotIn(x.m_Uuid.AsString(),connected)
 def test_explicit_low_current_terminal_cannot_root_shared_power_tree(self):
  b,a,x,z,r=self.fixture(True);p=power_plan(b,'rail',a,x,r,Oracle(b,r),(1,1,19,19),.25)
  self.assertNotEqual(p['status'],'routed')
if __name__=='__main__':unittest.main()
