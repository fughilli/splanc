"""Electrical geometry contracts: current budgets, source identity and coupling."""
import math,tempfile,unittest
from pathlib import Path
from types import SimpleNamespace as NS
from pnr.electrical import current_width,compile_policy,resolve_currents,net_policy,terminal_policy,neck_budget
from pnr.constraints import NetClass
from pnr.route.detail.coupled import solve_pair,offset_path,tune,geometry_ok,path_metrics
from pnr.route.detail.keyhole import length
from pnr.native_electrical import bank_points

FAB=dict(outer_copper_oz=1,inner_copper_oz=1,delta_t_c=40,via_drill_mm=.3,via_diameter_mm=.6,min_via_plating_um=20,board_thickness_mm=1.6,copper_resistivity_ohm_mm=2.1e-5,via_barrel_loss_budget_w=.01,via_array_peak_drop_v=.01)
class ElectricalTest(unittest.TestCase):
    def test_current_copper_temperature_and_inner_layer(self):
        w=current_width(5,1,40)
        self.assertGreater(w,1);self.assertLess(w,1.5)
        self.assertAlmostEqual(current_width(5,2,40),w/2)
        self.assertGreater(current_width(5,1,40,False),2*w)
        self.assertGreater(current_width(5,1,10),w)
        self.assertGreater(NetClass('x',width_mm=.2,current_a=5).resolved_width_mm(.2),.2)
        for v in (0,-1,float('nan'),float('inf')):
            with self.assertRaises(ValueError):current_width(v,1,40)
    def test_source_identity_and_layer_via_capacity(self):
        a=dict(target='supply',pads=['1'],rms_current_a=5,peak_current_a=16,source={'line':1})
        cs=[NS(ref='RENAMED',address='board.supply._p',pads=[NS(name='1',net='renamed-net')])]
        r=resolve_currents([a],cs);self.assertEqual(r[0]['ref'],'RENAMED')
        p=compile_policy(dict(fab={'track_width_mm':.2},net_classes=[]),r,FAB)
        n=net_policy('renamed-net',p)
        self.assertGreater(n['inner_width_mm'],n['outer_width_mm']);self.assertGreater(n['via_array']['count'],1)
        self.assertEqual(n['sources'],[{'line':1}])
        with self.assertRaises(ValueError):resolve_currents([a],cs*2)
        self.assertFalse(net_policy('unknown',p)['current_known'])
    def test_bank_uses_hole_clearance(self):
        pts=bank_points((0,0),5,.6,.3,.4)
        self.assertEqual(len(pts),5)
        self.assertGreaterEqual(min(math.dist(a,b) for i,a in enumerate(pts) for b in pts[i+1:]),.702-1e-9)

    def test_group_subset_retains_entire_source_current_budget(self):
        records=[dict(ref='X',net='rail',pads=['1','2'],scope='terminal',rms_current_a=2,peak_current_a=3)]
        rules=dict(electrical_fab=FAB,current_intents=records,net_classes=[dict(nets=['rail'],width_mm=1.5)],fab={'track_width_mm':.2})
        whole=terminal_policy('X',['1','2'],'rail',rules)
        for pins in (['1'],['2'],['1','2']):
            p=terminal_policy('X',pins,'rail',rules)
            self.assertEqual(p['rms_current_a'],2)
            self.assertEqual(p['peak_current_a'],3)
            self.assertEqual(p['outer_width_mm'],whole['outer_width_mm'])
        self.assertIsNone(terminal_policy('X',['1','3'],'rail',rules))
        self.assertEqual(net_policy('rail',rules)['outer_width_mm'],1.5)
    def test_coupled_pair_not_two_independent_routes(self):
        terminals={'p':((0,.2),(10,.2)),'n':((0,-.2),(10,-.2))}
        r=solve_pair('p','n',terminals,(-1,-2,11,2),lambda *args:True,lambda *args:True,.2,.2,.1)
        self.assertEqual(r['status'],'routed');self.assertAlmostEqual(r['lengths']['p'],r['lengths']['n'])
        self.assertTrue(geometry_ok(r['paths'],.2,.2,lambda *args:True))
        blocked=solve_pair('p','n',terminals,(-1,-2,11,2),lambda *args:False,lambda *args:False,.2,.2,.1)
        self.assertNotEqual(blocked['status'],'routed')
    def test_length_tuning_accounts_for_existing_lead_length(self):
        paths={'p':[(0,.2),(10,.2)],'n':[(0,-.2),(10,-.2)]}
        tuned=tune(paths,.2,.2,.05,lambda *args:True,{'n':1})
        self.assertIsNotNone(tuned)
        self.assertLessEqual(abs(length(tuned['p'])-length(tuned['n'])-1),.05)
        self.assertGreater(length(tuned['p']),10)
        self.assertTrue(geometry_ok(tuned,.2,.2,lambda *args:True))
        self.assertIsNone(tune(paths,.2,.2,.05,lambda *args:False,{'n':1}))
    def test_offset_rejects_reversing_or_consumed_bends(self):
        with self.assertRaises(ValueError):offset_path([(0,0),(1,0),(0,0)],.2)
        with self.assertRaises(ValueError):offset_path([(0,0),(.1,0),(.1,.1)],.3)

class PathTimingTest(unittest.TestCase):
    def test_branches_do_not_fake_a_matched_endpoint_path(self):
        r=path_metrics([(0,(0,0),(10,0)),(0,(5,0),(5,20))],[],((0,0),0),((10,0),0))
        self.assertTrue(r['valid']);self.assertEqual(r['length_mm'],10);self.assertGreater(r['branch_vertices'],0)
        disconnected=path_metrics([(0,(0,0),(4,0)),(0,(6,0),(10,0))],[],((0,0),0),((10,0),0))
        self.assertFalse(disconnected['connected'])
    def test_cycles_are_ambiguous_and_via_travel_is_not_free(self):
        tracks=[(0,(0,0),(5,0)),(1,(5,0),(10,0))]
        r=path_metrics(tracks,[((5,0),[0,1])],((0,0),0),((10,0),1),layer_heights={0:0,1:1.6})
        self.assertAlmostEqual(r['length_mm'],11.6)
        self.assertFalse(path_metrics(tracks,[((5,0),[0,1])],((0,0),0),((10,0),1))['connected'])
        r=path_metrics([(0,(0,0),(10,0)),(0,(0,0),(5,5)),(0,(5,5),(10,0))],[],((0,0),0),((10,0),0))
        self.assertFalse(r['valid']);self.assertEqual(r['reason'],'ambiguous_cycle')
    def test_terminal_budget_and_neck_do_not_erase_trunk_current(self):
        fab=dict(FAB,neck_loss_budget_w=.01,neck_peak_drop_v=.005)
        records=[dict(ref='X',net='rail',pads=['1'],scope='terminal',rms_current_a=2,peak_current_a=2,neck_max_length_mm=.5)]
        rules=dict(electrical_fab=fab,current_intents=records,net_classes=[dict(nets=['rail'],width_mm=1.5)],fab={'track_width_mm':.2})
        p=terminal_policy('X',['1'],'rail',rules)
        self.assertLess(p['outer_width_mm'],.5)
        self.assertEqual(net_policy('rail',rules)['outer_width_mm'],1.5)
        self.assertIsNone(terminal_policy('X',['1','2'],'rail',rules))
        self.assertIsNotNone(neck_budget(p,.25,.4,fab))
        self.assertIsNone(neck_budget(p,.25,.8,fab))
        self.assertIsNone(neck_budget(dict(p,rms_current_a=20),.25,.4,fab))

if __name__=='__main__':unittest.main()
