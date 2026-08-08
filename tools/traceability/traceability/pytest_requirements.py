"""Pytest plugin: annotate tests with the requirements they verify.

Requirements: PR-41

Usage in a test module::

    import pytest

    @pytest.mark.requirements("PR-12", "PR-30")
    def test_sntp_offset_math():
        ...

Every test so marked emits, in the jUnit XML, one traceability tag per
requirement inside its ``<testcase>``::

    <testcase name="test_sntp_offset_math" ...>
      <properties>
        <property name="requirement" value="PR-12"/>
        <property name="requirement" value="PR-30"/>
      </properties>
    </testcase>

The aggregation step (:mod:`traceability.report`) reads these tags back to
compute PASS/FAIL per requirement. The marker values are recorded verbatim; the
requirements-model validator (``//requirements:requirements_valid_test``) is what
guarantees every referenced ``PR-…`` id actually exists — keeping this plugin
dependency-free (no YAML load) so it is cheap to load in every test sandbox.

The plugin is deliberately import-safe: it only touches ``item.user_properties``
(the same list pytest's own ``record_property`` fixture populates), so the jUnit
reporter serialises the tags with no extra configuration beyond ``--junitxml``.
"""

from __future__ import annotations

REQUIREMENT_PROPERTY = "requirement"
MARKER_NAME = "requirements"


def pytest_configure(config) -> None:
    config.addinivalue_line(
        "markers",
        "requirements(*ids): PR/derived-PR ids this test verifies (traceability).",
    )


def _requirement_ids(item) -> list[str]:
    ids: list[str] = []
    for marker in item.iter_markers(name=MARKER_NAME):
        for arg in marker.args:
            # Accept both @requirements("PR-1", "PR-2") and
            # @requirements("PR-1, PR-2") / @requirements(["PR-1", "PR-2"]).
            if isinstance(arg, (list, tuple, set)):
                ids.extend(str(a).strip() for a in arg)
            else:
                ids.extend(part.strip() for part in str(arg).split(","))
    # De-dup, preserve order.
    seen: set[str] = set()
    out: list[str] = []
    for rid in ids:
        if rid and rid not in seen:
            seen.add(rid)
            out.append(rid)
    return out


def pytest_runtest_setup(item) -> None:
    # Runs before the test body; user_properties recorded here land on the
    # testcase in the jUnit XML regardless of pass/fail/skip.
    for rid in _requirement_ids(item):
        item.user_properties.append((REQUIREMENT_PROPERTY, rid))
