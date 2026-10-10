import unittest,random
from pnr.graph import BoardGraph,BoardOutline,Component
from pnr.constraints import compile_constraints
from pnr.place.batch_relocate import joint_configurations
class JointTests(unittest.TestCase):
 def fixture(self):
  g=BoardGraph('test',[Component('A','',(2,2),0,'top',(2,2),(2,2)),Component('B','',(8,2),0,'top',(2,2),(2,2)),Component('FIX','',(14,2),0,'top',(2,2),(2,2))],[],BoardOutline(20,10))
  c=compile_constraints({'board':{'outline':{'w':20,'h':10}},'fixed':{'FIX':{'at':[14,2]}}},g.refs)
  return g,c
 def test_swap_requires_joint_holdout(self):
  g,c=self.fixture();opts={'A':[dict(position=[8,2],cost=1)],'B':[dict(position=[2,2],cost=1)]}
  choices,audit=joint_configurations(g,c,opts)
  self.assertEqual(len(choices),1);self.assertEqual(len(choices[0]['moves']),2)
  self.assertEqual(g.component('A').pos,(2,2));self.assertEqual(choices[0]['graph'].component('FIX').pos,(14,2))
 def test_joint_collision_and_fixed_pose_rejected(self):
  g,c=self.fixture();opts={'A':[dict(position=[5,2],cost=1)],'B':[dict(position=[5,2],cost=1)]}
  choices,audit=joint_configurations(g,c,opts)
  self.assertFalse(choices);self.assertTrue(audit['rejections'][0]['reason']['overlaps'])
 def test_combinations_sampled_without_duplicates(self):
  g,c=self.fixture();opts={'A':[dict(position=[x,6],cost=x) for x in (2,5)],'B':[dict(position=[x,6],cost=x) for x in (9,12)]}
  choices,audit=joint_configurations(g,c,opts,samples=4,rng=random.Random(4))
  self.assertEqual(audit['combinatorial_space'],4);self.assertEqual(len({v['indices'] for v in choices}),4)
 def test_all_batch_pads_and_incident_tracks_removed_before_probe(self):
  from unittest.mock import patch
  from pnr.graph import Pad
  from pnr.place.batch_relocate import propose_batches
  g,c=self.fixture()
  g.component('A').pads=[Pad('1','a',(0,0),(.2,.2))]
  g.component('B').pads=[Pad('1','b',(0,0),(.2,.2))]
  seen=[]
  def fields(substrate,comp,rules,tracks,vias,pitch):
   self.assertEqual(substrate.component('A').pads,[])
   self.assertEqual(substrate.component('B').pads,[])
   self.assertEqual([t[0] for t in tracks],['unrelated'])
   self.assertEqual(vias,[]);seen.append(comp.ref);return {}
  with patch('pnr.place.batch_relocate._fields',side_effect=fields):
   choices,audit=propose_batches(g,c,{},[(n,'F.Cu',(0,0),(1,1),.2) for n in ['a','b','unrelated']],[('a',0,0)],refs=['A','B'],k=2,n=4)
  self.assertEqual(set(seen),{'A','B'})
  self.assertEqual(audit['removed_tracks'],2)
  self.assertEqual(len(g.component('A').pads),1)

if __name__=='__main__':unittest.main()
