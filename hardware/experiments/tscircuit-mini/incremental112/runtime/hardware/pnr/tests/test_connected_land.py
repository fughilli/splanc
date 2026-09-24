import unittest
import pcbnew as k
from test_native_electrical import board,pad,vec
from pnr.pad_entry import connected_land_witness,inspect
from pnr.native_electrical import add_track
class ConnectedLandTest(unittest.TestCase):
 def fixture(self):
  b=board();a=pad(b,'A','3','rail',(5,5),(.01,.01));a.SetShape(k.PAD_SHAPE_CUSTOM);poly=k.SHAPE_POLY_SET();poly.NewOutline()
  for pt in [(-.18,-.56),(.18,-.56),(.18,.56),(-.18,.56)]:poly.Append(vec(pt))
  a.AddPrimitivePoly(k.F_Cu,poly,0,True);p=pad(b,'A','1','rail',(5.12,5.44),(.6,.22))
  r={'fab':{'track_width_mm':.2},'current_intents':[{'scope':'terminal','ref':'A','net':'rail','pads':['1','3']}]}
  return b,a,p,r
 def test_full_overlap_requires_explicit_common_terminal_scope(self):
  b,a,p,r=self.fixture();self.assertTrue(connected_land_witness(p,a,k.F_Cu,r));r['current_intents']=[];self.assertFalse(connected_land_witness(p,a,k.F_Cu,r))
 def test_tiny_overlap_and_gap_rejected(self):
  b,a,p,r=self.fixture()
  for y in [5.66,5.7]:p.SetPosition(vec((5.12,y)));self.assertFalse(connected_land_witness(p,a,k.F_Cu,r))
 def test_foreign_net_and_footprint_rejected(self):
  b,a,p,r=self.fixture();p.SetNetCode(b.FindNet('other').GetNetCode());self.assertFalse(connected_land_witness(p,a,k.F_Cu,r));p2=pad(b,'B','1','rail',(5.12,5.44),(.6,.22));self.assertFalse(connected_land_witness(p2,a,k.F_Cu,r))
 def test_no_qualified_anchor_does_not_excuse_grazing(self):
  b,a,p,r=self.fixture();keep=add_track(b,'rail',k.F_Cu,(5.39,5.64),(6,5.64),.2);b.BuildConnectivity();rows=[row for row in inspect(b,r) if row[0].m_Uuid==p.m_Uuid];self.assertTrue(rows);self.assertFalse(rows[0][4])
 def test_ordinary_land_can_feed_declared_custom_bus(self):
  b,a,p,r=self.fixture();self.assertTrue(connected_land_witness(a,p,k.F_Cu,r))
  r['current_intents']=[];self.assertFalse(connected_land_witness(a,p,k.F_Cu,r))
 def test_qualification_crosses_untracked_bus_but_needs_real_root(self):
  b,a,p,r=self.fixture();q=pad(b,'A','2','rail',(5.12,4.56),(.6,.22));r['current_intents'][0]['pads'].append('2')
  graze=add_track(b,'rail',k.F_Cu,(5.39,4.36),(6,4.36),.2);b.BuildConnectivity()
  self.assertFalse(any(row[4] for row in inspect(b,r)))
  feed=add_track(b,'rail',k.F_Cu,(5.30,5.44),(6,5.44),.2);b.BuildConnectivity()
  rows=inspect(b,r);self.assertTrue(all(row[4] for row in rows))
  self.assertNotIn(a.m_Uuid.AsString(),[row[0].m_Uuid.AsString() for row in rows])
  r['current_intents']=[];self.assertFalse(next(row[4] for row in inspect(b,r) if row[0].m_Uuid==q.m_Uuid))
 def test_reverse_graze_is_not_a_bus_feed(self):
  b,a,p,r=self.fixture();p.SetPosition(vec((5.12,5.66)));self.assertFalse(connected_land_witness(a,p,k.F_Cu,r))
 def test_small_bus_cannot_reduce_large_conventional_land_contact(self):
  b,a,p,r=self.fixture();p.SetPosition(vec((5,5)));p.SetSize(vec((.8,.8)));r['fab']['track_width_mm']=.6
  self.assertFalse(connected_land_witness(p,a,k.F_Cu,r));self.assertFalse(connected_land_witness(a,p,k.F_Cu,r))
if __name__=='__main__':unittest.main()
