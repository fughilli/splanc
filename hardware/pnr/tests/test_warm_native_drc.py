import json,tempfile,unittest
from pathlib import Path
from unittest.mock import patch
from pnr.drc_warm.report import parse,UnsupportedReport
from pnr.drc_warm.model import split_board
from pnr.drc_warm.client import run_drc

class Contract(unittest.TestCase):
 def test_track_edit_does_not_change_static_model(self):
  a='(kicad_pcb (net 1 "VCC") (footprint "f" (at 1 2)) (segment (start 1 2) (uuid "u")))'
  b=a.replace('(start 1 2)','(start 1 3)')
  self.assertEqual(split_board(a)[0],split_board(b)[0]);self.assertNotEqual(split_board(a)[1],split_board(b)[1])
 def test_non_copper_and_quoted_whitespace_invalidate(self):
  a='(kicad_pcb (gr_text ")  (" (at 1 2)) (footprint "f" (at 3 4)))'
  self.assertNotEqual(split_board(a)[0],split_board(a.replace(')  (',') ('))[0])
  self.assertNotEqual(split_board(a)[0],split_board(a.replace('(at 3 4)','(at 3 5)'))[0])
 def test_malformed_or_duplicate_uuid_rejected(self):
  for s in ('(kicad_pcb (segment))','(kicad_pcb','(kicad_pcb (segment (uuid "a")) (segment (uuid "a")))'):
   with self.assertRaises(ValueError):split_board(s)
 def test_incomplete_report_rejected(self):
  with self.assertRaises(UnsupportedReport):parse('** Found 0 DRC violations **',{})
 def test_count_mismatch_rejected(self):
  with self.assertRaises(UnsupportedReport):parse('** Found 1 DRC violations **\n** Found 0 unconnected pads **\n** Found 0 Footprint errors **\n** End of Report **',{})
 def test_final_gate_forces_cli(self):
  with tempfile.TemporaryDirectory() as d,patch('pnr.native_drc._run_cold',return_value={'cold':True}) as cold,patch('pnr.drc_warm.client.warm') as hot:
   self.assertEqual(run_drc('cli','board',Path(d)/'report',service='host',final=True),{'cold':True});hot.assert_not_called();cold.assert_called_once()
 def test_failures_fall_back_without_stale_report(self):
  for error in (TimeoutError('deadline'),ValueError('bad reply'),RuntimeError('worker crash')):
   with tempfile.TemporaryDirectory() as d,patch('pnr.native_drc._run_cold') as cold,patch('pnr.drc_warm.client.warm',side_effect=error):
    report=Path(d)/'report.json';report.write_text('stale')
    def check(*args,**kwargs):self.assertFalse(report.exists());return {'cold':True}
    cold.side_effect=check;self.assertEqual(run_drc('cli','board',report,service='host'),{'cold':True});self.assertTrue(report.with_suffix('.warm-fallback.json').exists())
 def test_nonzero_findings_force_original_cli_report(self):
  with tempfile.TemporaryDirectory() as d,patch('pnr.native_drc._run_cold',return_value={'cold':True}),patch('pnr.drc_warm.client.warm',return_value=dict(violations=[{}],unconnected_items=[],schematic_parity=[])):
   self.assertEqual(run_drc('cli','board',Path(d)/'report.json',service='host'),{'cold':True})
 def test_snapshot_budget_fails_before_copying_another_board(self):
  from pnr.drc_warm.client import warm
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'boards').mkdir();(root/'ready.json').write_text(json.dumps({'version':'10.0.6'}))
   for i in range(64):(root/'boards'/str(i)).mkdir()
   with self.assertRaisesRegex(ValueError,'snapshot budget'):warm('missing-board',root)
   self.assertEqual(len(list((root/'boards').iterdir())),64)
 def test_ambiguous_open_requires_exact_same_endpoint_net_and_layer(self):
  header='** Found 0 DRC violations **\n** Found 1 unconnected pads **\n[unconnected_items]: Open\nRule; error\n@(1.0000 mm, 2.0000 mm): Track\n** Found 0 Footprint errors **\n** End of Report **'
  a=dict(uuid='a',description='Track',pos={'x':1,'y':2},_anchor=(1000000,2000000),_kind='PCB_TRACK',_net=1,_layer=0)
  b=dict(a,uuid='b');index={('1.0000','2.0000','Track'):{'a':a,'b':b}}
  item=parse(header,index)['unconnected_items'][0]['items'][0]
  self.assertEqual(item['equivalent_track_uuids_at_exact_shared_endpoint'],['a','b'])
  for key,value in (('_anchor',(1000001,2000000)),('_net',2),('_layer',1),('_kind','PCB_VIA')):
   index[('1.0000','2.0000','Track')]['b']=dict(b,**{key:value})
   with self.assertRaises(UnsupportedReport):parse(header,index)
 def test_ambiguous_violation_is_never_accepted(self):
  report='** Found 1 DRC violations **\n[shorting_items]: Short\nRule; error\n@(1.0000 mm, 2.0000 mm): Track\n** Found 0 unconnected pads **\n** Found 0 Footprint errors **\n** End of Report **'
  a=dict(uuid='a',description='Track',pos={'x':1,'y':2},_anchor=(1000000,2000000),_kind='PCB_TRACK',_net=1,_layer=0)
  with self.assertRaises(UnsupportedReport):parse(report,{('1.0000','2.0000','Track'):{'a':a,'b':dict(a,uuid='b')}})
if __name__=='__main__':unittest.main()
