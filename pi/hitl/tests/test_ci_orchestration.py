"""PR-36 — readiness-aware HITL/CI orchestration with contention control (CI side).

The HITL GitHub Actions lane (.github/workflows/hitl.yaml) encodes the orchestration
that keeps a shared, flaky bench trustworthy under concurrent CI:

  * the ``concurrency`` group is scoped PER PR/ref (not one global ``hitl-tests``
    group), so different PRs run concurrently and a new push supersedes only its
    OWN in-flight run — the old global group serialized everything and silently
    cancelled intermediate PRs' HITL check (7dc83fd8 / FUG-102);
  * the step that frees runner disk (``uses: ...maximize-github-runner-space``)
    runs before Nix is installed and before the ``bazel test`` step (FUG-76: the
    runner's ~14 GB can't hold the esp32c6-from-source closure + caches);
  * the ``bazel test`` invocation passes ``--flaky_test_attempts=N`` with N >= 2,
    so a transient per-boot DUT wedge recovers on a fresh flash while a real
    regression still fails all attempts and gates.

Stdlib-only text inspection of the committed workflow (no YAML dep, so it can never
abort suite collection); each case FAILS if that orchestration regresses. The
workflow is test data of //pi/hitl/tests:hitl_test, so under Bazel a missing file
FAILS every case; only a source-checkout run without it SKIPs.
"""

import os
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
        if os.environ.get("TEST_SRCDIR"):
            pytest.fail(
                f"HITL workflow {_WORKFLOW_REL!r} missing from the test's runfiles (BUILD data)"
            )
        pytest.skip(f"HITL workflow {_WORKFLOW_REL!r} not found in this source checkout")
    return p.read_text()


def _steps(text):
    """The workflow's steps, in order, as (name, uses, run) — split on the `- `
    items of the (single) job's `steps:` list."""
    lines = text.splitlines()
    start = next(i for i, ln in enumerate(lines) if re.match(r"^\s*steps:\s*$", ln))
    item_indent = None
    blocks = []
    for ln in lines[start + 1 :]:
        if not ln.strip() or ln.lstrip().startswith("#"):
            if blocks:
                blocks[-1].append(ln)
            continue
        indent = len(ln) - len(ln.lstrip())
        if item_indent is None:
            item_indent = indent
        if indent < item_indent:
            break  # left the steps list
        if indent == item_indent and ln.lstrip().startswith("- "):
            blocks.append([ln])
        elif blocks:
            blocks[-1].append(ln)

    def field(block, key):
        for ln in block:
            m = re.match(rf"^\s*(?:-\s+)?{key}:\s*(.*?)\s*$", ln)
            if m:
                return m.group(1)
        return ""

    return [("\n".join(b), field(b, "name"), field(b, "uses")) for b in blocks]


def _bazel_test_commands(step_text):
    """Each `bazel test ...` command in a run script, continuation lines joined."""
    joined = re.sub(r"\\\n\s*", " ", step_text)
    return [ln.strip() for ln in joined.splitlines() if re.match(r"^\s*bazel\s+test\b", ln)]


def test_concurrency_group_is_scoped_per_ref_not_global():
    m = re.search(r"(?m)^\s*group:\s*(.+?)\s*$", _text())
    assert m, "the HITL lane declares no concurrency group"
    group = m.group(1)
    # Per-PR/ref scoping: a template that expands to a per-PR/ref value, never
    # the bare constant that serialized (and cancelled) every run.
    assert group != "hitl-tests", "concurrency group reverted to the global value"
    exprs = re.findall(r"\$\{\{(.*?)\}\}", group)
    assert exprs, f"concurrency group is a constant, not per-ref: {group!r}"
    per_ref = re.compile(
        r"github\.(ref|head_ref|ref_name|event\.pull_request\.number|event\.number)\b"
    )
    assert any(
        per_ref.search(e) for e in exprs
    ), f"concurrency group's template references no PR/ref context: {group!r}"


def test_a_new_push_supersedes_its_own_in_flight_run():
    assert re.search(
        r"(?m)^\s*cancel-in-progress:\s*true\b", _text()
    ), "cancel-in-progress must be true so a new push supersedes its own stale run"


def test_runner_disk_is_freed_before_the_heavy_build():
    steps = _steps(_text())
    names = [name for _, name, _ in steps]

    def index_of(pred, what):
        hits = [i for i, step in enumerate(steps) if pred(*step)]
        assert hits, f"no {what} step found; steps={names}"
        return hits[0]

    free = index_of(
        lambda _t, _n, uses: "maximize-github-runner-space" in uses, "disk-space reclaim (uses:)"
    )
    nix = index_of(
        lambda _t, name, uses: "nix-quick-install-action" in uses or name.lower() == "install nix",
        "Install Nix",
    )
    test_step = index_of(lambda text, _n, _u: bool(_bazel_test_commands(text)), "`bazel test`")
    assert free < nix, f"disk is freed ({names[free]!r}) only after {names[nix]!r}"
    assert free < test_step, f"disk is freed ({names[free]!r}) only after {names[test_step]!r}"


def test_suite_runs_with_flaky_attempts_so_a_transient_wedge_recovers():
    # The flag must be an argument of the `bazel test` invocation itself (an
    # explanatory comment or another command does not count), with at least one
    # retry.
    commands = [c for text, _, _ in _steps(_text()) for c in _bazel_test_commands(text)]
    assert commands, "the HITL lane has no `bazel test` invocation"
    attempts = [int(n) for c in commands for n in re.findall(r"--flaky_test_attempts=(\d+)\b", c)]
    assert attempts, "the HITL bazel test invocation does not pass --flaky_test_attempts=<N>"
    assert min(attempts) >= 2, f"--flaky_test_attempts={min(attempts)} gives a wedged DUT no retry"


# --- priority classes + progress-driven queue waits (hitl-reserve #17) ---------


def _gating_command():
    """The pool lane's `bazel test` (the one forwarding HITL_SERVERS)."""
    commands = [c for text, _, _ in _steps(_text()) for c in _bazel_test_commands(text)]
    gating = [c for c in commands if "--test_env=HITL_SERVERS" in c]
    assert len(gating) == 1, f"expected one pool-lane bazel test, got {gating}"
    return gating[0]


def test_ci_reserves_with_a_priority_class_from_the_event():
    m = re.search(r"(?m)^\s*HITL_PRIORITY:\s*(.+?)\s*$", _text())
    assert m, "the HITL job sets no HITL_PRIORITY (rig queue scheduling class)"
    expr = m.group(1)
    # merge_group runs and the post-merge push to main are merge-critical; the rest
    # of CI is pr-ci. (dev is the default outside CI, never set here.)
    assert "merge_group" in expr and "push" in expr and "'merge-queue'" in expr, expr
    assert "'pr-ci'" in expr, expr
    assert "--test_env=HITL_PRIORITY" in _gating_command(), "HITL_PRIORITY not forwarded to tests"
    assert re.search(r"(?m)^\s*merge_group:\s*$", _text()), "no merge_group trigger"


def test_queue_waits_have_a_job_ceiling_not_a_fixed_timeout():
    text = _text()
    cmd = _gating_command()
    # Tests may wait in a progressing queue past the old 3600 s per-test bound ...
    m = re.search(r"--test_timeout=(\S+)", cmd)
    assert m, "the pool lane keeps Bazel's 3600 s eternal timeout (it caps the queue wait)"
    eternal = int(m.group(1).split(",")[-1])
    assert eternal > 3600, f"eternal test timeout {eternal}s still caps the queue wait"
    # ... while the whole job keeps a hard ceiling: a deadline for getting a unit,
    # forwarded to every test, under the job's timeout-minutes ...
    assert "--test_env=HITL_DEADLINE" in cmd
    assert re.search(r"export HITL_DEADLINE=", text), "HITL_DEADLINE is never computed"
    tm = re.search(r"(?m)^\s*timeout-minutes:\s*(\d+)\s*$", text)
    assert tm and int(tm.group(1)) <= 360, "the HITL job has no explicit timeout-minutes ceiling"
    budget = re.search(r"(?m)^\s*HITL_QUEUE_BUDGET_MIN:\s*'?(\d+)'?\s*$", text)
    assert budget and int(budget.group(1)) < int(
        tm.group(1)
    ), "queue budget must leave time for the body"
    # ... and a hung test body still can't hold a board for longer than an hour.
    hold = re.search(r"(?m)^\s*HITL_HOLD_MAX:\s*'?(\d+)'?\s*$", text)
    assert hold and 0 < int(hold.group(1)) <= 3600, "raising the Bazel timeout needs HITL_HOLD_MAX"
    assert "--test_env=HITL_HOLD_MAX" in cmd
