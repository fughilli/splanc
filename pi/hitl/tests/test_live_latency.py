"""Pure-logic tests for the live-control latency gate (live_latency_core).

No rig: the app's live sender port (latest-wins, one-in-flight, ack/legacy
pacing), the counter-echo lag arithmetic, the verdict, and a discrete-event model
of a slow device fed a 4 x 100 Hz knob stream — naive per-event sends fall behind
without bound, the live sender's lag stays flat. The on-hardware driver is
//pi/hitl/harness:live_latency_netstack.
"""

from __future__ import annotations

import heapq

import live_latency_core as core


def test_live_sender_one_in_flight_latest_wins():
    s = core.LiveSender(acks=True, min_interval_s=0.0)
    out = s.push(0.0, 0, [1.0])
    assert len(out) == 1 and out[0]["seq"] == 1 and out[0]["commit"] is False
    for v in range(2, 50):
        assert s.push(0.001 * v, 0, [float(v)]) == []
    assert s.push(0.06, 2, [0.5]) == []
    # The wrong seq (or a legacy reply) doesn't release a seq'd batch.
    assert s.on_reply(0.07, {"type": "control_ack", "seq": 9}) == []
    assert s.on_reply(0.07, {"type": "playback_state"}) == []
    out = s.on_reply(0.08, {"type": "control_ack", "seq": 1})
    assert out == [
        {
            "type": "set_uniforms",
            "values": [{"slot": 0, "value": [49.0]}, {"slot": 2, "value": [0.5]}],
            "commit": False,
            "seq": 2,
        }
    ]
    assert s.stats["coalesced"] == 47


def test_live_sender_legacy_pacing_and_timeout():
    s = core.LiveSender(acks=False, commit_ok=False, min_interval_s=0.025, ack_timeout_s=0.4)
    assert "seq" not in s.push(0.0, 1, [0.1])[0]
    assert s.push(0.01, 1, [0.2]) == []
    assert s.on_reply(0.02, {"type": "playback_state"}) == []  # interval not up yet
    assert s.poll(0.03)[0]["values"] == [{"slot": 1, "value": [0.2]}]
    s.push(0.04, 1, [0.3])
    assert s.poll(0.3) == []
    out = s.poll(0.44)  # the ack deadline passed: move on
    assert out and s.stats["timeouts"] == 1


def test_lag_tracker_echo():
    t = core.LagTracker()
    for k in range(1, 11):
        t.generated(k, k * 0.01)
    # Device answered (midpoint 0.105 s) having applied 5; value 6 was made at 0.06 s.
    s = t.echo(0.1, 0.11, 5)
    assert abs(s.lag_ms - 45.0) < 1e-6 and abs(s.rtt_ms - 10.0) < 1e-6
    # Up to date: the next value didn't exist yet.
    assert t.echo(0.2, 0.21, 10).lag_ms == 0.0


def test_verdict():
    good = [40.0] * 50
    assert core.verdict(False, good, good, good, 30)[0] == core.SKIP
    assert core.verdict(True, good[:5], good[:5], good, 30)[0] == core.SKIP
    assert core.verdict(True, good, good, good + good, 30) == (core.PASS, [])
    grown = [400.0] * 50
    st, why = core.verdict(True, good, grown, good + grown, 30)
    assert st == core.FAIL and any("grows" in r for r in why)
    st, why = core.verdict(True, good, [], good, 30)
    assert st == core.FAIL and "starved" in why[0]
    # A backlog starves the probe itself: a few samples, over budget, or a
    # probe that timed out, is a FAIL, not a SKIP.
    st, why = core.verdict(True, [8000.0], [15000.0], [8000.0, 15000.0], 150, probe_timeouts=2)
    assert st == core.FAIL and "timed out" in why[0], why
    assert core.verdict(True, [9000.0], [], [9000.0], 150)[0] == core.FAIL
    assert core.verdict(True, [40.0], [], [40.0], 150)[0] == core.SKIP


def _model(sender: str, service_s: float, rtt_s: float, seconds: float):
    """A device taking `service_s` per frame, in order, `rtt_s/2` each way;
    4 knobs x 100 Hz; slot 0 counts. Returns (t, lag_ms) samples every 100 ms."""
    ev: list = []  # (time, seq, kind, payload)
    n = 0

    def at(t, kind, payload=None):
        nonlocal n
        n += 1
        heapq.heappush(ev, (t, n, kind, payload))

    live = core.LiveSender(acks=True, min_interval_s=0.025)
    tracker = core.LagTracker()
    busy = 0.0
    applied = 0
    sched = core.midi_schedule(4, 100.0)
    k = 0
    while sched(k)[0] < seconds:
        at(sched(k)[0], "gen", k)
        k += 1
    for i in range(int(seconds * 10)):
        at(i * 0.1, "probe")
    counter = 0
    samples = []

    def wire(t, frame):
        nonlocal busy
        arrive = t + rtt_s / 2
        start = max(busy, arrive)
        busy = start + service_s
        at(busy, "apply", frame)

    while ev:
        t, _, kind, p = heapq.heappop(ev)
        if kind == "gen":
            slot = sched(p)[1]
            if slot == 0:
                counter += 1
                tracker.generated(counter, t)
                v = [float(counter)]
            else:
                v = [0.5]
            if sender == "naive":
                wire(t, {"type": "set_uniforms", "values": [{"slot": slot, "value": v}]})
            else:
                for f in live.push(t, slot, v):
                    wire(t, f)
        elif kind == "apply":
            for u in p["values"]:
                if u["slot"] == 0:
                    applied = int(u["value"][0])
            if "seq" in p:
                at(t + rtt_s / 2, "ack", p["seq"])
        elif kind == "ack":
            for f in live.on_reply(t, {"type": "control_ack", "seq": p}):
                wire(t, f)
        elif kind == "probe":
            for f in live.poll(t):
                wire(t, f)
            s = tracker.echo(t, t, applied)
            samples.append((t, s.lag_ms))
    return samples


def test_model_naive_grows_live_stays_flat():
    # A heavy effect leaves the device ~8 ms per frame: 125 frames/s < 400 events/s.
    naive = _model("naive", 0.008, 0.02, 60)
    live = _model("live", 0.008, 0.02, 60)

    def win(xs, t0, t1):
        return [lag for t, lag in xs if t0 <= t < t1]

    n_first, n_last = win(naive, 5, 25), win(naive, 40, 60)
    l_first, l_last = win(live, 5, 25), win(live, 40, 60)
    assert core.verdict(True, n_first, n_last, n_first + n_last, 20)[0] == core.FAIL
    st, why = core.verdict(True, l_first, l_last, l_first + l_last, 20)
    assert st == core.PASS, why
    assert core.pct(l_last, 99) < 100
    assert core.pct(n_last, 50) > 10_000
