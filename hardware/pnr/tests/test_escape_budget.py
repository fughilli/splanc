import unittest
from unittest.mock import patch
from pnr.route.detail import layered

class EscapeBudgetTest(unittest.TestCase):
    def test_local_failure_retains_distant_escape_search(self):
        calls=[]
        def search(*args,frontier_budget,**kwargs):
            calls.append(frontier_budget)
            return layered.LayerRoute([] if frontier_budget<12000 else [(0,0,0),(0,0,1)],'no_escape_port_pair' if frontier_budget<12000 else 'routed',frontier_budget)
        with patch.object(layered,'_route_escape_ports',side_effect=search):
            result=layered.route_escape_ports()
        self.assertEqual(calls,[512,12000]);self.assertEqual(result.status,'routed');self.assertEqual(result.expanded,12512)
    def test_complete_local_route_does_not_trigger_wider_search(self):
        path=[(0,0,0),(0,0,1)]
        with patch.object(layered,'_route_escape_ports',return_value=layered.LayerRoute(path,'routed',100)) as solve:
            result=layered.route_escape_ports()
        self.assertEqual(result.path,path);self.assertEqual(solve.call_count,1)

if __name__=='__main__':unittest.main()
