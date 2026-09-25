"""Exercise native owner lifetimes through process teardown, not just planning."""
import json,os,subprocess,sys,tempfile,unittest
from pathlib import Path
import pcbnew as k
from test_plane_leaf import PlaneLeafTest
from pnr.native_electrical import vec
class NativeLifecycleTest(unittest.TestCase):
 def test_shared_leaf_worker_exits_cleanly_and_preserves_partition(self):
  b,p,v,tracks,rules=PlaneLeafTest().fixture(shared=True)
  zone=k.ZONE(b);zone.SetLayer(k.In1_Cu);zone.SetNetCode(p.GetNetCode());outline=zone.Outline();outline.NewOutline()
  for xy in [(1,1),(19,1),(19,19),(1,19)]:outline.Append(vec(xy))
  b.Add(zone);zone.thisown=False;k.ZONE_FILLER(b).Fill(b.Zones());b.BuildConnectivity()
  with tempfile.TemporaryDirectory(prefix='plane-leaf-lifecycle-') as tmp:
   root=Path(tmp);seed=root/'seed.kicad_pcb';k.SaveBoard(str(seed),b);seed.with_suffix('.kicad_pro').write_text('{}');rp=root/'rules.json';rp.write_text(json.dumps(rules))
   env=dict(os.environ);env.pop('PNR_DRC_SERVICE',None)
   for index in range(2):
    out=root/str(index);command=[sys.executable,'-m','pnr.plane_leaf',str(seed),'--rules',str(rp),'--focus','RENAMED','--out-dir',str(out)]
    run=subprocess.run(command,env=env,capture_output=True,text=True,timeout=90)
    self.assertEqual(run.returncode,0,run.stdout+run.stderr)
    result=json.loads((out/'result.json').read_text());self.assertEqual(result['added_vias'],1);self.assertTrue(result['guards_pass']);self.assertTrue(result['checks']['preserved']);self.assertEqual(result['checks']['lost_pad_entries'],[])
if __name__=='__main__':unittest.main()
