"""Tests for the traceability matrix + HTML report.

Requirements: PR-25
"""

import pytest
from traceability import report
from traceability.junit import CaseResult, JUnitResults
from traceability.model import parse_model

MODEL, _ERRORS = parse_model(
    {
        "user_needs": [
            {"id": "UN-1", "title": "Need one"},
            {"id": "UN-2", "title": "Need two"},
        ],
        "product_requirements": [
            {"id": "PR-1", "title": "verified", "satisfies": ["UN-1"]},
            {"id": "PR-2", "title": "failing", "satisfies": ["UN-1"]},
            {"id": "PR-3", "title": "unverified", "satisfies": ["UN-2"]},
            {
                "id": "PR-9",
                "title": "coarse",
                "kind": "derived",
                "mitigates": ["RISK-1"],
                "verified_by": ["//pkg:target"],
            },
        ],
        "risks": [{"id": "RISK-1", "title": "hazard", "mitigated_by": ["PR-9"]}],
    }
)


def _results():
    r = JUnitResults()
    r.cases = [
        CaseResult(name="t1", classname="c", status="passed", requirements=("PR-1",)),
        CaseResult(name="t2", classname="c", status="failed", requirements=("PR-2",)),
    ]
    r.merge_target("//pkg:target", "passed")
    return r


@pytest.mark.requirements("PR-25")
def test_matrix_verification_status():
    m = report.build_matrix(MODEL, _results())
    assert m.pr_status["PR-1"].status == report.VERIFIED
    assert m.pr_status["PR-2"].status == report.FAILED
    assert m.pr_status["PR-3"].status == report.UNVERIFIED
    # Coarse per-target verification.
    assert m.pr_status["PR-9"].status == report.VERIFIED
    assert "//pkg:target (target)" in m.pr_status["PR-9"].passed


@pytest.mark.requirements("PR-25")
def test_user_need_validation_rolls_up():
    m = report.build_matrix(MODEL, _results())
    # UN-1 has a failing PR -> FAILED; UN-2's only PR is unverified.
    assert m.un_status["UN-1"] == report.FAILED
    assert m.un_status["UN-2"] == report.UNVERIFIED


@pytest.mark.requirements("PR-25")
def test_risk_mitigation_rolls_up():
    m = report.build_matrix(MODEL, _results())
    assert m.risk_status["RISK-1"] == report.MITIGATED


@pytest.mark.requirements("PR-25")
def test_render_html_is_self_contained_and_lists_entities():
    m = report.build_matrix(MODEL, _results())
    html = report.render_html(m)
    assert html.startswith("<!doctype html>")
    for ident in ("UN-1", "PR-1", "PR-2", "RISK-1", "VERIFIED", "FAILED"):
        assert ident in html
    # No external resources.
    assert "http://" not in html and "https://" not in html.replace("json-schema.org", "")
