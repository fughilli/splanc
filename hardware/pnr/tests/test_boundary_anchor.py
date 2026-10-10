"""Native adapter regression: finite-width contact outside search centerline bounds."""
import importlib.util,json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import pcbnew as k
from test_native_electrical import board,pad
from pnr.native_electrical import vec,add_track

class SearchStarted(Exception):pass
class BoundaryAnchorTest(unittest.TestCase):
 def run_case(self, ymax):
  adapter=Path(__file__).resolve().parents[2]/'tools/keyhole_region.py'
  spec=importlib.util.spec_from_file_location('boundary_adapter',adapter);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  b=board()
  for net in ('scl','sda'):b.Add(k.NETINFO_ITEM(b,net))
  pad(b,'A','1','sda',(2,3),(.5,.5));pad(b,'B','1','sda',(8,3),(.5,.5));pad(b,'C','1','scl',(5,4),(.5,.5))
  t=add_track(b,'scl',k.F_Cu,(5,4),(5,7),.2);identity=t.m_Uuid.AsString()
  v=k.PCB_VIA(b);v.SetNetCode(b.FindNet('scl').GetNetCode());v.SetPosition(vec((4.75,7.25)));v.SetFrontWidth(600000);v.SetDrill(300000);v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetLocked(True);b.Add(v)
  b.BuildConnectivity();self.assertTrue(t.GetEffectiveShape(k.F_Cu).Collide(v.GetEffectiveShape(k.F_Cu),0))
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);pcb=root/'board.kicad_pcb';k.SaveBoard(str(pcb),b);pcb.with_suffix('.kicad_pro').write_text(json.dumps({'net_settings':{'classes':[{'name':'Default','track_width':.2,'clearance':.15}],'netclass_patterns':[]}}));out=root/'out'
   argv=[str(adapter),str(pcb),'--out-dir',str(out),'--net','sda','--net','scl','--source-pad','A.1','--target-pad','B.1','--bounds','1','1','9',str(ymax),'--layers','--joint','--relocate-vias','--kicad-cli','unused']
   def solver(requests,bounds,clear,*args,**kwargs):
    data=json.loads((out/'fixture.json').read_text());retained={u for c in data['retained_components'] for u in c['members']};removed={u for c in data['chains'] for u in c['removed']}
    self.assertFalse(retained & removed)
    if ymax==7:
     self.assertIn(identity,retained);self.assertNotIn(identity,removed)
     missing=next(r for r in requests if r.name=='missing');self.assertFalse(clear(missing,0,(4.5,5),(5.5,5)))
    else:self.assertIn(identity,removed);self.assertNotIn(identity,retained)
    raise SearchStarted()
   with patch('sys.argv',argv),patch.object(m,'solve_joint_region',side_effect=solver):
    with self.assertRaises(SearchStarted):m.main()
 def test_contact_outside_window_retains_whole_component_and_obstacle(self):self.run_case(7)
 def test_same_contact_inside_larger_window_can_be_reopened(self):self.run_case(8)
if __name__=='__main__':unittest.main()
