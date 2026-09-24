import unittest,json,sys
import pcbnew as k
from pnr.incremental_place import apply
from pnr.ingest import build_graph
from pnr.merge_additive import signature
from pnr.plane_access import uid
V=lambda x,y:k.VECTOR2I(round(x*1e6),round(y*1e6))
class Test(unittest.TestCase):
 def fixture(self):
  b=k.BOARD()
  for name in ('A','B'):b.Add(k.NETINFO_ITEM(b,name))
  for a,z in [((1,1),(19,1)),((19,1),(19,19)),((19,19),(1,19)),((1,19),(1,1))]:
   t=k.PCB_SHAPE();t.SetShape(k.SHAPE_T_SEGMENT);t.SetStart(V(*a));t.SetEnd(V(*z));t.SetLayer(k.Edge_Cuts);t.SetWidth(50000);b.Add(t)
  # Independent pads on separate footprints; GND-like net A has a shared T.
  def pad(ref,x,y,net='A'):
   f=k.FOOTPRINT(b);f.SetReference(ref);f.SetPosition(V(x,y));b.Add(f);p=k.PAD(f);p.SetNumber('1');p.SetSize(V(1,1));p.SetShape(k.PAD_SHAPE_RECT);p.SetAttribute(k.PAD_ATTRIB_SMD);ls=k.LSET();ls.AddLayer(k.F_Cu);p.SetLayerSet(ls);p.SetPosition(V(x,y));p.SetNetCode(b.FindNet(net).GetNetCode());f.Add(p)
  for args in [('M',5,10),('L',10,5),('R',10,15),('X',15,5,'B'),('Y',15,15,'B')]:pad(*args)
  def track(a,z,net='A',layer=k.F_Cu):
   t=k.PCB_TRACK(b);t.SetStart(V(*a));t.SetEnd(V(*z));t.SetLayer(layer);t.SetWidth(200000);t.SetNetCode(b.FindNet(net).GetNetCode());b.Add(t);t.thisown=False;return uid(t)
  branch=track((5,10),(10,10));trunk=track((10,5),(10,15));other=track((15,5),(15,15),'B');back=track((4,8),(6,8),'B',k.B_Cu)
  b.BuildConnectivity();return b,branch,trunk,other,back
 def test_branch_preserves_shared_trunk_and_opposite_layer(self):
  b,branch,trunk,other,back=self.fixture();g=build_graph(b);c=g.component('M');c.pos=(c.pos[0],c.pos[1]+2)
  r=apply(b,g,{});self.assertEqual(set(r['removed']),{branch});self.assertEqual(r['retained_tracks'],3)
 def test_destination_conflict_removed(self):
  b,branch,trunk,other,back=self.fixture();g=build_graph(b);c=g.component('M');c.pos=(c.pos[0]+10,c.pos[1])
  r=apply(b,g,{});self.assertEqual(set(r['removed']),{branch,other});self.assertNotIn(trunk,r['removed'])
 def test_no_move_preserves_every_uuid_and_shape(self):
  b,*_=self.fixture();before={uid(t):signature(t) for t in b.GetTracks()};r=apply(b,build_graph(b),{});self.assertFalse(r['removed']);self.assertEqual(before,{uid(t):signature(t) for t in b.GetTracks()})
 def test_overlapping_segment_cluster_does_not_stop_leaf_cleanup(self):
  b,branch,trunk,other,back=self.fixture()
  old=next(t for t in b.GetTracks() if uid(t)==branch);b.Remove(old)
  ids=set()
  points=[(5,10),(6,10),(6.1,10),(6.2,10),(8,10),(10,10)]
  for a,z in zip(points,points[1:]):
   t=k.PCB_TRACK(b);t.SetStart(V(*a));t.SetEnd(V(*z));t.SetLayer(k.F_Cu);t.SetWidth(200000);t.SetNetCode(b.FindNet('A').GetNetCode());b.Add(t);t.thisown=False;ids.add(uid(t))
  b.BuildConnectivity();g=build_graph(b);c=g.component('M');c.pos=(c.pos[0],c.pos[1]+2)
  r=apply(b,g,{})
  self.assertEqual(set(r['removed']),ids)
  self.assertEqual({uid(t) for t in b.GetTracks()},{trunk,other,back})
if __name__=='__main__':unittest.main()
