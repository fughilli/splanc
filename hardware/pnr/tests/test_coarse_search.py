import unittest
from pnr.native_loop import route_search_pitch
from pnr.route.detail.keyhole import route
from pnr.route.detail.regional import segment_distance

class CoarseSearchTest(unittest.TestCase):
    def test_broad_detour_fits_search_budget_before_fine_retry(self):
        obstacle=[((4,-1),(6,-1)),((6,-1),(6,1)),((6,1),(4,1)),((4,1),(4,-1))]
        def clear(a,b):
            return all(segment_distance(a,b,c,d)>.15 for c,d in obstacle) and not (4<=a[0]<=6 and -1<=a[1]<=1)
        coarse=route([(0,0)],[(10,0)],(-1,-3,11,3),clear,pitch=route_search_pitch(1),max_expansions=6000)
        fine=route([(0,0)],[(10,0)],(-1,-3,11,3),clear,pitch=route_search_pitch(4),max_expansions=6000)
        self.assertEqual(coarse.status,'routed')
        self.assertEqual(coarse.path[0],(0,0));self.assertEqual(coarse.path[-1],(10,0))
        self.assertTrue(all(clear(a,b) for a,b in zip(coarse.path,coarse.path[1:])))
        self.assertEqual(fine.status,'search_budget')
        self.assertEqual([route_search_pitch(i) for i in range(1,6)],[.25,.15,.1,.05,.05])
if __name__=='__main__':unittest.main()
