import unittest
from unittest.mock import patch
from types import SimpleNamespace
import numpy as np
from pnr.route.detail.grid import Cell,RouteGrid
from pnr.route.detail.maze import route,remaining_connections,RoutedNet,RouteResult
from pnr.route.feedback import _place_route_loop
from pnr.graph import BoardGraph
from pnr.constraints import compile_constraints
class ScoreTest(unittest.TestCase):
 def test_partial_forest_counts_terminals(self):
  g=RouteGrid(6,6,1,layers=('F.Cu',));g.pad_net[(0,5,5)]='OTHER'
  result=route(g,{'N':[Cell(0,0,0),Cell(0,2,0),Cell(0,5,5)]},rrr_rounds=1,max_iters=1)
  self.assertEqual(result.nets['N'].remaining_connections,1);self.assertFalse(result.fully_routed)
 def test_no_inferred_layer_or_adjacent_connection(self):
  a,b,c,d=Cell(0,0,0),Cell(0,1,0),Cell(1,0,0),Cell(1,0,1)
  self.assertEqual(remaining_connections([a,b,c,d],[(a,b),(c,d)]),1)
  self.assertEqual(remaining_connections([a,b,c,d],[(a,b),(c,d),(a,c)]),0)
  self.assertEqual(remaining_connections([a,b],[]),1)
 def test_feedback_rewards_partial_improvement_and_resets_stale(self):
  graph=BoardGraph('test',[],[]);constraints=compile_constraints({'board':{'outline':{'w':10,'h':10}}},[])
  candidates=[BoardGraph('round'+str(i),[],[]) for i in range(4)]
  results=[SimpleNamespace(deferred_nets={'power'},result=RouteResult({'N':RoutedNet('N',remaining_connections=n),'power':RoutedNet('power')},['N','power'],1)) for n in [4,3,2,2]]
  with patch('pnr.route.feedback.place',side_effect=[(g,SimpleNamespace(legal=True)) for g in candidates]),patch('pnr.route.detail.router.route_board',side_effect=results),patch('pnr.route.feedback.detail_congestion',return_value=np.zeros((10,10))):
   best,report=_place_route_loop(graph,constraints,seed=0,iters=1,orient=False,max_rounds=4,gcell_mm=1,track_pitch_mm=.3,route_passes=1,detail_rules={},detail_pitch_mm=.3,detail_iters=1,spread=1)
  self.assertIs(best,candidates[2]);self.assertEqual(report.best_round,3);self.assertEqual(report.connection_history,[4,3,2,2]);self.assertEqual(report.overflow_history,[1,1,1,1]);self.assertFalse(report.converged)

import unittest
from collections import defaultdict
from pnr.route.detail.grid import RouteGrid,Cell
from pnr.route.detail.maze import _route_one,route,remaining_connections
class PartialNegotiationTest(unittest.TestCase):
 def test_negotiation_retains_usable_branch_with_blocked_first_terminal(self):
  g=RouteGrid(6,4,.5);g.pad_net[(0,1,1)]='OTHER'
  terminals=[Cell(0,1,1),Cell(0,4,1),Cell(0,7,1)]
  branch=_route_one(g,terminals,'A',defaultdict(int),defaultdict(float),3,.5)
  self.assertIsNotNone(branch);self.assertEqual(remaining_connections(terminals,branch.edges),1)
  r=route(g,{'A':terminals},max_iters=2,rrr_rounds=2)
  self.assertEqual(r.unrouted,['A']);self.assertFalse(r.nets['A'].routed)
  self.assertEqual(r.nets['A'].remaining_connections,1);self.assertTrue(r.nets['A'].segments)


if __name__=='__main__':unittest.main()
