"""Pytest entry point for Bazel py_test targets.

`py_test` runs its `main` as a plain `python <main>` invocation, so a bare
test module would just define functions and exit 0 without ever collecting
anything. This wrapper hands control to pytest, pointed at its own directory
so the sibling `test_*.py` modules (staged next to it in the runfiles tree)
are discovered and run.
"""

import os
import sys

import pytest

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    # `-p no:cacheprovider` keeps pytest from writing a .pytest_cache into the
    # read-only runfiles tree.
    sys.exit(pytest.main([here, "-vv", "-p", "no:cacheprovider", *sys.argv[1:]]))
