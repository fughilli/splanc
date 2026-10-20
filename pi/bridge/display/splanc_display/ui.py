"""The OLED HAT's interaction state machine: pages, buttons, overlays, dimming.

Pure and clock-injected (``clock`` returns seconds) so it is tested with fakes;
``main`` feeds it button events from gpiozero and ticks it from the render loop.

Button map (Waveshare 1.3" OLED HAT):
    KEY1            new pairing code
    KEY2            identify fixtures (flash every player)
    KEY3 hold >=5 s revoke all paired clients -> confirm screen -> KEY3 again
    joystick        left/up = previous page, right/down = next page, press = home
Any key wakes a sleeping screen (that press does nothing else).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

PAGES = ("home", "qr", "players", "network")

HOLD_SECONDS = 5.0  # KEY3 hold before the revoke confirm appears
CONFIRM_SECONDS = 10.0  # confirm screen auto-cancels after this
TOAST_SECONDS = 2.5
AUTO_CYCLE_SECONDS = 8.0  # page dwell when nobody is pressing buttons
MANUAL_HOLD_SECONDS = 30.0  # a joystick page change pauses auto-cycling this long
DIM_AFTER_SECONDS = 120.0  # contrast drops after this long without input/changes
SLEEP_AFTER_SECONDS = 1800.0  # blank after this long — only when no code is up
SHIFT_PERIOD_SECONDS = 60.0  # burn-in: move the whole image by a pixel this often

# (dx, dy) pixel-shift cycle — small enough to never clip the layout.
SHIFTS = ((0, 0), (1, 0), (1, 1), (0, 1))

KEYS = ("key1", "key2", "key3", "up", "down", "left", "right", "press")

# dispatch(cmd, done) runs a control command off the UI thread and calls
# done(ok: bool, message: str) when it finishes.
Dispatch = Callable[[str, Callable[[bool, str], None]], None]

DONE_TEXT = {
    "new_pairing_code": "New code requested",
    "identify": "Identifying fixtures",
    "revoke_all": "All clients revoked",
}


@dataclass(frozen=True)
class View:
    page: str
    overlay: Optional[str] = None  # None | "hold" | "confirm" | "toast"
    overlay_text: str = ""
    overlay_seconds: float = 0.0  # countdown for hold/confirm
    shift: tuple = (0, 0)
    dimmed: bool = False
    asleep: bool = False


class OledUI:
    def __init__(self, dispatch: Dispatch, clock: Callable[[], float], pages=PAGES):
        self.dispatch = dispatch
        self.clock = clock
        now = clock()
        self.pages = tuple(pages)
        self.page = 0
        self._page_since = now
        self._manual_until = 0.0
        self._last_activity = now
        self._hold_start: Optional[float] = None
        self._confirm_until: Optional[float] = None
        self._toast = ""
        self._toast_until = 0.0
        self._busy: Optional[str] = None
        self.code_visible = False  # set by main from the status (gates sleep)

    # --- inputs ----------------------------------------------------------------
    def activity(self) -> None:
        """Something worth looking at changed (status update): wake + undim."""
        self._last_activity = self.clock()

    def press(self, key: str) -> None:
        if key not in KEYS:
            return
        now = self.clock()
        was_asleep = self._asleep(now)
        self._last_activity = now
        if self._confirm_until is not None:
            self._confirm_until = None
            if key == "key3":
                self._run("revoke_all", now)
            else:
                self._show_toast("Cancelled", now)
            return
        if was_asleep:
            return  # the wake-up press does nothing else
        if key == "key1":
            self._run("new_pairing_code", now)
        elif key == "key2":
            self._run("identify", now)
        elif key == "key3":
            self._hold_start = now
        elif key in ("right", "down"):
            self._goto(self.page + 1, now, manual=True)
        elif key in ("left", "up"):
            self._goto(self.page - 1, now, manual=True)
        elif key == "press":
            self._goto(0, now, manual=True)

    def release(self, key: str) -> None:
        if key != "key3" or self._hold_start is None:
            return
        now = self.clock()
        held = now - self._hold_start
        self._hold_start = None
        if held < HOLD_SECONDS:
            self._show_toast("Hold KEY3 5 s to revoke", now)

    def tick(self) -> None:
        now = self.clock()
        if self._hold_start is not None and now - self._hold_start >= HOLD_SECONDS:
            self._hold_start = None
            self._confirm_until = now + CONFIRM_SECONDS
            self._last_activity = now
        if self._confirm_until is not None and now >= self._confirm_until:
            self._confirm_until = None
            self._show_toast("Cancelled", now)
        if (
            self._hold_start is None
            and self._confirm_until is None
            and now >= self._manual_until
            and now - self._page_since >= AUTO_CYCLE_SECONDS
        ):
            self._goto(self.page + 1, now, manual=False)

    # --- output ----------------------------------------------------------------
    def view(self) -> View:
        now = self.clock()
        shift = SHIFTS[int(now // SHIFT_PERIOD_SECONDS) % len(SHIFTS)]
        idle = now - self._last_activity
        base = dict(
            page=self.pages[self.page],
            shift=shift,
            dimmed=idle >= DIM_AFTER_SECONDS,
            asleep=self._asleep(now),
        )
        if self._confirm_until is not None:
            return View(
                overlay="confirm",
                overlay_seconds=self._confirm_until - now,
                **dict(base, dimmed=False),
            )
        if self._hold_start is not None:
            return View(
                overlay="hold",
                overlay_seconds=HOLD_SECONDS - (now - self._hold_start),
                **dict(base, dimmed=False),
            )
        if self._busy is not None:
            return View(overlay="toast", overlay_text="Working…", **base)
        if now < self._toast_until:
            return View(overlay="toast", overlay_text=self._toast, **base)
        return View(**base)

    @property
    def busy(self) -> bool:
        return self._busy is not None

    # --- internals -------------------------------------------------------------
    def _asleep(self, now: float) -> bool:
        return not self.code_visible and now - self._last_activity >= SLEEP_AFTER_SECONDS

    def _goto(self, idx: int, now: float, manual: bool) -> None:
        self.page = idx % len(self.pages)
        self._page_since = now
        if manual:
            self._manual_until = now + MANUAL_HOLD_SECONDS

    def _show_toast(self, text: str, now: float) -> None:
        self._toast = text
        self._toast_until = now + TOAST_SECONDS

    def _run(self, cmd: str, now: float) -> None:
        if self._busy is not None:
            self._show_toast("Busy, try again", now)
            return
        self._busy = cmd

        def done(ok: bool, message: str) -> None:
            t = self.clock()
            self._busy = None
            self._show_toast(DONE_TEXT.get(cmd, "Done") if ok else (message or "Failed"), t)
            self._last_activity = t

        self.dispatch(cmd, done)
