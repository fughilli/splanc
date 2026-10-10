import json,os,tempfile,unittest
from pathlib import Path
from pnr.profile import run,span
class Tests(unittest.TestCase):
 def test_records_failure_and_spans(self):
  with tempfile.TemporaryDirectory() as tmp:
   old=os.environ.get('PNR_PROFILE_DIR');os.environ['PNR_PROFILE_DIR']=tmp
   def task():
    with span('kernel'):sum(range(100))
    raise ValueError('expected failure')
   try:
    with self.assertRaises(ValueError):run('test',task)
    record=json.loads(next(Path(tmp).glob('*.json')).read_text());self.assertIn('expected failure',record['error']);self.assertGreaterEqual(record['spans']['kernel']['calls'],1);self.assertTrue(Path(record['profile']).exists());self.assertGreater(record['wall_seconds'],0)
   finally:
    if old is None:os.environ.pop('PNR_PROFILE_DIR',None)
    else:os.environ['PNR_PROFILE_DIR']=old
 def test_disabled_preserves_return(self):
  old=os.environ.pop('PNR_PROFILE_DIR',None)
  try:self.assertEqual(run('off',lambda:42),42)
  finally:
   if old is not None:os.environ['PNR_PROFILE_DIR']=old
if __name__=='__main__':unittest.main()
