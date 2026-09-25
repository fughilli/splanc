import unittest
from unittest.mock import patch
import pcbnew as k
from test_reference_guard import ReferenceGuardTest
from pnr.reference_guard import ReferenceGuard
from pnr.electrical import net_policy
from pnr.native_electrical import vec
class CacheTest(unittest.TestCase):
 def test_one_aperture_per_equal_radius_per_query(self):
  b,r=ReferenceGuardTest().fixture();g=ReferenceGuard(b,r)
  with patch.object(k,'SHAPE_CIRCLE',wraps=k.SHAPE_CIRCLE) as circle:
   self.assertTrue(g.via_clear('other',(10,2),.6));self.assertEqual(circle.call_count,1)
   self.assertFalse(g.via_clear('other',(10,5),.6));self.assertEqual(circle.call_count,2)
 def test_matches_original_native_geometry_for_varied_queries(self):
  b,r=ReferenceGuardTest().fixture();g=ReferenceGuard(b,r)
  def original(net,point,diameter):
   gap=net_policy(net,r)['clearance_mm']
   for corridor,nets,clearance in g.rows:
    if net in nets:continue
    aperture=k.SHAPE_CIRCLE(vec(point),round((diameter/2+max(gap,clearance)+.004)*1e6))
    if corridor.Collide(aperture,0):return False
   return True
  for net in ['other','rail']:
   for diameter in [.4,.6,1.6]:
    for y in [2,4,4.199,4.201,4.4,4.7,5.2,5.8,6.2,9]:
     with self.subTest(net=net,diameter=diameter,y=y):self.assertEqual(g.via_clear(net,(10,y),diameter),original(net,(10,y),diameter))
if __name__=='__main__':unittest.main()
