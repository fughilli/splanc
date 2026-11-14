"""Updates on the screens: the updaters' status files (lenient parsing,
staleness), the request files, the OLED flow (Updates page -> detail -> KEY3 ->
INSTALL UPDATE? -> KEY3), and the service end to end against the fake updater:
nothing is ever requested without that confirmation."""

import json
import os
import time

import pytest
from splanc_display import fake_bridge, fake_updates, main, render_hdmi, render_oled, ui
from splanc_display import updates as upd
from splanc_display.hat import KEY_PINS

NOW = 1_760_000_000.0


# --- parsing ---------------------------------------------------------------------------


def test_parse_is_lenient():
    assert upd.parse(None, "system", NOW).state == "unknown"
    assert upd.parse([], "agent", NOW).state == "unknown"
    c = upd.parse({"state": 7, "available": "x", "last_result": 3}, "system", NOW)
    assert c.state == "unknown" and c.available == "" and not c.installable
    c = upd.parse({"state": "teleporting", "updated_at": NOW}, "system", NOW)
    assert c.state == "teleporting" and c.phase == "Teleporting"


def test_parse_available_staged_and_progress():
    docs = fake_updates.sample_docs(NOW)
    c = upd.parse(docs["both"][0], "system", NOW)
    assert c.installable and c.available == "1.3.0" and c.download_bytes == 312_400_000
    assert c.current_text == "1.2.0" and not c.busy
    c = upd.parse(docs["staged"][0], "system", NOW)
    assert c.staged and c.installable and c.state == "staged"
    c = upd.parse(docs["downloading"][0], "system", NOW)
    assert c.installing and not c.installable and abs(c.progress - 0.47) < 0.01
    assert c.target == "1.3.0"
    c = upd.parse(docs["never-checked"][0], "system", NOW)
    assert c.current_text == "build 1a2b3c4" and not c.installable


def test_a_run_that_stopped_reporting_is_interrupted_and_can_be_retried():
    c = upd.parse(fake_updates.sample_docs(NOW)["interrupted"][0], "system", NOW)
    assert c.state == "interrupted" and c.failed and not c.busy and c.installable


def test_check_result_texts():
    s = fake_updates.sample_updates(NOW)
    assert upd.check_result(s["up-to-date"]) == "Up to date (1.2.0)"
    assert upd.check_result(s["both"]) == "New: system + agent"
    assert upd.check_result(s["agent"]) == "New: agent 1.9.0"
    assert upd.check_result(upd.Updates(system=upd.Component("system", "failed"))) == (
        "Check failed"
    )


# --- requests + watcher ------------------------------------------------------------------


def test_request_writes_only_known_names(tmp_path):
    upd.request("install-system", str(tmp_path))
    assert os.listdir(tmp_path) == ["install-system"]
    assert (tmp_path / "install-system").read_bytes() == b""
    with pytest.raises(upd.RequestError):
        upd.request("rm -rf /", str(tmp_path))
    with pytest.raises(upd.RequestError, match="not managed"):
        upd.request("check", str(tmp_path / "missing"))


def test_request_never_follows_a_symlink(tmp_path):
    target = tmp_path / "elsewhere"
    target.write_text("keep")
    d = tmp_path / "req"
    d.mkdir()
    os.symlink(target, d / "check")
    with pytest.raises(upd.RequestError):
        upd.request("check", str(d))
    assert target.read_text() == "keep"


def test_watcher(tmp_path):
    wall = [NOW]
    sysp, agp, req = tmp_path / "s.json", tmp_path / "a.json", tmp_path / "req"
    w = upd.UpdatesWatcher(str(sysp), str(agp), str(req), wall=lambda: wall[0])
    # Not the SD image (no request dir, no files): no updater to show.
    assert w.info.components == () and not w.info.can_request
    req.mkdir()
    wall[0] += 1
    assert w.poll()
    assert w.info.can_request and w.info.system.state == "unknown"
    s, a = fake_updates.sample_docs(NOW)["system"]
    sysp.write_text(json.dumps(s))
    agp.write_text(json.dumps(a))
    assert w.poll() and w.info.system.installable and not w.info.agent.installable
    assert not w.poll()  # unchanged
    # A running state that stops being refreshed turns "interrupted" on its own.
    sysp.write_text(json.dumps(fake_updates.sample_docs(NOW)["downloading"][0]))
    assert w.poll() and w.info.system.installing
    wall[0] += upd.STALE_SECONDS + 60
    assert w.poll() and w.info.system.state == "interrupted"


# --- the OLED state machine ----------------------------------------------------------------


class Dispatch:
    def __init__(self):
        self.calls = []

    def __call__(self, cmd, done, **args):
        self.calls.append((cmd, args, done))


@pytest.fixture
def d():
    return Dispatch()


def updates_ui(d, clock, installable=True):
    u = ui.OledUI(d, clock)
    u.set_updates(["system", "agent", ui.CHECK_KEY], lambda k: 7)
    u.installable = {"system": installable, "agent": False}
    u.install_note = {"system": "Up to date", "agent": "Up to date"}
    u.press("left")  # home -> (wraps to) Updates
    assert u.view().page == "updates"
    return u


def settle(u, clock, dt=1.0):
    clock.advance(dt)
    u.tick()
    return u.view()


def test_check_row_asks_and_shows_the_answer(d, clock):
    u = updates_ui(d, clock)
    u.press("down")
    u.press("down")
    u.press("press")
    assert [c[0] for c in d.calls] == ["check_updates"]
    v = u.view()
    assert v.checking and v.page == "updates" and v.overlay_text.startswith("Checking")
    u.press("press")  # again while it runs: no second request
    assert len(d.calls) == 1 and u.view().overlay_text == "Already checking"
    d.calls[0][2](True, "New: system 1.3.0")
    v = u.view()
    assert not v.checking and v.overlay_text == "New: system 1.3.0"
    clock.advance(ui.RESULT_TOAST_SECONDS + 0.1)
    assert u.view().overlay is None


def test_install_needs_the_detail_key3_and_a_second_key3(d, clock):
    u = updates_ui(d, clock)
    u.press("press")  # open System
    settle(u, clock)
    v = u.view()
    assert v.page == "update" and v.key == "system"
    u.press("key3")
    v = u.view()
    assert v.overlay == "confirm" and v.install == "system" and v.revoke == ""
    assert d.calls == []  # nothing yet
    u.press("key3")
    assert [(c[0], c[1]) for c in d.calls] == [("install_update", {"component": "system"})]
    d.calls[0][2](True, "")
    assert u.view().overlay_text == "Install started"


@pytest.mark.parametrize("key", ["left", "press", "key1", "key2", "up"])
def test_any_other_key_cancels_the_install(d, clock, key):
    u = updates_ui(d, clock)
    u.press("press")
    settle(u, clock)
    u.press("key3")
    u.press(key)
    assert u.view().overlay_text == "Cancelled"
    assert [c[0] for c in d.calls] == []


def test_the_install_confirm_times_out(d, clock):
    u = updates_ui(d, clock)
    u.press("press")
    settle(u, clock)
    u.press("key3")
    clock.advance(ui.CONFIRM_SECONDS + 0.1)
    u.tick()
    assert u.view().overlay_text == "Cancelled" and d.calls == []
    u.press("key3")  # a fresh confirm, then cancelled by the clock again
    assert u.view().install == "system"


def test_key3_with_nothing_to_install_says_why(d, clock):
    u = updates_ui(d, clock, installable=False)
    u.press("press")
    settle(u, clock)
    u.press("key3")
    v = u.view()
    assert v.overlay == "toast" and v.overlay_text == "Up to date" and d.calls == []
    clock.advance(ui.HOLD_SECONDS + 1)
    u.tick()
    assert u.view().overlay != "confirm"  # KEY3 here never starts a revoke hold


def test_key3_on_the_updates_list_is_still_revoke_all(d, clock):
    u = updates_ui(d, clock)
    u.press("key3")
    clock.advance(ui.HOLD_SECONDS + 0.1)
    u.tick()
    v = u.view()
    assert v.overlay == "confirm" and v.install == "" and v.revoke == ""


def test_update_detail_scrolls_and_goes_back(d, clock):
    u = updates_ui(d, clock)
    u.press("down")
    u.press("press")  # Agent
    settle(u, clock)
    assert u.view().key == "agent"
    for _ in range(5):
        u.press("down")
    assert settle(u, clock).update_scroll == 7 - ui.DETAIL_ROWS
    u.press("left")
    v = settle(u, clock)
    assert v.page == "updates" and v.update_sel == 1


# --- rendering -------------------------------------------------------------------------


def test_every_update_state_renders(outdir):
    paired = __import__("splanc_display.status", fromlist=["parse"]).parse(
        fake_bridge.sample("paired", NOW)
    )
    import dataclasses

    seen = set()
    for name, u in fake_updates.sample_updates(NOW).items():
        s = dataclasses.replace(paired, updates=u)
        views = [ui.View(page="updates")] + [
            ui.View(page="update", key=c.kind) for c in u.components
        ]
        for v in views:
            img = render_oled.render(s, v, now=NOW)
            seen.add(img.tobytes())
            if outdir:
                img.convert("L").resize((512, 256)).save(
                    os.path.join(outdir, f"oled-updates-{name}-{v.page}-{v.key}.png")
                )
        h = render_hdmi.render(s, (960, 540), now=NOW, oled=True)
        if outdir:
            h.save(os.path.join(outdir, f"hdmi-updates-{name}.png"))
    assert len(seen) > 20


def test_oled_shows_what_matters():
    """Spot checks on the words drawn (via draw.TRACE)."""
    import dataclasses

    from splanc_display import draw
    from splanc_display.status import parse

    ups = fake_updates.sample_updates(NOW)

    def texts(name, v):
        s = dataclasses.replace(parse(fake_bridge.sample("paired", NOW)), updates=ups[name])
        draw.TRACE = []
        render_oled._SCENE_CACHE.clear()
        try:
            render_oled.render(s, v, now=NOW)
            return " | ".join(t for _, _, t in draw.TRACE)
        finally:
            draw.TRACE = None

    t = texts("both", ui.View(page="updates"))
    assert "2 new" in t and "System 1.3.0" in t and "Agent 1.9.0" in t and "Check for updates" in t
    t = texts("both", ui.View(page="update", key="system"))
    assert "1.2.0" in t and "1.3.0" in t and "312 MB" in t
    assert render_oled.update_rows(ups["both"].system, NOW)[-1] == (None, "KEY3: install")
    assert ("What", "bridge software") in render_oled.update_rows(ups["both"].agent, NOW)
    t = texts("downloading", ui.View(page="update", key="system"))
    assert "Downloading 47%" in t and "bridge keeps running" in t
    t = texts("failed", ui.View(page="update", key="system"))
    assert "Error" in t  # what went wrong comes first
    assert render_oled.update_rows(ups["failed"].system, NOW)[-1] == (None, "KEY3: retry")
    rows = render_oled.update_rows(ups["up-to-date"].system, NOW)
    assert rows[-1] == (None, "Up to date") and not any("KEY3" in r[1] for r in rows)
    rows = render_oled.update_rows(ups["rolled-back"].system, NOW)
    assert ("Last", "health check failed:") in rows or any(r[0] == "Last" for r in rows)
    t = texts("ssh", ui.View(page="updates"))
    assert "splanc-bridge update" in t
    t = texts("both", ui.View(page="update", key="system", overlay="confirm", install="system"))
    assert "INSTALL UPDATE?" in t and "1.2.0 → 1.3.0" in t and "KEY3 = yes" in t


# --- the service, end to end against the fake updater ----------------------------------------


@pytest.fixture
def rig(tmp_path, buttons):
    bridge = fake_bridge.FakeBridge(str(tmp_path / "status.json"), str(tmp_path / "control.sock"))
    bridge.start()
    bridge.set(fake_bridge.sample("paired", time.time()))
    up = fake_updates.FakeUpdater(str(tmp_path), speed=20).start()
    app = main.App(
        hdmi="off",
        oled="png:" + str(tmp_path / "o.png"),
        status_path=bridge.status_path,
        control_path=bridge.control_path,
        button_factory=buttons,
        boot_frames=None,
        system_update_status=up.system_path,
        agent_update_status=up.agent_path,
        update_request=up.request_dir,
    )
    app.step()
    yield app, up, buttons
    up.stop()
    bridge.stop()
    app.stop.set()


def pump(app, until, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        app.step()
        if until():
            return True
        time.sleep(0.02)
    return False


def tap(app, buttons, key):
    buttons.by_pin[KEY_PINS[key]].press()
    buttons.by_pin[KEY_PINS[key]].release()
    app.step()


def test_service_check_then_confirmed_install(rig):
    app, up, buttons = rig
    up.act("upd_preset", "both")
    tap(app, buttons, "left")  # -> Updates
    assert pump(app, lambda: app.ui.view().page == "updates")
    assert pump(app, lambda: app.status.updates.system.installable)
    # Check for updates: the request file, and the answer as a toast.
    tap(app, buttons, "down")
    tap(app, buttons, "down")
    tap(app, buttons, "press")
    assert pump(app, lambda: app.ui.view().overlay_text == "New: system + agent")
    assert up.requests == ["check"]
    # Browsing, opening, scrolling, and a cancelled confirm request nothing.
    tap(app, buttons, "up")
    tap(app, buttons, "up")
    tap(app, buttons, "press")
    assert pump(app, lambda: app.ui.view().page == "update")
    tap(app, buttons, "key3")
    assert app.ui.view().overlay == "confirm"
    tap(app, buttons, "right")
    time.sleep(0.3)
    app.step()
    assert up.requests == ["check"]
    # KEY3, KEY3: installed, with progress on the way.
    tap(app, buttons, "key3")
    tap(app, buttons, "key3")
    assert pump(app, lambda: up.requests == ["check", "install-system"])
    assert pump(app, lambda: app.status.updates.system.installing)
    assert pump(app, lambda: app.status.updates.system.current == "1.3.0", timeout=10)
    assert not app.status.updates.system.installable
    assert up.requests == ["check", "install-system"]  # the agent was never touched


def test_service_without_an_updater_requests_nothing(tmp_path, buttons):
    bridge = fake_bridge.FakeBridge(str(tmp_path / "status.json"), str(tmp_path / "control.sock"))
    bridge.start()
    try:
        app = main.App(
            hdmi="off",
            oled="png:" + str(tmp_path / "o.png"),
            status_path=bridge.status_path,
            control_path=bridge.control_path,
            button_factory=buttons,
            boot_frames=None,
            system_update_status=str(tmp_path / "none.json"),
            agent_update_status=str(tmp_path / "none2.json"),
            update_request=str(tmp_path / "no-dir"),
        )
        app.step()
        assert app.status.updates.components == ()
        assert app.ui.installable == {}
        app.stop.set()
    finally:
        bridge.stop()
