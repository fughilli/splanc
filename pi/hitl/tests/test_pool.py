"""Pure-logic tests for the reservation pool's host-exclusion knob ($HITL_EXCLUDE_HOSTS).

A test lane can fence specific rigs OUT of its pool by hostname — used to keep the
netstack lane off a rig whose AP the heapless netstack can't join yet (rig-3's Pi 3
onboard AP drops the DUT's protected unicast), while the vendor-stack lane still uses
it. Matched by hostname so it works whether the pool came from $HITL_HOSTS or tailnet
discovery. No hardware: drive `_pool()` with $HITL_HOSTS + $HITL_EXCLUDE_HOSTS."""

import hitl_client
from hitl_client import _host_of, _pool


def _hosts(monkeypatch, hosts, exclude=None):
    monkeypatch.setenv("HITL_HOSTS", hosts)
    monkeypatch.delenv("HITL_SERVERS", raising=False)
    if exclude is None:
        monkeypatch.delenv("HITL_EXCLUDE_HOSTS", raising=False)
    else:
        monkeypatch.setenv("HITL_EXCLUDE_HOSTS", exclude)
    return [_host_of(u) for u in _pool()]


def test_no_exclusion_keeps_all(monkeypatch):
    assert _hosts(monkeypatch, "hitl-rig-1 hitl-rig-2 hitl-rig-3") == [
        "hitl-rig-1",
        "hitl-rig-2",
        "hitl-rig-3",
    ]


def test_excludes_named_host(monkeypatch):
    assert _hosts(monkeypatch, "hitl-rig-1 hitl-rig-2 hitl-rig-3", "hitl-rig-3") == [
        "hitl-rig-1",
        "hitl-rig-2",
    ]


def test_exclusion_accepts_comma_and_space_lists(monkeypatch):
    assert _hosts(monkeypatch, "hitl-rig-1 hitl-rig-2 hitl-rig-3", "hitl-rig-2, hitl-rig-3") == [
        "hitl-rig-1",
    ]


def test_empty_exclusion_is_a_no_op(monkeypatch):
    assert len(_hosts(monkeypatch, "hitl-rig-1 hitl-rig-2 hitl-rig-3", "")) == 3


def test_exclusion_matches_hostname_from_full_urls(monkeypatch):
    # the pool is normalized to base URLs; exclusion is by hostname, so it still bites.
    got = _hosts(
        monkeypatch,
        "http://hitl-rig-1:8087 http://hitl-rig-3:8087",
        "hitl-rig-3",
    )
    assert got == ["hitl-rig-1"]


def test_unknown_excluded_host_is_harmless(monkeypatch):
    assert _hosts(monkeypatch, "hitl-rig-1 hitl-rig-2", "hitl-rig-9") == [
        "hitl-rig-1",
        "hitl-rig-2",
    ]
    # sanity: the module exposes the knob wiring we rely on.
    assert hasattr(hitl_client, "_pool")
