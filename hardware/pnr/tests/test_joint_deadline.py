"""Deadline contract with a deterministic clock; geometry tests run separately."""
import unittest
from unittest.mock import patch
from pnr.route.detail.joint import solve_joint_region
from pnr.route.detail.regional import Request

class JointDeadlineTest(unittest.TestCase):
    def run_case(self, **options):
        now=[0.]
        def clear(*args):
            now[0]+=25.
            return True
        request=Request('one','n',[(0.,0.)],[(1.,0.)],.2,.15)
        with patch('time.monotonic',side_effect=lambda:now[0]):
            return solve_joint_region([request],(-1.,-1.,2.,1.),clear,lambda *a:True,
                                      max_seconds=120,**options)
    def test_default_obeys_requested_transaction_budget(self):
        self.assertEqual(self.run_case().status,'routed')
    def test_explicit_shorter_path_deadline_is_respected(self):
        self.assertEqual(self.run_case(route_seconds=20).status,'time_budget')

if __name__=='__main__':unittest.main()
