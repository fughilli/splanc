import json,tempfile,unittest
from pathlib import Path
from pnr.native_loop import terminal_repair_nets,repair_strategies_exhausted,route_job_key
class TerminalControllerTest(unittest.TestCase):
 def test_no_move_stop_waits_for_all_grid_attempts_and_filters_modes(self):
  target=dict(net='n',source='A.1',target='B.1',mode='signal')
  power=dict(net='p',source='P.1',target='Q.1',mode='power')
  attempts={route_job_key(target):1}
  self.assertFalse(repair_strategies_exhausted([target],attempts))
  attempts[route_job_key(target)]=4
  self.assertTrue(repair_strategies_exhausted([target,power],attempts,'signal'))
  self.assertFalse(repair_strategies_exhausted([target,power],attempts))
 def test_probe_preserves_adapter_output_directory_contract(self):
  with tempfile.TemporaryDirectory() as td:
   route=Path(td)/'route-001';target=dict(net='n',source='A.1',target='B.1')
   calls=[]
   def worker(mode,board,folder,extra):
    calls.append((mode,board,folder));self.assertEqual(json.loads(Path(extra[1]).read_text()),target);self.assertFalse(route.exists());return dict(reopen=['blocker'])
   self.assertEqual(terminal_repair_nets(worker,'board',route,target),['blocker'])
   self.assertEqual(calls[0][:2],('terminal-blockers','board'))
   route.mkdir() # The actual regional adapter must still be able to create it.
if __name__=='__main__':unittest.main()
