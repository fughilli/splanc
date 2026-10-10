import unittest
from unittest.mock import patch
from pnr.route.detail import layered

class LayerBudgetTest(unittest.TestCase):
    def run_case(self, required_budget):
        calls=[];active=[]
        def clear(layer,a,b):
            active.append(layer);return True
        def bridge(sources,targets,bounds,check,*,pitch,budget):
            check(sources[0],targets[0]);layer=active[-1];calls.append((layer,budget))
            path=[sources[0],targets[0]] if layer==1 and budget>=required_budget else []
            return layered.LayerRoute(path,'routed' if path else 'search_budget',budget)
        def frontier(points,*args):return {tuple(points[0]):[tuple(points[0])]},1
        with patch.object(layered,'escape_frontier',side_effect=frontier),patch.object(layered,'route_bridge',side_effect=bridge):
            result=layered.route_escape_ports([(0.,0.)],[(2.,0.)],(-1,-1,3,1),clear,lambda p:True,lambda p:(0,),pitch=.1,layers=2,budget=9000,max_vias=2)
        self.assertEqual(result.status,'routed')
        self.assertEqual(result.path[0],(0.,0.,0));self.assertEqual(result.path[-1],(2.,0.,0))
        return calls
    def test_other_layer_before_exhausting_first(self):
        self.assertEqual(self.run_case(3000),[(0,3000),(1,3000)])
    def test_full_budget_fallback_retained(self):
        self.assertEqual(self.run_case(9000),[(0,3000),(1,3000),(0,9000),(1,9000)])

if __name__=='__main__':unittest.main()
