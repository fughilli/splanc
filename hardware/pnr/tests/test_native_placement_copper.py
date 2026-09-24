import unittest
import pcbnew as k
from test_native_electrical import board,pad,rules
from pnr.placement_copper import rank_native_copper

class NativePlacementCopper(unittest.TestCase):
 def test_pad_via_collision_reorders_without_mutation(self):
  b=board();p=pad(b,'A','1','rail',(5,5),(.4,.4));v=k.PCB_VIA(b);v.SetPosition(k.VECTOR2I(6000000,5000000));v.SetWidth(600000);v.SetDrill(300000);v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNetCode(b.FindNet('other').GetNetCode());b.Add(v)
  f=p.GetParentFootprint();before=(f.GetPosition().x,f.GetPosition().y)
  result=rank_native_copper(b,rules(),[dict(ref='A',dx=1,dy=0),dict(ref='A',dx=-1,dy=0)])
  self.assertEqual(result[0]['dx'],-1);self.assertEqual(result[0]['native_pad_collisions'],0);self.assertGreater(result[1]['native_pad_collisions'],0)
  self.assertEqual((f.GetPosition().x,f.GetPosition().y),before);self.assertEqual(len(list(b.GetTracks())),1)
 def test_same_net_copper_is_not_a_foreign_blocker(self):
  b=board();p=pad(b,'A','1','rail',(5,5),(.4,.4));pad(b,'Z','1','rail',(6,5),(.4,.4))
  result=rank_native_copper(b,rules(),[dict(ref='A',dx=1,dy=0)])
  self.assertEqual(result[0]['native_pad_collisions'],0)

if __name__=='__main__':unittest.main()
