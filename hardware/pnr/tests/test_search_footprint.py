"""A proposed search path must respect the footprint used at native commit."""
import unittest
from pnr.route.detail.grid import Cell,RouteGrid
from pnr.route.detail.maze import _astar,_footprint

class SearchFootprintTest(unittest.TestCase):
 def test_wide_track_takes_real_detour_instead_of_repeatedly_rejected_centerline(self):
  g=RouteGrid(14,9,1,layers=('F.Cu',));g.routing_track_halos={'N':1}
  blocked={Cell(0,i,3) for i in range(4,10)}
  path=_astar(g,{Cell(0,1,4)},{Cell(0,12,4)},'N',{},{},3,0,blocked=blocked)
  self.assertIsNotNone(path)
  self.assertFalse(_footprint(g,path,0,1)&blocked)
  self.assertTrue(any(c.j>4 for c in path))
 def test_via_ring_avoids_copper_on_nonlanding_layer(self):
  g=RouteGrid(10,10,1,layers=('F.Cu','In1.Cu','B.Cu'));g.routing_via_keepout=2
  blocked={Cell(1,5,4)}
  path=_astar(g,{Cell(0,4,4)},{Cell(2,4,4)},'N',{},{},3,0,blocked=blocked)
  self.assertIsNotNone(path)
  self.assertFalse(_footprint(g,path,2,edges=list(zip(path,path[1:])))&blocked)
 def test_layer_crossing_does_not_reserve_a_phantom_via(self):
  g=RouteGrid(10,10,1,layers=('F.Cu','In1.Cu','B.Cu'))
  edges=[(Cell(0,4,4),Cell(0,5,4)),(Cell(2,4,4),Cell(2,4,5))]
  self.assertNotIn(Cell(1,4,4),_footprint(g,[c for e in edges for c in e],2,edges=edges))
 def test_soft_price_also_sees_width(self):
  g=RouteGrid(14,9,1,layers=('F.Cu',));g.routing_track_halos={'N':1}
  expensive={Cell(0,i,3):100 for i in range(4,10)}
  path=_astar(g,{Cell(0,1,4)},{Cell(0,12,4)},'N',{},{},3,0,soft=expensive)
  self.assertIsNotNone(path)
  self.assertFalse(_footprint(g,path,0,1)&expensive.keys())

if __name__=='__main__':unittest.main()
