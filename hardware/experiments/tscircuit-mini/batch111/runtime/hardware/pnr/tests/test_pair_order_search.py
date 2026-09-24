import unittest,time
from unittest.mock import patch
import pcbnew as k
from test_native_electrical import board,rules
from pnr.native_electrical import Oracle,pair_plan
class PairOrderSearchTest(unittest.TestCase):
 def test_trial_reservations_do_not_leak_into_parent(self):
  b=board();r=rules();o=Oracle(b,r);o.reserve_track('other',k.F_Cu,(3,3),(8,3),.2)
  fork=o.fork();fork.reserve_track('other',k.B_Cu,(3,8),(8,8),.2);fork.reserve_via('other',(12,12))
  self.assertFalse(fork.clear('rail',k.F_Cu,(5,2),(5,4),.2));self.assertFalse(o.clear('rail',k.F_Cu,(5,2),(5,4),.2))
  self.assertFalse(fork.clear('rail',k.B_Cu,(5,7),(5,9),.2));self.assertTrue(o.clear('rail',k.B_Cu,(5,7),(5,9),.2))
  self.assertFalse(fork.via('rail',(12,12),.6,.3));self.assertTrue(o.via('rail',(12,12),.6,.3))
 def test_failed_order_does_not_poison_alternate_order(self):
  b=board();r=rules();o=Oracle(b,r,deadline=time.monotonic()+5);deadline=o.deadline;seen=[]
  def candidate(b,pair,r,trial,bounds,pitch,order):
   seen.append(order)
   if order==('p','n'):
    trial.reserve_track('other',k.F_Cu,(3,8),(8,8),.2)
    return dict(status='no_coupled_channel')
   self.assertTrue(trial.clear('rail',k.F_Cu,(5,7),(5,9),.2))
   return dict(status='routed')
  with patch('pnr.native_electrical._pair_plan_order',side_effect=candidate):result=pair_plan(b,{'auxiliary_pairs':[{}]},r,o,(0,0,20,20),.2)
  self.assertEqual(seen,[('p','n'),('n','p')]);self.assertEqual(result['status'],'routed');self.assertEqual(o.deadline,deadline)
