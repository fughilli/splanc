"""The early boot splash's hand-off (splash.py, hat.LineFdGpio), the looping boot
frames it shares with the display, and the quiet-system wait."""

import array
import os
import socket
import struct
import threading
import uuid

import pytest
from PIL import Image
from splanc_display import boot, hat, main, render_oled, splash
from splanc_display.ui import View


@pytest.fixture
def bridge():
    # AF_UNIX paths are limited to ~107 bytes; pytest tmp paths can be longer.
    import tempfile

    from splanc_display import fake_bridge

    d = tempfile.mkdtemp(prefix="ss-", dir="/tmp")
    fb = fake_bridge.FakeBridge(
        os.path.join(d, "status.json"), os.path.join(d, "control.sock")
    ).start()
    yield fb
    fb.stop()
    for f in os.listdir(d):
        os.unlink(os.path.join(d, f))
    os.rmdir(d)


def frames_with_loop():
    intro = [Image.new("1", (128, 64), 0) for _ in range(4)]
    loop = []
    for i in range(3):
        img = Image.new("1", (128, 64), 0)
        img.putpixel((i, 0), 1)
        loop.append(img)
    return intro, loop


def test_boot_frames_v2_loop_round_trip():
    import gen_boot_frames

    intro, loop = frames_with_loop()
    fr = boot.unpack(gen_boot_frames.pack(intro, fps=10, loop=loop))
    assert fr.loop_start == 4 and len(fr.frames) == 7
    assert fr.duration == pytest.approx(0.4) and fr.loop_duration == pytest.approx(0.3)
    assert [fr.index(t / 10) for t in range(12)] == [0, 1, 2, 3, 4, 5, 6, 4, 5, 6, 4, 5]
    assert fr.at(0.75).tobytes() == loop[0].tobytes()
    # A calm hand-off point: the end of the intro, or of the current loop cycle.
    assert fr.cycle_end(0.1) == pytest.approx(0.4)
    assert fr.cycle_end(0.45) == pytest.approx(0.7)
    assert fr.cycle_end(0.7) == pytest.approx(0.7)
    # Version 1 (no loop) still reads and holds its last frame.
    v1 = boot.unpack(gen_boot_frames.pack(intro + loop, fps=10))
    assert v1.loop_start is None and v1.index(5.0) == 6 and v1.cycle_end(9.0) == 9.0


def test_generated_loop_starts_and_ends_on_the_intro_last_frame():
    """intro -> loop and loop -> loop never jump: the rest frame is the intro's last."""
    import gen_boot_frames as g

    here = os.path.dirname(os.path.abspath(__file__))
    svg = os.path.join(here, "..", "..", "..", "web", "public", "icons", "splanc.svg")
    if "TEST_SRCDIR" in os.environ:
        svg = os.path.join(
            os.environ["TEST_SRCDIR"], "_main", "web", "public", "icons", "splanc.svg"
        )
    if not os.path.exists(svg):
        pytest.skip("logo svg not reachable")
    intro = g.build_frames(svg)
    loop = g.build_loop(svg, intro[-1])
    assert len(loop) == int(round(g.LOOP_SECONDS * g.FPS))
    assert loop[-1].tobytes() == intro[-1].tobytes()
    moving = {f.tobytes() for f in loop}
    assert len(moving) > 10  # it keeps moving
    for a, b in zip([intro[-1]] + loop, loop + [loop[0]]):
        assert sum(x != y for x, y in zip(a.tobytes(), b.tobytes())) < 40
    # Nothing is drawn where the stage text goes.
    assert all(f.crop((0, 55, 128, 64)).getbbox() is None for f in loop)


def test_stage_text_sits_under_the_led_row():
    for text in splash.STAGES:
        img = Image.new("1", (128, 64), 0)
        splash.draw_stage(img, text)
        l, t, r, b = img.getbbox()
        assert t >= 56 and b <= 64 and l >= 0 and r <= 128, (text, img.getbbox())


def test_renderer_draws_the_stage_text_only_in_the_loop():
    intro, loop = frames_with_loop()
    fr = boot.BootFrames(intro + loop, 10, loop_start=4)
    from splanc_display.status import Status

    st = Status(state="waiting")
    early = render_oled.render(
        st, View(page="boot", boot_t=0.1, boot_text="Connecting…"), frames=fr
    )
    late = render_oled.render(st, View(page="boot", boot_t=0.5, boot_text="Connecting…"), frames=fr)
    assert early.crop((0, 55, 128, 64)).getbbox() is None
    want = fr.at(0.5).copy()
    splash.draw_stage(want, "Connecting…")
    assert late.tobytes() == want.tobytes()


def test_parse_reply():
    assert splash.parse_reply("ok t0=1500000000 stage=2 oled=1 frame=77\n") == (1.5, 2, True, 77)
    with pytest.raises(ValueError):
        splash.parse_reply("no")


class FakeSplash:
    """A stand-in splash on an abstract socket: answers ``stop`` like splanc-splash."""

    def __init__(self, t0_ns=5_000_000_000, stage=2, oled=True):
        self.address = "\0splanc-splash-test-" + uuid.uuid4().hex
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.bind(self.address)
        self.sock.listen(4)
        self.t0_ns, self.stage, self.oled = t0_ns, stage, oled
        self.requests = []
        self.r, self.w = os.pipe()  # stands in for the GPIO line request
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self):
        while True:
            try:
                c, _ = self.sock.accept()
            except OSError:
                return
            with c:
                data = c.recv(64)
                if not data.startswith(b"stop"):
                    continue
                self.requests.append(data.decode().strip())
                msg = f"ok t0={self.t0_ns} stage={self.stage} oled={int(self.oled)} frame=12\n".encode()
                anc = [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", [self.w]))]
                c.sendmsg([msg], anc if self.oled else [])
                return

    def close(self):
        self.sock.close()
        for fd in (self.r, self.w):
            try:
                os.close(fd)
            except OSError:
                pass


@pytest.fixture
def fake_splash(monkeypatch):
    s = FakeSplash()
    monkeypatch.setattr(splash, "ADDRESS", s.address)
    yield s
    s.close()


def test_stop_returns_the_handoff_and_the_passed_fd(fake_splash):
    assert splash.alive()
    h = splash.stop(hdmi=True)
    assert fake_splash.requests == ["stop hdmi=1"]
    assert h.t0 == 5.0 and h.stage == 2 and h.text == "Connecting…" and h.oled and h.frame == 12
    os.write(h.gpio_fd, b"x")  # really the splash's descriptor, alive in this process
    assert os.read(fake_splash.r, 1) == b"x"
    os.close(h.gpio_fd)


def test_no_splash_means_no_handoff(monkeypatch):
    monkeypatch.setattr(splash, "ADDRESS", "\0splanc-splash-none-" + uuid.uuid4().hex)
    assert not splash.alive() and splash.stop(hdmi=False) is None


def test_wait_quiet_waits_for_cpu_and_pressure():
    t = [0.0]
    busy = iter([(0, 100), (90, 200), (130, 300), (160, 400), (190, 500), (220, 600)])
    psi = iter([50.0, 10.0, 40.0, 10.0, 10.0])
    quiet, waited, what = splash.wait_quiet(
        max_wait=10,
        clock=lambda: t[0],
        sleep=lambda s: t.__setitem__(0, t[0] + s),
        cpu=lambda: next(busy),
        pressure=lambda: next(psi),
    )
    # 90% busy; 40% + psi 10 (quiet); 30% + psi 40 (not); 30% + 10, 30% + 10: two in a row
    assert quiet and waited == pytest.approx(2.5) and "cpu 30%" in what and "psi 10.0" in what


def test_wait_quiet_gives_up_on_a_busy_system():
    t = [0.0]
    n = [0]

    def cpu():
        n[0] += 1
        return n[0] * 95, n[0] * 100

    quiet, waited, _ = splash.wait_quiet(
        max_wait=3,
        clock=lambda: t[0],
        sleep=lambda s: t.__setitem__(0, t[0] + s),
        cpu=cpu,
        pressure=lambda: None,
    )
    assert not quiet and waited == pytest.approx(3.0)


def test_read_cpu_and_psi(tmp_path):
    (tmp_path / "stat").write_text("cpu  10 0 5 80 5 0 0 0 0 0\ncpu0 1 2 3 4\n")
    assert splash.read_cpu(str(tmp_path / "stat")) == (20, 100)
    (tmp_path / "cpu").write_text("some avg10=12.50 avg60=3.00 avg300=1.00 total=1\n")
    assert splash.read_psi(str(tmp_path / "cpu")) == 12.5
    assert splash.read_psi(str(tmp_path / "missing")) is None


def test_line_fd_gpio_drives_dc_and_keeps_rst_high():
    calls = []
    g = hat.LineFdGpio(42, ioctl=lambda fd, req, arg: calls.append((fd, req, arg)))
    g.setup(hat.PIN_DC, g.OUT)
    g.output(hat.PIN_DC, g.HIGH)
    g.output(hat.PIN_DC, g.LOW)
    assert [struct.unpack("<QQ", a) for _, _, a in calls] == [(0b11, 0b11), (0b10, 0b11)]
    assert all(fd == 42 and req == 0xC010B40F for fd, req, _ in calls)
    with pytest.raises(ValueError):
        g.setup(21, g.OUT)  # a key: never ours to drive


def test_app_continues_the_splash_animation(fake_splash, bridge, tmp_path, clock, monkeypatch):
    monkeypatch.setattr(splash, "wait_quiet", lambda **kw: (True, 0.5, "cpu 10%"))
    intro, loop = frames_with_loop()
    fr = boot.BootFrames(intro + loop, 10, loop_start=4)
    clock.t = 7.25  # 2.25 s after the splash's t0 (5.0)
    app = main.App(
        hdmi="off",
        oled="png:" + str(tmp_path / "oled.png"),
        clock=clock,
        status_path=bridge.status_path,
        control_path=bridge.control_path,
        boot_frames=fr,
        splash_mode="auto",
    )
    app.take_over_from_splash()
    assert fake_splash.requests == ["stop hdmi=0"]
    assert app.handoff is not None and app.handoff.gpio_fd is None  # png OLED: lines let go
    app.step()
    v = app.ui.view()
    assert v.page == "boot" and v.boot_t == pytest.approx(2.25) and v.boot_text == "Connecting…"
    assert v.shift == (0, 0)
    # It plays on to the end of the loop cycle that ends >= 0.4 s from now (2.8 s), then slides.
    clock.advance(0.5)
    app.step()
    assert app.ui.view().page == "boot"
    clock.advance(0.1)
    app.step()
    v = app.ui.view()
    assert v.page != "boot" and v.slide is not None and v.slide.src.page == "boot"


def test_app_without_splash_starts_its_own_boot(bridge, tmp_path, clock, monkeypatch):
    monkeypatch.setattr(splash, "ADDRESS", "\0splanc-splash-none-" + uuid.uuid4().hex)
    intro, loop = frames_with_loop()
    fr = boot.BootFrames(intro + loop, 10, loop_start=4)
    app = main.App(
        hdmi="off",
        oled="png:" + str(tmp_path / "oled.png"),
        clock=clock,
        status_path=bridge.status_path,
        boot_frames=fr,
        splash_mode="auto",
    )
    app.take_over_from_splash()
    assert app.handoff is None
    app.step()
    v = app.ui.view()
    assert v.page == "boot" and v.boot_t == 0 and v.boot_text == ""
