"""HDMI output: draw on the Linux framebuffer (/dev/fb0) from a dedicated VT.

Why the framebuffer: it exists on Pi OS Lite with no desktop (the KMS driver's
fbdev emulation backs the text console), needs no X/Wayland/DRM-master dance,
and works on every Pi from the 3 to the 5. To keep the kernel console from
drawing over us, we take VT 8 (``SPLANC_DISPLAY_VT``), switch to it and put it in
KD_GRAPHICS mode; a keyboard user can still Ctrl+Alt+F1 to a login prompt, and
while another VT is in front we stop drawing (and repaint on return).

No HDMI attached / no /dev/fb0: ``Framebuffer.open()`` returns None and the
caller retries later; nothing else depends on it.
"""

from __future__ import annotations

import fcntl
import os
import struct
from typing import Optional

from PIL import Image, ImageChops

FBIOGET_VSCREENINFO = 0x4600
FBIOGET_FSCREENINFO = 0x4602
KDSETMODE = 0x4B3A
KD_TEXT, KD_GRAPHICS = 0x00, 0x01
VT_ACTIVATE = 0x5606

# struct fb_var_screeninfo: 8 u32 (xres..bits_per_pixel, grayscale), then
# red/green/blue/transp bitfields (offset, length, msb_right) = 12 u32.
_VAR = struct.Struct("=8I12I")
_VAR_SIZE = 160  # the whole struct (we parse the head)
# struct fb_fix_screeninfo: char id[16]; unsigned long smem_start; u32 smem_len,
# type, type_aux, visual; u16 xpanstep, ypanstep, ywrapstep; u32 line_length.
_LONG = struct.calcsize("L")
_FIX_SIZE = 80


class FbInfo:
    def __init__(self, width, height, bpp, stride, red_off=16, blue_off=0):
        self.width, self.height, self.bpp, self.stride = width, height, bpp, stride
        self.red_off, self.blue_off = red_off, blue_off


def query(fd: int) -> FbInfo:
    var = bytearray(_VAR_SIZE)
    fcntl.ioctl(fd, FBIOGET_VSCREENINFO, var)
    v = _VAR.unpack_from(var)
    xres, yres, bpp = v[0], v[1], v[6]
    red_off, blue_off = v[8], v[14]
    fix = bytearray(_FIX_SIZE)
    fcntl.ioctl(fd, FBIOGET_FSCREENINFO, fix)
    # id[16] + smem_start + 4 u32 + 3 u16 (+2 pad to align the u32)
    line_length = struct.unpack_from("=I", fix, 16 + _LONG + 16 + 8)[0]
    if line_length < xres * bpp // 8:
        line_length = xres * bpp // 8
    return FbInfo(xres, yres, bpp, line_length, red_off, blue_off)


def query_sysfs(name: str = "fb0") -> Optional[FbInfo]:
    """Fallback when the ioctls aren't available (assumes RGB order)."""
    base = f"/sys/class/graphics/{name}"
    try:
        w, h = (int(x) for x in open(f"{base}/virtual_size").read().strip().split(","))
        bpp = int(open(f"{base}/bits_per_pixel").read().strip())
        stride = int(open(f"{base}/stride").read().strip())
    except (OSError, ValueError):
        return None
    return FbInfo(w, h, bpp, stride, 11 if bpp == 16 else 16, 0)


def pack(img: Image.Image, info: FbInfo) -> bytes:
    """RGB image -> framebuffer bytes (16 bpp RGB565/BGR565 or 32 bpp)."""
    img = img.convert("RGB")
    if info.bpp == 32:
        raw = img.tobytes("raw", "BGRX" if info.red_off == 16 else "RGBX")
    elif info.bpp == 24:
        raw = img.tobytes("raw", "BGR" if info.red_off == 16 else "RGB")
    elif info.bpp == 16:
        r, g, b = img.split()
        if info.red_off == 0:  # BGR565
            r, b = b, r
        # little-endian 5-6-5: low byte = GGGBBBBB, high byte = RRRRRGGG. The bit
        # fields don't overlap, so ImageChops.add (clipped sum) is a bitwise OR.
        lo = ImageChops.add(g.point(lambda v: ((v >> 2) & 0x07) << 5), b.point(lambda v: v >> 3))
        hi = ImageChops.add(r.point(lambda v: (v >> 3) << 3), g.point(lambda v: v >> 5))
        raw = Image.merge("LA", (lo, hi)).tobytes()
    else:
        raise ValueError(f"unsupported framebuffer depth {info.bpp} bpp")
    row = info.width * info.bpp // 8
    if info.stride == row:
        return raw
    pad = b"\0" * (info.stride - row)
    return b"".join(raw[y * row : (y + 1) * row] + pad for y in range(info.height))


class Framebuffer:
    def __init__(self, path: str, fd: int, info: FbInfo, vt: Optional["Console"]):
        self.path, self.fd, self.info, self.vt = path, fd, info, vt

    @classmethod
    def open(cls, path: str = "/dev/fb0", vt_num: Optional[int] = None) -> Optional["Framebuffer"]:
        try:
            fd = os.open(path, os.O_RDWR)
        except OSError:
            return None
        try:
            info = query(fd)
        except OSError:
            info = query_sysfs(os.path.basename(path))
        if info is None or info.width == 0 or info.height == 0:
            os.close(fd)
            return None
        vt = Console.take(vt_num) if vt_num else None
        return cls(path, fd, info, vt)

    @property
    def size(self):
        return self.info.width, self.info.height

    def visible(self) -> bool:
        return self.vt is None or self.vt.active()

    def show(self, img: Image.Image) -> bool:
        """Draw a full frame; False if our VT isn't in front (nothing drawn)."""
        if not self.visible():
            return False
        if img.size != self.size:
            img = img.resize(self.size)
        os.pwrite(self.fd, pack(img, self.info), 0)
        return True

    def changed(self) -> bool:
        """The mode changed under us (HDMI hotplug / resolution switch)."""
        try:
            info = query(self.fd)
        except OSError:
            return False
        return (info.width, info.height, info.bpp) != (
            self.info.width,
            self.info.height,
            self.info.bpp,
        )

    def close(self) -> None:
        if self.vt:
            self.vt.release()
        os.close(self.fd)


class Console:
    """A VT we switch to and put in graphics mode so fbcon leaves the fb alone."""

    def __init__(self, num: int, fd: int):
        self.num, self.fd = num, fd

    @classmethod
    def take(cls, num: int) -> Optional["Console"]:
        try:
            fd = os.open(f"/dev/tty{num}", os.O_WRONLY | os.O_NOCTTY)
        except OSError:
            return None
        con = cls(num, fd)
        try:
            fcntl.ioctl(fd, VT_ACTIVATE, num)
            fcntl.ioctl(fd, KDSETMODE, KD_GRAPHICS)
        except OSError:
            pass  # no CAP_SYS_TTY_CONFIG: draw anyway (the cursor may blink through)
        return con

    def active(self) -> bool:
        try:
            with open("/sys/class/tty/tty0/active") as f:
                return f.read().strip() == f"tty{self.num}"
        except OSError:
            return True

    def release(self) -> None:
        try:
            fcntl.ioctl(self.fd, KDSETMODE, KD_TEXT)
        except OSError:
            pass
        os.close(self.fd)


class PngSink:
    """Test/dev stand-in for a screen: every frame is saved to ``path``."""

    def __init__(self, path: str, size=(1920, 1080)):
        self.path, self.size, self.frames = path, size, 0

    def visible(self) -> bool:
        return True

    def show(self, img: Image.Image) -> bool:
        tmp = self.path + ".tmp.png"
        img.save(tmp)
        os.replace(tmp, self.path)
        self.frames += 1
        return True

    def changed(self) -> bool:
        return False

    def close(self) -> None:
        pass
