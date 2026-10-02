"""PR-36 — readiness-aware HITL/CI orchestration with contention control (CI side).

The HITL GitHub Actions lane (.github/workflows/hitl.yaml) encodes the orchestration
that keeps a shared, flaky bench trustworthy under concurrent CI:

  * the ``concurrency`` group is scoped PER PR/ref (not one global ``hitl-tests``
    group), so different PRs run concurrently and a new push supersedes only its
    OWN in-flight run — the old global group serialized everything and silently
    cancelled intermediate PRs' HITL check (7dc83fd8 / FUG-102);
  * a "Free runner disk space" step runs before the heavy Nix/Bazel build (FUG-76:
    the runner's ~14 GB can't hold the esp32c6-from-source closure + caches);
  * the suite runs with ``--flaky_test_attempts`` so a transient per-boot DUT wedge
    recovers on a fresh flash while a real regression still fails all attempts and
    gates.

Stdlib-only text inspection of the committed workflow (no YAML dep, so it can never
abort suite collection); each case FAILS if that orchestration regresses. SKIPs
(does not pass) if the workflow file isn't on the test's path — so to COUNT in CI
the lead must make hitl.yaml available to the test (see the report).
"""

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.requirements("PR-36")

_WORKFLOW_REL = ".github/workflows/hitl.yaml"


def _repo_file(relpath):
    """Locate a workspace-relative file under Bazel runfiles or in a source checkout."""
    try:
        from python.runfiles import runfiles as _rf  # Bazel-provided

        r = _rf.Create()
        if r:
            p = r.Rlocation("_main/" + relpath)
            if p and Path(p).is_file():
                return Path(p)
    except Exception:  # noqa: BLE001 - offline (no runfiles): fall back to the source tree
        pass
    for base in Path(__file__).absolute().parents:
        cand = base / relpath
        if cand.is_file():
            return cand
    return None


def _text():
    p = _repo_file(_WORKFLOW_REL)
    if p is None:
        pytest.skip(f"HITL workflow {_WORKFLOW_REL!r} not on the test path; add it as test data")
    return p.read_text()


def test_concurrency_group_is_scoped_per_ref_not_global():
    m = re.search(r"(?m)^\s*group:\s*(.+?)\s*$", _text())
    assert m, "the HITL lane declares no concurrency group"
    group = m.group(1)
    # Per-PR/ref scoping: templated on the ref, never the bare constant that
    # serialized (and cancelled) every run.
    assert group != "hitl-tests", "concurrency group reverted to the global value"
    assert "${{" in group, f"concurrency group is a constant, not per-ref: {group!r}"
    assert (
        "github.event.pull_request.number" in group and "github.ref" in group
    ), f"concurrency group is not scoped to the PR/ref: {group!r}"


def test_a_new_push_supersedes_its_own_in_flight_run():
    assert re.search(
        r"(?m)^\s*cancel-in-progress:\s*true\b", _text()
    ), "cancel-in-progress must be true so a new push supersedes its own stale run"


def test_runner_disk_is_freed_before_the_heavy_build():
    names = re.findall(r"(?mi)^\s*-?\s*name:\s*(.+?)\s*$", _text())
    assert any(
        "free" in n.lower() and "disk" in n.lower() for n in names
    ), f"no runner disk-space reclaim step found; step names={names}"


def test_suite_runs_with_flaky_attempts_so_a_transient_wedge_recovers():
    # Only NON-comment lines count — an explanatory `# --flaky_test_attempts…` comment
    # must not satisfy this (the flag has to be a real argument).
    real = [ln for ln in _text().splitlines() if not ln.lstrip().startswith("#")]
    assert any(
        "--flaky_test_attempts=" in ln for ln in real
    ), "the HITL bazel test invocation does not pass --flaky_test_attempts=<N>"
