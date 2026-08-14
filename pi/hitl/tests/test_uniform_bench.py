"""Pure-logic tests for the uniform-update drop-rate/bandwidth bench
(pi/hitl/harness/uniform_bench.py): the summary counters and pass/fail verdict,
with no hardware. Pins that a clean run (barrier OK, replies == sent) passes with
0% drop, and that a missing reply or a missing barrier fails."""

from uniform_bench_core import summarize, verdict


def _clean(sent=1000, replies=1000):
    return summarize(
        label="blast",
        sent=sent,
        replies=replies,
        bytes_sent=sent * 24,
        send_seconds=0.5,
        total_seconds=0.8,
        barrier_ok=True,
    )


def test_clean_run_is_zero_drop_and_passes():
    r = _clean()
    assert r["dropped"] == 0
    assert r["dropRatePct"] == 0.0
    assert r["barrierOk"] is True
    assert r["meanMsgBytes"] == 24.0
    assert r["sendBytesPerSec"] == round(1000 * 24 / 0.5, 1)
    ok, why = verdict(r)
    assert ok, why


def test_missing_replies_are_reported_as_drops_and_fail():
    r = _clean(sent=1000, replies=997)
    assert r["dropped"] == 3
    assert r["dropRatePct"] == 0.3
    ok, why = verdict(r)
    assert not ok
    assert "3/1000" in why


def test_missing_barrier_fails_even_with_all_replies():
    r = summarize("b", 500, 500, 500 * 24, 0.4, 0.6, barrier_ok=False)
    ok, why = verdict(r)
    assert not ok
    assert "barrier" in why.lower()


def test_zero_sent_does_not_divide_by_zero():
    r = summarize("empty", 0, 0, 0, 0.0, 0.0, barrier_ok=True)
    assert r["dropRatePct"] == 0.0
    assert r["sendMsgsPerSec"] is None
