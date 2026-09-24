import unittest
from build import added_segments

def t(a,b,**kw):return dict(start=a,end=b,net='n',layer='F.Cu',width=.2,**kw)
class DiffTest(unittest.TestCase):
 def test_split_reversed(self):
  self.assertEqual(added_segments([t([0,0],[2,0])],[t([1,0],[0,0]),t([2,0],[1,0])]),[])
 def test_partial(self):
  result=added_segments([t([0,0],[2,0])],[t([0,0],[1,0])])
  self.assertEqual(result[0]['start'],[1,0]);self.assertEqual(result[0]['end'],[2,0])
 def test_semantics_and_offset(self):
  a=t([0,0],[2,0])
  for old in [dict(a,net='other'),dict(a,layer='B.Cu'),dict(a,width=.3),t([0,.001],[2,.001])]:
   self.assertEqual(added_segments([a],[old]),[a])
if __name__=='__main__':unittest.main()
