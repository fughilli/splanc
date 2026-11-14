"""splanc-display: the bridge appliance's screen service (HDMI + OLED HAT).

    python3 -m splanc_display.main [--hdmi auto|off|png:PATH] [--oled auto|spi|i2c|off|png:PATH]

Environment (systemd reads /etc/splanc-bridge/bridge.env):
    SPLANC_BRIDGE_STATUS / SPLANC_BRIDGE_CONTROL   bridge status file / control socket
    SPLANC_SYSTEM_UPDATE_STATUS / SPLANC_AGENT_UPDATE_STATUS / SPLANC_UPDATE_REQUEST
                                      the updaters' status files and the request
                                      directory (updates.py)
    SPLANC_DISPLAY_HDMI=auto|off      default auto (draw on /dev/fb0 when it exists)
    SPLANC_DISPLAY_VT=8               the VT taken over for the HDMI page
    OLED=auto|spi|i2c|off             default auto (see hat.detect)
    OLED_ROTATE=0..3                  default 2 (matches Waveshare's orientation)

Every output is optional and retried: the service runs (and keeps the other
screen going) with no HDMI attached, no HAT, or no bridge running yet.

Frame pacing (OLED): while something moves (a slide, the list highlight, the
boot logo) the loop draws at up to MAX_FPS, slowed so that drawing + pushing a
frame takes at most half of one core (FRAME_CPU_SHARE of the measured cost);
otherwise it polls every IDLE_TICK and only draws when what's shown changed.
A button press wakes the loop at once. The unit runs it at Nice=10, so the
bridge's own work always wins the CPU.
"""

from __future__ import annotations

import argparse
import dataclasses
import os
import queue
import signal
import sys
import threading
import time
from typing import Optional

from . import boot, control, render_hdmi, render_oled, updates
from .fb import Framebuffer, PngSink
from .status import Status, StatusWatcher
from .ui import CHECK_KEY, OledUI

TICK = 0.1  # OLED/UI loop period when nothing moves (s)
IDLE_TICK = TICK
MAX_FPS = 30.0  # animation frame-rate cap
FRAME_CPU_SHARE = 0.5  # at most this much of a core goes to drawing animation frames
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
        boot_frames="auto",
        oled_device=None,
        hdmi_device=None,
        system_update_status: Optional[str] = None,
        agent_update_status: Optional[str] = None,
        update_request: Optional[str] = None,
    ):
        self.clock, self.wall = clock, wall
        self.hdmi_mode, self.oled_mode = hdmi, oled
        self.control_path = control_path
        self.vt, self.rotate = vt, rotate
        self.watcher = StatusWatcher(status_path)
        self.updates = updates.UpdatesWatcher(
            system_update_status, agent_update_status, update_request, wall=wall
        )
        self.status = self._merge()
        self.done_q: "queue.Queue" = queue.Queue()
        self.ui = OledUI(self._dispatch, clock)
        self.inputs: "queue.Queue" = queue.Queue()  # (kind, key, at) from the button thread
        self.wake = threading.Event()
        self.frames = boot.load() if boot_frames == "auto" else boot_frames
        self._booted = False
        self.frame_cost = 0.0  # EWMA seconds to render + push one OLED frame
        self._oled_key = None
        self.button_factory = button_factory
        # Hardware seams for the host simulator (sim.py): factories for a stand-in
        # OLED device (luma's display/contrast/hide/show/cleanup) and HDMI screen
        # (Framebuffer's visible/show/changed/close/size). They replace --oled/--hdmi.
        self.oled_device, self.hdmi_device = oled_device, hdmi_device
        self._sync_fixtures()
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

    def _merge(self) -> Status:
        """The bridge's status with the updaters' merged in (what the screens draw)."""
        return dataclasses.replace(self.watcher.status, updates=self.updates.info)

    # --- control commands (run off-thread, finish on the UI thread) -------------
    def _dispatch(self, cmd: str, done, **args) -> None:
        def work():
            try:
                if cmd == "install_update":
                    updates.request("install-" + args["component"], self.updates.request_path)
                    msg = ""
                elif cmd == "check_updates":
                    msg = self._check_updates()
                else:
                    control.send(cmd, path=self.control_path, **args)
                    msg = ""
                self.done_q.put((done, True, msg))
            except (control.ControlError, updates.RequestError) as e:
                log(f"{cmd}: {e}")
                self.done_q.put((done, False, str(e)))

        threading.Thread(target=work, daemon=True).start()

    def _check_updates(self) -> str:
        """Ask both updaters to look now; wait (this worker thread) until each has
        reported since, then summarise. The UI thread keeps polling the files."""
        t0 = self.wall()
        updates.request("check", self.updates.request_path)
        deadline = time.monotonic() + updates.CHECK_TIMEOUT
        while time.monotonic() < deadline and not self.stop.is_set():
            info = self.updates.info
            done = [
                c.updated_at is not None and c.updated_at > t0 and c.state != "checking"
                for c in info.components
            ]
            if done and all(done):
                break
            self.stop.wait(0.5)
        return updates.check_result(self.updates.info)

    def _sync_updates(self) -> None:
        """The Updates page's rows, and what KEY3 may do in each update's detail."""
        info, now = self.updates.info, self.wall()
        kinds = [c.kind for c in info.components]
        self.ui.set_updates(
            kinds + ([CHECK_KEY] if info.can_request else []),
            lambda k: render_oled.update_row_count(info.get(k), now),
        )
        installable, note = {}, {}
        for c in info.components:
            installable[c.kind] = info.can_request and c.installable
            if c.installable and not info.can_request:
                note[c.kind] = "Update over SSH"
            elif c.busy:
                note[c.kind] = "Update in progress"
            elif c.state == "disabled":
                note[c.kind] = "Updates are off"
            elif c.state == "unknown" and not c.available:
                note[c.kind] = "Not checked yet"
            else:
                note[c.kind] = "Up to date"
        self.ui.installable, self.ui.install_note = installable, note

    # --- OLED ------------------------------------------------------------------
    def _open_oled(self) -> None:
        now = self.clock()
        if self.oled is not None or now < self._oled_next_try:
            return
        self._oled_next_try = now + OLED_RETRY
        if self.oled_device is not None:
            self.oled, self.oled_kind = self.oled_device(), "sim"
        elif self.oled_mode.startswith("png:"):
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
        if not self._booted:
            self._booted = True
            if self.frames is not None:
                self.ui.start_boot(self.frames.duration)  # the logo plays while the bridge starts
        if self.buttons is None and (self.oled_kind != "png" or self.button_factory):
            try:
                from . import hat

                self.buttons = hat.Buttons(
                    lambda k: self._input("press", k),
                    lambda k: self._input("release", k),
                    factory=self.button_factory,
                )
            except Exception as e:
                log(f"HAT buttons unavailable: {e}")

    def _sync_fixtures(self) -> None:
        """Hand the fixture and client lists (and each detail's row count) to the menu."""
        st, now = self.watcher.status, self.wall()
        self._sync_updates()
        self.ui.set_fixtures(
            [p.key for p in st.players],
            lambda k: render_oled.detail_row_count(st.player(k), now),
        )
        self.ui.set_clients(
            [c.key for c in st.paired],
            lambda k: render_oled.client_row_count(st.client(k), now),
        )

    def _input(self, kind: str, key: str) -> None:
        """A button event (gpiozero's thread): queued for the UI thread, which wakes."""
        self.inputs.put((kind, key, self.clock()))
        self.wake.set()

    def _oled_frame(self) -> Optional[object]:
        if self.oled is None:
            return None
        st = self.status
        now = self.wall()
        self.ui.code_visible = st.active_code(now) is not None
        view = self.ui.view()
        try:
            want = (CONTRAST_DIM if view.dimmed else CONTRAST_NORMAL, view.asleep)
            if want != self._oled_state:
                self.oled.contrast(want[0])
                (self.oled.hide if view.asleep else self.oled.show)()
                self._oled_state = want
            if view.asleep:
                return view
            # Idle: draw only when what's shown changed (the clock ticks it once a
            # second for the countdowns and "12 s ago" texts).
            key = (st, view, int(now))
            if not view.animating and key == self._oled_key:
                return view
            self._oled_key = key
            t0 = time.perf_counter()
            img = render_oled.render(st, view, now=now, frames=self.frames)
            data = img.tobytes()
            if data != self._oled_last:
                self.oled.display(img)
                self._oled_last = data
                cost = time.perf_counter() - t0
                self.frame_cost = (
                    cost if self.frame_cost == 0 else 0.8 * self.frame_cost + 0.2 * cost
                )
            return view
        except Exception as e:
            log(f"OLED write failed, will retry: {e}")
            self.oled = None
            self._oled_last = None
            self._oled_key = None
            self._oled_state = (None, None)
            return None

    def frame_interval(self) -> float:
        """Seconds between animation frames: the fps cap, or slower when the panel
        path is slow (render + push within FRAME_CPU_SHARE of a core)."""
        return max(1.0 / MAX_FPS, self.frame_cost / FRAME_CPU_SHARE)

    # --- HDMI ------------------------------------------------------------------
    def _open_hdmi(self) -> None:
        now = self.clock()
        if self.hdmi is not None or self.hdmi_mode == "off" or now < self._hdmi_next_try:
            return
        self._hdmi_next_try = now + HDMI_RETRY
        if self.hdmi_device is not None:
            self.hdmi = self.hdmi_device()
            return
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
        st = self.status
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
    def step(self) -> float:
        """One UI/OLED iteration. Returns how long to wait before the next one."""
        self.wake.clear()
        bridge_changed = self.watcher.poll()
        before = self.updates.info.summary()
        updates_changed = self.updates.poll()
        if bridge_changed or updates_changed:
            if (bridge_changed and self.watcher.salient_changed) or (
                updates_changed and self.updates.info.summary() != before
            ):
                self.ui.activity()  # not for "seen"/perf ticks: those don't wake the screen
            self.status = self._merge()
            self._sync_fixtures()
        while True:
            try:
                kind, key, at = self.inputs.get_nowait()
            except queue.Empty:
                break
            (self.ui.press if kind == "press" else self.ui.release)(key, at=at)
        while True:
            try:
                done, ok, msg = self.done_q.get_nowait()
            except queue.Empty:
                break
            done(ok, msg)
        self.ui.tick()
        self._open_oled()
        view = self._oled_frame()
        return self.frame_interval() if view is not None and view.animating else IDLE_TICK

    def run(self) -> None:
        t = None
        if self.hdmi_mode != "off":
            t = threading.Thread(target=self._hdmi_loop, daemon=True)
            t.start()
        while not self.stop.is_set():
            t0 = self.clock()
            wait = self.step()
            # A press (or stop) cuts the wait short; animation frames are paced
            # from the start of the last one.
            self.wake.wait(max(0.0, wait - (self.clock() - t0)))
            if self.stop.is_set():
                break
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
        app.wake.set()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    log(f"watching {app.watcher.path} (hdmi={a.hdmi}, oled={a.oled})")
    app.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
