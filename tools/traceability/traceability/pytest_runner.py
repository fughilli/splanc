"""Shared pytest entry point for traceability-enabled Bazel ``py_test`` targets.

Requirements: PR-41

Bazel sets ``$XML_OUTPUT_FILE`` for every test and picks up whatever jUnit XML
the test writes there (falling back to a synthetic one-testcase file otherwise).
Routing pytest's ``--junitxml`` at that path means every ``py_test`` that uses
this runner produces rich, per-testcase jUnit XML — and, for tests carrying the
``@requirements(...)`` marker, that XML carries the traceability tags added by
:mod:`traceability.pytest_requirements`.

A package's ``tests/pytest_main.py`` becomes a three-line shim::

    from traceability.pytest_runner import main

    if __name__ == "__main__":
        raise SystemExit(main(__file__))

``main`` discovers tests in the shim's own directory (matching the historical
per-package behaviour) unless explicit paths are passed on argv.
"""

from __future__ import annotations

import os
import sys

import pytest
from traceability import pytest_requirements


def main(anchor: str, extra_args: list[str] | None = None) -> int:
    """Run pytest over the directory containing ``anchor``.

    Writes jUnit XML to ``$XML_OUTPUT_FILE`` when Bazel provides it, with the
    requirements plugin registered so ``@requirements`` markers are emitted as
    traceability tags. ``junit_family=xunit2`` is forced so per-testcase
    ``<properties>`` are serialised.
    """
    here = os.path.dirname(os.path.abspath(anchor))
    args = [here, "-vv", "-p", "no:cacheprovider"]

    xml_out = os.environ.get("XML_OUTPUT_FILE")
    if xml_out:
        args += [f"--junitxml={xml_out}", "-o", "junit_family=xunit2"]

    if extra_args:
        args += extra_args
    args += sys.argv[1:]

    return pytest.main(args, plugins=[pytest_requirements])
