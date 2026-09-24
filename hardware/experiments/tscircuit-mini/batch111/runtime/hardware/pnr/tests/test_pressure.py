import unittest
from types import SimpleNamespace as NS
from pnr.route.detail.grid import Cell,RouteGrid
from pnr.route.detail.pressure import disconnected_pairs,corridor,localized_pressure
from pnr.route.feedback import detail_congestion

class PressureTest(unittest.TestCase):
    def test_connected_branch_not_recharged_and_layers_not_merged(self):
        a,b,c=Cell(0,1,1),Cell(0,2,1),Cell(1,1,1)
        rn=NS(segments=[(0,(1,1),(2,1))],vias=[])
        self.assertEqual(len(disconnected_pairs([a,b,c],rn)),1)
        rn.vias=[(1,1)];rn.segments.append((1,(1,1),(1,2)))
        self.assertEqual(disconnected_pairs([a,b,c],rn),[])

    def test_via_only_connection_does_not_create_phantom_missing_pair(self):
        a,b=Cell(0,1,1),Cell(1,1,1)
        self.assertEqual(disconnected_pairs([a,b],NS(segments=[],vias=[(1,1)])),[])

    def test_blocking_wall_localizes_pressure_without_painting_net_box(self):
        grid=RouteGrid(10,10,1,layers=('F.Cu',));grid.blocked[0,:,5]=True
        a,b=Cell(0,1,5),Cell(0,8,5)
        rn=NS(cells=[],segments=[],vias=[])
        result=NS(unrouted=['n'],nets={'n':rn})
        events=localized_pressure(grid,{'n':[a,b]},result)
        self.assertEqual(events[0]['kind'],'obstructed_corridor')
        self.assertTrue(all(x==5.5 for x,y in events[0]['points']))
        board=NS(pressure_events=events)
        pressure=detail_congestion(board,None,10,10,1)
        self.assertAlmostEqual(pressure.sum(),1.)
        self.assertEqual((pressure>0).sum(),1)

    def test_open_corridor_and_budget_are_not_false_blockers(self):
        grid=RouteGrid(10,10,1,layers=('F.Cu',));a,b=Cell(0,1,5),Cell(0,8,5)
        self.assertEqual(corridor(grid,a,b,'n',{}),([],False))
        self.assertEqual(corridor(grid,a,b,'n',{},budget=1),([],True))
        rn=NS(cells=[],segments=[],vias=[]);result=NS(unrouted=['n'],nets={'n':rn})
        event=localized_pressure(grid,{'n':[a,b]},result)[0]
        self.assertEqual(event['kind'],'disconnected_terminals');self.assertEqual(len(event['points']),2)
        self.assertEqual(localized_pressure(grid,{'n':[a,b]},result,{'n'}),[])

if __name__=='__main__':unittest.main()
