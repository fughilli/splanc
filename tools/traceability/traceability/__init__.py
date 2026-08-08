"""Requirements-driven-development traceability toolkit for splanc.

Requirements: PR-40, PR-41, PR-42, PR-43

This package is the machinery behind the workflow described in
``docs/requirements-driven-development.md``:

* :mod:`traceability.model` loads and validates the machine-readable
  requirements model (``requirements/requirements.yaml``) — user needs (UN),
  product requirements (PR), risks (RISK), and the derived PRs that mitigate
  risks. (PR-40)
* :mod:`traceability.pytest_requirements` is a pytest plugin providing the
  ``@pytest.mark.requirements("PR-…")`` marker that stamps each test's jUnit
  ``<testcase>`` with ``<property name="requirement">`` traceability tags.
  (PR-41)
* :mod:`traceability.pytest_runner` is the shared Bazel ``py_test`` entry point
  that writes jUnit XML to ``$XML_OUTPUT_FILE`` with those tags. (PR-41)
* :mod:`traceability.junit` parses the tagged jUnit XML back into per-test
  results. (PR-42)
* :mod:`traceability.report` joins the model with the test results and renders
  the HTML verification/validation matrix. (PR-43)
* :mod:`traceability.cli` is the ``aggregate`` command wired into CI. (PR-43)
"""

from traceability.model import (  # noqa: F401
    Requirement,
    RequirementsModel,
    Risk,
    UserNeed,
    ValidationError,
    load_model,
)

__all__ = [
    "Requirement",
    "RequirementsModel",
    "Risk",
    "UserNeed",
    "ValidationError",
    "load_model",
]
