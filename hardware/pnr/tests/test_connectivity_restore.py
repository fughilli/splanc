import unittest
from pnr.connectivity_restore import lost_connections, restoration_membership, restores_connection

class ConnectivityRestoreTest(unittest.TestCase):
    def test_split_and_missing_are_explicit(self):
        self.assertEqual(lost_connections([['a','b','c']], [['a'],['b']]),
            [dict(original=['a','b','c'],fragments=[['a'],['b']],missing=['c'])])
    def test_new_connections_do_not_hide_lost_seed_connection(self):
        self.assertEqual(len(lost_connections([['a','b'],['c']], [['a','c'],['b']])),1)
    def test_merge_preserves_seed(self):
        self.assertEqual(lost_connections([['a','b'],['c']], [['a','b','c']]),[])
    def test_restoration_can_use_newly_joined_pad(self):
        m=restoration_membership([['a','b'],['c'],['d']], [['a','c'],['b'],['d']])
        self.assertTrue(restores_connection(m,'c','b'))
        self.assertFalse(restores_connection(m,'c','d'))
    def test_missing_singleton_fails_closed(self):
        self.assertEqual(lost_connections([['a']],[])[0]['missing'],['a'])

if __name__ == '__main__':unittest.main()
