"""Tests for the ``aggregate`` CLI entry point.

Requirements: PR-25
"""

import textwrap

import pytest
from traceability.cli import main

pytestmark = pytest.mark.requirements("PR-25")

_MODEL = textwrap.dedent(
    """
    user_needs:
      - id: UN-1
        title: Need one
    product_requirements:
      - id: PR-1
        title: Direct requirement
        satisfies: [UN-1]
    """
)


def _write_model(tmp_path):
    path = tmp_path / "requirements.yaml"
    path.write_text(_MODEL, encoding="utf-8")
    return path


def test_aggregate_runs_with_explicit_subcommand(tmp_path):
    model = _write_model(tmp_path)
    out = tmp_path / "report.html"
    rc = main(
        ["aggregate", "--requirements", str(model), "--junit", str(tmp_path), "--out", str(out)]
    )
    assert rc == 0
    assert out.exists()
    assert "UN-1" in out.read_text(encoding="utf-8")


def test_aggregate_defaults_the_subcommand(tmp_path):
    # CI and the docs invoke `bazel run :aggregate -- --requirements ...` without
    # the `aggregate` subcommand; the entry point must tolerate that.
    model = _write_model(tmp_path)
    out = tmp_path / "report.html"
    rc = main(["--requirements", str(model), "--junit", str(tmp_path), "--out", str(out)])
    assert rc == 0
    assert out.exists()


def test_invalid_model_returns_two(tmp_path):
    bad = tmp_path / "bad.yaml"
    # PR-1 satisfies a user need that does not exist -> dangling trace.
    bad.write_text(
        "product_requirements:\n  - id: PR-1\n    title: dangles\n    satisfies: [UN-99]\n",
        encoding="utf-8",
    )
    out = tmp_path / "report.html"
    rc = main(["--requirements", str(bad), "--junit", str(tmp_path), "--out", str(out)])
    assert rc == 2
    assert not out.exists()
