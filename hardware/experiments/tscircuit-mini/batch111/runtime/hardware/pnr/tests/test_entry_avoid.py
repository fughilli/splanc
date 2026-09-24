import unittest
import pcbnew as k
from test_native_electrical import board,pad,rules,add_track
from pnr.native_electrical import Oracle,power_plan
from pnr.pad_entry import snapshot
from pnr.via_coalesce import partition
class EntryAvoidTest(unittest.TestCase):
 def test_thin_load_branch_avoids_bare_rail_pad_and_joins_full_width_tree(self):
  b=board();a=pad(b,'LOAD','1','rail',(3,5),(.4,.4));middle=pad(b,'CAP','1','rail',(6,5),(1.5,1.5));root=pad(b,'ROOT','1','rail',(10,5));keep=add_track(b,'rail',k.F_Cu,(10,5),(15,5),1.5);b.BuildConnectivity()
  r=rules();r['current_intents'].append(dict(ref='LOAD',pads=['1'],net='rail',scope='terminal',rms_current_a=.01,peak_current_a=.01))
  result=power_plan(b,'rail',a,middle,r,Oracle(b,r),(1,1,19,19),.2)
  self.assertEqual(result['status'],'routed')
  keep2=[add_track(b,'rail',*t) for t in result['tracks']];b.BuildConnectivity()
  self.assertTrue(all(snapshot(b,r).values()))
  self.assertTrue(any(a.m_Uuid.AsString() in g and root.m_Uuid.AsString() in g and middle.m_Uuid.AsString() not in g for g in partition(b)))
if __name__=='__main__':unittest.main()
