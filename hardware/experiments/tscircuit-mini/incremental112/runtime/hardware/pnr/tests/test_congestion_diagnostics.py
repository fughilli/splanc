"""Ensure debug artifacts preserve coordinates, units, and observed provenance."""
import json
from pathlib import Path
import tempfile
import unittest
import xml.etree.ElementTree as ET
from types import SimpleNamespace as NS
from unittest.mock import patch
import numpy as np
from pnr.congestion_diagnostics import snapshot, svg, native_endpoints
from pnr.constraints import compile_constraints
from pnr.graph import BoardGraph, BoardOutline, Component, Pad, Net
from pnr.route.feedback import route_and_place, derive_inflation


def graph():
    return BoardGraph('debug',[Component(r,'',(x,2),0,'top',(1,1),(1,1),pads=[Pad('1','n',(0,0),(.5,.5))]) for r,x in [('A',2),('B',5)]],[Net('n',1,[('A','1'),('B','1')])],BoardOutline(10,10))


class CongestionDiagnosticsTest(unittest.TestCase):
    def test_snapshot_keeps_exact_cells_and_fixed_scale(self):
        g=graph();cell=np.zeros((4,4));cell[1,2]=3
        d=snapshot(g,{},label='test & <x>',cell=cell)
        self.assertEqual(d['feedback_cell'][1][2],3)
        root=ET.fromstring(svg(d));self.assertTrue(root.tag.endswith('svg'))
        self.assertIn('0 to 10+ units/cell',svg(d))
        cell[1,2]=300
        self.assertIn('0 to 10+ units/cell',svg(snapshot(g,{},label='high',cell=cell)))

    def test_historical_proxy_is_explicit(self):
        d=snapshot(graph(),{},label='historical',unresolved=['n'])
        self.assertIsNone(d['feedback_cell']);self.assertEqual(sum(v for _,_,v in d['endpoint_bins']),2)
        self.assertIn('Historical proxy',svg(d))

    def test_native_endpoint_transform_and_dedup(self):
        g=graph();t=dict(source='A.1',target='B.1',source_uuid='a',target_uuid='b',source_xy=[32,83],target_xy=[35,83])
        inv=dict(graph=json.loads(g.to_json()),footprint_poses={'A':[32,83,0]},targets=[t,t])
        d=native_endpoints(snapshot(g,{},label='native'),inv)
        self.assertEqual(d['endpoint_bins'],[[0,0,1],[2,0,1]])
        self.assertIn('Native unresolved terminals',svg(d))

    def test_loop_records_actual_feedback_and_applied_pressure(self):
        g=graph();cc=compile_constraints({'board':{'outline':{'w':10,'h':10}}},g.refs)
        result=NS(deferred_nets={'power'},result=NS(unrouted=['n'],nets={'n':NS(remaining_connections=1)}),failure_sites={'n':[(2,2)]},tracks=[],vias=[])
        with tempfile.TemporaryDirectory() as tmp, patch.dict('os.environ',{'PNR_ROUND_DIAGNOSTICS':tmp}),patch('pnr.route.feedback.place',return_value=(g,NS(legal=True))),patch('pnr.route.detail.router.route_board',return_value=result):
            route_and_place(g,cc,iters=1,max_rounds=2,detail_rules={})
            first=json.loads((Path(tmp)/'round-01/congestion.json').read_text())
            second=json.loads((Path(tmp)/'round-02/congestion.json').read_text())
            self.assertEqual(sum(map(sum,first['feedback_cell'])),1)
            self.assertEqual(first['metadata']['deferred_nets'],['power'])
            self.assertEqual(second['requested_inflation'],second['applied_inflation'])
            self.assertGreater(second['requested_inflation']['A'],1)
            self.assertEqual(second['metadata']['accumulation_before'],first['feedback_cell'])

    def test_current_peak_normalization_does_not_escalate(self):
        # Diagnostic characterization, not the desired future behavior. Changing
        # this policy requires its own placement/routing comparison.
        g=graph();cell=np.zeros((4,4));cell[0,0]=1
        self.assertEqual(derive_inflation(g,cell,2.5,fixed={}),derive_inflation(g,cell*10,2.5,fixed={}))

if __name__=='__main__':unittest.main()
