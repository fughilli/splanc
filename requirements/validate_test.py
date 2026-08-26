"""The committed requirements model is structurally and referentially valid.

Requirements: PR-23, PR-25

This is the guard that keeps requirements/requirements.yaml honest: it fails the
build on any malformed entity, bad id, dangling reference, or non-bidirectional
risk<->mitigation trace.
"""

import os

import pytest
from traceability.model import load_model


def _model_path() -> str:
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "requirements.yaml")


@pytest.mark.requirements("PR-23", "PR-25")
def test_requirements_model_is_valid():
    # load_model raises ValidationError (with the full problem list) on any issue.
    model = load_model(_model_path())
    assert model.user_needs, "expected at least one user need"
    assert model.direct_requirements(), "expected at least one direct requirement"
    assert model.risks, "expected at least one risk"


@pytest.mark.requirements("PR-25")
def test_every_risk_has_a_mitigation():
    model = load_model(_model_path())
    for risk in model.risks.values():
        assert model.requirements_for_risk(risk.id), f"{risk.id} has no mitigating derived PR"
