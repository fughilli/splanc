"""Native-loop policy regression: feedback, rollback gates and movement bounds."""
import json
import math
from pathlib import Path
import tempfile
import unittest
from pnr.native_loop import route_search_seconds,scheduled_route_jobs,route_job_key
from pnr.native_loop import gate, placements, score_failures
from pnr.graph import BoardGraph, BoardOutline, Component, Pad


class NativeLoopTest(unittest.TestCase):
    def test_small_placement_budget_visits_distinct_blockers(self):
        from pnr.native_loop import diverse_placement_trials
        moves=[dict(ref='A',position=[1,1]),dict(ref='A',position=[2,1]),
               dict(ref='B',position=[3,1]),dict(ref='C',position=[4,1])]
        self.assertEqual(diverse_placement_trials(moves,2),[moves[0],moves[2]])
        self.assertEqual(diverse_placement_trials(moves,4),[moves[0],moves[2],moves[3],moves[1]])
        self.assertEqual(diverse_placement_trials([],2),[])

    def test_complete_pair_chain_is_only_solved_once_per_sweep(self):
        from pnr.native_loop import unique_route_jobs
        jobs=[dict(mode='pair',pair_name='usb',net='p'),
              dict(mode='signal',net='x'),dict(mode='pair',pair_name='usb',net='n'),
              dict(mode='pair',pair_name='other',net='q'),dict(mode='plane',net='g'),
              dict(mode='plane',net='g')]
        self.assertEqual(unique_route_jobs(jobs),[jobs[i] for i in (0,1,3,4,5)])
        self.assertEqual(len(jobs),6)

    def test_fair_sweeps_do_not_starve_longer_connections(self):
        from pnr.native_loop import scheduled_route_jobs, route_job_key
        jobs=[dict(net='n',source='A.'+str(i),target='B.'+str(i),distance=i)
              for i in range(100)]
        attempts={};seen=set()
        for _ in range(3):
            for t in scheduled_route_jobs(jobs,attempts)[:40]:
                key=route_job_key(t);seen.add(key);attempts[key]=attempts.get(key,0)+1
        self.assertEqual(len(seen),100)
        reversed_job=dict(jobs[0],source=jobs[0]['target'],target=jobs[0]['source'])
        self.assertEqual(route_job_key(reversed_job),route_job_key(jobs[0]))

    def test_move_repairs_its_nets_and_observed_blocked_nets_only(self):
        from pnr.native_loop import affected_route_jobs
        jobs=[dict(net='terminal',source='A.1',target='B.1'),
              dict(net='blocked',source='C.1',target='D.1'),
              dict(net='terminal',source='E.1',target='F.1'),
              dict(net='unrelated',source='G.1',target='H.1')]
        inv=dict(graph=dict(components=[dict(ref='A',pads=[dict(net='terminal')])]),
                 owners={'track':'A'},targets=jobs)
        self.assertEqual(affected_route_jobs(inv,'A',{'blocked':{'track':3}}),jobs[:2])
        self.assertEqual(affected_route_jobs(inv,'absent',{}),[])
        pair=dict(net='usb',source='USB.1',target='MCU.1',related_refs=['A'])
        inv['targets'].append(pair)
        self.assertEqual(affected_route_jobs(inv,'A',{}),[jobs[0],pair])

    def test_failure_history_changes_component_priority(self):
        target=dict(source='A.1',target='B.2')
        scores=score_failures({},[dict(target=target,static_blockers={'copper':8,'unknown':2})],{'copper':'C'})
        self.assertEqual(scores,{'A':1,'B':1,'C':.8})
        self.assertEqual(score_failures(scores,[dict(target=target)],{}),{'A':2,'B':2,'C':.8})

    def test_native_acceptance_requires_improvement_and_preservation(self):
        before=dict(unconnected_items=[{},{}],violations=[])
        equal=dict(unconnected_items=[{},{}],violations=[])
        after=dict(unconnected_items=[{}],violations=[])
        checks=dict(preserved=True,lost_pad_entries=[])
        self.assertFalse(gate(before,equal,checks))
        self.assertTrue(gate(before,equal,checks,strict=False))
        self.assertTrue(gate(before,after,checks))
        self.assertFalse(gate(before,after,dict(preserved=False,lost_pad_entries=[])))
        self.assertFalse(gate(before,after,dict(preserved=True,lost_pad_entries=['pad'])))
        self.assertFalse(gate(before,dict(after,violations=[dict(type='clearance',items=[dict(uuid='new')])]),checks))
        self.assertFalse(gate(before,dict(after,violations=[dict(type='track_dangling',items=[])]),checks))

    def test_feedback_moves_only_legal_unfixed_components_with_total_bound(self):
        cs=[Component(ref,'test',(x,5),0,'top',(1,1),(1,1),pads=[Pad('1','n',(0,0),(.2,.2))]) for ref,x in [('A',3),('B',6),('C',9)]]
        cs[2].locked=True
        g=BoardGraph('test',cs,[],BoardOutline(12,12))
        inv=dict(graph=json.loads(g.to_json()),footprint_poses={c.ref:list(c.pos) for c in cs})
        with tempfile.TemporaryDirectory() as d:
            config=Path(d)/'constraints.yaml';config.write_text('schema: v0\nboard:\n  outline: {w: 12, h: 12}\nfixed:\n  A: {at: [3, 5]}\n')
            original=inv['footprint_poses']
            options=placements(inv,config,{'A':5,'B':2,'C':4},set(),original,.5)
            self.assertTrue(options)
            self.assertTrue(all(o['ref']=='B' and math.dist(o['position'],original['B'])<=.5 for o in options))
            tried={(o['ref'],*o['position']) for o in options}
            self.assertFalse(placements(inv,config,{'B':2},tried,original,.5))
            # Cumulative cap, not a renewed half-mm allowance each cycle.
            shifted=dict(original,B=[5.5,5])
            options=placements(inv,config,{'B':2},set(),shifted,.5)
            self.assertTrue(all(math.dist(o['position'],shifted['B'])<=.5 for o in options))


class Scheduling(unittest.TestCase):
 def test_untried_connection_retains_short_first_budget(self):
  a=dict(net='s',source='A.1',target='B.1',source_uuid='a',target_uuid='b',distance=1)
  z=dict(net='s',source='C.1',target='D.1',source_uuid='c',target_uuid='d',distance=50)
  attempts={route_job_key(a):3};queue=scheduled_route_jobs([a,z],attempts)
  self.assertEqual(queue[0],z)
  self.assertEqual(route_search_seconds(20,attempts.get(route_job_key(z),0)+1),5)
  self.assertEqual(route_search_seconds(20,attempts[route_job_key(a)]+1),20)
 def test_retry_growth_and_user_cap(self):
  self.assertEqual([route_search_seconds(20,n) for n in range(1,7)],[5,10,15,20,20,20])
  self.assertEqual(route_search_seconds(3,1),3)
  self.assertEqual([route_search_seconds(90,n) for n in range(1,9)],[5,10,15,20,40,80,90,90])


import unittest
from pnr.graph import BoardGraph,Component,BoardOutline
from pnr.constraints import compile_constraints
from pnr.place.metrics import hard_violations,translation_checker
class TranslationLegalityTest(unittest.TestCase):
 def test_cached_checks_match_full_constraints_for_individual_translations(self):
  g=BoardGraph('translation',[Component('A','',(5,5),0,'top',(2,2),(2,2)),Component('B','',(7,5),0,'top',(1,1),(1,1)),Component('C','',(7,5),0,'bottom',(1,1),(1,1)),Component('D','',(12,12),0,'top',(1,1),(1,1))],[],BoardOutline(20,20))
  c=compile_constraints({'board':{'outline':{'w':20,'h':20}},'fixed':{'A':{'at':[5,5]}},'group':[{'members':['B'],'anchor':'A','radius_mm':3,'hard':True}],'keepout':[{'name':'zone','polygon':[[15,15],[18,15],[18,18],[15,18]]}]},g.refs)
  for clearance in (0,.1):
   check=translation_checker(g,c,clearance)
   for part in g.components:
    old=part.pos
    for point in [(x,y) for x in (0,3,5,7,8,12,16,20) for y in (0,5,7,12,16,20)]+[(old[0]+.0009,old[1]+.0009)]:
     part.pos=point
     self.assertEqual(check(part),not any(hard_violations(g,c,clearance).values()),(part.ref,point,clearance))
    part.pos=old
 def test_illegal_baseline_is_rejected(self):
  g=BoardGraph('bad',[Component('A','',(-2,5),0,'top',(1,1),(1,1))],[],BoardOutline(20,20));c=compile_constraints({'board':{'outline':{'w':20,'h':20}}},g.refs)
  with self.assertRaises(ValueError):translation_checker(g,c)


if __name__=='__main__':unittest.main()
