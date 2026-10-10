import unittest
import pcbnew as k
from test_native_electrical import board
from pnr.native_electrical import add_track,Oracle
from pnr.reference_guard import ReferenceGuard
class ReferenceGuardTest(unittest.TestCase):
 def fixture(self):
  b=board();add_track(b,'p',k.F_Cu,(3,5),(17,5),.2);add_track(b,'n',k.F_Cu,(3,5.4),(17,5.4),.2)
  r=dict(fab={'clearance_mm':.15},net_classes=[dict(nets=['rail'],plane_layer='In1.Cu')],diff_pairs=[dict(name='usb',p='p',n='n',width_mm=.2,gap_mm=.2,reference_layer='In1.Cu')],routed_pair_references=[dict(pair='usb',segments=[dict(reference_paths={'p':[(3,5),(17,5)],'n':[(3,5.4),(17,5.4)]})])])
  return b,r
 def test_clearance_void_blocked_before_actual_pair_collision(self):
  b,r=self.fixture();guard=ReferenceGuard(b,r)
  # At y4.4 native copper clearance passes, but the larger plane aperture
  # overlaps the retained reference corridor.
  self.assertFalse(guard.via_clear('other',(10,4.4),.6));self.assertTrue(guard.via_clear('other',(10,4),.6))
  self.assertTrue(guard.via_clear('rail',(10,4.4),.6))
  plain=Oracle(b,dict(fab={'clearance_mm':.15}));protected=Oracle(b,r)
  self.assertTrue(plain.via('other',(10,4.4),.6,.3));self.assertFalse(protected.via('other',(10,4.4),.6,.3))
 def test_bank_diameter_and_foreign_net_clearance(self):
  b,r=self.fixture();guard=ReferenceGuard(b,r);self.assertTrue(guard.via_clear('other',(10,4),.6));self.assertFalse(guard.via_clear('other',(10,4),1.6))
  r['net_classes'].append(dict(nets=['other'],clearance_mm=.8));self.assertFalse(ReferenceGuard(b,r).via_clear('other',(10,4),.6))
 def test_stale_removed_pair_has_no_reserved_corridor(self):
  b,r=self.fixture();tracks=list(b.GetTracks())
  for t in tracks:b.Remove(t)
  self.assertEqual(ReferenceGuard(b,r).rows,[])
if __name__=='__main__':unittest.main()
