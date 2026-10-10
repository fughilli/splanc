"""Regression for one barrel serving three layers, without sacrificing branches."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from pnr.via_coalesce import acceptable

NATIVE = importlib.util.find_spec('pcbnew') is not None


@unittest.skipUnless(NATIVE, 'requires native KiCad Python')
class ViaCoalesceTests(unittest.TestCase):
    def fixture(self):
        import pcbnew as k
        from pnr.via_coalesce import vec
        b = k.BOARD(); b.SetCopperLayerCount(4)
        n = k.NETINFO_ITEM(b, 'aux'); b.Add(n)
        def via(p):
            v = k.PCB_VIA(b); v.SetPosition(vec(p)); v.SetViaType(k.VIATYPE_THROUGH)
            v.SetLayerPair(k.F_Cu, k.B_Cu); v.SetWidth(600000); v.SetDrill(300000)
            v.SetNetCode(n.GetNetCode()); b.Add(v)
            return v
        def track(a, z, la, width=0.2):
            t = k.PCB_TRACK(b); t.SetStart(vec(a)); t.SetEnd(vec(z)); t.SetLayer(la)
            t.SetWidth(round(width*1e6)); t.SetNetCode(n.GetNetCode()); b.Add(t)
            return t
        # Renamed, translated U18-like topology: survivor is inside a segment.
        keep, remove = via((8, 7.7)), via((8.5, 8.2))
        track((7.55, 6.5), (7.55, 7.25), k.F_Cu)
        tail = track((7.55, 7.25), (8.5, 8.2), k.F_Cu)
        track((8, 7.7), (9, 6.7), k.In2_Cu)
        track((8.5, 8.2), (9.5, 9.2), k.B_Cu)
        for num, p, la in [('1', (7.55, 6.5), k.F_Cu), ('2', (9, 6.7), k.In2_Cu), ('3', (9.5, 9.2), k.B_Cu)]:
            f = k.FOOTPRINT(b); f.SetReference('X'+num); b.Add(f)
            pad = k.PAD(f); pad.SetNumber(num); pad.SetShape(k.PAD_SHAPE_RECT)
            pad.SetSize(vec((.5, .5))); pad.SetPosition(vec(p)); pad.SetAttribute(k.PAD_ATTRIB_SMD)
            ls = k.LSET(); ls.AddLayer(la); pad.SetLayerSet(ls); pad.SetNetCode(n.GetNetCode()); f.Add(pad)
        b.BuildConnectivity()
        return b, keep, remove, tail, track

    def test_overlapping_annuli_do_not_replace_surviving_layer_bridges(self):
        import pcbnew as k
        from pnr.via_coalesce import plan, apply, partition, preserved, vec
        b,keep,remove,tail,track=self.fixture()
        # Keep annuli overlapping, but track endpoints outside the survivor pad.
        keep.SetPosition(vec((8,7.7)))
        remove.SetPosition(vec((8.5,7.95)))
        tail.SetEnd(remove.GetPosition())
        for t in b.GetTracks():
            if t.GetClass()=='PCB_TRACK' and t.GetLayer()==k.B_Cu:
                t.SetStart(remove.GetPosition())
        b.BuildConnectivity();before=partition(b)
        proposal=plan(b,keep,remove,{})
        self.assertTrue(any(t['layer']==k.B_Cu for t in proposal['additions']))
        apply(b,proposal)
        self.assertTrue(preserved(before,partition(b)))
        self.assertEqual(sum(t.GetClass()=='PCB_VIA' for t in b.GetTracks()),1)

    def test_trial_worker_exits_cleanly_after_releasing_borrowed_tracks(self):
        import pcbnew as k
        import subprocess,sys
        b,keep,remove,_,_=self.fixture()
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);source=root/'board.kicad_pcb'
            k.SaveBoard(str(source),b)
            rules=root/'rules.json';rules.write_text('{}')
            report=root/'report.json';out=root/'candidate.kicad_pcb'
            result=subprocess.run([sys.executable,'-m','pnr.via_coalesce',str(source),
                '--worker','trial','--rules',str(rules),'--report',str(report),
                '--out',str(out),'--keep',keep.m_Uuid.AsString(),
                '--remove',remove.m_Uuid.AsString()],capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertIn('proposal',json.loads(report.read_text()))
            reloaded=k.LoadBoard(str(out))
            self.assertEqual(sum(t.GetClass()=='PCB_VIA' for t in reloaded.GetTracks()),1)

    def test_three_layers_share_one_via_and_midsegment_tail_is_trimmed(self):
        from pnr.via_coalesce import plan, apply, partition, preserved, candidates
        b, keep, remove, tail, _ = self.fixture()
        before = partition(b)
        p = plan(b, keep, remove, {})
        self.assertEqual(len(p['additions']), 1)
        self.assertEqual(len(p['trims']), 1)
        apply(b, p)
        self.assertTrue(preserved(before, partition(b)))
        self.assertEqual(sum(t.GetClass() == 'PCB_VIA' for t in b.GetTracks()), 1)
        self.assertEqual(tail.GetEnd(), keep.GetPosition())
        self.assertEqual(candidates(b, {}, [])[0], [])
        # Persist/reload verifies repeatability across native process boundaries.
        import pcbnew
        with tempfile.TemporaryDirectory() as d:
            path = str(Path(d)/'saved.kicad_pcb'); pcbnew.SaveBoard(path, b)
            reloaded = pcbnew.LoadBoard(path); reloaded.BuildConnectivity()
            self.assertEqual(candidates(reloaded, {}, [])[0], [])
            self.assertTrue(preserved(before, partition(reloaded)))

    def test_coalescence_then_graph_cleanup_preserves_three_layer_branches(self):
        import pcbnew as k
        from pnr.via_coalesce import plan, apply, partition, preserved
        from pnr.track_graph import cycle_candidates, apply_cycle
        b, north, south, tail, track = self.fixture()
        track((7.55, 6.5), (8, 6.95), k.F_Cu)
        track((8, 6.95), (8, 7.7), k.F_Cu)
        b.BuildConnectivity(); before = partition(b)
        apply(b, plan(b, south, north, {}))
        choices = cycle_candidates(b, {}, [])
        self.assertEqual(len(choices), 1)
        self.assertEqual(len(choices[0]['remove_tracks']), 2)
        removed = apply_cycle(b, choices[0])
        self.assertTrue(preserved(before, partition(b)))
        self.assertEqual(sum(t.GetClass() == 'PCB_VIA' for t in b.GetTracks()), 1)
        self.assertEqual(cycle_candidates(b, {}, []), [])

    def test_obstructed_layer_bridge_rejected(self):
        import pcbnew as k
        from pnr.via_coalesce import plan
        b, keep, remove, _, track = self.fixture()
        other = k.NETINFO_ITEM(b, 'obstacle'); b.Add(other)
        track((7.6, 8.0), (8.8, 8.0), k.B_Cu).SetNetCode(other.GetNetCode())
        with self.assertRaisesRegex(ValueError, 'blocked layer'):
            plan(b, keep, remove, {})

    def test_width_not_necked_and_locked_port_rejected(self):
        import pcbnew as k
        from pnr.via_coalesce import plan
        b, keep, remove, _, _ = self.fixture()
        t = next(t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK' and t.GetLayer() == k.B_Cu)
        t.SetWidth(400000)
        self.assertEqual(plan(b, keep, remove, {})['additions'][0]['width_mm'], .4)
        t.SetLocked(True)
        with self.assertRaisesRegex(ValueError, 'locked'):
            plan(b, keep, remove, {})

    def test_differential_plane_and_power_classes_excluded(self):
        from pnr.via_coalesce import candidates
        b, *_ = self.fixture()
        self.assertTrue(candidates(b, {}, [])[0])
        for rules in [{'diff_pairs':[{'p':'aux','n':'other'}]},
                      {'net_classes':[{'nets':['aux'],'width_mm':.8}]},
                      {'net_classes':[{'nets':['aux'],'plane_layer':'In1.Cu'}]}]:
            self.assertEqual(candidates(b, rules, [])[0], [])

    def test_source_current_array_excluded_after_ref_rename(self):
        from pnr.via_coalesce import candidates
        import pcbnew as k
        b, *_ = self.fixture()
        f = next(f for f in b.GetFootprints() if f.GetReference() == 'X1')
        field = k.PCB_FIELD(f, k.FIELD_T_USER, 'atopile_address'); field.SetText('board.any_driver._p'); f.Add(field)
        f.SetReference('RENAMED987')
        with tempfile.TemporaryDirectory() as d:
            source=Path(d)/'source.ato'
            source.write_text('# @pnr-plane-access '+json.dumps(dict(kind='power_array',target='any_driver',pads=['1'],rms_current_a=5,peak_current_a=16))+'\n')
            self.assertEqual(candidates(b, {}, [source])[0], [])

    def test_removing_required_branch_fails_native_partition(self):
        import pcbnew as k
        from pnr.via_coalesce import partition, preserved
        b, keep, remove, _, _ = self.fixture()
        before = partition(b)
        t = next(t for t in b.GetTracks() if t.GetClass() == 'PCB_TRACK' and t.GetLayer() == k.B_Cu)
        b.Remove(t); b.BuildConnectivity()
        self.assertFalse(preserved(before, partition(b)))

    def test_locked_or_blind_via_and_smaller_survivor_rejected(self):
        import pcbnew as k
        from pnr.via_coalesce import plan
        b, keep, remove, _, _ = self.fixture()
        keep.SetLocked(True)
        with self.assertRaisesRegex(ValueError, 'locked'):
            plan(b, keep, remove, {})
        keep.SetLocked(False); keep.SetViaType(k.VIATYPE_BLIND)
        with self.assertRaisesRegex(ValueError, 'span'):
            plan(b, keep, remove, {})
        keep.SetViaType(k.VIATYPE_THROUGH); keep.SetDrill(200000)
        with self.assertRaisesRegex(ValueError, 'smaller'):
            plan(b, keep, remove, {})

    def test_nearby_unconnected_vias_are_not_candidates(self):
        import pcbnew as k
        from pnr.via_coalesce import candidates
        b, keep, remove, _, _ = self.fixture()
        for t in list(b.GetTracks()):
            if t.GetClass() == 'PCB_TRACK' and t.GetLayer() == k.F_Cu: b.Remove(t)
        self.assertEqual(candidates(b, {}, [])[0], [])


class AcceptanceTests(unittest.TestCase):
    def test_native_gate_rejects_new_clearance_disconnect_and_entry_loss(self):
        before = dict(violations=[], unconnected_items=[{}])
        good = dict(preserved=True, lost_pad_entries=[])
        self.assertTrue(acceptable(before, before, good))
        self.assertFalse(acceptable(before, dict(violations=[dict(type='clearance',items=[])],unconnected_items=[]),good))
        self.assertFalse(acceptable(before,before,dict(preserved=False,lost_pad_entries=[])))
        self.assertFalse(acceptable(before,before,dict(preserved=True,lost_pad_entries=['p'])))
        self.assertFalse(acceptable(before,dict(violations=[],unconnected_items=[{},{}]),good))

@unittest.skipUnless(NATIVE, 'requires native KiCad Python')
class StrandedSurvivorTests(unittest.TestCase):
 fixture = ViaCoalesceTests.fixture
 def prune_fixture(self,single=False,rules=None):
  import pcbnew as k
  from pnr.via_coalesce import uid,worker
  from types import SimpleNamespace
  b,keep,remove,_,_=self.fixture();wrappers=[]
  if single:
   wrappers=[t for t in b.GetTracks() if t.GetLayer()==k.In2_Cu and t.GetClass()=='PCB_TRACK']
   for t in wrappers:b.Remove(t)
  with tempfile.TemporaryDirectory() as directory:
   root=Path(directory);board=root/'board.kicad_pcb';k.SaveBoard(str(board),b)
   txn=root/'txn.json';txn.write_text(json.dumps(dict(proposal=dict(net='aux',keep=uid(keep)))))
   report=root/'report.json'
   worker(SimpleNamespace(board=board,worker='prune',transaction=txn,annotation_source=[],prune=[uid(keep),uid(remove)],report=report),rules or {})
   result=json.loads(report.read_text());loaded=k.LoadBoard(str(board))
   self.assertIn(uid(remove),{uid(t) for t in loaded.GetTracks()})
   return result,uid(keep)
 def test_only_newly_single_layer_survivor_is_pruned(self):
  result,keep=self.prune_fixture(single=True);self.assertEqual(result['removed_vias'],[keep])
 def test_multilayer_survivor_ports_are_retained(self):
  result,_=self.prune_fixture();self.assertEqual(result['removed'],[])
 def test_protected_plane_survivor_is_retained(self):
  result,_=self.prune_fixture(single=True,rules={'net_classes':[{'nets':['aux'],'plane_layer':'In1.Cu'}]});self.assertEqual(result['removed'],[])

if __name__ == '__main__':
    unittest.main()
