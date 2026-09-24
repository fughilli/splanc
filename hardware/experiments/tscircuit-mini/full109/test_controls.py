import os,tempfile,unittest
from pathlib import Path
from pnr.runtime_controls import DEFAULTS,validate,write,read,route_workers
from pnr.route.detail.parallel import NetPool
from pnr.route.detail.grid import RouteGrid,Cell
class Tests(unittest.TestCase):
 def test_bounds_and_stale_updates(self):
  with tempfile.TemporaryDirectory() as tmp:
   path=Path(tmp)/'controls.json';a=write(path,DEFAULTS,0);self.assertEqual(a,read(path))
   with self.assertRaises(ValueError):write(path,DEFAULTS,0)
   for bad in [dict(DEFAULTS,route_workers=0),dict(DEFAULTS,route_workers=True),dict(DEFAULTS,k=1),dict(DEFAULTS,route_workers=8,candidate_workers=4)]:
    with self.assertRaises(ValueError):validate(bad)
 def test_resize_and_active_candidate_cap(self):
  with tempfile.TemporaryDirectory() as tmp:
   old=dict(os.environ);path=Path(tmp)/'control.json';os.environ['PNR_CONTROL_FILE']=str(path);os.environ['PNR_CANDIDATE_WORKERS']='4'
   try:
    write(path,dict(DEFAULTS,route_workers=8,candidate_workers=2));self.assertEqual(route_workers('test'),4)
    write(path,dict(DEFAULTS,route_workers=1));g=RouteGrid(4,4,1);pool=NetPool(g,1)
    try:
     access={'A':[Cell(0,0,0),Cell(0,3,0)],'B':[Cell(0,0,3),Cell(0,3,3)]}
     for count in [1,2,1]:
      write(path,dict(DEFAULTS,route_workers=count));self.assertEqual(pool.configure(),count)
      result=pool.batch(['A','B'],access,{},{},3,.5);self.assertTrue(all(r and r.edges for r in result))
    finally:pool.close()
   finally:os.environ.clear();os.environ.update(old)
if __name__=='__main__':unittest.main()
