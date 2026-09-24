"""Nearby translations must not starve a legal paired-device orientation."""
import unittest

from pnr.placement_trials import diverse_pair_poses


class PairPoseDiversityTests(unittest.TestCase):
    def test_cover_orientations_before_nearby_translations(self):
        poses = [dict(ref="ESD", rotation=r, position=[i, 0], score=i)
                 for i, r in enumerate([90, 90, 0, 90, 0, 180, 90, 180, 270])]
        selected = diverse_pair_poses(poses, 4)
        self.assertEqual([p["rotation"] for p in selected], [90, 0, 180, 270])
        self.assertIs(selected[2], poses[5])
        all_poses = diverse_pair_poses(poses, 99)
        self.assertEqual(len(all_poses), len(poses))
        self.assertEqual({id(p) for p in all_poses}, {id(p) for p in poses})
        self.assertEqual(diverse_pair_poses(poses, 0), [])

    def test_package_identity_and_equivalent_rotation(self):
        poses = [dict(ref="A", rotation=0), dict(ref="A", rotation=360),
                 dict(ref="B", rotation=0)]
        self.assertEqual(diverse_pair_poses(poses, 2), [poses[0], poses[2]])


if __name__ == "__main__":
    unittest.main()
