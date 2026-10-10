import unittest
from pnr.route.detail.grid import RouteGrid
from pnr.route.detail.fixed import reserve_fixed_copper
from pnr.route.detail.maze import route
from pnr.route.detail.grid import Cell
class FixedCopperTest(unittest.TestCase):
 def test_off_grid_capsule_and_layer_scope(self):
  g=RouteGrid(10,10,.2,clearance=.1,track_width=.2)
  reserve_fixed_copper(g,dict(frame='engine-mm-y-up',tracks=[['usb','F.Cu',[.1,5.03],[9.9,5.03],.2]]))
  i,j=g.cell_of(5,5)
  self.assertFalse(g.passable(0,i,j,'signal'));self.assertTrue(g.passable(1,i,j,'signal'))
  self.assertFalse(g.via_passable(0,i,j,'signal'))
  # No legal crossing on the fixed track's layer, even with negotiation/ripup.
  a=Cell(0,*g.cell_of(5,2));b=Cell(0,*g.cell_of(5,8))
  r=route(g,{'signal':[a,b]},max_iters=2,rrr_rounds=1)
  self.assertTrue(r.nets['signal'].routed)
  self.assertTrue(r.nets['signal'].vias)
 def test_through_via_blocks_all_layers(self):
  g=RouteGrid(10,10,.2,layers=('F.Cu','In2.Cu','B.Cu'),clearance=.1,track_width=.2)
  reserve_fixed_copper(g,dict(frame='engine-mm-y-up',vias=[dict(net='usb',xy=[5,5],diameter_mm=.6,drill_mm=.3,type='through')]))
  for la in range(3):
   i,j=g.cell_of(5,5);self.assertFalse(g.passable(la,i,j,'signal'));self.assertFalse(g.via_passable(la,i,j,'signal'))
   i,j=g.cell_of(8,8);self.assertTrue(g.passable(la,i,j,'signal'))
 def test_frame_and_blind_vias_are_not_silently_assumed(self):
  g=RouteGrid(10,10,.2)
  with self.assertRaises(ValueError):reserve_fixed_copper(g,{})
  with self.assertRaises(ValueError):reserve_fixed_copper(g,dict(frame='engine-mm-y-up',vias=[dict(net='x',xy=[5,5],diameter_mm=.6,drill_mm=.3,type='blind')]))

if __name__ == "__main__":
    unittest.main()
