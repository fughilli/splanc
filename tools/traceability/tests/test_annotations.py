"""Tests for the source annotation scanner.

Requirements: PR-41, PR-44
"""

import pytest
from traceability import annotations
from traceability.model import parse_model

# Built from parts so this test file's own source is not picked up by the
# tree-wide scanner (//requirements:check_annotations) as a real annotation
# referencing a bogus id — the scanner is a plain text scan and cannot tell a
# fixture string from a live marker.
REQ_KW = "Requirements" + ":"
MARK = "@" + "requirements"

MODEL, _ = parse_model(
    {
        "user_needs": [{"id": "UN-1", "title": "n"}],
        "product_requirements": [{"id": "PR-1", "title": "d", "satisfies": ["UN-1"]}],
        "risks": [],
    }
)


@pytest.mark.requirements("PR-41")
def test_extracts_module_and_test_references():
    text = f'''
"""A module.

{REQ_KW} PR-1, PR-2
"""

{MARK}("PR-1", "PR-3")
def test_x():
    pass
'''
    refs = annotations.extract_from_text(text, "mod.py")
    got = {(r.pr_id, r.kind) for r in refs}
    assert ("PR-1", "module") in got
    assert ("PR-2", "module") in got
    assert ("PR-1", "test") in got
    assert ("PR-3", "test") in got


@pytest.mark.requirements("PR-44")
def test_unknown_references_flagged_against_model():
    text = f'{REQ_KW} PR-1, PR-99\n{MARK}("PR-42")'
    refs = annotations.extract_from_text(text, "m.py")
    unknown = {r.pr_id for r in annotations.unknown_references(refs, MODEL)}
    assert unknown == {"PR-99", "PR-42"}
