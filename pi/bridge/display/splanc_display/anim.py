"""Animation primitives for the OLED menus: easing, gliding values, scene slides.

Everything is a pure function of an injected clock (seconds), so the timing and
interruption rules are unit-tested with a fake clock:

- ``Tween``: a value (a list's scroll offset, its highlight row) gliding to a
  target. Retargeting mid-flight starts from where it is *now*, so a held
  joystick never queues motion up behind itself.
- ``Slide``: one scene replacing another (a page change, opening a fixture, the
  boot logo handing off). A new slide starts at once from the current target
  scene; reversing a running slide (back while it opens) turns it around in place.

Durations are short (120–250 ms) and eased out: the motion starts fast, so a
press feels immediate even on a panel that only manages ~20 fps.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable, Optional

Ease = Callable[[float], float]

PAGE_SECONDS = 0.20  # top-level page slide
PUSH_SECONDS = 0.22  # into / out of a fixture's detail
LIST_SECONDS = 0.12  # list highlight moving one row
SCROLL_SECONDS = 0.16  # list / detail scrolling
HANDOFF_SECONDS = 0.25  # boot logo -> first screen

EPS = 1e-9  # float slack on "has it finished" (fake clocks add up to 0.19999…)

OPPOSITE = {"left": "right", "right": "left", "up": "down", "down": "up"}


def clamp01(t: float) -> float:
    return 0.0 if t <= 0 else 1.0 if t >= 1 else t


def ease_out_cubic(t: float) -> float:
    t = clamp01(t)
    return 1 - (1 - t) ** 3


def ease_in_out_cubic(t: float) -> float:
    t = clamp01(t)
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def inverse(ease: Ease, y: float) -> float:
    """The t in [0, 1] with ease(t) == y (eases here are monotonic)."""
    lo, hi = 0.0, 1.0
    for _ in range(30):
        mid = (lo + hi) / 2
        if ease(mid) < y:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


class Tween:
    """A number gliding to its target over ``duration`` seconds."""

    def __init__(
        self, value: float = 0.0, duration: float = SCROLL_SECONDS, ease: Ease = ease_out_cubic
    ):
        self.duration = duration
        self.ease = ease
        self._from = self.target = float(value)
        self._t0 = float("-inf")

    def value(self, now: float) -> float:
        if self.duration <= 0:
            return self.target
        p = (now - self._t0) / self.duration
        if p >= 1:
            return self.target
        return self._from + (self.target - self._from) * self.ease(p)

    def set(self, target: float, now: float) -> None:
        """Glide to ``target`` from wherever it is now (retargets a running glide)."""
        target = float(target)
        if target == self.target:
            return
        self._from = self.value(now)
        self.target = target
        self._t0 = now

    def snap(self, value: float) -> None:
        """Jump (no animation): content moved under it, not the user."""
        self._from = self.target = float(value)
        self._t0 = float("-inf")

    def shift(self, delta: float) -> None:
        """Move start and target together (an item inserted above keeps its glide)."""
        self._from += delta
        self.target += delta

    def moving(self, now: float) -> bool:
        return now - self._t0 < self.duration - EPS and self._from != self.target


@dataclass(frozen=True)
class Scene:
    """One full screen: a top-level page, a fixture's detail (``key``), or the boot logo."""

    page: str
    key: str = ""


@dataclass(frozen=True)
class SlideView:
    """A slide as the renderer sees it: draw ``src`` and ``dst`` offset by ``p``."""

    src: Scene
    dst: Scene
    direction: str  # where the content moves: left | right | up | down
    style: str  # "slide" (both move together) | "push" (dst slides over src)
    p: float  # eased progress 0..1


class Slide:
    def __init__(
        self,
        src: Scene,
        dst: Scene,
        direction: str,
        t0: float,
        duration: float,
        style: str = "slide",
        ease: Ease = ease_out_cubic,
    ):
        self.src, self.dst, self.direction, self.style = src, dst, direction, style
        self.t0, self.duration, self.ease = t0, duration, ease

    def progress(self, now: float) -> float:
        return self.ease((now - self.t0) / self.duration) if self.duration > 0 else 1.0

    def done(self, now: float) -> bool:
        return now - self.t0 >= self.duration - EPS

    def view(self, now: float) -> SlideView:
        return SlideView(self.src, self.dst, self.direction, self.style, self.progress(now))


def retarget(
    cur: Optional[Slide],
    shown: Scene,
    dst: Scene,
    direction: str,
    now: float,
    duration: float,
    style: str = "slide",
) -> Slide:
    """The slide to ``dst``, given the one running (if any) and the scene shown.

    Reversing a running slide (``dst`` is where it came from, the opposite way)
    turns it around from its current position; anything else starts a fresh slide
    from the running slide's target (it never waits for it to finish).
    """
    if (
        cur is not None
        and not cur.done(now)
        and dst == cur.src
        and OPPOSITE.get(direction) == cur.direction
    ):
        remaining = 1.0 - cur.progress(now)  # how much of src is still to be uncovered
        t = inverse(cur.ease, remaining)
        return Slide(cur.dst, dst, direction, now - t * duration, duration, style, cur.ease)
    src = cur.dst if cur is not None and not cur.done(now) else shown
    return Slide(src, dst, direction, now, duration, style)
