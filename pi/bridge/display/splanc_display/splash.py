"""Taking the screens over from the early boot splash (pi/bridge/splash).

On the NixOS image, ``splanc-splash`` starts in the initrd, seconds before this
service can, and plays the boot animation (boot_frames.bin, the same frames) on
the OLED HAT and HDMI. It keeps running across the switch to the real root and
listens on the abstract unix socket ``@splanc-splash``. This service:

1. imports everything, loads the fonts and renders a frame off-screen, while
   the splash keeps animating (``App.run``);
2. waits until the system is quiet enough for the UI to animate smoothly
   (``wait_quiet``: CPU busy share, and PSI CPU pressure where the kernel has
   it), at most QUIET_MAX_SECONDS;
3. sends ``stop``. The splash stops drawing, closes the SPI device and the
   framebuffer, answers with the animation's start time (CLOCK_MONOTONIC, the
   clock time.monotonic() reads), the stage text it showed and whether the
   OLED was driven, passes its GPIO line request (DC + RST, still held: releasing
   RST would reset the panel) over the socket, and exits;
4. opens the panel without resetting or re-initialising it (hat.open_device's
   ``takeover``), and continues the same animation from the same moment, with
   the same stage text, then slides to the first page at the end of the cycle.

No splash (Raspberry Pi OS, a restart of this service, ``splanc.splash=0``):
``connect`` fails at once and the service starts as it always did.

The stage texts live here so the splash's build (tools/gen_splash_assets.py)
renders them with the same font, at the same place, as render_oled does.
"""

from __future__ import annotations

import array
import os
import socket
import time
from dataclasses import dataclass
from typing import Callable, Optional, Tuple

ADDRESS = "\0splanc-splash"  # abstract: reachable from the initrd's process and ours alike

# Indexed by the splash's stage number (splanc-splash.c, stage_detect()).
STAGES = (
    "Starting…",  # initrd
    "Loading system…",  # switched to the real root
    "Connecting…",  # NetworkManager up, no default route yet
    "Starting bridge…",  # online, the bridge hasn't written its status yet
    "Almost ready…",  # the bridge is up; the screens are loading
)
STAGE_FONT = "spleen/spleen-5x8.bdf"  # the terminus sets' small fallback
STAGE_BOTTOM = 64  # the text's ink sits on the panel's last rows, under the LED row

QUIET_MAX_SECONDS = 30.0  # never keep the UI back longer than this
QUIET_BUSY = 0.5  # CPU busy share (all cores) that counts as quiet
QUIET_PSI = 25.0  # /proc/pressure/cpu "some avg10" (%) that counts as quiet
QUIET_SAMPLE = 0.5
QUIET_SAMPLES = 2  # consecutive quiet samples needed


@dataclass(frozen=True)
class Handoff:
    t0: float  # CLOCK_MONOTONIC seconds at which the animation started
    stage: int
    oled: bool  # the splash drove the OLED (and passed its GPIO lines)
    gpio_fd: Optional[int]  # GPIO v2 line request: DC (offset 0) + RST (offset 1)
    frame: int = 0

    @property
    def text(self) -> str:
        return STAGES[self.stage] if 0 <= self.stage < len(STAGES) else ""


def _connect(address: str, timeout: float) -> Optional[socket.socket]:
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        s.connect(address)
        return s
    except OSError:
        s.close()
        return None


def alive(address: Optional[str] = None) -> bool:
    """Is a splash running (and listening)?"""
    s = _connect(address or ADDRESS, 0.5)
    if s is None:
        return False
    s.close()  # a connection that sends nothing is ignored
    return True


def parse_reply(line: str) -> Tuple[float, int, bool, int]:
    """``ok t0=<ns> stage=<i> oled=<0|1> frame=<n>`` -> (t0 s, stage, oled, frame)."""
    parts = line.strip().split()
    if not parts or parts[0] != "ok":
        raise ValueError(f"splash refused: {line.strip()!r}")
    kv = dict(p.split("=", 1) for p in parts[1:] if "=" in p)
    return (
        int(kv["t0"]) / 1e9,
        int(kv.get("stage", 0)),
        kv.get("oled") == "1",
        int(kv.get("frame", 0)),
    )


def stop(hdmi: bool, address: Optional[str] = None, timeout: float = 3.0) -> Optional[Handoff]:
    """Ask the splash to stop and hand over. ``hdmi``: we draw on /dev/fb0 next, so
    leave the console VT in graphics mode (else the splash gives it back). None if
    no splash is running (or it went away mid-way)."""
    s = _connect(address or ADDRESS, timeout)
    if s is None:
        return None
    try:
        s.sendall(b"stop hdmi=%d\n" % (1 if hdmi else 0))
        data, fds = b"", []
        while not data.endswith(b"\n"):
            msg, anc, _flags, _addr = s.recvmsg(
                256, socket.CMSG_SPACE(4 * array.array("i").itemsize)
            )
            for level, kind, payload in anc:
                if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                    a = array.array("i")
                    a.frombytes(payload[: len(payload) - len(payload) % a.itemsize])
                    fds.extend(a)
            if not msg:
                break
            data += msg
        t0, stage, oled, frame = parse_reply(data.decode("utf-8", "replace"))
    except (OSError, ValueError, KeyError) as e:
        print(f"splanc-display: splash hand-off failed: {e}", flush=True)
        return None
    finally:
        s.close()
    gpio_fd = fds[0] if fds else None
    for extra in fds[1:]:
        os.close(extra)
    if not oled and gpio_fd is not None:
        os.close(gpio_fd)
        gpio_fd = None
    return Handoff(
        t0=t0, stage=stage, oled=oled and gpio_fd is not None, gpio_fd=gpio_fd, frame=frame
    )


# --- "is the system quiet yet?" ----------------------------------------------------


def read_cpu(path: str = "/proc/stat") -> Optional[Tuple[int, int]]:
    """(busy, total) jiffies of all CPUs; iowait counts as busy (boot I/O)."""
    try:
        with open(path) as f:
            v = [int(x) for x in f.readline().split()[1:]]
    except (OSError, ValueError):
        return None
    if len(v) < 4:
        return None
    idle = v[3]
    return sum(v[:8]) - idle, sum(v[:8])


def read_psi(path: str = "/proc/pressure/cpu") -> Optional[float]:
    """CPU pressure "some avg10" (%), or None (no PSI in this kernel / disabled)."""
    try:
        with open(path) as f:
            for line in f:
                if line.startswith("some "):
                    kv = dict(p.split("=", 1) for p in line.split()[1:])
                    return float(kv["avg10"])
    except (OSError, ValueError, KeyError):
        pass
    return None


def wait_quiet(
    max_wait: float = QUIET_MAX_SECONDS,
    busy: float = QUIET_BUSY,
    psi: float = QUIET_PSI,
    sample: float = QUIET_SAMPLE,
    need: int = QUIET_SAMPLES,
    clock: Callable[[], float] = time.monotonic,
    sleep: Callable[[float], None] = time.sleep,
    cpu: Callable[[], Optional[Tuple[int, int]]] = read_cpu,
    pressure: Callable[[], Optional[float]] = read_psi,
) -> Tuple[bool, float, str]:
    """Wait until ``need`` consecutive ``sample``-second windows were quiet: CPU busy
    share below ``busy`` and (where the kernel has PSI) CPU pressure below ``psi``.
    Returns (quiet, seconds waited, last measurement)."""
    start = clock()
    good, last, what = 0, cpu(), "no samples"
    while True:
        waited = clock() - start
        if waited >= max_wait:
            return False, waited, what
        sleep(sample)
        now = cpu()
        p = pressure()
        share = None
        if now is not None and last is not None and now[1] > last[1]:
            share = (now[0] - last[0]) / (now[1] - last[1])
        last = now
        what = (f"cpu {share * 100:.0f}%" if share is not None else "cpu n/a") + (
            f", psi {p:.1f}" if p is not None else ""
        )
        quiet = (share is None or share < busy) and (p is None or p < psi)
        good = good + 1 if quiet else 0
        if good >= need:
            return True, clock() - start, what


# --- the stage text (drawn identically by the splash and by render_oled) ------------


def stage_font():
    from . import fonts

    return _font(os.path.join(fonts.FONT_DIR, STAGE_FONT))


_FONTS: dict = {}


def _font(path: str):
    if path not in _FONTS:
        from . import fonts

        _FONTS[path] = fonts.BitmapFont(path)
    return _FONTS[path]


def draw_stage(img, text: str) -> None:
    """``text`` centred on the panel's bottom rows (``img``: mode "1", 128x64)."""
    if not text:
        return
    from PIL import ImageDraw

    f = stage_font()
    dr = ImageDraw.Draw(img)
    w = f.width(text)
    x = max(0, (img.width - w) // 2)
    y = STAGE_BOTTOM - f.height
    f.draw(dr, (x, y), text, 1)
