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
    assert "//pkg:target (target, simulation)" in m.pr_status["PR-9"].passed


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
def test_underverified_when_evidence_below_demanded_method():
    model, errs = parse_model(
        {
            "user_needs": [{"id": "UN-1", "title": "n"}],
            "product_requirements": [
                {"id": "PR-1", "title": "hw", "satisfies": ["UN-1"], "method": "hitl"},
                {"id": "PR-2", "title": "hw-ok", "satisfies": ["UN-1"], "method": "hitl"},
            ],
            "risks": [],
        }
    )
    assert errs == []
    r = JUnitResults()
    r.cases = [
        # PR-1 covered only by a simulation-level test -> AMBER (under-verified).
        CaseResult(
            name="t1", classname="c", status="passed", requirements=("PR-1",), level="simulation"
        ),
        # PR-2 covered by an on-hardware test -> GREEN.
        CaseResult(name="t2", classname="c", status="passed", requirements=("PR-2",), level="hitl"),
    ]
    m = report.build_matrix(model, r)
    assert m.pr_status["PR-1"].status == report.UNDERVERIFIED
    assert m.pr_status["PR-1"].demanded == "hitl"
    assert m.pr_status["PR-1"].provided == "simulation"
    assert m.pr_status["PR-2"].status == report.VERIFIED
    # A user need with an under-verified PR is only PARTIAL, not VALIDATED.
    assert m.un_status["UN-1"] == report.PARTIAL
    html = report.render_html(m)
    assert "UNDER-VERIFIED" in html


@pytest.mark.requirements("PR-25")
def test_untagged_evidence_defaults_to_simulation():
    model, _ = parse_model(
        {
            "user_needs": [{"id": "UN-1", "title": "n"}],
            "product_requirements": [
                {"id": "PR-1", "title": "sim", "satisfies": ["UN-1"]},  # demands simulation
            ],
            "risks": [],
        }
    )
    r = JUnitResults()
    # No level tag -> provides simulation, which meets the simulation demand.
    r.cases = [CaseResult(name="t", classname="c", status="passed", requirements=("PR-1",))]
    m = report.build_matrix(model, r)
    assert m.pr_status["PR-1"].status == report.VERIFIED


@pytest.mark.requirements("PR-25")
def test_cost_pyramid_policy_flags_expensive_only_evidence():
    model, _ = parse_model(
        {
            "user_needs": [{"id": "UN-1", "title": "n"}],
            "product_requirements": [
                # demands hitl, only hitl evidence -> pyramid violation
                {"id": "PR-1", "title": "lonely", "satisfies": ["UN-1"], "method": "hitl"},
                # demands hitl, has both hitl and a cheap sim rung -> OK
                {"id": "PR-2", "title": "backed", "satisfies": ["UN-1"], "method": "hitl"},
                # demands simulation -> never a pyramid concern
                {"id": "PR-3", "title": "cheap", "satisfies": ["UN-1"], "method": "simulation"},
            ],
            "risks": [],
        }
    )
    r = JUnitResults()
    r.cases = [
        CaseResult(name="a", classname="c", status="passed", requirements=("PR-1",), level="hitl"),
        CaseResult(name="b", classname="c", status="passed", requirements=("PR-2",), level="hitl"),
        CaseResult(
            name="b2", classname="c", status="passed", requirements=("PR-2",), level="simulation"
        ),
        CaseResult(name="c", classname="c", status="passed", requirements=("PR-3",), level="hitl"),
    ]
    m = report.build_matrix(model, r)
    assert m.pyramid_violations() == ["PR-1"]
    assert m.pr_status["PR-1"].pyramid_violation is True
    assert m.pr_status["PR-2"].pyramid_violation is False
    assert m.pr_status["PR-3"].pyramid_violation is False
    assert "Cost-pyramid policy" in report.render_html(m)


@pytest.mark.requirements("PR-25")
def test_render_html_is_self_contained_and_lists_entities():
    m = report.build_matrix(MODEL, _results())
    html = report.render_html(m)
    assert html.startswith("<!doctype html>")
    for ident in ("UN-1", "PR-1", "PR-2", "RISK-1", "VERIFIED", "FAILED"):
        assert ident in html
    # No external resources.
    assert "http://" not in html and "https://" not in html.replace("json-schema.org", "")
