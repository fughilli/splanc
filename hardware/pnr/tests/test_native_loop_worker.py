"""Run with native KiCad Python: moved terminals retain their existing branch."""
import os, subprocess, sys
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
            for attempt in range(5):
                target=d/('subprocess-%d.kicad_pcb'%attempt)
                log=d/('subprocess-%d.json'%attempt)
                completed=subprocess.run([sys.executable,'-m','pnr.native_loop',str(out),'--worker','unmove','--rules',str(rules),'--spec',str(spec),'--out',str(target),'--report',str(log)],capture_output=True,text=True,timeout=30,env=dict(os.environ,PYTHONHASHSEED=str(attempt),PNR_PROFILE_DIR=str(d/('profiles-%d'%attempt))))
                self.assertEqual(completed.returncode,0,completed.stdout+completed.stderr)
                self.assertEqual(json.loads(log.read_text())['restored_ref'],'A')
                profiles=list((d/('profiles-%d'%attempt)).glob('*.json'))
                self.assertEqual(len(profiles),1)
                profile=json.loads(profiles[0].read_text())
                self.assertIsNone(profile['error'])
                self.assertTrue(profile['hot_functions'])
                import pstats
                self.assertTrue(pstats.Stats(profile['profile']).stats)

                checked=k.LoadBoard(str(target))
                self.assertEqual([t.m_Uuid.AsString() for t in checked.GetTracks()],[t.m_Uuid.AsString() for t in b.GetTracks()])
                self.assertEqual([t.GetNetname() for t in checked.GetTracks()],['signal'])



if __name__=='__main__':unittest.main()
