"""Paired-client management on the display: parsing ``paired_clients``, the Clients
page and a client's detail (navigation, KEY3 hold -> confirm -> revoke that one
client, revoke-all unchanged elsewhere, a client vanishing while open), the
renderers, ``splanc-bridge clients|revoke``, and the fake bridge + simulator."""

import os
import shutil
import tempfile
import time

import pytest
from splanc_display import anim, ctl, fake_bridge, main, render_hdmi, render_oled, sim, ui
from splanc_display.anim import Scene
from splanc_display.hat import KEY_PINS
from splanc_display.status import Client, fmt_age, parse

NOW = 1_760_000_000.0
KEYS = ["g1", "g2", "g3", "g4", "g5", "g6"]


# --- status ----------------------------------------------------------------------------


def test_parse_paired_clients_and_defaults():
    s = parse(fake_bridge.sample("paired", NOW))
    assert s.clients_state == "ok"
    assert [c.label for c in s.paired] == ["Claude", "Kevin's iPhone", "Home Assistant script"]
    c = s.paired[0]
    assert (c.kind, c.kind_label, c.live) == ("connector", "AI connector", True)
    assert c.last_used_at == NOW - 300 and c.created_at == NOW - 12 * 86400
    assert s.paired[2].last_used_at is None
    assert s.client(c.id) is c and s.client("nope") is None
    assert s.clients_live == 2
    # An older bridge writes neither field: an empty list, state "".
    old = fake_bridge.sample("paired", NOW)
    del old["paired_clients"], old["paired_clients_state"]
    s = parse(old)
    assert s.paired == () and s.clients_state == "" and s.clients == 2


def test_parse_is_lenient_about_bad_client_entries():
    s = parse(
        dict(
            fake_bridge.sample("paired", NOW),
            paired_clients=[
                {"id": "a", "label": "  ", "kind": 7, "created_at": "x", "live": "yes"},
                {"label": "no id"},
                "junk",
                {"id": "b", "label": "ok", "last_used_at": True},
            ],
        )
    )
    assert [c.id for c in s.paired] == ["a", "b"]
    a = s.paired[0]
    assert (a.label, a.kind, a.created_at, a.live, a.kind_label) == (
        "Unnamed client",
        "",
        None,
        False,
        "Client",
    )
    assert s.paired[1].last_used_at is None
    assert parse(dict(fake_bridge.sample("paired", NOW), paired_clients="nope")).paired == ()


def test_salient_notices_clients_coming_going_and_going_live():
    a = parse(fake_bridge.sample("paired", NOW))
    doc = fake_bridge.sample("paired", NOW)
    doc["paired_clients"][1]["live"] = False
    assert parse(doc).salient() != a.salient()
    doc = fake_bridge.sample("paired", NOW)
    doc["paired_clients"][0]["last_used_at"] -= 60  # last-used ticking: not salient
    assert parse(doc).salient() == a.salient()


def test_fmt_age():
    assert [fmt_age(x) for x in (None, 3, 45, 300, 7200, 3 * 86400)] == [
        "never",
        "now",
        "45s",
        "5m",
        "2h",
        "3d",
    ]


# --- the menu --------------------------------------------------------------------------


class Dispatcher:
    """Records (cmd, args); finishes them when the test says so."""

    def __init__(self):
        self.calls = []
        self.pending = []

    def __call__(self, cmd, done, **args):
        self.calls.append((cmd, args))
        self.pending.append(done)

    def finish(self, ok=True, msg=""):
        self.pending.pop(0)(ok, msg)


@pytest.fixture
def d():
    return Dispatcher()


@pytest.fixture
def u(d, clock):
    m = ui.OledUI(d, clock)
    m.set_fixtures(["fx1", "fx2"])
    m.set_clients(KEYS, rows_of=lambda k: 7)
    return m


def settle(u, clock, s=1.0):
    clock.advance(s)
    u.tick()
    return u.view()


def to_clients(u, clock):
    u.press("left")  # home -> (wraps to) the last page: Clients
    assert u.view().page == "clients"
    settle(u, clock)


def test_clients_is_the_last_page_and_existing_order_is_kept():
    assert ui.PAGES == ("home", "qr", "players", "network", "clients")


def test_client_list_selects_and_scrolls_on_its_own(u, clock):
    to_clients(u, clock)
    for _ in range(5):
        u.press("down")
    v = settle(u, clock)
    assert (v.client_sel, v.client_pos, v.client_top) == (5, 5, 5 - ui.LIST_ROWS + 1)
    assert (v.sel, v.list_pos) == (0, 0)  # the fixture list didn't move
    u.press("right")  # left/right still page: wraps to home
    assert u.view().page == "home"


def test_empty_client_list_pages_like_the_others(d, clock):
    m = ui.OledUI(d, clock)
    m.press("left")
    assert m.view().page == "clients"
    m.press("down")  # nothing to select: next page (wraps to home)
    assert m.view().page == "home"


def test_open_a_client_scroll_and_back(u, clock):
    to_clients(u, clock)
    u.press("down")
    u.press("press")
    v = u.view()
    assert v.page == "client" and v.key == "g2"
    assert v.slide.src == Scene("clients") and v.slide.dst == Scene("client", "g2")
    for _ in range(10):
        u.press("down")
    assert settle(u, clock).client_scroll == 7 - ui.DETAIL_ROWS
    u.press("left")
    v = u.view()
    assert v.page == "clients" and v.client_sel == 1 and v.slide.direction == "right"


def test_key3_hold_in_a_client_revokes_that_client(u, d, clock):
    to_clients(u, clock)
    u.press("down")
    u.press("down")
    u.press("press")
    settle(u, clock)
    u.press("key3")
    v = u.view()
    assert v.overlay == "hold" and v.revoke == "g3"
    clock.advance(ui.HOLD_SECONDS)
    u.tick()
    v = u.view()
    assert v.overlay == "confirm" and v.revoke == "g3"
    u.release("key3")
    u.press("key3")
    assert d.calls == [("revoke", {"grant": "g3"})]
    assert u.view().overlay_text == "Working…"
    d.finish(True)
    v = u.view()
    assert v.overlay_text == "Client revoked"
    assert v.page == "clients"  # back to the list by itself
    # The status then drops it: no "Client is gone" on top.
    u.set_clients([k for k in KEYS if k != "g3"])
    assert u.view().overlay_text == "Client revoked"
    assert u.view().client_sel == 2  # the neighbour that moved up


def test_key3_elsewhere_is_still_revoke_all(u, d, clock):
    to_clients(u, clock)  # on the list, not in a detail
    u.press("key3")
    assert u.view().revoke == ""
    clock.advance(ui.HOLD_SECONDS)
    u.tick()
    u.press("key3")
    assert d.calls == [("revoke_all", {})]


def test_client_confirm_cancels_and_short_hold_explains(u, d, clock):
    to_clients(u, clock)
    u.press("press")
    u.press("key3")
    clock.advance(1)
    u.release("key3")
    assert "Hold KEY3" in u.view().overlay_text and u.view().revoke == ""
    u.press("key3")
    clock.advance(ui.HOLD_SECONDS)
    u.tick()
    u.press("left")  # any other key: cancelled, nothing sent
    assert u.view().overlay_text == "Cancelled" and d.calls == []
    assert u.view().page == "client"  # the cancelling press does nothing else
    u.press("key3")
    clock.advance(ui.HOLD_SECONDS)
    u.tick()
    clock.advance(ui.CONFIRM_SECONDS)
    u.tick()
    assert u.view().overlay_text == "Cancelled" and d.calls == []


def test_failed_revoke_stays_and_says_why(u, d, clock):
    to_clients(u, clock)
    u.press("press")
    u.press("key3")
    clock.advance(ui.HOLD_SECONDS)
    u.tick()
    u.press("key3")
    d.finish(False, "the client list needs a relay update")
    v = u.view()
    assert v.page == "client" and v.overlay_text.startswith("the client list needs")


def test_client_revoked_elsewhere_while_open(u, d, clock):
    to_clients(u, clock)
    u.press("press")
    u.press("key3")  # mid-hold when it disappears
    u.set_clients(KEYS[1:])
    v = u.view()
    assert v.page == "clients" and v.overlay_text == "Client is gone"
    clock.advance(ui.HOLD_SECONDS + 1)
    u.tick()
    assert u.view().overlay != "confirm"  # the hold for it was dropped
    u.press("key3")  # a fresh hold on the list is revoke-all again
    assert u.view().revoke == ""


def test_key1_from_a_client_goes_home(u, d, clock):
    to_clients(u, clock)
    u.press("press")
    u.press("key1")
    assert u.view().page == "home"
    settle(u, clock, anim.PAGE_SECONDS + 0.1)
    u.press("left")
    assert u.view().page == "clients"  # the detail was closed, not left behind


def test_fixture_detail_unaffected(u, clock):
    while u.view().page != "players":
        u.press("right")
    u.press("press")
    assert u.view().page == "detail" and u.view().key == "fx1"
    u.press("key3")
    assert u.view().revoke == ""  # KEY3 in a fixture is revoke-all, as before


# --- renderers -------------------------------------------------------------------------


def _status(**over):
    return parse(fake_bridge.sample("paired", NOW, **over))


def test_client_rows():
    s = _status()
    rows = render_oled.client_rows(s.paired[0], NOW)
    assert rows[0] == ("Kind", "AI connector")
    assert ("Used", "5 min ago") in rows and ("Added", "12 d ago") in rows
    assert ("Live", "yes") in rows and rows[-1] == (None, "Hold KEY3: revoke")
    assert ("Used", "never") in render_oled.client_rows(s.paired[2], NOW)
    long = Client(id="x", label="A connector with a really long client name, longer than any")
    rows = render_oled.client_rows(long, NOW)
    assert rows[0][0] == "Name" and rows[1][0] == ""  # wrapped onto two rows
    assert render_oled.client_rows(None, NOW) == [("", "Client is gone")]


@pytest.mark.parametrize(
    "name,over,view",
    [
        ("list", {}, ui.View(page="clients", client_sel=1, client_pos=1)),
        ("detail", {}, ui.View(page="client", key="Qm3xT9vKa2LpRw8e")),
        ("none", {"paired_clients": []}, ui.View(page="clients")),
        (
            "outdated",
            {"paired_clients": [], "paired_clients_state": "relay_outdated"},
            ui.View(page="clients"),
        ),
        (
            "confirm",
            {},
            ui.View(
                page="client",
                key="Qm3xT9vKa2LpRw8e",
                overlay="confirm",
                overlay_seconds=7,
                revoke="Qm3xT9vKa2LpRw8e",
            ),
        ),
    ],
)
def test_oled_client_screens_draw(name, over, view, outdir):
    img = render_oled.render(_status(**over), view, now=NOW)
    assert img.size == (128, 64) and img.getbbox() is not None
    if outdir:
        img.save(os.path.join(outdir, f"oled-clients-{name}.png"))


def test_oled_screens_differ_by_state():
    def bits(**over):
        return render_oled.render(_status(**over), ui.View(page="clients"), now=NOW).tobytes()

    assert (
        len(
            {
                bits(),
                bits(paired_clients=[]),
                bits(paired_clients=[], paired_clients_state="relay_outdated"),
            }
        )
        == 3
    )


@pytest.mark.parametrize(
    "over",
    [
        {},
        {"paired_clients": fake_bridge.many_clients(NOW, 9)},
        {"paired_clients": [], "paired_clients_state": "relay_outdated"},
        {"paired_clients": []},
    ],
)
def test_hdmi_client_panel(over, outdir):
    img = render_hdmi.render(_status(**over), now=NOW, oled=True)
    assert img.size == (1920, 1080)
    if outdir:
        n = len(over.get("paired_clients", [1, 2, 3]))
        img.save(
            os.path.join(outdir, f"hdmi-clients-{n}-{over.get('paired_clients_state', 'ok')}.png")
        )


# --- control: ctl + fake bridge + app --------------------------------------------------


@pytest.fixture
def bridge():
    d = tempfile.mkdtemp(prefix="sbc-", dir="/tmp")
    fb = fake_bridge.FakeBridge(
        os.path.join(d, "status.json"), os.path.join(d, "control.sock")
    ).start()
    yield fb
    fb.stop()
    shutil.rmtree(d, ignore_errors=True)


def test_ctl_clients_and_revoke(bridge, monkeypatch, capsys):
    monkeypatch.setenv("SPLANC_BRIDGE_STATUS", bridge.status_path)
    monkeypatch.setenv("SPLANC_BRIDGE_CONTROL", bridge.control_path)
    bridge.set(fake_bridge.sample("paired", time.time()))
    assert ctl.main(["clients"]) == 0
    out = capsys.readouterr().out
    assert "Claude" in out and "AI connector" in out and "Qm3xT9vKa2LpRw8e" in out
    assert "never" in out and "(live)" in out
    assert ctl.main(["status"]) == 0
    assert "2 connected, 3 paired" in capsys.readouterr().out
    assert ctl.main(["revoke", "Qm3xT9vKa2LpRw8e"]) == 2  # no tty, no --yes
    assert ctl.main(["revoke", "Qm3xT9vKa2LpRw8e", "--yes"]) == 0
    assert "Revoked Qm3xT9vKa2LpRw8e" in capsys.readouterr().out
    assert [c["label"] for c in bridge.doc["paired_clients"]] == [
        "Kevin's iPhone",
        "Home Assistant script",
    ]
    assert ctl.main(["revoke", "nope", "--yes"]) == 1
    assert "no paired client" in capsys.readouterr().err
    bridge.set(
        fake_bridge.sample(
            "paired", time.time(), paired_clients=[], paired_clients_state="relay_outdated"
        )
    )
    assert ctl.main(["clients"]) == 0
    assert "needs a relay update" in capsys.readouterr().out


def test_app_revokes_one_client_end_to_end(bridge, tmp_path, buttons, clock):
    bridge.set(fake_bridge.sample("paired", time.time()))
    app = main.App(
        hdmi="off",
        oled="png:" + str(tmp_path / "o.png"),
        clock=clock,
        status_path=bridge.status_path,
        control_path=bridge.control_path,
        button_factory=buttons,
        boot_frames=None,
    )
    app.step()
    btn = buttons.by_pin
    btn[KEY_PINS["left"]].press()  # home -> Clients
    app.step()
    btn[KEY_PINS["down"]].press()  # Kevin's iPhone
    btn[KEY_PINS["press"]].press()
    app.step()
    assert app.ui.view().page == "client" and app.ui.view().key == "Hn7cY2bWq5ZsJd1u"
    btn[KEY_PINS["key3"]].press()
    app.step()
    clock.advance(ui.HOLD_SECONDS + 0.1)
    app.step()
    assert app.ui.view().overlay == "confirm"
    btn[KEY_PINS["key3"]].release()
    btn[KEY_PINS["key3"]].press()
    end = time.time() + 5
    while time.time() < end and app.ui.view().overlay_text != "Client revoked":
        app.step()
        time.sleep(0.02)
    assert app.ui.view().overlay_text == "Client revoked"
    assert bridge.commands == ["revoke"]
    end = time.time() + 5
    while time.time() < end and len(app.watcher.status.paired) != 2:
        app.step()
        time.sleep(0.02)
    assert [c.label for c in app.watcher.status.paired] == ["Claude", "Home Assistant script"]


# --- simulator -------------------------------------------------------------------------


@pytest.fixture
def model():
    d = tempfile.mkdtemp(prefix="simc-", dir="/tmp")
    b = sim.FakeModel(os.path.join(d, "status.json"), os.path.join(d, "control.sock"))
    b.phase, b.delay = "running", 0.0
    b.start()
    yield b
    b.stop()
    shutil.rmtree(d, ignore_errors=True)


def test_sim_model_client_knobs_and_revoke(model):
    import json

    model.act("client_list", "sample")
    doc = model.build()
    assert doc["state"] == "paired" and len(doc["paired_clients"]) == 3
    assert doc["paired_clients_state"] == "ok"
    model.act("client_add")
    new = model.paired_list[-1]["id"]
    assert model.build()["paired_clients"][-1]["live"] is True
    model.act("client_live", new)
    assert model.build()["paired_clients"][-1]["live"] is False
    r = model.handle(json.dumps({"cmd": "revoke", "grant": new}).encode())
    assert r["ok"] and r["label"]
    assert len(model.build()["paired_clients"]) == 3
    assert not model.handle(json.dumps({"cmd": "revoke", "grant": "zz"}).encode())["ok"]
    model.act("client_remove", model.paired_list[0]["id"])
    assert len(model.snapshot()["paired_clients"]) == 2
    model.act("relay", False)
    assert model.build()["paired_clients_state"] == "offline"
    model.act("relay", True)
    model.act("client_list", "outdated")
    doc = model.build()
    assert doc["paired_clients_state"] == "relay_outdated" and doc["paired_clients"] == []
    assert not model.handle(json.dumps({"cmd": "revoke", "grant": "x"}).encode())["ok"]
    model.act("client_list", "outdated")
    model.act("client_list", "many")
    assert len(model.build()["paired_clients"]) == 12
    assert model.handle(b'{"cmd": "revoke_all"}')["ok"]
    assert model.build()["paired_clients"] == [] and model.build()["state"] == "unpaired"
