import unittest
from pnr.feedback_boundary import placement_graph
from pnr.phase_budget import PhaseClock
class BoundaryTests(unittest.TestCase):
 def test_generated_mount_removed_but_source_and_physical_locks_retained(self):
  source={'components':[{'ref':'A','locked':False},{'ref':'B','locked':True}]}
  inv={'graph':{'components':[{'ref':'A','locked':True},{'ref':'B','locked':False},{'ref':'hole'}],'nets':[]},'physical_locks':[]}
  out=placement_graph(inv,source,{'mounting_holes':[{'name':'hole'}]})
  self.assertEqual(out['components'],[{'ref':'A','locked':False},{'ref':'B','locked':True}])
  self.assertEqual(len(inv['graph']['components']),3)
  inv['physical_locks']=['A'];self.assertTrue(placement_graph(inv,source,{'mounting_holes':[{'name':'hole'}]})['components'][0]['locked'])
 def test_unknown_native_component_is_not_silently_deleted(self):
  with self.assertRaises(ValueError):placement_graph({'graph':{'components':[{'ref':'unknown'}],'nets':[]}}, {'components':[]},{})
 def test_refinement_has_its_own_budget(self):
  now=[0.];clock=PhaseClock(lambda:now[0]);now[0]=1900.;clock.begin_refinement()
  self.assertEqual(clock.prerequisite_seconds,1900);self.assertEqual(clock.elapsed(),0)
  now[0]+=10;self.assertEqual(clock.elapsed(),10)
if __name__=='__main__':unittest.main()
