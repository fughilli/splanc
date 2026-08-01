"""Unit tests for the runner-pool picker (no network — RigStatus is built directly)."""

import hitl_pool
from hitl_pool import RigStatus, choose, normalize_base, parse_servers


def _status(active=None, queue=0, rig="rig"):
    return {"rig": rig, "active": active, "queue_length": queue, "lease_seconds": 1800}


def test_normalize_base_adds_scheme_and_port():
    assert normalize_base("hitl-rig") == "http://hitl-rig:8087"
    assert normalize_base("hitl-rig:9000") == "http://hitl-rig:9000"
    assert normalize_base("https://rig") == "https://rig:8087"
    assert normalize_base("http://rig:8087/") == "http://rig:8087"
    assert normalize_base("  ") == ""


def test_parse_servers_splits_and_dedupes():
    assert parse_servers("a, b  c") == [
        "http://a:8087", "http://b:8087", "http://c:8087",
    ]
    # Dedupe keeps first-seen order.
    assert parse_servers("a, a, http://a:8087") == ["http://a:8087"]
    assert parse_servers("") == []
    assert parse_servers(None) == []


def test_choose_prefers_idle_over_busy():
    idle = RigStatus("http://idle", _status(active=None, queue=0), None)
    busy = RigStatus("http://busy", _status(active={"id": "x"}, queue=0), None)
    assert choose([busy, idle]) is idle


def test_choose_prefers_shortest_queue():
    a = RigStatus("http://a", _status(queue=3), None)
    b = RigStatus("http://b", _status(queue=1), None)
    c = RigStatus("http://c", _status(queue=5), None)
    assert choose([a, b, c]) is b


def test_choose_skips_unreachable():
    dead = RigStatus("http://dead", None, "timeout")
    live = RigStatus("http://live", _status(queue=9), None)
    assert choose([dead, live]) is live


def test_choose_none_when_all_unreachable():
    assert choose([RigStatus("http://x", None, "err")]) is None


def test_choose_is_stable_on_ties():
    first = RigStatus("http://first", _status(queue=0), None)
    second = RigStatus("http://second", _status(queue=0), None)
    assert choose([first, second]) is first


def test_busy_rig_counts_as_one_load():
    busy = RigStatus("http://busy", _status(active={"id": "x"}, queue=0), None)
    idle_q1 = RigStatus("http://q1", _status(queue=1), None)
    # A held rig with an empty queue and a rig with one waiter are equally loaded;
    # tie breaks to the earlier entry.
    assert busy.load == idle_q1.load == 1
    assert choose([busy, idle_q1]) is busy


def test_servers_from_env_prefers_pool(monkeypatch):
    monkeypatch.setenv("HITL_SERVERS", "r1, r2")
    monkeypatch.setenv("HITL_SERVER", "http://solo:8087")
    assert hitl_pool.servers_from_env() == ["http://r1:8087", "http://r2:8087"]
    monkeypatch.delenv("HITL_SERVERS")
    assert hitl_pool.servers_from_env() == ["http://solo:8087"]
