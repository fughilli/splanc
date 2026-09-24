import unittest
from pnr.obsolete_branch import obsolete_leaf_items


def graph(*edges):
    result = {}
    for a, b in edges:
        result.setdefault(a, set()).add(b)
        result.setdefault(b, set()).add(a)
    return result


class ObsoleteBranchTest(unittest.TestCase):
    def test_overlapping_bend_is_peeled_to_shared_trunk(self):
        g = graph(('pad', 'a'), ('a', 'b'), ('a', 'c'), ('b', 'c'),
                  ('c', 'junction'), ('junction', 'left'), ('junction', 'right'))
        self.assertEqual(obsolete_leaf_items(g, {'pad'}, {'left', 'right'}),
                         {'pad', 'a', 'b', 'c'})

    def test_unrelated_stub_is_not_removed(self):
        g = graph(('seed', 'j'), ('j', 'left'), ('j', 'right'), ('j', 'stub'))
        self.assertEqual(obsolete_leaf_items(g, {'seed'}, {'left', 'right'}), {'seed'})

    def test_anchor_in_cycle_prevents_peeling(self):
        g = graph(('seed', 'a'), ('a', 'b'), ('b', 'seed'), ('b', 'j'))
        self.assertEqual(obsolete_leaf_items(g, {'seed'}, {'a', 'j'}), set())

    def test_two_terminal_bridge_survives(self):
        g = graph(('l', 'a'), ('a', 'b'), ('b', 'r'), ('a', 'seed'))
        self.assertEqual(obsolete_leaf_items(g, {'seed'}, {'l', 'r'}), {'seed'})

    def test_isolated_moved_net_cluster_is_removed(self):
        g = graph(('seed', 'a'), ('a', 'b'), ('b', 'seed'))
        self.assertEqual(obsolete_leaf_items(g, {'seed'}), set(g))

    def test_locked_or_array_item_stops_branch(self):
        g = graph(('seed', 'a'), ('a', 'locked'), ('locked', 'far'))
        self.assertEqual(obsolete_leaf_items(g, {'seed'}, {'locked'}), {'seed', 'a'})

    def test_long_branch_does_not_exhaust_recursion(self):
        g = graph(*[(str(i), str(i + 1)) for i in range(1100)])
        self.assertEqual(len(obsolete_leaf_items(g, {'0'}, {'1100'})), 1100)


if __name__ == '__main__':
    unittest.main()
