"""End to end against the fake bridge: status file -> screens, buttons -> socket."""

import os
import tempfile
import time

import pytest
from splanc_display import control, ctl, fake_bridge, main
from splanc_display.hat import KEY_PINS


@pytest.fixture
def bridge(tmp_path):
    # AF_UNIX paths are limited to ~107 bytes; pytest tmp paths can be longer.
    import tempfile

    d = tempfile.mkdtemp(prefix="sb-", dir="/tmp")
    fb = fake_bridge.FakeBridge(
        os.path.join(d, "status.json"), os.path.join(d, "control.sock")
    ).start()
    yield fb
    fb.stop()
    for f in os.listdir(d):
        os.unlink(os.path.join(d, f))
    os.rmdir(d)


def wait(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


def make_app(bridge, tmp_path, buttons, clock):
    return main.App(
        hdmi="png:" + str(tmp_path / "hdmi.png"),
        oled="png:" + str(tmp_path / "oled.png"),
        clock=clock,
        status_path=bridge.status_path,
        control_path=bridge.control_path,
        button_factory=buttons,
    )


def drain(app, until, timeout=5.0):
    """Step the app (fake clock) until ``until()`` — commands run on real threads."""
    return wait(lambda: (app.step(), until())[1], timeout)


def test_control_roundtrip(bridge):
    assert control.send("identify", path=bridge.control_path) == {"ok": True, "players": 0}
    bridge.fail = "relay offline"
    with pytest.raises(control.ControlError, match="relay offline"):
        control.send("identify", path=bridge.control_path)


def test_control_no_bridge():
    # A short dir: macOS caps AF_UNIX paths at 104 bytes and its pytest tmp_path is longer.
    with tempfile.TemporaryDirectory(dir="/tmp") as d:
        with pytest.raises(control.ControlError, match="not running"):
            control.send("identify", path=os.path.join(d, "nope.sock"))


def test_screens_follow_status_and_buttons_drive_bridge(bridge, tmp_path, buttons, clock):
    bridge.set(fake_bridge.sample("unpaired", time.time()))
    app = make_app(bridge, tmp_path, buttons, clock)
    app.step()
    app.hdmi_frame()
    assert app.oled_kind == "png" and app.oled.frames == 1
    assert app.hdmi.frames == 1 and os.path.exists(tmp_path / "hdmi.png")
    app.hdmi_frame()
    assert app.hdmi.frames == 1  # unchanged status: no repaint

    # KEY1 -> new_pairing_code -> bridge rewrites status -> both screens update
    buttons.by_pin[KEY_PINS["key1"]].press()
    assert drain(app, lambda: app.watcher.status.state == "pairing")
    assert bridge.commands == ["new_pairing_code"]
    app.hdmi_frame()
    assert app.hdmi.frames == 2

    # KEY2 -> identify
    buttons.by_pin[KEY_PINS["key2"]].press()
    assert drain(app, lambda: "identify" in bridge.commands and not app.ui.busy)

    # KEY3 held 5 s -> confirm -> KEY3 -> revoke_all
    k3 = buttons.by_pin[KEY_PINS["key3"]]
    k3.press()
    clock.advance(5.1)
    app.step()
    assert app.ui.view().overlay == "confirm"
    k3.release()
    k3.press()
    assert drain(
        app, lambda: "revoke_all" in bridge.commands and app.watcher.status.state == "unpaired"
    )


def test_bridge_down_shows_error_toast(bridge, tmp_path, buttons, clock):
    app = make_app(bridge, tmp_path, buttons, clock)
    bridge.stop()
    app.step()
    buttons.by_pin[KEY_PINS["key1"]].press()
    assert drain(app, lambda: not app.ui.busy)
    assert "not running" in app.ui.view().overlay_text


def test_missing_status_file_waits(tmp_path, buttons, clock):
    app = main.App(
        hdmi="off",
        oled="png:" + str(tmp_path / "o.png"),
        clock=clock,
        status_path=str(tmp_path / "none.json"),
    )
    app.step()
    assert app.watcher.status.state == "waiting" and app.oled.frames == 1


def test_ctl_status_and_commands(bridge, monkeypatch, capsys):
    monkeypatch.setenv("SPLANC_BRIDGE_STATUS", bridge.status_path)
    monkeypatch.setenv("SPLANC_BRIDGE_CONTROL", bridge.control_path)
    bridge.set(fake_bridge.sample("pairing", time.time(), code="WXYZ-2345"))
    assert ctl.main(["status"]) == 0
    out = capsys.readouterr().out
    assert "Ready to pair" in out and "WXYZ-2345" in out and "Living room arch" in out
    assert ctl.main(["status", "--json"]) == 0
    assert '"WXYZ-2345"' in capsys.readouterr().out
    assert ctl.main(["new-code"]) == 0
    assert "Pairing code:" in capsys.readouterr().out
    assert ctl.main(["revoke-all"]) == 2  # no tty, no --yes: refuses
    assert ctl.main(["revoke-all", "--yes"]) == 0
    assert bridge.commands == ["new_pairing_code", "revoke_all"]


def test_boot_animation_plays_then_idle_draws_nothing(bridge, tmp_path, buttons, clock):
    from PIL import Image
    from splanc_display import boot

    frames = boot.BootFrames([Image.new("1", (128, 64), v) for v in (0, 255)], fps=10)
    bridge.set(fake_bridge.sample("paired", time.time()))
    app = main.App(
        hdmi="off",
        oled="png:" + str(tmp_path / "o.png"),
        clock=clock,
        status_path=bridge.status_path,
        control_path=bridge.control_path,
        button_factory=buttons,
        boot_frames=frames,
    )
    wait = app.step()
    assert app.ui.view().page == "boot" and wait == pytest.approx(app.frame_interval())
    assert app.frame_interval() >= 1 / main.MAX_FPS
    clock.advance(0.25)  # past the logo: the hand-off slide runs
    app.step()
    assert app.ui.view().slide is not None
    clock.advance(1.0)
    assert app.step() == main.IDLE_TICK  # settled: back to the idle poll
    n = app.oled.frames
    for _ in range(5):
        app.step()  # nothing changed (same second): no redraw, no SPI traffic
    assert app.oled.frames == n


def test_press_wakes_the_loop_and_slides(bridge, tmp_path, buttons, clock):
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
    assert not app.wake.is_set()
    buttons.by_pin[KEY_PINS["right"]].press()
    assert app.wake.is_set()  # the run loop's wait ends at once
    assert app.step() == pytest.approx(app.frame_interval())  # animating: frame pacing
    assert app.ui.view().page == "qr" and app.ui.view().slide is not None


def test_frame_interval_backs_off_on_a_slow_panel(bridge, tmp_path, clock):
    app = main.App(
        hdmi="off", oled="off", clock=clock, status_path=bridge.status_path, boot_frames=None
    )
    app.frame_cost = 0.005
    assert app.frame_interval() == pytest.approx(1 / main.MAX_FPS)
    app.frame_cost = 0.040  # a slow Pi: keep drawing to half a core
    assert app.frame_interval() == pytest.approx(0.040 / main.FRAME_CPU_SHARE)


def test_fixture_list_follows_the_status(bridge, tmp_path, buttons, clock):
    doc = fake_bridge.sample("paired", time.time())
    doc["players"] = fake_bridge.many_players(time.time(), 6)
    bridge.set(doc)
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
    press = lambda k: (buttons.by_pin[KEY_PINS[k]].press(), app.step())  # noqa: E731
    press("right")
    press("right")
    press("down")
    press("press")
    v = app.ui.view()
    assert v.page == "detail" and v.key == doc["players"][1]["id"]
    # The fixture vanishes from the bridge's list: back to the list.
    doc["players"] = [p for p in doc["players"] if p["id"] != v.key]
    doc["updated_at"] += 1
    bridge.set(doc)
    assert drain(app, lambda: app.ui.view().page == "players")
