"""PR-36 — readiness-aware HITL/CI orchestration with contention control.

The reservation client replaces timing assumptions with readiness signals and
spreads load under contention, so a flaky/contended bench doesn't erode trust:

  * ``Reservation._await_active`` advances only on the daemon's reported STATE —
    it holds while queued and returns the moment the reservation is ``active``,
    wiring the endpoint from the response; a reservation ``released`` before
    activating raises at once (never a silent timing guess); and if it never
    activates it RELEASES the slot before giving up (a stuck queue frees the rig
    instead of the heartbeat pinning it).
  * ``Reservation._pick_server`` is contention-aware: among the pool it prefers a
    host with a FREE matching unit, else one with a matching BUSY unit (to queue
    on) over a blind fallback, and errors only when nothing is reachable — so a
    burst of CI reservations fans out instead of piling onto one rig.

Pure logic: the daemon HTTP + the readiness socket probe are stubbed, no network,
no real sleeps. See hitl_client.py and DESIGN.md "Flow". Commits 7dc83fd8 /
1613f70c / 3e4a68dc built the surrounding parallel-CI orchestration.
"""

import hitl_client
import pytest
from hitl_client import Reservation, ReserveError, _host_of

pytestmark = pytest.mark.requirements("PR-36")

CAPS = ["flash", "improv", "wss-app"]


def _unit(active=None, caps=CAPS, pin_only=False, type_="esp32c6"):
    return {"active": active, "type": type_, "capabilities": list(caps), "pin_only": pin_only}


# --- _await_active: state-driven, not time-driven ----------------------------


def _mk_res(server="http://hitl-rig-1:8087", rid="res-1"):
    r = Reservation(server=server)
    r.id = rid
    return r


def test_await_active_returns_only_once_the_daemon_reports_active(monkeypatch):
    polls = [
        {"state": "queued", "position": 2},
        {"state": "queued", "position": 0},
        {
            "state": "active",
            "endpoint": {"host": "ignored.local", "port": 2222, "user": "agent"},
            "unit": "c6-abcdef",
        },
    ]
    seen = []

    def fake_get(url, timeout=10.0):
        assert url == "http://hitl-rig-1:8087/reservation/res-1"
        seen.append(url)
        return polls.pop(0)

    sleeps = []
    monkeypatch.setattr(hitl_client, "_get", fake_get)
    monkeypatch.setattr(hitl_client, "_wait_port", lambda *a, **k: True)
    monkeypatch.setattr(hitl_client.time, "sleep", lambda s: sleeps.append(s))

    r = _mk_res()
    r._await_active(timeout=100.0)

    # It consumed BOTH queued polls before activating (readiness, not a timer)...
    assert len(seen) == 3 and polls == []
    assert sleeps == [2, 2]  # one inter-poll wait per queued observation, none after active
    # ...and wired the endpoint from the ACTIVE response (so these are proof it
    # didn't return early on a queued poll, where they'd be None).
    assert r.port == 2222 and r.user == "agent" and r._unit == "c6-abcdef"
    # The ssh host is the pool address we reached the daemon at, not the endpoint's
    # (possibly-unresolvable) advertised host.
    assert r.host == _host_of("http://hitl-rig-1:8087") == "hitl-rig-1"
    assert r.endpoint == "agent@hitl-rig-1:2222"


def test_await_active_raises_when_released_before_activating(monkeypatch):
    polls = [
        {"state": "queued", "position": 1},
        {"state": "released", "message": "preempted"},
    ]
    monkeypatch.setattr(hitl_client, "_get", lambda url, timeout=10.0: polls.pop(0))
    monkeypatch.setattr(hitl_client, "_wait_port", lambda *a, **k: True)
    monkeypatch.setattr(hitl_client.time, "sleep", lambda s: None)

    r = _mk_res()
    with pytest.raises(ReserveError) as e:
        r._await_active(timeout=100.0)
    assert "released before activating" in str(e.value)
    assert r.port is None  # never wired an endpoint


def test_await_active_releases_the_slot_if_it_never_activates(monkeypatch):
    # A reservation that never activates must be RELEASED (not left held by the
    # heartbeat) so a stuck queue frees the rig for the next waiter.
    monkeypatch.setattr(hitl_client, "_get", lambda url, timeout=10.0: {"state": "queued"})
    posts = []
    monkeypatch.setattr(hitl_client, "_post", lambda url, *a, **k: posts.append(url) or {})

    r = _mk_res()
    with pytest.raises(ReserveError) as e:
        r._await_active(timeout=0.0)  # deadline already passed -> straight to release+raise
    assert "did not activate" in str(e.value)
    assert any(u.endswith("/reservation/res-1/release") for u in posts)


# --- _pick_server: contention-aware spread -----------------------------------


def _pool_get(mapping):
    """A fake _get that serves a per-host /status from {base_url: status_dict};
    an unknown host raises (unreachable)."""

    def fake(url, timeout=10.0):
        base = url[: -len("/status")] if url.endswith("/status") else url
        if base not in mapping:
            raise OSError("unreachable")
        return mapping[base]

    return fake


def _set_pool(monkeypatch, hosts):
    monkeypatch.setenv("HITL_HOSTS", hosts)
    monkeypatch.delenv("HITL_SERVERS", raising=False)
    monkeypatch.delenv("HITL_SERVER", raising=False)


def test_pick_prefers_a_host_with_a_free_matching_unit(monkeypatch):
    _set_pool(monkeypatch, "h1 h2 h3")
    monkeypatch.setattr(
        hitl_client,
        "_get",
        _pool_get(
            {
                "http://h1:8087": {
                    "units": [_unit(active="busy")]
                },  # matching but BUSY -> queueable
                "http://h2:8087": {"units": [_unit()]},  # FREE matching -> wins
                "http://h3:8087": {"units": [_unit(caps=["led-strip"])]},  # reachable, non-matching
            }
        ),
    )
    r = Reservation(require_caps=CAPS)
    assert r._pick_server() == "http://h2:8087"


def test_pick_queues_on_a_matching_busy_host_over_a_blind_fallback(monkeypatch):
    _set_pool(monkeypatch, "h1 h2")
    monkeypatch.setattr(
        hitl_client,
        "_get",
        _pool_get(
            {
                "http://h1:8087": {"units": [_unit(caps=["led-strip"])]},  # reachable, non-matching
                "http://h2:8087": {
                    "units": [_unit(active="busy")]
                },  # matching but busy -> queue here
            }
        ),
    )
    r = Reservation(require_caps=CAPS)
    assert r._pick_server() == "http://h2:8087"


def test_pick_errors_when_no_host_is_reachable(monkeypatch):
    _set_pool(monkeypatch, "h1 h2")
    monkeypatch.setattr(hitl_client, "_get", _pool_get({}))  # every /status raises
    r = Reservation(require_caps=CAPS)
    with pytest.raises(ReserveError) as e:
        r._pick_server()
    assert "no reachable host" in str(e.value)
