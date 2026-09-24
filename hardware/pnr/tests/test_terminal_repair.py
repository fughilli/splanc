import unittest
import pcbnew as k
from test_native_electrical import board,pad
from pnr.native_electrical import add_track
from pnr.terminal_repair import suggest
class TerminalRepairTest(unittest.TestCase):
 def fixture(self,back=False):
  b=board();a=pad(b,'SOURCE','1','p',(5,5),(.2,.8));z=pad(b,'DEST','2','p',(15,15),(.2,.8))
  surface=k.B_Cu if back else k.F_Cu
  if back:
   ls=k.LSET();ls.AddLayer(surface);a.SetLayerSet(ls);z.SetLayerSet(ls)
  track=add_track(b,'other',surface,(4,4.4),(6,4.4),.2);b.BuildConnectivity()
  return b,track,dict(net='p',source='SOURCE.1',target='DEST.2',source_uuid=a.m_Uuid.AsString(),target_uuid=z.m_Uuid.AsString())
 def test_reports_local_copper_without_changing_board(self):
  b,t,target=self.fixture();before=[x.m_Uuid.AsString() for x in b.GetTracks()]
  result=suggest(b,{},target)
  self.assertEqual(result['reopen'],['other']);self.assertEqual(before,[x.m_Uuid.AsString() for x in b.GetTracks()])
 def test_back_surface_and_ref_rename(self):
  b,t,target=self.fixture(True)
  for f in b.GetFootprints():
   if f.GetReference()=='SOURCE':f.SetReference('RENAMED')
  target['source']='RENAMED.1';self.assertEqual(suggest(b,{},target)['reopen'],['other'])
 def test_protected_locked_and_power_blockers_not_displaced(self):
  b,t,target=self.fixture();self.assertEqual(suggest(b,{},target,excluded=['other'])['reopen'],[])
  t.SetLocked(True);self.assertEqual(suggest(b,{},target)['reopen'],[]);t.SetLocked(False)
  rules={'net_classes':[{'name':'power','nets':['other'],'width_mm':1.5}]}
  self.assertEqual(suggest(b,rules,target)['reopen'],[])
 def test_protected_target_not_probed(self):
  b,t,target=self.fixture();rules={'net_classes':[{'name':'power','nets':['p'],'width_mm':1.5}]}
  self.assertEqual(suggest(b,rules,target)['reason'],'protected_target')
if __name__=='__main__':unittest.main()
