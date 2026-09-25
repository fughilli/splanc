import unittest
from pnr.plane_leaf_repair import RepairBudget
class BudgetTest(unittest.TestCase):
 def test_ineligible_footprints_do_not_spend_signal_trials(self):
  b=RepairBudget(max_trials=2)
  for i in range(12):
   self.assertTrue(b.reserve('sha',str(i),'sda'))
   b.record('sha',str(i),dict(status='no_guarded_leaf'))
  self.assertTrue(b.reserve('sha','renamed','scl'))
  self.assertEqual(b.trials,0)
 def test_no_leaf_cache_crosses_nets_but_not_changed_board(self):
  b=RepairBudget();self.assertTrue(b.reserve('a','U','sda'));b.record('a','U',dict(status='no_guarded_leaf'))
  self.assertFalse(b.reserve('a','U','scl'));self.assertTrue(b.reserve('b','U','scl'))
 def test_trial_and_probe_caps_are_independent(self):
  b=RepairBudget(max_trials=1,max_probes=4);self.assertTrue(b.reserve('a','U','sda'));b.record('a','U',dict(leaf=dict(guards_pass=True)))
  self.assertFalse(b.reserve('a','V','scl'))
  b=RepairBudget(max_probes=1);self.assertTrue(b.reserve('a','U','sda'));b.record('a','U',dict(status='worker_error'));self.assertFalse(b.reserve('a','V','sda'))
 def test_failed_signal_counts_but_worker_error_does_not_poison_eligibility(self):
  b=RepairBudget();self.assertTrue(b.reserve('a','U','sda'));b.record('a','U',dict(status='worker_error'));self.assertTrue(b.reserve('a','U','scl'))
  b.record('a','U',dict(status='signal_worker_error',leaf=dict(guards_pass=True)));self.assertEqual(b.trials,1)
  self.assertFalse(b.reserve('a','U','scl'))
if __name__=='__main__':unittest.main()
