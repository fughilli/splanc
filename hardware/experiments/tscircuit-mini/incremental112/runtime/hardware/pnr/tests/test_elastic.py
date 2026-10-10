import unittest
import numpy as np
from pnr.graph import BoardGraph,BoardOutline,Component,Pad,Net
from pnr.constraints import compile_constraints
from pnr.place.elastic import mesh_weights,project_collectively,deform
from pnr.place.metrics import hard_violations

class ElasticTest(unittest.TestCase):
    def test_bilinear_partition_and_affine_motion(self):
        points=np.array([[0,0],[5,5],[10,10],[2,7]])
        weights,nx,ny=mesh_weights(points,10,10,5)
        self.assertTrue(np.allclose(weights.sum(1),1));self.assertTrue(np.all(weights>=0))
        nodes=np.array([[x,y] for x in np.linspace(0,10,nx) for y in np.linspace(0,10,ny)])
        self.assertTrue(np.allclose(weights@nodes,points))

    def fixture(self):
        parts=[Component(ref,'test',(x,5),0,'top',(1,1),(1,1),pads=[Pad('1',net,(.4,0),(.2,.2))]) for ref,x,net in [('A',2,'n1'),('B',3.1,'n2'),('C',4.2,'n3'),('D',8,'n1')]]
        g=BoardGraph('mesh',parts,[Net(n,i,[(r,'1') for r in refs]) for i,(n,refs) in enumerate([('n1',['A','D']),('n2',['B','D']),('n3',['C','D'])])],BoardOutline(12,10))
        cc=compile_constraints({'board':{'outline':{'w':12,'h':10}},'fixed':{'A':{'at':[2,5]}}},g.refs)
        return g,cc

    def test_collective_projection_preserves_anchor_and_relays_displacement(self):
        g,cc=self.fixture();g.component('B').pos=(2.7,5);g.component('C').pos=(3.4,5)
        before=g.to_json();out=project_collectively(g,cc,{'A':(2,5)})
        self.assertEqual(g.to_json(),before);self.assertEqual(out.component('A').pos,(2,5))
        self.assertGreater(out.component('C').pos[0],3.4)
        self.assertFalse(any(hard_violations(out,cc).values()))

    def test_deformation_moves_multiple_parts_without_geometry_changes(self):
        g,cc=self.fixture();before=g.to_json()
        rules={'fab':{'track_width_mm':1.2},'default_clearance_mm':.2}
        outcome=deform(g,cc,rules,{'A':2},iters=110,max_move=2)
        self.assertIsNotNone(outcome);out,report,event=outcome
        self.assertEqual(g.to_json(),before);self.assertTrue(report.legal)
        self.assertGreaterEqual(len(event['moves']),2)
        self.assertEqual(out.component('A').pos,g.component('A').pos)
        for c in out.components:
            old=g.component(c.ref);self.assertEqual(c.pads,old.pads);self.assertEqual(c.rot,old.rot);self.assertEqual(c.courtyard,old.courtyard)


class GrowthTest(unittest.TestCase):
    def test_growth_is_opt_in_bounded_and_requires_stall(self):
        from pnr.place.growth import propose_growth
        self.assertEqual(propose_growth([50,51,52],(70,55),(70,55))[1],'outline_locked')
        self.assertIsNone(propose_growth([50,40,30],(70,55),(70,55),enabled=True)[0])
        size,reason=propose_growth([50,51,52],(70,55),(70,55),enabled=True)
        self.assertEqual(size,(73.5,57.75));self.assertEqual(reason,'stalled_global_routing_demand')
        self.assertIsNone(propose_growth([50,51,52],(77,60.5),(70,55),enabled=True)[0])


class ElasticControllerTest(unittest.TestCase):
    def test_full_loop_uses_collective_moves_and_escalates_after_plateau(self):
        from unittest.mock import patch
        from types import SimpleNamespace as NS
        from pnr.route.feedback import route_and_place
        g,cc=ElasticTest().fixture()
        results=[NS(deferred_nets=set(),result=NS(unrouted=['n1'],nets={'n1':NS(remaining_connections=n)}),failure_sites={'n1':[(2,5)]}) for n in (4,5,3)]
        event=dict(moves={'B':{}},channel_before=4,channel_after=3,strength=1)
        with patch.dict('os.environ',{'PNR_PLACEMENT_MODE':'elastic'}),patch('pnr.route.feedback.place',return_value=(g,NS(legal=True))),patch('pnr.route.detail.router.route_board',side_effect=results),patch('pnr.place.elastic.deform',return_value=(g,NS(legal=True),event)) as mesh:
            placed,report=route_and_place(g,cc,iters=1,max_rounds=3,detail_rules={})
        self.assertEqual(report.connection_history,[4,5,3]);self.assertEqual(report.best_round,3)
        self.assertEqual(mesh.call_count,2)
        self.assertEqual([c.kwargs['strength'] for c in mesh.call_args_list],[1.,1.5])
        self.assertGreater(mesh.call_args_list[1].args[3]['A'],mesh.call_args_list[0].args[3]['A'])

if __name__=='__main__':unittest.main()

