"""Tests for jUnit XML parsing + traceability-tag extraction.

Requirements: PR-25
"""

import os
import tempfile

import pytest
from traceability import junit
from traceability.junit_writer import JUnitWriter

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


@pytest.mark.requirements("PR-25")
def test_extracts_per_case_requirement_tags():
    with tempfile.TemporaryDirectory() as d:
        p = _write(XUNIT2, os.path.join(d, "test.xml"))
        cases = junit.parse_file(p)
    by_name = {c.name: c for c in cases}
    assert by_name["test_offset"].requirements == ("PR-5", "PR-35")
    assert by_name["test_offset"].status == "passed"
    assert by_name["test_broken"].status == "failed"
    assert by_name["test_untagged"].requirements == ()


@pytest.mark.requirements("PR-25")
def test_target_derived_from_bazel_testlogs_path():
    assert (
        junit.target_from_path("x/bazel-testlogs/pi/hitl/tests/hitl_test/test.xml")
        == "//pi/hitl/tests:hitl_test"
    )
    # The resolved path (readlink -f bazel-testlogs) drops the symlink name; the
    # marker is only .../testlogs/... — target mapping must still work (else all
    # coarse verified_by traceability breaks in CI).
    assert (
        junit.target_from_path(
            "/root/.cache/bazel/execroot/_main/bazel-out/k8-fastbuild/testlogs/web/costModel_test/test.xml"
        )
        == "//web:costModel_test"
    )
    assert junit.target_from_path("/tmp/random/test.xml") == ""


@pytest.mark.requirements("PR-25", "PR-25")
def test_junit_writer_roundtrips_through_parser():
    # HITL-style non-pytest runner: phases emit tagged jUnit that the parser
    # reads back byte-faithfully.
    w = JUnitWriter("hitl_e2e")
    w.add("flash_boot", ["PR-9", "PR-34"], "passed", duration=1.2)
    try:
        with w.case("improv_provision", ["PR-9"]):
            raise RuntimeError("no join")
    except RuntimeError:
        pass
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "test.xml")
        w.write(p)
        cases = junit.parse_file(p)
    by_name = {c.name: c for c in cases}
    assert by_name["flash_boot"].requirements == ("PR-9", "PR-34")
    assert by_name["flash_boot"].status == "passed"
    assert by_name["improv_provision"].status == "failed"
    assert by_name["improv_provision"].requirements == ("PR-9",)


@pytest.mark.requirements("PR-25")
def test_parses_level_property():
    xml = """<?xml version="1.0"?>
    <testsuite name="s" tests="1">
      <testcase classname="c" name="t">
        <properties>
          <property name="requirement" value="PR-1"/>
          <property name="level" value="hil"/>
        </properties>
      </testcase>
    </testsuite>"""
    with tempfile.TemporaryDirectory() as d:
        cases = junit.parse_file(_write(xml, os.path.join(d, "test.xml")))
    assert cases[0].level == "hil"


@pytest.mark.requirements("PR-25")
def test_junit_writer_stamps_hitl_level_by_default():
    w = JUnitWriter("hitl_e2e")
    w.add("flash_boot", ["PR-9"])  # inherits default_level
    with w.case("provision", ["PR-29"], level="hil"):  # explicit override
        pass
    with tempfile.TemporaryDirectory() as d:
        p = os.path.join(d, "test.xml")
        w.write(p)
        cases = junit.parse_file(p)
    by_name = {c.name: c for c in cases}
    assert by_name["flash_boot"].level == "hitl"
    assert by_name["provision"].level == "hil"


@pytest.mark.requirements("PR-25")
def test_collect_merges_target_status_worst_wins():
    with tempfile.TemporaryDirectory() as d:
        logs = os.path.join(d, "bazel-testlogs", "pi", "hitl", "tests", "hitl_test")
        os.makedirs(logs)
        _write(XUNIT2, os.path.join(logs, "test.xml"))
        results = junit.collect([d])
    # Failure present -> target status is the worst (failed).
    assert results.target_status["//pi/hitl/tests:hitl_test"] == "failed"
    assert len(results.cases) == 3
