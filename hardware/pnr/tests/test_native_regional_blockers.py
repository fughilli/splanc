import unittest,copy,json
import pcbnew as k
from test_native_electrical import board,pad
from pnr.native_electrical import add_track,uid
from pnr.regional_blockers import plans_from_rows,inspect

def row(net='renamed_signal',hits=3,**kw):
 d=dict(net=net,hits=hits,uuid=net+str(hits),kind='PCB_TRACK',locked=False,protected=False,mode='signal',width_mm=.2,a=(1.1,2.2),b=(7.43,8.1));d.update(kw);return d
class BlockerTest(unittest.TestCase):
 def test_aggregate_hits_not_single_segment(self):
  p=plans_from_rows([row('one',3),row('two',5),row('one',4)],[],[0,0,6,6]);self.assertEqual(p[0]['net'],'one');self.assertEqual(p[0]['hits'],7)
 def test_full_endpoints_and_absolute_grid_expand(self):
  p=plans_from_rows([row()],[],[0,0,6,6])[0];self.assertEqual(p['bounds'],[0,0,8.45,9.1])
 def test_no_input_mutation(self):
  r=[row()];a=copy.deepcopy(r);plans_from_rows(r,[],[0,0,6,6]);self.assertEqual(r,a)
 def test_locks_power_planes_pairs_and_special_width_excluded(self):
  for change in [dict(locked=True),dict(protected=True),dict(mode='power'),dict(mode='plane'),dict(mode='differential'),dict(width_mm=.4),dict(kind='PCB_VIA')]:
   with self.subTest(change=change):self.assertEqual(plans_from_rows([row(**change)],[],[0,0,6,6]),[])
 def test_already_removed_net_excluded(self):self.assertEqual(plans_from_rows([row()],['renamed_signal'],[0,0,6,6]),[])
 def test_region_is_bounded_and_pool_limited(self):
  self.assertEqual(plans_from_rows([row(b=(100,8))],[],[0,0,6,6]),[])
  self.assertEqual(len(plans_from_rows([row(str(i),i+1) for i in range(5)],[],[0,0,6,6])),2)
 def test_native_ids_and_source_policy_drive_selection(self):
  b=board()
  for n in ['FIRST','SECOND']:b.Add(k.NETINFO_ITEM(b,n))
  pad(b,'X','1','FIRST',(2,2));pad(b,'Y','1','SECOND',(4,4))
  a=add_track(b,'FIRST',k.B_Cu,(1,2),(5,2),.2);c=add_track(b,'SECOND',k.B_Cu,(1,4),(5,4),.2)
  rules={'fab':{'track_width_mm':.2,'clearance_mm':.15},'diff_pairs':[{'name':'protected_pair','p':'SECOND','n':'OTHER'}]}
  p=inspect(b,rules,{'static_blockers':{uid(a):3,uid(c):100,'unknown':1000}},[],[0,0,6,6])['plans'];self.assertEqual([x['net'] for x in p],['FIRST'])
if __name__=='__main__':unittest.main()
