"""splanc-display: the bridge appliance's screen service (HDMI + OLED HAT).

    python3 -m splanc_display.main [--hdmi auto|off|png:PATH] [--oled auto|spi|i2c|off|png:PATH]

Environment (systemd reads /etc/splanc-bridge/bridge.env):
    SPLANC_BRIDGE_STATUS / SPLANC_BRIDGE_CONTROL   bridge status file / control socket
    SPLANC_DISPLAY_HDMI=auto|off      default auto (draw on /dev/fb0 when it exists)
    SPLANC_DISPLAY_VT=8               the VT taken over for the HDMI page
    OLED=auto|spi|i2c|off             default auto (see hat.detect)
    OLED_ROTATE=0..3                  default 2 (matches Waveshare's orientation)

Every output is optional and retried: the service runs (and keeps the other
screen going) with no HDMI attached, no HAT, or no bridge running yet.
"""

from __future__ import annotations

import argparse
import os
import queue
import signal
import sys
import threading
import time
from typing import Optional

from . import control, render_hdmi, render_oled
from .fb import Framebuffer, PngSink
from .status import StatusWatcher
from .ui import OledUI

TICK = 0.1  # OLED/UI loop period (s)
HDMI_RETRY = 15.0
OLED_RETRY = 60.0
HDMI_REFRESH = 30.0  # repaint at least this often (clock text, recovery)
CONTRAST_NORMAL, CONTRAST_DIM = 0xCF, 0x10


def log(*a) -> None:
    print("splanc-display:", *a, file=sys.stderr, flush=True)


class PngOled:
    """Stand-in OLED device: saves frames as (scaled) PNGs."""

    def __init__(self, path: str):
        self.path = path
        self.frames = 0
        self.contrast_level = CONTRAST_NORMAL
        self.hidden = False

    def display(self, img) -> None:
        from PIL import Image

        tmp = self.path + ".tmp.png"
        img.convert("L").resize((512, 256), Image.NEAREST).save(tmp)
        os.replace(tmp, self.path)
        self.frames += 1

    def contrast(self, level: int) -> None:
        self.contrast_level = level

    def hide(self) -> None:
        self.hidden = True

    def show(self) -> None:
        self.hidden = False

    def cleanup(self) -> None:
        pass


class App:
    def __init__(
        self,
        hdmi: str = "auto",
        oled: str = "auto",
        clock=time.monotonic,
        wall=time.time,
        status_path: Optional[str] = None,
        control_path: Optional[str] = None,
        button_factory=None,
        vt: int = 8,
        rotate: int = 2,
    ):
        self.clock, self.wall = clock, wall
        self.hdmi_mode, self.oled_mode = hdmi, oled
        self.control_path = control_path
        self.vt, self.rotate = vt, rotate
        self.watcher = StatusWatcher(status_path)
        self.done_q: "queue.Queue" = queue.Queue()
        self.ui = OledUI(self._dispatch, clock)
        self.button_factory = button_factory
        self.stop = threading.Event()
        self.oled = None
        self.oled_kind: Optional[str] = None
        self.buttons = None
        self._oled_next_try = 0.0
        self._oled_last = None
        self._oled_state = (None, None)  # (contrast, hidden)
        self.hdmi = None
        self._hdmi_next_try = 0.0
        self._hdmi_last = None
        self._hdmi_last_at = -1e9
        self._hdmi_was_visible = False

    # --- control commands (run off-thread, finish on the UI thread) -------------
    def _dispatch(self, cmd: str, done) -> None:
        def work():
            try:
                control.send(cmd, path=self.control_path)
                self.done_q.put((done, True, ""))
            except control.ControlError as e:
                log(f"{cmd}: {e}")
                self.done_q.put((done, False, str(e)))

        threading.Thread(target=work, daemon=True).start()

    # --- OLED ------------------------------------------------------------------
    def _open_oled(self) -> None:
        now = self.clock()
        if self.oled is not None or now < self._oled_next_try:
            return
        self._oled_next_try = now + OLED_RETRY
        if self.oled_mode.startswith("png:"):
            self.oled, self.oled_kind = PngOled(self.oled_mode[4:]), "png"
        else:
            from . import hat

            kind = hat.detect(self.oled_mode)
            if kind is None:
                if self.oled_mode == "off":
                    self._oled_next_try = float("inf")
                return
            try:
                self.oled = hat.open_device(kind, rotate=self.rotate)
                self.oled_kind = kind
                log(f"OLED HAT on {kind}")
            except Exception as e:  # luma/spidev/gpio missing or busy
                log(f"OLED ({kind}) unavailable: {e}")
                return
        if self.buttons is None and (self.oled_kind != "png" or self.button_factory):
            try:
                from . import hat

                self.buttons = hat.Buttons(
                    self.ui.press, self.ui.release, factory=self.button_factory
                )
            except Exception as e:
                log(f"HAT buttons unavailable: {e}")

    def _oled_frame(self) -> None:
        if self.oled is None:
            return
        st = self.watcher.status
        self.ui.code_visible = st.active_code(self.wall()) is not None
        view = self.ui.view()
        try:
            want = (CONTRAST_DIM if view.dimmed else CONTRAST_NORMAL, view.asleep)
            if want != self._oled_state:
                self.oled.contrast(want[0])
                (self.oled.hide if view.asleep else self.oled.show)()
                self._oled_state = want
            if view.asleep:
                return
            img = render_oled.render(st, view, now=self.wall())
            data = img.tobytes()
            if data != self._oled_last:
                self.oled.display(img)
                self._oled_last = data
        except Exception as e:
            log(f"OLED write failed, will retry: {e}")
            self.oled = None
            self._oled_last = None
            self._oled_state = (None, None)

    # --- HDMI ------------------------------------------------------------------
    def _open_hdmi(self) -> None:
        now = self.clock()
        if self.hdmi is not None or self.hdmi_mode == "off" or now < self._hdmi_next_try:
            return
        self._hdmi_next_try = now + HDMI_RETRY
        if self.hdmi_mode.startswith("png:"):
            self.hdmi = PngSink(self.hdmi_mode[4:])
            return
        self.hdmi = Framebuffer.open("/dev/fb0", vt_num=self.vt)
        if self.hdmi:
            log(
                f"HDMI framebuffer {self.hdmi.size[0]}x{self.hdmi.size[1]} @ {self.hdmi.info.bpp} bpp"
            )

    def hdmi_frame(self, force: bool = False) -> None:
        self._open_hdmi()
        if self.hdmi is None:
            return
        if self.hdmi.changed():
            log("HDMI mode changed; reopening")
            self.hdmi.close()
            self.hdmi, self._hdmi_last, self._hdmi_next_try = None, None, 0.0
            return self._open_hdmi()
        visible = self.hdmi.visible()
        back = visible and not self._hdmi_was_visible
        self._hdmi_was_visible = visible
        if not visible:
            return
        st = self.watcher.status
        now = self.wall()
        # Content key: changes when anything shown changes (the countdown ticks
        # once a second while a code is up).
        code = st.active_code(now)
        key = (st, int(now) if code and code.expires_at else None, self.oled is not None)
        stale = self.clock() - self._hdmi_last_at >= HDMI_REFRESH
        if not (force or back or stale or key != self._hdmi_last):
            return
        try:
            self.hdmi.show(
                render_hdmi.render(st, self.hdmi.size, now=now, oled=self.oled is not None)
            )
        except OSError as e:
            log(f"HDMI write failed, will retry: {e}")
            self.hdmi.close()
            self.hdmi = None
            return
        self._hdmi_last, self._hdmi_last_at = key, self.clock()

    def _hdmi_loop(self) -> None:
        while not self.stop.is_set():
            try:
                self.hdmi_frame()
            except Exception as e:  # never let the HDMI thread die
                log(f"HDMI error: {e}")
            self.stop.wait(0.25)

    # --- main loop -------------------------------------------------------------
    def step(self) -> None:
        if self.watcher.poll():
            self.ui.activity()
        while True:
            try:
                done, ok, msg = self.done_q.get_nowait()
            except queue.Empty:
                break
            done(ok, msg)
        self.ui.tick()
        self._open_oled()
        self._oled_frame()

    def run(self) -> None:
        t = None
        if self.hdmi_mode != "off":
            t = threading.Thread(target=self._hdmi_loop, daemon=True)
            t.start()
        while not self.stop.is_set():
            self.step()
            self.stop.wait(TICK)
        if t:
            t.join(2)
        self.close()

    def close(self) -> None:
        if self.buttons:
            self.buttons.close()
        if self.oled is not None:
            try:
                self.oled.cleanup()
            except Exception:
                pass
        if self.hdmi is not None:
            self.hdmi.close()


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(prog="splanc-display", description="Splanc bridge status screens")
    ap.add_argument("--hdmi", default=os.environ.get("SPLANC_DISPLAY_HDMI", "auto"))
    ap.add_argument("--oled", default=os.environ.get("OLED", "auto"))
    ap.add_argument("--vt", type=int, default=int(os.environ.get("SPLANC_DISPLAY_VT", "8") or 8))
    ap.add_argument("--rotate", type=int, default=int(os.environ.get("OLED_ROTATE", "2") or 2))
    a = ap.parse_args(argv)
    app = App(hdmi=a.hdmi, oled=a.oled, vt=a.vt, rotate=a.rotate % 4)

    def stop(*_):
        app.stop.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log(f"watching {app.watcher.path} (hdmi={a.hdmi}, oled={a.oled})")
    app.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
