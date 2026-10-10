import os,unittest
from unittest.mock import patch
from pnr.route.detail.router import detail_pitch,escape_reach_cells
class PitchTest(unittest.TestCase):
 def test_auto_preserves_original_geometry_resolution(self):
  with patch.dict(os.environ,{},clear=True):self.assertAlmostEqual(detail_pitch(None,.2,.15),.35)
 def test_override_reaches_all_callers_and_explicit_wins(self):
  with patch.dict(os.environ,{'PNR_DETAIL_PITCH_MM':'.25'}):
   self.assertEqual(detail_pitch(None,.2,.15),.25)
   self.assertEqual(detail_pitch(.3,.2,.15),.3)
   self.assertEqual(escape_reach_cells(detail_pitch(None,.2,.15),.2,.15),6)
 def test_zero_selects_auto(self):
  with patch.dict(os.environ,{'PNR_DETAIL_PITCH_MM':'0'}):self.assertAlmostEqual(detail_pitch(None,.2,.15),.35)
 def test_invalid_pitch_fails_closed(self):
  for value in ['nan','inf','-1','bad','']:
   with self.subTest(value=value),patch.dict(os.environ,{'PNR_DETAIL_PITCH_MM':value}):
    with self.assertRaises(ValueError):detail_pitch(None,.2,.15)
if __name__=='__main__':unittest.main()
