import unittest
from unittest.mock import patch
from pnr.route.detail.joint import solve_joint_region, conflicts
from pnr.route.detail.layered import LayerRoute
from pnr.route.detail.regional import Request

class CompleteTransactionTest(unittest.TestCase):
    def test_feasible_child_survives_sibling_deadline(self):
        requests=[Request("a","a",[(0,0)],[(4,0)]),Request("b","b",[(2,-1)],[(2,1)])]
        paths=[[(0,0,0),(4,0,0)],[(2,-1,0),(2,1,0)],
               [(0,0,0),(0,0,1),(4,0,1),(4,0,0)]]
        clock=[0.]
        calls=[]
        def search(*args,**kwargs):
            calls.append(1)
            if len(calls)>3:
                clock[0]=11.
                return LayerRoute([],"time_budget")
            clock[0]+=1.
            return LayerRoute(paths[len(calls)-1],"routed")
        with patch("pnr.route.detail.joint.route_layers",side_effect=search),patch("time.monotonic",side_effect=lambda:clock[0]):
            result=solve_joint_region(requests,(-1,-2,5,2),lambda *a:True,lambda *a:True,max_seconds=10)
        self.assertEqual(result.status,"routed")
        self.assertFalse(conflicts(requests,result.paths))
        self.assertEqual(len(calls),3)

if __name__=="__main__":unittest.main()
