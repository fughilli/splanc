import math,unittest
from pnr.route.detail.coupled import route_directional
from pnr.route.detail.keyhole import route,legal
from pnr.route.detail.regional import segment_distance
class DirectionalGridTest(unittest.TestCase):
    def test_exact_leads_reach_grid_without_violating_terminal_heading(self):
        a,z=(.07,.13),(10.07,5.13);bounds=(-.1,-2,12,8)
        def clear(x,y):
            for point,direction in ((a,1),(z,-1)):
                if segment_distance(x,y,point,point)<2:
                    if any(abs(q[1]-point[1])>1e-7 or direction*(q[0]-point[0]) < -1e-7 for q in (x,y)):return False
            for x0,y0,x1,y1 in [(3,-1,4,2.5),(6,3,7,7)]:
                if x0<=x[0]<=x1 and y0<=x[1]<=y1:return False
                corners=[(x0,y0),(x1,y0),(x1,y1),(x0,y1),(x0,y0)]
                if any(segment_distance(x,y,c,d)<.45 for c,d in zip(corners,corners[1:])):return False
            return True
        original=route([a],[z],bounds,clear,pitch=.2,max_expansions=20000)
        self.assertEqual(original.status,'terminal_escape_blocked')
        fixed=route_directional(a,z,(1,0),(1,0),bounds,clear,.2,2,20000)
        self.assertEqual(fixed.status,'routed');self.assertTrue(legal(fixed.path,clear))
        self.assertEqual(fixed.path[0],a);self.assertEqual(fixed.path[-1],z)
        self.assertGreater(len(fixed.path),4)
if __name__=='__main__':unittest.main()
