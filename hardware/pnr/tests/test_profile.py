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

import gc,os,tempfile,unittest,weakref
from unittest.mock import patch
from pnr import profile
class Payload: pass
class LeaseTests(unittest.TestCase):
 def test_leases_survive_report_then_release(self):
  refs=[];events=[]
  def work():
   x=Payload();refs.append(weakref.ref(x));profile.retain_native(x);return 73
  def emit(*args,**kwargs):
   gc.collect();self.assertIsNotNone(refs[0]());events.append('report')
  with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'PNR_PROFILE_DIR':folder}),patch('pnr.live.emit',side_effect=emit):
   self.assertEqual(profile.run('lease',work),73)
  gc.collect();self.assertIsNone(refs[0]());self.assertIsNone(profile._native_roots);self.assertEqual(events,['report'])
 def test_nested_calls_share_outer_lease(self):
  refs=[]
  def nested():
   x=Payload();refs.append(weakref.ref(x));profile.retain_native(x)
  def work():
   profile.run('inner',nested);gc.collect();self.assertIsNotNone(refs[0]())
  with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'PNR_PROFILE_DIR':folder}),patch('pnr.live.emit'):
   profile.run('outer',work)
  gc.collect();self.assertIsNone(refs[0]());self.assertIsNone(profile._native_roots)
 def test_failure_releases_lease_and_preserves_exception(self):
  refs=[]
  def work():
   x=Payload();refs.append(weakref.ref(x));profile.retain_native(x);raise ValueError('expected')
  with tempfile.TemporaryDirectory() as folder,patch.dict(os.environ,{'PNR_PROFILE_DIR':folder}),patch('pnr.live.emit'):
   with self.assertRaisesRegex(ValueError,'expected'):profile.run('lease-error',work)
  gc.collect();self.assertIsNone(refs[0]());self.assertIsNone(profile._native_roots);self.assertFalse(profile.active)
 def test_unprofiled_calls_do_not_retain(self):
  x=Payload();ref=weakref.ref(x)
  with patch.dict(os.environ,{},clear=True):profile.retain_native(x)
  del x;gc.collect();self.assertIsNone(ref());self.assertIsNone(profile._native_roots)

if __name__=='__main__':unittest.main()
