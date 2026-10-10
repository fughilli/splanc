import unittest
from pnr.route.detail.layered import route_layers,primitives
from pnr.native_electrical import bank_clear
class TransitionPorts(unittest.TestCase):
 def route(self,barrels=lambda p:True,ports=lambda p,a,b:{a,b}=={0,1}):
  return route_layers([(0,0)],[(4,0)],(-.5,-.5,4.5,.5),
   lambda la,a,b:la!=0 or max(a[0],b[0])<1.9 or min(a[0],b[0])>2.1,
   barrels,transition_clear=ports,pitch=.25,max_expansions=1500,max_vias=2)
 def test_uses_only_selected_feed_layers(self):
  r=self.route();self.assertEqual(r.status,'routed')
  changes=[(a[2],b[2]) for a,b in zip(r.path,r.path[1:]) if a[2]!=b[2]]
  self.assertEqual(len(changes),2);self.assertTrue(all(set(x)=={0,1} for x in changes))
 def test_forbidden_ports_cannot_hide_in_decomposition_or_maze(self):
  self.assertFalse(self.route(ports=lambda *a:False).path)
 def test_all_layer_barrel_guard_remains_required(self):
  self.assertFalse(self.route(barrels=lambda p:False).path)
 def test_bank_copper_only_on_actual_ports(self):
  class Oracle:
   rules={'fab':{'hole_clearance_mm':.2}}
   def via(self,*args):return True
   def clear(self,net,layer,*args):return layer!=2
  policy={'via_array':{'count':3,'diameter_mm':.6,'drill_mm':.3}}
  oracle=Oracle()
  self.assertIsNone(bank_clear(oracle,'power',(0,0),policy,[(0,1.5),(1,1.5),(2,3)]))
  points=bank_clear(oracle,'power',(0,0),policy,[(0,1.5),(1,1.5)])
  self.assertEqual(len(points),3)
  oracle.via=lambda *a:False
  self.assertIsNone(bank_clear(oracle,'power',(0,0),policy,[(0,1.5),(1,1.5)]))
if __name__=='__main__':unittest.main()
