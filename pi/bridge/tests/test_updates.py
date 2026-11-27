"""Software updates on the screens (updates.py): updates are only ever shown as
available, and installed after a yes on the bridge itself — the Updates page,
its detail + "Install?" confirm, the header's update arrow, the request files the
root side acts on, and the whole flow through the simulator's fake updaters."""

import json
import os
import shutil
import tempfile
import time

import pytest
from splanc_display import fake_bridge, render_hdmi, render_oled, sim, ui, updates
from splanc_display.status import parse
from splanc_display.ui import View

NOW = 1_760_000_000.0

SYSTEM_OFFER = {
    "state": "available",
    "current_version": "1.3.0",
    "available": {"version": "1.4.0", "bytes": 48_200_000, "paths": 37},
    "checked_at": NOW - 120,
}
AGENT_IDLE = {"state": "idle", "current_version": "1.9.2", "available": None, "checked_at": NOW}


def ups(system=SYSTEM_OFFER, agent=AGENT_IDLE, supported=True):
    return updates.Updates(
        system=updates.parse_track("system", system),
        agent=updates.parse_track("agent", agent),
        supported=supported,
    )


def with_updates(u, state="paired", **over):
    from dataclasses import replace

    return replace(parse(fake_bridge.sample(state, NOW, **over)), updates=u)


# --- parsing + requests ------------------------------------------------------------------


def test_tracks_parse_leniently():
    t = updates.parse_track("system", SYSTEM_OFFER)
    assert (t.state, t.current, t.available, t.size) == ("available", "1.3.0", "1.4.0", 48_200_000)
    assert t.offer and not t.busy and not t.waiting
    for junk in (None, [], "x", {"state": 7, "available": "1.4.0", "checked_at": "now"}):
        t = updates.parse_track("agent", junk)
        assert not t.available and t.checked_at is None
    assert not updates.parse_track("agent", None).known
    dl = updates.parse_track(
        "system",
        dict(SYSTEM_OFFER, state="downloading", bytes_total=200, bytes_done=50),
    )
    assert dl.busy and not dl.offer and dl.progress == 0.25
    waiting = updates.parse_track(
        "system",
        dict(SYSTEM_OFFER, state="staged", staged={"version": "1.4.0", "confirmed": True}),
    )
    assert waiting.waiting and not waiting.offer and waiting.label == "Ready to restart"
    rev = updates.parse_track("system", {"state": "idle", "current_rev": "0123456789abcdef"})
    assert rev.current == "rev 0123456"


def test_request_files(tmp_path):
    d = tmp_path / "req"
    with pytest.raises(updates.RequestError, match="not managed"):
        updates.request("check", str(d))
    d.mkdir()
    updates.request("install-system", str(d))
    updates.request("check", str(d))
    assert sorted(os.listdir(d)) == ["check", "install-system"]
    with pytest.raises(updates.RequestError, match="unknown"):
        updates.request("rm -rf", str(d))


def test_watcher_merges_updates_into_the_status(tmp_path):
    sysf, agf, req = tmp_path / "s.json", tmp_path / "a.json", tmp_path / "req"
    req.mkdir()
    bridge = tmp_path / "status.json"
    bridge.write_text(json.dumps(fake_bridge.sample("paired", NOW)))
    from splanc_display.status import StatusWatcher

    w = StatusWatcher(str(bridge), updates=updates.UpdatesWatcher(str(sysf), str(agf), str(req)))
    w.poll()
    assert w.status.updates.supported and not w.status.updates.tracks
    sysf.write_text(json.dumps(SYSTEM_OFFER))
    assert w.poll() and w.salient_changed  # a new offer wakes the screen
    assert w.status.updates.system.available == "1.4.0" and w.status.state == "paired"
    assert not w.poll()


def test_fmt_size():
    assert updates.fmt_size(48_200_000) == "48 MB"
    assert updates.fmt_size(3_200_000) == "3.2 MB"
    assert updates.fmt_size(612_000) == "612 KB"
    assert updates.fmt_size(None) == "-"


# --- the menu state machine -----------------------------------------------------------------


class Dispatcher:
    def __init__(self):
        self.calls = []

    def __call__(self, cmd, done, **args):
        self.calls.append((cmd, args))
        done(True, "")


@pytest.fixture
def d():
    return Dispatcher()


@pytest.fixture
def u(d, clock):
    m = ui.OledUI(d, clock, pages=ui.UPDATES_PAGES)
    m.set_updates(["system", "agent", "check"], rows_of=lambda k: 6)
    m.offers = {"system": "install", "agent": None}
    m.update_action = lambda target: m.offers.get(target)
    return m


def to_updates(u, clock):
    while u.view().page != "updates":
        u.press("right")
    clock.advance(1)
    u.tick()


def test_check_now_asks_both_updaters(u, d, clock):
    to_updates(u, clock)
    for _ in range(2):
        u.press("down")
    assert u.view().update_sel == 2
    u.press("press")
    assert d.calls == [("update_check", {})]
    assert u.view().page == "updates"  # stays on the list
    assert u.view().overlay_text == ui.DONE_TEXT["update_check"]


def test_row_added_above_keeps_a_short_list_at_its_top(d, clock):
    # The bridge's display: System's status file shows up after the page is on
    # screen (only Agent + Check now before), with "Check now" selected. The
    # selection stays on "Check now", and the list, which fits, still starts at
    # System instead of scrolling it off the top.
    m = ui.OledUI(d, clock, pages=ui.UPDATES_PAGES)
    m.set_updates(["agent", "check"], rows_of=lambda k: 6)
    to_updates(m, clock)
    m.press("down")
    assert m.view().update_sel == 1
    m.set_updates(["system", "agent", "check"], rows_of=lambda k: 6)
    clock.advance(1)
    m.tick()
    v = m.view()
    assert v.update_sel == 2
    assert v.update_top == 0


def test_list_offset_stays_within_the_list():
    top_for = ui.OledUI._top_for
    n = ui.LIST_ROWS
    assert top_for(2, 1, 3) == 0  # fits on screen: always from the first row
    assert top_for(5, 3, 10) == 3  # long list: the selection stays where it was
    assert top_for(9, 0, 10) == 10 - n  # scrolls just enough to show the last row
    assert top_for(1, 5, 10) == 1  # and back up to a selection above the top
    assert top_for(0, 0, 0) == 0


def test_install_needs_a_yes(u, d, clock):
    to_updates(u, clock)
    u.press("press")  # open System
    assert u.view().page == "update" and u.view().key == "system"
    u.press("press")  # Install? ...
    v = u.view()
    assert (v.overlay, v.confirm, v.target) == ("confirm", "install", "system")
    assert d.calls == []  # ... nothing yet
    u.press("left")  # any other key: later
    assert d.calls == [] and u.view().overlay_text == "Later"
    assert u.view().page == "update"
    u.press("press")
    u.press("press")  # yes
    assert d.calls == [("update_install", {"target": "system"})]
    u.press("press")
    u.press("key3")  # KEY3 also says yes
    assert d.calls[-1] == ("update_install", {"target": "system"})


def test_install_confirm_times_out_to_later(u, d, clock):
    to_updates(u, clock)
    u.press("press")
    u.press("press")
    clock.advance(ui.CONFIRM_SECONDS + 0.1)
    u.tick()
    assert u.view().overlay_text == "Later" and d.calls == []
    # A later KEY3 hold is the revoke flow again, not an install.
    u.press("key3")
    clock.advance(ui.HOLD_SECONDS + 0.1)
    u.tick()
    v = u.view()
    assert (v.overlay, v.confirm) == ("confirm", "revoke")


def test_nothing_on_offer_press_goes_back(u, d, clock):
    to_updates(u, clock)
    u.press("down")
    u.press("press")  # Agent: up to date
    assert u.view().key == "agent"
    u.press("press")
    assert u.view().page == "updates" and d.calls == []


def test_restart_now_for_a_waiting_system_update(u, d, clock):
    u.offers["system"] = "restart"
    to_updates(u, clock)
    u.press("press")
    u.press("press")
    assert u.view().confirm == "restart"
    u.press("press")
    assert d.calls == [("update_restart", {"target": "system"})]


def test_updates_page_only_on_the_image(d, clock):
    assert "updates" not in ui.OledUI(d, clock).pages
    assert ui.OledUI(d, clock, pages=ui.UPDATES_PAGES).pages[-1] == "updates"


# --- rendering ------------------------------------------------------------------------------


def save(img, outdir, name):
    if outdir:
        img.convert("L").resize((512, 256)).save(os.path.join(outdir, name))


def lit(img):
    return img.histogram()[255]


def test_home_header_shows_the_update_arrow(outdir):
    plain = render_oled.render(with_updates(ups(system=AGENT_IDLE)), View(page="home"), now=NOW)
    flag = render_oled.render(with_updates(ups()), View(page="home"), now=NOW)
    header = (60, 0, 128, 13)
    assert flag.crop(header).tobytes() != plain.crop(header).tobytes()
    assert flag.crop((0, 14, 128, 64)).tobytes() == plain.crop((0, 14, 128, 64)).tobytes()
    assert (
        plain.tobytes()
        == render_oled.render(with_updates(None), View(page="home"), now=NOW).tobytes()
    )  # no updates watched: exactly as before
    save(flag, outdir, "oled-update-flag-home.png")


@pytest.mark.parametrize(
    "name,system",
    [
        ("offer", SYSTEM_OFFER),
        ("downloading", dict(SYSTEM_OFFER, state="downloading", bytes_total=10, bytes_done=4)),
        ("failed", dict(SYSTEM_OFFER, state="failed", message="install failed: not signed")),
        ("idle", dict(AGENT_IDLE, current_version="1.3.0")),
    ],
)
def test_updates_page_and_detail(name, system, outdir):
    s = with_updates(ups(system=system))
    page = render_oled.render(s, View(page="updates", key=""), now=NOW)
    assert 40 < lit(page) < 128 * 64 * 0.75
    detail = render_oled.render(s, View(page="update", key="system"), now=NOW)
    assert 40 < lit(detail) < 128 * 64 * 0.75
    save(page, outdir, f"oled-updates-{name}.png")
    save(detail, outdir, f"oled-update-system-{name}.png")


def test_detail_rows_say_what_pressing_does():
    t = ups().system
    rows = render_oled.update_rows(t, NOW)
    assert ("Now", "1.3.0") in rows and ("New", "1.4.0") in rows and ("Size", "48 MB") in rows
    # The action is on the first screen (rows 0-3), "later" further down.
    assert rows[2] == (None, "Press: install") and rows[-1] == (None, "Left: later")
    busy = render_oled.update_rows(t, NOW, clients=2)
    assert (None, "Restart waits for apps") in busy
    waiting = updates.parse_track(
        "system", dict(SYSTEM_OFFER, state="staged", staged={"version": "1.4.0", "confirmed": True})
    )
    assert render_oled.update_rows(waiting, NOW)[2] == (None, "Press: restart now")
    dl = updates.parse_track(
        "system", dict(SYSTEM_OFFER, state="downloading", bytes_total=10, bytes_done=4)
    )
    assert render_oled.update_rows(dl, NOW)[2] == ("State", "Downloading 40%")
    agent = updates.parse_track(
        "agent",
        {
            "state": "available",
            "current_version": "1.9.2",
            "available": {"version": "1.10.0", "notes": "Faster fixture discovery"},
        },
    )
    notes = [v for k, v in render_oled.update_rows(agent, NOW) if k == "Notes"]
    assert notes and notes[0].startswith("Faster")


@pytest.mark.parametrize("kind", ["install", "restart"])
def test_install_confirm_overlay(kind, outdir):
    s = with_updates(ups())
    v = View(
        page="update",
        key="system",
        overlay="confirm",
        confirm=kind,
        target="system",
        overlay_seconds=7.0,
    )
    img = render_oled.render(s, v, now=NOW)
    assert lit(img.crop((0, 0, 128, 13))) > 600  # the lit title bar
    revoke = render_oled.render(s, View(page="update", key="system", overlay="confirm"), now=NOW)
    assert img.tobytes() != revoke.tobytes()
    save(img, outdir, f"oled-update-confirm-{kind}.png")


def test_hdmi_tells_where_to_confirm(outdir):
    s = with_updates(ups())
    a = render_hdmi.render(s, (1920, 1080), now=NOW, oled=True)
    b = render_hdmi.render(with_updates(ups(system=AGENT_IDLE)), (1920, 1080), now=NOW, oled=True)
    assert a.crop((0, 1020, 1920, 1075)).tobytes() != b.crop((0, 1020, 1920, 1075)).tobytes()
    render_hdmi.render(s, (1280, 720), now=NOW, oled=False)
    if outdir:
        a.save(os.path.join(outdir, "hdmi-update-available.png"))


# --- end to end: the simulator's fake updaters -------------------------------------------


def wait(pred, timeout=8.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def simulator():
    d = tempfile.mkdtemp(prefix="su-", dir="/tmp")
    b = sim.FakeModel(os.path.join(d, "status.json"), os.path.join(d, "control.sock"))
    b.phase, b.delay = "running", 0.0
    b.updates.step = 0.05
    b.start()
    s = sim.Sim(b, hdmi_size=(640, 360), boot_frames=None).start()
    yield s, b
    s.stop()
    b.stop()
    shutil.rmtree(d, ignore_errors=True)


def page(s):
    return s.app.ui.view().page


def goto_updates(s):
    assert wait(lambda: page(s) not in ("boot",))
    for _ in range(len(ui.UPDATES_PAGES)):
        if page(s) == "updates":
            break
        s.tap("left")
        time.sleep(0.05)
    assert wait(lambda: page(s) == "updates")


def test_sim_check_then_confirmed_install(simulator):
    s, b = simulator
    goto_updates(s)
    status = lambda: s.app.watcher.status.updates  # noqa: E731
    assert status().system.state == "idle" and status().offers == 0
    b.updates.offer("system", found=False)  # on the channel, not yet seen
    s.tap("down")
    s.tap("down")
    s.tap("press")  # Check now
    assert wait(lambda: "check" in b.updates.requests)
    assert wait(lambda: status().system.available == "1.4.0")
    assert b.updates.docs["system"]["current_version"] == "1.3.0"  # found, not installed
    s.tap("up")
    s.tap("up")
    s.tap("press")  # System's detail
    assert wait(lambda: page(s) == "update" and s.app.ui.view().key == "system")
    s.tap("press")  # Install?
    assert wait(lambda: s.app.ui.view().confirm == "install")
    assert "install-system" not in b.updates.requests
    s.tap("press")  # yes
    assert wait(lambda: "install-system" in b.updates.requests)
    assert wait(lambda: b.updates.docs["system"]["current_version"] == "1.4.0")
    assert wait(lambda: status().system.state == "idle" and not status().system.available)


def test_sim_install_waits_for_apps_then_restart_now(simulator):
    s, b = simulator
    b.act("paired", True)
    b.act("clients", 2)
    b.updates.offer("system")
    goto_updates(s)
    s.tap("press")
    assert wait(lambda: page(s) == "update")
    s.tap("press")
    s.tap("press")
    st = lambda: s.app.watcher.status.updates.system  # noqa: E731
    assert wait(lambda: st().waiting)
    assert b.updates.docs["system"]["current_version"] == "1.3.0"
    s.tap("press")  # Restart now?
    assert wait(lambda: s.app.ui.view().confirm == "restart")
    s.tap("key3")
    assert wait(lambda: "restart-system" in b.updates.requests)
    assert wait(lambda: b.updates.docs["system"]["current_version"] == "1.4.0")
