"""splanc-display: the bridge appliance's screen service (HDMI + OLED HAT).

    python3 -m splanc_display.main [--hdmi auto|off|png:PATH] [--oled auto|spi|i2c|off|null|png:PATH]

Environment (systemd reads /etc/splanc-bridge/bridge.env):
    SPLANC_BRIDGE_STATUS / SPLANC_BRIDGE_CONTROL   bridge status file / control socket
    SPLANC_DISPLAY_HDMI=auto|off      default auto (draw on /dev/fb0 when it exists)
    SPLANC_DISPLAY_VT=8               the VT taken over for the HDMI page
    OLED=auto|spi|i2c|off             default auto (see hat.detect)
    OLED_ROTATE=0..3                  default 2 (matches Waveshare's orientation)
    SPLANC_UPDATE_REQUESTS / SPLANC_SYSTEM_UPDATE_STATUS / SPLANC_AGENT_UPDATE_STATUS
                                      the Updates page (updates.py; shown when the
                                      request directory exists: the SD image)
    SPLANC_DISPLAY_SPLASH=auto|off    take the screens over from the early boot
                                      splash once loaded and the system is quiet
                                      (splash.py); default auto
    SPLANC_DISPLAY_FRAME_STATS=1      log animation frame-interval stats (jitter)

Every output is optional and retried: the service runs (and keeps the other
screen going) with no HDMI attached, no HAT, or no bridge running yet.

Frame pacing (OLED): while something moves (a slide, the list highlight, the
boot logo) the loop draws at up to MAX_FPS, slowed so that drawing + pushing a
frame takes at most half of one core (FRAME_CPU_SHARE of the measured cost);
otherwise it polls every IDLE_TICK and only draws when what's shown changed. The
screensaver animates at its own generation rate (View.frame_period), not the panel's.
A button press wakes the loop at once. The unit runs it at Nice=10, so the
bridge's own work always wins the CPU.
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

from . import boot, control, render_hdmi, render_oled, splash, updates
from .fb import Framebuffer, PngSink
from .status import StatusWatcher
from .ui import PAGES, UPDATE_CHECK, UPDATES_PAGES, OledUI, View

TICK = 0.1  # OLED/UI loop period when nothing moves (s)
IDLE_TICK = TICK
# The SH1106's own scan rate (datasheet v2.2): fFRM = fOSC / (divide ratio * 54
# DCLKs per row * 64 rows) = 104 Hz at the nominal 360 kHz. luma.oled's init sends
# D5h 0xF0 (divide ratio 1, oscillator +50%): 540 kHz -> ~156 Hz (137-182 Hz over the
# RC oscillator's 315-420 kHz spread). Drawing faster than the panel scans is wasted.
PANEL_HZ = 360_000 * 1.5 / (54 * 64)
MAX_FPS = PANEL_HZ  # animation frame-rate cap: the panel's native rate
FRAME_CPU_SHARE = 0.5  # at most this much of a core goes to drawing animation frames
HDMI_RETRY = 15.0
OLED_RETRY = 60.0
HDMI_REFRESH = 30.0  # repaint at least this often (clock text, recovery)
SPLASH_CONTINUE = 0.4  # after the splash's hand-off, keep its animation at least this long
CONTRAST_NORMAL, CONTRAST_DIM = 0xCF, 0x10


def log(*a) -> None:
    print("splanc-display:", *a, file=sys.stderr, flush=True)


class FrameStats:
    """Animation frame intervals (SPLANC_DISPLAY_FRAME_STATS=1): mean/p50/p99/max
    to the journal every ``every`` frames and when an animation ends."""

    def __init__(self, clock, every: int = 150):
        self.clock, self.every = clock, every
        self.last: Optional[float] = None
        self.ivs: list = []

    def frame(self) -> None:
        now = self.clock()
        if self.last is not None:
            self.ivs.append(now - self.last)
        self.last = now
        if len(self.ivs) >= self.every:
            self.flush()

    def idle(self) -> None:
        self.flush()
        self.last = None

    def flush(self) -> None:
        if not self.ivs:
            return
        v = sorted(self.ivs)
        n = len(v)
        log(
            f"frames: {n + 1} drawn, interval mean {sum(v) / n * 1e3:.1f} p50 {v[n // 2] * 1e3:.1f} "
            f"p99 {v[min(n - 1, int(n * 0.99))] * 1e3:.1f} max {v[-1] * 1e3:.1f} ms"
        )
        self.ivs = []


class NullOled:
    """``--oled null``: frames are rendered and dropped (frame timing benchmarks)."""

    def __init__(self):
        self.frames = 0

    def display(self, img) -> None:
        img.tobytes()
        self.frames += 1

    def contrast(self, level: int) -> None:
        pass

    def hide(self) -> None:
        pass

    def show(self) -> None:
        pass

    def cleanup(self) -> None:
        pass


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
        update_watcher="auto",
        splash_mode: str = "off",
        frame_stats: bool = False,
    ):
        self.clock, self.wall = clock, wall
        self.hdmi_mode, self.oled_mode = hdmi, oled
        self.control_path = control_path
        self.vt, self.rotate = vt, rotate
        # Software updates (updates.py): watched + the Updates page only where the
        # screen manages them (the request directory exists: the SD image).
        if update_watcher == "auto":
            update_watcher = updates.UpdatesWatcher()
            if not update_watcher.updates.supported:
                update_watcher = None
        self.updates = update_watcher
        self.watcher = StatusWatcher(status_path, updates=update_watcher)
        self.done_q: "queue.Queue" = queue.Queue()
        self.ui = OledUI(
            self._dispatch, clock, pages=UPDATES_PAGES if update_watcher is not None else PAGES
        )
        self.ui.update_action = self._update_action
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
        self.splash_mode = splash_mode
        self.handoff: Optional[splash.Handoff] = None
        self.frame_stats = FrameStats(clock) if frame_stats else None
        self._first_frame_logged = set()

    # --- control commands (run off-thread, finish on the UI thread) -------------
    def _dispatch(self, cmd: str, done, **args) -> None:
        def work():
            try:
                if cmd.startswith("update_"):
                    self._update_request(cmd, args.get("target", ""))
                else:
                    control.send(cmd, path=self.control_path, **args)
                self.done_q.put((done, True, ""))
            except (control.ControlError, updates.RequestError) as e:
                log(f"{cmd}: {e}")
                self.done_q.put((done, False, str(e)))

        threading.Thread(target=work, daemon=True).start()

    # --- software updates --------------------------------------------------------------
    def _update_request(self, cmd: str, target: str) -> None:
        """The Updates page's Check / Install / Restart -> a request for the root side."""
        if self.updates is None:
            raise updates.RequestError("updates are not managed from this screen")
        if cmd == "update_check":
            action = "check"
        elif cmd == "update_install" and target in updates.TARGETS:
            action = "install-" + target
        elif cmd == "update_restart" and target == "system":
            action = "restart-system"
        else:
            raise updates.RequestError(f"unknown update command {cmd} {target}")
        log(f"update request: {action}")
        updates.request(action, self.updates.requests)

    def _update_action(self, target: str) -> Optional[str]:
        """What pressing in an updater's detail does: install | restart | None."""
        u = self.watcher.status.updates
        t = u.track(target) if u is not None else None
        if t is None:
            return None
        if t.waiting and target == "system":
            return "restart"
        return "install" if t.offer else None

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
        elif self.oled_mode == "null":
            self.oled, self.oled_kind = NullOled(), "null"
        else:
            from . import hat

            kind = hat.detect(self.oled_mode)
            fd = self._takeover_fd()
            if kind != "spi" and fd is not None:
                os.close(fd)  # the splash drove SPI blind; this HAT is elsewhere (or off)
                fd = None
            if kind is None:
                if self.oled_mode == "off":
                    self._oled_next_try = float("inf")
                return
            try:
                self.oled = hat.open_device(kind, rotate=self.rotate, takeover=fd)
                self.oled_kind = kind
                log(
                    f"OLED HAT on {kind}"
                    + (" (taken over from the boot splash)" if fd is not None else "")
                )
            except Exception as e:  # luma/spidev/gpio missing or busy
                if fd is not None:
                    try:
                        os.close(fd)
                    except OSError:
                        pass
                log(f"OLED ({kind}) unavailable: {e}")
                return
        if not self._booted:
            self._booted = True
            if self.frames is not None:
                h = self.handoff
                if h is not None:
                    # Continue the splash's animation from where it is, to the end of
                    # its current cycle, then slide to the first page.
                    t = self.clock() - h.t0
                    end = self.frames.cycle_end(t + SPLASH_CONTINUE)
                    self.ui.start_boot(end - t, t0=h.t0, text=h.text)
                else:
                    self.ui.start_boot(
                        self.frames.duration
                    )  # the logo plays while the bridge starts
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

    def _takeover_fd(self) -> Optional[int]:
        """The splash's DC/RST line request, once (None: no splash or no OLED there)."""
        h = self.handoff
        if h is None or not h.oled or h.gpio_fd is None:
            return None
        self.handoff = splash.Handoff(h.t0, h.stage, False, None, h.frame, h.version)
        return h.gpio_fd

    # --- the early boot splash ----------------------------------------------------
    def take_over_from_splash(self) -> None:
        """Let the boot splash animate until we are ready and the system is quiet
        enough for a smooth UI, then take the screens over from it (splash.py)."""
        if self.splash_mode == "off" or not splash.alive():
            return
        t0 = self.clock()
        st = self.watcher.status
        # Warm up off-screen while the splash still animates: fonts, the boot frames,
        # the first page, the HDMI page (each first render loads and caches a lot).
        try:
            n = self.wall()
            render_oled.render(
                st, View(page="boot", boot_t=9.0, boot_text="…"), now=n, frames=self.frames
            )
            render_oled.render(st, View(page="home"), now=n)
            if self.hdmi_mode != "off":
                render_hdmi.render(st, (1920, 1080), now=n, oled=True)
        except Exception as e:
            log(f"warm-up render failed: {e}")
        warm = self.clock() - t0
        quiet, waited, what = splash.wait_quiet(
            max_wait=float(os.environ.get("SPLANC_DISPLAY_QUIET_MAX", splash.QUIET_MAX_SECONDS))
        )
        hdmi = self.hdmi_mode == "auto" and os.path.exists("/dev/fb0")
        page = self._handoff_page() if hdmi else None
        self.handoff = splash.stop(hdmi=hdmi, page=page)
        if page:
            try:
                os.unlink(page)
            except OSError:
                pass
        if self.handoff is None:
            log("boot splash went away before the hand-off")
            return
        if self.oled_device is not None or self.oled_mode.split(":")[0] in ("png", "null", "off"):
            fd = self._takeover_fd()  # no HAT driven here: let the lines go
            if fd is not None:
                os.close(fd)
        log(
            f"took over from the boot splash at {self.clock():.2f} s since boot (warm-up "
            f"{warm:.2f} s, {'quiet' if quiet else 'still busy'} after {waited:.1f} s: {what}; "
            f"stage {self.handoff.text!r}, OLED {'yes' if self.handoff.oled else 'no'})"
        )

    def _handoff_page(self) -> Optional[str]:
        """Our first HDMI frame, in the framebuffer's format, for the splash to open
        HDMI into (its outro): the very page hdmi_frame() draws next."""
        from . import fb as fbmod

        info = fbmod.query_sysfs("fb0")
        if info is None or info.bpp not in (16, 32):
            return None
        try:
            from . import hat

            oled = hat.detect(self.oled_mode) is not None
        except Exception:
            oled = False
        path = os.path.join(
            os.environ.get("RUNTIME_DIRECTORY", "/run/splanc-display"), "hdmi-page.fb"
        )
        img = render_hdmi.render(
            self.watcher.status, (info.width, info.height), now=self.wall(), oled=oled
        )
        return path if splash.write_page(img, info, path) else None

    def _sync_fixtures(self) -> None:
        """Hand the fixture and client lists (and each detail's row count) to the menu."""
        st, now = self.watcher.status, self.wall()
        self.ui.set_fixtures(
            [p.key for p in st.players],
            lambda k: render_oled.detail_row_count(st.player(k), now),
        )
        self.ui.set_clients(
            [c.key for c in st.paired],
            lambda k: render_oled.client_row_count(st.client(k), now),
        )
        self.ui.set_matter(st.matter is not None)
        u = st.updates
        if u is not None:
            self.ui.set_updates(
                [t.target for t in u.tracks] + [UPDATE_CHECK],
                lambda k: render_oled.update_row_count(u.track(k), now, st.clients),
            )

    def _input(self, kind: str, key: str) -> None:
        """A button event (gpiozero's thread): queued for the UI thread, which wakes."""
        self.inputs.put((kind, key, self.clock()))
        self.wake.set()

    def _oled_frame(self) -> Optional[object]:
        if self.oled is None:
            return None
        st = self.watcher.status
        now = self.wall()
        self.ui.code_visible = st.active_code(now) is not None
        view = self.ui.view()
        try:
            # Dimmed for the passive stage and the screensaver; the panel is never
            # switched off (the screensaver is what an idle panel shows).
            want = (CONTRAST_DIM if view.dimmed else CONTRAST_NORMAL, False)
            if want != self._oled_state:
                self.oled.contrast(want[0])
                self.oled.show()
                self._oled_state = want
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
                self._first_frame("OLED")
                if self.frame_stats is not None and view.animating:
                    self.frame_stats.frame()
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

    def _first_frame(self, what: str) -> None:
        if what not in self._first_frame_logged:
            self._first_frame_logged.add(what)
            log(f"first {what} frame at {time.monotonic():.2f} s since boot")

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
        self._first_frame("HDMI")

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
        if self.watcher.poll():
            if self.watcher.salient_changed:
                self.ui.activity()  # not for "seen"/perf ticks: those don't wake the screen
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
        animating = view is not None and view.animating
        if self.frame_stats is not None and not animating:
            self.frame_stats.idle()
        if not animating:
            return IDLE_TICK
        return max(self.frame_interval(), view.frame_period)

    def run(self) -> None:
        self.take_over_from_splash()
        if self.handoff is not None:
            # The panel at once (the splash just let go of it), and before the HDMI
            # thread's first page, which shows the HAT's key hints when it's there.
            self._open_oled()
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
    app = App(
        hdmi=a.hdmi,
        oled=a.oled,
        vt=a.vt,
        rotate=a.rotate % 4,
        splash_mode=os.environ.get("SPLANC_DISPLAY_SPLASH", "auto"),
        frame_stats=os.environ.get("SPLANC_DISPLAY_FRAME_STATS", "") not in ("", "0"),
    )

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
