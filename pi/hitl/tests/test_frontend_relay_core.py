"""frontend_relay_core: the relay's heap lines off its serial, the idle-heap gate, and
the replies a front end with no P4 attached must give."""

from frontend_relay_core import FLOOR, check_replies, heap_samples, verdict

LOG = """\
[t=1200] [relay] heap=91234 max=60000 min=88000 rekeys=0 tls=0/14336 slots=0/2 fb=0 fwd=0 unavail=0 local=0
[t=6200] [net] t=6200 lease=none
[t=11200] [relay] heap=70100 max=50100 min=52000 rekeys=0 tls=9000/14336 slots=1/2 fb=0 fwd=2 unavail=2 local=2
[t=12000] [player-netstack] map=0 leds heap=68000 max=40000 min=51000 rekeys=0 tls=0/0
"""


def test_heap_samples_reads_both_status_lines():
    assert heap_samples(LOG) == [
        (91234, 60000, 88000),
        (70100, 50100, 52000),
        (68000, 40000, 51000),
    ]
    assert heap_samples("no status here") == []


def test_verdict_gates_the_idle_window_on_the_floor():
    ok, msg = verdict([(90000, 1, 1), (30000, 1, 1), (40000, 1, 1), (50000, 1, 1)])
    assert ok and "idle free 30000 B" in msg
    ok, _ = verdict([(90000, 1, 1), (FLOOR - 1, 1, 1), (40000, 1, 1), (50000, 1, 1)])
    assert not ok
    # Boot-time samples before the window don't count.
    ok, _ = verdict([(1000, 1, 1), (30000, 1, 1), (40000, 1, 1), (50000, 1, 1)])
    assert ok
    ok, msg = verdict([(30000, 1, 1)])
    assert not ok and "only 1 heap line" in msg


def test_check_replies():
    unavailable = {"type": "error", "code": "player_unavailable", "message": "…"}
    good = {
        "get_tls_info": {"type": "tls_info", "state": "ready", "certSha256": "ab"},
        "get_wifi_policy": {"type": "wifi_policy_state"},
        "hello": unavailable,
        "set_device_name": unavailable,
    }
    assert check_replies(good) == []
    bad = dict(
        good, hello={"type": "welcome"}, get_tls_info={"type": "tls_info", "state": "generating"}
    )
    errs = check_replies(bad)
    assert (
        len(errs) == 2 and any("hello" in e for e in errs) and any("generating" in e for e in errs)
    )
    assert len(check_replies({})) == 4
