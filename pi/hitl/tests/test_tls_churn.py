"""Unit tests for the concurrent-TLS-slot churn test's pure logic (FUG-136).

The on-hardware driver (hitl_tls_churn.py) is manual+hitl, but its outcome
taxonomy and PASS/FAIL verdict must not drift — a graceful TLS abort under slot
pressure must stay REJECTED (not ERROR), and the verdict must FAIL a never-
recovering round (the wedge this test exists to catch) while tolerating shed
load. Those are pinned here so `bazel test //...` guards them.
"""

import ssl

from tls_churn_core import (
    ERROR,
    FAIL,
    OK,
    PASS,
    REJECTED,
    SKIP,
    TIMEOUT,
    Round,
    classify,
    result_line,
    run_status,
    tally,
    verdict,
)


def test_classify_success_is_ok():
    assert classify(None) == OK


def test_classify_timeout():
    assert classify(TimeoutError("handshake stalled")) == TIMEOUT


def test_classify_connection_and_tls_aborts_are_graceful_backpressure():
    # Slot shedding surfaces as refused/reset/TLS-abort — all REJECTED, not ERROR.
    assert classify(ConnectionRefusedError()) == REJECTED
    assert classify(ConnectionResetError()) == REJECTED
    assert classify(BrokenPipeError()) == REJECTED
    assert classify(EOFError()) == REJECTED
    assert classify(ssl.SSLError("EOF occurred in violation of protocol")) == REJECTED
    # A bare transport OSError (tunnel/socket drop) is still the peer dropping us.
    assert classify(OSError("Socket closed")) == REJECTED


def test_classify_unexpected_is_error():
    assert classify(ValueError("bug in our client")) == ERROR


def test_tally_counts_every_category():
    counts = tally([OK, OK, REJECTED, TIMEOUT])
    assert counts == {OK: 2, REJECTED: 1, TIMEOUT: 1, ERROR: 0}


def _round(index, served=1, cert=200, recovered=True, recover_s=1.0, rejected=3):
    outcomes = {OK: served, REJECTED: rejected, TIMEOUT: 0, ERROR: 0}
    return Round(
        index=index,
        outcomes=outcomes,
        cert_status=cert,
        recovered=recovered,
        recover_s=recover_s if recovered else None,
    )


def test_round_derived_properties():
    r = _round(1, served=2, cert=200)
    assert r.served == 2
    assert r.cert_ok is True
    assert r.alive_under_load is True
    dark = _round(1, served=0, cert=None)
    assert dark.alive_under_load is False


def test_verdict_pass_when_baseline_recovery_and_liveness_hold():
    rounds = [_round(1), _round(2), _round(3)]
    v = verdict(baseline_ok=True, rounds=rounds, crashed=False)
    assert v.ok, v.reasons
    assert v.reasons == []


def test_verdict_fails_on_a_non_recovering_round():
    # The wedge: contention burst that never frees a slot again.
    rounds = [_round(1), _round(2, recovered=False)]
    v = verdict(baseline_ok=True, rounds=rounds, crashed=False)
    assert not v.ok
    assert any("did not recover" in r for r in v.reasons)


def test_verdict_fails_without_a_working_baseline():
    v = verdict(baseline_ok=False, rounds=[], crashed=False)
    assert not v.ok
    assert any("baseline" in r for r in v.reasons)


def test_verdict_fails_on_crash_marker():
    v = verdict(baseline_ok=True, rounds=[_round(1)], crashed=True)
    assert not v.ok
    assert any("crash" in r for r in v.reasons)


def test_verdict_tolerates_shed_load_while_serving_something():
    # Only 1 of 4 handshakes served + cert page refused, rest rejected/timed out —
    # that's graceful degradation, and it recovered, so PASS.
    r = Round(
        index=1,
        outcomes={OK: 1, REJECTED: 2, TIMEOUT: 1, ERROR: 0},
        cert_status=None,
        recovered=True,
        recover_s=2.0,
    )
    v = verdict(baseline_ok=True, rounds=[r], crashed=False)
    assert v.ok, v.reasons


def test_verdict_fails_on_total_blackout_every_round():
    # Served nothing and cert never loaded in any round => blackout (a wedge even
    # if a later probe squeaked through).
    rounds = [
        Round(index=1, outcomes={OK: 0}, cert_status=None, recovered=True, recover_s=5.0),
        Round(index=2, outcomes={OK: 0}, cert_status=None, recovered=True, recover_s=5.0),
    ]
    v = verdict(baseline_ok=True, rounds=rounds, crashed=False)
    assert not v.ok
    assert any("blackout" in r for r in v.reasons)


def test_run_status_skip_when_no_baseline():
    # No baseline handshake => inconclusive (the bench couldn't reach the device),
    # NOT a wedge — must be SKIP (exit 0), never FAIL, even with no rounds/crash.
    assert run_status(baseline_ok=False, rounds=[], crashed=False) == SKIP
    assert run_status(baseline_ok=False, rounds=[], crashed=True) == SKIP


def test_run_status_pass_and_fail_once_baseline_established():
    assert run_status(baseline_ok=True, rounds=[_round(1)], crashed=False) == PASS
    assert run_status(baseline_ok=True, rounds=[_round(1, recovered=False)], crashed=False) == FAIL
    assert run_status(baseline_ok=True, rounds=[_round(1)], crashed=True) == FAIL


def test_result_line_reflects_status():
    rounds = [_round(1), _round(2, recovered=False)]
    line = result_line(baseline_ok=True, rounds=rounds, crashed=False, status=FAIL)
    assert line.startswith("RESULT ")
    assert "rounds=2" in line
    assert "recovered=1/2" in line
    assert "verdict=FAIL" in line
    # A no-baseline run reads verdict=SKIP with baseline=down, not a false PASS/FAIL.
    skip_line = result_line(baseline_ok=False, rounds=[], crashed=False, status=SKIP)
    assert "verdict=SKIP" in skip_line
    assert "baseline=down" in skip_line
