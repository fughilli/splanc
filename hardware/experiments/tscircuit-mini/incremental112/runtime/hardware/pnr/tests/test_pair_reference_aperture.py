import unittest
import pcbnew as k
from test_native_electrical import board,rules
from pnr.native_electrical import pair_reference_validator
class ReferenceApertureTest(unittest.TestCase):
 def test_future_via_aperture_blocks_reference_before_board_mutation(self):
  b=board();r=rules();r['net_classes']=[dict(name='ground',nets=['rail'],plane_layer='In1.Cu')]
  z=k.ZONE(b);z.SetLayer(k.In1_Cu);z.SetNetCode(b.FindNet('rail').GetNetCode());z.SetLocalClearance(200000);poly=z.Outline();poly.NewOutline()
  for x,y in [(1,1),(19,1),(19,19),(1,19)]:poly.Append(x*1000000,y*1000000)
  b.Add(z);k.ZONE_FILLER(b).Fill(b.Zones());pair=dict(p='p',n='n',width_mm=.2,gap_mm=.2,reference_layer='In1.Cu')
  clear=pair_reference_validator(b,pair,r);self.assertTrue(clear.center((3,5),(17,5),.4))
  planned=pair_reference_validator(b,pair,r,[('p',(10,5))]);self.assertFalse(planned.center((3,5),(17,5),.4));self.assertTrue(planned.center((3,8),(17,8),.4))
  self.assertTrue(clear.center((3,5),(17,5),.4));self.assertEqual(len(list(b.GetTracks())),0)
