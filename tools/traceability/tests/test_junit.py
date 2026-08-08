"""Tests for jUnit XML parsing + traceability-tag extraction.

Requirements: PR-42
"""

import os
import tempfile

import pytest
from traceability import junit

XUNIT2 = """<?xml version="1.0"?>
<testsuites>
  <testsuite name="pytest" tests="3">
    <testcase classname="tests.test_sync" name="test_offset">
      <properties>
        <property name="requirement" value="PR-5"/>
        <property name="requirement" value="PR-35"/>
      </properties>
    </testcase>
    <testcase classname="tests.test_sync" name="test_broken">
      <properties><property name="requirement" value="PR-5"/></properties>
      <failure message="boom">trace</failure>
    </testcase>
    <testcase classname="tests.test_sync" name="test_untagged"/>
  </testsuite>
</testsuites>
"""


def _write(text: str, path: str) -> str:
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return path


@pytest.mark.requirements("PR-42")
def test_extracts_per_case_requirement_tags():
    with tempfile.TemporaryDirectory() as d:
        p = _write(XUNIT2, os.path.join(d, "test.xml"))
        cases = junit.parse_file(p)
    by_name = {c.name: c for c in cases}
    assert by_name["test_offset"].requirements == ("PR-5", "PR-35")
    assert by_name["test_offset"].status == "passed"
    assert by_name["test_broken"].status == "failed"
    assert by_name["test_untagged"].requirements == ()


@pytest.mark.requirements("PR-42")
def test_target_derived_from_bazel_testlogs_path():
    assert (
        junit.target_from_path("x/bazel-testlogs/pi/hitl/tests/hitl_test/test.xml")
        == "//pi/hitl/tests:hitl_test"
    )
    assert junit.target_from_path("/tmp/random/test.xml") == ""


@pytest.mark.requirements("PR-42")
def test_collect_merges_target_status_worst_wins():
    with tempfile.TemporaryDirectory() as d:
        logs = os.path.join(d, "bazel-testlogs", "pi", "hitl", "tests", "hitl_test")
        os.makedirs(logs)
        _write(XUNIT2, os.path.join(logs, "test.xml"))
        results = junit.collect([d])
    # Failure present -> target status is the worst (failed).
    assert results.target_status["//pi/hitl/tests:hitl_test"] == "failed"
    assert len(results.cases) == 3
