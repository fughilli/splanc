"""The checked-in golden vectors are gen_golden.py's output (regenerate with the command in
gen_golden.py's docstring after changing it)."""

import os
import subprocess
import sys
import unittest


class GoldenFreshTest(unittest.TestCase):
    def test_golden_matches_generator(self):
        out = subprocess.run(
            [sys.executable, "-I", os.environ["GEN_GOLDEN"]],
            check=True,
            capture_output=True,
            text=True,
        ).stdout
        with open(os.environ["SWARM_WIRE_GOLDEN"]) as f:
            self.assertEqual(out, f.read())


if __name__ == "__main__":
    unittest.main()
