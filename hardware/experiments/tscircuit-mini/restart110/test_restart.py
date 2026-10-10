import unittest,tempfile,json,sys,subprocess,uuid,hashlib
from pathlib import Path
sys.path.insert(0,str(Path('hardware/tools/pnr_live').resolve()))
from settings import seed,save
from pnr.runtime_controls import DEFAULTS
from broker import archive,stop_tree,launch_spec
class Tests(unittest.TestCase):
 def test_preferences_survive_new_run_and_service_reload(self):
  with tempfile.TemporaryDirectory() as tmp:
   r=Path(tmp);prefs=r/'settings.json';a=r/'a/control.json';b=r/'b/control.json'
   old=seed(a,prefs);values=dict(DEFAULTS,route_workers=3)
   new=save(a,prefs,values,old['revision'],'boundary');self.assertEqual(new['restart_epoch'],0)
   self.assertEqual(seed(b,prefs)['values'],values)
   self.assertEqual(seed(a,prefs)['values'],values)
   newer=save(a,prefs,values,new['revision'],'restart_round');self.assertEqual(newer['restart_epoch'],1)
   with self.assertRaises(ValueError):save(a,prefs,DEFAULTS,new['revision'],'restart_round')
 def test_staged_runtime_fails_closed_on_mutation(self):
  with tempfile.TemporaryDirectory() as tmp:
   root=Path(tmp);driver=root/'driver.py';wrapper=root/'wrapper.py'
   driver.write_text('driver');wrapper.write_text('wrapper')
   spec=dict(driver=str(driver),wrapper=str(wrapper),files={str(p):hashlib.sha256(p.read_bytes()).hexdigest() for p in (driver,wrapper)})
   (root/'next-controller.json').write_text(json.dumps(spec));self.assertEqual(launch_spec(root),spec)
   driver.write_text('changed')
   with self.assertRaises(ValueError):launch_spec(root)
 def test_archive_only_unfinished_round(self):
  with tempfile.TemporaryDirectory() as tmp:
   r=Path(tmp);done=r/'relocation/round-01';partial=r/'relocation/round-02';done.mkdir(parents=True);partial.mkdir();(done/'result.json').write_text('{}');(partial/'candidate.pcb').write_text('evidence')
   dest=archive(r,1);self.assertTrue(done.exists());self.assertFalse(partial.exists());self.assertEqual((dest/'round-02/candidate.pcb').read_text(),'evidence')
 def test_stop_only_owned_process(self):
  token='pnr-test-'+uuid.uuid4().hex;p=subprocess.Popen([sys.executable,'-c','import time;time.sleep(300)',token])
  try:
   with self.assertRaises(RuntimeError):stop_tree(p.pid,'wrong-controller')
   self.assertIsNone(p.poll());stop_tree(p.pid,token);self.assertIsNotNone(p.wait(timeout=5))
  finally:
   if p.poll() is None:p.kill();p.wait()
if __name__=='__main__':unittest.main()
