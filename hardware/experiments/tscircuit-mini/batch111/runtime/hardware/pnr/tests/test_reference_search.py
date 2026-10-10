import unittest
from pnr.route.detail.coupled import solve_pair
class PairSearchValidation(unittest.TestCase):
 def test_tuned_path_gate_is_obeyed(self):
  args=('p','n',{'p':((0,.2),(10,.2)),'n':((0,-.2),(10,-.2))},(-2,-4,12,4),lambda *x:True,lambda *x:True,.2,.2,.1)
  seen=[]
  def accept(paths):seen.append(paths);return False
  r=solve_pair(*args,max_attempts=1,accept_paths=accept)
  self.assertNotEqual(r['status'],'routed');self.assertTrue(seen);self.assertGreater(r['failures'].get('path_validation',0),0)
  r=solve_pair(*args,max_attempts=1,accept_paths=lambda p:True);self.assertEqual(r['status'],'routed')
if __name__=='__main__':unittest.main()
