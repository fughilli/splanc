import unittest,math
from pnr.route.detail.coupled import solve_pair,path_metrics
class DensePortalTest(unittest.TestCase):
 def test_narrow_reference_window_between_coarse_samples(self):
  # The differential trunk must begin after x=3.56 of reference copper.
  # Each pad may have at most .65 mm of uncoupled access. The old .5/.75
  # portal choices respectively miss the reference and exceed the cap.
  terms={'p':((3,5.2),(17,5.2)),'n':((3,4.8),(17,4.8))}
  def envelope(a,z,w):return all(3.56<=q[0]<=16.44 and 4.6<=q[1]<=5.4 for q in (a,z))
  result=solve_pair('p','n',terms,(1,1,19,19),lambda *a:True,envelope,.2,.2,.1,pitch=.1,max_uncoupled=.65,max_attempts=32)
  self.assertEqual(result['status'],'routed',result)
  self.assertAlmostEqual(result['lengths']['p'],result['lengths']['n'])
 def test_insufficient_uncoupled_cap_still_rejects(self):
  terms={'p':((3,5.2),(17,5.2)),'n':((3,4.8),(17,4.8))}
  def envelope(a,z,w):return all(3.56<=q[0]<=16.44 and 4.6<=q[1]<=5.4 for q in (a,z))
  result=solve_pair('p','n',terms,(1,1,19,19),lambda *a:True,envelope,.2,.2,.1,pitch=.1,max_uncoupled=.5,max_attempts=32)
  self.assertNotEqual(result['status'],'routed')
if __name__=='__main__':unittest.main()
