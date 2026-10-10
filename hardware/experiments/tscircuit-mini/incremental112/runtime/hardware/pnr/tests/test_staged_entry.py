import json,tempfile,unittest
from pathlib import Path
import pcbnew as k
from test_native_electrical import board,pad
from pnr.fixed_copper import export,append
from pnr.ingest import _board_frame
from pnr.pad_entry import snapshot
class StagedEntryTest(unittest.TestCase):
 def test_grazing_contact_gets_center_branch_without_mutating_source(self):
  b=board();pad(b,'X','1','rail',(10,10),(.6,.6));pad(b,'Y','1','rail',(12,10.35),(.6,.6))
  rules={'fab':{'via_diameter_mm':.6,'via_drill_mm':.3,'clearance_mm':.15}}
  with tempfile.TemporaryDirectory() as d:
   r=Path(d);a=r/'source.kicad_pcb';z=r/'result.kicad_pcb';k.SaveBoard(str(a),b);a.with_suffix('.kicad_pro').write_text('{}');original=a.read_bytes();export(a,r/'export');f=json.loads((r/'export/fixed.json').read_text());frame,_=_board_frame(b)
   point=lambda x,y:frame.point(round(x*1e6),round(y*1e6))
   append(a,f,{'tracks':[['rail','F.Cu',point(9,10.35),point(12,10.35),.2]],'vias':[]},rules,z)
   self.assertEqual(original,a.read_bytes());report=json.loads(z.with_suffix('.entry-repair.json').read_text());self.assertEqual(report['entry_repairs']['added'][0]['pad'],'X.1');self.assertFalse(report['new_bad_entries']);self.assertFalse(report['lost_pad_entries']);self.assertTrue(all(snapshot(k.LoadBoard(str(z)),rules).values()))
