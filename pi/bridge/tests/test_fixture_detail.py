"""Fixture details: lenient parsing of the new status fields and the detail
screen's text (long names, missing fields, IPv4 / link-local / IPv6, unreachable)."""

import pytest
from splanc_display import render_oled
from splanc_display.status import Status, fmt_ago, fmt_bytes, host_kind, parse

NOW = 1_760_000_000.0


def player(**kw):
    doc = {
        "state": "paired",
        "players": [dict({"name": "Test strip", "host": "192.0.2.10", "ok": True}, **kw)],
    }
    return parse(doc).players[0]


def rows(p):
    return dict(r for r in render_oled.detail_rows(p, NOW) if r[0])


def test_parse_details_and_defaults():
    p = player(
        id="02:00:5E:00:00:01",
        fw="1.8.2",
        room="Test room",
        seen=NOW - 12,
        session="live",
        leds=300,
        leds_src="map",
        effect="test-effect",
        perf={
            "fps": 41.5,
            "budget_used": 0.634,
            "overruns": 3,
            "lagging": True,
            "heap_free": 55500,
            "at": NOW - 4,
        },
    )
    assert p.key == "02:00:5E:00:00:01" and p.condition == "connected"
    assert (p.leds, p.leds_src, p.perf.fps, p.perf.overruns, p.perf.lagging) == (
        300,
        "map",
        41.5,
        3,
        True,
    )
    old = player()  # an older bridge: no details at all
    assert old.key == "192.0.2.10" and old.perf is None and old.seen is None
    assert old.condition == "connected"  # ok, session unknown


def test_parse_is_lenient_about_bad_detail_fields():
    p = player(
        id=5,
        seen="soon",
        leds=-3,
        perf={"fps": "fast", "overruns": True, "lagging": "no"},
        error="",
    )
    assert p.id == "" and p.seen is None and p.leds is None and p.error is None
    assert p.perf.fps is None and p.perf.overruns is None and p.perf.lagging is None
    assert player(perf=[1, 2]).perf is None


@pytest.mark.parametrize(
    "kw, cond",
    [
        ({"session": "live"}, "connected"),
        ({"session": "reconnecting"}, "reconnecting"),
        ({"session": "none"}, "idle"),
        ({"session": "none", "error": "not answering"}, "unreachable"),
        ({"session": "none", "ok": False}, "unreachable"),
        ({"ok": False}, "unreachable"),
    ],
)
def test_condition(kw, cond):
    assert player(**kw).condition == cond


def test_healthy_detail_rows():
    p = player(
        id="02:00:5E:00:00:01",
        fw="1.8.2",
        room="Test room",
        seen=NOW - 12,
        session="live",
        leds=300,
        leds_src="configured",
        effect="test-effect",
        perf={
            "fps": 42,
            "budget_used": 0.634,
            "overruns": 0,
            "lagging": False,
            "heap_free": 55500,
            "at": NOW - 4,
        },
    )
    r = rows(p)
    assert r["State"] == "Connected" and r["Seen"] == "12 s ago" and r["IP"] == "192.0.2.10"
    assert r["ID"] == "02:00:5E:00:00:01" and r["FW"] == "1.8.2" and r["Room"] == "Test room"
    assert r["LEDs"] == "300" and r["Effect"] == "test-effect"
    assert r["FPS"] == "42" and r["Budget"] == "63% used" and r["Overrun"] == "0"
    assert r["Heap"] == "54.2 KB free" and r["Perf"] == "4 s ago"
    assert "Error" not in r


def test_map_derived_leds_and_lagging():
    r = rows(player(leds=120, leds_src="map", perf={"fps": 18.5, "lagging": True, "at": NOW}))
    assert r["LEDs"] == "120 (map)" and r["FPS"] == "18.5  lagging"


def test_missing_fields_show_dashes():
    r = rows(player())
    assert r["Seen"] == "never" and r["ID"] == "-" and r["FW"] == "-" and r["Room"] == "-"
    assert r["LEDs"] == "-" and r["Effect"] == "-" and r["Perf"] == "no data yet"


def test_unreachable_shows_the_error_wrapped():
    err = (
        "no reply to two heartbeat pings after 31 s of silence: "
        "it rebooted, moved to another IP, or dropped off Wi-Fi"
    )
    p = player(ok=True, session="none", error=err, seen=NOW - 340)
    rs = render_oled.detail_rows(p, NOW)
    assert rs[0] == ("State", "Unreachable")
    assert (
        rs[1][0] == "Error"
        and rs[2][0] == ""
        and 2 <= sum(1 for r in rs if r[0] in ("Error", "")) <= 3
    )
    assert rs[3][1].endswith("…")  # long errors are cut at three lines
    assert rows(p)["Seen"] == "5 min ago"


def test_gone_fixture():
    assert render_oled.detail_rows(None, NOW) == [("", "Fixture is gone")]


@pytest.mark.parametrize(
    "host, want",
    [
        ("192.0.2.7", ("IP", "192.0.2.7")),
        ("169.254.12.3", ("IP", "169.254.12.3 (LL)")),
        ("fe80::1%wlan0", ("IPv6", "fe80::1")),
        ("[2001:db8::5]", ("IPv6", "2001:db8::5")),
        ("splanc-test.local", ("Host", "splanc-test.local")),
        ("", ("IP", "-")),
    ],
)
def test_host_kind(host, want):
    assert host_kind(host) == want


@pytest.mark.parametrize(
    "s, want",
    [
        (None, "never"),
        (-3, "just now"),
        (1, "just now"),
        (12, "12 s ago"),
        (60, "1 min ago"),
        (3599, "59 min ago"),
        (7200, "2 h ago"),
        (3 * 86400, "3 d ago"),
    ],
)
def test_fmt_ago(s, want):
    assert fmt_ago(s) == want


def test_fmt_bytes():
    assert (fmt_bytes(None), fmt_bytes(812), fmt_bytes(55500), fmt_bytes(3 << 20)) == (
        "-",
        "812 B",
        "54.2 KB",
        "3.0 MB",
    )


def test_salient_ignores_ticking_fields():
    a = Status(state="paired", players=(player(seen=NOW - 2, perf={"fps": 40, "at": NOW}),))
    b = Status(state="paired", players=(player(seen=NOW - 9, perf={"fps": 38, "at": NOW + 5}),))
    assert a != b and a.salient() == b.salient()
    c = Status(state="paired", players=(player(session="none", error="gone"),))
    assert c.salient() != a.salient()
