"""The host simulator: the real service on mocked peripherals, driven like the page does."""

import json
import os
import shutil
import tempfile
import time
import urllib.request

import pytest
from PIL import Image
from splanc_display import sim
from splanc_display.boot import BootFrames


def wait(pred, timeout=5.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.02)
    return False


@pytest.fixture
def bridge():
    d = tempfile.mkdtemp(prefix="sim-", dir="/tmp")  # short: AF_UNIX path limit
    b = sim.FakeModel(os.path.join(d, "status.json"), os.path.join(d, "control.sock"))
    b.phase, b.delay = "running", 0.0
    b.start()
    yield b
    b.stop()
    shutil.rmtree(d, ignore_errors=True)


def tiny_boot():
    """A 0.3 s boot logo (3 frames at 10 fps), each frame distinct."""
    frames = []
    for i in range(3):
        img = Image.new("1", (128, 64), 0)
        img.paste(1, (i * 40, 0, i * 40 + 20, 20))
        frames.append(img)
    return BootFrames(frames, 10)


@pytest.fixture
def simulator(bridge):
    s = sim.Sim(bridge, hdmi_size=(640, 360), boot_frames=tiny_boot()).start()
    yield s
    s.stop()


def page(s):
    return s.app.ui.view().page


def test_boot_then_keys_walk_the_menu(simulator):
    s = simulator
    assert wait(lambda: s.frames.oled_seq > 0)
    assert page(s) == "boot"
    assert wait(lambda: page(s) == "home" and not s.app.ui.view().animating)
    home = s.frames.oled_bits()
    assert any(home)

    for _ in range(2):  # home -> qr -> players, through gpiozero-shaped buttons
        s.tap("right")
        time.sleep(0.05)
    assert wait(lambda: page(s) == "players" and not s.app.ui.view().animating)
    assert s.frames.oled_bits() != home

    s.tap("down")
    s.tap("press")
    assert wait(lambda: page(s) == "detail")
    assert s.app.ui.view().key == "02:00:5E:10:00:A2"  # the second sample fixture
    assert s.frames.hdmi_seq > 0 and s.frames.hdmi.size == (640, 360)


def test_key3_hold_is_timed_and_revokes(simulator, bridge):
    s = simulator
    bridge.act("paired", True)
    assert wait(lambda: page(s) != "boot")
    s.clock.speed = 4.0  # the 5 s hold in 1.25 s of real time
    s.press("key3")
    assert wait(lambda: s.app.ui.view().overlay == "hold")
    assert wait(lambda: s.app.ui.view().overlay == "confirm", timeout=4)
    s.release("key3")
    s.tap("key3")
    assert wait(lambda: "revoke_all" in bridge.commands)
    assert wait(lambda: s.app.watcher.status.state == "unpaired")


def test_bridge_knobs_reach_the_screens(simulator, bridge):
    s = simulator
    assert wait(lambda: s.app.watcher.status.state == "unpaired")
    bridge.act("relay", False)
    assert wait(lambda: s.app.watcher.status.state == "offline")
    bridge.act("relay", True)
    bridge.act("code", 300)
    assert wait(lambda: s.app.watcher.status.state == "pairing")
    n = len(s.app.watcher.status.players)
    bridge.act("add")
    assert wait(lambda: len(s.app.watcher.status.players) == n + 1)
    key = bridge.players[0]["id"]
    bridge.act("toggle", key)
    assert wait(lambda: not s.app.watcher.status.player(key).ok)
    bridge.act("fixtures", "none")
    assert wait(lambda: s.app.watcher.status.players == ())
    bridge.act("phase", "error")
    assert wait(lambda: s.app.watcher.status.state == "error")


def test_restart_replays_the_boot(simulator):
    s = simulator
    assert wait(lambda: page(s) == "home")
    s.restart()
    assert wait(lambda: page(s) == "boot", timeout=2)
    assert wait(lambda: page(s) == "home")
    s.tap("right")  # the restarted service has its own buttons
    assert wait(lambda: page(s) == "qr")


def test_http_page_keys_and_stream(simulator):
    s = simulator
    srv = sim.serve(s, port=0)
    base = f"http://127.0.0.1:{srv.server_port}"
    try:

        def post(path, body):
            req = urllib.request.Request(
                base + path, json.dumps(body).encode(), {"content-type": "application/json"}
            )
            return json.load(urllib.request.urlopen(req, timeout=5))

        html = urllib.request.urlopen(base + "/", timeout=5).read()
        assert b'<canvas id="oled"' in html
        assert wait(lambda: page(s) == "home" and not s.app.ui.view().animating)
        before = s.frames.oled_bits()
        post("/key", {"key": "right", "action": "press"})
        post("/key", {"key": "right", "action": "release"})
        assert wait(lambda: page(s) == "qr" and not s.app.ui.view().animating)
        assert s.frames.oled_bits() != before
        assert len(urllib.request.urlopen(base + "/oled.bin", timeout=5).read()) == 1024

        assert post("/bridge", {"action": "relay", "arg": False})["ok"]
        assert wait(lambda: s.app.watcher.status.state == "offline")
        bad = urllib.request.Request(
            base + "/key", b'{"key": "nope", "action": "press"}', {"content-type": "x"}
        )
        with pytest.raises(urllib.error.HTTPError):
            urllib.request.urlopen(bad, timeout=5)

        ev = urllib.request.urlopen(base + "/events", timeout=5)
        line = ev.readline()
        while not line.startswith(b"data: "):
            line = ev.readline()
        msg = json.loads(line[6:])
        assert "bits" in msg or "view" in msg
        ev.close()
    finally:
        srv.shutdown()
        srv.server_close()


def test_sim_clock_slows_down():
    t = [100.0]
    c = sim.SimClock(lambda: t[0])
    t[0] += 1
    assert c() == pytest.approx(101.0)
    c.speed = 0.25
    t[0] += 1
    assert c() == pytest.approx(101.25)
    c.speed = 1
    t[0] += 1
    assert c() == pytest.approx(102.25)
