"""The OLED HAT's interaction state machine: pages, the fixture menu, buttons,
overlays, transitions, dimming.

Pure and clock-injected (``clock`` returns seconds) so it is tested with fakes;
``main`` feeds it button events and status updates and ticks it from the render loop.

Screens: four top-level pages (home, qr, players = the fixture list, network)
and, under the list, one fixture's detail. Button map (Waveshare 1.3" OLED HAT):

    KEY1            new pairing code (from anywhere; goes to the home page to show it)
    KEY2            identify fixtures (flash every player)
    KEY3 hold >=5 s revoke all paired clients -> confirm screen -> KEY3 again
    joystick        left/right = previous/next page; up/down = previous/next page,
                    except on the fixture list where they move the selection;
                    press = open the selected fixture (list) or go home (other pages)
    in a fixture    up/down scroll its details; left or press = back to the list

Any key wakes a sleeping screen (that press does nothing else). Every screen
change slides (anim.py); a press during a slide retargets it at once.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from . import anim
from .anim import Scene, SlideView, Tween

PAGES = ("home", "qr", "players", "network")

HOLD_SECONDS = 5.0  # KEY3 hold before the revoke confirm appears
CONFIRM_SECONDS = 10.0  # confirm screen auto-cancels after this
TOAST_SECONDS = 2.5
AUTO_CYCLE_SECONDS = 8.0  # page dwell when nobody is pressing buttons
MANUAL_HOLD_SECONDS = 30.0  # a joystick page change pauses auto-cycling this long
DETAIL_IDLE_SECONDS = 300.0  # an untouched fixture detail goes back to the list
DIM_AFTER_SECONDS = 120.0  # contrast drops after this long without input/changes
SLEEP_AFTER_SECONDS = 1800.0  # blank after this long — only when no code is up
SHIFT_PERIOD_SECONDS = 60.0  # burn-in: move the whole image by a pixel this often

LIST_ROWS = 4  # fixture rows on screen at once
DETAIL_ROWS = 4  # detail rows on screen at once

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
    page: str  # a PAGES entry, "detail", or "boot"
    overlay: Optional[str] = None  # None | "hold" | "confirm" | "toast"
    overlay_text: str = ""
    overlay_seconds: float = 0.0  # countdown for hold/confirm
    shift: tuple = (0, 0)
    dimmed: bool = False
    asleep: bool = False
    key: str = ""  # the fixture shown by "detail"
    slide: Optional[SlideView] = None  # a screen change in progress
    sel: int = 0  # the fixture list's selected row
    list_pos: float = 0.0  # its highlight, in rows (animated)
    list_top: float = 0.0  # its scroll offset, in rows (animated)
    detail_scroll: float = 0.0  # the detail's scroll offset, in rows (animated)
    boot_t: Optional[float] = None  # seconds into the boot animation (while it shows)
    animating: bool = False  # something is moving: draw at the animation frame rate


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
        # The fixture menu.
        self._keys: tuple = ()
        self._sel_key: Optional[str] = None
        self._detail: Optional[str] = None  # the open fixture's key
        self._detail_since = now
        self._rows_of: Callable[[str], int] = lambda key: DETAIL_ROWS
        self._list_pos = Tween(0, anim.LIST_SECONDS)
        self._list_top = Tween(0, anim.SCROLL_SECONDS)
        self._detail_scroll = Tween(0, anim.SCROLL_SECONDS)
        # Screen changes + the boot animation.
        self._slide: Optional[anim.Slide] = None
        self._boot_t0: Optional[float] = None
        self._boot_until: Optional[float] = None

    # --- the scene shown (when no slide is running) ---------------------------------
    @property
    def scene(self) -> Scene:
        if self._boot_until is not None:
            return Scene("boot")
        if self._detail is not None:
            return Scene("detail", self._detail)
        return Scene(self.pages[self.page])

    @property
    def sel(self) -> int:
        if self._sel_key is None or self._sel_key not in self._keys:
            return 0
        return self._keys.index(self._sel_key)

    def _change(
        self,
        before: Scene,
        now: float,
        direction: str,
        style: str = "slide",
        duration: float = anim.PAGE_SECONDS,
    ) -> None:
        after = self.scene
        if after == before:
            return
        self._slide = anim.retarget(self._slide, before, after, direction, now, duration, style)

    # --- inputs ----------------------------------------------------------------
    def activity(self) -> None:
        """Something worth looking at changed (status update): wake + undim."""
        self._last_activity = self.clock()

    def start_boot(self, seconds: float) -> None:
        """Show the boot animation for ``seconds``, then slide to the first page."""
        now = self.clock()
        self._boot_t0 = now
        self._boot_until = now + seconds

    def set_fixtures(self, keys, rows_of: Optional[Callable[[str], int]] = None) -> None:
        """The fixture list changed (or was refreshed). Keeps the selection on the
        same fixture; one that disappeared hands it to its neighbour, and an open
        detail of a vanished fixture slides back to the list."""
        now = self.clock()
        keys = tuple(keys)
        if rows_of is not None:
            self._rows_of = rows_of
        old_sel = self.sel
        self._keys = keys
        if self._sel_key is not None and self._sel_key in keys:
            new = keys.index(self._sel_key)
            if new != old_sel:  # something was inserted/removed above it: stay on it
                self._list_pos.shift(new - old_sel)
                self._list_top.snap(self._top_for(new, self._list_top.target + (new - old_sel)))
        elif keys:
            idx = min(old_sel, len(keys) - 1)
            self._sel_key = keys[idx]
            self._list_pos.snap(idx)
            self._list_top.snap(self._top_for(idx, self._list_top.target))
        else:
            self._sel_key = None
            self._list_pos.snap(0)
            self._list_top.snap(0)
        if self._detail is not None and self._detail not in keys:
            before = self.scene
            self._detail = None
            self._page_to("players")
            self._change(before, now, "right", "push", anim.PUSH_SECONDS)
            self._show_toast("Fixture is gone", now)
        elif self._detail is not None:
            self._clamp_detail(now)

    def press(self, key: str, at: Optional[float] = None) -> None:
        """A key went down (``at``: when, if it waited in a queue; default now)."""
        if key not in KEYS:
            return
        now = self.clock() if at is None else at
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
        if self._boot_until is not None:
            self._end_boot(now)  # any key skips the logo, then does its job
        if key == "key1":
            self._run("new_pairing_code", now)
            self._go_home_for_code(now)
        elif key == "key2":
            self._run("identify", now)
        elif key == "key3":
            self._hold_start = now
        elif self._detail is not None:
            self._detail_key(key, now)
        elif self.pages[self.page] == "players" and self._keys and key in ("up", "down", "press"):
            self._list_key(key, now)
        elif key in ("right", "down"):
            self._goto(self.page + 1, now, manual=True)
        elif key in ("left", "up"):
            self._goto(self.page - 1, now, manual=True, direction="right")
        elif key == "press":
            self._goto(0, now, manual=True, direction="right")

    def release(self, key: str, at: Optional[float] = None) -> None:
        if key != "key3" or self._hold_start is None:
            return
        now = self.clock() if at is None else at
        held = now - self._hold_start
        self._hold_start = None
        if held < HOLD_SECONDS:
            self._show_toast("Hold KEY3 5 s to revoke", now)

    def tick(self) -> None:
        now = self.clock()
        if self._slide is not None and self._slide.done(now):
            self._slide = None
        if self._boot_until is not None:
            if now >= self._boot_until:
                self._end_boot(now)
            return
        if self._hold_start is not None and now - self._hold_start >= HOLD_SECONDS:
            self._hold_start = None
            self._confirm_until = now + CONFIRM_SECONDS
            self._last_activity = now
        if self._confirm_until is not None and now >= self._confirm_until:
            self._confirm_until = None
            self._show_toast("Cancelled", now)
        if self._detail is not None:
            if now - self._detail_since >= DETAIL_IDLE_SECONDS:
                self._back_to_list(now)
            return  # no auto-cycling out of a fixture someone opened
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
        scene = self.scene
        slide = (
            self._slide.view(now) if self._slide is not None and not self._slide.done(now) else None
        )
        boot_t = None
        if self._boot_t0 is not None and (
            scene.page == "boot" or (slide and "boot" in (slide.src.page, slide.dst.page))
        ):
            boot_t = now - self._boot_t0
        animating = (
            slide is not None
            or scene.page == "boot"
            or self._list_pos.moving(now)
            or self._list_top.moving(now)
            or self._detail_scroll.moving(now)
        )
        base = dict(
            page=scene.page,
            key=scene.key,
            shift=shift,
            dimmed=idle >= DIM_AFTER_SECONDS,
            asleep=self._asleep(now),
            slide=slide,
            sel=self.sel,
            list_pos=self._list_pos.value(now),
            list_top=self._list_top.value(now),
            detail_scroll=self._detail_scroll.value(now),
            boot_t=boot_t,
            animating=animating,
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
        if self._boot_until is not None:
            return False
        return not self.code_visible and now - self._last_activity >= SLEEP_AFTER_SECONDS

    def _end_boot(self, now: float) -> None:
        before = self.scene
        self._boot_until = None
        self._page_since = now
        self._change(before, now, "up", "slide", anim.HANDOFF_SECONDS)

    def _page_to(self, name: str) -> None:
        if name in self.pages:
            self.page = self.pages.index(name)

    def _goto(self, idx: int, now: float, manual: bool, direction: str = "left") -> None:
        before = self.scene
        self.page = idx % len(self.pages)
        self._page_since = now
        if manual:
            self._manual_until = now + MANUAL_HOLD_SECONDS
        self._change(before, now, direction)

    def _go_home_for_code(self, now: float) -> None:
        if self._detail is None and self.pages[self.page] in ("home", "qr"):
            return
        before = self.scene
        self._detail = None
        self.page = 0
        self._page_since = now
        self._manual_until = now + MANUAL_HOLD_SECONDS
        self._change(before, now, "right")

    @staticmethod
    def _top_for(sel: int, top: float) -> float:
        """The list's scroll offset that keeps row ``sel`` on screen, moving least."""
        top = int(round(top))
        if sel < top:
            return sel
        if sel >= top + LIST_ROWS:
            return sel - LIST_ROWS + 1
        return top

    def _list_key(self, key: str, now: float) -> None:
        self._manual_until = now + MANUAL_HOLD_SECONDS
        self._page_since = now
        idx = self.sel
        if key == "press":
            before = self.scene
            self._detail = self._keys[idx]
            self._detail_since = now
            self._detail_scroll.snap(0)
            self._change(before, now, "left", "push", anim.PUSH_SECONDS)
            return
        new = max(0, min(len(self._keys) - 1, idx + (1 if key == "down" else -1)))
        if new == idx:
            return
        self._sel_key = self._keys[new]
        self._list_pos.set(new, now)
        self._list_top.set(self._top_for(new, self._list_top.target), now)

    def _detail_key(self, key: str, now: float) -> None:
        self._detail_since = now
        if key in ("left", "press"):
            self._back_to_list(now)
        elif key in ("up", "down"):
            step = 1 if key == "down" else -1
            self._detail_scroll.set(self._detail_limit(self._detail_scroll.target + step), now)

    def _detail_limit(self, t: float) -> float:
        most = max(0, self._rows_of(self._detail) - DETAIL_ROWS) if self._detail else 0
        return max(0, min(most, t))

    def _clamp_detail(self, now: float) -> None:
        """The detail got shorter (an error cleared): keep the scroll in range."""
        self._detail_scroll.set(self._detail_limit(self._detail_scroll.target), now)

    def _back_to_list(self, now: float) -> None:
        before = self.scene
        self._detail = None
        self._page_to("players")
        self._page_since = now
        self._manual_until = now + MANUAL_HOLD_SECONDS
        self._change(before, now, "right", "push", anim.PUSH_SECONDS)

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
