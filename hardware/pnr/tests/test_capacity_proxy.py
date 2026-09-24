import unittest
from pnr.graph import BoardGraph,BoardOutline,Component,Pad
from pnr.place.capacity_proxy import CapacityGraph,commodities,score,diverse_options,rank_candidates
from pnr.place.batch_relocate import joint_configurations
from pnr.constraints import compile_constraints

class CapacityTests(unittest.TestCase):
    def fixture(self,count=1):
        cs=[]
        for i in range(count):
            for prefix,x in [('A',1),('B',9)]:
                cs.append(Component(prefix+str(i),'',(x,2),0,'top',(.2,.2),(.2,.2),pads=[Pad('1','n'+str(i),(0,0),(.2,.2))],smd_body=True))
        return BoardGraph('fixture',cs,[],BoardOutline(10,4))
    def test_shared_demand_and_width_increase_contention(self):
        g=self.fixture(8)
        small=score(g,{'layers':2,'fab':{'track_width_mm':.1}},passes=2)
        wide=score(g,{'layers':2,'fab':{'track_width_mm':1.2}},passes=2)
        self.assertGreater(wide['overflow_units'],small['overflow_units'])
        self.assertGreater(wide['score'],small['score'])
    def test_through_board_barrier_unreachable(self):
        g=self.fixture();r={'layers':2,'copper_keepouts':[{'ref':'A0','rect_mm':[3,-2,5,2]}]}
        result=score(g,r,passes=1)
        self.assertEqual(result['unreachable_branches'],1)
    def test_smd_body_does_not_reserve_backside(self):
        g=self.fixture();g.components[0].bbox=(9,4);g.components[0].courtyard=(9,4)
        m=CapacityGraph(g,{'layers':2});back=[v for v,(la,x,y) in zip(m.cap,m.location) if la==1]
        self.assertGreater(sum(back),0)
    def test_declared_power_widths_and_via_arrays_used(self):
        g=self.fixture();r={'layers':4,'electrical_nets':{'n0':{'outer_width_mm':1.5,'inner_width_mm':3.1,'via_array':{'count':3}}}}
        c=commodities(g,r,CapacityGraph(g,r))[0]
        self.assertAlmostEqual(c['widths'][0],1.65);self.assertAlmostEqual(c['widths'][1],3.25);self.assertEqual(c['via_count'],3)
    def test_pair_is_one_corridor_with_both_tracks(self):
        g=self.fixture(2);r={'layers':2,'diff_pairs':[{'name':'pair','p':'n0','n':'n1','width_mm':.2,'gap_mm':.15,'terminal_chain':[{'p':'A0.1','n':'A1.1'},{'p':'B0.1','n':'B1.1'}]}]}
        cs=commodities(g,r,CapacityGraph(g,r));self.assertEqual(len(cs),1);self.assertAlmostEqual(cs[0]['widths'][0],.7)
    def test_input_immutable_and_deterministic(self):
        g=self.fixture();before=g.to_json();a=score(g,{},passes=2);b=score(g,{},passes=2)
        self.assertEqual(a['score'],b['score']);self.assertEqual(g.to_json(),before)
    def test_diversity_preserves_distant_basin(self):
        opts=[dict(position=[x,2],cost=x) for x in [1,2,3,4,20]]
        selected=diverse_options(opts,opts[0],3,30,10)
        self.assertIn(opts[-1],selected);self.assertEqual(selected[0],opts[0])
    def test_singleton_move_enters_joint_evaluation(self):
        g=self.fixture();cc=compile_constraints({'board':{'outline':{'w':10,'h':4}}},g.refs)
        choices,audit=joint_configurations(g,cc,{'A0':[dict(position=[3,2],cost=1)]})
        self.assertEqual(len(choices),1);self.assertEqual(len(choices[0]['moves']),1)
    def test_hierarchy_has_bounded_expensive_evaluations(self):
        g=self.fixture();cs=[]
        for x in [1,2,3,4]:
            c=BoardGraph.from_json(g.to_json());c.component('A0').pos=(x,2)
            cs.append(dict(graph=c,cost=1,moves=[dict(ref='A0')]))
        ranked,audit=rank_candidates(cs,{},budget=2,passes=1)
        self.assertEqual(audit['evaluated'],2);self.assertEqual(len(ranked),2)


class OpportunityTests(unittest.TestCase):
    def test_opposite_body_opportunity_without_part_names(self):
        g=BoardGraph('test',[Component('TEST','',(40,20),0,'bottom',(8,8),(8,8),smd_body=True),Component('MODULE','',(15,30),0,'top',(18,25),(18,25),smd_body=True)],[],BoardOutline(60,50))
        opts=[dict(position=p,cost=i) for i,p in enumerate([[40,20],[42,20],[15,25],[5,5]])]
        selected=diverse_options(opts,opts[0],3,60,50,g,'TEST')
        self.assertEqual(selected[-1]['position'],[15,25])
    def test_large_owned_land_has_escape_portal(self):
        g=BoardGraph('test',[Component('X','',(3,3),0,'top',(5,5),(5,5),pads=[Pad('1','rail',(0,0),(4,4))],smd_body=True),Component('Y','',(9,3),0,'top',(1,1),(1,1),pads=[Pad('1','rail',(0,0),(.3,.3))],smd_body=True)],[],BoardOutline(12,8))
        self.assertEqual(score(g,{'layers':2},passes=1)['unreachable_branches'],0)

if __name__=='__main__':unittest.main()
