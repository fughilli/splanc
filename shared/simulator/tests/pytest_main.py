"""Pytest entry point — traceability-enabled shared runner.

Requirements: PR-41

Delegates to //tools/traceability so this suite writes jUnit XML to
$XML_OUTPUT_FILE with the @requirements markers emitted as traceability tags.
"""

from traceability.pytest_runner import main

if __name__ == "__main__":
    raise SystemExit(main(__file__))
