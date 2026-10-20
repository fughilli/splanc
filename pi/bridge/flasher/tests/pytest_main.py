"""Pytest entry point: rules_requirements' traceability-enabled runner (as pi/bridge)."""

from rules_requirements.hooks.pytest_runner import main

if __name__ == "__main__":
    raise SystemExit(main(__file__))
