"""Run with native KiCad Python: moved terminals retain their existing branch."""
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
import pcbnew as k
from pnr.native_loop import native_worker
from pnr.via_coalesce import partition, preserved

class NativeMoveTest(unittest.TestCase):
    def test_translated_terminal_replaces_old_fanout(self):
        b=k.BOARD();n=k.NETINFO_ITEM(b,'signal');b.Add(n)
        for ref,x in [('A',40),('B',44)]:
            f=k.FOOTPRINT(b);f.SetReference(ref);b.Add(f);f.SetPosition(k.VECTOR2I(x*1000000,40000000))
            p=k.PAD(f);p.SetNumber('1');p.SetPosition(f.GetPosition());p.SetSize(k.VECTOR2I(800000,800000));p.SetShape(k.PAD_SHAPE_RECT);p.SetAttribute(k.PAD_ATTRIB_SMD)
            ls=k.LSET();ls.AddLayer(k.F_Cu);p.SetLayerSet(ls);p.SetNetCode(n.GetNetCode());f.Add(p)
        t=k.PCB_TRACK(b);t.SetStart(k.VECTOR2I(40000000,40000000));t.SetEnd(k.VECTOR2I(44000000,40000000));t.SetWidth(200000);t.SetLayer(k.F_Cu);t.SetNetCode(n.GetNetCode());b.Add(t)
        b.BuildConnectivity();before=partition(b)
        with tempfile.TemporaryDirectory() as d:
            d=Path(d);source=d/'before.kicad_pcb';out=d/'after.kicad_pcb';spec=d/'move.json';rules=d/'rules.json';report=d/'report.json'
            k.SaveBoard(str(source),b);spec.write_text(json.dumps(dict(ref='A',dx=0,dy=.25)));rules.write_text('{}')
            native_worker(SimpleNamespace(board=source,rules=rules,annotation_source=[],worker='move',spec=spec,out=out,report=report))
            after=k.LoadBoard(str(out));after.BuildConnectivity()
            self.assertTrue(preserved(before,partition(after)))
            r=json.loads(report.read_text());self.assertEqual(len(r['removed_tracks']),1);self.assertEqual(r['added_tracks'],2)
            self.assertEqual(next(f for f in after.GetFootprints() if f.GetReference()=='A').GetPosition().y,40250000)
            spec.write_text(json.dumps(dict(ref='A',before=str(source),moved=str(out))))
            restored=d/'restored.kicad_pcb'
            native_worker(SimpleNamespace(board=out,rules=rules,annotation_source=[],worker='unmove',spec=spec,out=restored,report=report))
            restored_board=k.LoadBoard(str(restored));restored_board.BuildConnectivity()
            self.assertTrue(preserved(before,partition(restored_board)))
            self.assertEqual(next(f for f in restored_board.GetFootprints() if f.GetReference()=='A').GetPosition().y,40000000)
            self.assertEqual([t.m_Uuid.AsString() for t in restored_board.GetTracks()],[t.m_Uuid.AsString() for t in b.GetTracks()])


if __name__=='__main__':unittest.main()
