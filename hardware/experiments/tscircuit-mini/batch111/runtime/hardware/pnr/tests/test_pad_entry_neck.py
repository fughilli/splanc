import copy,unittest
import pcbnew as k
from test_native_electrical import board,pad,FAB
from pnr.native_electrical import add_track
from pnr.electrical import compile_policy
from pnr.pad_entry import snapshot,repair_changed_entries
from pnr.pad_entry_neck import repair_neck
class PadEntryNeckTest(unittest.TestCase):
 def fixture(self):
  b=board();ps=[pad(b,'A',str(i+1),'rail',(5+i*.65,5),(.4,.45)) for i in range(3)]
  pad(b,'A','7','other',(5.65,4.02),(1,1))
  records=[dict(ref='A',pads=['1','2','3'],net='rail',scope='terminal',rms_current_a=5,peak_current_a=5,neck_max_length_mm=.5,source={})]
  r=compile_policy({'fab':{'track_width_mm':.2,'clearance_mm':.15},'net_classes':[{'nets':['rail'],'width_mm':1.2}]},records,FAB)
  w=r['electrical_nets']['rail']['outer_width_mm'] if 'rail' in r.get('electrical_nets',{}) else 1.1922682420297217
  keep=[add_track(b,'rail',k.F_Cu,(5.65,5.35),(6.8,5.35),w),add_track(b,'rail',k.F_Cu,(5.65,5),(5.65,5.35),.65)];b.BuildConnectivity()
  return b,ps,r,keep,w
 def test_completes_grazing_neighbors_with_full_current_necks(self):
  b,ps,r,keep,w=self.fixture();self.assertFalse(all(snapshot(b,r).values()))
  result=repair_changed_entries(b,r,{})
  self.assertFalse(result['new_bad_entries']);self.assertTrue(all(snapshot(b,r).values()))
  necks=[x['source_neck'] for x in result['entry_repairs']['added'] if 'source_neck' in x];self.assertTrue(necks)
  self.assertTrue(all(x['budget']['loss_w']<=FAB['neck_loss_budget_w'] for x in necks))
 def test_missing_authorization_and_tight_loss_budget_add_nothing(self):
  for unauthorized in [True,False]:
   b,ps,r,keep,w=self.fixture()
   if unauthorized:r['current_intents']=[]
   else:r['electrical_fab']['neck_loss_budget_w']=.001
   count=len(list(b.GetTracks()));self.assertIsNone(repair_neck(b,ps[0],k.F_Cu,[keep[0]],w,r));self.assertEqual(len(list(b.GetTracks())),count)
 def test_bootstrap_land_keeps_full_switch_envelope_at_short_escape(self):
  # Reproduces a small capacitor grazed by a wide switch trunk. The other
  # capacitor land prevents a full-width center branch; source permits 0.25mm.
  from pnr.pad_entry import repair
  from pnr.electrical import terminal_policy,neck_budget
  b=board();p=pad(b,'C','2','rail',(5,5),(.54,.5))
  pad(b,'C','1','other',(5,4.175),(.54,.5))
  records=[dict(ref='C',pads=['2'],net='rail',scope='terminal',rms_current_a=5,peak_current_a=16,neck_max_length_mm=.25,source={})]
  r=compile_policy({'fab':{'track_width_mm':.2,'clearance_mm':.15},'net_classes':[{'nets':['rail'],'width_mm':1.5}]},records,FAB)
  add_track(b,'rail',k.F_Cu,(4.647861,5.602139),(4.2,6.05),1.5)
  add_track(b,'rail',k.F_Cu,(4.2,6.13),(4.525,5.805),1.5)
  b.BuildConnectivity();self.assertFalse(all(snapshot(b,r).values()))
  result=repair(b,r);self.assertFalse(result['blocked']);self.assertTrue(all(snapshot(b,r).values()))
  neck=result['added'][0]['source_neck'];self.assertLessEqual(neck['budget']['length_mm'],.25)
  policy=terminal_policy('C',['2'],'rail',r)
  self.assertEqual((policy['rms_current_a'],policy['peak_current_a']),(5,16))
  self.assertIsNone(neck_budget(policy,.5,.251,r['electrical_fab']))
  self.assertTrue(any(t.GetWidth()==1500000 for t in b.GetTracks()))
if __name__=='__main__':unittest.main()
