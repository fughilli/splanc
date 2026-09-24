import json,tempfile,unittest
from unittest.mock import patch
from types import SimpleNamespace as NS
import numpy as np
from pnr.graph import BoardGraph,BoardOutline,Component,Pad
from pnr.constraints import compile_constraints
from pnr.place.placer import PlacementReport
from pnr.place.legalize import LegalizationError
from pnr.place.metrics import hard_violations
from pnr.route.feedback import local_feedback_placement,_place_route_loop
from pnr.route.detail.maze import RouteResult,RoutedNet
class PlacementFallback(unittest.TestCase):
    def fixture(self):
        cs=[Component(ref,'generic',(x,5),0,'top',(1,1),(1,1),pads=[Pad('1','N',(0,0),(.2,.2))]) for ref,x in [('FIXED',3),('MOVABLE',6),('LOCKED',9)]]
        cs[2].locked=True;g=BoardGraph('test',cs,[],BoardOutline(20,20));cc=compile_constraints({'board':{'outline':{'w':20,'h':20}},'fixed':{'FIXED':{'at':[3,5]}}},g.refs)
        return g,cc
    def test_fixed_locked_and_source_geometry_survive_local_feedback(self):
        g,cc=self.fixture();before=g.to_json();tried=set();pressure={c.ref:1.5 for c in g.components}
        a=local_feedback_placement(g,cc,{},pressure,tried);self.assertIsNotNone(a)
        moved,report,event=a;self.assertTrue(report.legal);self.assertEqual(event['ref'],'MOVABLE');self.assertFalse(any(hard_violations(moved,cc).values()))
        self.assertEqual(g.to_json(),before);self.assertEqual(moved.component('MOVABLE').courtyard,g.component('MOVABLE').courtyard)
        b=local_feedback_placement(g,cc,{},pressure,tried);self.assertNotEqual(a[2]['position'],b[2]['position'])
    def test_global_legalization_failure_still_runs_next_complete_route(self):
        g,cc=self.fixture();prep=PlacementReport(20,20,10,10)
        calls=[]
        def place(*args,**kwargs):
            calls.append(1)
            if len(calls)==1:return g,prep
            raise LegalizationError('fixture global legalization exhausted')
        results=[NS(deferred_nets=set(),result=RouteResult({'N':RoutedNet('N',remaining_connections=n)},['N'],1)) for n in (4,3)]
        with patch('pnr.route.feedback.place',side_effect=place),patch('pnr.route.detail.router.route_board',side_effect=results) as routing,patch('pnr.route.feedback.detail_congestion',return_value=np.ones((20,20))):
            best,report=_place_route_loop(g,cc,seed=0,iters=1,orient=False,max_rounds=2,gcell_mm=1,track_pitch_mm=.3,route_passes=1,detail_rules={},detail_pitch_mm=.3,detail_iters=1,spread=1)
        self.assertEqual(routing.call_count,2);self.assertEqual(report.connection_history,[4,3]);self.assertEqual(report.best_round,2);self.assertNotEqual(best.component('MOVABLE').pos,g.component('MOVABLE').pos)
if __name__=='__main__':unittest.main()
