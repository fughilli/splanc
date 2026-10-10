"""Exercise retry dispatch/termination at the controller boundary.

Native workers are a recorded protocol fixture: the test concerns the controller,
not geometric clearance. Native copper regressions run separately.
"""
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from pnr import native_loop

class PlacementBudgetControllerTest(unittest.TestCase):
    def test_exhausts_grid_refinements_and_sends_recorded_pitch(self):
        self.run_controller(20, [.25,.15,.1,.05], [5,10,15,20])

    def test_exhausts_long_retry_budget_before_no_move_stop(self):
        self.run_controller(90, [.25,.15,.1,.05,.05,.05,.05], [5,10,15,20,40,80,90])

    def run_controller(self, maximum, expected_pitches, expected_seconds):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); repo=root/'repo'; package=repo/'hardware/pnr/pnr'
            package.mkdir(parents=True);(package/'__init__.py').write_text('')
            adapter=repo/'hardware/tools/keyhole_region.py';adapter.parent.mkdir(parents=True);adapter.write_text('')
            board=root/'input.kicad_pcb';board.write_text('fixture');board.with_suffix('.kicad_pro').write_text('{}')
            rules=root/'rules.json';rules.write_text('{}'); constraints=root/'constraints.yaml';constraints.write_text('{}')
            target=dict(net='power',source='A.1',target='B.1',source_xy=[2,2],target_xy=[4,4],mode='power',distance=3)
            inventory=dict(targets=[target],footprint_poses={'A':[2,2]},item_nets={'a':'power'},excluded=[],owners={},bounds=[0,0,10,10])
            drc=dict(unconnected_items=[dict(items=[dict(uuid='a')])],violations=[])
            pitches=[];seconds=[];placements=[]
            move=dict(ref='A',original=[2,2],position=[2.1,2.1],score=1)
            checks=dict(preserved=True,lost_pad_entries=[],new_bad_entries=[],reference_failures=[])
            def invoke(cmd,**kwargs):
                if '--worker' in cmd:
                    mode=cmd[cmd.index('--worker')+1]
                    value=([move] if mode=='placement-copper' else checks if mode=='check' else {} if mode in ('prepare','move') else inventory)
                    Path(cmd[cmd.index('--report')+1]).write_text(json.dumps(value))
                else:
                    self.assertEqual(cmd[2],'pnr.native_electrical')
                    # A missing --pitch must fail rather than silently read a default.
                    pitch=float(cmd[cmd.index('--pitch')+1]);duration=float(cmd[cmd.index('--seconds')+1])
                    if any(part.startswith('move-') for part in Path(cmd[cmd.index('--out-dir')+1]).parts):placements.append((pitch,duration))
                    else:pitches.append(pitch);seconds.append(duration)
                    out=Path(cmd[cmd.index('--out-dir')+1]);out.mkdir()
                    (out/'result.json').write_text(json.dumps(dict(status='no_current_sized_channel',accepted=False)))
            original=Path.cwd()
            try:
                with patch.object(native_loop.subprocess,'run',side_effect=invoke),patch('pnr.native_drc.run_drc',return_value=drc),patch.object(native_loop,'placements',return_value=[move]):
                    native_loop.main([str(board),'--repo',str(repo),'--rules',str(rules),'--constraints',str(constraints),'--electrical-fab',str(rules),'--out-dir',str(root/'run'),'--kicad-python','fixture-python','--kicad-cli','fixture-cli','--cycles',str(len(expected_seconds)),'--placement-attempts','1','--seconds','600','--search-seconds',str(maximum)])
            finally:
                os.chdir(original)
            progress=json.loads((root/'run/progress.json').read_text())
            self.assertEqual(pitches,expected_pitches)
            self.assertEqual(seconds,expected_seconds)
            self.assertEqual(placements,list(zip(expected_pitches,expected_seconds)))
            self.assertEqual(len(progress['rounds']),len(expected_pitches))
            self.assertEqual(progress['termination'],'cycle_limit')
            self.assertEqual(progress['opens'],1)

if __name__=='__main__':unittest.main()
