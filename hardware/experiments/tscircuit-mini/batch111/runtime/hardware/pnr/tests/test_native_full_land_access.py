"""A full-current bus may cover a small land from a clear outer landing."""
import time,unittest
from unittest.mock import patch
import pnr.native_electrical as electrical
import pcbnew as k
from test_native_electrical import board,pad,rules
from pnr.native_electrical import Oracle,power_plan,add_track,access
from pnr.pad_entry import witness

class FullLandAccess(unittest.TestCase):
 def test_outer_round_cap_escapes_without_narrowing_or_grazing(self):
  b=board();a=pad(b,'A','1','rail',(5,5),(.6,.3));z=pad(b,'Z','1','rail',(10,5),(.6,.3));pad(b,'BLOCK','1','other',(4.25,5),(.2,.2))
  r=rules();oracle=Oracle(b,r,deadline=time.monotonic()+5)
  self.assertFalse(oracle.clear('rail',k.F_Cu,(5,5),(5,5),1.5))
  self.assertTrue(any(oracle.clear('rail',k.F_Cu,q,q,1.5) for q in access([a],k.F_Cu,1.5)))
  result=power_plan(b,'rail',a,z,r,oracle,(1,1,19,19),.1)
  self.assertEqual(result['status'],'routed')
  self.assertTrue(result['tracks']);self.assertFalse(result.get('banks'))
  tracks=[add_track(b,'rail',*t) for t in result['tracks']]
  self.assertTrue(all(t.GetWidth()>=1500000 for t in tracks if t))
  self.assertTrue(any(witness(a,t,1.5) for t in tracks if t))
  self.assertTrue(any(witness(z,t,1.5) for t in tracks if t))

class PrunedPowerAccess(unittest.TestCase):
 def test_blocked_round_caps_never_reach_route_frontier(self):
  b=board();a=pad(b,'A','1','rail',(5,5),(.6,.3));z=pad(b,'Z','1','rail',(10,5),(.6,.3));pad(b,'BLOCK','1','other',(4.25,5),(.2,.2))
  r=rules();oracle=Oracle(b,r,deadline=time.monotonic()+5);original=electrical.route;calls=[]
  def checked(starts,ends,bounds,clear,**kwargs):
   calls.append((starts,ends))
   self.assertTrue(all(clear(q,q) for q in [*starts,*ends]),'blocked cap wasted a routing frontier')
   return original(starts,ends,bounds,clear,**kwargs)
  with patch.object(electrical,'route',side_effect=checked):
   result=power_plan(b,'rail',a,z,r,oracle,(1,1,19,19),.1)
  self.assertTrue(calls);self.assertEqual(result['status'],'routed');self.assertFalse(result['banks'])

class CenterFirstAccess(unittest.TestCase):
 def test_clear_pad_centers_do_not_expand_equivalent_frontiers(self):
  b=board();a=pad(b,'A','1','rail',(5,5),(.6,.3));z=pad(b,'Z','1','rail',(10,5),(.6,.3))
  r=rules();oracle=Oracle(b,r,deadline=time.monotonic()+5);original=electrical.route;calls=[]
  def checked(starts,ends,bounds,clear,**kwargs):
   calls.append((starts,ends));self.assertEqual(len(starts),1);self.assertEqual(len(ends),1)
   return original(starts,ends,bounds,clear,**kwargs)
  with patch.object(electrical,'route',side_effect=checked):
   result=power_plan(b,'rail',a,z,r,oracle,(1,1,19,19),.1)
  self.assertTrue(calls);self.assertEqual(result['status'],'routed')

if __name__=='__main__':unittest.main()
