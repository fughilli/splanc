"""Pytest entry point for the HITL Bazel py_test (mirrors pi/server/tests)."""

import os
import sys

import pytest

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    sys.exit(pytest.main([here, "-vv", "-p", "no:cacheprovider", *sys.argv[1:]]))
