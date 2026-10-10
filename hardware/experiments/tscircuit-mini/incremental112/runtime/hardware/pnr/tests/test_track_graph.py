"""Pad/via anchored graph cycles, including the U18 fanout diamond."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from pnr.track_graph import redundant_chains


def diamond():
    def segment(identity, a, b, width=200000):
        return dict(id=identity, a=tuple(round(v*1e6) for v in a),
                    b=tuple(round(v*1e6) for v in b), width=width)
    # The far end of 'tail' is a via. The diamond junction is in its middle.
    return [segment('a1',(7.55,6.5),(8,6.95)),
            segment('a2',(8,6.95),(8,7.7)),
            segment('b1',(7.55,6.5),(7.55,7.25)),
            segment('tail',(7.55,7.25),(8.5,8.2))]


class GraphTests(unittest.TestCase):
    def test_diamond_preserves_midsegment_continuation(self):
        segments=diamond()
        p=redundant_chains(segments,[(7550000,6500000),(8500000,8200000)])
        self.assertEqual(len(p),1)
        self.assertEqual(p[0]['remove_tracks'],['a1','a2'])
        self.assertAlmostEqual(p[0]['length_mm'],p[0]['retained_path_mm'])
        remaining=[s for s in segments if s['id'] not in p[0]['remove_tracks']]
        self.assertEqual(redundant_chains(remaining,[(7550000,6500000),(8500000,8200000)]),[])

    def test_locked_chain_or_narrower_alternative_is_retained(self):
        segments=diamond();segments[0]['locked']=True
        self.assertEqual(redundant_chains(segments),[])
        segments=diamond();segments[2]['width']=150000
        self.assertEqual(redundant_chains(segments),[])

    def test_required_interior_terminal_and_t_branch_are_preserved(self):
        self.assertEqual(redundant_chains(diamond(),[(8000000,7300000)]),[])
        segments=diamond()+[dict(id='required_branch',a=(8000000,7300000),b=(9000000,7300000),width=200000)]
        self.assertEqual(redundant_chains(segments),[])

    def test_identical_overlap_removes_only_one_copy(self):
        segments=[dict(id='one',a=(0,0),b=(1000000,0),width=200000),
                  dict(id='two',a=(0,0),b=(1000000,0),width=200000)]
        choices=redundant_chains(segments,[(0,0),(1000000,0)])
        self.assertEqual(len(choices),2)
        segments=[s for s in segments if s['id'] not in choices[0]['remove_tracks']]
        self.assertEqual(redundant_chains(segments,[(0,0),(1000000,0)]),[])

    def test_cycle_bound_and_disconnected_paths(self):
        self.assertEqual(redundant_chains(diamond(),max_length=500000),[])
        self.assertEqual(redundant_chains(diamond()[:2]),[])


@unittest.skipUnless(importlib.util.find_spec('pcbnew'),'requires native KiCad')
class NativeTests(unittest.TestCase):
    def fixture(self):
        import pcbnew as k
        b=k.BOARD();b.SetCopperLayerCount(4)
        n=k.NETINFO_ITEM(b,'arbitrary-net');b.Add(n)
        for s in diamond():
            t=k.PCB_TRACK(b);t.SetStart(k.VECTOR2I(*s['a']));t.SetEnd(k.VECTOR2I(*s['b']))
            t.SetWidth(s['width']);t.SetLayer(k.F_Cu);t.SetNetCode(n.GetNetCode());b.Add(t)
        for ref,num,pos in [('ANY987','10',(7550000,6500000)),('OTHER','1',(8500000,8200000))]:
            f=k.FOOTPRINT(b);f.SetReference(ref);b.Add(f)
            p=k.PAD(f);p.SetNumber(num);p.SetPosition(k.VECTOR2I(*pos));p.SetSize(k.VECTOR2I(400000,400000))
            p.SetShape(k.PAD_SHAPE_RECT);p.SetAttribute(k.PAD_ATTRIB_SMD)
            ls=k.LSET();ls.AddLayer(k.F_Cu);p.SetLayerSet(ls);p.SetNetCode(n.GetNetCode());f.Add(p)
        b.BuildConnectivity();return b

    def test_native_pad_connectivity_entry_and_repeatability(self):
        import pcbnew as k
        from pnr.track_graph import cycle_candidates,apply_cycle
        from pnr.via_coalesce import partition,preserved
        from pnr.pad_entry import snapshot
        b=self.fixture();before=partition(b);entries=snapshot(b,{})
        choices=cycle_candidates(b,{},[])
        self.assertEqual(len(choices),1)
        removed = apply_cycle(b,choices[0])
        self.assertTrue(preserved(before,partition(b)))
        self.assertEqual(snapshot(b,{}),entries)
        self.assertEqual(len(list(b.GetTracks())),2)
        with tempfile.TemporaryDirectory() as d:
            path=str(Path(d)/'board.kicad_pcb');k.SaveBoard(path,b)
            reload=k.LoadBoard(path);reload.BuildConnectivity()
            self.assertEqual(cycle_candidates(reload,{},[]),[])
            self.assertTrue(preserved(before,partition(reload)))

    def test_serialized_native_worker_transaction(self):
        import pcbnew as k
        from types import SimpleNamespace
        from pnr.track_graph import cycle_candidates
        from pnr.via_coalesce import worker
        b=self.fixture();proposal=cycle_candidates(b,{},[])[0]
        with tempfile.TemporaryDirectory() as d:
            folder=Path(d);source=folder/'source.kicad_pcb';out=folder/'after.kicad_pcb'
            transaction=folder/'proposal.json';report=folder/'edit.json'
            k.SaveBoard(str(source),b);transaction.write_text(json.dumps(proposal))
            worker(SimpleNamespace(board=source,worker='cycle-trial',transaction=transaction,
                                   radius=1.5,annotation_source=[],out=out,report=report),{})
            self.assertNotIn('skipped',json.loads(report.read_text()))
            reloaded=k.LoadBoard(str(out))
            self.assertEqual(len(list(reloaded.GetTracks())),2)

    def test_source_current_array_and_diff_pair_excluded(self):
        import pcbnew as k
        from pnr.track_graph import cycle_candidates
        b=self.fixture();f=next(f for f in b.GetFootprints() if f.GetReference()=='ANY987')
        field=k.PCB_FIELD(f,k.FIELD_T_USER,'atopile_address');field.SetText('board.source_driver._p');f.Add(field)
        f.SetReference('RENAMED999')
        with tempfile.TemporaryDirectory() as d:
            path=Path(d)/'source.ato';path.write_text('# @pnr-plane-access '+json.dumps(dict(kind='power_array',target='source_driver',pads=['10'],rms_current_a=5,peak_current_a=16)))
            self.assertEqual(cycle_candidates(b,{},[path]),[])
        self.assertEqual(cycle_candidates(b,{'diff_pairs':[{'p':'arbitrary-net','n':'other'}]},[]),[])

    def test_layers_cannot_be_conflated(self):
        import pcbnew as k
        from pnr.track_graph import cycle_candidates
        b=self.fixture();next(iter(b.GetTracks())).SetLayer(k.B_Cu)
        self.assertEqual(cycle_candidates(b,{},[]),[])

if __name__=='__main__':
    unittest.main()
