import unittest
from pnr.batch_validate import evaluate
class Tests(unittest.TestCase):
 def test_one_validation_for_disjoint_batch(self):
  calls=[]
  def validate(current,items):calls.append(len(items));return current|{j for j,p in items}
  current,accepted,retry,report=evaluate([1,2,3,4],frozenset(),lambda j,b:dict(proposal_ready=True,accepted=False),validate,4)
  self.assertEqual(current,{1,2,3,4});self.assertEqual(calls,[4]);self.assertFalse(retry);self.assertEqual(report['validation_attempts'],1)
 def test_crossing_isolated_against_accepted_prefix(self):
  def validate(current,items):
   jobs=[j for j,p in items]
   if len(current)+len(jobs)>1:return None
   return current|set(jobs)
  current,accepted,retry,report=evaluate([1,2],frozenset(),lambda j,b:dict(proposal_ready=True),validate)
  self.assertEqual(current,{1});self.assertEqual(accepted,[1]);self.assertEqual(retry,[2]);self.assertEqual(report['validation_attempts'],3)
 def test_error_never_commits_unvalidated_work(self):
  def validate(current,items):raise RuntimeError('DRC unavailable')
  state,accepted,retry,report=evaluate([1,2],frozenset(),lambda j,b:dict(proposal_ready=True),validate)
  self.assertFalse(state);self.assertFalse(accepted);self.assertEqual(retry,[1,2])
 def test_legacy_accepted_not_proposal_ready(self):
  state,accepted,retry,report=evaluate([1],0,lambda j,b:dict(accepted=True),lambda c,p:1)
  self.assertEqual(state,0);self.assertEqual(report['validation_attempts'],0);self.assertEqual(retry,[1])
if __name__=='__main__':unittest.main()
