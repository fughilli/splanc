"""Pytest entry point for Bazel py_test targets (see shared/protocol/tests)."""

import os
import sys

import pytest

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    sys.exit(pytest.main([here, "-vv", "-p", "no:cacheprovider", *sys.argv[1:]]))
