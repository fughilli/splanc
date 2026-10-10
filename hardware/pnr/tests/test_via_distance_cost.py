import unittest
from pnr.route.detail.grid import RouteGrid,Cell
from pnr.route.detail.maze import _astar
class ViaDistanceCostTest(unittest.TestCase):
 def test_short_layer_excursion_loses_to_surface_detour_at_two_pitches(self):
  for pitch in (.25,.4):
   g=RouteGrid(12,12,pitch,layers=('F.Cu','B.Cu'),clearance=.15,track_width=.2,via_radius=.3)
   for i in range(g.nx):
    for j in range(g.ny):
     x,y=g.center_of(i,j)
     if 5<=x<=6 and 1<=y<=11:g.blocked[0,j,i]=True
   src=Cell(0,*g.cell_of(1,6));dst=Cell(0,*g.cell_of(10,6))
   def path(cost):return _astar(g,{src},{dst},'signal',{}, {},cost,0.)
   cheap=path(3.);physical=path(3./pitch)
   self.assertIsNotNone(cheap);self.assertIsNotNone(physical)
   self.assertTrue(any(c.layer==1 for c in cheap))
   self.assertTrue(all(c.layer==0 for c in physical))
if __name__=='__main__':unittest.main()
