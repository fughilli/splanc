"""The OLED boot animation: frames pre-rendered at build time from the Splanc logo.

``pi/bridge/tools/gen_boot_frames.py`` writes ``boot_frames.bin`` next to this
module (Bazel's //pi/bridge:boot_frames for the agent bundle; the NixOS image's
splancPy derivation runs the same script). A checkout without it (the
installer's ``--source`` dev path) just skips the animation.

The file holds the intro (the logo appearing) and, from version 2, a "loading"
loop played after it, repeated: ``at(t)`` keeps moving for as long as the boot
scene shows. The early boot splash (pi/bridge/splash) plays the same frames from
the initrd; splash.py continues them from where it was.
"""

from __future__ import annotations

import os
import struct
import zlib
from typing import List, Optional

from PIL import Image

MAGIC = b"SPLB"
DEFAULT_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "boot_frames.bin")


class BootFrames:
    """``frames[:loop_start]`` is the intro, ``frames[loop_start:]`` the loop
    (``loop_start=None``: no loop, the last frame holds)."""

    def __init__(self, frames: List[Image.Image], fps: int, loop_start: Optional[int] = None):
        self.frames = frames
        self.fps = fps
        if loop_start is not None and not 0 < loop_start < len(frames):
            loop_start = None
        self.loop_start = loop_start

    @property
    def intro_frames(self) -> int:
        return self.loop_start if self.loop_start is not None else len(self.frames)

    @property
    def duration(self) -> float:
        """The intro's length: how long the logo plays before the first screen."""
        return self.intro_frames / self.fps

    @property
    def loop_duration(self) -> float:
        return (len(self.frames) - self.intro_frames) / self.fps

    def index(self, t: float) -> int:
        i = int(max(0.0, t) * self.fps + 1e-9)
        if i < self.intro_frames:
            return i
        if self.loop_start is None:
            return len(self.frames) - 1
        n = len(self.frames) - self.loop_start
        return self.loop_start + (i - self.loop_start) % n

    def at(self, t: float) -> Image.Image:
        """The frame for ``t`` seconds in (then the loop, or the last frame held)."""
        return self.frames[self.index(t)]

    def cycle_end(self, t: float) -> float:
        """The first time >= ``t`` at which the animation is back at the end of the
        intro / a loop cycle (a calm moment to hand off to the first screen)."""
        if t <= self.duration or not self.loop_duration:
            return max(t, self.duration)
        k = -(-(t - self.duration) // self.loop_duration)  # ceil
        return self.duration + k * self.loop_duration


def unpack(data: bytes) -> BootFrames:
    if data[:4] != MAGIC:
        raise ValueError("not a boot frames file")
    version, fps, w, h, n = struct.unpack("<BBBBH", data[4:10])
    if version not in (1, 2) or fps <= 0 or n <= 0:
        raise ValueError(f"unsupported boot frames (v{version}, {fps} fps, {n} frames)")
    loop_start, at = None, 10
    if version == 2:
        (loop_start,) = struct.unpack("<H", data[10:12])
        at = 12
    body = zlib.decompress(data[at:])
    size = w * h // 8
    if len(body) != size * n:
        raise ValueError("truncated boot frames")
    frames = [Image.frombytes("1", (w, h), body[i * size : (i + 1) * size]) for i in range(n)]
    return BootFrames(frames, fps, loop_start)


def load(path: Optional[str] = None) -> Optional[BootFrames]:
    """The frames, or None when the file is missing or unreadable (no animation)."""
    path = path or os.environ.get("SPLANC_BOOT_FRAMES") or DEFAULT_PATH
    try:
        with open(path, "rb") as f:
            return unpack(f.read())
    except (OSError, ValueError, zlib.error, struct.error):
        return None
