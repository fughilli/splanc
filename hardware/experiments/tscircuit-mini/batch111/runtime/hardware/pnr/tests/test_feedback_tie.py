import unittest
from unittest.mock import patch
from types import SimpleNamespace as NS
from pnr.graph import BoardGraph,BoardOutline,Component
from pnr.constraints import compile_constraints
from pnr.route.feedback import route_and_place
class FeedbackTieTest(unittest.TestCase):
 def test_fewer_incomplete_nets_breaks_equal_missing_connections_and_resets_stale(self):
  g=BoardGraph('tie',[Component('A','',(5,5),0,'top',(1,1),(1,1))],[],BoardOutline(20,20));c=compile_constraints({'board':{'outline':{'w':20,'h':20}}},g.refs)
  results=[]
  for nets,missing in [(32,52),(28,52),(29,57)]:
   names=['n'+str(i) for i in range(nets)];counts={n:NS(remaining_connections=1+(missing-nets if i==0 else 0)) for i,n in enumerate(names)}
   results.append(NS(deferred_nets=set(),result=NS(unrouted=names,nets=counts),failure_sites={}))
  with patch('pnr.route.feedback.place',return_value=(g,NS(legal=True))),patch('pnr.route.detail.router.route_board',side_effect=results):
   placed,report=route_and_place(g,c,max_rounds=3,iters=1,detail_rules={})
  self.assertEqual(report.best_round,2);self.assertIs(report.detail_result,results[1]);self.assertEqual(report.termination,'round_limit')

if __name__ == "__main__":
    unittest.main()
