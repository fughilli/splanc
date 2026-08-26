"""Tests for the requirements model loader/validator.

Requirements: PR-23, PR-25
"""

import pytest
from traceability.model import Method, ValidationError, method_rank, parse_model

GOOD = {
    "user_needs": [{"id": "UN-1", "title": "Need"}],
    "product_requirements": [
        {"id": "PR-1", "title": "Direct", "satisfies": ["UN-1"]},
        {
            "id": "PR-2",
            "title": "Mitigation",
            "kind": "derived",
            "mitigates": ["RISK-1"],
        },
    ],
    "risks": [{"id": "RISK-1", "title": "Hazard", "mitigated_by": ["PR-2"]}],
}


@pytest.mark.requirements("PR-23")
def test_valid_model_parses_clean():
    model, errors = parse_model(GOOD)
    assert errors == []
    assert set(model.user_needs) == {"UN-1"}
    assert model.requirements["PR-2"].is_derived
    assert model.requirements_for_risk("RISK-1")[0].id == "PR-2"
    assert model.requirements_for_need("UN-1")[0].id == "PR-1"


@pytest.mark.requirements("PR-25")
def test_direct_pr_must_satisfy_a_need():
    data = {
        "user_needs": [{"id": "UN-1", "title": "Need"}],
        "product_requirements": [{"id": "PR-1", "title": "orphan"}],
        "risks": [],
    }
    _, errors = parse_model(data)
    assert any("must satisfy at least one user need" in e for e in errors)
    # UN-1 is now unsatisfied too.
    assert any("not satisfied by any product requirement" in e for e in errors)


@pytest.mark.requirements("PR-25")
def test_derived_pr_must_mitigate_a_risk():
    data = {
        "user_needs": [],
        "product_requirements": [{"id": "PR-1", "title": "x", "kind": "derived"}],
        "risks": [],
    }
    _, errors = parse_model(data)
    assert any("must mitigate at least one risk" in e for e in errors)


@pytest.mark.requirements("PR-25")
def test_mitigation_trace_must_be_bidirectional():
    data = {
        "user_needs": [],
        "product_requirements": [
            {"id": "PR-2", "title": "m", "kind": "derived", "mitigates": ["RISK-1"]}
        ],
        # RISK-1 does not list PR-2 back.
        "risks": [{"id": "RISK-1", "title": "h", "mitigated_by": []}],
    }
    _, errors = parse_model(data)
    assert any("mitigation trace must be bidirectional" in e for e in errors)


@pytest.mark.requirements("PR-25")
def test_risk_mitigated_by_must_be_derived():
    data = {
        "user_needs": [{"id": "UN-1", "title": "n"}],
        # PR-1 is direct but a risk claims it as a mitigation.
        "product_requirements": [{"id": "PR-1", "title": "d", "satisfies": ["UN-1"]}],
        "risks": [{"id": "RISK-1", "title": "h", "mitigated_by": ["PR-1"]}],
    }
    _, errors = parse_model(data)
    assert any("not a derived requirement" in e for e in errors)


@pytest.mark.requirements("PR-23")
def test_bad_ids_are_rejected():
    data = {
        "user_needs": [{"id": "U1", "title": "n"}],
        "product_requirements": [],
        "risks": [],
    }
    _, errors = parse_model(data)
    assert any("id must match UN-<n>" in e for e in errors)


@pytest.mark.requirements("PR-23")
def test_method_ordering_is_analysis_to_hitl():
    assert (
        method_rank("analysis")
        < method_rank("simulation")
        < method_rank("sil")
        < method_rank("hil")
        < method_rank("hitl")
    )
    assert int(Method.HITL) == max(int(m) for m in Method)
    # inspection is deliberately unordered (incomparable), and so is nonsense.
    assert method_rank("inspection") is None
    assert method_rank("bogus") is None


@pytest.mark.requirements("PR-23")
def test_method_defaults_to_simulation_and_validates():
    model, errors = parse_model(GOOD)
    assert errors == []
    assert model.requirements["PR-1"].method == "simulation"  # defaulted
    bad = {
        "user_needs": [{"id": "UN-1", "title": "n"}],
        "product_requirements": [
            {"id": "PR-1", "title": "x", "satisfies": ["UN-1"], "method": "vibes"}
        ],
        "risks": [],
    }
    _, errors = parse_model(bad)
    assert any("method must be one of" in e for e in errors)


@pytest.mark.requirements("PR-23")
def test_verified_by_accepts_string_or_mapping():
    data = {
        "user_needs": [{"id": "UN-1", "title": "n"}],
        "product_requirements": [
            {
                "id": "PR-1",
                "title": "x",
                "satisfies": ["UN-1"],
                "method": "hitl",
                "verified_by": ["//a:bare", {"target": "//b:rich", "level": "hitl"}],
            }
        ],
        "risks": [],
    }
    model, errors = parse_model(data)
    assert errors == []
    vbs = model.requirements["PR-1"].verified_by
    assert vbs[0].target == "//a:bare" and vbs[0].level == "simulation"  # default
    assert vbs[1].target == "//b:rich" and vbs[1].level == "hitl"


@pytest.mark.requirements("PR-23")
def test_validation_error_carries_all_problems():
    with pytest.raises(ValidationError) as exc:
        import io
        import tempfile

        from traceability.model import load_model  # noqa: PLC0415

        # Write a broken model to a temp file and load it.
        with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as fh:
            fh.write("user_needs: [{id: UN-1, title: n}]\nproduct_requirements: []\nrisks: []\n")
            path = fh.name
        load_model(path)
    assert exc.value.errors  # non-empty
    _ = io  # silence unused import lint if any
