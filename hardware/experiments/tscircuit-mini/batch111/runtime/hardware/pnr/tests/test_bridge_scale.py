import unittest
from pnr.route.detail.layered import route_bridge
from pnr.route.detail.keyhole import route,legal

class BridgeScale(unittest.TestCase):
 def test_original_fine_grid_retained_for_offset_slits(self):
  def clear(a,b):
   for x,y in [(1.,.15),(2.,.35)]:
    if min(a[0],b[0])<=x<=max(a[0],b[0]):
     if abs(a[0]-b[0])<1e-9:
      if max(abs(a[1]-y),abs(b[1]-y))>.019:return False
     else:
      at=a[1]+(b[1]-a[1])*(x-a[0])/(b[0]-a[0])
      if abs(at-y)>.019:return False
   return True
  sources=[(.1,.5)];targets=[(2.9,.5)];bounds=(0,0,3,1)
  coarse=route(sources,targets,bounds,clear,pitch=.2,max_expansions=3000)
  result=route_bridge(sources,targets,bounds,clear,pitch=.05,budget=10000)
  self.assertFalse(coarse.path);self.assertEqual(result.status,'routed');self.assertTrue(legal(result.path,clear))
  self.assertEqual(result.path[0],sources[0]);self.assertEqual(result.path[-1],targets[0])

if __name__=='__main__':unittest.main()
