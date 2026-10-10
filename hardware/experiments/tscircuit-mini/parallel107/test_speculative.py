import unittest,threading
from pnr.speculative import evaluate_batch
from pnr.merge_additive import additions
class Tests(unittest.TestCase):
 def test_parallel_and_conflict_retry(self):
  barrier=threading.Barrier(2);base=frozenset()
  def propose(job,snapshot):
   self.assertEqual(snapshot,base);barrier.wait(timeout=3);return {job['cell']}
  def commit(job,snapshot,current,proposal):return None if current&proposal else current|proposal
  jobs=[dict(cell=1),dict(cell=1)]
  state,accepted,retry,events=evaluate_batch(jobs,base,propose,commit)
  self.assertEqual(state,{1});self.assertEqual(len(accepted),1);self.assertEqual(len(retry),1)
 def test_disjoint_fusion(self):
  state,accepted,retry,_=evaluate_batch([1,2],frozenset(),lambda j,s:{j},lambda j,b,c,p:c|p)
  self.assertEqual(state,{1,2});self.assertEqual(accepted,[1,2]);self.assertFalse(retry)
 def test_fail_closed(self):
  for proposal,current in [({}, {'a':1}),({'a':2},{'a':1}),({'a':1},{'a':2}),({'a':1,'b':2},{'a':1,'b':3})]:
   with self.assertRaises(ValueError):additions({'a':1},proposal,current)
  self.assertEqual(additions({'a':1},{'a':1,'b':2},{'a':1,'c':3}),['b'])
if __name__=='__main__':unittest.main()
