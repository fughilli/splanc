import unittest
from pnr.full_iteration import objective
class ObjectiveTests(unittest.TestCase):
 def test_electrical_regression_beats_signal_gain(self):
  audit={'reference_failures':[],'subwidth_track_count':0,'pairs':[{'length_match_qualified':True}]}
  clean=objective({'violations':[],'unconnected_items':[{}]*20},{'blocked':[]},audit)
  broken=objective({'violations':[],'unconnected_items':[]},{'blocked':[{}]},audit)
  self.assertGreater(broken,clean)
  audit['subwidth_track_count']=1
  self.assertGreater(objective({'violations':[],'unconnected_items':[]},{'blocked':[]},audit),clean)
 def test_requires_final_reports(self):
  with self.assertRaises(KeyError):objective({}, {}, {})
if __name__=='__main__':unittest.main()
