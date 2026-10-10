import unittest
from power_hold_up import hold_up_seconds, required_capacitance_f


class HoldUpTest(unittest.TestCase):
    def test_energy_conservation(self):
        # 1 F discharging 5 V -> 3 V releases 8 joules: 2 W for 4 seconds.
        self.assertEqual(hold_up_seconds(1, 5, 3, 2), 4)
        self.assertEqual(hold_up_seconds(1, 5, 3, 2, 0.5), 2)
        self.assertEqual(required_capacitance_f(5, 3, 2, 4), 1)

    def test_rejects_unphysical_inputs(self):
        for args in ((0, 5, 3, 2), (1, 2, 3, 2), (1, 5, 3, 0),
                     (1, 5, 3, 2, 1.1), (float('nan'), 5, 3, 2)):
            with self.assertRaises(ValueError):
                hold_up_seconds(*args)


if __name__ == '__main__':
    unittest.main()
