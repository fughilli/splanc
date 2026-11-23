"""Cross-rig routing: capacity-aware host pick + work stealing (no hardware).

Regression for 2026-11-23: rig-2 had 5 C6s under a concurrency cap of 4, so one
unit always looked free; every reservation picked rig-2 whenever rig-1 was full,
and stayed queued there (103 deep) while 3 of rig-1's C6s idled. The pick must
count only units the daemon would ADMIT (host + per-class caps), weigh the queue
already waiting there, spread a burst in proportion to free room, and a queued
waiter must move when another rig can start it at once."""

import collections

import hitl_client
import pytest
from hitl_client import Reservation, host_slot

CAPS = ["flash", "improv", "wss-app"]


def _unit(name, active=False, type_="esp32c6", pin_only=False):
    return {
        "name": name,
        "type": type_,
        "capabilities": CAPS,
        "pin_only": pin_only,
        "active": {"id": "x", "unit_type": type_} if active else None,
    }


def _status(n_units, n_active, host_cap=0, class_cap=None, queued=0, extra=None):
    st = {
        "units": [_unit(f"c6-{i}", active=i < n_active) for i in range(n_units)] + (extra or []),
        "queue_length": queued,
        "queue_by_class": {"pr-ci": queued},
        "max_concurrent": host_cap,
        "max_concurrent_per_class": class_cap or {},
    }
    return st


def _queue(queued, cls="pr-ci", type_="esp32c6"):
    return {
        "classes": [
            {"class": c, "queued": queued if c == cls else 0}
            for c in ("merge-queue", "pr-ci", "dev")
        ],
        "types": [{"type": type_, "queued": queued}],
    }


def _matches(u):
    return u.get("type") == "esp32c6"


# --- host_slot: the pure rating -------------------------------------------------


def test_free_unit_behind_the_class_cap_is_not_admittable():
    # rig-2 on 2026-11-23: 5 C6s, 4 active, cap 4 -> nothing can start there.
    s = host_slot("r2", _status(5, 4, host_cap=4, class_cap={"esp32c6": 4}), None, _matches)
    assert s.admit == 0
    assert s.capacity == 4


def test_host_cap_bounds_admission_across_classes():
    pi = [_unit("pi-1", active=True, type_="led-mapper-pi", pin_only=True)]
    st = _status(4, 2, host_cap=3, class_cap={"esp32c6": 4}, extra=pi)
    assert host_slot("r1", st, None, _matches).admit == 0  # 2 C6 + 1 Pi = host cap 3


def test_uncapped_host_counts_every_free_unit():
    s = host_slot("r1", _status(4, 1), None, _matches)
    assert (s.admit, s.capacity) == (3, 4)


def test_queue_ahead_eats_the_room():
    s = host_slot("r1", _status(4, 1, queued=5), _queue(5), _matches)
    assert s.room == 3 - 5


def test_a_higher_class_does_not_count_lower_class_waiters_as_ahead():
    q = _queue(40, cls="pr-ci")
    s = host_slot("r2", _status(5, 5, queued=40), q, _matches, priority="merge-queue")
    assert s.ahead == 0
    assert host_slot("r2", _status(5, 5, queued=40), q, _matches, priority="pr-ci").ahead == 40


def test_without_queue_summary_falls_back_to_queue_length():
    assert host_slot("r1", _status(4, 4, queued=7), None, _matches).ahead == 7


# --- _pick_server ---------------------------------------------------------------


def _fake_pool(monkeypatch, statuses, queues=None):
    queues = queues or {}
    monkeypatch.setenv("HITL_HOSTS", " ".join(h for h in statuses))

    def fake_get(url, timeout=10.0):
        for h, st in statuses.items():
            base = f"http://{h}:8087"
            if url == base + "/status":
                return st
            if url == base + "/queue":
                if h not in queues:
                    raise OSError("no /queue")
                return queues[h]
        raise OSError(f"unreachable {url}")

    monkeypatch.setattr(hitl_client, "_get", fake_get)


def test_capped_phantom_free_unit_no_longer_attracts_reservations(monkeypatch):
    # rig-1 full with 2 queued; rig-2 at its cap with ONE idle-but-capped C6 and 100
    # queued. Old code: rig-2 "has a free unit" -> always rig-2. Now: rig-1 (shorter wait).
    _fake_pool(
        monkeypatch,
        {
            "hitl-rig-1": _status(4, 4, host_cap=6, class_cap={"esp32c6": 4}, queued=2),
            "hitl-rig-2": _status(5, 4, host_cap=4, class_cap={"esp32c6": 4}, queued=100),
        },
        {"hitl-rig-1": _queue(2), "hitl-rig-2": _queue(100)},
    )
    picks = collections.Counter(Reservation(sku="esp32c6")._pick_server() for _ in range(50))
    assert picks == {"http://hitl-rig-1:8087": 50}


def test_burst_spreads_in_proportion_to_free_room(monkeypatch):
    _fake_pool(
        monkeypatch,
        {"hitl-rig-1": _status(4, 0), "hitl-rig-2": _status(5, 1)},  # room 4 vs 4
    )
    hitl_client.random.seed(1)
    picks = collections.Counter(Reservation(sku="esp32c6")._pick_server() for _ in range(400))
    assert 140 < picks["http://hitl-rig-1:8087"] < 260  # ~50/50, never all on one rig


def test_full_fleet_queues_where_the_wait_per_unit_is_shortest(monkeypatch):
    _fake_pool(
        monkeypatch,
        {
            "hitl-rig-1": _status(4, 4, queued=8),  # 9/4 per unit
            "hitl-rig-2": _status(5, 5, queued=8),  # 9/5 per unit -> shorter
        },
        {"hitl-rig-1": _queue(8), "hitl-rig-2": _queue(8)},
    )
    assert Reservation(sku="esp32c6")._pick_server() == "http://hitl-rig-2:8087"


# --- work stealing while queued -------------------------------------------------


class _Daemons:
    """Two fake daemons: rig-2 keeps us queued; rig-1 can (or can't) start us."""

    def __init__(self, rig1_starts=True):
        self.rig1_starts = rig1_starts
        self.posts = []
        self.statuses = {
            "hitl-rig-1": _status(4, 2, host_cap=6, class_cap={"esp32c6": 4}),
            "hitl-rig-2": _status(5, 4, host_cap=4, class_cap={"esp32c6": 4}, queued=100),
        }

    def get(self, url, timeout=10.0):
        for h, st in self.statuses.items():
            if url == f"http://{h}:8087/status":
                return st
            if url == f"http://{h}:8087/queue":
                return _queue(st["queue_length"])
        if url == "http://hitl-rig-2:8087/reservation/old":
            return {"state": "queued", "position": 50, "priority": "pr-ci"}
        if url == "http://hitl-rig-1:8087/reservation/new":
            if self.rig1_starts:
                return {
                    "state": "active",
                    "unit": "c6-2",
                    "endpoint": {"port": 2224, "user": "agent"},
                }
            return {"state": "queued", "position": 0, "priority": "pr-ci"}
        raise AssertionError(url)

    def post(self, url, body=None, timeout=15.0):
        self.posts.append(url)
        if url == "http://hitl-rig-1:8087/reserve":
            return {"id": "new", "state": "active" if self.rig1_starts else "queued"}
        return {}


@pytest.fixture
def clock(monkeypatch):
    t = [1000.0]
    monkeypatch.setattr(hitl_client.time, "time", lambda: t[0])
    monkeypatch.setattr(hitl_client.time, "sleep", lambda s: t.__setitem__(0, t[0] + s))
    monkeypatch.setattr(hitl_client, "_wait_port", lambda *a, **k: True)
    return t


def _queued_on_rig2(monkeypatch, d):
    monkeypatch.setenv("HITL_HOSTS", "hitl-rig-1 hitl-rig-2")
    monkeypatch.setattr(hitl_client, "_get", d.get)
    monkeypatch.setattr(hitl_client, "_post", d.post)
    r = Reservation(sku="esp32c6")
    r.server, r.id = "http://hitl-rig-2:8087", "old"
    r._reserve_body = {"owner": "t", "unit_type": "esp32c6"}
    return r


def test_queued_waiter_moves_to_a_rig_that_can_start_it(monkeypatch, clock):
    d = _Daemons(rig1_starts=True)
    r = _queued_on_rig2(monkeypatch, d)
    r._await_active(timeout=600)
    assert (r.server, r.id, r._unit) == ("http://hitl-rig-1:8087", "new", "c6-2")
    assert "http://hitl-rig-2:8087/reservation/old/release" in d.posts  # gave up the old slot
    assert clock[0] - 1000.0 < 60  # within ~one rebalance interval


def test_lost_race_keeps_the_original_place(monkeypatch, clock):
    d = _Daemons(rig1_starts=False)
    r = _queued_on_rig2(monkeypatch, d)
    with pytest.raises(hitl_client.ReserveError):
        r._await_active(timeout=100)
    assert "http://hitl-rig-1:8087/reservation/new/release" in d.posts  # dropped the probe
    # ...and only released the original slot at the very end (the hard-cap give-up).
    assert d.posts.index("http://hitl-rig-1:8087/reservation/new/release") < d.posts.index(
        "http://hitl-rig-2:8087/reservation/old/release"
    )


def test_pinned_server_never_rebalances(monkeypatch, clock):
    d = _Daemons(rig1_starts=True)
    monkeypatch.setenv("HITL_SERVER", "http://hitl-rig-2:8087")
    r = _queued_on_rig2(monkeypatch, d)
    with pytest.raises(hitl_client.ReserveError):
        r._await_active(timeout=100)
    assert "http://hitl-rig-1:8087/reserve" not in d.posts


def test_rebalance_can_be_disabled(monkeypatch, clock):
    monkeypatch.setenv("HITL_REBALANCE_EVERY", "0")
    d = _Daemons(rig1_starts=True)
    r = _queued_on_rig2(monkeypatch, d)
    with pytest.raises(hitl_client.ReserveError):
        r._await_active(timeout=100)
    assert "http://hitl-rig-1:8087/reserve" not in d.posts
