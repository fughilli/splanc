import unittest
from pnr.geometric_tree import tree,length
class Tests(unittest.TestCase):
 def test_u_becomes_shared_tree(self):
  old=[((0,3),(0,0)),((0,0),(4,0)),((4,0),(4,3))];new=tree([(0,3),(4,3),(2,0)],old,lambda a,b:True)
  self.assertLess(length(new),length(old));self.assertTrue(all(any(t in e for e in new) for t in [(0,3),(4,3),(2,0)]))
 def test_obstacle_is_not_crossed(self):
  def clear(a,b):return not(min(a[0],b[0])<2<max(a[0],b[0]) and min(a[1],b[1])<3)
  new=tree([(0,0),(4,0)],[((0,0),(0,4)),((0,4),(4,4)),((4,4),(4,0))],clear)
  self.assertIsNotNone(new);self.assertTrue(all(clear(*e) for e in new))
 def test_impossible_fails_closed(self):self.assertIsNone(tree([(0,0),(4,0)],[],lambda a,b:False))
 def test_staircase_shortens(self):
  old=[((0,0),(1,0)),((1,0),(1,1)),((1,1),(2,1)),((2,1),(2,2))];new=tree([(0,0),(2,2)],old,lambda a,b:True);self.assertAlmostEqual(length(new),2**.5*2)
if __name__=='__main__':unittest.main()
