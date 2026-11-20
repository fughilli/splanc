"""Pytest entry point for the mesh-bench unit tests."""

import os
import sys

import pytest

if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    tests = sorted(
        os.path.join(here, f)
        for f in os.listdir(here)
        if f.startswith("test_") and f.endswith(".py")
    )
    args = ["-q", "-p", "no:cacheprovider"] + tests
    xml = os.environ.get("XML_OUTPUT_FILE")
    if xml:
        args.append(f"--junitxml={xml}")
    sys.exit(pytest.main(args))
