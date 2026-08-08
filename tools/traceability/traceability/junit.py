"""Parse jUnit XML (including the traceability tags) into test results.

Requirements: PR-42

Two sources of test->requirement traceability are supported:

1. **Fine-grained (per test case):** ``<property name="requirement" value="PR-…">``
   tags inside a ``<testcase>``, emitted by the pytest plugin
   (:mod:`traceability.pytest_requirements`). This is the preferred mechanism and
   the one HITL and software-only Python tests use.

2. **Coarse (per target):** the jUnit *file* maps to a Bazel test target (derived
   from its ``bazel-testlogs/<pkg>/<name>/test.xml`` path). The requirements model
   can attach that target to PRs via ``verified_by`` for languages whose
   runners do not yet emit per-case tags (C++, Rust, Go, TS). The whole file's
   pass/fail then contributes to those PRs. See ``report.build_matrix``.

This module only extracts facts from the XML; joining them to the model and
deciding PASS/FAIL lives in :mod:`traceability.report`.
"""

from __future__ import annotations

import glob
import os
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET

# Status of a single test case, most-severe-wins when merging duplicates.
STATUS_ORDER = {"passed": 0, "skipped": 1, "failed": 2, "error": 3}


@dataclass
class CaseResult:
    name: str
    classname: str
    status: str  # passed | skipped | failed | error
    requirements: tuple[str, ...] = ()  # PR ids from per-case property tags
    source_file: str = ""  # jUnit file this came from
    target: str = ""  # bazel label derived from the file path, if any

    @property
    def full_name(self) -> str:
        return f"{self.classname}::{self.name}" if self.classname else self.name


@dataclass
class JUnitResults:
    cases: list[CaseResult] = field(default_factory=list)
    files: list[str] = field(default_factory=list)
    # Per-target aggregate status (worst case wins), for coarse traceability.
    target_status: dict[str, str] = field(default_factory=dict)

    def merge_target(self, target: str, status: str) -> None:
        if not target:
            return
        cur = self.target_status.get(target)
        if cur is None or STATUS_ORDER[status] > STATUS_ORDER[cur]:
            self.target_status[target] = status


def _case_status(case: ET.Element) -> str:
    if case.find("error") is not None:
        return "error"
    if case.find("failure") is not None:
        return "failed"
    if case.find("skipped") is not None:
        return "skipped"
    return "passed"


def _case_requirements(case: ET.Element) -> tuple[str, ...]:
    reqs: list[str] = []
    # xunit2 nests <properties><property/></properties> inside <testcase>.
    for prop in case.findall("./properties/property"):
        if prop.get("name") == "requirement":
            value = prop.get("value", "").strip()
            if value:
                reqs.append(value)
    return tuple(reqs)


def target_from_path(path: str, workspace_root: str = "") -> str:
    """Derive a Bazel test label from a ``bazel-testlogs`` jUnit file path.

    ``.../bazel-testlogs/pi/hitl/tests/hitl_test/test.xml`` -> ``//pi/hitl/tests:hitl_test``.
    Returns "" when the path is not recognisably under bazel-testlogs.
    """
    norm = path.replace("\\", "/")
    marker = "bazel-testlogs/"
    idx = norm.rfind(marker)
    if idx == -1:
        return ""
    rel = norm[idx + len(marker) :]
    parts = rel.split("/")
    # Drop the trailing test.xml (and any shard/attempt subdir Bazel may add).
    while parts and (parts[-1].endswith(".xml") or parts[-1] in ("test.xml",)):
        parts.pop()
    if len(parts) < 2:
        return ""
    name = parts[-1]
    pkg = "/".join(parts[:-1])
    return f"//{pkg}:{name}"


def parse_file(path: str) -> list[CaseResult]:
    """Parse one jUnit XML file into its test cases."""
    target = target_from_path(path)
    try:
        tree = ET.parse(path)
    except ET.ParseError:
        return []
    root = tree.getroot()
    suites = [root] if root.tag == "testsuite" else root.findall(".//testsuite")
    cases: list[CaseResult] = []
    for suite in suites:
        for case in suite.findall("testcase"):
            cases.append(
                CaseResult(
                    name=case.get("name", ""),
                    classname=case.get("classname", ""),
                    status=_case_status(case),
                    requirements=_case_requirements(case),
                    source_file=path,
                    target=target,
                )
            )
    return cases


def collect(paths: list[str]) -> JUnitResults:
    """Parse and merge many jUnit files (explicit files or directories)."""
    results = JUnitResults()
    for path in _expand(paths):
        cases = parse_file(path)
        if not cases and not os.path.isfile(path):
            continue
        results.files.append(path)
        results.cases.extend(cases)
        for case in cases:
            results.merge_target(case.target, case.status)
    return results


def _expand(paths: list[str]) -> list[str]:
    out: list[str] = []
    for path in paths:
        if os.path.isdir(path):
            out.extend(sorted(glob.glob(os.path.join(path, "**", "*.xml"), recursive=True)))
        elif any(ch in path for ch in "*?["):
            out.extend(sorted(glob.glob(path, recursive=True)))
        else:
            out.append(path)
    # De-dup, keep order.
    seen: set[str] = set()
    unique: list[str] = []
    for p in out:
        if p not in seen:
            seen.add(p)
            unique.append(p)
    return unique
