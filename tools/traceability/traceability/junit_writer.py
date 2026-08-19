"""Emit traceability-tagged jUnit XML from non-pytest test runners.

Requirements: PR-25

The pytest plugin covers software-only Python suites, but on-hardware HITL tests
are driven by a plain ``py_binary`` (e.g. ``//pi/hitl/harness:e2e``). This writer
lets such a runner produce the same jUnit shape the aggregator consumes: one
``<testcase>`` per phase, each carrying ``<property name="requirement">`` tags.

    report = JUnitWriter("hitl_e2e")
    with report.case("improv_provision", ["PR-9"]):
        provision_dut(...)            # raises on failure -> recorded as <failure>
    report.write(os.environ.get("XML_OUTPUT_FILE") or "hitl_e2e.xml")

Any exception inside a ``case`` block is recorded as a failure (with the
exception text) and re-raised, so the writer never changes control flow.
"""

from __future__ import annotations

import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from xml.etree import ElementTree as ET


@dataclass
class _Case:
    name: str
    requirements: list[str]
    status: str = "passed"  # passed | failed | error | skipped
    message: str = ""
    duration: float = 0.0
    level: str = ""


@dataclass
class JUnitWriter:
    suite: str
    classname: str = ""
    cases: list[_Case] = field(default_factory=list)
    # On-hardware runs provide HITL-level evidence by default; a caller may pass a
    # different default (e.g. "hil") or override per case.
    default_level: str = "hitl"

    def add(
        self,
        name: str,
        requirements: list[str],
        status: str = "passed",
        message: str = "",
        duration: float = 0.0,
        level: str = "",
    ) -> None:
        self.cases.append(
            _Case(name, list(requirements), status, message, duration, level or self.default_level)
        )

    @contextmanager
    def case(self, name: str, requirements: list[str], level: str = ""):
        """Record ``name`` as passed, or as failed if the block raises (re-raised)."""
        start = time.monotonic()
        try:
            yield
        except BaseException as exc:  # noqa: BLE001 — record then re-raise
            self.add(
                name,
                requirements,
                "failed",
                f"{type(exc).__name__}: {exc}",
                time.monotonic() - start,
                level,
            )
            raise
        else:
            self.add(name, requirements, "passed", "", time.monotonic() - start, level)

    def to_element(self) -> ET.Element:
        failures = sum(1 for c in self.cases if c.status == "failed")
        errors = sum(1 for c in self.cases if c.status == "error")
        skipped = sum(1 for c in self.cases if c.status == "skipped")
        total_time = sum(c.duration for c in self.cases)
        suites = ET.Element("testsuites")
        suite = ET.SubElement(
            suites,
            "testsuite",
            name=self.suite,
            tests=str(len(self.cases)),
            failures=str(failures),
            errors=str(errors),
            skipped=str(skipped),
            time=f"{total_time:.3f}",
        )
        for c in self.cases:
            tc = ET.SubElement(
                suite,
                "testcase",
                classname=self.classname or self.suite,
                name=c.name,
                time=f"{c.duration:.3f}",
            )
            if c.requirements or c.level:
                props = ET.SubElement(tc, "properties")
                for rid in c.requirements:
                    ET.SubElement(props, "property", name="requirement", value=rid)
                if c.level:
                    ET.SubElement(props, "property", name="level", value=c.level)
            if c.status in ("failed", "error"):
                tag = "failure" if c.status == "failed" else "error"
                ET.SubElement(tc, tag, message=c.message).text = c.message
            elif c.status == "skipped":
                ET.SubElement(tc, "skipped", message=c.message)
        return suites

    def to_string(self) -> str:
        return ET.tostring(self.to_element(), encoding="unicode")

    def write(self, path: str) -> None:
        ET.ElementTree(self.to_element()).write(path, encoding="utf-8", xml_declaration=True)
