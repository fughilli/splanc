"""HITL lane verdict (pi/hitl/ci/verdict_core.py) and the flake report's parsing.

Pinned: which failing attempts count as infra (and so re-queue, then SKIP instead of
failing the job), that quarantined tests run and report but never gate, that a
malformed quarantine list is rejected, and that the workflow wires the verdict in.
The attempt logs below are trimmed from real hitl_tests job logs (2026-10).
"""

import datetime as dt
import json
import re
from pathlib import Path

import flake_report
import pytest
import verdict_core as vc

E2E = "//pi/hitl/harness:e2e_netstack"
FX = "//pi/hitl/harness:fx_bench_netstack"
REJOIN = "//pi/hitl/harness:rejoin_loop"

ACTIVATION_TIMEOUT = """\
queued: position 7
queued: position 6
Traceback (most recent call last):
hitl_client.ReserveError: reservation 4d34850d8cfe1ca0 did not activate within 2400s
"""
NO_UNIT_REPORTED_AS_FAIL = """\
FAIL: no reachable host with a matching unit (device=any, sku=esp32c6, caps=[]); \
http://tentacle-lamp-1:8087: <urlopen error [Errno 111] Connection refused>
[junit] wrote 1 phase result(s) -> /tmp/test.xml
"""
KILLED_WHILE_QUEUED = """\
[ble-e2e] sequence: hello + 7 map windows (6706B map)
queued: position 4
queued: position 3
-- Test timed out at 2026-10-22 23:19:54 UTC --
"""
WSS_NEVER_UP = """\
reserved: id=7293a07def2bd666 on http://hitl-rig-1:8087 unit=c6-2ce684
[flash] OK — booted the app and BLE is advertising
ws never came up at wss://localhost:41023/ws: TimeoutError: timed out during opening handshake
===== DUT serial log: c6-2ce684 dut0.log (reservation 7293a07def2bd666) (last 40 of 900 lines) =====
hitl_client.ReserveError: reservation x did not activate within 2400s
"""
OFF_MARGIN = """\
reserved: id=1 on http://hitl-rig-2:8087 unit=c6-a
FAIL: 2 effect(s) off-margin, 0 missing vs golden
"""
TIMEOUT_MID_RUN = """\
reserved: id=1 on http://hitl-rig-1:8087 unit=c6-123170
BOOT_JSON {"booted": true, "lease_ms": 10313}
-- Test timed out at 2026-10-22 23:19:54 UTC --
"""
RIG_SSH = """\
reserved: id=1 on http://hitl-rig-2:8087 unit=c6-a
hitl_client.ReserveError: could not probe DUT 10.42.0.5 from the rig (ssh exited 255)
"""


@pytest.mark.parametrize(
    "log,kind,why",
    [
        (ACTIVATION_TIMEOUT, "infra", "reservation_timeout"),
        # hitl_client's progress-driven give-ups (#376)
        (
            "queued: position 2\nhitl_client.ReserveError: reservation ab12 did not activate "
            "before the CI deadline (HITL_DEADLINE; waited 14400s)\n",
            "infra",
            "ci_deadline",
        ),
        (
            "hitl_client.ReserveError: reservation ab12 did not activate (queue stalled: no "
            "progress for 3600s, HITL_QUEUE_STALL_TIMEOUT=3600; waited 5000s)\n",
            "infra",
            "queue_stalled",
        ),
        (
            "FAIL: reservation ab12 did not activate (rig unhealthy: daemon unreachable for 301s)\n",
            "infra",
            "rig_unreachable",
        ),
        (
            "reservation ab12 did not activate (rig unhealthy: no unit can serve this request "
            "for 600s)\n",
            "infra",
            "no_unit_can_serve",
        ),
        (
            "reservation ab12 did not activate within the 21600s safety cap (HITL_ACTIVATE_MAX)\n",
            "infra",
            "reservation_timeout",
        ),
        # HITL_HOLD_MAX expiry: the test held its unit too long -> a test problem
        (
            "reserved: id=1 on http://hitl-rig-1:8087 unit=c6-1\n[hitl] held the unit for "
            "HITL_HOLD_MAX=3600s; terminating to free it\n",
            "test",
            "failed",
        ),
        (NO_UNIT_REPORTED_AS_FAIL, "infra", "no_matching_unit"),
        (KILLED_WHILE_QUEUED, "infra", "killed_while_queued"),
        (RIG_SSH, "infra", "rig_ssh"),
        # A DUT that never opens its socket can be the firmware: not infra (and the
        # attached serial log's text doesn't count as the test's output).
        (WSS_NEVER_UP, "test", "failed"),
        (OFF_MARGIN, "test", "test failure marker"),
        (TIMEOUT_MID_RUN, "test", "failed"),
        ("", "test", "failed"),
    ],
)
def test_classify_attempt(log, kind, why):
    assert vc.classify_attempt(log) == (kind, why)


def test_a_failure_marker_beats_an_infra_line():
    log = OFF_MARGIN + "hitl_client.ReserveError: reservation y did not activate within 60s\n"
    assert vc.classify_attempt(log)[0] == "test"


# --- BEP -> verdict --------------------------------------------------------


def _bep(*events):
    lines = []
    for label, attempts, overall in events:
        for n, (status, log) in enumerate(attempts, 1):
            lines.append(
                json.dumps(
                    {
                        "id": {"testResult": {"label": label, "run": 1, "shard": 1, "attempt": n}},
                        "testResult": {
                            "status": status,
                            "testActionOutput": [{"name": "test.log", "uri": "file://" + log}],
                        },
                    }
                )
            )
        lines.append(
            json.dumps(
                {
                    "id": {"testSummary": {"label": label}},
                    "testSummary": {"overallStatus": overall, "attemptCount": len(attempts)},
                }
            )
        )
    lines.append("not json")  # tolerated
    return vc.parse_bep(lines)


LOGS = {
    "/l/act": ACTIVATION_TIMEOUT,
    "/l/queued": KILLED_WHILE_QUEUED,
    "/l/wss": WSS_NEVER_UP,
    "/l/margin": OFF_MARGIN,
    "/l/ok": "reserved: id=1\nPASS\n",
}


def _read(path):
    return LOGS[path]


def _v(runs, quarantine=None, requested=(E2E, FX, REJOIN)):
    return {r.label: r for r in vc.verdict(requested, runs, quarantine or {}, _read)}


def test_pass_flaky_fail_and_infra():
    run = _bep(
        (E2E, [("FAILED", "/l/wss"), ("PASSED", "/l/ok")], "FLAKY"),
        (FX, [("FAILED", "/l/act"), ("FAILED", "/l/margin"), ("FAILED", "/l/act")], "FAILED"),
        (REJOIN, [("FAILED", "/l/act"), ("TIMEOUT", "/l/queued"), ("FAILED", "/l/act")], "FAILED"),
    )
    v = _v([run])
    assert v[E2E].verdict == vc.PASS and "non-infra retry" in v[E2E].why
    assert v[FX].verdict == vc.FAIL, "one real failure among infra attempts still fails"
    assert v[REJOIN].verdict == vc.INFRA
    assert vc.requeue(v.values()) == [REJOIN]
    assert [r.label for r in vc.gating_failures(v.values())] == [FX]


def test_requeue_outcome_decides():
    first = _bep((REJOIN, [("FAILED", "/l/act")] * 3, "FAILED"))
    passed = _bep((REJOIN, [("PASSED", "/l/ok")], "PASSED"))
    still = _bep((REJOIN, [("FAILED", "/l/act")] * 3, "FAILED"))
    broke = _bep((REJOIN, [("FAILED", "/l/margin")] * 3, "FAILED"))
    one = (REJOIN,)
    assert _v([first, passed], requested=one)[REJOIN].verdict == vc.PASS
    assert _v([first, still], requested=one)[REJOIN].verdict == vc.INFRA
    assert _v([first, broke], requested=one)[REJOIN].verdict == vc.FAIL
    # every attempt of both invocations is in the report
    assert len(_v([first, broke], requested=one)[REJOIN].attempts) == 6


def test_a_requested_test_with_no_result_fails():
    v = _v([_bep((E2E, [("PASSED", "/l/ok")], "PASSED"))], requested=(E2E, FX))
    assert v[FX].verdict == vc.FAIL and "no test result" in v[FX].why


def _entry(test, review_by=dt.date(2026, 11, 8)):
    return vc.Entry(test, "37% attempt failures", "#1", "@me", dt.date(2026, 10, 25), review_by)


def test_quarantined_tests_run_and_report_but_never_gate():
    run = _bep(
        (FX, [("FAILED", "/l/margin")] * 3, "FAILED"),
        (E2E, [("PASSED", "/l/ok")], "PASSED"),
    )
    v = _v([run], {FX: _entry(FX)}, requested=(E2E, FX))
    assert v[FX].verdict == vc.QUARANTINED and v[FX].quarantined_outcome == vc.FAIL
    assert vc.gating_failures(v.values()) == []
    md = vc.summary_markdown(list(v.values()), {FX: _entry(FX)}, dt.date(2026, 10, 26))
    assert "quarantined (FAIL)" in md and "past its review date" not in md
    late = vc.summary_markdown(
        list(v.values()), {FX: _entry(FX, dt.date(2026, 10, 1))}, dt.date(2026, 10, 26)
    )
    assert "past its review date" in late


# --- quarantine list -------------------------------------------------------

GOOD = """
[[quarantine]]
test = "//pi/hitl/harness:rejoin_loop"
reason = "x"
issue = "#1"
owner = "@a"
since = 2026-10-25
review_by = 2026-11-08
"""


def test_quarantine_list_loads():
    q = vc.load_quarantine(GOOD)
    assert q[REJOIN].review_by == dt.date(2026, 11, 8)


@pytest.mark.parametrize(
    "text",
    [
        GOOD.replace('owner = "@a"\n', ""),  # missing key
        GOOD.replace("since = 2026-10-25", 'since = "soon"'),  # not a date
        GOOD.replace("//pi/hitl", "pi/hitl"),  # not a label
        GOOD + GOOD,  # duplicate
        GOOD.replace("[[quarantine]]", "[[quarantined]]"),
        "nope [",
    ],
)
def test_malformed_quarantine_list_is_rejected(text):
    with pytest.raises(vc.QuarantineError):
        vc.load_quarantine(text)


def _repo_file(relpath):
    try:
        from python.runfiles import runfiles as _rf

        r = _rf.Create()
        if r:
            p = r.Rlocation("_main/" + relpath)
            if p and Path(p).is_file():
                return Path(p)
    except Exception:  # noqa: BLE001
        pass
    for base in Path(__file__).absolute().parents:
        if (base / relpath).is_file():
            return base / relpath
    pytest.skip(f"{relpath} not found")


def test_checked_in_quarantine_list_is_valid():
    vc.load_quarantine(_repo_file("pi/hitl/ci/quarantine.toml").read_text())


def test_workflow_runs_the_verdict_on_the_build_events():
    wf = _repo_file(".github/workflows/hitl.yaml").read_text()
    assert "--build_event_json_file=" in wf
    assert re.search(r"pi/hitl/ci/hitl_verdict\.py .*--requeue-out", wf, re.S)
    assert re.search(r"hitl_verdict\.py \"\$\{verdict_args\[@\]\}\" \\\s*\n\s*--json-out", wf)


# --- flake report ----------------------------------------------------------

JOB_LOG = """\
2026-10-22T01:00:00.0000000Z ==================== Test output for //pi/hitl/harness:rejoin_loop:
2026-10-22T01:00:00.0000000Z queued: position 3
2026-10-22T01:00:00.0000000Z hitl_client.ReserveError: reservation a did not activate within 2400s
2026-10-22T01:00:00.0000000Z ================================================================================
2026-10-22T01:00:00.0000000Z ==================== Test output for //pi/hitl/harness:rejoin_loop:
2026-10-22T01:00:00.0000000Z reserved: id=1 on http://hitl-rig-1:8087 unit=c6-1
2026-10-22T01:00:00.0000000Z -- Test timed out at 2026-10-22 01:00:00 UTC --
2026-10-22T01:00:00.0000000Z ================================================================================
2026-10-22T01:00:00.0000000Z ==================== Test output for //pi/hitl/harness:rejoin_loop:
2026-10-22T01:00:00.0000000Z reserved: id=2 on http://hitl-rig-1:8087 unit=c6-1
2026-10-22T01:00:00.0000000Z PASS
2026-10-22T01:00:00.0000000Z ================================================================================
2026-10-22T01:00:00.0000000Z //pi/hitl/harness:rejoin_loop    FLAKY, failed in 2 out of 3 in 900.1s
2026-10-22T01:00:00.0000000Z //pi/hitl/harness:e2e_netstack   PASSED in 91.8s
"""


def test_flake_report_splits_a_job_log_into_attempts():
    out = flake_report.split_log(JOB_LOG)
    assert out[E2E] == {"status": "PASSED", "attempts": 1, "failed": 0, "blocks": []}
    r = out[REJOIN]
    assert (r["status"], r["attempts"], r["failed"], len(r["blocks"])) == ("FLAKY", 3, 2, 2)
    s = flake_report.tally([("pull_request", t, x) for t, x in out.items()])
    assert s[REJOIN]["infra"] == 1 and s[REJOIN]["fail"] == 1 and s[REJOIN]["attempts"] == 2
    assert s[REJOIN]["flaky_runs"] == 1 and not s[REJOIN]["candidate"]
