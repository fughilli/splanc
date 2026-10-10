import unittest
from pnr.route_epoch import evaluate_epochs

class EpochContract(unittest.TestCase):

    def run_epoch(self, edits, **kw):
        args = dict(apply=lambda s, e: s + (e,), proxy=lambda *_: True, native_gate=lambda *_: True, eligible=lambda _: True, max_edits=4)
        args.update(kw)
        return evaluate_epochs((), edits, **args)

    def test_clean_batch(self):
        r = self.run_epoch(range(4))
        self.assertEqual(r.state, (0, 1, 2, 3))
        self.assertEqual(r.native_calls, 1)

    def test_failed_batch_bisects(self):
        r = self.run_epoch([1, 2, 3, 4], native_gate=lambda _, s: 3 not in s)
        self.assertEqual(r.state, (1, 2, 4))
        self.assertEqual(r.rejected, [3])
        self.assertEqual(r.native_calls, 5)

    def test_proxy_rejects(self):
        r = self.run_epoch([1, 2, 3], proxy=lambda _, s, e: e != 2)
        self.assertEqual(r.state, (1, 3))
        self.assertEqual(r.rejected, [2])

    def test_power_plane_pair_individual(self):
        r = self.run_epoch(['signal', 'power', 'plane', 'pair', 'signal'], eligible=lambda e: e == 'signal')
        self.assertEqual(r.native_calls, 5)

    def test_native_exception(self):

        def check(_, s):
            raise RuntimeError('stale native state')
        r = self.run_epoch([1, 2], native_gate=check)
        self.assertEqual(r.state, ())
        self.assertEqual(r.accepted, [])
        self.assertEqual(r.rejected, [1, 2])

    def test_boolean_contract(self):
        self.assertEqual(self.run_epoch([1], native_gate=lambda *_: 'probably clean').state, ())
        self.assertEqual(self.run_epoch([1], proxy=lambda *_: None).state, ())

    def test_proposal_error(self):

        def apply(s, e):
            if e == 2:
                raise RuntimeError('stale revision')
            return s + (e,)
        self.assertEqual(self.run_epoch([1, 2, 3], apply=apply).state, (1, 3))

    def test_provisional_events(self):
        events = []
        r = self.run_epoch([1, 2], emit=events.append, native_gate=lambda *_: False)
        self.assertEqual(r.state, ())
        self.assertNotIn('accepted_epoch', [e['status'] for e in events])

    def test_budget(self):
        for n in [0, -1, False, 1.5]:
            with self.assertRaises(ValueError):
                self.run_epoch([], max_edits=n)
if __name__ == '__main__':
    unittest.main()
