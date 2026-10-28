"""The OLED boot animation: frames pre-rendered at build time from the Splanc logo.

``pi/bridge/tools/gen_boot_frames.py`` writes ``boot_frames.bin`` next to this
module (Bazel's //pi/bridge:boot_frames for the agent bundle; the NixOS image's
splancPy derivation runs the same script). A checkout without it (the
installer's ``--source`` dev path) just skips the animation.
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
    def __init__(self, frames: List[Image.Image], fps: int):
        self.frames = frames
        self.fps = fps

    @property
    def duration(self) -> float:
        return len(self.frames) / self.fps

    def at(self, t: float) -> Image.Image:
        """The frame for ``t`` seconds in (held on the last one afterwards)."""
        i = int(max(0.0, t) * self.fps)
        return self.frames[min(i, len(self.frames) - 1)]


def unpack(data: bytes) -> BootFrames:
    if data[:4] != MAGIC:
        raise ValueError("not a boot frames file")
    version, fps, w, h, n = struct.unpack("<BBBBH", data[4:10])
    if version != 1 or fps <= 0 or n <= 0:
        raise ValueError(f"unsupported boot frames (v{version}, {fps} fps, {n} frames)")
    body = zlib.decompress(data[10:])
    size = w * h // 8
    if len(body) != size * n:
        raise ValueError("truncated boot frames")
    frames = [Image.frombytes("1", (w, h), body[i * size : (i + 1) * size]) for i in range(n)]
    return BootFrames(frames, fps)


def load(path: Optional[str] = None) -> Optional[BootFrames]:
    """The frames, or None when the file is missing or unreadable (no animation)."""
    path = path or os.environ.get("SPLANC_BOOT_FRAMES") or DEFAULT_PATH
    try:
        with open(path, "rb") as f:
            return unpack(f.read())
    except (OSError, ValueError, zlib.error, struct.error):
        return None
