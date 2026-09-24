"""Initial exploration must vary the whole layout and preserve hard source rules."""
import copy
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import patch

from pnr.constraints import compile_constraints
from pnr.graph import BoardGraph, BoardOutline, Component, Net, Pad
from pnr.place.initial_pool import (InitialPoolConfig, initial_starts, preserve_source_locks,
    select_initial_placement, diverse_shortlist, pose_distance)
from pnr.place.model import global_place
from pnr.place.placer import PlacementReport
from pnr.route.detail.maze import RouteResult, RoutedNet


def fixture():
    components = [Component(ref,'test',(x,y),rot,'top',(1,1),(1,1),locked=locked,
                  pads=[Pad('1','N',(0,0),(.3,.3))],smd_body=True)
                  for ref,x,y,rot,locked in [('FIXED',2,2,0,False),('LOCKED',15,12,90,True),
                                            ('A',7,5,0,False),('B',10,8,0,False)]]
    graph = BoardGraph('pool',components,[Net('N',1,[(c.ref,'1') for c in components])],BoardOutline(20,16))
    constraints = compile_constraints({'board':{'outline':{'w':20,'h':16}},
                                      'fixed':{'FIXED':{'at':[2,2],'rot':0}}},graph.refs)
    return graph,constraints


class InitialStartsTest(unittest.TestCase):
    def test_explicit_starts_cover_board_and_are_reproducible(self):
        graph,constraints = fixture();before=graph.to_json()
        starts=initial_starts(graph,constraints,InitialPoolConfig(),seed=118)
        self.assertEqual(starts,initial_starts(graph,constraints,InitialPoolConfig(),seed=118))
        self.assertEqual(len(starts),8)
        self.assertEqual(starts[0]['kind'],'legacy-global')
        self.assertEqual(starts[1]['positions']['A'],[7,5])
        self.assertEqual(graph.to_json(),before)
        points=[s['positions']['A'] for s in starts[2:]]
        self.assertGreater(max(p[0] for p in points)-min(p[0] for p in points),8)
        self.assertGreater(max(p[1] for p in points)-min(p[1] for p in points),6)
        self.assertTrue(all('LOCKED' not in s['positions'] and 'FIXED' not in s['positions'] for s in starts[1:]))
        self.assertGreater(len({s['rotations']['A'] for s in starts[2:]}),1)

    def test_global_optimizer_uses_explicit_centres_and_rotation_logits(self):
        graph,constraints=fixture()
        constraints=preserve_source_locks(graph,constraints)
        positions,rotations=global_place(graph,constraints,20,16,iters=0,seed=0,
                       initial_positions={'A':(16,3),'B':(4,12),'FIXED':(10,10)},
                       initial_rotations={'A':180,'B':90})
        self.assertEqual(positions['A'],(16,3))
        self.assertEqual(positions['B'],(4,12))
        self.assertEqual(positions['FIXED'],(2,2))
        self.assertEqual(positions['LOCKED'],(15,12))
        self.assertEqual(rotations['A'],180)
        self.assertEqual(rotations['B'],90)
        self.assertEqual(rotations['LOCKED'],90)

    def test_locks_are_added_locally_without_overriding_authored_fixed_pose(self):
        graph,constraints=fixture();graph.component('FIXED').locked=True
        new=preserve_source_locks(graph,constraints)
        self.assertNotIn('LOCKED',constraints.locked_refs)
        self.assertIn('LOCKED',new.locked_refs)
        self.assertEqual(len([c for c in new.constraints if 'FIXED' in c.refs]),1)

    def test_hard_bottom_side_releases_xy_and_preserves_mirrored_pad_geometry(self):
        from pnr.place.placer import place
        from pnr.place.metrics import hard_violations
        from pnr.constraints import ConstraintError
        graph,_=fixture();graph.component('A').pads[0].offset=(.2,.4)
        constraints=compile_constraints({'board':{'outline':{'w':20,'h':16}},
                    'side':{'bottom':['@board.pogo']}},graph.refs,{'board.pogo':'A'})
        self.assertNotIn('A',constraints.locked_refs)
        self.assertIn('A',hard_violations(graph,constraints)['side_misplaced'])
        placed,report=place(graph,constraints,iters=0,initial_positions={
                            'FIXED':(2,2),'LOCKED':(15,12),'A':(16,3),'B':(4,12)},
                            initial_rotations={'A':0},orient=False)
        self.assertTrue(report.legal)
        self.assertEqual(placed.component('A').side,'bottom')
        self.assertEqual(placed.component('A').pads[0].offset,(.2,-.4))
        self.assertEqual(placed.component('A').pads[0].net,'N')
        self.assertGreater(abs(placed.component('A').pos[0]-graph.component('A').pos[0]),5)
        self.assertFalse(any(hard_violations(placed,constraints).values()))
        with self.assertRaises(ConstraintError):
            compile_constraints({'side':{'bottom':['A'],'top':['A']}},graph.refs)
        with self.assertRaises(ConstraintError):
            compile_constraints({'fixed':{'A':{'at':[1,1],'side':'top'}},
                                 'side':{'bottom':['A']}},graph.refs)

    def test_shortlist_preserves_reference_and_distant_orientation_basin(self):
        graph,constraints=fixture();candidates=[]
        for index,(xy,cost,rot) in enumerate([((7,5),100,0),((7.1,5),1,0),((7.2,5),2,0),((17,3),5,90)]):
            g=copy.deepcopy(graph);g.component('A').pos=xy;g.component('A').rot=rot
            candidates.append(dict(id=str(index),graph=g,cost=cost))
        selected=diverse_shortlist(candidates,3,'cost',mandatory=['0'],refs=['A','B'])
        self.assertEqual([c['id'] for c in selected],['0','1','3'])
        self.assertGreater(pose_distance(selected[0]['graph'],selected[2]['graph'],['A']),.4)

    def test_opposite_body_basin_reserves_a_topological_alternative(self):
        host=Component('RADIO','module',(10,10),0,'top',(10,12),(10,12),
                       pads=[],smd_body=True)
        pogo=Component('PAD_ARRAY','test',(3,3),0,'bottom',(3,4),(3,4),
                       pads=[Pad(str(i),'N',(i*.1,0),(.2,.2)) for i in range(8)],smd_body=True)
        graph=BoardGraph('basin',[host,pogo],[],BoardOutline(24,22))
        constraints=compile_constraints({'board':{'outline':{'w':24,'h':22}},
            'fixed':{'RADIO':{'at':[10,10],'side':'top'}},
            'side':{'bottom':['PAD_ARRAY']}},graph.refs)
        starts=initial_starts(graph,constraints,InitialPoolConfig(),seed=9)
        self.assertEqual(starts[2]['kind'],'opposite-body-global')
        self.assertEqual(starts[2]['basin_anchors'][0]['at'],[10,10])
        self.assertNotIn('PAD_ARRAY',constraints.locked_refs)
        # A non-SMD through-hole body owns both surfaces and cannot host it.
        host.smd_body=False;host.pads=[Pad('1','N',(0,0),(1,1),through_hole=True)]
        starts=initial_starts(graph,constraints,InitialPoolConfig(),seed=9)
        self.assertFalse(any('basin_anchors' in start for start in starts))

    def test_under_body_basin_survives_unrelated_global_legalization_failure(self):
        from pnr.place.legalize import LegalizationError
        host=Component('H','module',(10,10),0,'top',(10,12),(10,12),pads=[],smd_body=True)
        pogo=Component('P','test',(3,3),0,'bottom',(3,4),(3,4),
            pads=[Pad(str(i),'N',(i*.1,0),(.2,.2)) for i in range(8)],smd_body=True)
        graph=BoardGraph('basin',[host,pogo],[],BoardOutline(24,22))
        constraints=compile_constraints({'board':{'outline':{'w':24,'h':22}},
            'fixed':{'H':{'at':[10,10],'side':'top'}},'side':{'bottom':['P']}},graph.refs)
        def placement(g,c,**kw):
            if 'P' in c.locked_refs:raise LegalizationError('unrelated hard group')
            return copy.deepcopy(g),PlacementReport(24,22,1,1)
        with patch('pnr.place.initial_pool.place',side_effect=placement),\
             patch('pnr.place.capacity_proxy.cheap_score',return_value=0),\
             patch('pnr.place.capacity_proxy.score',return_value={'score':0}),\
             patch('pnr.route.detail.router.route_board') as route:
            _,_,_,report=select_initial_placement(graph,constraints,{'layers':2},
                config=InitialPoolConfig(starts=4,proxy_budget=4),iters=1,proxy_only=True)
        route.assert_not_called()
        basin=report['candidates'][2]
        self.assertEqual(basin['status'],'legal')
        self.assertEqual(basin['basin_fallback_from'],'start-00')
        self.assertEqual(basin['poses']['P'][:2],[10,10])
        self.assertNotIn('P',constraints.locked_refs)

    def test_config_is_opt_in_and_bounded(self):
        with patch.dict(os.environ,{},clear=True):
            self.assertIsNone(InitialPoolConfig.from_environment())
        with patch.dict(os.environ,{'PNR_INITIAL_POOL':'1','PNR_INITIAL_STARTS':'4','PNR_INITIAL_FINALISTS':'2'},clear=True):
            self.assertEqual(InitialPoolConfig.from_environment().starts,4)
        for kwargs in [dict(starts=1),dict(route_finalists=9),dict(proxy_budget=1),dict(proxy_pitch_mm=0)]:
            with self.assertRaises(ValueError):InitialPoolConfig(**kwargs)


class InitialSelectionTest(unittest.TestCase):
    def test_routed_evidence_outvotes_proxy_and_baseline_has_same_budget(self):
        graph,constraints=fixture();before=graph.to_json();calls=[]
        def placement(g,c,**kw):
            out=copy.deepcopy(g)
            # Deterministically distinct legal basins; fixed/native locks unchanged.
            index=(kw['seed']//104729)%8
            out.component('A').pos=(5+index,4)
            out.component('B').pos=(12-index*.5,8)
            return out,PlacementReport(20,16,10,10)
        def routed(g,c,r,**kw):
            calls.append((g.component('A').pos,kw))
            # The cheapest-capacity baseline is incomplete; another finalist wins.
            missing=2 if g.component('A').pos[0]==5 else 0
            net=RoutedNet('N',remaining_connections=missing)
            return NS(result=RouteResult({'N':net},['N'] if missing else [],1),deferred_nets=set(),
                      tracks=[],vias=[],escape_diagnostics={})
        with tempfile.TemporaryDirectory() as tmp,patch('pnr.place.initial_pool.place',side_effect=placement),\
             patch('pnr.place.capacity_proxy.cheap_score',side_effect=lambda g,r:g.component('A').pos[0]),\
             patch('pnr.place.capacity_proxy.score',side_effect=lambda g,r,**kw:{'score':g.component('A').pos[0]}),\
             patch('pnr.route.detail.router.route_board',side_effect=routed):
            chosen,prep,route,report=select_initial_placement(graph,constraints,{'layers':2},
                config=InitialPoolConfig(starts=5,route_finalists=3,proxy_budget=4),iters=5,
                route_iters=7,pitch=.25,output=tmp)
            saved=json.loads((Path(tmp)/'report.json').read_text())
            self.assertEqual(saved['selected'],report['selected'])
            self.assertIn('start-00',report['route_finalists'])
            self.assertIn('start-01',report['route_finalists'])
            self.assertEqual(report['detailed_evaluations'],3)
            self.assertEqual(report['proxy_evaluations'],4)
            self.assertNotEqual(report['selected'],'start-00')
            self.assertEqual([kw for _,kw in calls],[{'pitch':.25,'max_iters':7}]*3)
            self.assertFalse(report['plateau_observed'])
            self.assertEqual(graph.to_json(),before)
            self.assertEqual(chosen.component('LOCKED').pos,(15,12))

    def test_candidates_changing_pad_net_are_rejected_before_route(self):
        graph,constraints=fixture()
        def placement(g,c,**kw):
            out=copy.deepcopy(g);out.component('A').pads[0].net='BAD'
            return out,PlacementReport(20,16,10,10)
        with patch('pnr.place.initial_pool.place',side_effect=placement),\
             patch('pnr.place.capacity_proxy.cheap_score',return_value=0),\
             patch('pnr.place.capacity_proxy.score',return_value={'score':0}),\
             patch('pnr.route.detail.router.route_board',return_value=NS(result=RouteResult({},[],1),
                   deferred_nets=set(),tracks=[],vias=[],escape_diagnostics={})) as route:
            _,_,_,report=select_initial_placement(graph,constraints,{'layers':2},
                config=InitialPoolConfig(starts=3,route_finalists=2,proxy_budget=3),iters=0)
        self.assertEqual(route.call_count,1) # only unchanged source incumbent survives
        self.assertEqual(report['selected'],'start-01')
        self.assertEqual(report['candidates'][0]['status'],'rejected_hard_constraints')


    def test_proxy_only_never_routes_or_claims_selected_placement(self):
        graph,constraints=fixture()
        with patch('pnr.place.initial_pool.place',return_value=(graph,PlacementReport(20,16,10,10))),\
             patch('pnr.place.capacity_proxy.cheap_score',return_value=0),\
             patch('pnr.place.capacity_proxy.score',return_value={'score':3}),\
             patch('pnr.route.detail.router.route_board') as route:
            chosen,prep,cached,report=select_initial_placement(graph,constraints,{'layers':2},
                config=InitialPoolConfig(starts=3,route_finalists=2,proxy_budget=3),
                iters=0,proxy_only=True)
        route.assert_not_called()
        self.assertIsNone(cached)
        self.assertIsNone(report['selected'])
        self.assertEqual(report['detailed_evaluations'],0)
        self.assertEqual(report['termination'],'proxy_only_budget_completed')
        self.assertTrue(report['recommendation'])
        self.assertFalse(report['plateau_observed'])

    def test_feedback_reuses_initial_winner_route_without_extra_budget(self):
        from pnr.route.feedback import route_and_place
        graph,constraints=fixture()
        route=NS(result=RouteResult({},[],1),deferred_nets=set(),tracks=[],vias=[])
        pool_report={'selected':'start-00','candidates':[{'id':'start-00','seed':0}]}
        with patch.dict(os.environ,{},clear=True),\
             patch('pnr.place.initial_pool.select_initial_placement',
                   return_value=(graph,PlacementReport(20,16,10,10),route,pool_report)) as select,\
             patch('pnr.route.detail.router.route_board') as route_again:
            chosen,report=route_and_place(graph,constraints,iters=1,max_rounds=1,
                                         detail_rules={},initial_pool=True)
        select.assert_called_once()
        route_again.assert_not_called()
        self.assertIs(report.detail_result,route)
        self.assertIs(report.initial_pool,pool_report)


if __name__=='__main__':unittest.main()
