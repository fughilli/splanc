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

class ProgressBudgetControllerTest(unittest.TestCase):
    def test_exhausts_grid_refinements_and_sends_recorded_pitch(self):
        self.run_controller(20, [.25,.1,.1,.05], [5,10,20,20])

    def test_exhausts_long_retry_budget_before_no_move_stop(self):
        self.run_controller(90, [.25,.1,.1,.05,.05,.05,.05], [5,10,20,40,80,90,90])

    def test_no_hint_without_complete_independent_paths_and_conflicts(self):
        full=dict(status='time_budget',attempts=[dict(stage='independent',completed=2,events=[dict(status='routed'),dict(status='routed')]),dict(stage='conflicts')])
        self.assertEqual(native_loop.progress_budget_hint(full,15,90),30)
        self.assertEqual(native_loop.progress_budget_hint(full,80,90),90)
        self.assertEqual(native_loop.progress_budget_hint(dict(full,status='no_channel_at_pitch'),15,90),0)
        self.assertEqual(native_loop.progress_budget_hint(dict(status='time_budget'),15,90),0)
        partial=__import__('copy').deepcopy(full);partial['attempts'][0]['completed']=1
        self.assertEqual(native_loop.progress_budget_hint(partial,15,90),0)

    def run_controller(self, maximum, expected_pitches, expected_seconds):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); repo=root/'repo'; package=repo/'hardware/pnr/pnr'
            package.mkdir(parents=True);(package/'__init__.py').write_text('')
            adapter=repo/'hardware/tools/keyhole_region.py';adapter.parent.mkdir(parents=True);adapter.write_text('')
            board=root/'input.kicad_pcb';board.write_text('fixture');board.with_suffix('.kicad_pro').write_text('{}')
            rules=root/'rules.json';rules.write_text('{}'); constraints=root/'constraints.yaml';constraints.write_text('{}')
            target=dict(net='power',source='A.1',target='B.1',source_xy=[2,2],target_xy=[4,4],mode='signal',distance=3)
            inventory=dict(targets=[target],footprint_poses={},item_nets={'a':'power'},excluded=[],owners={},bounds=[0,0,10,10])
            drc=dict(unconnected_items=[dict(items=[dict(uuid='a')])],violations=[])
            pitches=[];seconds=[]
            def invoke(cmd,**kwargs):
                if '--worker' in cmd:
                    mode=cmd[cmd.index('--worker')+1]
                    value=({'reopen':[]} if mode=='terminal-blockers' else {} if mode=='prepare' else inventory)
                    Path(cmd[cmd.index('--report')+1]).write_text(json.dumps(value))
                else:
                    self.assertTrue(cmd[1].endswith('keyhole_region.py'))
                    # A missing --pitch must fail rather than silently read a default.
                    pitches.append(float(cmd[cmd.index('--pitch')+1]));seconds.append(float(cmd[cmd.index('--max-seconds')+1]))
                    out=Path(cmd[cmd.index('--out-dir')+1]);out.mkdir()
                    (out/'result.json').write_text(json.dumps(dict(status='time_budget',accepted=False,attempts=[dict(stage='independent',completed=2,events=[dict(status='routed'),dict(status='routed')]),dict(stage='conflicts',conflicts=3)])))
            original=Path.cwd()
            try:
                with patch.object(native_loop.subprocess,'run',side_effect=invoke),patch('pnr.native_drc.run_drc',return_value=drc),patch.object(native_loop,'placements',return_value=[]):
                    native_loop.main([str(board),'--repo',str(repo),'--rules',str(rules),'--constraints',str(constraints),'--out-dir',str(root/'run'),'--kicad-python','fixture-python','--kicad-cli','fixture-cli','--cycles','8','--seconds','600','--search-seconds',str(maximum)])
            finally:
                os.chdir(original)
            progress=json.loads((root/'run/progress.json').read_text())
            self.assertEqual(pitches,expected_pitches)
            self.assertEqual(seconds,expected_seconds)
            self.assertEqual([e['search_pitch'] for e in progress['events']],pitches)
            self.assertEqual(len(progress['rounds']),len(expected_pitches))
            self.assertEqual(progress['termination'],'no_legal_untried_moves')
            self.assertEqual(progress['opens'],1)

if __name__=='__main__':unittest.main()
