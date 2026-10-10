import tempfile,unittest
from pathlib import Path
from unittest.mock import patch
import pcbnew as k
from test_native_electrical import board,pad,add_track
from pnr.fixed_copper import validate
class StageGateTest(unittest.TestCase):
 def test_rejects_changed_fixed_track_and_new_native_violation(self):
  b=board();pad(b,'X','1','rail',(10,10),(.6,.6));pad(b,'Y','1','rail',(11,10),(.6,.6));t=add_track(b,'rail',k.F_Cu,(10,10),(11,10),.2)
  with tempfile.TemporaryDirectory() as d:
   a,z=Path(d)/'a.kicad_pcb',Path(d)/'z.kicad_pcb';k.SaveBoard(str(a),b);k.SaveBoard(str(z),b)
   clean=dict(violations=[],unconnected_items=[])
   with patch('pnr.pad_entry.snapshot',return_value={}):
    self.assertTrue(validate(a,z,{},clean,clean)['accepted'])
    t.SetWidth(210000);k.SaveBoard(str(z),b)
    self.assertFalse(validate(a,z,{},clean,clean)['accepted'])
    t.SetWidth(200000);k.SaveBoard(str(z),b)
    bad=dict(violations=[dict(type='shorting_items',items=[],description='new short')],unconnected_items=[])
    self.assertFalse(validate(a,z,{},clean,bad)['accepted'])
 def test_final_reference_failure_rejects_unchanged_pair_copper(self):
  b=board()
  with tempfile.TemporaryDirectory() as d:
   a,z=Path(d)/'a.kicad_pcb',Path(d)/'z.kicad_pcb';k.SaveBoard(str(a),b);k.SaveBoard(str(z),b)
   clean=dict(violations=[],unconnected_items=[])
   rules={'diff_pairs':[{'name':'usb'}]};refs=[dict(pair='usb',segments=[dict(reference_paths={'Dpos':[(1,1),(2,2)]})])]
   with patch('pnr.pad_entry.snapshot',return_value={}),patch('pnr.native_electrical.pair_reference_validator',return_value=lambda paths,cap:False):
    q=validate(a,z,rules,clean,clean,refs);self.assertFalse(q['accepted']);self.assertEqual(q['reference_failures'],[dict(pair='usb',segment=0)])
    self.assertFalse(validate(a,z,dict(rules,routed_pair_references=refs),clean,clean)['accepted'])

class OuterReferenceGateTest(unittest.TestCase):
 def test_new_reference_gap_rejects_route_even_when_an_open_closes(self):
  from pnr.native_loop import gate
  before=dict(violations=[],unconnected_items=[{}]);after=dict(violations=[],unconnected_items=[])
  checks=dict(preserved=True,lost_pad_entries=[])
  self.assertTrue(gate(before,after,checks))
  self.assertFalse(gate(before,after,dict(checks,reference_failures=[dict(pair='usb',segment=0)])))
