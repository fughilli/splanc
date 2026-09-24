import unittest
import numpy as np
from pnr.place.relocate import distance_field,propose
from pnr.graph import BoardGraph,BoardOutline,Component,Pad,Net
from pnr.constraints import compile_constraints

class LayeredCostTests(unittest.TestCase):
 def test_crossing_uses_other_layer(self):
  blocked=np.zeros((2,5,9),bool);via=np.ones((5,9),bool);copper=np.zeros((2,5,9));copper[0,:,4]=1
  dist=distance_field(blocked,via,copper,[(0,2,0)],1)
  self.assertEqual(dist[0,2,8],14) # 8 mm + two 3 mm transitions
 def test_no_aperture_is_expensive(self):
  blocked=np.zeros((2,5,9),bool);copper=np.zeros((2,5,9));copper[0,:,4]=1
  dist=distance_field(blocked,np.zeros((5,9),bool),copper,[(0,2,0)],1)
  self.assertGreater(dist[0,2,8],100)
 def test_all_layers_blocked_cannot_teleport(self):
  blocked=np.zeros((2,5,9),bool);blocked[:,:,4]=True
  dist=distance_field(blocked,np.ones((5,9),bool),np.zeros(blocked.shape),[(0,2,0)],1)
  self.assertTrue(np.isinf(dist[0,2,8]))
 def test_whole_board_move_and_anchor(self):
  a=Component('A','', (3,3),0,'top',(1,1),(1,1),pads=[Pad('1','n',(0,0),(.4,.4))])
  b=Component('B','',(24,16),0,'top',(1,1),(1,1),pads=[Pad('1','n',(0,0),(.4,.4))])
  g=BoardGraph('t',[a,b],[Net('n',1,[('A','1'),('B','1')])],BoardOutline(30,20))
  cc=compile_constraints({'fixed':{'B':{'at':[24,16]}},'board':{'outline':{'w':30,'h':20}}},g.refs)
  result=propose(g,cc,{},[],pitch=1.,max_parts=1)
  self.assertIsNotNone(result)
  new,report,event=result
  self.assertTrue(report.legal);self.assertEqual(new.component('B').pos,b.pos)
  self.assertGreater(event['moves'][0]['distance_mm'],10)
  self.assertEqual(g.component('A').pos,(3,3))
  self.assertLess(event['cost_after'],event['cost_before'])
  g.component('A').locked=True
  self.assertIsNone(propose(g,cc,{},[]))

 def test_hard_relative_group_survives_global_search(self):
  a=Component('A','',(3,3),0,'bottom',(1,1),(1,1),pads=[Pad('1','n',(0,0),(.4,.4))])
  b=Component('B','',(24,16),0,'top',(1,1),(1,1),pads=[Pad('1','n',(0,0),(.4,.4))])
  c=Component('C','',(4,3),0,'top',(1,1),(1,1))
  g=BoardGraph('t',[a,b,c],[Net('n',1,[('A','1'),('B','1')])],BoardOutline(30,20))
  cc=compile_constraints({'fixed':{'B':{'at':[24,16]},'C':{'at':[4,3]}},'group':[{'members':['A'],'anchor':'C','radius_mm':4,'hard':True}],'board':{'outline':{'w':30,'h':20}}},g.refs)
  outcome=propose(g,cc,{},[],pitch=1.)
  self.assertIsNotNone(outcome)
  new,report,event=outcome
  import math
  self.assertLessEqual(math.dist(new.component('A').pos,c.pos),4)
  self.assertEqual(new.component('A').side,'bottom')
  self.assertEqual(new.component('A').rot,0)
  self.assertTrue(report.legal)

class ControllerTests(unittest.TestCase):
 def test_loop_reroutes_proposal_and_retains_best(self):
  from unittest.mock import patch
  from types import SimpleNamespace as NS
  from pnr.route.feedback import route_and_place
  g=BoardGraph('t',[Component('A','',(2,5),0,'top',(1,1),(1,1),pads=[Pad('1','n1',(0,0),(.2,.2))])],[Net('n1',1,[('A','1')])],BoardOutline(12,10))
  cc=compile_constraints({'board':{'outline':{'w':12,'h':10}}},g.refs)
  results=[NS(tracks=[('n1','F.Cu',(1,1),(2,2),.2)],vias=[],deferred_nets=set(),result=NS(unrouted=['n1'],nets={'n1':NS(remaining_connections=n)}),failure_sites={'n1':[(2,5)]}) for n in (4,5,3)]
  with patch.dict('os.environ',{'PNR_PLACEMENT_MODE':'relocate'}),patch('pnr.route.feedback.place',return_value=(g,NS(legal=True))) as initial,patch('pnr.route.detail.router.route_board',side_effect=results),patch('pnr.place.relocate.propose',return_value=(g,NS(legal=True),dict(moves=[]))) as relocation:
   _,report=route_and_place(g,cc,iters=1,max_rounds=3,detail_rules={})
  self.assertEqual(report.connection_history,[4,5,3]);self.assertEqual(report.best_round,3)
  self.assertEqual(initial.call_count,1);self.assertEqual(relocation.call_count,2)
  self.assertEqual(relocation.call_args_list[1].args[3],results[1].tracks)

class AnnealingTests(unittest.TestCase):
 def test_sampling_reproducible_and_cools(self):
  import random
  from pnr.place.anneal import choose_cost
  a=random.Random(19);b=random.Random(19)
  seq=[choose_cost([0.,.02,.08],.1,a) for _ in range(100)]
  self.assertEqual(seq,[choose_cost([0.,.02,.08],.1,b) for _ in range(100)])
  self.assertEqual(set(seq),{0,1,2})
  self.assertEqual(choose_cost([2,1,3],0,a),1)
 def test_plateau_requires_cold_window_and_resets_on_gain(self):
  from pnr.place.anneal import Plateau
  p=Plateau(warmup=3,patience=3)
  for value in [10,10,10,10,10]:p.observe(value)
  self.assertFalse(p.reached)
  p.observe(9)
  self.assertEqual(p.cold_stale,0)
  for _ in range(3):p.observe(9)
  self.assertTrue(p.reached)
  self.assertEqual(p.temperature,0)

if __name__=='__main__':unittest.main()
