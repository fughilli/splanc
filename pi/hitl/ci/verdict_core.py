"""The HITL lane's verdict: infra outcomes don't fail, quarantined tests don't gate.

`bazel test` (with --flaky_test_attempts) says PASSED / FLAKY / FAILED / TIMEOUT per
target. On the shared bench that conflates three different things, so the lane turns
each target's attempts into one of:

  PASS         passed (possibly after a retry: FLAKY counts as a pass, as before).
  FAIL         failed on its own merits: at least one failing attempt that wasn't infra.
  INFRA        every failing attempt was infrastructure — the test never got a fair
               run (the reservation never activated, no rig had a matching unit, the
               rig's ssh/tunnel failed, or bazel killed it while it was still queued).
               The lane re-queues these once; if still INFRA they are SKIPPED: reported
               loudly, but they don't fail the job.
  QUARANTINED  listed in quarantine.toml: still runs and reports PASS/FAIL, never gates.

The infra taxonomy is deliberately narrow: a DUT that won't boot, join Wi-Fi or open
its socket is NOT infra (it can be the firmware under test); see the flake budget
policy in pi/hitl/ci/README.md.

Stdlib only (runs on the runner's python3; unit-tested in //pi/hitl/tests).
"""

from __future__ import annotations

import dataclasses
import datetime as _dt
import json
import re
import tomllib
from typing import Callable, Iterable, Mapping

PASS, FAIL, INFRA, QUARANTINED = "PASS", "FAIL", "INFRA", "QUARANTINED"

# A failing attempt is infra when it carries one of these and no test-failure marker.
_INFRA = [
    # hitl_client's progress-driven give-ups all read "reservation X did not activate
    # <reason>" (#376): the CI deadline, a stalled queue, an unhealthy rig (daemon
    # unreachable / no unit can serve), the safety cap, or the legacy fixed timeout.
    ("ci_deadline", re.compile(r"did not activate before the CI deadline")),
    ("queue_stalled", re.compile(r"did not activate \(queue stalled")),
    ("rig_unreachable", re.compile(r"did not activate \(rig unhealthy: daemon unreachable")),
    ("no_unit_can_serve", re.compile(r"did not activate \(rig unhealthy: no unit can serve")),
    ("reservation_timeout", re.compile(r"reservation \S+ did not activate\b")),
    ("released_before_activating", re.compile(r"reservation released before activating")),
    (
        "no_matching_unit",
        re.compile(r"no reachable host with a matching unit|ReserveError: no hosts:"),
    ),
    (
        "rig_ssh",
        re.compile(
            r"could not probe DUT \S+ from the rig \(ssh|tunnel to \S+ via \S+ did not come up"
        ),
    ),
    ("rig_http", re.compile(r"ReserveError: https?://\S+: \d{3}\b")),
]
_TEST_FAILURE = re.compile(
    r"AssertionError|verdict=FAIL|^(?:\[[\w-]+\] )?FAIL\b|^PROBLEM:|off-margin", re.M
)
_SERIAL_TAIL = "===== DUT serial log:"  # the attached serial log isn't the test's output


def classify_attempt(log: str) -> tuple[str, str]:
    """-> ("infra", why) or ("test", why) for one FAILED/TIMEOUT attempt's test.log."""
    own = log.split(_SERIAL_TAIL)[0]
    # A harness reports its reserve error as "FAIL: <error>": judge the failure
    # markers only on lines that aren't themselves an infra error.
    rest = "\n".join(ln for ln in own.splitlines() if not any(rx.search(ln) for _, rx in _INFRA))
    if _TEST_FAILURE.search(rest):
        return "test", "test failure marker"
    for name, rx in _INFRA:
        if rx.search(own):
            return "infra", name
    # Killed (bazel TIMEOUT) while still waiting in the rig queue: it never reserved.
    if re.search(r"(?m)^queued:", own) and not re.search(r"(?m)^reserved:", own):
        return "infra", "killed_while_queued"
    return "test", "failed"


@dataclasses.dataclass(frozen=True)
class Entry:
    test: str
    reason: str
    issue: str
    owner: str
    since: _dt.date
    review_by: _dt.date


class QuarantineError(ValueError):
    pass


_KEYS = {"test", "reason", "issue", "owner", "since", "review_by"}


def load_quarantine(text: str) -> dict[str, Entry]:
    try:
        doc = tomllib.loads(text)
    except tomllib.TOMLDecodeError as e:
        raise QuarantineError(str(e)) from e
    if set(doc) - {"quarantine"}:
        raise QuarantineError(f"unknown top-level keys {sorted(set(doc) - {'quarantine'})}")
    out: dict[str, Entry] = {}
    for i, q in enumerate(doc.get("quarantine", [])):
        if set(q) != _KEYS:
            raise QuarantineError(f"entry #{i}: needs exactly {sorted(_KEYS)}, got {sorted(q)}")
        if not str(q["test"]).startswith("//"):
            raise QuarantineError(f"entry #{i}: test must be an absolute label")
        for k in ("since", "review_by"):
            if not isinstance(q[k], _dt.date):
                raise QuarantineError(f"entry #{i}: {k} must be a TOML date (YYYY-MM-DD)")
        if q["test"] in out:
            raise QuarantineError(f"duplicate entry for {q['test']}")
        out[q["test"]] = Entry(**{k: q[k] for k in _KEYS})
    return out


# ---------------------------------------------------------------------------
# Build Event Protocol (--build_event_json_file) -> per-target attempts


@dataclasses.dataclass
class Attempt:
    n: int
    status: str  # PASSED / FAILED / TIMEOUT / ...
    log: str  # path to the attempt's test.log ('' if none)


@dataclasses.dataclass
class Outcome:
    label: str
    overall: str = "NO_STATUS"
    attempts: list[Attempt] = dataclasses.field(default_factory=list)


def _file(uri: str) -> str:
    return uri[len("file://") :] if uri.startswith("file://") else ""


def parse_bep(lines: Iterable[str]) -> dict[str, Outcome]:
    out: dict[str, Outcome] = {}
    for ln in lines:
        ln = ln.strip()
        if not ln:
            continue
        try:
            ev = json.loads(ln)
        except json.JSONDecodeError:
            continue
        eid = ev.get("id", {})
        if "testResult" in eid and "testResult" in ev:
            label = eid["testResult"]["label"]
            o = out.setdefault(label, Outcome(label))
            log = next(
                (
                    _file(f.get("uri", ""))
                    for f in ev["testResult"].get("testActionOutput", [])
                    if f.get("name") == "test.log"
                ),
                "",
            )
            o.attempts.append(
                Attempt(
                    int(eid["testResult"].get("attempt", 1)),
                    ev["testResult"].get("status", "NO_STATUS"),
                    log,
                )
            )
        elif "testSummary" in eid and "testSummary" in ev:
            label = eid["testSummary"]["label"]
            out.setdefault(label, Outcome(label)).overall = ev["testSummary"].get(
                "overallStatus", "NO_STATUS"
            )
    for o in out.values():
        o.attempts.sort(key=lambda a: a.n)
    return out


def merge(runs: Iterable[Mapping[str, Outcome]]) -> dict[str, Outcome]:
    """Later invocations (a re-queue) supersede earlier ones target by target, but
    every attempt is kept for the report."""
    out: dict[str, Outcome] = {}
    for run in runs:
        for label, o in run.items():
            prev = out.get(label)
            o2 = Outcome(label, o.overall, (prev.attempts if prev else []) + o.attempts)
            out[label] = o2
    return out


# ---------------------------------------------------------------------------


@dataclasses.dataclass
class Result:
    label: str
    verdict: str  # PASS / FAIL / INFRA / QUARANTINED
    status: str  # bazel's overall status of the deciding run
    why: str
    quarantined_outcome: str = ""  # PASS/FAIL/INFRA under quarantine
    attempts: list[dict] = dataclasses.field(default_factory=list)


def judge(
    o: Outcome, read_log: Callable[[str], str], last_attempts: Iterable[Attempt]
) -> tuple[str, str, list[dict]]:
    """Verdict of one target from its deciding run's attempts."""
    rows = []
    kinds = []
    for a in last_attempts:
        row = {"attempt": a.n, "status": a.status}
        if a.status != "PASSED":
            try:
                text = read_log(a.log) if a.log else ""
            except OSError:
                text = ""
            kind, why = classify_attempt(text) if text else ("test", "no log")
            row.update(kind=kind, why=why)
            kinds.append(kind)
        rows.append(row)
    if o.overall in ("PASSED", "FLAKY"):
        flaky = [r for r in rows if r.get("kind") == "test"]
        return PASS, ("passed after a non-infra retry" if flaky else "passed"), rows
    if kinds and all(k == "infra" for k in kinds):
        whys = sorted({r["why"] for r in rows if r.get("kind") == "infra"})
        return INFRA, "every failing attempt was infra: " + ", ".join(whys), rows
    if not rows:
        return FAIL, f"no attempt recorded (bazel status {o.overall})", rows
    return FAIL, f"bazel {o.overall}", rows


def verdict(
    requested: Iterable[str],
    runs: list[Mapping[str, Outcome]],
    quarantine: Mapping[str, Entry],
    read_log: Callable[[str], str],
) -> list[Result]:
    """One Result per requested target. `runs` are the BEP outcomes of each bazel
    invocation in order (the second one, if any, is the infra re-queue)."""
    results = []
    for label in sorted(set(requested)):
        deciding = None
        for run in runs:
            if label in run:
                deciding = run[label]
        if deciding is None:
            v, why, rows, status = (
                FAIL,
                "no test result (build failed or bazel aborted)",
                [],
                "NO_STATUS",
            )
        else:
            v, why, rows = judge(deciding, read_log, deciding.attempts)
            status = deciding.overall
        all_rows = [
            dict(r, invocation=i)
            for i, run in enumerate(runs)
            if label in run
            for r in judge(run[label], read_log, run[label].attempts)[2]
        ]
        if label in quarantine:
            results.append(Result(label, QUARANTINED, status, why, v, all_rows or rows))
        else:
            results.append(Result(label, v, status, why, "", all_rows or rows))
    return results


def requeue(results: Iterable[Result]) -> list[str]:
    return [r.label for r in results if r.verdict == INFRA]


def gating_failures(results: Iterable[Result]) -> list[Result]:
    return [r for r in results if r.verdict == FAIL]


def summary_markdown(
    results: list[Result], quarantine: Mapping[str, Entry], today: _dt.date
) -> str:
    icon = {PASS: "pass", FAIL: "**FAIL**", INFRA: "skipped (infra)", QUARANTINED: "quarantined"}
    lines = ["### HITL verdict", "", "| test | verdict | bazel | why |", "|---|---|---|---|"]
    for r in results:
        v = icon[r.verdict]
        if r.verdict == QUARANTINED:
            v += f" ({r.quarantined_outcome})"
        lines.append(f"| `{r.label}` | {v} | {r.status} | {r.why} |")
    q = [quarantine[r.label] for r in results if r.label in quarantine]
    if q:
        lines += ["", "Quarantined (runs, reports, doesn't gate):", ""]
        for e in q:
            late = " — **past its review date**" if e.review_by < today else ""
            lines.append(
                f"- `{e.test}`: {e.reason} ({e.issue}, {e.owner}, review by {e.review_by}){late}"
            )
    return "\n".join(lines) + "\n"
