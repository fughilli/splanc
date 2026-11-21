"""The OLED HAT's interaction state machine: pages, the fixture menu, buttons,
overlays, transitions, dimming.

Pure and clock-injected (``clock`` returns seconds) so it is tested with fakes;
``main`` feeds it button events and status updates and ticks it from the render loop.

Screens: five top-level pages (home, qr, players = the fixture list, network,
clients = the paired-client list), a sixth on the SD image (updates: the system
and agent updaters + "Check now"), "matter" after "qr" while the bridge runs its
Matter bridge (its pairing QR + code) and, under each list, one item's detail
(``detail`` = a fixture, ``client`` = a paired client, ``update`` = one updater).
Button map (Waveshare 1.3" OLED HAT):

    KEY1            new pairing code (from anywhere; goes to the home page to show it)
    KEY2            identify fixtures (flash every player)
    KEY3 hold >=5 s revoke all paired clients -> confirm screen -> KEY3 again;
                    in a client's detail: revoke THAT client (same hold + confirm)
    joystick        left/right = previous/next page; up/down = previous/next page,
                    except on a list (fixtures, clients) where they move the selection;
                    press = open the selected item (list) or go home (other pages)
    in a detail     up/down scroll it; left or press = back to its list
    Matter page     press = let another controller add the bridge (opens a 15 min
                    commissioning window once it has been added)
    Updates page    press on "Check now" = check both updaters; on System/Agent =
                    its detail, where press (with an update on offer) asks
                    "Install?" -> press or KEY3 = install, any other key = later.
                    A confirmed system update that waits for apps to disconnect
                    offers "Restart now" the same way. Nothing installs without it.

Any key wakes a sleeping screen (that press does nothing else). Every screen
change slides (anim.py); a press during a slide retargets it at once.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

from . import anim, gliders
from .anim import Scene, SlideView, Tween

PAGES = ("home", "qr", "players", "network", "clients")
# The SD image (updates managed from the screen) adds the Updates page.
UPDATES_PAGES = PAGES + ("updates",)
# Each list page and the scene that shows one of its items.
LIST_DETAIL = {"players": "detail", "clients": "client", "updates": "update"}
UPDATE_CHECK = "check"  # the Updates list's "Check now" row (not a detail)

HOLD_SECONDS = 5.0  # KEY3 hold before the revoke confirm appears
CONFIRM_SECONDS = 10.0  # confirm screen auto-cancels after this
TOAST_SECONDS = 2.5
AUTO_CYCLE_SECONDS = 8.0  # page dwell when nobody is pressing buttons
MANUAL_HOLD_SECONDS = 30.0  # a joystick page change pauses auto-cycling this long
DETAIL_IDLE_SECONDS = 300.0  # an untouched fixture detail goes back to the list
# Three stages: active (bright) -> passive (dimmed) -> the screensaver (dimmed gliders,
# one per online fixture; gliders.py), which a pairing code on screen holds off.
DIM_AFTER_SECONDS = 120.0  # passive: contrast drops after this long without input/changes
SAVER_AFTER_SECONDS = 1800.0  # the screensaver, after this long — only when no code is up
SHIFT_PERIOD_SECONDS = 60.0  # burn-in: move the whole image by a pixel this often

LIST_ROWS = 4  # fixture rows on screen at once
DETAIL_ROWS = 4  # detail rows on screen at once

# (dx, dy) pixel-shift cycle. The UI is laid out 1 px narrower and shorter than the
# panel (render_oled.W x H), so every shift shows all of it.
SHIFTS = ((0, 0), (1, 0), (1, 1), (0, 1))

KEYS = ("key1", "key2", "key3", "up", "down", "left", "right", "press")

# dispatch(cmd, done, **args) runs a control command off the UI thread and calls
# done(ok: bool, message: str) when it finishes (args only for commands that take
# some: revoke's grant).
Dispatch = Callable[..., None]

DONE_TEXT = {
    "new_pairing_code": "New code requested",
    "matter_pair": "Matter pairing open",
    "identify": "Identifying fixtures",
    "revoke_all": "All clients revoked",
    "revoke": "Client revoked",
    "update_check": "Checking for updates",
    "update_install": "Update started",
    "update_restart": "Restarting soon",
}

# An updater's action from its detail: "install" | "restart" | None (nothing to do).
UpdateAction = Callable[[str], Optional[str]]


@dataclass(frozen=True)
class View:
    page: str  # a PAGES entry, "detail", "client", or "boot"
    overlay: Optional[str] = None  # None | "hold" | "confirm" | "toast"
    confirm: str = ""  # the confirm's question: "revoke" | "install" | "restart"
    target: str = ""  # install/restart: the updater ("system" | "agent")
    overlay_text: str = ""
    overlay_seconds: float = 0.0  # countdown for hold/confirm
    shift: tuple = (0, 0)
    dimmed: bool = False
    saver: bool = False  # the screensaver (only ``saver_t`` and ``dimmed`` apply)
    saver_t: float = 0.0  # seconds into it
    key: str = ""  # the item shown by "detail" (a fixture) or "client" (a grant id)
    slide: Optional[SlideView] = None  # a screen change in progress
    sel: int = 0  # the fixture list's selected row
    list_pos: float = 0.0  # its highlight, in rows (animated)
    list_top: float = 0.0  # its scroll offset, in rows (animated)
    detail_scroll: float = 0.0  # the fixture detail's scroll offset, in rows (animated)
    client_sel: int = 0  # the same three for the client list
    client_pos: float = 0.0
    client_top: float = 0.0
    client_scroll: float = 0.0  # the client detail's scroll offset
    update_sel: int = 0  # the same four for the Updates page
    update_pos: float = 0.0
    update_top: float = 0.0
    update_scroll: float = 0.0
    revoke: str = ""  # hold/confirm: the client (grant id) being revoked; "" = all
    boot_t: Optional[float] = None  # seconds into the boot animation (while it shows)
    animating: bool = False  # something is moving: draw at the animation frame rate
    frame_period: float = 0.0  # while animating, wait at least this long (s; 0 = the panel's rate)


class _Menu:
    """One list page and its detail: the items' keys, the selection (kept on the
    same item as the list changes), which item is open, and their animations."""

    def __init__(self, page: str, detail_page: str, gone_text: str, now: float):
        self.page = page
        self.detail_page = detail_page
        self.gone_text = gone_text
        self.keys: tuple = ()
        self.sel_key: Optional[str] = None
        self.open: Optional[str] = None  # the open item's key
        self.since = now
        self.rows_of: Callable[[str], int] = lambda key: DETAIL_ROWS
        self.pos = Tween(0, anim.LIST_SECONDS)
        self.top = Tween(0, anim.SCROLL_SECONDS)
        self.scroll = Tween(0, anim.SCROLL_SECONDS)

    @property
    def sel(self) -> int:
        if self.sel_key is None or self.sel_key not in self.keys:
            return 0
        return self.keys.index(self.sel_key)

    def moving(self, now: float) -> bool:
        return self.pos.moving(now) or self.top.moving(now) or self.scroll.moving(now)


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
        self._confirm = "revoke"  # what the confirm asks: revoke | install | restart
        self._target = ""  # install/restart: the updater
        self._revoke = ""  # the hold/confirm's client ("" = revoke all)
        self.update_action: UpdateAction = lambda target: None  # set by main
        self._toast = ""
        self._toast_until = 0.0
        self._busy: Optional[str] = None
        self.code_visible = False  # set by main from the status (gates sleep)
        # The fixture menu and the client menu; at most one item open at a time.
        self._fx = _Menu("players", "detail", "Fixture is gone", now)
        self._cl = _Menu("clients", "client", "Client is gone", now)
        self._up = _Menu("updates", "update", "Updater is gone", now)
        self._menus = {m.page: m for m in (self._fx, self._cl, self._up)}
        self._open: Optional[_Menu] = None
        # Screen changes + the boot animation.
        self._slide: Optional[anim.Slide] = None
        self._boot_t0: Optional[float] = None
        self._boot_until: Optional[float] = None

    # --- the scene shown (when no slide is running) ---------------------------------
    @property
    def scene(self) -> Scene:
        if self._boot_until is not None:
            return Scene("boot")
        if self._open is not None:
            return Scene(self._open.detail_page, self._open.open)
        return Scene(self.pages[self.page])

    @property
    def sel(self) -> int:
        return self._fx.sel

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
    def idle_for(self, seconds: float) -> None:
        """Act as if nothing happened for the last ``seconds`` (the simulator's
        shortcut to the passive stage and the screensaver)."""
        self._last_activity = self.clock() - seconds

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
        self._set_items(self._fx, keys, rows_of)

    def set_clients(self, keys, rows_of: Optional[Callable[[str], int]] = None) -> None:
        """The paired-client list changed: as set_fixtures, for the Clients page."""
        self._set_items(self._cl, keys, rows_of)

    def set_matter(self, enabled: bool) -> None:
        """Show the Matter page (after "qr") while the bridge runs its Matter bridge."""
        have = "matter" in self.pages
        if enabled == have:
            return
        cur = self.pages[self.page]
        pages = [p for p in self.pages if p != "matter"]
        if enabled:
            pages.insert(pages.index("qr") + 1 if "qr" in pages else len(pages), "matter")
        self.pages = tuple(pages)
        self.page = self.pages.index(cur) if cur in self.pages else 0

    def set_updates(self, keys, rows_of: Optional[Callable[[str], int]] = None) -> None:
        """The Updates page's rows: the updaters shown ("system", "agent") + "check"."""
        self._set_items(self._up, keys, rows_of)

    def _set_items(self, m: _Menu, keys, rows_of) -> None:
        now = self.clock()
        keys = tuple(keys)
        if rows_of is not None:
            m.rows_of = rows_of
        old_sel = m.sel
        m.keys = keys
        if m.sel_key is not None and m.sel_key in keys:
            new = keys.index(m.sel_key)
            if new != old_sel:  # something was inserted/removed above it: stay on it
                m.pos.shift(new - old_sel)
                m.top.snap(self._top_for(new, m.top.target + (new - old_sel)))
        elif keys:
            idx = min(old_sel, len(keys) - 1)
            m.sel_key = keys[idx]
            m.pos.snap(idx)
            m.top.snap(self._top_for(idx, m.top.target))
        else:
            m.sel_key = None
            m.pos.snap(0)
            m.top.snap(0)
        if m.open is not None and m.open not in keys:
            if self._revoke == m.open:  # a hold/confirm for a client that is gone
                self._hold_start = self._confirm_until = None
                self._revoke = ""
            m.open = None
            if self._open is m:
                before = self.scene
                self._open = None
                self._page_to(m.page)
                self._change(before, now, "right", "push", anim.PUSH_SECONDS)
                self._show_toast(m.gone_text, now)
        elif m.open is not None:
            self._clamp_detail(m, now)

    def press(self, key: str, at: Optional[float] = None) -> None:
        """A key went down (``at``: when, if it waited in a queue; default now)."""
        if key not in KEYS:
            return
        now = self.clock() if at is None else at
        was_saver = self._saver_since(now) is not None
        self._last_activity = now
        if self._confirm_until is not None:
            self._confirm_until = None
            if self._confirm != "revoke":
                kind, self._confirm = self._confirm, "revoke"
                if key in ("press", "key3"):
                    self._run("update_" + kind, now, target=self._target)
                else:
                    self._show_toast("Later", now)
                return
            target, self._revoke = self._revoke, ""
            if key != "key3":
                self._show_toast("Cancelled", now)
            elif target:
                self._run("revoke", now, grant=target)
            else:
                self._run("revoke_all", now)
            return
        if was_saver:
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
            # In a client's detail KEY3 revokes that client; anywhere else, all of them.
            self._revoke = self._cl.open if self._open is self._cl and self._cl.open else ""
        elif self._open is not None:
            self._detail_key(self._open, key, now)
        elif (
            self.pages[self.page] in self._menus
            and self._menus[self.pages[self.page]].keys
            and key in ("up", "down", "press")
        ):
            self._list_key(self._menus[self.pages[self.page]], key, now)
        elif key == "press" and self.pages[self.page] == "matter":
            self._run("matter_pair", now)
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
            self._revoke = ""
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
            self._revoke = ""
            self._show_toast("Cancelled" if self._confirm == "revoke" else "Later", now)
            self._confirm = "revoke"
        if self._open is not None:
            if (
                now - self._open.since >= DETAIL_IDLE_SECONDS
                and self._hold_start is None
                and self._confirm_until is None
            ):
                self._back_to_list(now)
            return  # no auto-cycling out of an item someone opened
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
        saver_since = self._saver_since(now)
        if saver_since is not None:
            t = now - saver_since
            rate = gliders.GENS_PER_SECOND
            return View(
                page=self.scene.page,
                dimmed=True,
                saver=True,
                saver_t=t,
                animating=True,
                # Wake at the next generation (a fixed period would drift and skip some).
                frame_period=(int(t * rate) + 1) / rate - t,
            )
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
            or self._fx.moving(now)
            or self._cl.moving(now)
            or self._up.moving(now)
        )
        base = dict(
            page=scene.page,
            key=scene.key,
            shift=shift,
            dimmed=idle >= DIM_AFTER_SECONDS,
            slide=slide,
            sel=self._fx.sel,
            list_pos=self._fx.pos.value(now),
            list_top=self._fx.top.value(now),
            detail_scroll=self._fx.scroll.value(now),
            client_sel=self._cl.sel,
            client_pos=self._cl.pos.value(now),
            client_top=self._cl.top.value(now),
            client_scroll=self._cl.scroll.value(now),
            update_sel=self._up.sel,
            update_pos=self._up.pos.value(now),
            update_top=self._up.top.value(now),
            update_scroll=self._up.scroll.value(now),
            boot_t=boot_t,
            animating=animating,
        )
        if self._confirm_until is not None:
            return View(
                overlay="confirm",
                overlay_seconds=self._confirm_until - now,
                confirm=self._confirm,
                target=self._target if self._confirm != "revoke" else "",
                revoke=self._revoke,
                **dict(base, dimmed=False),
            )
        if self._hold_start is not None:
            return View(
                overlay="hold",
                overlay_seconds=HOLD_SECONDS - (now - self._hold_start),
                revoke=self._revoke,
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
    def _saver_since(self, now: float) -> Optional[float]:
        """When the screensaver started (None: not showing)."""
        if self._boot_until is not None or self.code_visible:
            return None
        start = self._last_activity + SAVER_AFTER_SECONDS
        return start if now >= start else None

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
        if self._open is None and self.pages[self.page] in ("home", "qr"):
            return
        before = self.scene
        if self._open is not None:
            self._open.open = None
            self._open = None
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

    def _list_key(self, m: _Menu, key: str, now: float) -> None:
        self._manual_until = now + MANUAL_HOLD_SECONDS
        self._page_since = now
        idx = m.sel
        if key == "press" and m is self._up and m.keys[idx] == UPDATE_CHECK:
            self._run("update_check", now)
            return
        if key == "press":
            before = self.scene
            m.open = m.keys[idx]
            m.since = now
            m.scroll.snap(0)
            self._open = m
            self._change(before, now, "left", "push", anim.PUSH_SECONDS)
            return
        new = max(0, min(len(m.keys) - 1, idx + (1 if key == "down" else -1)))
        if new == idx:
            return
        m.sel_key = m.keys[new]
        m.pos.set(new, now)
        m.top.set(self._top_for(new, m.top.target), now)

    def _detail_key(self, m: _Menu, key: str, now: float) -> None:
        m.since = now
        if key == "press" and m is self._up and m.open:
            action = self.update_action(m.open)
            if action in ("install", "restart"):
                self._confirm, self._target = action, m.open
                self._confirm_until = now + CONFIRM_SECONDS
                return
        if key in ("left", "press"):
            self._back_to_list(now)
        elif key in ("up", "down"):
            step = 1 if key == "down" else -1
            m.scroll.set(self._detail_limit(m, m.scroll.target + step), now)

    @staticmethod
    def _detail_limit(m: _Menu, t: float) -> float:
        most = max(0, m.rows_of(m.open) - DETAIL_ROWS) if m.open else 0
        return max(0, min(most, t))

    def _clamp_detail(self, m: _Menu, now: float) -> None:
        """The detail got shorter (an error cleared): keep the scroll in range."""
        m.scroll.set(self._detail_limit(m, m.scroll.target), now)

    def _back_to_list(self, now: float) -> None:
        m = self._open
        if m is None:
            return
        before = self.scene
        m.open = None
        self._open = None
        self._page_to(m.page)
        self._page_since = now
        self._manual_until = now + MANUAL_HOLD_SECONDS
        self._change(before, now, "right", "push", anim.PUSH_SECONDS)

    def _show_toast(self, text: str, now: float) -> None:
        self._toast = text
        self._toast_until = now + TOAST_SECONDS

    def _run(self, cmd: str, now: float, **args) -> None:
        """Send ``cmd`` (with ``args``, e.g. revoke's ``grant``) to the bridge."""
        if self._busy is not None:
            self._show_toast("Busy, try again", now)
            return
        self._busy = cmd

        def done(ok: bool, message: str) -> None:
            t = self.clock()
            self._busy = None
            if (
                ok
                and cmd == "revoke"
                and self._open is self._cl
                and self._cl.open == args.get("grant")
            ):
                self._back_to_list(t)  # it's gone: back to the list (no "is gone" toast)
            self._show_toast(DONE_TEXT.get(cmd, "Done") if ok else (message or "Failed"), t)
            self._last_activity = t

        if args:
            self.dispatch(cmd, done, **args)
        else:
            self.dispatch(cmd, done)
