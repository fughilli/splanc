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
    sequential_churn_verdict,
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


def test_verdict_fails_when_it_never_recovers_after_the_final_burst():
    # The wedge: the last burst never frees a slot again (persistent).
    rounds = [_round(1), _round(2, recovered=False)]
    v = verdict(baseline_ok=True, rounds=rounds, crashed=False)
    assert not v.ok
    assert any("did not recover after the final burst" in r for r in v.reasons)


def test_verdict_tolerates_a_transient_early_non_recovery_that_heals():
    # Round 1 took longer than its window to free a slot, but round 3 (the final
    # burst) recovered fine — graceful slow degradation on a heap-tight board, not
    # a wedge. Reported (recovered=2/3) but PASS, so transient timing on real
    # hardware doesn't red-line a healthy device.
    rounds = [_round(1, recovered=False), _round(2), _round(3)]
    v = verdict(baseline_ok=True, rounds=rounds, crashed=False)
    assert v.ok, v.reasons


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


def test_verdict_tolerates_momentary_blackout_that_recovers():
    # Served nothing under load but recovered afterward in every round: the server
    # shed/queued everyone during the burst and came back — that's "sheds rather
    # than wedging", the desired behavior, so PASS (blackout is reported, not
    # gated, to avoid LRU-thrash flakiness).
    rounds = [
        Round(index=1, outcomes={OK: 0}, cert_status=None, recovered=True, recover_s=5.0),
        Round(index=2, outcomes={OK: 0}, cert_status=None, recovered=True, recover_s=5.0),
    ]
    v = verdict(baseline_ok=True, rounds=rounds, crashed=False)
    assert v.ok, v.reasons


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


# -- sequential_churn_verdict (FUG-140-adjacent: slot_guard de-flake) ---------
# slot_guard (hitl_slot_repro) used to fail on ANY reconnect failure; these pin
# the corrected verdict: a wedge (no recovery) or a non-graceful ERROR fails, but
# graceful shed-and-recover does not.


def test_seq_verdict_passes_clean_and_graceful_recovered():
    # All-clean, and shed-but-recovered, both pass — a heap-tight 2-slot server is
    # allowed to reset/time-out the odd reconnect under a hammer as long as it heals.
    clean = ("held=0", [OK] * 20, True)
    shed = ("held=1", [OK] * 17 + [REJECTED, TIMEOUT, REJECTED], True)
    v = sequential_churn_verdict(True, [clean, shed], max_welcome_ms=3000, connect_timeout_ms=10000)
    assert v.ok and v.reasons == []


def test_seq_verdict_fails_on_wedge_no_recovery():
    # The field bug: the burst leaves the endpoint wedged (recovered=False).
    wedged = ("held=1", [OK] * 5 + [REJECTED] * 15, False)
    v = sequential_churn_verdict(True, [wedged], max_welcome_ms=3000, connect_timeout_ms=10000)
    assert not v.ok
    assert any("wedge" in r for r in v.reasons)


def test_seq_verdict_fails_on_nongraceful_error():
    # An ERROR outcome (e.g. served a non-welcome / unexpected) is never graceful,
    # even if the server later recovers.
    erred = ("held=0", [OK] * 19 + [ERROR], True)
    v = sequential_churn_verdict(True, [erred], max_welcome_ms=3000, connect_timeout_ms=10000)
    assert not v.ok
    assert any("non-graceful" in r for r in v.reasons)


def test_seq_verdict_fails_on_latency_breach_and_bad_baseline():
    # A served welcome slower than the client deadline is a fail (it would abort
    # mid-handshake — the storm trigger); so is a dead baseline.
    ok_churn = ("held=0", [OK] * 20, True)
    v = sequential_churn_verdict(True, [ok_churn], max_welcome_ms=10001, connect_timeout_ms=10000)
    assert not v.ok and any("latency" in r for r in v.reasons)
    v2 = sequential_churn_verdict(False, [ok_churn], max_welcome_ms=100, connect_timeout_ms=10000)
    assert not v2.ok and any("single ws connect" in r for r in v2.reasons)
