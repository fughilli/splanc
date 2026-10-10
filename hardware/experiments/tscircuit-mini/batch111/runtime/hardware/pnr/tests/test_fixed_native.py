import json,tempfile,unittest
from pathlib import Path
import pcbnew as k
from test_native_electrical import board,pad,add_track
from pnr.fixed_copper import export,append,extract
class FixedNativeTest(unittest.TestCase):
 def test_export_append_preserves_frame_geometry_and_source(self):
  b=board();pad(b,'X','1','rail',(103,207),(.6,.6));pad(b,'Y','1','rail',(110,210),(.6,.6));t=add_track(b,'rail',k.F_Cu,(103,207),(104,207),.2)
  v=k.PCB_VIA(b);v.SetPosition(k.VECTOR2I(104000000,207000000));v.SetFrontWidth(600000);v.SetDrill(300000);v.SetViaType(k.VIATYPE_THROUGH);v.SetLayerPair(k.F_Cu,k.B_Cu);v.SetNetCode(b.FindNet('rail').GetNetCode());b.Add(v)
  with tempfile.TemporaryDirectory() as d:
   p=Path(d);source=p/'source.kicad_pcb';k.SaveBoard(str(source),b);source.with_suffix('.kicad_pro').write_text('{}');original=source.read_bytes();export(source,p/'export');fixed=json.loads((p/'export/fixed.json').read_text());self.assertEqual(fixed['vias'][0]['diameter_mm'],.6)
   net,layer,a,z,w=fixed['tracks'][0];routes=dict(tracks=[[net,'B.Cu',z,[z[0]+2,z[1]],.2]],vias=[]);out=p/'out.kicad_pcb';append(source,fixed,routes,{'fab':{'via_diameter_mm':.6,'via_drill_mm':.3}},out)
   self.assertEqual(source.read_bytes(),original);saved=k.LoadBoard(str(out));tracks=list(saved.GetTracks());self.assertEqual(len(tracks),3)
   new=next(x for x in tracks if x.GetClass()=='PCB_TRACK' and x.GetLayer()==k.B_Cu);self.assertEqual((new.GetStart().x,new.GetStart().y),(104000000,207000000));self.assertEqual((new.GetEnd().x,new.GetEnd().y),(106000000,207000000))
   self.assertTrue(any(x.m_Uuid.AsString()==t.m_Uuid.AsString() for x in tracks))
   with self.assertRaises(ValueError):append(source,dict(fixed,source_sha256='stale'),routes,{'fab':{}},p/'bad.kicad_pcb')
