"""Pytest entry point: rules_requirements' traceability-enabled runner.

@rr(PR-25): the traceability-enabled test runner of this suite

Writes JUnit XML to $XML_OUTPUT_FILE with the @pytest.mark.requirements markers
emitted as traceability properties (see docs/requirements-driven-development.md).
"""

from rules_requirements.hooks.pytest_runner import main

if __name__ == "__main__":
    raise SystemExit(main(__file__))
