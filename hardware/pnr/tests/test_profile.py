"""Profiler lifecycle must release native entries before metadata processing."""
import cProfile
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from pnr import profile as profiling

class ProfileTests(unittest.TestCase):
    def test_serialized_snapshot_is_reused_after_clear(self):
        events=[]
        class Traced(cProfile.Profile):
            def dump_stats(self,path):
                events.append('dump')
                super().dump_stats(path)
            def clear(self):
                events.append('clear')
                super().clear()
        def workload():
            return sum(range(100))
        p=Traced();p.runcall(workload)
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'profile.pstats'
            original=profiling.pstats.Stats
            def read_saved(source):
                self.assertEqual(events,['dump','clear'])
                self.assertEqual(source,str(path))
                self.assertEqual(p.getstats(),[])
                return original(source)
            with patch.object(profiling.pstats,'Stats',side_effect=read_saved):
                stats=profiling.finalized_stats(p,path)
            self.assertTrue(any(key[2]=='workload' for key in stats.stats))

    def test_function_result_and_failure_are_preserved(self):
        for failing in (False,True):
            with tempfile.TemporaryDirectory() as directory:
                def work():
                    if failing:raise ValueError('sentinel')
                    return 123
                with patch.dict(os.environ,{'PNR_PROFILE_DIR':directory}),patch('pnr.live.emit'):
                    if failing:
                        with self.assertRaisesRegex(ValueError,'sentinel'):
                            profiling.run('test',work)
                    else:self.assertEqual(profiling.run('test',work),123)
                records=list(Path(directory).glob('*.json'))
                self.assertEqual(len(records),1)
                record=json.loads(records[0].read_text())
                self.assertEqual(record['error'],"ValueError('sentinel')" if failing else None)
                self.assertTrue(record['hot_functions'])
                self.assertTrue(Path(record['profile']).is_file())
                self.assertFalse(profiling.active)

if __name__=='__main__':unittest.main()
